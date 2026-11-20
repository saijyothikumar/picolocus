# Workspace Rules: Skill-Driven Engineering & Real-World Verification

## 1. Proactive Skill Usage, Discovery & Updates

- **Always Read Skills First:** Before designing architectures, reviewing plans, or writing code, check `.agents/skills/` and read both `SKILL.md` and its `references/` files (`transformers-js`, `hybrid-search-implementation`, `security-and-hardening`, etc.). Also read [`AGENTS.md`](./AGENTS.md) for concise business logic and architectural context.
- **Acquire Missing Skills:** When introducing new algorithms, runtimes, or toolchains, search permissive (MIT/Apache-2.0) skill repositories on GitHub/skills.sh and install audited skills into `.agents/skills/`.
- **Continuously Update Skills:** Whenever real-world benchmarking exposes a limitation, latency bottleneck, or API change in an installed skill, update `.agents/skills/<skill>/` immediately so knowledge compounds.

## 2. Project Architectural Invariants (Picolocus v1.0.0)

- **Zero Chat / Zero Autonomous Click:** Never introduce generative text/chat UI or autonomous `.click()` / destructive HTTP mutations into the runtime SDK.
- **Explicit Business Consent & Zero Fake Vectors:** 0 model downloads, WASM allocations, or network requests prior to explicit opt-in consent (`controller.grantConsent()`). When `.onnx` is absent, run `searchInstant()` only (`0` embeddings; never generate fake string-hash vectors).
- **Fail-Closed RBAC & Physical Manifest Isolation:** Never leak restricted controls or doc clauses into public/docs manifests or cross-page `sessionStorage` handoffs.
- **Self-Hosted & Offline-Capable Assets:** Never hardcode runtime fetches to external CDNs without local hosting support (`allowLocalModels = true`, `allowRemoteModels = false` by default).
- **Permissive Open-Source Only:** Only depend on MIT, Apache-2.0, BSD, or ISC licensed libraries and model checkpoints.
