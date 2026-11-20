import { describe, it, expect } from 'vitest';
import { AstScanner } from '../src/scanner.js';
import { ProseChunker } from '../src/chunker.js';
import { ManifestCompiler } from '../src/compiler.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('CLI Scanner & Chunker', () => {
  it('scans HTML controls and inherits ancestor roles and tiers', () => {
    const html = `
      <section data-mi-roles="admin" data-mi-tier="growth">
        <button id="btn-delete" data-mi-label="Delete Project">Delete</button>
        <div data-mi-ignore="true">
          <button id="btn-secret">Ignored</button>
        </div>
      </section>
      <div>
        <button id="btn-public" data-mi-label="Public Action">Public</button>
      </div>
    `;

    const scanner = new AstScanner();
    const items = scanner.scanHtml(html);

    expect(items.length).toBe(2);

    const deleteBtn = items.find((i) => i.id === 'btn-delete');
    expect(deleteBtn).toBeDefined();
    expect(deleteBtn?.roles).toContain('admin');
    expect(deleteBtn?.requiredTier).toBe('growth');

    const publicBtn = items.find((i) => i.id === 'btn-public');
    expect(publicBtn).toBeDefined();
    expect(publicBtn?.roles).toBeUndefined();
  });

  it('scans TSX source code and extracts JSX controls with attributes', () => {
    const tsx = `
      export function Dashboard() {
        return (
          <div data-mi-roles="billing_editor">
            <button id="btn-invoice" data-mi-label="Download Invoice">Download</button>
            <input type="text" placeholder="Filter rows" data-mi-id="input-filter" />
          </div>
        );
      }
    `;

    const scanner = new AstScanner();
    const items = scanner.scanTsx(tsx);

    expect(items.length).toBe(2);
    const invoiceBtn = items.find((i) => i.id === 'btn-invoice');
    expect(invoiceBtn?.roles).toContain('billing_editor');
    expect(invoiceBtn?.targetType).toBe('action');

    const filterInput = items.find((i) => i.id === 'input-filter');
    expect(filterInput?.targetType).toBe('setting');
  });

  it('chunks prose paragraphs into sentence clauses', () => {
    const html = `
      <article>
        <p>
          We do not sell, rent, or trade your personal email under any circumstances.
          Our company protects user privacy with end-to-end client-side encryption.
        </p>
      </article>
    `;

    const chunker = new ProseChunker();
    const clauses = chunker.chunkHtml(html);

    expect(clauses.length).toBe(2);
    expect(clauses[0]?.targetType).toBe('doc_clause');
    expect(clauses[0]?.verbatimText).toContain('We do not sell');
    expect(clauses[1]?.verbatimText).toContain('Our company protects');
  });
});

describe('Physical RBAC Separation & Verification', () => {
  it('physically isolates public controls, public docs, and role-gated items', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'picolocus-test-'));

    try {
      const items = [
        { id: 'ctrl-pub', label: 'Public Button', targetType: 'action' as const, source: 'manifest' as const },
        { id: 'doc-pub', label: 'Privacy Policy', targetType: 'doc_clause' as const, source: 'manifest' as const, verbatimText: 'Policy text here.' },
        { id: 'ctrl-admin', label: 'Purge Database', targetType: 'action' as const, roles: ['admin'], source: 'manifest' as const },
      ];

      const manifests = await ManifestCompiler.compile(items, { outDir: tempDir });

      expect(manifests['manifest.public.json']).toBeDefined();
      expect(manifests['manifest.docs.json']).toBeDefined();
      expect(manifests['manifest.admin.json']).toBeDefined();

      // Verify manifest.public.json contains ONLY public controls
      const publicItems = manifests['manifest.public.json']!.items;
      expect(publicItems.length).toBe(1);
      expect(publicItems[0]?.id).toBe('ctrl-pub');

      // Verify manifest.docs.json contains ONLY public docs
      const docItems = manifests['manifest.docs.json']!.items;
      expect(docItems.length).toBe(1);
      expect(docItems[0]?.id).toBe('doc-pub');

      // Verify manifest.admin.json contains the admin item
      const adminItems = manifests['manifest.admin.json']!.items;
      expect(adminItems.length).toBe(1);
      expect(adminItems[0]?.id).toBe('ctrl-admin');

      // Verify verification check passes cleanly
      const verifyRes = ManifestCompiler.verify(tempDir);
      expect(verifyRes.valid).toBe(true);
      expect(verifyRes.errors.length).toBe(0);

      // Tamper test: inject restricted item into manifest.public.json
      const tamperedPublic = {
        ...manifests['manifest.public.json']!,
        items: [...publicItems, { id: 'leaked-admin', label: 'Leaked', targetType: 'action' as const, roles: ['admin'], source: 'manifest' as const }],
      };
      writeFileSync(join(tempDir, 'manifest.public.json'), JSON.stringify(tamperedPublic));

      const leakRes = ManifestCompiler.verify(tempDir);
      expect(leakRes.valid).toBe(false);
      expect(leakRes.errors.some((e) => e.includes('RBAC LEAK'))).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
