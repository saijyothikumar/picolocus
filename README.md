#`@silent-mi-Client-Side "Silent UI" Micro-Intelligence SDK

> **Show, Don't Chat - Guide, Don't Click.**

> License: **Apache-2.0** Browser Footprint: **`~24.5 KB` gzipped (`0` runtime dependencies)**

@silent-mi is a modular, privacy-preserving client-side Micro-Intelligence SDK that helps users locate controls across hundreds of fields, step through matches via ** Prev / Next ** buttons or an expandable **Details List**, navigate closed or lazy-mounted drawers, find dynamic table rows, and highlight verbatim policy clauses **without cloud LLM calls, chat Uls, focus-stealing overlays, or autonomous destructive clicks**.

> **For Al Coding Agents & Maintainers:** Read [`AGENTS.md'](./AGENTS.md) first for concise business logic and the

architectural reasoning behind every core invariant.

##Clean Single-Branch Architecture (Main SDK vs. Optional.onnx vs. Sandbox)

Everything stays version-controlled on **one Git branch**, while files: ["dist"]` and separate packages guarantee end-users install **zero test UI, zero third-party bloat, and zero unused ONNX dependencies**:
text

AGENTS.md

#Concise business-logic & design context for Al agents

packages/

# <-- MAIN DISTRIBUTABLE PROJECT (packed via npm run pack:sdk)

-core/

#@silent-mi/core-Zero-dep hybrid engine, stems, transpositions, negation gate, Int8 math,

generalized RBAC/tiers

web/

# @silent-mi/web-Zero-dep Pure CSS Highlighter + Docked Locator (~24.5 KB gzipped, ZERO

ONNX code)

onnx/

# @silent-mi/onnx - Optional.onnx WebWorker plug-in + idle RAM reaper + client memory profiler

cli/

#@silent-mi/cli - Build-time HTML/JSX AST scanner, RBAC verifier, smoke test & init-train CLI

sandbox/

# <-- ISOLATED TESTBED & E2E ONLY ("private": true - NEVER shipped to SDK users)

demo-saas/

# Interactive test app (panels, inputs, 200-row table, ?onnx= loader & RAM telemetry)

e2e/

# Playwright real-browser Microsoft Edge E2E suite

python/

#.onnx drop-in guide & CPU LinearAdapter / ONNX QUInt8 trainer (silent-mi-trainer)

## Integrating Into Any Client App

### 1. Zero-Config Mode (@silent-mi/web` Only - `~24.5 KB Gzipped, `0` Dependencies)

Works out of the box on any web app with **zero manifest JSON, zero roles/tiers required, and zero `.onnx` weights**: ts

import { initSilentMI } from '@silent-mi/web';

const mi await initSilentMI();
Or drop in a single <script>` tag('packages/web/dist/silent-mi.iife.js'):

html

<script src="/silent-mi.iife.js" data-silent-mi-auto></script>

### 2. Custom Tiers, Multi-Role RBAC & Entitlements (Domain-Agnostic)

No role names or tier hierarchies are hardcoded. Configure any custom plan ladder (`tierOrder`), feature flags

(`entitlements), multi-role arrays (`roles'), per-role manifests (`manifestUrls.byRole), or custom predicates

(canAccessTier`, `canAccessRoles):

ts

import { initSilentMI } from '@silent-mi/web';

const mi = await initSilentMI({

tierOrder: ['starter', 'growth', 'scale'], // Any custom tier order (optional)

user: {

},

roles: ['billing_editor', 'auditor'],

tier: 'starter',

entitlements: ['addon:sso'], // Unlocks specific features regardless of plan rank

manifestUrls: {

public: '/manifests/manifest.public.json',

docs: '/manifests/manifest.docs.json',

byRole: {

billing editor: '/manifests/manifest.billing.json',
auditor: '/manifests/manifest.auditor.json',

},

},

});

In HTML/JSX, `data-mi-ignore`, `data-mi-roles`, `data-mi-tier`, and `data-mi-tier-policy` (`"hide" or

"spotlight_upsell") can be placed directly on elements or inherited from parent containers (<section data-mi-roles="auditor">') across controls, live `table tbody tr` rows, and `[data-mi-doc]`/`<article> policy clauses.

### 3. Neural Hybrid Mode (@silent-mi/web` + Optional @silent-mi/onnx` Plug-in)

Install @silent-mi/onnx' + @huggingface/transformers only when deploying a self-hosted.onnx checkpoint (see [python/README.md'](./python/README.md) for offline.onnx setup and CPU `LinearAdapter fitting):

ts

import { initSilentMI } from '@silent-mi/web';

import { createOnnxEmbedder } from '@silent-mi/onnx';

const mi = await initSilentMI({

embedder: createOnnxEmbedder({

onnxModelld: 'bge-micro-v2',

localModelPath: '/models/',

wasmPath: '/wasm/',

expected ModelSha256: '<sha256-from-silent-mi-scan>', // Required when loading a LinearAdapter

idleTimeoutMs: 120 000, // Reclaims ~60-95 MB WASM RAM after 2 min idle (auto re-warms on next query)
}),

adapterUrls: {

public: '/manifests/adapter.public.json',

},

});

> **Why Hybrid Search = Native Lexical +`.onnx Vector:** Even when `.onnx` is enabled, @silent-mi/core` runs synchronous lexical scoring (<0.5 ms`) on keystroke 1 for literal IDs (#TX-903`, `$412.00′), 3-char prefixes (`revok`), and `0`-index transpositions (f2a2fa`) that subword encoders miss, then seamlessly merges coalesced WebWorker Int8 semantic scores for domain paraphrases (` "kill session" → "Revoke All API Keys"`).

## Built-In Security & Browser Optimization Guarantees

**Zero Stitched Runtime Dependencies:** @silent-mi/core' and `@silent-mi/web` ship `0` external dependencies native pre-indexed token/stem Set's, `0`-index Damerau transpositions (f2a2fa), Pigeonhole-guarded 1-edit typo matching, branch-and-bound coverage pruning, `tbody-cached live table harvesting, and flat Int8Array cosine similarity (<1ms for 500 items).

-**Negation, Pure-Negation & Self-Negated Clause Safety:** Queries like "pause billing, do NOT delete workspace" or pure negations ("do not delete workspace"`) block destructive matches (`rejectedAsOOD: true even at 1.00 cosine), while pre-indexed clause polarity preserves self-negated policy sentences ("We do not sell, rent, or trade your personal email"`).

- **Strict CSP & Trusted Types Ready:** Zero `innerHTML`, `outerHTML, or eval across all runtime packages; scoped Light DOM [data-smi-ui="true"]' isolation for the docked Locator bar; native `CSS.highlights API for zero-DOM-mutation clause highlighting.

-**Same-Origin Route, Storage & Adapter Hardening:** Cross-page handoffs block `javascript:', 'data:`, and `// or A open-redirect vectors and re-validate restored sessionStorage matches against active RBAC/tier rules
(filterAuthorized Matches'); `LinearAdapter enforces exact baseModelSha256 pinning; HabitMemory` (` <= 1.3 KB)

stores only salted FNV-1 a hashes with zero raw query text.

-**Two-Layer RBAC Isolation:** Build-time silent-mi scan + silent-mi verify prevent restricted controls and restricted document clauses from entering manifest.public.json', `manifest.docs.json', or 'train_pairs.public.jsonl', and runtime setUserContext() purges active highlights and stepper sessions immediately on role changes.

##Quick Start - Local Verification, Packaging & Training Prep

powershell

#Build & typecheck all 4 SDK packages + sandbox

npm run build

npm run typecheck

# Audit untagged controls, scan manifests & verify 0 RBAC leaks (public + docs)

npm run suggest

npm run scan

npm run verify

# Run Golden Model & RAM Smoke Test (lexical default; pass --require-onnx on.onnx test hosts)

npm run smoke:model

#On .onnx test machine: npm run smoke:model----model bge-micro-v2 --require-onnx

#Generate customizable training workspace & validate via Python stdlib gate
nom run init:train

$env:PYTHONPATH = "python"; python -m silent_mi_trainer validate --config sandbox/demo-saas/training/silent-mi.train.json

# Run all Vitest unit tests + Playwright real-browser Microsoft Edge E2E tests

npm test

npm run test:e2e

# Export clean, test-free.tgz SDK tarballs into./release/

npm run pack:sdk

#Start interactive sandbox app (http://localhost:5173 or http://localhost:5173/?onnx=bge-micro-v2)

npm run dev

## Publishing & Sharing the SDK

**Private / Offline Sharing:** Distribute the .tgz files generated by `npm run pack:sdk in/release/` (`npm install ./silent-mi-web-0.3.0.tgz`).

- **Public npm Registry:** Run `npm publish --access public inside each packages/* directory once ready.

-**GitHub Packages:** Point `publishConfig.registry to https://npm.pkg.github.com under your GitHub org scope.

## Long-Term Extras (Parked - Out of Current Scope)

1. **Universal Browser Extension / Bookmarklet Wrapper:** Load @silent-mi onto any third-party webpage to auto-

harvest live DOM controls, headings, and policy paragraphs on the fly so everyday users can locate settings or verbatim clauses across unfamiliar websites locally.

2. **Track 2-Ultra-Tiny Hardware Micro-Intelligence (<= 1 MB RAM):** Embedded C/TFLite Micro structured intent-to-action controller (e.g., offline headset audio EQ adjustment with local user preference adaptation).
