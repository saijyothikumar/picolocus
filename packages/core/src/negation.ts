/**
 * @silent-mi/core - Negation-first intent gate & zero-dependency suffix stemmer
 * Product Invariant: "do not delete" must NEVER highlight "Delete workspace".
 */

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

/**
 * Minimal zero-dependency suffix stemmer for English tokens (length >= 4).
 * Handles -ing, -ed, -ies, -es, -s, -tion, -ment.
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
    // Double consonant check (e.g. stopping -> stop, running -> run), but preserve 'll' and 'ss' (billing -> bill, passing -> pass)
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

/**
 * Extracts literal exact tokens (#id, $amount, prefixes, alphanumeric hyphenated).
 */
export function extractExactTokens(text: string): string[] {
  const matches = text.match(EXACT_TOKEN_REGEX);
  if (!matches) return [];
  const set = new Set<string>();
  for (const m of matches) {
    set.add(m.trim().toLowerCase());
  }
  return Array.from(set);
}

/**
 * Tokenizes text into individual lowercase alphanumeric words.
 */
export function tokenizeWords(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9]+/g);
  return words ? words : [];
}

/**
 * Parses user query into affirmative vs negated intent.
 * 1. Truncates to 512 characters.
 * 2. Splits around negation cues and clause delimiters.
 * 3. Extracts negatedExactTokens before keyword extraction to protect IDs like #TX-904.
 * 4. Separates primary negated terms from secondary shared terms.
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

  // Build regex matching negation cues on word boundaries
  const cuePattern = new RegExp(
    `\\b(?:${NEGATION_CUES.map((c) => c.replace("'", "['’]")).join('|')})\\b`,
    'i'
  );

  for (const clause of clauseSplits) {
    const clauseTrimmed = clause.trim();
    if (!clauseTrimmed) continue;

    const match = cuePattern.exec(clauseTrimmed);
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
      // Exclude short noise tokens
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

  const isPure = foundNegation && affirmativeTokens.length === 0;

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
