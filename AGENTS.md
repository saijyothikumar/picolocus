#AGENTS.md-Business Logic & Architectural Context (@silent-mi`)

> Concise context for Al agents. Focuses strictly on **business logic** and **why** each architectural invariant exists-omitting standard TypeScript/monorepo details agents can infer directly.

##1. Product Thesis: "Show, Don't Chat - Guide, Don't Click"

**Zero Generative Chat / Zero Hallucination:** Users want to locate a Ul control, live table row, or verbatim policy sentence in `<10 ms, not read LLM prose. Out-of-distribution queries must return `matches: []` (`rejectedASOOD: true), never a low-confidence guess.

-**Zero Autonomous.click() or Mutations:** Highlight targets via [data-silent-mi-active="true"] and guide across closed drawers via 2-step breadcrumbs (Step 1 highlights trigger -> human clicks -> Step 2` awaits lazy SPA portals via waitForElementSelector + CSS geometry stabilization via waitForStableRect). Never programmatically .click() host controls, as apps contain destructive actions (Delete`, `Revoke`, `Refund`).

-**Negation-First Intent Gate (`packages/core/src/negation.ts`, `engine.ts'):** Standard embeddings score

"delete" and "do not delete"" nearly identically (>0.90 cosine). Split affirmative vs. negated clauses before scoring; extract negated ExactTokens" ("except #TX-903") before keyword splitting so #TX-904` is never poisoned; reject affirmative controls on pure-negation queries ("do not delete workspace" -> `rejectedAsOOD: true even at 'sem = 1.00); and pre-index clause-scoped polarity (hasSelfNegatedTerms) at load time so self-negated policy clauses ("We do not sell, rent, or trade your personal email") match without penalty.

##2. Browser Extreme Optimization ("Zero Stitched Bloat")

-**Zero External Runtime Dependencies in @silent-mi/core' & @silent-mi/web` (`~24.5 KB` gzipped):** Do not add fuzzy-search, BM25, HNSW, CSS-in-JS, or tour-overlay npm packages. Pre-indexed token/stem Set's+ `0`-index transposition (f2a` <-> `2fa') + Pigeonhole-guarded 1-edit Levenshtein + flat `Int8Array cosine (~0.04 ms for 500 items) outperform stitched libraries at a fraction of the bundle size.

-**Why Native Lexical (`searchInstant) Stays Alongside.onnx':** `computeLexicalScores is the lexical half of Hybrid Search (Lexical + .onnx Int8 Vector`), not a missing-model shim. WordPiece/BPE`.onnx subwords miss literal #TX-903 IDs, 3-char prefixes, and `0`-index acronym transpositions, while `searchInstant()` delivers < 0.5 ms keystroke-1 responsiveness while the Web Worker warms or recovers from idle RAM reaping.

- **Strict Separation of @silent-mi/onnx` & Idle Reaper:** WebAssembly/ONNX code lives exclusively behind EmbedderPlugin in packages/onnx` (`0B ML cost when unused). Inference runs in a latest-only coalesced Web Worker (LatestOnlyQueue`, `depth = 1`); `reapldleWorker()` (`120 s` default) terminates the Worker to reclaim ~60-95 MB WASM RAM while preserving transparent re-warm + DOM vector re-sync, whereas `dispose()` settles in-flight warmup promises permanently.

-**Zero Fake Hash Vectors & Fast Live Tables:** When no `.onnx model is configured, run searchinstant() only (`0`

embeddings). FNV-1a is strictly for table-status deduplication and salted 'HabitMemory` (` <= 1.3 KB` in localStorage, zero raw query text). `DomRowIndexer caches ancestor RBAC/ignore lookups per 'tbody` (`parentAuthCache) so 200-row scans stay `< 5 ms.

-**Zero DOM Mutation & Zero Focus Stealing:** Highlight verbatim clauses via native `CSS.highlights` (`Range`) -never wrap host DOM text in <mark> tags. Never steal document.active Element or mount blocking backdrops; clicking a host control calls clearVisual Highlight() while keeping Prev/Next stepper state alive.

##3. Generalization, Security & Enterprise Constraints

-**Domain-Agnostic Roles & Tiers:** Never hardcode SaaS tiers (free/pro/enterprise`) or role names (`viewer/admin') in core/web logic. Host apps pass 'tierOrder', 'entitlements`, `manifestUrls.byRole / adapterUrls.byRole`, or canAccessTier/canAccessRoles predicates; unconfigured tiers fail closed except on exact match or explicit entitlement.
- **Two-Layer RBAC & Cross-Page Handoff Isolation:** Restricted controls and restricted highlight_clause items must

never enter 'manifest.public.json', `manifest.docs.json', or 'train_pairs.public.jsonl` (`npm run verify). Container `data-mi-roles`, `data-mi-tier`, and `data-mi-tier-policy inherit across controls, live table rows, and prose clauses. Restored `sessionStorage handoffs pass through filter Authorized Matches()', and 'setUserContext() immediately purges active highlights, callouts, and stepper sessions.

-**Trusted Types CSP, Same-Origin Routes & SHA-256 Pinning:** Never use `innerHTML`, `outerHTML, or eval in

runtime packages. Validate cross-page routes via resolveSafeSameOriginUrl()`. `LinearAdapter strictly verifies baseModelSha256 with zero `-local-onnx wildcard fallback. Keep allowRemote Models = false by default and use only MIT`, `Apache-2.0`, `BSD', or 'ISC` licenses.

## 4. Why CPU LinearAdapter Over GPU Fine-Tuning

- Fine-tuning transformer weights on 50-500 Ul labels overfits and requires shipping a new 22+ MB``.onnx per tenant. silent-mi init-train + python-m silent_mi_trainer fit-adapter fit a` <= 50 KB low-rank Int8 residual projection (LinearAdapter, cryptographically pinned to baseModelSha256') on CPU in seconds, gated by stratified goldens.jsonl (Recall@1`, `MRR@5`, `0` negation violations).

##5. Verification Commands

| Check | Command |

| Build all SDK packages |

npm run build |

| Typecheck SDK + sandbox

| `npm run typecheck |

| Single unit test file | `

npx vitest run packages/core/test/engine-and-safety.test.ts |

All unit tests (Vitest) |

npm test |
| Scan & verify zero RBAC leaks | `npm run scan then `npm run verify |

| Model & RSS smoke gate | `npm run smoke:model` ( add ----model <id> --require-onnx on.onnx hosts) |

| Training scaffold & Python gate | `npm run init:train` then `$env: PYTHONPATH="python"; python-m silent_mi_trainer

validate--config sandbox/demo-saas/training/silent-mi.train.json |

| Real-browser E2E (Edge) | `npm run test:e2e` |

| Export clean `.tgz` tarballs | `npm run pack:sdk |
