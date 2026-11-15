/**
 * @silent-mi/core - Micro-Intelligence Search Engine
 * Features:
 * - Load-time pre-indexing with clause-scoped polarity
 * - RBAC/Tier authorization caching and slicing
 * - Branch-and-bound lexical scoring (< 0.5 ms)
 * - 0-index adjacent Damerau transposition & Pigeonhole-guarded 1-edit Levenshtein
 * - Negation penalties & Pure-negation gate
 * - Int8 Hybrid scoring fusion & OOD rejection gate
 */

import {
  EngineOptions,
  ManifestItem,
  SearchMatch,
  SearchResult,
  UserContext,
} from './types.js';
import { computeInt8Cosine } from './embedder.js';
import { HabitMemory } from './habit-memory.js';
import {
  extractExactTokens,
  parseQueryIntent,
  stemToken,
  tokenizeWords,
  NEGATION_CUES,
} from './negation.js';

export interface PreIndexedItem {
  raw: ManifestItem;
  id: string;
  targetType: ManifestItem['targetType'];
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
}

export class SilentMIEngine {
  private items: PreIndexedItem[] = [];
  private authCache = new Map<string, PreIndexedItem[]>();
  private habitMemory: HabitMemory;
  private options: Required<EngineOptions>;

  constructor(options?: EngineOptions, habitMemory?: HabitMemory) {
    this.options = {
      minConfidence: options?.minConfidence ?? 0.29,
      oodSemanticFloor: options?.oodSemanticFloor ?? 0.44,
      maxResults: options?.maxResults ?? 6,
      habitBoostWeight: options?.habitBoostWeight ?? 0.08,
      tierOrder: options?.tierOrder ?? [],
      canAccessTier: options?.canAccessTier ?? ((u, r) => this.defaultCanAccessTier(u, r)),
      canAccessRoles: options?.canAccessRoles ?? ((u, r) => this.defaultCanAccessRoles(u, r)),
    };
    this.habitMemory = habitMemory ?? new HabitMemory();
  }

  setItems(items: ManifestItem[]): void {
    this.items = items.map((item) => this.preIndexItem(item));
    this.authCache.clear();
  }

  addItems(items: ManifestItem[]): void {
    const indexed = items.map((item) => this.preIndexItem(item));
    this.items.push(...indexed);
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

  /**
   * Pre-indexes an item once at load time.
   * Extracts polarity sets: affirmativeTokens, unnegatedBodyTokens, hasSelfNegatedTerms.
   */
  private preIndexItem(item: ManifestItem): PreIndexedItem {
    const labelLower = item.label.toLowerCase().trim();
    const compactLabel = labelLower.replace(/[^a-z0-9]/g, '');

    const labelTokens = tokenizeWords(item.label);
    const labelTokenSet = new Set(labelTokens);

    const allTokens = new Set<string>(labelTokens);
    const stemSet = new Set<string>();

    for (const t of labelTokens) {
      stemSet.add(stemToken(t));
    }

    if (item.synonyms) {
      for (const syn of item.synonyms) {
        for (const t of tokenizeWords(syn)) {
          allTokens.add(t);
          stemSet.add(stemToken(t));
        }
      }
    }

    if (item.description) {
      for (const t of tokenizeWords(item.description)) {
        allTokens.add(t);
        stemSet.add(stemToken(t));
      }
    }

    if (item.verbatimText) {
      for (const t of tokenizeWords(item.verbatimText)) {
        allTokens.add(t);
        stemSet.add(stemToken(t));
      }
    }

    if (item.liveStatus) {
      for (const t of tokenizeWords(item.liveStatus)) {
        allTokens.add(t);
        stemSet.add(stemToken(t));
      }
    }

    // Exact tokens (#id, $amount, prefixes)
    const exactTokens = new Set<string>();
    const fullText = `${item.label} ${item.description || ''} ${item.verbatimText || ''} ${item.liveStatus || ''} ${item.id}`;
    for (const et of extractExactTokens(fullText)) {
      exactTokens.add(et);
    }
    // Also include item.id itself
    exactTokens.add(item.id.toLowerCase());

    // Vector Int8 view
    let vector: Int8Array | null = null;
    if (item.vector && item.vector.length > 0) {
      vector = new Int8Array(item.vector);
    }

    // Polarity extraction
    const affirmativeTokens = new Set<string>();
    for (const t of labelTokens) affirmativeTokens.add(t);
    if (item.synonyms) {
      for (const syn of item.synonyms) {
        for (const t of tokenizeWords(syn)) affirmativeTokens.add(t);
      }
    }

    const { unnegatedBodyTokens, hasSelfNegatedTerms } = this.extractClausePolarity(
      item.description,
      item.verbatimText,
      item.liveStatus
    );

    return {
      raw: item,
      id: item.id,
      targetType: item.targetType,
      label: item.label,
      labelLower,
      compactLabel,
      tokenSet: allTokens,
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
    };
  }

  /**
   * Evaluates clause-scoped polarity across body texts.
   * Verbal negators protect tokens from the cue onward, setting hasSelfNegatedTerms = true.
   * Strips up to 3 words after space-delimited "no" without breaking "No-Code".
   */
  private extractClausePolarity(
    description?: string,
    verbatimText?: string,
    liveStatus?: string
  ): { unnegatedBodyTokens: Set<string>; hasSelfNegatedTerms: boolean } {
    const unnegatedBodyTokens = new Set<string>();
    let hasSelfNegatedTerms = false;

    const fullBody = [description, verbatimText, liveStatus].filter(Boolean).join(' ');
    if (!fullBody.trim()) {
      return { unnegatedBodyTokens, hasSelfNegatedTerms };
    }

    // Split sentences and major clauses on sentence delimiters (.!?;) or contrastive "but"
    const sentences = fullBody.split(/[.!?;]|\bbut\b/i);

    const cuePattern = new RegExp(
      `\\b(?:${NEGATION_CUES.map((c) => c.replace("'", "['’]")).join('|')})\\b`,
      'i'
    );

    for (const sent of sentences) {
      const trimmed = sent.trim();
      if (!trimmed) continue;

      const cueMatch = cuePattern.exec(trimmed);
      if (cueMatch && typeof cueMatch.index === 'number') {
        hasSelfNegatedTerms = true;
        // Tokens before the cue are unnegated
        const beforeCue = trimmed.slice(0, cueMatch.index);
        for (const t of tokenizeWords(beforeCue)) {
          unnegatedBodyTokens.add(t);
        }
        // Tokens from cue onward (including lists joined by commas/or) are protected from unnegatedBodyTokens
      } else {
        // Strip up to 3 words after standalone space-delimited "no " (protecting hyphenated words like "No-Code")
        const strippedNo = trimmed.replace(/\bno\s+([a-z0-9]+(?:\s+[a-z0-9]+){0,2})\b/gi, ' ');
        for (const t of tokenizeWords(strippedNo)) {
          unnegatedBodyTokens.add(t);
        }
      }
    }

    return { unnegatedBodyTokens, hasSelfNegatedTerms };
  }

  /**
   * Filters and caches authorized item slice based on UserContext.
   */
  getAuthorizedSlice(user?: UserContext): PreIndexedItem[] {
    const cacheKey = this.getAuthKey(user);
    const cached = this.authCache.get(cacheKey);
    if (cached) return cached;

    const userRoles = this.normalizeRoles(user);
    const userTier = user?.tier;
    const entitlements = new Set(
      (user?.entitlements || []).map((e) => e.toLowerCase())
    );

    const slice = this.items.filter((item) => {
      // 1. Role Check
      if (item.roles && item.roles.length > 0) {
        const canAccess = this.options.canAccessRoles(userRoles, item.roles);
        if (!canAccess) return false;
      }

      // 2. Tier Check
      if (item.requiredTier) {
        const reqLower = item.requiredTier.toLowerCase();
        // Check entitlements: tier:<name> or <name>
        if (entitlements.has(reqLower) || entitlements.has(`tier:${reqLower}`)) {
          return true;
        }

        const tierAllowed = this.options.canAccessTier(userTier, item.requiredTier);
        if (!tierAllowed) {
          // If policy is 'upsell', retain with tier locked; otherwise filter out
          return item.tierPolicy === 'upsell';
        }
      }

      return true;
    });

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
    // Fail closed if tierOrder is omitted or tier not in list, unless exact match
    return u === r;
  }

  /**
   * Re-evaluates matches against current user permissions for cross-page restored handoffs.
   */
  filterAuthorizedMatches(matches: SearchMatch[], user?: UserContext): SearchMatch[] {
    const authorizedIds = new Set(this.getAuthorizedSlice(user).map((i) => i.id));
    return matches.filter((m) => authorizedIds.has(m.id));
  }

  /**
   * Synchronous Keystroke-1 Instant Search (< 0.5 ms).
   * Runs pure lexical search with zero fake vectors.
   */
  searchInstant(query: string, user?: UserContext, options?: EngineOptions): SearchResult {
    return this.search(query, null, user, options);
  }

  /**
   * Core Search Method (Lexical or Hybrid).
   */
  search(
    query: string,
    queryVector: Int8Array | null,
    user?: UserContext,
    opts?: EngineOptions
  ): SearchResult {
    const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const minConf = opts?.minConfidence ?? this.options.minConfidence;
    const oodFloor = opts?.oodSemanticFloor ?? this.options.oodSemanticFloor;
    const maxRes = opts?.maxResults ?? this.options.maxResults;
    const habitWeight = opts?.habitBoostWeight ?? this.options.habitBoostWeight;

    const intent = parseQueryIntent(query);
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
      };
    }

    const qTokens = intent.affirmativeTokens.slice(0, 12);
    const qCount = qTokens.length;
    const minCoverage = qCount <= 2 ? qCount : Math.ceil(0.6 * qCount);

    const compactQuery = intent.affirmativeText.toLowerCase().replace(/[^a-z0-9]/g, '');
    const qLower = intent.affirmativeText.toLowerCase().trim();
    const queryHash = this.habitMemory.hashQuery(intent.affirmativeText);

    const candidates: SearchMatch[] = [];
    let topRaw = 0;

    for (const item of slice) {
      // 1. Lexical Scoring with Branch-and-Bound Early Exit
      let posLex = 0;
      let matchedTokens = 0;

      // Direct label hit shortcuts
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

      // Token iteration with early exit
      let tokenScoreAccum = 0;
      for (let i = 0; i < qCount; i++) {
        const token = qTokens[i]!;
        const remaining = qCount - i;

        // Branch-and-bound prune
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

      // Exact literal ID bonus strictly when not negated
      for (const eid of intent.affirmativeExactTokens) {
        if (item.exactTokens.has(eid) && !intent.negatedExactTokens.includes(eid)) {
          posLex = Math.max(posLex + 0.45, 0.85);
          break;
        }
      }

      // Self-negated clause lexical score (for pure-negation matching)
      let selfLex = 0;
      if (item.hasSelfNegatedTerms && intent.isPureNegation) {
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
      let penalty = 0;

      // +0.85 for negated exact tokens
      for (const net of intent.negatedExactTokens) {
        if (item.exactTokens.has(net)) {
          penalty += 0.85;
          break;
        }
      }

      // Primary negated terms hitting affirmative tokens (+0.85)
      // For self-negated policy items under pure-negation queries, affirmative label tokens do not incur penalty
      if (!item.hasSelfNegatedTerms || !intent.isPureNegation) {
        for (const nt of intent.negatedTerms) {
          if (item.affirmativeTokens.has(nt)) {
            penalty += 0.85;
            break;
          }
        }
      }

      // Primary negated terms hitting unnegated body tokens (+0.60)
      for (const nt of intent.negatedTerms) {
        if (item.unnegatedBodyTokens.has(nt)) {
          penalty += 0.60;
          break;
        }
      }

      // Secondary shared nouns in affirmative tokens (+0.08)
      for (const st of intent.secondarySharedTerms) {
        if (item.affirmativeTokens.has(st)) {
          penalty += 0.08;
          break;
        }
      }

      // 4. Pure-Negation Intent Gate
      // Forbid all non-self-negated controls from matching even if semantic similarity is 1.00!
      if (intent.isPureNegation) {
        if (!item.hasSelfNegatedTerms || penalty > 0) {
          continue; // Block completely
        }
        // Only self-negated entries with zero penalty qualify
        const baseScore = usedVectors ? Math.max(sem, 0.88 * selfLex) : 0.88 * selfLex;
        const habitBoost = this.habitMemory.getBoost(queryHash, item.id, habitWeight);
        const finalScore = baseScore + habitBoost;

        if (finalScore >= minConf) {
          candidates.push(
            this.buildMatch(item, user, finalScore, selfLex, sem, penalty)
          );
        }
        continue;
      }

      // 5. Hybrid Fusion
      let baseScore = 0;
      if (intent.hasNegation) {
        // Negated hybrid fusion
        baseScore = usedVectors ? 0.80 * sem + 0.20 * posLex : 0.88 * posLex;
      } else {
        // Non-negated hybrid fusion: max(posLex, sem) + 0.08 bonus when both >= 0.35
        const agreementBonus = posLex >= 0.35 && sem >= 0.35 ? 0.08 : 0.0;
        baseScore = Math.max(posLex, sem) + agreementBonus;
      }

      const habitBoost = this.habitMemory.getBoost(queryHash, item.id, habitWeight);
      const finalScore = baseScore + habitBoost - penalty;

      if (baseScore > topRaw) topRaw = baseScore;

      // 6. OOD Gate
      // Reject any candidate with posLex < 0.25 and sem < 0.44 or final score < minConfidence (0.29)
      const passesOOD = (posLex >= 0.25 || sem >= oodFloor) && finalScore >= minConf;
      if (passesOOD) {
        candidates.push(
          this.buildMatch(item, user, finalScore, posLex, sem, penalty)
        );
      }
    }

    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score);
    const topMatches = candidates.slice(0, maxRes);

    const endTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const latencyMs = Math.round((endTime - startTime) * 100) / 100;

    return {
      query,
      affirmativeQuery: intent.affirmativeText,
      negatedTerms: intent.negatedTerms,
      matches: topMatches,
      rejectedAsOOD: topMatches.length === 0,
      topRawConfidence: Math.round(topRaw * 100) / 100,
      latencyMs,
      usedSemanticVectors: queryVector !== null,
    };
  }

  private scoreSingleToken(token: string, item: PreIndexedItem): number {
    // 1. O(1) tokenSet (1.0, or 1.08 in labelTokenSet)
    if (item.labelTokenSet.has(token)) return 1.08;
    if (item.tokenSet.has(token)) return 1.0;

    // 2. Stem match (0.92)
    const stemmed = stemToken(token);
    if (item.stemSet.has(stemmed)) return 0.92;

    const tLen = token.length;

    // 3. charCodeAt(0)-guarded prefix and stem-prefix for len >= 3 (0.83 / 0.78)
    if (tLen >= 3) {
      const firstChar = token.charCodeAt(0);
      for (const t of item.tokenSet) {
        if (t.charCodeAt(0) === firstChar && t.startsWith(token)) {
          return 0.83;
        }
      }
      for (const s of item.stemSet) {
        if (s.charCodeAt(0) === firstChar && s.startsWith(stemmed)) {
          return 0.78;
        }
      }

      // 4. 0-index adjacent Damerau transposition across indices 0..len-2 for len >= 3 (0.86)
      // Catches f2a <-> 2fa, scv <-> csv
      for (let j = 0; j <= tLen - 2; j++) {
        const transposed =
          token.slice(0, j) + token[j + 1] + token[j] + token.slice(j + 2);
        if (item.tokenSet.has(transposed)) {
          return 0.86;
        }
      }
    }

    // 5. Pigeonhole-guarded 1-edit Levenshtein for length >= 4 (0.78)
    // where |qLen - hLen| <= 1 and (first or last char matches)
    if (tLen >= 4) {
      const qFirst = token.charCodeAt(0);
      const qLast = token.charCodeAt(tLen - 1);

      for (const cand of item.tokenSet) {
        const cLen = cand.length;
        if (Math.abs(tLen - cLen) <= 1) {
          if (cand.charCodeAt(0) === qFirst || cand.charCodeAt(cLen - 1) === qLast) {
            if (this.isOneEditDistance(token, cand)) {
              return 0.78;
            }
          }
        }
      }
    }

    return 0;
  }

  private isOneEditDistance(s1: string, s2: string): boolean {
    const len1 = s1.length;
    const len2 = s2.length;
    if (Math.abs(len1 - len2) > 1) return false;

    let i = 0;
    let j = 0;
    let edits = 0;

    while (i < len1 && j < len2) {
      if (s1[i] !== s2[j]) {
        edits++;
        if (edits > 1) return false;

        if (len1 > len2) {
          i++;
        } else if (len2 > len1) {
          j++;
        } else {
          i++;
          j++;
        }
      } else {
        i++;
        j++;
      }
    }

    if (i < len1 || j < len2) edits++;
    return edits === 1;
  }

  private buildMatch(
    item: PreIndexedItem,
    user: UserContext | undefined,
    score: number,
    lexicalScore: number,
    semanticScore: number,
    negationPenalty: number
  ): SearchMatch {
    let tierLocked = false;
    let upsellTier: string | undefined;

    if (item.requiredTier) {
      const userTier = user?.tier;
      const entitlements = new Set((user?.entitlements || []).map((e) => e.toLowerCase()));
      const reqLower = item.requiredTier.toLowerCase();
      const hasEntitlement = entitlements.has(reqLower) || entitlements.has(`tier:${reqLower}`);

      if (!hasEntitlement && !this.options.canAccessTier(userTier, item.requiredTier)) {
        if (item.tierPolicy === 'upsell') {
          tierLocked = true;
          upsellTier = item.requiredTier;
        }
      }
    }

    return {
      ...item.raw,
      score: Math.round(score * 100) / 100,
      lexicalScore: Math.round(lexicalScore * 100) / 100,
      semanticScore: Math.round(semanticScore * 100) / 100,
      negationPenalty: Math.round(negationPenalty * 100) / 100,
      tierLocked,
      upsellTier,
    };
  }
}
