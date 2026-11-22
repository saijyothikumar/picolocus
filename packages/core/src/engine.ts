/**
 * @picolocus/core - Micro-Intelligence Search Engine (v1.0.4)
 * Features:
 * - Load-time pre-indexing with clause-scoped polarity
 * - Declarative JSON harness compilation & domain glossary expansion
 * - Dynamic playbook rule evaluation (<0.02 ms) with live state matching
 * - Directional antonym & reversible toggle polarity gating
 * - RBAC/Tier authorization caching and slicing
 * - Branch-and-bound lexical scoring (<0.5 ms)
 * - 0-index adjacent Damerau transposition & Pigeonhole-guarded 1-edit Levenshtein
 * - Population Z-score computation across all authorized items with small-N safety
 * - Calibrated Jev-style System-One decision gate (choice | disambiguate | noul)
 */

import {
  CalibrationProfile,
  DecisionHeadPlugin,
  EngineOptions,
  HarnessConfig,
  ManifestItem,
  PlaybookRule,
  RoleManifest,
  SearchExplainTrace,
  SearchMatch,
  SearchResponse,
  StateConflictKind,
  UserContext,
} from './types.js';
import { computeInt8Cosine } from './embedder.js';
import { HabitMemory } from './habit-memory.js';
import {
  analyzeActionPolarity,
  extractExactTokens,
  normalizeRoute,
  parseQueryIntent,
  stemToken,
  tokenizeWords,
  NEGATION_CUES,
  CUE_PATTERN,
} from './negation.js';
import {
  evaluatePlaybookBranches,
  expandGlossaryTokens,
  playbookToManifestItem,
} from './playbook.js';

export const DEFAULT_CALIBRATION: CalibrationProfile = {
  minConfidence: 0.29,
  oodSemanticFloor: 0.44,
  minLexicalWithoutSemantic: 0.25,
  marginThreshold: 0.045,
  zScoreThreshold: 1.35,
  disambiguationTieDelta: 0.04,
  routeBoost: 0.035,
  visibleBoost: 0.03,
};

export interface PreIndexedItem {
  raw: ManifestItem;
  id: string;
  targetType: ManifestItem['targetType'];
  kind?: ManifestItem['kind'];
  label: string;
  labelLower: string;
  compactLabel: string;
  tokenSet: Set<string>;
  stemSet: Set<string>;
  labelTokenSet: Set<string>;
  exactTokens: Set<string>;
  vector: Int8Array | null;
  affirmativeTokens: Set<string>;
  unnegatedBodyTokens: Set<string>;
  hasSelfNegatedTerms: boolean;
  roles?: string[];
  requiredTier?: string;
  tierPolicy?: ManifestItem['tierPolicy'];
  triggerChain?: string[];
  whenUserAsks?: string[];
  playbookRule?: PlaybookRule;
}

/**
 * Formats a manifest item or playbook into a single passage for indexing/embedding.
 */
export function formatManifestPassage(
  item: ManifestItem,
  glossary?: Record<string, readonly string[]>
): string {
  const parts: string[] = [item.label];

  if (item.whenUserAsks && item.whenUserAsks.length > 0) {
    parts.push(...item.whenUserAsks);
  }

  if (item.synonyms && item.synonyms.length > 0) {
    parts.push(...item.synonyms);
  }

  if (glossary) {
    const rawTokens = tokenizeWords(parts.join(' '));
    const expanded = expandGlossaryTokens(rawTokens, glossary, 24);
    if (expanded.length > rawTokens.length) {
      parts.push(expanded.slice(rawTokens.length).join(' '));
    }
  }

  if (item.description) parts.push(item.description);
  if (item.verbatimText) parts.push(item.verbatimText);
  if (item.calloutTitle) parts.push(item.calloutTitle);
  if (item.calloutText) parts.push(item.calloutText);

  return parts.filter(Boolean).join(' ');
}

export class SilentMIEngine {
  private items: PreIndexedItem[] = [];
  private playbooks: PlaybookRule[] = [];
  private glossary: Record<string, readonly string[]> = Object.create(null);
  private authCache = new Map<string, PreIndexedItem[]>();
  private habitMemory: HabitMemory;
  private options: Required<Omit<EngineOptions, 'calibration' | 'lexicon'>> & {
    calibration: CalibrationProfile;
    lexicon: EngineOptions['lexicon'];
  };
  private decisionHead?: DecisionHeadPlugin;

  constructor(options?: EngineOptions, habitMemory?: HabitMemory) {
    const minConf =
      options?.minConfidence ?? options?.calibration?.minConfidence ?? DEFAULT_CALIBRATION.minConfidence;
    const oodFloor =
      options?.oodSemanticFloor ?? options?.calibration?.oodSemanticFloor ?? DEFAULT_CALIBRATION.oodSemanticFloor;
    const minLexNoSem =
      options?.minLexicalWithoutSemantic ??
      options?.calibration?.minLexicalWithoutSemantic ??
      DEFAULT_CALIBRATION.minLexicalWithoutSemantic;

    this.options = {
      minConfidence: minConf,
      oodSemanticFloor: oodFloor,
      minLexicalWithoutSemantic: minLexNoSem,
      maxResults: options?.maxResults ?? 6,
      habitBoostWeight: options?.habitBoostWeight ?? 0.08,
      tierOrder: options?.tierOrder ?? [],
      calibration: {
        ...DEFAULT_CALIBRATION,
        ...options?.calibration,
        minConfidence: minConf,
        oodSemanticFloor: oodFloor,
        minLexicalWithoutSemantic: minLexNoSem,
      },
      lexicon: options?.lexicon,
      canAccessTier: options?.canAccessTier ?? ((u, r) => this.defaultCanAccessTier(u, r)),
      canAccessRoles: options?.canAccessRoles ?? ((u, r) => this.defaultCanAccessRoles(u, r)),
    };
    this.habitMemory = habitMemory ?? new HabitMemory();
  }

  setDecisionHead(head: DecisionHeadPlugin | undefined): void {
    this.decisionHead = head;
  }

  registerHarness(harness: HarnessConfig): void {
    if (harness.domainGlossary) {
      this.glossary = { ...this.glossary, ...harness.domainGlossary };
    }
    if (harness.items && harness.items.length > 0) {
      this.registerItems(harness.items);
    }
    if (harness.playbooks && harness.playbooks.length > 0) {
      for (const rule of harness.playbooks) {
        this.registerPlaybook(rule);
      }
    }
  }

  registerPlaybook(rule: PlaybookRule): void {
    this.playbooks.push(rule);
    const syntheticItem = playbookToManifestItem(rule);
    const preIndexed = this.preIndexItem(syntheticItem);
    preIndexed.playbookRule = rule;
    this.items.push(preIndexed);
    this.authCache.clear();
  }

  registerItems(items: ManifestItem[]): void {
    this.addItems(items);
  }

  registerGlossary(glossary: Record<string, readonly string[]>): void {
    this.glossary = { ...this.glossary, ...glossary };
  }

  loadManifests(manifests: RoleManifest[]): void {
    for (const m of manifests) {
      if (m.domainGlossary) {
        this.glossary = { ...this.glossary, ...m.domainGlossary };
      }
      if (m.items && m.items.length > 0) {
        this.addItems(m.items);
      }
      if (m.playbooks && m.playbooks.length > 0) {
        for (const pb of m.playbooks) {
          this.registerPlaybook(pb);
        }
      }
    }
  }

  setItems(items: ManifestItem[]): void {
    const existingIds = new Set<string>();
    const deduplicated: ManifestItem[] = [];
    for (const item of items) {
      if (!existingIds.has(item.id)) {
        deduplicated.push(item);
        existingIds.add(item.id);
      }
    }
    this.items = deduplicated.map((item) => this.preIndexItem(item));
    this.authCache.clear();
  }

  addItems(items: ManifestItem[]): void {
    const existingIds = new Set(this.items.map((i) => i.id));
    for (const item of items) {
      if (!existingIds.has(item.id)) {
        this.items.push(this.preIndexItem(item));
        existingIds.add(item.id);
      }
    }
    this.authCache.clear();
  }

  getItems(): ManifestItem[] {
    return this.items.map((i) => ({ ...i.raw }));
  }

  getMergedEntries(): ManifestItem[] {
    return this.items.map((i) => {
      const cloned: ManifestItem = { ...i.raw };
      if (i.roles) cloned.roles = [...i.roles];
      if (i.requiredTier) cloned.requiredTier = i.requiredTier;
      if (i.tierPolicy) cloned.tierPolicy = i.tierPolicy;
      return cloned;
    });
  }

  getHabitMemory(): HabitMemory {
    return this.habitMemory;
  }

  private preIndexItem(item: ManifestItem): PreIndexedItem {
    const safeLabel = item.label || '';
    const labelLower = safeLabel.toLowerCase();
    const compactLabel = labelLower.replace(/[^a-z0-9]/g, '');

    const passage = formatManifestPassage(item, this.glossary);
    const tokens = tokenizeWords(passage);
    const tokenSet = new Set(tokens);
    const stemSet = new Set(tokens.map((t) => stemToken(t)));

    const labelTokens = tokenizeWords(safeLabel);
    const labelTokenSet = new Set(labelTokens);

    const exactTokens = new Set<string>();
    if (item.selector) {
      for (const t of extractExactTokens(item.selector)) exactTokens.add(t);
    }
    for (const t of extractExactTokens(safeLabel)) exactTokens.add(t);
    if (item.description) {
      for (const t of extractExactTokens(item.description)) exactTokens.add(t);
    }
    if (item.id) {
      for (const t of extractExactTokens(item.id)) exactTokens.add(t);
      if (item.id.startsWith('#')) exactTokens.add(item.id.toLowerCase());
    }

    const affirmativeTokens = new Set<string>();
    for (const t of labelTokens) affirmativeTokens.add(t);
    if (item.synonyms) {
      for (const syn of item.synonyms) {
        for (const t of tokenizeWords(syn)) affirmativeTokens.add(t);
      }
    }
    if (item.whenUserAsks) {
      for (const ask of item.whenUserAsks) {
        for (const t of tokenizeWords(ask)) affirmativeTokens.add(t);
      }
    }

    const { unnegatedBodyTokens, hasSelfNegatedTerms } = this.extractClausePolarity(
      item.description,
      item.verbatimText,
      item.liveStatus,
      item.label
    );

    let vector: Int8Array | null = null;
    if (item.vector && item.vector.length > 0) {
      vector = new Int8Array(item.vector);
    }

    const triggerChain =
      item.triggerChain && item.triggerChain.length > 0
        ? [...item.triggerChain]
        : item.parentTriggerSelector
          ? [item.parentTriggerSelector]
          : undefined;

    return {
      raw: item,
      id: item.id,
      targetType: item.targetType || (item.verbatimText ? 'doc_clause' : 'action'),
      kind: item.kind,
      label: item.label,
      labelLower,
      compactLabel,
      tokenSet,
      stemSet,
      labelTokenSet,
      exactTokens,
      vector,
      affirmativeTokens,
      unnegatedBodyTokens,
      hasSelfNegatedTerms,
      roles: item.roles ? [...item.roles] : undefined,
      requiredTier: item.requiredTier,
      tierPolicy: item.tierPolicy,
      triggerChain,
      whenUserAsks: item.whenUserAsks ? [...item.whenUserAsks] : undefined,
      playbookRule: item.playbookRule || this.playbooks.find((p) => p.id === item.id),
    };
  }

  private extractClausePolarity(
    description?: string,
    verbatimText?: string,
    liveStatus?: string,
    label?: string
  ): { unnegatedBodyTokens: Set<string>; hasSelfNegatedTerms: boolean } {
    const unnegatedBodyTokens = new Set<string>();
    let hasSelfNegatedTerms = false;

    // Check if label contains negation cue (e.g. "Do Not Disturb")
    if (label && CUE_PATTERN.test(label)) {
      hasSelfNegatedTerms = true;
    }

    const fullBody = [description, verbatimText, liveStatus].filter(Boolean).join(' ');
    if (!fullBody.trim()) {
      return { unnegatedBodyTokens, hasSelfNegatedTerms };
    }

    const sentences = fullBody.split(/[.!?;]|\bbut\b/i);

    for (const sent of sentences) {
      const trimmed = sent.trim();
      if (!trimmed) continue;

      const cueMatch = CUE_PATTERN.exec(trimmed);
      if (cueMatch && typeof cueMatch.index === 'number') {
        hasSelfNegatedTerms = true;
        const beforeCue = trimmed.slice(0, cueMatch.index);
        for (const t of tokenizeWords(beforeCue)) {
          unnegatedBodyTokens.add(t);
        }
      } else {
        const strippedNo = trimmed.replace(/\bno\s+([a-z0-9]+(?:\s+[a-z0-9]+){0,2})\b/gi, ' ');
        for (const t of tokenizeWords(strippedNo)) {
          unnegatedBodyTokens.add(t);
        }
      }
    }

    return { unnegatedBodyTokens, hasSelfNegatedTerms };
  }

  getAuthorizedSlice(user?: UserContext): PreIndexedItem[] {
    const cacheKey = this.getAuthKey(user);
    const cached = this.authCache.get(cacheKey);
    if (cached) return cached;

    const userRoles = this.normalizeRoles(user);
    const userTier = user?.tier;
    const entitlements = new Set(
      (user?.entitlements || [])
        .filter((e): e is string => typeof e === 'string')
        .map((e) => e.toLowerCase())
    );

    const slice = this.items.filter((item) => {
      if (item.roles && item.roles.length > 0) {
        const canAccess = this.options.canAccessRoles(userRoles, item.roles);
        if (!canAccess) return false;
      }

      if (item.requiredTier) {
        const reqLower = item.requiredTier.toLowerCase();
        if (entitlements.has(reqLower) || entitlements.has(`tier:${reqLower}`)) {
          return true;
        }

        const tierAllowed = this.options.canAccessTier(userTier, item.requiredTier);
        if (!tierAllowed) {
          return item.tierPolicy === 'spotlight_upsell' || item.tierPolicy === 'upsell';
        }
      }

      return true;
    });

    if (this.authCache.size >= 32) {
      const firstKey = this.authCache.keys().next().value;
      if (firstKey) this.authCache.delete(firstKey);
    }
    this.authCache.set(cacheKey, slice);
    return slice;
  }

  private normalizeRoles(user?: UserContext): string[] {
    const set = new Set<string>();
    if (user?.role && user.role.trim()) set.add(user.role.trim().toLowerCase());
    if (user?.roles) {
      for (const r of user.roles) {
        if (r && r.trim()) set.add(r.trim().toLowerCase());
      }
    }
    if (set.size === 0) set.add('public');
    return Array.from(set);
  }

  private getAuthKey(user?: UserContext): string {
    const roles = this.normalizeRoles(user).sort().join(',');
    const tier = (user?.tier || '').toLowerCase().trim();
    const ents = (user?.entitlements || []).slice().sort().join(',');
    const salt = user?.tenantSalt || '';
    return `${salt}::${roles}::${tier}::${ents}`;
  }

  private defaultCanAccessRoles(userRoles: string[], itemRoles: string[]): boolean {
    const uSet = new Set(userRoles.map((r) => r.toLowerCase()));
    for (const ir of itemRoles) {
      if (uSet.has(ir.toLowerCase())) return true;
    }
    return false;
  }

  private defaultCanAccessTier(userTier: string | undefined, requiredTier: string): boolean {
    if (!userTier) return false;
    const u = userTier.toLowerCase().trim();
    const r = requiredTier.toLowerCase().trim();

    if (this.options.tierOrder.length > 0) {
      const order = this.options.tierOrder.map((t) => t.toLowerCase().trim());
      const uIdx = order.indexOf(u);
      const rIdx = order.indexOf(r);
      if (uIdx >= 0 && rIdx >= 0) {
        return uIdx >= rIdx;
      }
    }
    return u === r;
  }

  filterAuthorizedMatches(matches: SearchMatch[], user?: UserContext): SearchMatch[] {
    const authorizedIds = new Set(this.getAuthorizedSlice(user).map((i) => i.id));
    return matches.filter((m) => authorizedIds.has(m.id));
  }

  searchInstant(query: string, user?: UserContext, options?: EngineOptions): SearchResponse {
    return this.search(query, null, user, options);
  }

  search(
    query: string,
    queryVector: Int8Array | null,
    user?: UserContext,
    opts?: EngineOptions
  ): SearchResponse {
    const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const safeQuery = typeof query === 'string' ? query : '';
    const cal = { ...this.options.calibration, ...opts?.calibration };
    const minConf =
      opts?.minConfidence ?? opts?.calibration?.minConfidence ?? cal.minConfidence ?? this.options.minConfidence;
    const oodFloor =
      opts?.oodSemanticFloor ?? opts?.calibration?.oodSemanticFloor ?? cal.oodSemanticFloor ?? this.options.oodSemanticFloor;
    const minLexNoSem =
      opts?.minLexicalWithoutSemantic ??
      opts?.calibration?.minLexicalWithoutSemantic ??
      cal.minLexicalWithoutSemantic ??
      this.options.minLexicalWithoutSemantic;
    const maxRes = opts?.maxResults ?? this.options.maxResults;
    const habitWeight = opts?.habitBoostWeight ?? this.options.habitBoostWeight;

    const intent = parseQueryIntent(safeQuery);
    const slice = this.getAuthorizedSlice(user);

    if (intent.affirmativeTokens.length === 0 && !intent.hasNegation) {
      return {
        query,
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

    const expandedTokens = expandGlossaryTokens(intent.affirmativeTokens, this.glossary, 20);
    const qTokens = expandedTokens.slice(0, 14);
    const qCount = qTokens.length;
    const minCoverage = qCount <= 2 ? qCount : Math.ceil(0.6 * qCount);

    const compactQuery = intent.affirmativeText.toLowerCase().replace(/[^a-z0-9]/g, '');
    const qLower = intent.affirmativeText.toLowerCase().trim();
    const queryHash = this.habitMemory.hashQuery(intent.affirmativeText);

    // Pre-calculate raw pre-threshold scores for population statistics across all authorized items
    const rawScores: number[] = new Array(slice.length);
    const candidatePool: Array<{
      item: PreIndexedItem;
      score: number;
      lexicalScore: number;
      semanticScore: number;
      negationPenalty: number;
      polarityPenalty: number;
      stateConflict?: StateConflictKind;
      matchedBranchIndex?: number;
      materializedTarget?: ManifestItem;
      matchedExactId: boolean;
    }> = [];

    let topRaw = 0;

    for (let idx = 0; idx < slice.length; idx++) {
      const item = slice[idx]!;

      // 1. Lexical Scoring with Branch-and-Bound
      let posLex = 0;
      let matchedTokens = 0;

      if (compactQuery && item.compactLabel === compactQuery) {
        posLex = 1.0;
        matchedTokens = qCount;
      } else if (qLower && item.labelLower.startsWith(qLower)) {
        posLex = Math.max(posLex, 0.93);
      } else if (qLower && item.labelLower.includes(qLower)) {
        posLex = Math.max(posLex, 0.84);
      } else if (compactQuery && item.compactLabel.includes(compactQuery)) {
        posLex = Math.max(posLex, 0.80);
      }

      let tokenScoreAccum = 0;
      for (let i = 0; i < qCount; i++) {
        const token = qTokens[i]!;
        const remaining = qCount - i;

        if (matchedTokens + remaining < minCoverage && posLex < 0.80) {
          break;
        }

        const tScore = this.scoreSingleToken(token, item);
        if (tScore > 0) {
          matchedTokens++;
          tokenScoreAccum += tScore;
        }
      }

      if (matchedTokens >= minCoverage && qCount > 0) {
        const avgTokenScore = tokenScoreAccum / qCount;
        posLex = Math.max(posLex, avgTokenScore);
      }

      let matchedExactId = false;
      for (const eid of intent.affirmativeExactTokens) {
        if (item.exactTokens.has(eid) && !intent.negatedExactTokens.includes(eid)) {
          posLex = Math.max(posLex + 0.45, 0.85);
          matchedExactId = true;
          break;
        }
      }

      let selfLex = 0;
      if (item.hasSelfNegatedTerms && (intent.isPureNegation || intent.hasNegation)) {
        let negMatched = 0;
        for (const nt of intent.negatedTerms) {
          if (item.tokenSet.has(nt)) negMatched++;
        }
        if (intent.negatedTerms.length > 0 && negMatched > 0) {
          selfLex = negMatched / intent.negatedTerms.length;
        }
      }

      // 2. Semantic Scoring (Int8 Cosine)
      let sem = 0;
      let usedVectors = false;
      if (queryVector && item.vector) {
        sem = computeInt8Cosine(queryVector, item.vector);
        usedVectors = true;
      }

      // 3. Negation Penalties
      let negPenalty = 0;
      for (const net of intent.negatedExactTokens) {
        if (item.exactTokens.has(net)) {
          negPenalty += 0.85;
          break;
        }
      }

      if (!item.hasSelfNegatedTerms) {
        for (const nt of intent.negatedTerms) {
          if (item.affirmativeTokens.has(nt)) {
            negPenalty += 0.85;
            break;
          }
        }
      }

      for (const nt of intent.negatedTerms) {
        if (item.unnegatedBodyTokens.has(nt)) {
          negPenalty += 0.60;
          break;
        }
      }

      for (const st of intent.secondarySharedTerms) {
        if (item.affirmativeTokens.has(st)) {
          negPenalty += 0.08;
          break;
        }
      }

      // 4. Playbook Rule Branch Evaluation
      let matchedBranchIndex: number | undefined;
      let materializedTarget: ManifestItem | undefined;

      if (item.playbookRule) {
        const evalCtx = { user, appState: user?.appState, domContext: user?.domContext };
        const evaluated = evaluatePlaybookBranches(item.playbookRule, evalCtx);
        if (!evaluated) {
          // Playbook condition not satisfied; drop candidate
          rawScores[idx] = 0;
          continue;
        }
        matchedBranchIndex = evaluated.branchIndex;
        const target = evaluated.target;
        const targetKind =
          target.kind ??
          (target.verbatimSentence
            ? 'highlight_clause'
            : target.triggerChain && target.triggerChain.length > 0
              ? 'breadcrumb'
              : 'spotlight');

        materializedTarget = {
          ...item.raw,
          route: target.route,
          selector: target.selector,
          triggerChain: target.triggerChain,
          kind: targetKind,
          verbatimText: target.verbatimSentence,
          calloutTitle: target.calloutTitle,
          calloutText: target.calloutText,
        };
      }

      // 5. Action Polarity & State Conflict Check
      const domCtx = user?.domContext;
      const effectiveSelector = materializedTarget?.selector ?? item.raw.selector;
      const effectiveRoute = materializedTarget?.route ?? item.raw.route;

      const liveLabel = effectiveSelector && domCtx?.liveLabels ? domCtx.liveLabels[effectiveSelector] : undefined;
      const liveChecked = effectiveSelector && domCtx?.checkedSelectors ? domCtx.checkedSelectors[effectiveSelector] : undefined;
      const polarity = analyzeActionPolarity(
        intent.affirmativeTokens,
        Array.from(item.affirmativeTokens),
        liveLabel,
        liveChecked,
        this.options.lexicon
      );

      let stateConflict = polarity.stateConflict;
      if (!stateConflict && effectiveSelector && domCtx?.disabledSelectors?.has(effectiveSelector)) {
        stateConflict = 'disabled_control';
      }

      // 6. Base Score & Boosts
      let baseScore = 0;
      if (intent.isPureNegation) {
        if (!item.hasSelfNegatedTerms || selfLex < 0.20 || negPenalty > 0 || polarity.polarityPenalty > 0) {
          rawScores[idx] = 0;
          continue;
        }
        baseScore = usedVectors ? Math.max(sem, 0.88 * selfLex) : 0.88 * selfLex;
      } else if (intent.hasNegation) {
        baseScore = usedVectors ? 0.80 * sem + 0.20 * posLex : 0.88 * posLex;
      } else {
        const agreementBonus = posLex >= 0.35 && sem >= 0.35 ? 0.08 : 0.0;
        baseScore = Math.max(posLex, sem) + agreementBonus;
      }

      // Route and Visibility Boosts
      let contextBoost = 0;
      if (effectiveRoute && user?.appState?.currentRoute) {
        const itemRoute = normalizeRoute(effectiveRoute);
        const currentRoute = normalizeRoute(String(user.appState.currentRoute));
        if (itemRoute === currentRoute) {
          contextBoost += cal.routeBoost;
        }
      }
      if (effectiveSelector && domCtx?.visibleSelectors?.has(effectiveSelector)) {
        contextBoost += cal.visibleBoost;
      }

      const habitBoost = this.habitMemory.getBoost(queryHash, item.id, habitWeight);
      const totalScore = baseScore + habitBoost + contextBoost - negPenalty - polarity.polarityPenalty;

      rawScores[idx] = Math.max(0, totalScore);
      if (baseScore > topRaw) topRaw = baseScore;

      // Threshold check
      const effectiveLex = intent.isPureNegation ? selfLex : posLex;
      const passesConfidence = totalScore >= minConf;
      const passesHybridBounds = effectiveLex >= minLexNoSem || sem >= oodFloor;
      if (passesConfidence && (passesHybridBounds || matchedExactId)) {
        candidatePool.push({
          item,
          score: totalScore,
          lexicalScore: effectiveLex,
          semanticScore: sem,
          negationPenalty: negPenalty,
          polarityPenalty: polarity.polarityPenalty,
          stateConflict,
          matchedBranchIndex,
          materializedTarget,
          matchedExactId,
        });
      }
    }

    // 7. Population Statistics across all authorized items (Small-N Safe)
    const N = rawScores.length;
    let popMean = 0;
    let popStdDev = 0;
    if (N > 0) {
      let sum = 0;
      for (let i = 0; i < N; i++) sum += rawScores[i]!;
      popMean = sum / N;

      let sumSqDiff = 0;
      for (let i = 0; i < N; i++) {
        const diff = rawScores[i]! - popMean;
        sumSqDiff += diff * diff;
      }
      popStdDev = Math.sqrt(sumSqDiff / N);
    }

    // Sort candidate pool descending
    candidatePool.sort((a, b) => b.score - a.score);

    // Apply optional DecisionHead plugin if present (respecting negation/polarity penalties)
    if (this.decisionHead && candidatePool.length > 0) {
      const topCandidatesForRerank = candidatePool.slice(0, maxRes).map((c) =>
        this.buildMatch(
          c.item,
          user,
          c.score,
          c.lexicalScore,
          c.semanticScore,
          c.negationPenalty,
          c.stateConflict,
          c.matchedBranchIndex,
          c.materializedTarget
        )
      );
      try {
        const rerankedScores = this.decisionHead.rerank(query, topCandidatesForRerank);
        const resolvedScores = Array.isArray(rerankedScores)
          ? rerankedScores
          : rerankedScores instanceof Promise
            ? null
            : null;
        if (resolvedScores && resolvedScores.length === topCandidatesForRerank.length) {
          candidatePool.length = topCandidatesForRerank.length;
          for (let i = 0; i < resolvedScores.length; i++) {
            const rawRerank = resolvedScores[i]!;
            candidatePool[i]!.score = rawRerank - candidatePool[i]!.negationPenalty - candidatePool[i]!.polarityPenalty;
          }
          candidatePool.sort((a, b) => b.score - a.score);
        }
      } catch {
        // Fallback to hybrid score
      }
    }

    // 8. Calibrated Jev System-One Gate & Ambiguous Ties
    const topCand = candidatePool[0];
    const secondCand = candidatePool[1];

    // Measure margin against actual second highest score across slice if candidatePool has 1 item
    let secondScore = secondCand?.score ?? 0;
    if (candidatePool.length === 1 && rawScores.length > 1) {
      let maxOther = 0;
      for (let i = 0; i < rawScores.length; i++) {
        const s = rawScores[i]!;
        if (Math.abs(s - (topCand?.score ?? 0)) > 1e-5 && s > maxOther) {
          maxOther = s;
        }
      }
      secondScore = maxOther;
    }

    const margin = topCand ? topCand.score - secondScore : 0;
    const topScore = topCand?.score ?? 0;
    const zScore = popStdDev > 1e-6 ? (topScore - popMean) / popStdDev : 0;

    const hasLexicalSupport = Boolean(topCand?.matchedExactId) || (topCand?.lexicalScore ?? 0) >= 0.12;
    const hasAmbiguousTie =
      hasLexicalSupport &&
      candidatePool.length >= 2 &&
      margin <= cal.disambiguationTieDelta &&
      topScore >= minConf;

    // Small-N Outlier Rejection Guard
    const shouldApplyOutlierRejection =
      slice.length >= 5 &&
      !hasAmbiguousTie &&
      ((topCand?.lexicalScore ?? 0) < 0.78 && !topCand?.matchedExactId);

    // If no lexical support, candidate MUST have sufficient confidence, margin, and statistical z-score separation
    const lacksSupport =
      !hasLexicalSupport &&
      (topScore < 0.52 || margin < 0.06 || zScore < cal.zScoreThreshold);

    let decision: 'choice' | 'disambiguate' | 'noul' = 'choice';

    if (
      candidatePool.length === 0 ||
      topScore < minConf ||
      lacksSupport ||
      (shouldApplyOutlierRejection && margin < cal.marginThreshold && zScore < cal.zScoreThreshold)
    ) {
      decision = 'noul';
    } else if (hasAmbiguousTie) {
      decision = 'disambiguate';
    } else {
      decision = 'choice';
    }

    let finalMatches: SearchMatch[] = [];
    if (decision !== 'noul') {
      finalMatches = candidatePool.slice(0, maxRes).map((c, idx) => {
        const match = this.buildMatch(
          c.item,
          user,
          c.score,
          c.lexicalScore,
          c.semanticScore,
          c.negationPenalty,
          c.stateConflict,
          c.matchedBranchIndex,
          c.materializedTarget
        );
        if (hasAmbiguousTie && idx < 3) {
          match.disambiguationIndex = idx + 1;
        }
        return match;
      });
    }

    const endTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const latencyMs = Math.round((endTime - startTime) * 100) / 100;

    const explain: SearchExplainTrace = {
      lexicalScore: topCand?.lexicalScore ?? 0,
      semanticScore: topCand?.semanticScore ?? 0,
      negationPenalty: topCand?.negationPenalty ?? 0,
      polarityPenalty: topCand?.polarityPenalty ?? 0,
      rawScore: topRaw,
      zScore: Math.round(zScore * 100) / 100,
      margin: Math.round(margin * 1000) / 1000,
      decision,
      matchedTokens: intent.affirmativeTokens,
      negatedTokens: intent.negatedTerms,
      matchedBranchIndex: topCand?.matchedBranchIndex,
      stateConflict: topCand?.stateConflict,
    };

    return {
      query,
      affirmativeQuery: intent.affirmativeText,
      negatedTerms: intent.negatedTerms,
      matches: finalMatches,
      rejectedAsOOD: decision === 'noul',
      topRawConfidence: Math.round(topRaw * 100) / 100,
      latencyMs,
      usedSemanticVectors: queryVector !== null,
      decision,
      confidence: Math.min(1.0, Math.max(0, Math.round(topScore * 100) / 100)),
      margin: Math.round(margin * 1000) / 1000,
      zScore: Math.round(zScore * 100) / 100,
      explain,
    };
  }

  private scoreSingleToken(token: string, item: PreIndexedItem): number {
    if (item.tokenSet.has(token)) {
      return item.labelTokenSet.has(token) ? 0.90 : 0.70;
    }

    const stem = stemToken(token);
    if (item.stemSet.has(stem)) {
      return 0.65;
    }

    // 0-index adjacent Damerau transposition (e.g. f2a <-> 2fa)
    if (token.length >= 3) {
      for (let i = 0; i < token.length - 1; i++) {
        const transposed =
          token.slice(0, i) +
          token[i + 1] +
          token[i] +
          token.slice(i + 2);
        if (item.tokenSet.has(transposed)) {
          return 0.55;
        }
      }
    }

    // Pigeonhole 1-edit Levenshtein for token length >= 4
    if (token.length >= 4) {
      for (const itemToken of item.tokenSet) {
        if (Math.abs(itemToken.length - token.length) <= 1) {
          if (
            itemToken[0] === token[0] ||
            itemToken[itemToken.length - 1] === token[token.length - 1]
          ) {
            if (this.isOneEditDistance(token, itemToken)) {
              return 0.40;
            }
          }
        }
      }
    }

    return 0.0;
  }

  private isOneEditDistance(a: string, b: string): boolean {
    const m = a.length;
    const n = b.length;
    if (Math.abs(m - n) > 1) return false;

    let i = 0;
    let j = 0;
    let edits = 0;

    while (i < m && j < n) {
      if (a[i] === b[j]) {
        i++;
        j++;
      } else {
        edits++;
        if (edits > 1) return false;
        if (m > n) {
          i++;
        } else if (n > m) {
          j++;
        } else {
          i++;
          j++;
        }
      }
    }
    if (i < m || j < n) edits++;
    return edits === 1;
  }

  private buildMatch(
    item: PreIndexedItem,
    user: UserContext | undefined,
    score: number,
    lexicalScore: number,
    semanticScore: number,
    negationPenalty: number,
    stateConflict?: StateConflictKind,
    matchedBranchIndex?: number,
    materializedTarget?: ManifestItem
  ): SearchMatch {
    const baseRaw = materializedTarget ?? item.raw;
    let tierLocked = false;
    let upsellTier: string | undefined;

    if (item.requiredTier) {
      const entitlements = new Set(
        (user?.entitlements || [])
          .filter((e): e is string => typeof e === 'string')
          .map((e) => e.toLowerCase())
      );
      const reqLower = item.requiredTier.toLowerCase();
      const hasEntitlement = entitlements.has(reqLower) || entitlements.has(`tier:${reqLower}`);
      const tierAllowed = hasEntitlement || this.options.canAccessTier(user?.tier, item.requiredTier);
      if (!tierAllowed) {
        tierLocked = true;
        upsellTier = item.requiredTier;
      }
    }

    return {
      ...baseRaw,
      targetType: baseRaw.targetType ?? item.targetType,
      score: Math.min(1.0, Math.max(0, Math.round(score * 1000) / 1000)),
      lexicalScore: Math.round(lexicalScore * 100) / 100,
      semanticScore: Math.round(semanticScore * 100) / 100,
      negationPenalty: Math.round(negationPenalty * 100) / 100,
      upsellLocked: tierLocked,
      tierLocked,
      upsellTier,
      stateConflict,
      matchedBranchIndex,
    };
  }
}
