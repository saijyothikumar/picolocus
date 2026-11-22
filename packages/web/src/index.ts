/**
 * @picolocus/web
 * Client-Side Micro-Intelligence Web SDK (v1.0.2)
 * License: Apache-2.0
 */

import {
  EmbedderPlugin,
  EngineOptions,
  HabitMemory,
  HarnessConfig,
  ManifestItem,
  normalizeRoute,
  PlaybookDomSnapshot,
  RoleManifest,
  SearchMatch,
  SearchResponse,
  SilentMIEngine,
  UserContext,
} from '@picolocus/core';

import { DomRowIndexer, DomRowIndexerOptions } from './dom-indexer.js';
import { VisualHighlighter, VisualHighlighterOptions } from './highlighter.js';
import {
  CrossPageHandoffManager,
  GuideResult,
  MatchStepSession,
  MatchStepSessionOptions,
  ViewportTieBreaker,
} from './actions.js';
import {
  DEFAULT_I18N,
  SpotlightBar,
  SpotlightBarCallbacks,
  SpotlightBarOptions,
  SpotlightI18n,
} from './spotlight-bar.js';
import { isElementVisible, resolveBestVisibleElement, resolveSafeSameOriginUrl } from './stability.js';

export * from './stability.js';
export * from './dom-indexer.js';
export * from './highlighter.js';
export * from './actions.js';
export * from './spotlight-bar.js';

export interface SilentMIConfig extends EngineOptions {
  user?: UserContext;
  manifestUrls?: {
    public?: string;
    docs?: string;
    byRole?: Record<string, string>;
  };
  embedder?: EmbedderPlugin;
  autoHarvestDom?: boolean;
  harvestRootSelector?: string;
  untrustedSelector?: string;
  storageNamespace?: string;
  habitStorage?: 'local' | 'session' | 'memory' | 'off';
  basePath?: string;
  routingMode?: 'pathname' | 'hash';
  onNavigate?: (route: string) => void | Promise<void>;
  blockedRoutes?: string[];
  stepRevealTimeoutMs?: number;
  hotkey?: string;
  cspNonce?: string;
  i18n?: Partial<SpotlightI18n>;
  showBar?: boolean;
}

export interface SilentMIClient {
  query(text: string, user?: UserContext): Promise<SearchResponse>;
  guide(matchOrId: SearchMatch | string): Promise<GuideResult>;
  grantConsent(): Promise<void>;
  revokeConsent(): Promise<void>;
  isConsented(): boolean;
  setAppState(state: Record<string, string | number | boolean | null>): void;
  getAppState(): Record<string, string | number | boolean | null>;
  registerHarness(harness: HarnessConfig): void;
  registerItems(items: ManifestItem[]): void;
  setUserContext(user: UserContext): Promise<void>;
  destroy(): void;
}

export class SilentMIController implements SilentMIClient {
  public engine: SilentMIEngine;
  public domIndexer: DomRowIndexer;
  public highlighter: VisualHighlighter;
  public session: MatchStepSession;
  public tieBreaker: ViewportTieBreaker;
  public spotlightBar?: SpotlightBar;
  public embedder: EmbedderPlugin | null = null;
  public userContext: UserContext | undefined;
  public config: SilentMIConfig;

  private activeQuery = '';
  private appState: Record<string, string | number | boolean | null> = {};
  private storageNamespace: string;
  private habitStorage: 'local' | 'session' | 'memory' | 'off';
  private habitStorageKey: string;
  private routeListener?: () => void;
  private isDestroyed = false;

  constructor(config: SilentMIConfig = {}) {
    this.config = config;
    this.userContext = config.user;
    this.storageNamespace = config.storageNamespace || 'picolocus';
    this.habitStorage = config.habitStorage || 'local';
    this.habitStorageKey = `${this.storageNamespace}_habit_v2`;

    // Load initial habit memory from storage (with backward compatibility)
    let initialHabits: string | null = null;
    if (this.habitStorage === 'local' && typeof localStorage !== 'undefined') {
      try {
        initialHabits = localStorage.getItem(this.habitStorageKey) || localStorage.getItem('silent_mi_habit_v2');
      } catch {
        // Storage access blocked
      }
    } else if (this.habitStorage === 'session' && typeof sessionStorage !== 'undefined') {
      try {
        initialHabits = sessionStorage.getItem(this.habitStorageKey) || sessionStorage.getItem('silent_mi_habit_v2');
      } catch {
        // Storage access blocked
      }
    }

    const habitMemory = new HabitMemory(initialHabits, this.storageNamespace);
    this.engine = new SilentMIEngine(config, habitMemory);

    this.domIndexer = new DomRowIndexer({
      harvestRootSelector: config.harvestRootSelector,
      untrustedSelector: config.untrustedSelector,
    });

    this.highlighter = new VisualHighlighter({
      cspNonce: config.cspNonce,
      untrustedSelector: config.untrustedSelector,
    });

    this.session = new MatchStepSession(this.highlighter, {
      onNavigate: config.onNavigate,
      basePath: config.basePath,
      routingMode: config.routingMode,
      storageNamespace: this.storageNamespace,
      stepRevealTimeoutMs: config.stepRevealTimeoutMs,
      blockedRoutes: config.blockedRoutes,
    });

    this.tieBreaker = new ViewportTieBreaker();
    this.embedder = config.embedder || null;

    if (config.showBar !== false && typeof document !== 'undefined') {
      this.spotlightBar = new SpotlightBar(
        this.session,
        {
          onQueryChange: (q) => void this.query(q),
          onSelectMatch: (m) => void this.handleSelectMatch(m),
          onNext: () => this.handleNext(),
          onPrev: () => this.handlePrev(),
          onClose: () => this.handleClose(),
          onGrantConsent: () => this.grantConsent(),
        },
        {
          cspNonce: config.cspNonce,
          hotkey: config.hotkey,
          i18n: config.i18n,
          embedder: this.embedder,
        }
      );
    }

    this.init();
  }

  private async init(): Promise<void> {
    // 1. Fetch manifests if URLs provided
    await this.loadConfiguredManifests();
    if (this.isDestroyed) return;

    // 2. Harvest live DOM controls
    if (this.config.autoHarvestDom !== false && typeof document !== 'undefined') {
      const domItems = this.domIndexer.harvestDom();
      this.engine.addItems(domItems);

      let prevDomSignature = '';
      this.domIndexer.startObserving(document.body, () => {
        if (this.isDestroyed) return;
        const refreshedDom = this.domIndexer.harvestDom();
        const currentSignature = `${refreshedDom.length}:${refreshedDom.map((i) => `${i.id}:${i.label}:${i.route || ''}:${i.liveStatus || ''}`).join(';')}`;
        if (currentSignature === prevDomSignature) {
          return;
        }
        prevDomSignature = currentSignature;

        // Replace dom items while retaining manifest items
        const manifestOnly = this.engine.getItems().filter((i: ManifestItem) => i.source === 'manifest');
        this.engine.setItems([...manifestOnly, ...refreshedDom]);
        if (this.embedder && (typeof this.embedder.isConsented !== 'function' || this.embedder.isConsented() !== false)) {
          void this.domIndexer.syncDomEmbeddings(refreshedDom, this.embedder);
        }
        if (this.activeQuery) {
          if (this.session.getTotal() === 0) {
            void this.query(this.activeQuery);
          } else {
            const instantResult = this.engine.searchInstant(this.activeQuery, this.userContext);
            const matches = [...instantResult.matches];
            this.applyViewportTieBreaker(matches);
            this.session.updateMatchesPreservingCurrent(matches);
            this.spotlightBar?.updateMatches(this.session.getMatches(), this.session.getIndex());
          }
        }
      });
    }

    // 3. Initialize embedder warmup if consented
    if (this.embedder) {
      if (typeof this.embedder.isConsented !== 'function' || this.embedder.isConsented() !== false) {
        try {
          await this.embedder.warmup();
          if (this.isDestroyed) return;
          await this.domIndexer.syncDomEmbeddings(this.engine.getItems(), this.embedder);
        } catch {
          // Fallback to pure lexical mode
        }
      }
    }
    if (this.isDestroyed) return;

    // 4. Setup popstate / hashchange listeners for route transitions
    if (typeof window !== 'undefined') {
      this.routeListener = () => {
        if (this.config.autoHarvestDom !== false) {
          const domItems = this.domIndexer.harvestDom();
          const manifestOnly = this.engine.getItems().filter((i: ManifestItem) => i.source === 'manifest');
          this.engine.setItems([...manifestOnly, ...domItems]);
        }
        this.restoreHandoffIfPresent();
      };
      window.addEventListener('popstate', this.routeListener);
      window.addEventListener('hashchange', this.routeListener);
    }

    // 5. Restore cross-page handoff if present
    this.restoreHandoffIfPresent();
  }

  private restoreHandoffIfPresent(): void {
    const handoff = CrossPageHandoffManager.restoreHandoff(
      this.engine,
      this.userContext,
      this.storageNamespace
    );
    if (handoff && handoff.query) {
      this.spotlightBar?.setInputValue(handoff.query);
      void this.query(handoff.query).then(() => {
        if (handoff.match) {
          void this.handleSelectMatch(handoff.match);
        }
      });
    }
  }

  async setUserContext(user: UserContext): Promise<void> {
    const normalizedRoles = user.roles || (user.role ? [user.role] : []);
    this.userContext = { ...user, roles: normalizedRoles };
    // Role change purges active highlights, callouts, and stepper sessions immediately
    this.session.clear();
    this.highlighter.clearVisualHighlight();
    await this.loadConfiguredManifests();
    if (this.activeQuery) {
      void this.query(this.activeQuery);
    }
  }

  setAppState(state: Record<string, string | number | boolean | null>): void {
    this.appState = { ...this.appState, ...state };
    if (this.userContext) {
      this.userContext = { ...this.userContext, appState: this.appState };
    }
    if (this.activeQuery) {
      if (this.session.getTotal() === 0) {
        void this.query(this.activeQuery);
      } else {
        const instantResult = this.engine.searchInstant(this.activeQuery, this.userContext);
        const matches = [...instantResult.matches];
        this.applyViewportTieBreaker(matches);
        this.session.updateMatchesPreservingCurrent(matches);
        this.spotlightBar?.updateMatches(this.session.getMatches(), this.session.getIndex());
      }
    }
  }

  getAppState(): Record<string, string | number | boolean | null> {
    return { ...this.appState };
  }

  registerHarness(harness: HarnessConfig): void {
    this.engine.registerHarness(harness);
  }

  registerItems(items: ManifestItem[]): void {
    this.engine.registerItems(items);
  }

  async grantConsent(): Promise<void> {
    if (this.embedder && typeof this.embedder.grantConsent === 'function') {
      await this.embedder.grantConsent();
    }
    this.spotlightBar?.setEmbedder(this.embedder);
    if (this.embedder) {
      try {
        await this.embedder.warmup();
        await this.domIndexer.syncDomEmbeddings(this.engine.getItems(), this.embedder);
      } catch {
        // Ignore warmup failure
      }
    }
    if (this.activeQuery) {
      void this.query(this.activeQuery);
    }
  }

  async revokeConsent(): Promise<void> {
    if (this.embedder && typeof this.embedder.revokeConsent === 'function') {
      await this.embedder.revokeConsent();
    }
    this.spotlightBar?.setEmbedder(this.embedder);
  }

  isConsented(): boolean {
    if (this.embedder && typeof this.embedder.isConsented === 'function') {
      return this.embedder.isConsented();
    }
    return true;
  }

  async query(text: string, user?: UserContext): Promise<SearchResponse> {
    const domSnapshot = this.captureDomSnapshot();
    const effectiveUser: UserContext = {
      ...this.userContext,
      ...user,
      appState: { ...this.appState, ...user?.appState },
      domContext: { ...this.userContext?.domContext, ...domSnapshot, ...user?.domContext },
    };
    this.activeQuery = text.trim();

    if (!this.activeQuery) {
      this.session.clear();
      this.spotlightBar?.updateMatches([], 0);
      return {
        query: text,
        affirmativeQuery: '',
        negatedTerms: [],
        matches: [],
        rejectedAsOOD: true,
        topRawConfidence: 0,
        latencyMs: 0,
        usedSemanticVectors: false,
        decision: 'noul',
        confidence: 0,
        margin: 0,
        zScore: 0,
      };
    }

    // Stage 1: Synchronous Keystroke-1 Lexical Instant Search (< 0.5 ms)
    const instantResult = this.engine.searchInstant(this.activeQuery, effectiveUser);
    let currentMatches = [...instantResult.matches];
    this.applyViewportTieBreaker(currentMatches);

    this.session.setSession(this.activeQuery, currentMatches);
    this.spotlightBar?.updateMatches(currentMatches, 0);

    const firstMatch = this.session.getCurrent();
    if (firstMatch) {
      void this.session.guideMatch(firstMatch);
    } else {
      this.highlighter.clearVisualHighlight();
      this.session.cancelPendingDrawerGuidance();
    }

    // Stage 2: Coalesced EmbedderPlugin refinement (if embedder active and consented)
    if (
      this.embedder &&
      this.embedder.isEnabled &&
      (typeof this.embedder.isConsented !== 'function' || this.embedder.isConsented() !== false)
    ) {
      const requestedQuery = this.activeQuery;
      try {
        const qVec = await this.embedder.embedQuery(requestedQuery);
        if (this.isDestroyed || this.activeQuery !== requestedQuery) {
          return instantResult;
        }
        if (qVec) {
          const hybridResult = this.engine.search(requestedQuery, qVec, effectiveUser);
          currentMatches = [...hybridResult.matches];
          this.applyViewportTieBreaker(currentMatches);

          if (this.session.getIndex() > 0) {
            // User already started stepping: preserve their active match/index
            this.session.updateMatchesPreservingCurrent(currentMatches);
            this.spotlightBar?.updateMatches(currentMatches, this.session.getIndex());
          } else {
            // User is at root: update session and only guide if match changed
            const prevCurrent = this.session.getCurrent();
            this.session.setSession(requestedQuery, currentMatches);
            this.spotlightBar?.updateMatches(currentMatches, 0);

            const updatedFirst = this.session.getCurrent();
            if (updatedFirst && (!prevCurrent || prevCurrent.id !== updatedFirst.id)) {
              void this.session.guideMatch(updatedFirst);
            } else if (!updatedFirst) {
              this.highlighter.clearVisualHighlight();
              this.session.cancelPendingDrawerGuidance();
            }
          }

          return {
            ...hybridResult,
            matches: currentMatches,
          };
        }
      } catch {
        // Retain lexical results on embedding failure
      }
    }

    return {
      ...instantResult,
      matches: currentMatches,
    };
  }

  async guide(matchOrId: SearchMatch | string): Promise<GuideResult> {
    let targetMatch: SearchMatch | null = null;
    if (typeof matchOrId === 'string') {
      const currentMatches = this.session.getMatches();
      targetMatch = currentMatches.find((m) => m.id === matchOrId) || null;
      if (!targetMatch) {
        const item = this.engine.getItems().find((i: ManifestItem) => i.id === matchOrId);
        if (item) {
          targetMatch = {
            ...item,
            score: 1.0,
            lexicalScore: 1.0,
            semanticScore: 0,
            negationPenalty: 0,
            upsellLocked: false,
          };
        }
      }
    } else {
      targetMatch = matchOrId;
    }

    if (!targetMatch) {
      return { mode: 'missing', stepIndex: 0, totalSteps: 1, element: null };
    }

    this.recordHabitConfirmation(this.activeQuery || targetMatch.label, targetMatch.id);
    return this.session.guideMatch(targetMatch);
  }

  private applyViewportTieBreaker(matches: SearchMatch[]): void {
    const topScore = matches[0]?.score || 0;
    for (const m of matches) {
      const boost = this.tieBreaker.getBoost(m, topScore);
      m.score = Math.min(1.0, m.score + boost);
    }
    matches.sort((a, b) => {
      if (Math.abs(b.score - a.score) > 1e-4) {
        return b.score - a.score;
      }
      // Visible element tie-breaker: prefer visible over hidden responsive duplicates
      const elA = a.selector ? resolveBestVisibleElement(document, a.selector, true) : null;
      const elB = b.selector ? resolveBestVisibleElement(document, b.selector, true) : null;
      const visA = elA ? isElementVisible(elA) : false;
      const visB = elB ? isElementVisible(elB) : false;
      if (visA !== visB) return visA ? -1 : 1;
      return 0;
    });
  }

  private captureDomSnapshot(): PlaybookDomSnapshot {
    if (typeof document === 'undefined') return {};
    const visibleSelectors = new Set<string>();
    const disabledSelectors = new Set<string>();
    const checkedSelectors: Record<string, boolean> = {};
    const liveLabels: Record<string, string> = {};

    const elements = document.querySelectorAll<HTMLElement>(
      'button, a, input, select, textarea, [data-mi-label], [data-mi-id], [role="switch"]'
    );

    for (let i = 0; i < elements.length; i++) {
      const el = elements[i]!;
      const sel = el.id
        ? `#${el.id}`
        : el.getAttribute('data-mi-id')
          ? `[data-mi-id="${el.getAttribute('data-mi-id')}"]`
          : null;
      if (!sel) continue;

      if (isElementVisible(el)) {
        visibleSelectors.add(sel);
      }
      if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') {
        disabledSelectors.add(sel);
      }
      const isChecked =
        el.getAttribute('aria-checked') === 'true' ||
        (el as HTMLInputElement).checked === true ||
        el.getAttribute('data-mi-state') === 'enabled';
      checkedSelectors[sel] = isChecked;

      const text =
        el.getAttribute('data-mi-label') ||
        el.textContent?.trim() ||
        (el as HTMLInputElement).value ||
        el.getAttribute('aria-label') ||
        '';
      if (text) {
        liveLabels[sel] = text;
      }
    }

    return { visibleSelectors, disabledSelectors, checkedSelectors, liveLabels };
  }

  private recordHabitConfirmation(query: string, matchId: string): void {
    this.engine.getHabitMemory().recordConfirmation(query, matchId);
    if (this.habitStorage === 'local' && typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(this.habitStorageKey, this.engine.getHabitMemory().toJSON());
      } catch {
        // Ignore storage errors
      }
    } else if (this.habitStorage === 'session' && typeof sessionStorage !== 'undefined') {
      try {
        sessionStorage.setItem(this.habitStorageKey, this.engine.getHabitMemory().toJSON());
      } catch {
        // Ignore storage errors
      }
    }
  }

  private async handleSelectMatch(match: SearchMatch): Promise<void> {
    this.recordHabitConfirmation(this.activeQuery, match.id);

    // Cross-page route navigation if onNavigate is not configured and target route differs from current route
    if (match.route && !this.session.onNavigate && typeof window !== 'undefined' && window.location) {
      const currentLoc = this.session.routingMode === 'hash' ? window.location.hash : window.location.pathname;
      const currentNorm = normalizeRoute(currentLoc, {
        basePath: this.session.basePath,
        routingMode: this.session.routingMode,
      });
      const targetNorm = normalizeRoute(match.route, {
        basePath: this.session.basePath,
        routingMode: this.session.routingMode,
      });

      if (currentNorm !== targetNorm) {
        const safeUrl = resolveSafeSameOriginUrl(match.route, undefined, this.session.blockedRoutes);
        if (safeUrl) {
          CrossPageHandoffManager.saveHandoff(this.activeQuery, match, this.storageNamespace);
          window.location.href = safeUrl;
          return;
        }
      }
    }

    await this.session.guideMatch(match);
    this.spotlightBar?.updateMatches(this.session.getMatches(), this.session.getIndex());
  }

  private handleNext(): void {
    const nextMatch = this.session.next();
    if (nextMatch) {
      void this.session.guideMatch(nextMatch);
      this.spotlightBar?.updateMatches(this.session.getMatches(), this.session.getIndex());
    }
  }

  private handlePrev(): void {
    const prevMatch = this.session.prev();
    if (prevMatch) {
      void this.session.guideMatch(prevMatch);
      this.spotlightBar?.updateMatches(this.session.getMatches(), this.session.getIndex());
    }
  }

  private handleClose(): void {
    this.session.clear();
    this.spotlightBar?.hide();
  }

  private async loadConfiguredManifests(): Promise<void> {
    const urls: string[] = [];
    if (this.config.manifestUrls?.public) urls.push(this.config.manifestUrls.public);
    if (this.config.manifestUrls?.docs) urls.push(this.config.manifestUrls.docs);

    const roles = this.userContext?.roles || (this.userContext?.role ? [this.userContext.role] : []);
    if (this.config.manifestUrls?.byRole && roles.length > 0) {
      for (const r of roles) {
        const u = this.config.manifestUrls.byRole[r];
        if (u && !urls.includes(u)) urls.push(u);
      }
    }

    for (const url of urls) {
      try {
        const res = await fetch(url);
        if (res.ok) {
          const data: unknown = await res.json();
          if (data && typeof data === 'object') {
            const manifest = data as Partial<RoleManifest>;
            if (Array.isArray(manifest.items)) {
              this.engine.addItems(manifest.items);
            }
            if (Array.isArray(manifest.playbooks)) {
              for (const pb of manifest.playbooks) {
                this.engine.registerPlaybook(pb);
              }
            }
          }
        }
      } catch {
        // Ignore fetch errors in offline sandbox
      }
    }
  }

  destroy(): void {
    this.isDestroyed = true;
    if (this.routeListener && typeof window !== 'undefined') {
      window.removeEventListener('popstate', this.routeListener);
      window.removeEventListener('hashchange', this.routeListener);
      this.routeListener = undefined;
    }
    this.domIndexer.stopObserving();
    this.session.destroy();
    this.spotlightBar?.destroy();
    this.embedder?.dispose();
  }
}

/**
 * Public SDK factory functions.
 */
export type PicolocusConfig = SilentMIConfig;
export type PicolocusClient = SilentMIClient;
export const PicolocusController = SilentMIController;
export type PicolocusController = SilentMIController;

export async function initPicolocus(config: PicolocusConfig = {}): Promise<PicolocusClient> {
  const client = new PicolocusController(config);
  if (typeof window !== 'undefined') {
    (window as any).__picolocus = client;
    (window as any).__silent_mi = client;
  }
  return client;
}

export async function createPicolocus(config: PicolocusConfig = {}): Promise<PicolocusClient> {
  return initPicolocus(config);
}

// Backward-compatible aliases
export const initSilentMI = initPicolocus;
export const createSilentMI = createPicolocus;

// Automatic initialization for script tags carrying data-pico-auto or data-silent-mi-auto
if (
  typeof document !== 'undefined' &&
  document.currentScript &&
  (document.currentScript.hasAttribute('data-pico-auto') ||
    document.currentScript.hasAttribute('data-silent-mi-auto'))
) {
  void initPicolocus();
}
