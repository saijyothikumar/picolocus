/**
 * @picolocus/web - Actions, N-step triggerChain breadcrumbs, Top-Layer modal callouts,
 * zero-reload SPA routing, and cross-page handoffs
 * Invariant: Never programmatically .click() host controls.
 */

import { SearchMatch, SilentMIEngine, UserContext, normalizeRoute } from '@picolocus/core';
import { VisualHighlighter } from './highlighter.js';
import { fnv1a32 } from './dom-indexer.js';
import {
  isElementVisible,
  resolveBestVisibleElement,
  resolveSafeSameOriginUrl,
  waitForElementSelector,
  waitForStableRect,
} from './stability.js';

export const DEFAULT_HANDOFF_KEY = 'silent_mi_handoff_v4';
export const HANDOFF_TTL_MS = 15000;

export interface HandoffPayload {
  query: string;
  targetId: string;
  route?: string;
  timestamp: number;
}

export interface GuideResult {
  mode: 'direct' | 'breadcrumb_step_1' | 'breadcrumb_step_k' | 'route_navigated' | 'missing';
  stepIndex: number;
  totalSteps: number;
  element: Element | null;
}

export interface MatchStepSessionOptions {
  onNavigate?: (route: string) => void | Promise<void>;
  basePath?: string;
  routingMode?: 'pathname' | 'hash';
  storageNamespace?: string;
  stepRevealTimeoutMs?: number;
  blockedRoutes?: string[];
}

export class MatchStepSession {
  private query = '';
  private matches: SearchMatch[] = [];
  private currentIndex = 0;
  private highlighter: VisualHighlighter;
  private abortController: AbortController | null = null;
  private drawerTimeout: ReturnType<typeof setTimeout> | null = null;
  private activeTriggerEl: Element | null = null;
  private hostListenerRegistered = false;
  private calloutEl: HTMLElement | null = null;
  private outsideInteractionListener?: (e: Event) => void;
  private escapeKeyListener?: (e: KeyboardEvent) => void;

  public onNavigate?: (route: string) => void | Promise<void>;
  public basePath?: string;
  public routingMode: 'pathname' | 'hash';
  public storageNamespace: string;
  public stepRevealTimeoutMs: number;
  public blockedRoutes: string[];

  constructor(highlighter: VisualHighlighter, options: MatchStepSessionOptions = {}) {
    this.highlighter = highlighter;
    this.onNavigate = options.onNavigate;
    this.basePath = options.basePath;
    this.routingMode = options.routingMode || 'pathname';
    this.storageNamespace = options.storageNamespace || 'silent_mi';
    this.stepRevealTimeoutMs = options.stepRevealTimeoutMs || 2500;
    this.blockedRoutes = options.blockedRoutes || ['/logout', '/signout'];
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

  getMatches(): SearchMatch[] {
    return this.matches;
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
    this.removeCallout();
  }

  cancelPendingDrawerGuidance(): void {
    if (this.drawerTimeout !== null) {
      clearTimeout(this.drawerTimeout);
      this.drawerTimeout = null;
    }
    if (this.activeTriggerEl) {
      this.activeTriggerEl.removeAttribute('data-pico-active');
      this.activeTriggerEl.removeAttribute('data-silent-mi-active');
      this.activeTriggerEl = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  /**
   * Guides user across closed drawers, tabs, popups, and portal menus via N-step breadcrumbs.
   * Step 1 highlights trigger and awaits human click or Enter/Space.
   * Step 2 awaits geometry stabilization before highlighting target or next trigger.
   * Invariant: Never calls .click() programmatically.
   */
  async guideMatch(match: SearchMatch, root?: ParentNode): Promise<GuideResult> {
    this.cancelPendingDrawerGuidance();
    this.removeCallout();

    const docRoot = root ?? (typeof document !== 'undefined' ? document : null);
    if (!docRoot) {
      return { mode: 'missing', stepIndex: 0, totalSteps: 1, element: null };
    }

    // 1. Check trigger chain visibility on current page before auto-navigating
    const chain: string[] =
      match.triggerChain && match.triggerChain.length > 0
        ? match.triggerChain
        : match.parentTriggerSelector
          ? [match.parentTriggerSelector]
          : [];

    const hasVisibleTriggerInChain = chain.some((sel) => {
      const el = resolveBestVisibleElement(docRoot, sel, true);
      return Boolean(el && this.isElementVisible(el));
    });

    // Zero-reload SPA routing via optional onNavigate (when not guided by a visible in-page trigger)
    if (!hasVisibleTriggerInChain && match.route && typeof window !== 'undefined' && window.location) {
      const currentLoc = this.routingMode === 'hash' ? window.location.hash : window.location.pathname;
      const currentNorm = normalizeRoute(currentLoc, {
        basePath: this.basePath,
        routingMode: this.routingMode,
      });
      const targetNorm = normalizeRoute(match.route, {
        basePath: this.basePath,
        routingMode: this.routingMode,
      });

      if (currentNorm !== targetNorm) {
        if (this.onNavigate) {
          await this.onNavigate(match.route);
          if (match.selector) {
            await waitForElementSelector(match.selector, docRoot, this.stepRevealTimeoutMs);
          }
        } else {
          CrossPageHandoffManager.saveHandoff(this.query, match, this.storageNamespace);
          const safeUrl = resolveSafeSameOriginUrl(match.route, undefined, this.blockedRoutes);
          if (safeUrl) {
            window.location.assign(safeUrl);
            return { mode: 'route_navigated', stepIndex: 0, totalSteps: 1, element: null };
          }
        }
      }
    }

    // 2. Check if target element is already visible
    const target = match.selector ? resolveBestVisibleElement(docRoot, match.selector, true) : null;
    const isTargetVisible = target ? this.isElementVisible(target) : false;

    if (isTargetVisible || chain.length === 0) {
      if (target) {
        this.highlighter.highlightMatch(match, docRoot, false);
        this.showTopLayerCallout(target, match);
        return { mode: 'direct', stepIndex: 0, totalSteps: 1, element: target };
      }
      // Target selector missing from DOM
      this.showMissingSelectorNotice(match.selector || match.label);
      return { mode: 'missing', stepIndex: 0, totalSteps: 1, element: null };
    }

    // 4. Find the deepest currently visible trigger k in triggerChain
    let startK = 0;
    let foundVisible = false;
    for (let k = chain.length - 1; k >= 0; k--) {
      const trigSel = chain[k]!;
      const candidate = resolveBestVisibleElement(docRoot, trigSel, true);
      if (candidate && this.isElementVisible(candidate)) {
        startK = k;
        foundVisible = true;
        break;
      }
    }

    if (!foundVisible) {
      if (target && isTargetVisible) {
        this.highlighter.highlightMatch(match, docRoot, false);
        this.showTopLayerCallout(target, match);
        return { mode: 'direct', stepIndex: 0, totalSteps: 1, element: target };
      }
      const missingSel = chain[0] || match.selector || match.label;
      this.showMissingSelectorNotice(missingSel);
      return { mode: 'missing', stepIndex: 0, totalSteps: chain.length + 1, element: null };
    }

    const triggerSelector = chain[startK]!;
    const trigger = resolveBestVisibleElement(docRoot, triggerSelector, true);

    if (!trigger) {
      // Trigger not found in DOM, fallback to highlighting target or showing notice
      if (target) {
        this.highlighter.highlightMatch(match, docRoot, false);
        this.showTopLayerCallout(target, match);
        return { mode: 'direct', stepIndex: 0, totalSteps: 1, element: target };
      }
      this.showMissingSelectorNotice(triggerSelector);
      return { mode: 'missing', stepIndex: 0, totalSteps: 1, element: null };
    }

    // Highlight trigger (supporting both modern data-pico-active and legacy data-silent-mi-active)
    trigger.setAttribute('data-pico-active', 'true');
    trigger.setAttribute('data-silent-mi-active', 'true');
    this.activeTriggerEl = trigger;
    try {
      trigger.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch {
      // Ignore
    }

    const totalSteps = chain.length + 1;
    const currentStepNum = startK + 1;
    this.showStepCallout(trigger, `Step ${currentStepNum} of ${totalSteps}: Click to reveal`);

    const ac = new AbortController();
    this.abortController = ac;

    // Auto-expire trigger highlight after 15 seconds
    this.drawerTimeout = setTimeout(() => {
      ac.abort();
      if (this.activeTriggerEl === trigger) {
        this.activeTriggerEl = null;
      }
      trigger.removeAttribute('data-pico-active');
      trigger.removeAttribute('data-silent-mi-active');
      this.removeCallout();
      this.drawerTimeout = null;
    }, 15000);

    let isAdvancing = false;
    const advanceStep = async () => {
      if (isAdvancing) return;
      isAdvancing = true;
      if (this.drawerTimeout !== null) {
        clearTimeout(this.drawerTimeout);
        this.drawerTimeout = null;
      }
      if (this.activeTriggerEl === trigger) {
        this.activeTriggerEl = null;
      }
      trigger.removeAttribute('data-pico-active');
      trigger.removeAttribute('data-silent-mi-active');
      this.removeCallout();
      if (ac.signal.aborted) return;

      const nextSelector = startK + 1 < chain.length ? chain[startK + 1]! : match.selector;
      if (nextSelector) {
        const nextEl = await waitForElementSelector(nextSelector, docRoot, this.stepRevealTimeoutMs);
        if (ac.signal.aborted) return;
        if (nextEl) {
          await waitForStableRect(nextEl, 900);
          if (ac.signal.aborted) return;
          if (startK + 1 < chain.length) {
            // Guide next trigger in chain
            await this.guideMatch(match, docRoot);
          } else {
            // Final target reached
            this.highlighter.highlightMatch(match, docRoot, false);
            this.showTopLayerCallout(nextEl, match);
          }
        } else {
          this.showMissingSelectorNotice(nextSelector);
        }
      }
    };

    trigger.addEventListener('click', () => void advanceStep(), { once: true, signal: ac.signal });
    const onTriggerKey = (e: Event) => {
      const kb = e as KeyboardEvent;
      if (kb.key === 'Enter' || kb.key === ' ') {
        void advanceStep();
      }
    };
    trigger.addEventListener('keydown', onTriggerKey, { signal: ac.signal });

    return {
      mode: startK === 0 ? 'breadcrumb_step_1' : 'breadcrumb_step_k',
      stepIndex: startK,
      totalSteps,
      element: trigger,
    };
  }

  private isElementVisible(el: Element): boolean {
    return isElementVisible(el);
  }

  /**
   * Top-Layer modal callout visibility using popover="manual" with fallback for <dialog open>.
   * Displays provenance badges, live-state reversal warnings, and disabled state guards.
   */
  private showTopLayerCallout(target: Element, match: SearchMatch): void {
    if (typeof document === 'undefined') return;
    this.removeCallout();

    const callout = document.createElement('div');
    callout.className = 'pico-callout silent-mi-callout';
    callout.setAttribute('data-smi-ui', 'true');

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
    callout.appendChild(badgeSpan);

    const titleSpan = document.createElement('span');
    titleSpan.textContent = match.tierLocked
      ? `🔒 Requires ${match.upsellTier || 'Upgrade'}`
      : `${match.label} (${Math.round(match.score * 100)}%)`;
    callout.appendChild(titleSpan);

    // Live-state reversal warning
    const isTargetAlreadyInState =
      match.stateConflict === 'already_in_target_state' ||
      target.getAttribute('data-mi-state') === 'enabled' ||
      target.getAttribute('aria-checked') === 'true' ||
      Boolean(
        target.textContent &&
        /^(disable|turn off|deactivate)/i.test(target.textContent.trim()) &&
        /enable|turn on|activate/i.test(match.label)
      );

    if (isTargetAlreadyInState) {
      const warnDiv = document.createElement('div');
      warnDiv.style.color = '#fbbf24';
      warnDiv.style.fontSize = '11px';
      warnDiv.style.marginTop = '2px';
      warnDiv.textContent = '⚠️ Already enabled — clicking this control will disable it';
      callout.appendChild(warnDiv);
    }

    // Live disabled control check
    const isDisabled =
      target.matches?.(':disabled') ||
      target.getAttribute('aria-disabled') === 'true' ||
      target.hasAttribute('disabled');
    if (isDisabled) {
      const disDiv = document.createElement('div');
      disDiv.style.color = '#f87171';
      disDiv.style.fontSize = '11px';
      disDiv.style.marginTop = '2px';
      disDiv.textContent = '⚠️ Control is currently disabled';
      callout.appendChild(disDiv);
    }

    // RowTextFingerprint verification for virtualized tables
    if (match.provenance === 'data_row' && typeof match.rowTextFingerprint === 'number') {
      const currentText = target.textContent?.trim() || '';
      const currentStatus = target.getAttribute('data-mi-status') || target.getAttribute('class') || '';
      const currFingerprint = fnv1a32(currentText + currentStatus);
      if (currFingerprint !== match.rowTextFingerprint) {
        const rowWarn = document.createElement('div');
        rowWarn.style.color = '#fbbf24';
        rowWarn.style.fontSize = '11px';
        rowWarn.style.marginTop = '2px';
        rowWarn.textContent = '⚠️ Table row content was updated';
        callout.appendChild(rowWarn);
      }
    }

    this.mountCallout(callout, target);
  }

  private showStepCallout(target: Element, text: string): void {
    if (typeof document === 'undefined') return;
    this.removeCallout();

    const callout = document.createElement('div');
    callout.className = 'pico-callout silent-mi-callout';
    callout.setAttribute('data-smi-ui', 'true');
    callout.textContent = text;

    this.mountCallout(callout, target);
  }

  private showMissingSelectorNotice(selectorOrLabel: string): void {
    if (typeof document === 'undefined') return;
    this.removeCallout();

    const notice = document.createElement('div');
    notice.className = 'pico-callout silent-mi-callout';
    notice.setAttribute('data-smi-ui', 'true');
    notice.style.position = 'fixed';
    notice.style.bottom = '20px';
    notice.style.right = '20px';
    notice.style.background = '#374151';
    notice.style.color = '#9ca3af';
    notice.textContent = `Target control (${selectorOrLabel}) not found on current page.`;

    document.body.appendChild(notice);
    this.calloutEl = notice;
    setTimeout(() => {
      if (this.calloutEl === notice) {
        this.removeCallout();
      }
    }, 4000);
  }

  private mountCallout(callout: HTMLElement, anchorEl: Element): void {
    let isPopover = false;
    try {
      callout.setAttribute('popover', 'manual');
      if (typeof callout.showPopover === 'function') {
        document.body.appendChild(callout);
        callout.showPopover();
        isPopover = true;
      } else {
        const host = anchorEl.closest('dialog[open]') ?? document.body;
        host.appendChild(callout);
      }
    } catch {
      const host = anchorEl.closest('dialog[open]') ?? document.body;
      host.appendChild(callout);
    }

    this.calloutEl = callout;

    // Position above anchor element (or flip below if too close to viewport top)
    try {
      const rect = anchorEl.getBoundingClientRect();
      if (isPopover) {
        callout.style.position = 'fixed';
        callout.style.margin = '0';
        callout.style.inset = 'unset';
        callout.style.bottom = 'auto';
        callout.style.right = 'auto';
        const top = rect.top >= 42 ? rect.top - 36 : rect.bottom + 6;
        const maxLeft = Math.max(10, (window.innerWidth || 360) - 260);
        const left = Math.max(10, Math.min(rect.left, maxLeft));
        callout.style.top = `${top}px`;
        callout.style.left = `${left}px`;
      } else {
        callout.style.position = 'absolute';
        const top = Math.max(10, rect.top + window.scrollY - 36);
        const left = Math.max(10, rect.left + window.scrollX);
        callout.style.top = `${top}px`;
        callout.style.left = `${left}px`;
      }
    } catch {
      // Fallback
    }
  }

  private removeCallout(): void {
    if (this.calloutEl) {
      try {
        if (typeof this.calloutEl.hidePopover === 'function') {
          this.calloutEl.hidePopover();
        }
      } catch {
        // Ignore
      }
      this.calloutEl.remove();
      this.calloutEl = null;
    }
  }

  /**
   * Registers pointerdown outside-click listener with composedPath() so Shadow DOM is pierced.
   */
  private registerHostInteractions(): void {
    if (typeof document === 'undefined' || this.hostListenerRegistered) return;

    const handleOutsideInteraction = (e: Event) => {
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [e.target];

      // 1. If clicking inside locator UI or callout, retain
      const clickedSmiUi = path.some(
        (node) =>
          node instanceof Element &&
          (node.hasAttribute('data-smi-ui') || node.closest?.('[data-smi-ui="true"]'))
      );
      if (clickedSmiUi) return;

      // 2. If clicking on active target element -> highlight relief (halo removed, zero focus stealing)
      const clickedActiveTarget = path.some(
        (node) =>
          node instanceof Element &&
          (node.getAttribute('data-pico-active') === 'true' ||
            node.closest?.('[data-pico-active="true"]') ||
            node.getAttribute('data-silent-mi-active') === 'true' ||
            node.closest?.('[data-silent-mi-active="true"]'))
      );
      if (clickedActiveTarget) {
        this.highlighter.clearVisualHighlight();
        this.removeCallout();
        return;
      }

      // 3. Otherwise clicked outside -> dismiss highlight, callout, and any pending drawer step
      this.cancelPendingDrawerGuidance();
      this.highlighter.clearVisualHighlight();
      this.removeCallout();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.cancelPendingDrawerGuidance();
        this.highlighter.clearVisualHighlight();
        this.removeCallout();
      }
    };

    this.outsideInteractionListener = handleOutsideInteraction;
    this.escapeKeyListener = handleKeyDown;

    document.addEventListener('pointerdown', handleOutsideInteraction, { capture: true });
    document.addEventListener('keydown', handleKeyDown);

    this.hostListenerRegistered = true;
  }

  destroy(): void {
    this.clear();
    if (typeof document !== 'undefined') {
      if (this.outsideInteractionListener) {
        document.removeEventListener('pointerdown', this.outsideInteractionListener, { capture: true });
        this.outsideInteractionListener = undefined;
      }
      if (this.escapeKeyListener) {
        document.removeEventListener('keydown', this.escapeKeyListener);
        this.escapeKeyListener = undefined;
      }
    }
    this.hostListenerRegistered = false;
  }
}

/**
 * Viewport tie-breaker boost calculator with 500ms cache.
 * Boosts: +0.035 visible in-page, +0.020 hidden in-page within 0.15 of top score.
 */
export class ViewportTieBreaker {
  private cache = new Map<string, { boost: number; timestamp: number }>();

  getBoost(match: SearchMatch, topScore: number, root?: ParentNode): number {
    const docRoot = root ?? (typeof document !== 'undefined' ? document : null);
    if (!docRoot || !match.selector) return 0.0;
    const now = performance.now();
    const cached = this.cache.get(match.id);
    if (cached && now - cached.timestamp < 500) {
      return cached.boost;
    }

    let boost = 0.0;
    try {
      const el = docRoot.querySelector(match.selector);
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
  static getStorageKey(storageNamespace = 'silent_mi'): string {
    return `${storageNamespace}_handoff_v4`;
  }

  static saveHandoff(query: string, match: SearchMatch, storageNamespace = 'silent_mi'): void {
    if (typeof sessionStorage === 'undefined') return;
    try {
      const payload: HandoffPayload = {
        query,
        targetId: match.id,
        route: match.route,
        timestamp: Date.now(),
      };
      const key = this.getStorageKey(storageNamespace);
      sessionStorage.setItem(key, JSON.stringify(payload));
    } catch {
      // Storage errors ignored
    }
  }

  static restoreHandoff(
    engine: SilentMIEngine,
    user?: UserContext,
    storageNamespace = 'silent_mi'
  ): { query: string; match: SearchMatch | null } | null {
    if (typeof sessionStorage === 'undefined') return null;
    try {
      const key = this.getStorageKey(storageNamespace);
      let raw = sessionStorage.getItem(key);
      if (raw) {
        sessionStorage.removeItem(key);
      } else {
        // Fallback to older keys for backward test compatibility
        const fallbackKeys = ['silent_mi_handoff_v4', 'silent_mi_handoff_v1'];
        for (const fbKey of fallbackKeys) {
          raw = sessionStorage.getItem(fbKey);
          if (raw) {
            sessionStorage.removeItem(fbKey);
            break;
          }
        }
      }

      if (!raw) return null;

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
