# AGENTS.md — Business Logic & Architectural Context (Picolocus v1.0.4)

> Concise context for AI agents. Focuses strictly on **business logic** and **why** each architectural invariant exists — omitting standard TypeScript/monorepo details agents can infer directly.

## 1. Product Thesis: "Show, Don't Chat — Guide, Don't Click"

- **Zero Generative Chat / Zero Hallucination:** Users want to locate a UI control, live table row, or verbatim policy sentence in `< 10 ms`, not read LLM prose. Out-of-distribution queries must return `matches: []` (`rejectedAsOOD: true`), never a low-confidence guess.
- **Zero Autonomous `.click()` or Mutations:** Highlight targets via `[data-pico-active="true"]` (or `[data-silent-mi-active="true"]`) and guide across closed drawers/tabs/modals via N-step breadcrumbs (Step 1 highlights trigger -> human clicks -> Step 2 awaits lazy SPA portals via `waitForElementSelector` + CSS geometry stabilization via `waitForStableRect`). Never programmatically `.click()` host controls, as apps contain destructive actions (`Delete`, `Revoke`, `Refund`).
- **Negation-First Intent Gate (`packages/core/src/negation.ts`, `engine.ts`):** Standard embeddings score "delete" and "do not delete" nearly identically (>0.90 cosine). Split affirmative vs. negated clauses before scoring; extract negated `ExactTokens` ("except #TX-903") before keyword splitting so `#TX-904` is never poisoned; reject affirmative controls on pure-negation queries ("do not delete workspace" -> `rejectedAsOOD: true` even at `sem = 1.00`); and pre-index clause-scoped polarity (`hasSelfNegatedTerms`) at load time so self-negated policy clauses ("We do not sell, rent, or trade your personal email") match without penalty.

## 2. Browser Extreme Optimization & Opt-In Architecture

- **Zero External Runtime Dependencies in `@picolocus/core` & `@picolocus/web` (`<= 26 KB` gzipped):** Pre-indexed token/stem `Set`s + `0`-index transposition (`f2a` <-> `2fa`) + Pigeonhole-guarded 1-edit Levenshtein + flat `Int8Array` cosine (`~0.04 ms` for 500 items) deliver high performance without stitched runtime bloat.
- **Explicit Business Consent & Idle Reaper:** Zero model downloads, WASM memory allocation, or network requests prior to explicit opt-in consent (`controller.grantConsent()`). Inference runs in a latest-only coalesced Web Worker (`LatestOnlyQueue`, `depth = 1`); `reapIdleWorker()` (`120 s` default) terminates the Worker to reclaim ~60-95 MB WASM RAM while preserving transparent re-warm + DOM vector re-sync.
- **Why Native Lexical (`searchInstant`) Stays Alongside `.onnx`:** `computeLexicalScores` is the lexical half of Hybrid Search (Lexical + `.onnx` Int8 Vector), not a missing-model shim. WordPiece/BPE `.onnx` subwords miss literal `#TX-903` IDs, 3-char prefixes, and `0`-index acronym transpositions, while `searchInstant()` delivers `< 0.5 ms` keystroke-1 responsiveness while the Web Worker warms or recovers from idle RAM reaping.
- **Declarative Playbooks Over Python SVD:** State-dependent UI routing (e.g. SSO configuration across free, unverified, and configured states) is compiled declaratively via `PlaybookRule` (`evaluatePlaybookBranches` in `<0.02 ms` with zero eval), eliminating legacy Python training pipelines.
- **Zero DOM Mutation & Zero Focus Stealing:** Highlight verbatim clauses via native `CSS.highlights` (`Range`) — never wrap host DOM text in `<mark>` tags. Never steal `document.activeElement` or mount blocking backdrops; clicking a host control triggers highlight relief while keeping Prev/Next stepper state alive.

## 3. Generalization, Security & Enterprise Constraints

- **Domain-Agnostic Roles & Tiers:** Never hardcode SaaS tiers (`free`/`pro`/`enterprise`) or role names (`viewer`/`admin`) in core/web logic. Host apps pass `tierOrder`, `entitlements`, `manifestUrls.byRole`, or `canAccessTier`/`canAccessRoles` predicates; unconfigured tiers fail closed except on exact match or explicit entitlement.
- **Two-Layer RBAC & Cross-Page Handoff Isolation:** Restricted controls and restricted `highlight_clause` items must never enter `manifest.public.json`, `manifest.docs.json`, or unauthenticated bundles (`npm run verify`). Container `data-mi-roles`, `data-mi-tier`, and `data-mi-tier-policy` inherit across controls, live table rows, and prose clauses. Restored `sessionStorage` handoffs pass through `filterAuthorizedMatches()`, and `setUserContext()` immediately purges active highlights, callouts, and stepper sessions.
- **Trusted Types CSP, Same-Origin Routes & Top-Layer Callouts:** Never use `innerHTML`, `outerHTML`, or `eval` in runtime packages. Validate cross-page routes via `resolveSafeSameOriginUrl()`. Callouts mount using modern top-layer `popover="manual"` with dialog fallbacks to guarantee visibility over host z-indexes.

## 4. Verification Commands

| Check | Command |
|---|---|
| Build all SDK packages | `npm run build` |
| Typecheck SDK + sandbox | `npm run typecheck` |
| All unit tests (Vitest) | `npm test` |
| Scan & compile manifests | `npm run scan` |
| Verify zero RBAC leaks | `npm run verify` |
| Query assertions (real ONNX) | `npm run test:queries -- --require-onnx` |
| Model & RAM smoke gate | `npm run smoke:model -- --model mdbr-leaf-ir --require-onnx` |
| Export clean `.tgz` tarballs | `npm run pack:sdk` (with BypassSandbox: true) |
| Real-browser E2E (Edge) | `npm run test:e2e` (with BypassSandbox: true) |
