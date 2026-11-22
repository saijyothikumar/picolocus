<p align="center">
  <img src="./assets/pico-locus-mascot.svg" alt="Picolocus Mascot" width="220" />
</p>

<h1 align="center">Picolocus (<code>@picolocus/*</code>)</h1>

<p align="center">
  <strong>Client-Side Micro-Intelligence SDK (v1.0.4)</strong><br />
  <em>Show, Don't Chat — Guide, Don't Click.</em>
</p>

<p align="center">
  <a href="https://github.com/saijyothikumar/picolocus/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache-2.0" /></a>
  <img src="https://img.shields.io/badge/bundle%20size-24.7%20KB%20gzipped-success.svg" alt="Bundle Size" />
  <img src="https://img.shields.io/badge/accuracy-100.0%25%20(56%2F56)-brightgreen.svg" alt="Benchmark Accuracy" />
  <img src="https://img.shields.io/badge/dependencies-0%20runtime-brightgreen.svg" alt="Zero Dependencies" />
  <a href="https://saijyothikumar.github.io/picolocus/"><img src="https://img.shields.io/badge/live%20demo-GitHub%20Pages-blueviolet.svg" alt="Live Demo" /></a>
</p>

`Picolocus` is a modular, privacy-preserving client-side Micro-Intelligence SDK that helps users locate controls across hundreds of fields, step through matches via **Prev / Next** buttons or an expandable **Details List**, navigate closed or lazy-mounted drawers, find dynamic table rows, and highlight verbatim policy clauses **without cloud LLM calls, chat UIs, focus-stealing overlays, or autonomous destructive clicks**.

> **For AI Coding Agents & LLMs:** Read [`LLMS.md`](./LLMS.md) and [`AGENTS.md`](./AGENTS.md) for concise machine specifications, architectural invariants, and schema definitions.

---

## Clean Single-Branch Architecture (Main SDK vs. Optional `.onnx` vs. Sandbox)

Everything stays version-controlled on **one Git branch**, while `files: ["dist"]` and separate packages guarantee end-users install **zero test UI, zero third-party bloat, and zero unused ONNX dependencies**:

```text
AGENTS.md         # Concise business-logic & design context for AI agents
packages/         # <-- MAIN DISTRIBUTABLE PROJECT (packed via npm run pack:sdk)
  core/           # @picolocus/core — Zero-dep hybrid engine, negation gate, playbooks, Int8 cosine
  web/            # @picolocus/web — Zero-dep Pure CSS Highlighter + Docked Locator (~24.5 KB gzipped, ZERO ONNX code)
  onnx/           # @picolocus/onnx — Optional .onnx WebWorker plug-in + idle RAM reaper + client memory profiler
  cli/            # @picolocus/cli — Build-time HTML/JSX AST scanner, RBAC verifier, smoke test & query test CLI
sandbox/          # <-- ISOLATED TESTBED & E2E ONLY ("private": true — NEVER shipped to SDK users)
  demo-saas/      # Interactive test app (panels, inputs, 200-row table, ?onnx= loader & RAM telemetry)
  e2e/            # Playwright real-browser E2E suite (Chromium in CI / Microsoft Edge local)
```

---

## Integrating Into Any Client App

### 1. Zero-Config Mode (`@picolocus/web` Only — `<= 26 KB` Gzipped, `0` Dependencies)

Works out of the box on any web app with **zero manifest JSON, zero roles/tiers required, and zero `.onnx` weights**:

```typescript
import { initPicolocus } from '@picolocus/web';

const pico = await initPicolocus();
```

Or drop in a single `<script>` tag (`packages/web/dist/picolocus.iife.js`):

```html
<script src="/picolocus.iife.js" data-pico-auto></script>
```

*(Note: `@silent-mi/web`, `initSilentMI`, and `data-silent-mi-auto` are supported as backward-compatible aliases).*

### 2. Custom Tiers, Multi-Role RBAC & Entitlements (Domain-Agnostic)

No role names or tier hierarchies are hardcoded. Configure any custom plan ladder (`tierOrder`), feature flags (`entitlements`), multi-role arrays (`roles`), per-role manifests (`manifestUrls.byRole`), or custom predicates (`canAccessTier`, `canAccessRoles`):

```typescript
import { initPicolocus } from '@picolocus/web';

const pico = await initPicolocus({
  tierOrder: ['free', 'pro', 'enterprise'],
  user: {
    roles: ['billing_editor', 'auditor'],
    tier: 'free',
    entitlements: ['addon:sso'], // Unlocks specific features regardless of plan rank
  },
  manifestUrls: {
    public: '/manifests/manifest.public.json',
    docs: '/manifests/manifest.docs.json',
    byRole: {
      admin: '/manifests/manifest.admin.json',
    },
  },
});
```

In HTML/JSX, `data-mi-ignore`, `data-mi-roles`, `data-mi-tier`, and `data-mi-tier-policy` (`"hide"` or `"upsell"`) can be placed directly on elements or inherited from parent containers (`<section data-mi-roles="auditor">`) across controls, live `table tbody tr` rows, and `[data-mi-clause]`/`<article>` policy clauses.

### 3. Neural Hybrid Mode with Explicit Business Consent (`@picolocus/onnx`)

Install `@picolocus/onnx` + `@huggingface/transformers` when deploying a self-hosted `.onnx` checkpoint (such as Matryoshka 256d `mdbr-leaf-ir`):

```typescript
import { initPicolocus } from '@picolocus/web';
import { createOnnxEmbedder } from '@picolocus/onnx';

const embedder = createOnnxEmbedder({
  modelId: 'mdbr-leaf-ir',
  localModelPath: '/models/mdbr-leaf-ir',
  idleTimeoutMs: 120000, // Reclaims ~60-95 MB WASM RAM after 2 min idle (auto re-warms on next query)
});

const pico = await initPicolocus({
  embedder,
  manifestUrls: {
    public: '/manifests/manifest.public.json',
  },
});

// Explicit Business Consent: 0 network or model requests prior to consent
await pico.grantConsent();
console.log('AI Consented:', pico.isConsented());
```

> **Why Hybrid Search = Native Lexical + `.onnx` Vector:** Even when `.onnx` is enabled, `@picolocus/core` runs synchronous lexical scoring (`< 0.5 ms`) on keystroke 1 for literal IDs (`#TX-903`, `$412.00`), 3-char prefixes (`revok`), and `0`-index transpositions (`f2a` <-> `2fa`) that subword encoders miss, then seamlessly merges coalesced WebWorker Int8 semantic scores for domain paraphrases (`"kill session"` -> `"Revoke All API Keys"`).

---

## Built-In Security & Browser Optimization Guarantees

- **Zero Stitched Runtime Dependencies:** `@picolocus/core` and `@picolocus/web` ship `0` external dependencies — native pre-indexed token/stem `Set`s, `0`-index Damerau transpositions (`f2a` <-> `2fa`), Pigeonhole-guarded 1-edit typo matching, branch-and-bound coverage pruning, `tbody`-cached live table harvesting, and flat `Int8Array` cosine similarity (`< 0.05 ms` for 500 items).
- **Negation, Pure-Negation & Self-Negated Clause Safety:** Queries like "pause billing, do NOT delete workspace" or pure negations ("do not delete workspace") block destructive matches (`rejectedAsOOD: true` even at 1.00 cosine), while pre-indexed clause polarity preserves self-negated policy sentences ("We do not sell, rent, or trade your personal email").
- **Strict CSP & Trusted Types Ready:** Zero `innerHTML`, `outerHTML`, or `eval` across all runtime packages; scoped Light DOM `[data-smi-ui="true"]` isolation for the docked Locator bar; native `CSS.highlights` API for zero-DOM-mutation clause highlighting.
- **Declarative Playbooks:** State-dependent UI workflows (such as SSO configuration branches based on plan tier and setup state) evaluate in `<0.02 ms` without dynamic code evaluation or external Python training loops.
- **Top-Layer Popover Callouts:** Modal callouts mount using native `popover="manual"` with dialog fallbacks to guarantee high z-index visibility above any host application layer.
- **Two-Layer RBAC Isolation:** Build-time `picolocus scan` + `picolocus verify` prevent restricted controls and restricted document clauses from entering `manifest.public.json` or `manifest.docs.json`, and runtime `setUserContext()` purges active highlights and stepper sessions immediately on role changes.

---

## Quick Start — Local Verification & Packaging

```powershell
# Build & typecheck all 4 SDK packages + sandbox
npm run build
npm run typecheck

# Harvest controls, compile manifests & verify 0 RBAC leaks
npm run scan
npm run verify

# Run Golden Model & RAM Smoke Gate (Matryoshka 256d Int8 ONNX)
npm run smoke:model -- --model mdbr-leaf-ir --require-onnx

# Run query suite assertions
npm run test:queries -- --require-onnx

# Run all Vitest unit tests + Playwright real-browser Microsoft Edge E2E tests
npm test
npm run test:e2e

# Export clean, test-free .tgz SDK tarballs into ./release/
npm run pack:sdk

# Start interactive sandbox app (http://localhost:5173 or http://localhost:5173/?onnx=true)
npm run dev
```

---

## Testing in Real Projects & Live Performance Telemetry

### 1. Interactive Sandbox with Live Metrics
Run the local sandbox app to test and observe search latency and memory in real time:
```bash
npm run dev
```
- Open `http://localhost:5173` for pure lexical mode (`0 MB` ONNX RAM).
- Open `http://localhost:5173/?onnx=true&consent=eager` to test ONNX Matryoshka 256d vector search.
- The top-right badge displays live **RAM footprint** (ONNX estimate + actual Chromium JS heap memory) and last query latency.

### 2. Browser DevTools Console Monitoring
Every search logs real-time telemetry into the browser DevTools console:
```text
[Picolocus Telemetry] "export audit" -> choice (1 matches, top: "Export Audit Data") in 1.45ms | Heap: 38.2 MB (+0.1 MB)
```
Inspect structured telemetry history at any time in the console via:
```javascript
window.__picolocus_telemetry.records
```

### 3. Automated Hardware Benchmark (RSS & Latency Smoke Gate)
Benchmark ONNX inference latency and heap memory delta directly from the command line:
```bash
npm run smoke:model -- --model mdbr-leaf-ir --require-onnx
```
Verifies that 10 consecutive warm inference passes remain below `60 ms` latency and `350 MB` process RSS (observed: `~9.8 ms` latency, `~227 MB` RSS).

---

## Empirical Benchmark Accuracy & Client RAM Telemetry

### 1. 56-Query Benchmark Evaluation (`100.0%` Accuracy)
The suite evaluates `@picolocus/core` and `@picolocus/onnx` against 56 diverse real-world assertions across 10 distinct categories, runnable via `npm run test:queries -- --require-onnx`:

| Benchmark Category | Queries Tested | Pass Rate | Measured Latency |
|:---|:---:|:---:|:---:|
| **Affirmative UI Actions** (Direct controls, settings, modals) | 8 | **100.0%** (8/8) | 4.8 – 10.0 ms |
| **Typos & Transpositions** (`f2a`, `save prfile`, `webhoks`, `dark mdoe`) | 6 | **100.0%** (6/6) | 4.3 – 5.1 ms |
| **Conversational Paraphrases** (Domain synonyms & phrasing) | 6 | **100.0%** (6/6) | 4.2 – 6.0 ms |
| **Dynamic Table Rows & Vendors** (`#TX-900`–`#TX-911`, Hooli, Cyberdyne) | 10 | **100.0%** (10/10) | 4.8 – 7.2 ms |
| **Pure Negation Intent Gates** ("do not delete workspace" -> OOD `noul`) | 7 | **100.0%** (7/7) | 4.4 – 5.4 ms |
| **Exception Negations** ("view invoice #TX-902 except #TX-903") | 2 | **100.0%** (2/2) | 6.1 – 7.0 ms |
| **Self-Negated Policy Clauses** ("We do not sell personal email") | 3 | **100.0%** (3/3) | 4.5 – 4.7 ms |
| **Out-Of-Distribution (OOD)** (Pizza, flights, acoustic guitar, quantum physics) | 6 | **100.0%** (6/6) | 5.2 – 7.9 ms |
| **Stateful Playbook Branches & Tier Locks** (Free upgrade, SSO toggle, IdP URL) | 4 | **100.0%** (4/4) | 5.5 – 8.4 ms |
| **Role-Based Access Control** (Viewer rejected vs Admin allowed danger zone) | 4 | **100.0%** (4/4) | 4.7 – 5.9 ms |
| **OVERALL COMPLIANCE** | **56** | **100.0%** (56/56) | **~5.8 ms avg** |

### 2. Empirical Client Memory Breakdown
Telemetry measured on live Chromium sessions:

| Search Mode | Client WASM RAM | Host JS Heap Overhead | Total Tab RAM Footprint | Behavioral Invariant |
|:---|:---:|:---:|:---:|:---|
| **Pure Lexical Mode** | `0 MB` | `<= 24 KB` | `<= 25 KB` | Zero model downloads, zero WASM heap. Keystroke-1 latency `< 0.5 ms`. |
| **Neural ONNX (`mdbr-leaf-ir` q4)** | `~54.6 MB` weights + `~7.4 MB` context | `~10 MB` worker thread | `~65–74 MB` | Matryoshka 256d Int8 vectors. Re-warms in `< 80 ms`. |
| **Idle Reaped State** | `0 MB` (fully reclaimed) | `<= 24 KB` | `<= 25 KB` | Worker terminated after 120s inactivity (or 15s hidden tab). Auto-resyncs on next query. |

---

## CI/CD, Deployment & Package Distribution

### 1. GitHub Actions CI Matrix (`.github/workflows/ci.yml`)
Automated multi-version verification runs on every push and PR to `main`:
- **Matrix:** Node.js `20.x` and `22.x` on `ubuntu-latest`.
- **Verification Gates Executed in CI:**
  1. `npm audit --audit-level=high` (High-severity vulnerability audit)
  2. `npm run build` (Core, CLI, Web, ONNX compilation)
  3. `npm run verify:versions` (Cross-monorepo version parity check)
  4. `npm run typecheck` (Monorepo strict TypeScript)
  5. `npm test` (Vitest with isolated forks)
  6. `npm run scan` (AST harvest & manifest compiler)
  7. `npm run verify` (0 RBAC leaks & bounds verification)
  8. `npm run test:queries -- --require-onnx` (Golden query evaluation with ONNX)
  9. `npm run smoke:model -- --require-onnx` (Memory RSS and latency thresholds)
  10. `npm run build:demo` (Vite production distribution)
  11. `npm run pack:sdk` (Release tarballs generation)
  12. `npm run test:e2e` (Playwright browser automation)

### 2. Live Production Demo Hosting
The interactive sandbox workbench (`sandbox/demo-saas`) is production-ready across multiple cloud hosting targets:
- **GitHub Pages:** Automatically built and deployed on every push to `main` via [`.github/workflows/deploy-pages.yml`](./.github/workflows/deploy-pages.yml) at `https://saijyothikumar.github.io/picolocus/`.
- **Vercel:** Pre-configured via [`vercel.json`](./vercel.json) with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless` headers for optional multithreaded WebAssembly workloads (single-threaded WASM runs without COOP/COEP headers across all hosts, including GitHub Pages).
- **Render:** Pre-configured via [`render.yaml`](./render.yaml) for static site hosting.

### 3. Publishing & Sharing the SDK
- **Automated GitHub Release & npm Publish:** Triggered via [`.github/workflows/release.yml`](./.github/workflows/release.yml) with npm provenance (`--provenance`).
- **Private / Offline Sharing:** Distribute the `.tgz` files generated by `npm run pack:sdk` in `./release/` (`npm install ./release/picolocus-web-1.0.4.tgz`).
- **Public npm Registry:** Run `npm publish --access public` inside each `packages/*` directory once ready.
- **GitHub Packages:** Point `publishConfig.registry` to `https://npm.pkg.github.com` under your GitHub org scope (`saijyothikumar`).
