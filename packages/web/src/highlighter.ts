/**
 * @silent-mi/web - Pure CSS Highlighter & Native CSS.highlights Range API
 * Invariants:
 * - Style active controls via [data-silent-mi-active="true"] (#6366f1) and [data-silent-mi-active="upsell"] (#f59e0b)
 * - Verbatim document sentences highlighted via native CSS.highlights registry (ZERO <mark> DOM mutations)
 * - Scroll smoothly WITHOUT calling .focus()
 * - Non-blocking floating callout badge
 */

import { SearchMatch } from '@silent-mi/core';

export const CSS_HIGHLIGHT_NAME = 'silent-mi-clause';

export class VisualHighlighter {
  private activeElement: Element | null = null;
  private calloutBadge: HTMLElement | null = null;
  private styleSheetInjected = false;

  constructor() {
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
    style.textContent = `
      [data-silent-mi-active="true"] {
        outline: 2px solid #6366f1 !important;
        outline-offset: 3px !important;
        box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.4), 0 0 20px rgba(99, 102, 241, 0.25) !important;
        transition: outline 0.15s ease, box-shadow 0.15s ease !important;
      }
      [data-silent-mi-active="upsell"] {
        outline: 2px solid #f59e0b !important;
        outline-offset: 3px !important;
        box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.4), 0 0 20px rgba(245, 158, 11, 0.25) !important;
        transition: outline 0.15s ease, box-shadow 0.15s ease !important;
      }
      ::highlight(${CSS_HIGHLIGHT_NAME}) {
        background-color: rgba(99, 102, 241, 0.25);
        color: inherit;
        text-decoration: underline wavy #6366f1;
      }
      .silent-mi-callout {
        position: absolute;
        z-index: 999998;
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
        animation: silent-mi-fade 0.2s ease-out;
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
  highlightMatch(match: SearchMatch, root: ParentNode = document): Element | null {
    this.clearVisualHighlight();

    if (!match.selector) return null;
    const target = root.querySelector(match.selector);
    if (!target) return null;

    this.activeElement = target;

    // Apply pure CSS attribute halo
    const activeValue = match.tierLocked ? 'upsell' : 'true';
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

    // Display non-blocking floating callout badge
    this.showCalloutBadge(target, match);

    return target;
  }

  /**
   * Highlights verbatim text using native CSS.highlights registry.
   * Invariant: ZERO <mark> tags or DOM node wrapping.
   */
  highlightVerbatimClause(container: Element, verbatimText: string): void {
    if (typeof CSS === 'undefined' || !('highlights' in CSS)) {
      return; // Gracefully no-op in environments lacking CSS Custom Highlight API
    }

    const doc = container.ownerDocument || document;
    const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const normalizedTarget = verbatimText.trim().toLowerCase();

    const ranges: Range[] = [];
    let currentNode = walker.nextNode();

    while (currentNode) {
      const nodeText = currentNode.nodeValue || '';
      const idx = nodeText.toLowerCase().indexOf(normalizedTarget);
      if (idx >= 0) {
        const range = doc.createRange();
        range.setStart(currentNode, idx);
        range.setEnd(currentNode, idx + verbatimText.length);
        ranges.push(range);
        break;
      }
      currentNode = walker.nextNode();
    }

    if (ranges.length > 0) {
      const highlight = new Highlight(...ranges);
      CSS.highlights.set(CSS_HIGHLIGHT_NAME, highlight);
    }
  }

  private showCalloutBadge(target: Element, match: SearchMatch): void {
    if (typeof document === 'undefined') return;
    this.removeCalloutBadge();

    const badge = document.createElement('div');
    badge.className = 'silent-mi-callout';
    badge.setAttribute('data-smi-ui', 'true');

    const badgeText = match.tierLocked
      ? `🔒 Requires ${match.upsellTier || 'Upgrade'}`
      : `${match.label} (${Math.round(match.score * 100)}% match)`;
    badge.textContent = badgeText;

    document.body.appendChild(badge);
    this.calloutBadge = badge;

    // Position above target
    try {
      const rect = target.getBoundingClientRect();
      const top = Math.max(10, rect.top + window.scrollY - 34);
      const left = Math.max(10, rect.left + window.scrollX);
      badge.style.top = `${top}px`;
      badge.style.left = `${left}px`;
    } catch {
      // Position calculation fallback
    }
  }

  private removeCalloutBadge(): void {
    if (this.calloutBadge) {
      this.calloutBadge.remove();
      this.calloutBadge = null;
    }
  }

  /**
   * Clears active visual highlight attributes and CSS ranges while preserving stepping state.
   */
  clearVisualHighlight(): void {
    if (this.activeElement) {
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
