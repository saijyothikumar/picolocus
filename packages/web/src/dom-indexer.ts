/**
 * @picolocus/web - Zero-config live DOM harvesting & tbody-cached live table scanner
 * Features:
 * - Interactive controls harvesting (buttons, links, inputs, selects, ARIA controls)
 * - Closed drawer parent trigger inference (<details>, aria-controls, data-mi-parent, data-mi-triggers)
 * - Strict UGC isolation: skip [data-mi-untrusted] subtrees entirely
 * - Up to 500 table rows with tbody-cached ancestor lookups (< 5 ms for 200 rows)
 * - 32-bit FNV-1a row fingerprinting to prevent engine re-indexing of unchanged rows
 * - Stable row selectors (#id, data-row-id, data-id, aria-rowindex) avoiding brittle nth-child
 * - Provenance tagging ('trusted_dom' for controls, 'data_row' for live table rows)
 * - Prose clause harvesting (35..650 char paragraphs split to sentence clauses)
 * - Ancestor attribute inheritance (data-mi-ignore, data-mi-roles, data-mi-tier, data-mi-tier-policy)
 * - Embedding sync for unseen live items via embedBatch (falling back to embedDirect) with role: 'document'
 * - Debounced MutationObserver (250 ms) ignoring [data-smi-ui] self-mutations
 */

import { ActionKind, EmbedderPlugin, ManifestItem, TargetType, TierPolicy } from '@picolocus/core';

export interface AncestorAuthMetadata {
  ignored: boolean;
  roles?: string[];
  tier?: string;
  tierPolicy?: TierPolicy;
}

export interface DomRowIndexerOptions {
  harvestRootSelector?: string;
  untrustedSelector?: string;
}

export function fnv1a32(str: string): number {
  let hash = 0x811c9dc5;
  const len = str.length;
  for (let i = 0; i < len; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export class DomRowIndexer {
  private parentIgnoreCache = new WeakMap<Element, boolean>();
  private parentAuthCache = new WeakMap<Element, AncestorAuthMetadata>();
  private rowFingerprints = new Map<string, { hash: number; item: ManifestItem }>();
  private mutationObserver: MutationObserver | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private onMutateCallback: (() => void) | null = null;
  private harvestRootSelector?: string;
  private untrustedSelector: string;

  constructor(options: DomRowIndexerOptions = {}) {
    this.harvestRootSelector = options.harvestRootSelector;
    this.untrustedSelector = options.untrustedSelector || '[data-mi-untrusted], [data-pico-untrusted]';
  }

  clearCache(): void {
    this.parentIgnoreCache = new WeakMap<Element, boolean>();
    this.parentAuthCache = new WeakMap<Element, AncestorAuthMetadata>();
  }

  /**
   * Resolves ancestor metadata with tbody caching to ensure 200-row scans run in < 5 ms.
   * Strictly enforces UGC isolation by ignoring any element inside untrustedSelector.
   */
  resolveAncestorAuth(element: Element): AncestorAuthMetadata {
    // Check if element is inside a tbody
    const tbody = element.closest('tbody');
    const cacheKey = tbody || element.parentElement;

    if (cacheKey && this.parentAuthCache.has(cacheKey)) {
      return this.parentAuthCache.get(cacheKey)!;
    }

    let curr: Element | null = element;
    let ignored = false;
    let roles: string[] | undefined;
    let tier: string | undefined;
    let tierPolicy: TierPolicy | undefined;

    while (curr && curr !== document.documentElement) {
      if (
        curr.getAttribute('data-mi-ignore') === 'true' ||
        curr.hasAttribute('data-smi-ui') ||
        curr.matches?.(this.untrustedSelector) ||
        curr.getAttribute('data-mi-untrusted') === 'true'
      ) {
        ignored = true;
        break;
      }
      if (!roles && curr.hasAttribute('data-mi-roles')) {
        roles = curr
          .getAttribute('data-mi-roles')!
          .split(',')
          .map((r) => r.trim().toLowerCase())
          .filter(Boolean);
      }
      if (!tier && curr.hasAttribute('data-mi-tier')) {
        tier = curr.getAttribute('data-mi-tier')!.trim().toLowerCase();
      }
      if (!tierPolicy && curr.hasAttribute('data-mi-tier-policy')) {
        const pol = curr.getAttribute('data-mi-tier-policy')!.trim().toLowerCase();
        if (pol === 'hide' || pol === 'upsell') {
          tierPolicy = pol;
        }
      }
      curr = curr.parentElement;
    }

    const meta: AncestorAuthMetadata = { ignored, roles, tier, tierPolicy };
    if (cacheKey) {
      this.parentAuthCache.set(cacheKey, meta);
      this.parentIgnoreCache.set(cacheKey, ignored);
    }
    return meta;
  }

  /**
   * Scans the DOM and extracts controls, table rows, and doc clauses.
   */
  harvestDom(root?: ParentNode): ManifestItem[] {
    this.clearCache();
    const docRoot = root ?? (typeof document !== 'undefined' ? document : null);
    if (!docRoot || typeof docRoot.querySelectorAll !== 'function') return [];

    let searchRoot: ParentNode = docRoot;
    if (this.harvestRootSelector && typeof docRoot.querySelector === 'function') {
      const selected = docRoot.querySelector(this.harvestRootSelector);
      if (selected) {
        searchRoot = selected;
      }
    }

    const items: ManifestItem[] = [];

    // 1. Harvest Interactive Controls
    const controlElements = searchRoot.querySelectorAll(
      'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="switch"], [data-mi-id]'
    );

    for (let i = 0; i < controlElements.length; i++) {
      const el = controlElements[i]!;
      // Skip self-UI elements and untrusted UGC subtrees
      if (el.closest('[data-smi-ui="true"]')) continue;
      if (el.closest(this.untrustedSelector)) continue;

      const auth = this.resolveAncestorAuth(el);
      if (auth.ignored) continue;

      // Extract label
      const label =
        el.getAttribute('data-mi-label') ||
        el.getAttribute('aria-label') ||
        (el instanceof HTMLInputElement && el.placeholder ? el.placeholder : '') ||
        el.textContent?.trim() ||
        '';

      if (!label || label.length < 2) continue;

      const id =
        el.getAttribute('data-mi-id') ||
        el.id ||
        `ctrl-${fnv1a32(label + (el.getAttribute('name') || '') + i).toString(16)}`;

      // Infer target type
      let targetType: TargetType = 'action';
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLSelectElement ||
        el instanceof HTMLTextAreaElement ||
        el.getAttribute('role') === 'switch'
      ) {
        targetType = 'setting';
      }

      // Infer closed drawer / accordion triggers or multi-step trigger chains
      let parentTriggerSelector: string | undefined;
      let triggerChain: string[] | undefined;

      const explicitTriggers = el.getAttribute('data-mi-triggers');
      if (explicitTriggers) {
        triggerChain = explicitTriggers
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (triggerChain.length > 0) {
          parentTriggerSelector = triggerChain[0];
        }
      }

      const explicitParent = el.getAttribute('data-mi-parent');
      if (explicitParent) {
        parentTriggerSelector = explicitParent;
        if (!triggerChain) {
          triggerChain = [explicitParent];
        }
      } else if (!parentTriggerSelector) {
        const details = el.closest('details');
        if (details && !details.open) {
          const summary = details.querySelector('summary');
          if (summary) {
            parentTriggerSelector = summary.id ? `#${summary.id}` : `details summary`;
            triggerChain = [parentTriggerSelector];
          }
        }
      }

      // Parse user asks questions and callout hints
      const asksAttr = el.getAttribute('data-mi-asks');
      const whenUserAsks = asksAttr
        ? asksAttr
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;

      const calloutTitle = el.getAttribute('data-mi-callout-title') || undefined;
      const calloutText = el.getAttribute('data-mi-callout-text') || undefined;
      const actionAttr = el.getAttribute('data-mi-action');
      const actionKind = actionAttr ? (actionAttr as ActionKind) : undefined;
      const liveState = el.getAttribute('data-mi-state') || undefined;
      const route =
        el.getAttribute('data-mi-route') ||
        el.closest('[data-mi-route]')?.getAttribute('data-mi-route') ||
        undefined;

      const kwAttr = el.getAttribute('data-mi-keywords');
      const keywords = kwAttr
        ? kwAttr
            .split(',')
            .map((k) => k.trim())
            .filter(Boolean)
        : undefined;

      // Build CSS selector
      const selector = el.id ? `#${el.id}` : `[data-mi-id="${id}"]`;
      if (!el.id && !el.hasAttribute('data-mi-id')) {
        el.setAttribute('data-mi-id', id);
      }

      items.push({
        id,
        targetType,
        label,
        description: el.getAttribute('data-mi-description') || el.getAttribute('title') || undefined,
        selector,
        parentTriggerSelector,
        triggerChain,
        whenUserAsks,
        calloutTitle,
        calloutText,
        kind: actionKind,
        liveStatus: liveState,
        route,
        synonyms: keywords,
        roles: auth.roles,
        requiredTier: auth.tier,
        tierPolicy: auth.tierPolicy,
        source: 'dom',
        provenance: 'trusted_dom',
      });
    }

    // 2. Harvest Live Table Rows (up to 500 rows)
    const rowElements = searchRoot.querySelectorAll('[data-mi-row], table tbody tr');
    const maxRows = Math.min(rowElements.length, 500);

    for (let i = 0; i < maxRows; i++) {
      const tr = rowElements[i]!;
      if (tr.closest('[data-smi-ui="true"]')) continue;
      if (tr.closest(this.untrustedSelector)) continue;

      const auth = this.resolveAncestorAuth(tr);
      if (auth.ignored) continue;

      const rowText = tr.textContent?.trim() || '';
      if (!rowText || rowText.length < 3) continue;

      const rowId =
        tr.getAttribute('data-mi-id') ||
        tr.id ||
        `row-${fnv1a32(rowText + i).toString(16)}`;

      // Status fingerprinting using 32-bit FNV-1a
      const statusAttr = tr.getAttribute('data-mi-status') || tr.getAttribute('class') || '';
      const rowFingerprint = fnv1a32(rowText + statusAttr);

      const cached = this.rowFingerprints.get(rowId);
      if (cached && cached.hash === rowFingerprint) {
        // Reuse existing object reference without engine re-indexing!
        items.push(cached.item);
        continue;
      }

      // Build stable row selector preferring stable attributes over brittle nth-child
      let selector: string;
      if (tr.id) {
        selector = `#${tr.id}`;
      } else if (tr.hasAttribute('data-row-id')) {
        selector = `[data-row-id="${tr.getAttribute('data-row-id')}"]`;
      } else if (tr.hasAttribute('data-id')) {
        selector = `[data-id="${tr.getAttribute('data-id')}"]`;
      } else if (tr.hasAttribute('aria-rowindex')) {
        selector = `[aria-rowindex="${tr.getAttribute('aria-rowindex')}"]`;
      } else {
        selector = `[data-mi-id="${rowId}"]`;
        if (!tr.hasAttribute('data-mi-id')) {
          tr.setAttribute('data-mi-id', rowId);
        }
      }

      // First cell or prominent text as label
      const firstCell = tr.querySelector('td, th');
      const label = firstCell?.textContent?.trim() || rowText.slice(0, 60);

      const newItem: ManifestItem = {
        id: rowId,
        targetType: 'row',
        label,
        description: rowText,
        liveStatus: statusAttr || undefined,
        selector,
        roles: auth.roles,
        requiredTier: auth.tier,
        tierPolicy: auth.tierPolicy,
        source: 'dom',
        provenance: 'data_row',
        rowTextFingerprint: rowFingerprint,
      };

      this.rowFingerprints.set(rowId, { hash: rowFingerprint, item: newItem });
      items.push(newItem);
    }

    // 3. Harvest Prose & Policy Clauses (paragraphs 35..650 characters)
    const docContainers = searchRoot.querySelectorAll('[data-mi-doc], article p, main p');
    for (let i = 0; i < docContainers.length; i++) {
      const p = docContainers[i]!;
      if (p.closest('[data-smi-ui="true"]')) continue;
      if (p.closest(this.untrustedSelector)) continue;

      const auth = this.resolveAncestorAuth(p);
      if (auth.ignored) continue;

      const text = p.textContent?.trim() || '';
      if (text.length < 35 || text.length > 650) continue;

      // Split into sentence clauses
      const sentences = text.split(/(?<=[.!?])\s+/);
      for (let sIdx = 0; sIdx < sentences.length; sIdx++) {
        const sentence = sentences[sIdx]?.trim();
        if (!sentence || sentence.length < 25) continue;

        const clauseId = `clause-${fnv1a32(sentence).toString(16)}`;
        const selector = p.id ? `#${p.id}` : `[data-mi-clause="${clauseId}"]`;
        if (!p.hasAttribute('data-mi-clause')) {
          p.setAttribute('data-mi-clause', clauseId);
        }

        items.push({
          id: clauseId,
          targetType: 'doc_clause',
          label: sentence.slice(0, 60) + (sentence.length > 60 ? '...' : ''),
          verbatimText: sentence,
          selector,
          roles: auth.roles,
          requiredTier: auth.tier,
          tierPolicy: auth.tierPolicy,
          source: 'dom',
        });
      }
    }

    return items;
  }

  /**
   * Syncs embeddings for unseen live items via embedBatch (falling back to embedDirect) with role: 'document'.
   */
  async syncDomEmbeddings(items: ManifestItem[], embedder?: EmbedderPlugin): Promise<void> {
    if (!embedder || !embedder.isEnabled) return;
    if (typeof embedder.isConsented === 'function' && !embedder.isConsented()) return;

    const unEmbedded = items.filter((item) => !item.vector && item.source === 'dom');
    if (unEmbedded.length === 0) return;

    const passages = unEmbedded.map(
      (item) => `${item.label} ${item.description || ''} ${item.verbatimText || ''}`.trim()
    );

    try {
      if (typeof embedder.embedBatch === 'function') {
        const embeddings = await embedder.embedBatch(passages, 'document');
        for (let i = 0; i < unEmbedded.length; i++) {
          const item = unEmbedded[i];
          const emb = embeddings[i];
          if (item && emb) {
            item.vector = Array.from(emb);
            if (item.targetType === 'row' && this.rowFingerprints.has(item.id)) {
              const prev = this.rowFingerprints.get(item.id)!;
              this.rowFingerprints.set(item.id, { hash: prev.hash, item });
            }
          }
        }
      } else if (typeof embedder.embedDirect === 'function') {
        for (let i = 0; i < unEmbedded.length; i++) {
          const item = unEmbedded[i]!;
          const passage = passages[i]!;
          const emb = await embedder.embedDirect(passage, 'document');
          if (emb) {
            item.vector = Array.from(emb);
            if (item.targetType === 'row' && this.rowFingerprints.has(item.id)) {
              const prev = this.rowFingerprints.get(item.id)!;
              this.rowFingerprints.set(item.id, { hash: prev.hash, item });
            }
          }
        }
      }
    } catch {
      // Embedding failure should not crash DOM harvesting
    }
  }

  /**
   * Starts debounced MutationObserver (250 ms) ignoring [data-smi-ui] changes.
   */
  startObserving(target?: Node, onMutate?: () => void): void {
    if (typeof MutationObserver === 'undefined') return;
    const obsTarget = target ?? (typeof document !== 'undefined' ? document.body : null);
    if (!obsTarget || !onMutate) return;
    this.stopObserving();
    this.onMutateCallback = onMutate;

    this.mutationObserver = new MutationObserver((mutations) => {
      // Check if mutations are purely internal to [data-smi-ui]
      let hasExternalMutation = false;
      for (let i = 0; i < mutations.length; i++) {
        const mut = mutations[i]!;
        const targetEl = mut.target instanceof Element ? mut.target : mut.target.parentElement;
        if (targetEl && !targetEl.closest('[data-smi-ui="true"]')) {
          hasExternalMutation = true;
          break;
        }
      }

      if (!hasExternalMutation) return;

      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.clearCache();
        if (this.onMutateCallback) {
          this.onMutateCallback();
        }
      }, 250);
    });

    this.mutationObserver.observe(obsTarget, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        'class',
        'style',
        'hidden',
        'data-mi-status',
        'data-pico-status',
        'aria-expanded',
        'aria-checked',
        'disabled',
        'open',
        'data-state',
      ],
    });
  }

  stopObserving(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.mutationObserver) {
      this.mutationObserver.disconnect();
      this.mutationObserver = null;
    }
  }
}
