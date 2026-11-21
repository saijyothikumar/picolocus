/**
 * @picolocus/core - Negation-first intent gate, action polarity & zero-dependency suffix stemmer (v1.0.0)
 * Product Invariant: "do not delete" must NEVER highlight "Delete workspace".
 * Product Invariant: Directional antonyms (import vs export) trigger polarity rejection;
 * Reversible toggles (enable vs disable) detect live state conflicts without penalty.
 */

import { LexiconConfig, StateConflictKind } from './types.js';

export interface ParsedQueryIntent {
  rawQuery: string;
  truncatedQuery: string;
  hasNegation: boolean;
  isPureNegation: boolean;
  affirmativeText: string;
  affirmativeTokens: string[];
  affirmativeExactTokens: string[];
  negatedTerms: string[];
  secondarySharedTerms: string[];
  negatedExactTokens: string[];
}

export interface RouteNormalizeOptions {
  basePath?: string;
  routingMode?: 'pathname' | 'hash';
}

export interface ActionPolarityResult {
  polarityPenalty: number;
  stateConflict?: StateConflictKind;
}

export const NEGATION_CUES = [
  'instead of',
  'other than',
  'rather than',
  'except for',
  'no longer',
  'does not',
  'will not',
  'did not',
  'do not',
  'not to',
  "doesn't",
  "didn't",
  'cannot',
  'without',
  'except',
  'never',
  "don't",
  "won't",
  'avoid',
  'skip',
  "can't",
  'not',
] as const;

// Exact token patterns: #id, $amount, prefixes (inv-, tx-, usr-, ord-, err-), or mixed alphanumeric >= 3 chars
const EXACT_TOKEN_REGEX = /(?:#[A-Za-z0-9_-]{2,}|\$\d+(?:\.\d+)?|\b(?:inv|tx|usr|ord|err)-[A-Za-z0-9_-]+|\b[A-Za-z0-9]+(?:[-#][A-Za-z0-9]+)+\b)/gi;

// Default directional antonym word groups: [Pole A synonyms, Pole B synonyms]
const DEFAULT_DIRECTIONAL_ANTONYMS: Array<[readonly string[], readonly string[]]> = [
  [['import'], ['export']],
  [['upload'], ['download']],
  [['upgrade'], ['downgrade']],
  [['create', 'add', 'new'], ['delete', 'remove', 'destroy', 'purge']],
  [['archive'], ['restore', 'unarchive']],
  [['send'], ['request', 'receive']],
];

// Default reversible toggle word groups: [Positive/Enable synonyms, Negative/Disable synonyms]
const DEFAULT_REVERSIBLE_TOGGLES: Array<[readonly string[], readonly string[]]> = [
  [['enable', 'activate', 'turn on', 'setup', 'start'], ['disable', 'deactivate', 'turn off', 'stop']],
  [['lock', 'freeze'], ['unlock', 'unfreeze']],
  [['mute'], ['unmute']],
  [['pause'], ['resume']],
  [['show', 'reveal'], ['hide', 'conceal']],
];

/**
 * Normalizes a route with optional basePath stripping and hash route handling.
 */
export function normalizeRoute(route?: string, options?: RouteNormalizeOptions): string {
  if (!route) return '/';
  let r = route.trim();
  if (options?.routingMode === 'hash' || r.startsWith('#')) {
    if (r.startsWith('#')) {
      r = r.slice(1);
    }
  }
  if (options?.basePath && r.startsWith(options.basePath)) {
    r = r.slice(options.basePath.length);
  }
  if (!r.startsWith('/')) {
    r = '/' + r;
  }
  if (r.length > 1 && r.endsWith('/')) {
    r = r.slice(0, -1);
  }
  return r;
}

/**
 * Minimal zero-dependency suffix stemmer for English tokens (length >= 4).
 */
export function stemToken(token: string): string {
  if (token.length < 4) return token;
  const lower = token.toLowerCase();

  if (lower.endsWith('ment') && lower.length >= 6) {
    return lower.slice(0, -4);
  }
  if (lower.endsWith('tion') && lower.length >= 6) {
    return lower.slice(0, -4) + 't';
  }
  if (lower.endsWith('ies') && lower.length >= 5) {
    return lower.slice(0, -3) + 'y';
  }
  if (lower.endsWith('ing') && lower.length >= 5) {
    const base = lower.slice(0, -3);
    if (
      base.length >= 3 &&
      base[base.length - 1] === base[base.length - 2] &&
      !base.endsWith('ll') &&
      !base.endsWith('ss')
    ) {
      return base.slice(0, -1);
    }
    return base;
  }
  if (lower.endsWith('ed') && lower.length >= 5) {
    const base = lower.slice(0, -2);
    if (
      base.length >= 3 &&
      base[base.length - 1] === base[base.length - 2] &&
      !base.endsWith('ll') &&
      !base.endsWith('ss')
    ) {
      return base.slice(0, -1);
    }
    return base;
  }
  if (lower.endsWith('sses')) {
    return lower.slice(0, -2);
  }
  if (
    lower.endsWith('ces') ||
    lower.endsWith('ges') ||
    lower.endsWith('ses') ||
    lower.endsWith('zes')
  ) {
    return lower.slice(0, -1);
  }
  if (lower.endsWith('es') && lower.length >= 5) {
    return lower.slice(0, -2);
  }
  if (lower.endsWith('s') && !lower.endsWith('ss') && lower.length >= 4) {
    return lower.slice(0, -1);
  }

  return lower;
}

export function extractExactTokens(text: string): string[] {
  const matches = text.match(EXACT_TOKEN_REGEX);
  if (!matches) return [];
  const set = new Set<string>();
  for (const m of matches) {
    set.add(m.trim().toLowerCase());
  }
  return Array.from(set);
}

export function tokenizeWords(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9]+/g);
  return words ? words : [];
}

/**
 * Analyzes query affirmative tokens against item tokens and live DOM state.
 * Returns polarityPenalty = 0.85 for directional antonym conflicts (e.g. export vs import).
 * Returns polarityPenalty = 0 with stateConflict: 'already_in_target_state' for reversible toggles.
 */
export function analyzeActionPolarity(
  affirmativeTokens: readonly string[],
  entryAffirmativeTokens: readonly string[],
  liveDomLabel?: string,
  liveChecked?: boolean,
  _lexicon?: LexiconConfig
): ActionPolarityResult {
  const querySet = new Set(affirmativeTokens.map((t) => stemToken(t.toLowerCase())));
  const entrySet = new Set(entryAffirmativeTokens.map((t) => stemToken(t.toLowerCase())));

  // 1. Directional Antonym Check
  for (const [poleAGroup, poleBGroup] of DEFAULT_DIRECTIONAL_ANTONYMS) {
    const itemHasA = poleAGroup.some((w) => entrySet.has(stemToken(w)));
    const itemHasB = poleBGroup.some((w) => entrySet.has(stemToken(w)));

    // Dual-pole immunity (e.g. "Import & Export Contacts")
    if (itemHasA && itemHasB) {
      continue;
    }

    const queryWantsA = poleAGroup.some((w) => querySet.has(stemToken(w)));
    const queryWantsB = poleBGroup.some((w) => querySet.has(stemToken(w)));

    // Query demands pole A, but item only exposes pole B
    if (queryWantsA && !queryWantsB && itemHasB && !itemHasA) {
      return { polarityPenalty: 0.85 };
    }
    // Query demands pole B, but item only exposes pole A
    if (queryWantsB && !queryWantsA && itemHasA && !itemHasB) {
      return { polarityPenalty: 0.85 };
    }
  }

  // 2. Reversible State Toggle Check
  const liveLabelLower = (liveDomLabel || '').toLowerCase();
  for (const [posGroup, negGroup] of DEFAULT_REVERSIBLE_TOGGLES) {
    const queryWantsPos = posGroup.some((w) => querySet.has(stemToken(w)));
    const queryWantsNeg = negGroup.some((w) => querySet.has(stemToken(w)));

    if (!queryWantsPos && !queryWantsNeg) continue;

    // Item must be related to this toggle group
    const itemIsToggle =
      posGroup.some((w) => entrySet.has(stemToken(w))) ||
      negGroup.some((w) => entrySet.has(stemToken(w)));

    if (!itemIsToggle) continue;

    // If query wants POSITIVE (e.g. "enable 2fa"):
    // Check if live button already shows NEGATIVE (e.g. "Disable 2FA") or liveChecked === true
    if (queryWantsPos) {
      const alreadyActive =
        liveChecked === true ||
        negGroup.some((w) => liveLabelLower.includes(w.toLowerCase()));
      if (alreadyActive) {
        return {
          polarityPenalty: 0.0,
          stateConflict: 'already_in_target_state',
        };
      }
    }

    // If query wants NEGATIVE (e.g. "disable 2fa"):
    // Check if live button already shows POSITIVE (e.g. "Enable 2FA") or liveChecked === false
    if (queryWantsNeg) {
      const alreadyDisabled =
        liveChecked === false ||
        posGroup.some((w) => liveLabelLower.includes(w.toLowerCase()));
      if (alreadyDisabled) {
        return {
          polarityPenalty: 0.0,
          stateConflict: 'already_in_target_state',
        };
      }
    }
  }

  return { polarityPenalty: 0.0 };
}

export const CUE_PATTERN = new RegExp(
  `\\b(?:${NEGATION_CUES.map((c) => c.replace("'", "['’]")).join('|')})\\b`,
  'i'
);

/**
 * Parses user query into affirmative vs negated intent.
 */
export function parseQueryIntent(rawQuery: string): ParsedQueryIntent {
  const truncated = rawQuery.length > 512 ? rawQuery.slice(0, 512) : rawQuery;
  const trimmed = truncated.trim();
  if (!trimmed) {
    return {
      rawQuery,
      truncatedQuery: truncated,
      hasNegation: false,
      isPureNegation: false,
      affirmativeText: '',
      affirmativeTokens: [],
      affirmativeExactTokens: [],
      negatedTerms: [],
      secondarySharedTerms: [],
      negatedExactTokens: [],
    };
  }

  // Split clauses on commas, semicolons, isolated dashes, and "but"
  const clauseSplits = trimmed.split(/[,;]|\s+-\s+|\bbut\b/i);

  const affirmativeClauses: string[] = [];
  const negatedClauses: string[] = [];
  let foundNegation = false;

  for (const clause of clauseSplits) {
    const clauseTrimmed = clause.trim();
    if (!clauseTrimmed) continue;

    const match = CUE_PATTERN.exec(clauseTrimmed);
    if (match && typeof match.index === 'number') {
      foundNegation = true;
      const cueIndex = match.index;
      const beforeCue = clauseTrimmed.slice(0, cueIndex).trim();
      const afterCue = clauseTrimmed.slice(cueIndex + match[0].length).trim();

      if (beforeCue) affirmativeClauses.push(beforeCue);
      if (afterCue) negatedClauses.push(afterCue);
    } else {
      affirmativeClauses.push(clauseTrimmed);
    }
  }

  // 1. Process Negated Clauses: extract negatedExactTokens first
  const negatedExactSet = new Set<string>();
  const negatedKeywordList: string[] = [];

  for (const negClause of negatedClauses) {
    const exactTokens = extractExactTokens(negClause);
    for (const et of exactTokens) {
      negatedExactSet.add(et);
    }

    // Strip exact token patterns from the negated text before keyword splitting
    const strippedClause = negClause.replace(EXACT_TOKEN_REGEX, ' ');
    const words = tokenizeWords(strippedClause);
    for (const w of words) {
      if (w.length >= 2) {
        negatedKeywordList.push(w);
      }
    }
  }

  // 2. Process Affirmative Clauses
  const affirmativeText = affirmativeClauses.join(' ').trim();
  const affirmativeExactTokens = extractExactTokens(affirmativeText);
  const affirmativeTokens = tokenizeWords(affirmativeText);
  const affirmativeSet = new Set(affirmativeTokens);

  // 3. Partition Negated Keywords into Primary vs Secondary Shared Terms
  const primaryNegatedSet = new Set<string>();
  const secondarySharedSet = new Set<string>();

  for (const w of negatedKeywordList) {
    if (affirmativeSet.has(w)) {
      secondarySharedSet.add(w);
    } else {
      primaryNegatedSet.add(w);
    }
  }

  const CONVERSATIONAL_STOPWORDS = new Set(['we', 'i', 'you', 'please', 'can', 'policy', 'terms']);
  const meaningfulAffirmative = affirmativeTokens.filter((t) => !CONVERSATIONAL_STOPWORDS.has(t));
  const isPure = foundNegation && meaningfulAffirmative.length === 0;

  return {
    rawQuery,
    truncatedQuery: truncated,
    hasNegation: foundNegation,
    isPureNegation: isPure,
    affirmativeText,
    affirmativeTokens,
    affirmativeExactTokens,
    negatedTerms: Array.from(primaryNegatedSet),
    secondarySharedTerms: Array.from(secondarySharedSet),
    negatedExactTokens: Array.from(negatedExactSet),
  };
}
