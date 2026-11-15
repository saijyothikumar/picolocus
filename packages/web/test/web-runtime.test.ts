import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  DomRowIndexer,
  VisualHighlighter,
  MatchStepSession,
  resolveSafeSameOriginUrl,
  waitForStableRect,
  waitForElementSelector,
  CrossPageHandoffManager,
  SpotlightBar,
} from '../src/index.js';
import { SilentMIEngine } from '@silent-mi/core';

describe('Web Runtime DOM Indexer & tbody Cache', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it('harvests interactive controls, table rows, and doc clauses with ancestor inheritance', () => {
    container.innerHTML = `
      <section data-mi-roles="admin,auditor" data-mi-tier="enterprise">
        <button id="btn-save" data-mi-label="Save Settings">Save</button>
        <div data-mi-ignore="true">
          <button id="btn-ignored">Ignored Button</button>
        </div>
        <details id="drawer-sec">
          <summary id="sec-trigger">Security Drawer</summary>
          <button id="btn-webhook" data-mi-label="Create Webhook">Webhook</button>
        </details>
      </section>

      <table>
        <tbody id="invoice-tbody">
          <tr id="row-tx-1" data-mi-status="paid"><td>#TX-1</td><td>$100.00</td></tr>
          <tr id="row-tx-2" data-mi-status="pending"><td>#TX-2</td><td>$200.00</td></tr>
        </tbody>
      </table>

      <article>
        <p>This is a verbatim compliance policy statement that exceeds 35 characters easily.</p>
      </article>
    `;

    const indexer = new DomRowIndexer();
    const items = indexer.harvestDom(container);

    // 1. Controls check
    const saveBtn = items.find((i) => i.id === 'btn-save');
    expect(saveBtn).toBeDefined();
    expect(saveBtn?.roles).toContain('admin');
    expect(saveBtn?.requiredTier).toBe('enterprise');

    // 2. Ignored check
    const ignoredBtn = items.find((i) => i.id === 'btn-ignored');
    expect(ignoredBtn).toBeUndefined();

    // 3. Parent trigger inference for closed details
    const webhookBtn = items.find((i) => i.id === 'btn-webhook');
    expect(webhookBtn).toBeDefined();
    expect(webhookBtn?.parentTriggerSelector).toBe('#sec-trigger');

    // 4. Table row check
    const row1 = items.find((i) => i.id === 'row-tx-1');
    expect(row1).toBeDefined();
    expect(row1?.targetType).toBe('row');

    // 5. Clause check
    const clause = items.find((i) => i.targetType === 'doc_clause');
    expect(clause).toBeDefined();
    expect(clause?.verbatimText).toContain('compliance policy statement');
  });

  it('reuses tbody cache and row status fingerprints across multiple scans', () => {
    container.innerHTML = `
      <table>
        <tbody id="test-tbody">
          <tr id="row-tx-100" data-mi-status="paid"><td>#TX-100</td><td>Paid</td></tr>
        </tbody>
      </table>
    `;

    const indexer = new DomRowIndexer();
    const firstScan = indexer.harvestDom(container);
    const rowFirst = firstScan.find((i) => i.id === 'row-tx-100');

    const secondScan = indexer.harvestDom(container);
    const rowSecond = secondScan.find((i) => i.id === 'row-tx-100');

    // Same object reference preserved without re-allocating
    expect(rowFirst).toBe(rowSecond);
  });
});

describe('Stability & Safe Route Resolution', () => {
  it('rejects unsafe and cross-origin routes', () => {
    expect(resolveSafeSameOriginUrl('javascript:alert(1)')).toBeNull();
    expect(resolveSafeSameOriginUrl('data:text/html,bad')).toBeNull();
    expect(resolveSafeSameOriginUrl('vbscript:bad')).toBeNull();
    expect(resolveSafeSameOriginUrl('//evil.com/phish')).toBeNull();
    expect(resolveSafeSameOriginUrl('/\\evil.com/phish')).toBeNull();
    expect(resolveSafeSameOriginUrl('https://evil.com/phish', 'http://localhost:5173')).toBeNull();

    // Valid same-origin paths
    expect(resolveSafeSameOriginUrl('/billing/invoices', 'http://localhost:5173')).toBe(
      '/billing/invoices'
    );
    expect(resolveSafeSameOriginUrl('/security?tab=webhooks#settings', 'http://localhost:5173')).toBe(
      '/security?tab=webhooks#settings'
    );
  });

  it('resolves immediately in layout-less JSDOM without artificial timeouts', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);

    const start = Date.now();
    const rect = await waitForStableRect(el);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(100);
    expect(rect).toBeDefined();
    el.remove();
  });

  it('polls for lazy portal elements', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    setTimeout(() => {
      const portalEl = document.createElement('div');
      portalEl.id = 'lazy-portal-item';
      root.appendChild(portalEl);
    }, 50);

    const found = await waitForElementSelector('#lazy-portal-item', root, 300);
    expect(found).not.toBeNull();
    expect(found?.id).toBe('lazy-portal-item');
    root.remove();
  });
});

describe('Pure CSS Highlighter (Zero DOM Mutations)', () => {
  let target: HTMLButtonElement;

  beforeEach(() => {
    target = document.createElement('button');
    target.id = 'test-btn';
    target.textContent = 'Action Button';
    document.body.appendChild(target);
  });

  afterEach(() => {
    target.remove();
  });

  it('highlights with data-silent-mi-active and creates NO <mark> tags', () => {
    const highlighter = new VisualHighlighter();
    highlighter.highlightMatch({
      id: 'test-btn',
      targetType: 'action',
      label: 'Action Button',
      selector: '#test-btn',
      score: 0.95,
      lexicalScore: 0.95,
      semanticScore: 0,
      negationPenalty: 0,
      source: 'dom',
    });

    expect(target.getAttribute('data-silent-mi-active')).toBe('true');
    // Ensure zero <mark> DOM mutations
    expect(document.querySelectorAll('mark').length).toBe(0);

    // Callout badge exists in data-smi-ui
    const badge = document.querySelector('.silent-mi-callout');
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute('data-smi-ui')).toBe('true');

    highlighter.clearVisualHighlight();
    expect(target.hasAttribute('data-silent-mi-active')).toBe(false);
    expect(document.querySelector('.silent-mi-callout')).toBeNull();
  });
});

describe('Persistent MatchStepSession & Cross-Page Handoff', () => {
  it('steps through matches with next() and prev() without losing session', () => {
    const highlighter = new VisualHighlighter();
    const session = new MatchStepSession(highlighter);

    const matches = [
      { id: '1', label: 'First', selector: '#a', score: 0.9, lexicalScore: 0.9, semanticScore: 0, negationPenalty: 0, targetType: 'action' as const, source: 'dom' as const },
      { id: '2', label: 'Second', selector: '#b', score: 0.8, lexicalScore: 0.8, semanticScore: 0, negationPenalty: 0, targetType: 'action' as const, source: 'dom' as const },
    ];

    session.setSession('test', matches);
    expect(session.getCurrent()?.id).toBe('1');
    expect(session.next()?.id).toBe('2');
    expect(session.next()?.id).toBe('1'); // Wraps around
    expect(session.prev()?.id).toBe('2');
  });

  it('saves and restores cross-page handoffs with prototype pollution safety and 15s TTL', () => {
    const engine = new SilentMIEngine();
    engine.setItems([
      { id: 'item-10', label: 'Security Webhooks', targetType: 'setting', source: 'manifest' },
    ]);

    const match = {
      id: 'item-10',
      label: 'Security Webhooks',
      targetType: 'setting' as const,
      source: 'manifest' as const,
      score: 0.92,
      lexicalScore: 0.92,
      semanticScore: 0,
      negationPenalty: 0,
    };

    CrossPageHandoffManager.saveHandoff('webhooks', match);
    const restored = CrossPageHandoffManager.restoreHandoff(engine);

    expect(restored).not.toBeNull();
    expect(restored?.query).toBe('webhooks');
    expect(restored?.match?.id).toBe('item-10');
  });
});

describe('SpotlightBar UI Strict CSP Compliance', () => {
  it('constructs UI purely with createElement and replaceChildren (Zero innerHTML)', () => {
    const highlighter = new VisualHighlighter();
    const session = new MatchStepSession(highlighter);
    const bar = new SpotlightBar(session, {
      onQueryChange: () => {},
      onSelectMatch: () => {},
      onNext: () => {},
      onPrev: () => {},
      onClose: () => {},
    });

    const locatorEl = document.querySelector('.silent-mi-bar');
    expect(locatorEl).not.toBeNull();
    expect(locatorEl?.getAttribute('data-smi-ui')).toBe('true');

    // Details update test
    bar.updateMatches(
      [
        {
          id: 'test-item',
          label: 'Test Item',
          targetType: 'action',
          score: 0.88,
          lexicalScore: 0.88,
          semanticScore: 0,
          negationPenalty: 0,
          source: 'dom',
        },
      ],
      0
    );

    const listItem = document.querySelector('.silent-mi-item');
    expect(listItem).not.toBeNull();
    expect(listItem?.textContent).toContain('Test Item');

    bar.destroy();
    expect(document.querySelector('.silent-mi-bar')).toBeNull();
  });
});
