/**
 * @silent-mi/web
 * Client-Side "Silent UI" Micro-Intelligence Web SDK
 * License: Apache-2.0
 */

import {
  EmbedderPlugin,
  EngineOptions,
  LinearAdapter,
  ManifestItem,
  RoleManifest,
  SearchMatch,
  SilentMIEngine,
  UserContext,
  JargonAdapterPayload,
} from '@silent-mi/core';

import { DomRowIndexer } from './dom-indexer.js';
import { VisualHighlighter } from './highlighter.js';
import {
  CrossPageHandoffManager,
  MatchStepSession,
  ViewportTieBreaker,
} from './actions.js';
import { SpotlightBar } from './spotlight-bar.js';

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
  adapterUrls?: {
    public?: string;
    byRole?: Record<string, string>;
  };
  embedder?: EmbedderPlugin;
  autoHarvestDom?: boolean;
}

export class SilentMIController {
  private engine: SilentMIEngine;
  private domIndexer: DomRowIndexer;
  private highlighter: VisualHighlighter;
  private session: MatchStepSession;
  private tieBreaker: ViewportTieBreaker;
  private spotlightBar: SpotlightBar;
  private embedder: EmbedderPlugin | null = null;
  private adapter: LinearAdapter | null = null;
  private userContext: UserContext | undefined;
  private config: SilentMIConfig;
  private activeQuery = '';

  constructor(config: SilentMIConfig = {}) {
    this.config = config;
    this.userContext = config.user;
    this.engine = new SilentMIEngine(config);
    this.domIndexer = new DomRowIndexer();
    this.highlighter = new VisualHighlighter();
    this.session = new MatchStepSession(this.highlighter);
    this.tieBreaker = new ViewportTieBreaker();
    this.embedder = config.embedder || null;

    this.spotlightBar = new SpotlightBar(this.session, {
      onQueryChange: (q) => this.handleQuery(q),
      onSelectMatch: (m) => this.handleSelectMatch(m),
      onNext: () => this.handleNext(),
      onPrev: () => this.handlePrev(),
      onClose: () => this.handleClose(),
    });

    this.init();
  }

  private async init(): Promise<void> {
    // 1. Fetch manifests if URLs provided
    await this.loadConfiguredManifests();

    // 2. Harvest live DOM controls
    if (this.config.autoHarvestDom !== false && typeof document !== 'undefined') {
      const domItems = this.domIndexer.harvestDom();
      this.engine.addItems(domItems);

      this.domIndexer.startObserving(document.body, () => {
        const refreshedDom = this.domIndexer.harvestDom();
        // Replace dom items while retaining manifest items
        const manifestOnly = this.engine.getItems().filter((i) => i.source === 'manifest');
        this.engine.setItems([...manifestOnly, ...refreshedDom]);
        if (this.activeQuery) {
          this.handleQuery(this.activeQuery);
        }
      });
    }

    // 3. Initialize embedder & adapter
    if (this.embedder) {
      try {
        await this.embedder.warmup();
        await this.loadConfiguredAdapter();
      } catch {
        // Fallback to pure lexical mode
      }
    }

    // 4. Restore cross-page handoff if present
    const handoff = CrossPageHandoffManager.restoreHandoff(this.engine, this.userContext);
    if (handoff && handoff.query) {
      this.spotlightBar.setInputValue(handoff.query);
      this.handleQuery(handoff.query);
      if (handoff.match) {
        this.handleSelectMatch(handoff.match);
      }
    }
  }

  setUserContext(user: UserContext): void {
    this.userContext = user;
    // Role change purges active highlights, callouts, and stepper sessions immediately
    this.session.clear();
    this.highlighter.clearVisualHighlight();
    if (this.activeQuery) {
      this.handleQuery(this.activeQuery);
    }
  }

  async handleQuery(query: string): Promise<void> {
    this.activeQuery = query.trim();
    if (!this.activeQuery) {
      this.session.clear();
      this.spotlightBar.updateMatches([], 0);
      return;
    }

    // Stage 1: Synchronous Keystroke-1 Lexical Instant Search (< 0.5 ms)
    const instantResult = this.engine.searchInstant(this.activeQuery, this.userContext);
    let currentMatches = [...instantResult.matches];

    // Apply viewport tie-breaker boost
    const topScore = currentMatches[0]?.score || 0;
    for (const m of currentMatches) {
      const boost = this.tieBreaker.getBoost(m, topScore);
      m.score = Math.min(1.0, m.score + boost);
    }
    currentMatches.sort((a, b) => b.score - a.score);

    this.session.setSession(this.activeQuery, currentMatches);
    this.spotlightBar.updateMatches(currentMatches, 0);

    const firstMatch = this.session.getCurrent();
    if (firstMatch) {
      this.session.guideMatch(firstMatch);
    }

    // Stage 2: Coalesced EmbedderPlugin refinement (if embedder active and ready)
    if (this.embedder && this.embedder.isReady && this.embedder.isEnabled) {
      try {
        let qVec = await this.embedder.embedQuery(this.activeQuery);
        if (qVec && this.adapter) {
          // Apply low-rank linear residual bottleneck
          qVec = this.adapter.project(qVec).int8;
        }

        if (qVec) {
          const hybridResult = this.engine.search(
            this.activeQuery,
            qVec,
            this.userContext
          );
          currentMatches = [...hybridResult.matches];

          const newTopScore = currentMatches[0]?.score || 0;
          for (const m of currentMatches) {
            const boost = this.tieBreaker.getBoost(m, newTopScore);
            m.score = Math.min(1.0, m.score + boost);
          }
          currentMatches.sort((a, b) => b.score - a.score);

          this.session.setSession(this.activeQuery, currentMatches);
          this.spotlightBar.updateMatches(currentMatches, 0);

          const updatedFirst = this.session.getCurrent();
          if (updatedFirst) {
            this.session.guideMatch(updatedFirst);
          }
        }
      } catch {
        // Gracefully retain lexical results
      }
    }
  }

  handleSelectMatch(match: SearchMatch): void {
    // Record habit confirmation
    this.engine.getHabitMemory().recordConfirmation(this.activeQuery, match.id);

    // Save handoff before cross-page route navigation
    if (match.route && typeof window !== 'undefined') {
      CrossPageHandoffManager.saveHandoff(this.activeQuery, match);
      window.location.href = match.route;
      return;
    }

    this.session.guideMatch(match);
    this.spotlightBar.updateMatches(
      this.engine.getAuthorizedSlice(this.userContext).map((i) => ({
        ...i.raw,
        score: match.id === i.id ? match.score : 0,
        lexicalScore: 0,
        semanticScore: 0,
        negationPenalty: 0,
      })),
      this.session.getIndex()
    );
  }

  handleNext(): void {
    const nextMatch = this.session.next();
    if (nextMatch) {
      this.session.guideMatch(nextMatch);
      this.spotlightBar.updateMatches(
        this.session.getCurrent() ? [this.session.getCurrent()!] : [],
        this.session.getIndex()
      );
    }
  }

  handlePrev(): void {
    const prevMatch = this.session.prev();
    if (prevMatch) {
      this.session.guideMatch(prevMatch);
      this.spotlightBar.updateMatches(
        this.session.getCurrent() ? [this.session.getCurrent()!] : [],
        this.session.getIndex()
      );
    }
  }

  handleClose(): void {
    this.session.clear();
    this.spotlightBar.hide();
  }

  private async loadConfiguredManifests(): Promise<void> {
    const urls: string[] = [];
    if (this.config.manifestUrls?.public) urls.push(this.config.manifestUrls.public);
    if (this.config.manifestUrls?.docs) urls.push(this.config.manifestUrls.docs);

    if (this.config.manifestUrls?.byRole && this.userContext?.roles) {
      for (const r of this.userContext.roles) {
        const u = this.config.manifestUrls.byRole[r];
        if (u) urls.push(u);
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
          }
        }
      } catch {
        // Ignore fetch errors in offline sandbox
      }
    }
  }

  private async loadConfiguredAdapter(): Promise<void> {
    if (!this.embedder || !this.config.adapterUrls) return;
    const url = this.config.adapterUrls.public;
    if (!url) return;

    try {
      const res = await fetch(url);
      if (res.ok) {
        const payload = (await res.json()) as JargonAdapterPayload;
        const candidate = new LinearAdapter(payload);
        // Strict cryptographic pinning check
        if (candidate.matchesBaseModel(this.embedder.id, this.embedder.modelSha256)) {
          this.adapter = candidate;
        }
      }
    } catch {
      // Ignore adapter load failure
    }
  }

  destroy(): void {
    this.domIndexer.stopObserving();
    this.session.clear();
    this.spotlightBar.destroy();
  }
}

/**
 * Public SDK initialization function.
 */
export async function initSilentMI(config: SilentMIConfig = {}): Promise<SilentMIController> {
  return new SilentMIController(config);
}

// Automatic initialization for script tags carrying data-silent-mi-auto
if (
  typeof document !== 'undefined' &&
  document.currentScript &&
  document.currentScript.hasAttribute('data-silent-mi-auto')
) {
  initSilentMI();
}
