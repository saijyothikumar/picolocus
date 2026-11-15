/**
 * @silent-mi/web - Zero-config live DOM harvesting & tbody-cached live table scanner
 * Features:
 * - Interactive controls harvesting (buttons, links, inputs, selects, ARIA controls)
 * - Closed drawer parent trigger inference (<details>, aria-controls, data-mi-parent)
 * - Up to 500 table rows with tbody-cached ancestor lookups (< 5 ms for 200 rows)
 * - 32-bit FNV-1a row fingerprinting to prevent engine re-indexing of unchanged rows
 * - Prose clause harvesting (35..650 char paragraphs split to sentence clauses)
 * - Ancestor attribute inheritance (data-mi-ignore, data-mi-roles, data-mi-tier, data-mi-tier-policy)
 * - Debounced MutationObserver (250 ms) ignoring [data-smi-ui] self-mutations
 */

import { ManifestItem, TargetType, TierPolicy } from '@silent-mi/core';

export interface AncestorAuthMetadata {
  ignored: boolean;
  roles?: string[];
  tier?: string;
  tierPolicy?: TierPolicy;
}

function fnv1a32(str: string): number {
  let hash = 0x811c9dc5;
  const len = str.length;
  for (let i = 0; i < len; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export class DomRowIndexer {
  private parentIgnoreCache = new Map<Element, boolean>();
  private parentAuthCache = new Map<Element, AncestorAuthMetadata>();
  private rowFingerprints = new Map<string, { hash: number; item: ManifestItem }>();
  private mutationObserver: MutationObserver | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private onMutateCallback: (() => void) | null = null;

  clearCache(): void {
    this.parentIgnoreCache.clear();
    this.parentAuthCache.clear();
  }

  /**
   * Resolves ancestor metadata with tbody caching to ensure 200-row scans run in < 5 ms.
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
      if (curr.getAttribute('data-mi-ignore') === 'true' || curr.hasAttribute('data-smi-ui')) {
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
  harvestDom(root: ParentNode = document): ManifestItem[] {
    this.clearCache();
    const items: ManifestItem[] = [];

    // 1. Harvest Interactive Controls
    const controlElements = root.querySelectorAll(
      'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="switch"], [data-mi-id]'
    );

    for (let i = 0; i < controlElements.length; i++) {
      const el = controlElements[i]!;
      // Skip self-UI elements
      if (el.closest('[data-smi-ui="true"]')) continue;

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

      // Infer closed drawer / accordion triggers into parentTriggerSelector
      let parentTriggerSelector: string | undefined;
      const explicitParent = el.getAttribute('data-mi-parent');
      if (explicitParent) {
        parentTriggerSelector = explicitParent;
      } else {
        const details = el.closest('details');
        if (details && !details.open) {
          const summary = details.querySelector('summary');
          if (summary) {
            parentTriggerSelector = summary.id
              ? `#${summary.id}`
              : `details summary`;
          }
        }
      }

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
        roles: auth.roles,
        requiredTier: auth.tier,
        tierPolicy: auth.tierPolicy,
        source: 'dom',
      });
    }

    // 2. Harvest Live Table Rows (up to 500 rows)
    const rowElements = root.querySelectorAll('[data-mi-row], table tbody tr');
    const maxRows = Math.min(rowElements.length, 500);

    for (let i = 0; i < maxRows; i++) {
      const tr = rowElements[i]!;
      if (tr.closest('[data-smi-ui="true"]')) continue;

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

      const selector = tr.id ? `#${tr.id}` : `[data-mi-id="${rowId}"]`;
      if (!tr.id && !tr.hasAttribute('data-mi-id')) {
        tr.setAttribute('data-mi-id', rowId);
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
      };

      this.rowFingerprints.set(rowId, { hash: rowFingerprint, item: newItem });
      items.push(newItem);
    }

    // 3. Harvest Prose & Policy Clauses (paragraphs 35..650 characters)
    const docContainers = root.querySelectorAll('[data-mi-doc], article p, main p');
    for (let i = 0; i < docContainers.length; i++) {
      const p = docContainers[i]!;
      if (p.closest('[data-smi-ui="true"]')) continue;

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
   * Starts debounced MutationObserver (250 ms) ignoring [data-smi-ui] changes.
   */
  startObserving(target: Node = document.body, onMutate: () => void): void {
    if (typeof MutationObserver === 'undefined') return;
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

    this.mutationObserver.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'data-mi-status'],
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
