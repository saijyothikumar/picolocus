/**
 * @picolocus/core - Declarative Playbook Compiler & Branch Evaluator (v1.0.3)
 * Evaluates stateful UI conditional navigation in <0.02 ms with zero eval.
 */

import {
  HarnessConfig,
  ManifestItem,
  PlaybookBranch,
  PlaybookEvalContext,
  PlaybookRule,
  PlaybookTarget,
} from './types.js';
import { tokenizeWords } from './negation.js';

export function defineHarness(config: HarnessConfig): HarnessConfig {
  return config;
}

/**
 * Bidirectional glossary expansion at index and query time within token budgets.
 */
export function expandGlossaryTokens(
  tokens: readonly string[],
  glossary?: Record<string, readonly string[]>,
  maxTokens = 32
): string[] {
  if (!glossary || tokens.length === 0) return [...tokens];
  const out = new Set<string>(tokens.map((t) => t.toLowerCase()));

  for (const t of tokens) {
    if (out.size >= maxTokens) break;
    const lower = t.toLowerCase();

    // Direct mapping (guard against Object prototype property collision)
    const direct = Object.prototype.hasOwnProperty.call(glossary, lower)
      ? glossary[lower]
      : undefined;
    if (Array.isArray(direct)) {
      for (const syn of direct) {
        if (out.size >= maxTokens) break;
        for (const w of tokenizeWords(syn)) {
          if (out.size >= maxTokens) break;
          out.add(w);
        }
      }
    }

    // Reverse mapping
    for (const [key, synList] of Object.entries(glossary)) {
      if (out.size >= maxTokens) break;
      if (Array.isArray(synList) && synList.some((s) => s.toLowerCase() === lower)) {
        for (const w of tokenizeWords(key)) {
          if (out.size >= maxTokens) break;
          out.add(w);
        }
        for (const s of synList) {
          if (out.size >= maxTokens) break;
          for (const w of tokenizeWords(s)) {
            if (out.size >= maxTokens) break;
            out.add(w);
          }
        }
      }
    }
  }

  return Array.from(out);
}

/**
 * Indexes each PlaybookRule as a synthetic ManifestItem with whenUserAsks in synonyms.
 */
export function playbookToManifestItem(rule: PlaybookRule): ManifestItem {
  const firstTarget = rule.branches[0]?.target;
  return {
    id: rule.id,
    label: rule.label,
    description: rule.description,
    whenUserAsks: [...rule.whenUserAsks],
    synonyms: [...rule.whenUserAsks],
    roles: rule.roles,
    requiredTier: rule.requiredTier,
    tierPolicy: rule.tierPolicy,
    source: 'manifest',
    kind: firstTarget?.kind ?? 'spotlight',
    route: firstTarget?.route ?? '/',
    selector: firstTarget?.selector,
    triggerChain: firstTarget?.triggerChain,
    calloutTitle: firstTarget?.calloutTitle,
    calloutText: firstTarget?.calloutText,
    playbookRule: rule,
  };
}

/**
 * Evaluates playbook branches sequentially in <0.02 ms with zero eval.
 */
export function evaluatePlaybookBranches(
  rule: PlaybookRule,
  evalCtx: PlaybookEvalContext
): { branchIndex: number; target: PlaybookTarget } | null {
  const branches = rule.branches;
  for (let i = 0; i < branches.length; i++) {
    const branch = branches[i]!;
    if (branchMatches(branch, evalCtx)) {
      return { branchIndex: i, target: branch.target };
    }
  }
  return null;
}

function branchMatches(branch: PlaybookBranch, ctx: PlaybookEvalContext): boolean {
  if (branch.default) return true;
  const cond = branch.condition;
  if (!cond) return true;

  // 1. App state check
  if (cond.state) {
    if (!ctx.appState) return false;
    for (const [k, expected] of Object.entries(cond.state)) {
      if (ctx.appState[k] !== expected) return false;
    }
  }

  // 2. User role check
  if (cond.userRole) {
    if (!ctx.user) return false;
    const allowed = (Array.isArray(cond.userRole) ? cond.userRole : [cond.userRole]).map((r) =>
      r.toLowerCase().trim()
    );
    const userRoles = (ctx.user.roles || (ctx.user.role ? [ctx.user.role] : [])).map((r) =>
      r.toLowerCase().trim()
    );
    if (!allowed.some((r) => userRoles.includes(r))) return false;
  }

  // 3. User tier check
  if (cond.userTier) {
    if (!ctx.user || !ctx.user.tier) return false;
    const allowed = (Array.isArray(cond.userTier) ? cond.userTier : [cond.userTier]).map((t) =>
      t.toLowerCase().trim()
    );
    const userTier = ctx.user.tier.toLowerCase().trim();
    if (!allowed.includes(userTier)) return false;
  }

  // 4. DOM Snapshot checks
  const dom = ctx.domContext;
  if (cond.domVisible) {
    if (!dom?.visibleSelectors) return false;
    const sels = Array.isArray(cond.domVisible) ? cond.domVisible : [cond.domVisible];
    if (!sels.every((s) => dom.visibleSelectors!.has(s))) return false;
  }
  if (cond.domAbsent) {
    if (dom?.visibleSelectors) {
      const sels = Array.isArray(cond.domAbsent) ? cond.domAbsent : [cond.domAbsent];
      if (sels.some((s) => dom.visibleSelectors!.has(s))) return false;
    }
  }
  if (cond.domDisabled) {
    if (!dom?.disabledSelectors) return false;
    const sels = Array.isArray(cond.domDisabled) ? cond.domDisabled : [cond.domDisabled];
    if (!sels.every((s) => dom.disabledSelectors!.has(s))) return false;
  }
  if (cond.domChecked) {
    if (!dom?.checkedSelectors) return false;
    for (const [sel, expected] of Object.entries(cond.domChecked)) {
      if (dom.checkedSelectors[sel] !== expected) return false;
    }
  }

  // 5. Custom predicate
  if (cond.predicate) {
    try {
      if (!cond.predicate(ctx)) return false;
    } catch {
      return false;
    }
  }

  return true;
}
