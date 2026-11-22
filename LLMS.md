# LLMS.md — Architectural Specification & Machine Guide for AI Agents (Picolocus v1.0.4)

> Dense, machine-readable reference for AI coding agents, automation harnesses, and LLM code generation.
> Governed by strict verification gates: every assertion in this document maps directly to active, tested TypeScript code.

---

## 1. Product Thesis & System Invariants

- **Package Identity:** `@picolocus` (v1.0.4), Apache-2.0 License.
- **Core Philosophy:** *"Show, Don't Chat — Guide, Don't Click."*
  - **Zero Generative Chat / Zero Hallucination:** No conversational bot UI, no cloud LLM API calls, no LLM prose generation. Queries resolve deterministically to UI elements, live table rows, or verbatim policy excerpts in `< 10 ms`.
  - **Zero Autonomous `.click()` or Destructive Mutations:** The SDK never programmatically invokes `.click()` on host elements. Destructive actions (`Delete`, `Revoke`, `Refund`) are highlighted with non-destructive CSS attributes (`[data-pico-active="true"]` / `[data-silent-mi-active="true"]`), guiding the user via visual breadcrumbs while requiring human execution.
  - **Out-of-Distribution (OOD) Gate:** Vector search mathematically returns nearest neighbors even for gibberish or non-existent settings (anisotropy baseline cosine `0.75-0.85`). `@picolocus/core` enforces a lexical support gate (`hasLexicalSupport`); queries without lexical grounding or below calibrated margins return `matches: []`, `rejectedAsOOD: true`, and `decision: 'noul'`, never false-positive guesses.
  - **Negation-First Polarity Gate:** Bi-encoder embeddings score affirmative and negated phrases (e.g. *"delete"* vs. *"do not delete"*) with `>0.90` cosine similarity. `@picolocus/core` isolates negated clauses, extracts exact exclusions before token splitting, rejects affirmative controls on pure-negation queries (`decision: 'noul'`), and pre-indexes clause polarity so self-negated policy statements (*"We do not sell your data"*) match without penalty.
  - **DOM Non-Destructiveness:** Zero `<mark>` tag wrapping. Verbatim document clauses are highlighted via the native browser `CSS.highlights` Range registry. Active controls receive CSS attributes (`[data-pico-active="true"]` / `[data-silent-mi-active="true"]`).
  - **Zero Focus Stealing:** The docked Locator bar and callout badges never steal `document.activeElement`. Users can type in host inputs while matches are highlighted.

---

## 2. Monorepo Package Matrix

| Package | Role | External Runtime Dependencies | Bundle Size Budget |
|---|---|:---:|:---:|
| **`@picolocus/core`** | Zero-dependency hybrid search engine, negation gate, playbooks, Int8 cosine similarity | **0** | `<= 15 KB` gzipped |
| **`@picolocus/web`** | Zero-dependency Pure CSS Highlighter, N-step breadcrumb guidance, Top-Layer callouts, docked Spotlight bar | **0** | Strictly `<= 26 KB` gzipped (measured: ~24.56 KB) |
| **`@picolocus/onnx`** | Client-side Web Worker ONNX embedder plugin, explicit opt-in consent gate, 120s tab-sleep idle RAM reaper | Optional peer (`@huggingface/transformers` in host app) | Isolated Web Worker |
| **`@picolocus/cli`** | Build-time HTML/JSX scanner, manifest compiler, RBAC isolation verifier, golden model smoke test, query assertion CLI | Node runtime only | CLI binary |

---

## 3. Core Architectural Mechanisms

### 3.1 Hybrid Search (`searchInstant` + `.onnx` Vector)
- **Why Native Lexical Operates Alongside ONNX:** Subword tokenizers (WordPiece / BPE) shatter literal technical IDs (`#TX-903`, `sku_8192`, `$412.00`) and short acronyms (`2fa` / `f2a`). Furthermore, compiling WASM and allocating ONNX buffers takes `1.5s–5.0s` on cold start.
- **Two-Stage Execution:**
  1. **Stage 1 (Synchronous Keystroke 1):** `engine.searchInstant()` executes in `< 0.5 ms` using pre-indexed token sets, stem maps, 0-index transpositions (`f2a` <-> `2fa`), and Pigeonhole 1-edit Levenshtein matching.
  2. **Stage 2 (Asynchronous Coalesced Refinement):** When ONNX is consented and warmed, queries enter `LatestOnlyQueue` (`depth = 1`). In-flight embeddings are coalesced; when the Int8 vector resolves, `engine.search()` merges lexical scores with flat `Int8Array` cosine similarity (`< 0.05 ms` for 500 items).

### 3.2 WebAssembly Memory & The 120s Idle Reaper
- **WASM Memory Invariant:** In the WebAssembly standard, instance memory can grow dynamically, but cannot be returned to the OS process while the instance lives.
- **Idle Reaper (`reapIdleWorker`):** Terminating the Web Worker (`worker.terminate()`) is the only reliable browser mechanism to reclaim 60 MB–95 MB of WASM heap RAM.
- The reaper triggers after `120s` of query inactivity or `15s` after `document.visibilityState === 'hidden'`. Model weights remain cached in CacheStorage / IndexedDB for instant re-warm on subsequent interaction.

### 3.3 Explicit Business Consent
- In standard configuration (`consentMode: 'opt-in'`), `@picolocus/onnx` issues **0 network requests, 0 model downloads, and 0 WASM memory allocations** prior to an explicit call to `controller.grantConsent()`.
- Calling `controller.revokeConsent()` terminates the active worker and deletes cached model weights.

### 3.4 Two-Layer RBAC & Physical Manifest Isolation
- **Build-Time Isolation:** `picolocus scan` compiles distinct manifests (`manifest.public.json`, `manifest.docs.json`, `manifest.<role>.json`). Restricted controls and sensitive clauses never enter public bundles.
- **Runtime Purge:** Calling `controller.setUserContext(newUser)` immediately purges active highlights, callout badges, and multi-step stepper sessions. Cross-page handoffs restored from `sessionStorage` re-validate through `filterAuthorizedMatches()`.

### 3.5 Declarative State-Dependent Playbooks
- State-dependent UI routing (e.g. directing to "Verify Domain" -> "Configure IdP URL" -> "Enable SSO" across Free, Unverified, and Ready states) is compiled into declarative `PlaybookRule` JSON.
- Evaluated synchronously by `evaluatePlaybookBranches()` in `< 0.02 ms` without dynamic code evaluation (`eval` / `new Function`).

---

## 4. Public API Reference

### 4.1 `@picolocus/web`

```typescript
import { initPicolocus, createPicolocus, PicolocusClient, PicolocusConfig } from '@picolocus/web';

// Initialize SDK
const pico: PicolocusClient = await initPicolocus({
  user: {
    roles: ['editor'],
    tier: 'pro',
    entitlements: ['feature:export'],
  },
  manifestUrls: {
    public: '/manifests/manifest.public.json',
    docs: '/manifests/manifest.docs.json',
    byRole: { admin: '/manifests/manifest.admin.json' },
  },
  embedder: optionalOnnxEmbedder,
  showBar: true,           // Mounts docked Locator bar
  autoHarvestDom: true,     // Automatically harvests live controls and tbody rows
  routingMode: 'hash',     // 'hash' | 'pathname'
  onNavigate: (route) => { /* custom SPA router callback */ },
});

// Primary Methods
const searchResponse = await pico.query('export audit logs');
const guideResult = await pico.guide(searchResponse.matches[0]);
await pico.setUserContext({ roles: ['admin'], tier: 'enterprise' });
pico.setAppState({ ssoConfigured: true });
await pico.grantConsent();
await pico.revokeConsent();
pico.destroy();
```

### 4.2 `@picolocus/onnx`

```typescript
import { createOnnxEmbedder, estimateOnnxRamFootprintMb, measureClientMemory } from '@picolocus/onnx';

const embedder = createOnnxEmbedder({
  modelId: 'mdbr-leaf-ir',
  localModelPath: '/models/mdbr-leaf-ir',
  idleTimeoutMs: 120000,
  consentMode: 'opt-in', // 'opt-in' | 'eager'
});

// Telemetry & memory metrics
const estMb = estimateOnnxRamFootprintMb(embedder);
const clientHeapMb = await measureClientMemory(); // Resolves in Chromium and Node
```

---

## 5. Manifest Item Schema

```typescript
interface ManifestItem {
  id: string;
  label: string;
  targetType: 'action' | 'navigation' | 'setting' | 'row' | 'doc_clause';
  selector?: string;
  route?: string;
  body?: string;
  roles?: string[];
  requiredTier?: string;
  tierPolicy?: 'hide' | 'upsell';
  parentTriggerSelector?: string;
  triggerChain?: string[];
  verbatimText?: string;
  rowTextFingerprint?: number;
  playbookRule?: PlaybookRule;
  source: 'manifest' | 'dom';
}
```

---

## 6. Verification & Quality Gates

All modifications must pass the 10 quality gates prior to commit:

| Gate | Command | Passing Standard |
|---|---|---|
| **Build SDK** | `npm run build` | All packages compile; `@picolocus/web` `<= 26 KB` gzipped |
| **Verify Versions** | `npm run verify:versions` | Monorepo package manifests and lockfile version parity |
| **Typecheck** | `npm run typecheck` | TypeScript exit 0 across monorepo |
| **Unit Tests** | `npm test` | 68/68 Vitest unit tests pass |
| **Scan Manifests** | `npm run scan` | AST scanner extracts controls and generates manifests |
| **Verify RBAC** | `npm run verify` | 0 restricted controls leaked into public manifests |
| **Query Suite** | `npm run test:queries -- --require-onnx` | All golden query assertions match expected decisions |
| **Model Smoke** | `npm run smoke:model -- --model mdbr-leaf-ir --require-onnx` | Latency `< 60 ms`, RSS `< 350 MB` |
| **Pack Tarballs** | `npm run pack:sdk` *(BypassSandbox: true)* | Clean `.tgz` tarballs generated in `release/` |
| **Real Browser E2E** | `npm run test:e2e` *(BypassSandbox: true)* | 18/18 Playwright scenarios pass in Chromium/Edge |
| **Git Hygiene** | `git status` | Zero untracked scratch files or debug artifacts |
