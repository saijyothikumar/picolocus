/**
 * @picolocus/web - Pure CSS Highlighter & Native CSS.highlights Range API
 * Invariants:
 * - Style active controls via [data-silent-mi-active="true"] and [data-silent-mi-active="upsell"]
 * - Verbatim document sentences highlighted via native CSS.highlights registry (ZERO <mark> DOM mutations)
 * - Skip [data-mi-untrusted] subtrees so untrusted UGC repeating policy sentences is never highlighted
 * - Scroll smoothly WITHOUT calling .focus()
 * - Non-blocking floating callout badge with CSS custom properties
 */

import { SearchMatch } from '@picolocus/core';
import { resolveBestVisibleElement } from './stability.js';

export const CSS_HIGHLIGHT_NAME = 'silent-mi-clause';

export interface VisualHighlighterOptions {
  cspNonce?: string;
  untrustedSelector?: string;
  traverseShadowDom?: boolean;
}

interface CharLocation {
  node: Text;
  offset: number;
}

/**
 * Finds a Range corresponding to verbatimText inside container, skipping untrusted subtrees.
 * Normalizes multi-character whitespace, spans across inline tags, and traverses open shadow roots.
 */
export function findNormalizedSentenceRange(
  container: Element | ParentNode,
  verbatimText: string,
  untrustedSelector = '[data-mi-untrusted]',
  traverseShadowDom = true
): Range | null {
  if (!container || !verbatimText) return null;
  const doc = (container as Element).ownerDocument || (container as Document) || document;

  const textNodes: Text[] = [];

  function collectTextNodes(node: ParentNode): void {
    const walker = doc.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let curr = walker.nextNode();
    while (curr) {
      const textNode = curr as Text;
      const parent = textNode.parentElement;
      if (!parent || !parent.closest(untrustedSelector)) {
        textNodes.push(textNode);
      }
      curr = walker.nextNode();
    }

    if (traverseShadowDom) {
      try {
        const allElements = node.querySelectorAll('*');
        for (let i = 0; i < allElements.length; i++) {
          const el = allElements[i];
          if (el && el.shadowRoot && !el.closest(untrustedSelector)) {
            collectTextNodes(el.shadowRoot);
          }
        }
      } catch {
        // ignore
      }
    }
  }

  collectTextNodes(container);

  if (textNodes.length === 0) return null;

  const charMap: CharLocation[] = [];
  let normalizedStr = '';
  let lastWasSpace = false;

  for (const tNode of textNodes) {
    const val = tNode.nodeValue || '';
    for (let i = 0; i < val.length; i++) {
      const ch = val[i]!;
      const isSpace = /\s/.test(ch);
      if (isSpace) {
        if (!lastWasSpace && normalizedStr.length > 0) {
          normalizedStr += ' ';
          charMap.push({ node: tNode, offset: i });
          lastWasSpace = true;
        }
      } else {
        normalizedStr += ch.toLowerCase();
        charMap.push({ node: tNode, offset: i });
        lastWasSpace = false;
      }
    }
  }

  const targetNorm = verbatimText.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!targetNorm) return null;

  const matchIdx = normalizedStr.indexOf(targetNorm);
  if (matchIdx < 0) return null;

  const startLoc = charMap[matchIdx];
  const endLoc = charMap[matchIdx + targetNorm.length - 1];
  if (!startLoc || !endLoc) return null;

  try {
    const range = doc.createRange();
    range.setStart(startLoc.node, startLoc.offset);
    range.setEnd(endLoc.node, endLoc.offset + 1);
    return range;
  } catch {
    return null;
  }
}

export class VisualHighlighter {
  private activeElement: Element | null = null;
  private calloutBadge: HTMLElement | null = null;
  private styleSheetInjected = false;
  private cspNonce?: string;
  private untrustedSelector: string;
  private traverseShadowDom: boolean;

  constructor(options: VisualHighlighterOptions = {}) {
    this.cspNonce = options.cspNonce;
    this.untrustedSelector = options.untrustedSelector || '[data-mi-untrusted]';
    this.traverseShadowDom = options.traverseShadowDom ?? true;
    this.injectStyles();
  }

  private injectStyles(): void {
    if (typeof document === 'undefined' || this.styleSheetInjected) return;
    const styleId = 'silent-mi-highlighter-styles';
    if (document.getElementById(styleId)) {
      this.styleSheetInjected = true;
      return;
    }

    const style = document.createElement('style');
    style.id = styleId;
    style.setAttribute('data-smi-ui', 'true');
    if (this.cspNonce) {
      style.nonce = this.cspNonce;
      style.setAttribute('nonce', this.cspNonce);
    }

    style.textContent = `
      :root {
        --smi-accent: #6366f1;
        --smi-upsell: #f59e0b;
        --smi-clause-bg: rgba(99, 102, 241, 0.25);
        --smi-z-index: 999998;
      }
      [data-pico-active="true"],
      [data-silent-mi-active="true"] {
        outline: 2px solid var(--smi-accent, #6366f1) !important;
        outline-offset: 3px !important;
        box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.4), 0 0 20px rgba(99, 102, 241, 0.25) !important;
        transition: outline 0.15s ease, box-shadow 0.15s ease !important;
      }
      [data-pico-active="upsell"],
      [data-silent-mi-active="upsell"] {
        outline: 2px solid var(--smi-upsell, #f59e0b) !important;
        outline-offset: 3px !important;
        box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.4), 0 0 20px rgba(245, 158, 11, 0.25) !important;
        transition: outline 0.15s ease, box-shadow 0.15s ease !important;
      }
      ::highlight(${CSS_HIGHLIGHT_NAME}) {
        background-color: var(--smi-clause-bg, rgba(99, 102, 241, 0.25));
        color: inherit;
        text-decoration: underline wavy var(--smi-accent, #6366f1);
      }
      .pico-callout,
      .silent-mi-callout {
        position: absolute;
        z-index: var(--smi-z-index, 999998);
        padding: 6px 12px;
        background: #1e1b4b;
        color: #e0e7ff;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 12px;
        font-weight: 500;
        border-radius: 6px;
        border: 1px solid #4338ca;
        box-shadow: 0 4px 12px rgba(0,0,0,0.25);
        pointer-events: none;
        white-space: nowrap;
        animation: pico-fade 0.2s ease-out;
      }
      @keyframes pico-fade {
        from { opacity: 0; transform: translateY(4px); }
        to { opacity: 1; transform: translateY(0); }
      }
      @keyframes silent-mi-fade {
        from { opacity: 0; transform: translateY(4px); }
        to { opacity: 1; transform: translateY(0); }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
    this.styleSheetInjected = true;
  }

  /**
   * Highlights a matched target without DOM mutations or focus stealing.
   */
  highlightMatch(
    match: SearchMatch,
    root?: ParentNode,
    showCallout = true
  ): Element | null {
    this.clearVisualHighlight();

    if (!match.selector) return null;
    const docRoot = root ?? (typeof document !== 'undefined' ? document : null);
    if (!docRoot) return null;
    const target = resolveBestVisibleElement(docRoot, match.selector, this.traverseShadowDom);
    if (!target) return null;

    this.activeElement = target;

    // Apply pure CSS attribute halo (supporting both data-pico-active and legacy data-silent-mi-active)
    const activeValue = match.tierLocked ? 'upsell' : 'true';
    target.setAttribute('data-pico-active', activeValue);
    target.setAttribute('data-silent-mi-active', activeValue);

    // If doc_clause and verbatimText exists: use native CSS.highlights Range API
    if (match.targetType === 'doc_clause' && match.verbatimText) {
      this.highlightVerbatimClause(target, match.verbatimText);
    }

    // Scroll into view smoothly WITHOUT stealing focus
    try {
      target.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
        inline: 'nearest',
      });
    } catch {
      // Fallback for environments lacking smooth scroll
    }

    // Display non-blocking floating callout badge if requested
    if (showCallout) {
      this.showCalloutBadge(target, match);
    }

    return target;
  }

  /**
   * Highlights verbatim text using native CSS.highlights registry.
   * Invariant: ZERO <mark> tags or DOM node wrapping.
   * Skips text inside untrustedSelector.
   */
  highlightVerbatimClause(container: Element, verbatimText: string): void {
    if (typeof CSS === 'undefined' || !('highlights' in CSS)) {
      return; // Gracefully no-op in environments lacking CSS Custom Highlight API
    }

    const range = findNormalizedSentenceRange(
      container,
      verbatimText,
      this.untrustedSelector,
      this.traverseShadowDom
    );

    if (range) {
      try {
        const HighlightClass = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
        if (HighlightClass) {
          const highlight = new HighlightClass(range);
          (CSS.highlights as unknown as { set(name: string, hl: unknown): void }).set(
            CSS_HIGHLIGHT_NAME,
            highlight
          );
        }
      } catch {
        // Ignore environments with partial CSS.highlights support
      }
    }
  }

  private showCalloutBadge(target: Element, match: SearchMatch): void {
    if (typeof document === 'undefined') return;
    this.removeCalloutBadge();

    const badge = document.createElement('div');
    badge.className = 'pico-callout silent-mi-callout';
    badge.setAttribute('data-smi-ui', 'true');

    // Provenance badge
    let provenanceBadge = 'App Control';
    if (match.provenance === 'data_row') {
      provenanceBadge = 'Live Table Row';
    } else if (match.targetType === 'doc_clause') {
      provenanceBadge = 'Verbatim Policy Excerpt';
    }

    const badgeSpan = document.createElement('span');
    badgeSpan.style.display = 'inline-block';
    badgeSpan.style.fontSize = '10px';
    badgeSpan.style.opacity = '0.75';
    badgeSpan.style.marginRight = '6px';
    badgeSpan.style.textTransform = 'uppercase';
    badgeSpan.textContent = `[${provenanceBadge}]`;
    badge.appendChild(badgeSpan);

    const titleSpan = document.createElement('span');
    titleSpan.textContent = match.tierLocked
      ? `🔒 Requires ${match.upsellTier || 'Upgrade'}`
      : `${match.label} (${Math.round(match.score * 100)}%)`;
    badge.appendChild(titleSpan);

    if (match.stateConflict === 'already_in_target_state') {
      const warnDiv = document.createElement('div');
      warnDiv.style.color = '#fbbf24';
      warnDiv.style.fontSize = '11px';
      warnDiv.style.marginTop = '2px';
      warnDiv.textContent = '⚠️ Already enabled — clicking this control will disable it';
      badge.appendChild(warnDiv);
    }

    let isPopover = false;
    try {
      badge.setAttribute('popover', 'manual');
      if (typeof badge.showPopover === 'function') {
        document.body.appendChild(badge);
        badge.showPopover();
        isPopover = true;
      } else {
        const host = target.closest('dialog[open]') ?? document.body;
        host.appendChild(badge);
      }
    } catch {
      const host = target.closest('dialog[open]') ?? document.body;
      host.appendChild(badge);
    }

    this.calloutBadge = badge;

    // Position above target
    try {
      const rect = target.getBoundingClientRect();
      if (isPopover) {
        badge.style.position = 'fixed';
        badge.style.inset = 'unset';
        badge.style.bottom = 'auto';
        badge.style.right = 'auto';
        badge.style.margin = '0';
        const top = Math.max(10, rect.top - 34);
        const left = Math.max(10, rect.left);
        badge.style.top = `${top}px`;
        badge.style.left = `${left}px`;
      } else {
        badge.style.position = 'absolute';
        const top = Math.max(10, rect.top + window.scrollY - 34);
        const left = Math.max(10, rect.left + window.scrollX);
        badge.style.top = `${top}px`;
        badge.style.left = `${left}px`;
      }
    } catch {
      // Position calculation fallback
    }
  }

  private removeCalloutBadge(): void {
    if (this.calloutBadge) {
      try {
        if (typeof this.calloutBadge.hidePopover === 'function') {
          this.calloutBadge.hidePopover();
        }
      } catch {
        // Ignore
      }
      this.calloutBadge.remove();
      this.calloutBadge = null;
    }
  }

  /**
   * Clears active visual highlight attributes and CSS ranges while preserving stepping state.
   */
  clearVisualHighlight(): void {
    if (this.activeElement) {
      this.activeElement.removeAttribute('data-pico-active');
      this.activeElement.removeAttribute('data-silent-mi-active');
      this.activeElement = null;
    }
    this.removeCalloutBadge();

    // Clear native CSS highlights
    if (typeof CSS !== 'undefined' && 'highlights' in CSS) {
      try {
        CSS.highlights.delete(CSS_HIGHLIGHT_NAME);
      } catch {
        // Ignore
      }
    }
  }
}
