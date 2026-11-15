/**
 * @silent-mi/web - Actions, 2-step drawer breadcrumbs, viewport tie-breakers, and cross-page handoffs
 * Invariant: Never programmatically .click() host controls.
 */

import { SearchMatch, SilentMIEngine, UserContext } from '@silent-mi/core';
import { VisualHighlighter } from './highlighter.js';
import { resolveSafeSameOriginUrl, waitForElementSelector, waitForStableRect } from './stability.js';

export const HANDOFF_STORAGE_KEY = 'silent_mi_handoff_v1';
export const HANDOFF_TTL_MS = 15000;

export interface HandoffPayload {
  query: string;
  targetId: string;
  route?: string;
  timestamp: number;
}

export class MatchStepSession {
  private query = '';
  private matches: SearchMatch[] = [];
  private currentIndex = 0;
  private highlighter: VisualHighlighter;
  private abortController: AbortController | null = null;
  private hostListenerRegistered = false;

  constructor(highlighter: VisualHighlighter) {
    this.highlighter = highlighter;
    this.registerHostInteractions();
  }

  setSession(query: string, matches: SearchMatch[]): void {
    this.query = query;
    this.matches = matches;
    this.currentIndex = 0;
  }

  getCurrent(): SearchMatch | null {
    if (this.matches.length === 0) return null;
    return this.matches[this.currentIndex] || null;
  }

  getIndex(): number {
    return this.currentIndex;
  }

  getTotal(): number {
    return this.matches.length;
  }

  getQuery(): string {
    return this.query;
  }

  next(): SearchMatch | null {
    if (this.matches.length === 0) return null;
    this.currentIndex = (this.currentIndex + 1) % this.matches.length;
    return this.getCurrent();
  }

  prev(): SearchMatch | null {
    if (this.matches.length === 0) return null;
    this.currentIndex = (this.currentIndex - 1 + this.matches.length) % this.matches.length;
    return this.getCurrent();
  }

  jumpTo(index: number): SearchMatch | null {
    if (index >= 0 && index < this.matches.length) {
      this.currentIndex = index;
      return this.getCurrent();
    }
    return null;
  }

  clear(): void {
    this.cancelPendingDrawerGuidance();
    this.query = '';
    this.matches = [];
    this.currentIndex = 0;
    this.highlighter.clearVisualHighlight();
  }

  cancelPendingDrawerGuidance(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  /**
   * Guides user across closed drawers via 2-step breadcrumbs.
   * Step 1: Highlights trigger and awaits human click.
   * Step 2: Awaits geometry stabilization before highlighting target.
   * Invariant: Never calls .click() programmatically.
   */
  async guideMatch(match: SearchMatch, root: ParentNode = document): Promise<void> {
    this.cancelPendingDrawerGuidance();

    // Check if target requires opening a closed parent drawer/trigger
    if (match.parentTriggerSelector) {
      const trigger = root.querySelector(match.parentTriggerSelector);
      const target = match.selector ? root.querySelector(match.selector) : null;

      // If target is already visible or trigger not found, highlight target directly
      const isTargetVisible = target && this.isElementVisible(target);

      if (trigger && !isTargetVisible) {
        // Step 1: Highlight parent trigger
        trigger.setAttribute('data-silent-mi-active', 'true');
        try {
          trigger.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } catch {
          // Ignore
        }

        const ac = new AbortController();
        this.abortController = ac;

        // Auto-expire listener after 15 seconds
        const timeout = setTimeout(() => {
          ac.abort();
          trigger.removeAttribute('data-silent-mi-active');
        }, 15000);

        trigger.addEventListener(
          'click',
          async () => {
            clearTimeout(timeout);
            trigger.removeAttribute('data-silent-mi-active');
            if (ac.signal.aborted) return;

            // Wait for lazy drawer portal and CSS stabilization
            if (match.selector) {
              await waitForElementSelector(match.selector, root, 650);
              const resolvedTarget = root.querySelector(match.selector);
              if (resolvedTarget) {
                await waitForStableRect(resolvedTarget, 900);
                // Step 2: Highlight target inside open drawer
                this.highlighter.highlightMatch(match, root);
              }
            }
          },
          { once: true, signal: ac.signal }
        );

        return;
      }
    }

    // Direct Step 1 highlight
    this.highlighter.highlightMatch(match, root);
  }

  private isElementVisible(el: Element): boolean {
    if (!(el instanceof HTMLElement)) return true;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /**
   * Registers click on host controls or Escape to dismiss visual rings without resetting session.
   */
  private registerHostInteractions(): void {
    if (typeof document === 'undefined' || this.hostListenerRegistered) return;

    document.addEventListener('click', (e) => {
      const target = e.target as Element | null;
      // If clicking outside the docked locator UI, clear visual rings while preserving session
      if (target && !target.closest('[data-smi-ui="true"]')) {
        this.highlighter.clearVisualHighlight();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.highlighter.clearVisualHighlight();
      }
    });

    this.hostListenerRegistered = true;
  }
}

/**
 * Viewport tie-breaker boost calculator with 500ms cache.
 * Boosts: +0.035 visible in-page, +0.020 hidden in-page within 0.15 of top score.
 */
export class ViewportTieBreaker {
  private cache = new Map<string, { boost: number; timestamp: number }>();

  getBoost(match: SearchMatch, topScore: number, root: ParentNode = document): number {
    if (!match.selector) return 0.0;
    const now = performance.now();
    const cached = this.cache.get(match.id);
    if (cached && now - cached.timestamp < 500) {
      return cached.boost;
    }

    let boost = 0.0;
    try {
      const el = root.querySelector(match.selector);
      if (el) {
        const rect = el.getBoundingClientRect();
        const isInViewport =
          rect.top >= 0 &&
          rect.left >= 0 &&
          rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
          rect.right <= (window.innerWidth || document.documentElement.clientWidth);

        if (isInViewport && rect.width > 0 && rect.height > 0) {
          boost = 0.035;
        } else if (match.parentTriggerSelector && topScore - match.score <= 0.15) {
          boost = 0.020;
        }
      }
    } catch {
      // Fallback
    }

    this.cache.set(match.id, { boost, timestamp: now });
    return boost;
  }
}

/**
 * Prototype-safe cross-page handoff management via sessionStorage with 15-second TTL.
 */
export class CrossPageHandoffManager {
  static saveHandoff(query: string, match: SearchMatch): void {
    if (typeof sessionStorage === 'undefined') return;
    try {
      const payload: HandoffPayload = {
        query,
        targetId: match.id,
        route: match.route,
        timestamp: Date.now(),
      };
      sessionStorage.setItem(HANDOFF_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Storage errors ignored
    }
  }

  static restoreHandoff(
    engine: SilentMIEngine,
    user?: UserContext
  ): { query: string; match: SearchMatch | null } | null {
    if (typeof sessionStorage === 'undefined') return null;
    try {
      const raw = sessionStorage.getItem(HANDOFF_STORAGE_KEY);
      if (!raw) return null;
      sessionStorage.removeItem(HANDOFF_STORAGE_KEY);

      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;

      // Strip __proto__ keys
      const safe: Record<string, unknown> = Object.create(null);
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        safe[k] = v;
      }

      const timestamp = typeof safe['timestamp'] === 'number' ? safe['timestamp'] : 0;
      if (Date.now() - timestamp > HANDOFF_TTL_MS) {
        return null; // Expired
      }

      const query = typeof safe['query'] === 'string' ? safe['query'] : '';
      const targetId = typeof safe['targetId'] === 'string' ? safe['targetId'] : '';

      // Re-run search and re-filter through engine.filterAuthorizedMatches
      const results = engine.searchInstant(query, user);
      const authorizedMatches = engine.filterAuthorizedMatches(results.matches, user);

      const match = authorizedMatches.find((m) => m.id === targetId) || null;
      return { query, match };
    } catch {
      return null;
    }
  }
}
