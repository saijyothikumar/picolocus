import { describe, it, expect } from 'vitest';
import { AstScanner } from '../src/scanner.js';
import { ProseChunker } from '../src/chunker.js';
import { ManifestCompiler } from '../src/compiler.js';
import { TestQueriesRunner } from '../src/test-queries.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('CLI v1.0.0 Harness & Playbook Compilation', () => {
  it('parses triggerChain and whenUserAsks and isolates [data-mi-untrusted]', () => {
    const html = `
      <section>
        <button
          id="btn-tax"
          data-mi-label="Add EU VAT Number"
          data-mi-triggers="#tab-billing, #btn-open-tax-modal"
          data-mi-asks="how do I enter my VAT ID?, add EU VAT number"
          data-mi-action="update"
          data-mi-state="unconfigured"
          data-mi-keywords="vat, tax, eu tax"
        >
          Add VAT
        </button>
        <div data-mi-untrusted="true">
          <button id="btn-ugc" data-mi-label="UGC Action">Malicious</button>
        </div>
      </section>
    `;

    const scanner = new AstScanner();
    const items = scanner.scanHtml(html);

    expect(items.length).toBe(1);
    const taxBtn = items[0]!;
    expect(taxBtn.id).toBe('btn-tax');
    expect(taxBtn.triggerChain).toEqual(['#tab-billing', '#btn-open-tax-modal']);
    expect(taxBtn.parentTriggerSelector).toBe('#tab-billing');
    expect(taxBtn.whenUserAsks).toContain('how do I enter my VAT ID?');
    expect(taxBtn.kind).toBe('update');
    expect(taxBtn.liveStatus).toBe('unconfigured');
    expect(taxBtn.synonyms).toContain('vat');

    // UGC button was completely excluded
    expect(items.some((i) => i.id === 'btn-ugc')).toBe(false);
  });

  it('compiles harness items and converts playbooks to manifest items with correct provenance', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'picolocus-harness-'));

    try {
      const harnessPath = join(tempDir, 'picolocus.harness.json');
      const harnessConfig = {
        harnessVersion: '1.0',
        items: [
          {
            id: 'harness-vat',
            label: 'Add EU VAT Number',
            targetType: 'action' as const,
            selector: '#input-vat',
            triggerChain: ['#tab-billing', '#btn-open-tax-modal'],
            whenUserAsks: ['enter tax ID', 'add VAT number'],
          },
        ],
        playbooks: [
          {
            id: 'playbook-sso',
            label: 'Configure SAML SSO',
            whenUserAsks: ['set up Okta SSO', 'configure SAML authentication'],
            branches: [
              {
                condition: { state: { tier: 'free' } },
                target: { route: '/pricing', selector: '#btn-upgrade-pro' },
              },
              {
                default: true,
                target: { route: '/security/sso', selector: '#input-idp-url' },
              },
            ],
          },
        ],
      };

      writeFileSync(harnessPath, JSON.stringify(harnessConfig, null, 2));

      const manifests = await ManifestCompiler.compile([], {
        outDir: tempDir,
        harnessPath,
      });

      const publicItems = manifests['manifest.public.json']!.items;
      expect(publicItems.length).toBe(2);

      const vatItem = publicItems.find((i) => i.id === 'harness-vat');
      expect(vatItem).toBeDefined();
      expect(vatItem?.provenance).toBe('harness_item');
      expect(vatItem?.triggerChain).toEqual(['#tab-billing', '#btn-open-tax-modal']);

      const ssoItem = publicItems.find((i) => i.id === 'playbook-sso');
      expect(ssoItem).toBeDefined();
      expect(ssoItem?.provenance).toBe('playbook_branch');
      expect(ssoItem?.whenUserAsks).toContain('set up Okta SSO');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 25000);

  it('evaluates test queries assertions against compiled manifests', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'picolocus-queries-'));

    try {
      const items = [
        {
          id: 'btn-delete-workspace',
          label: 'Delete Workspace',
          targetType: 'action' as const,
          source: 'manifest' as const,
          actionKind: 'delete' as const,
        },
        {
          id: 'btn-export-audit',
          label: 'Export Audit Logs',
          targetType: 'action' as const,
          source: 'manifest' as const,
          requiredTier: 'enterprise',
          tierPolicy: 'upsell' as const,
        },
      ];

      await ManifestCompiler.compile(items, { outDir: tempDir });

      const queriesPath = join(tempDir, 'queries.json');
      const testCases = [
        {
          query: 'Export Audit Logs',
          expectedTopId: 'btn-export-audit',
          expectTierLocked: true,
          user: { tier: 'free' },
        },
        {
          query: 'do not delete workspace',
          expectOOD: true,
          notExpectedIds: ['btn-delete-workspace'],
        },
        {
          query: 'random_nonsense_gibberish_998',
          expectOOD: true,
        },
      ];
      writeFileSync(queriesPath, JSON.stringify(testCases, null, 2));

      const res = await TestQueriesRunner.run({
        manifestsDir: tempDir,
        queriesPath,
      });

      expect(res.passed).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 25000);
});
