# Workspace Rules: Skill-Driven Engineering & Real-World Verification

## 1. Proactive Skill Usage, Discovery & Updates

**Always Read Skills First:** Before designing architectures, reviewing plans, or writing code, check.agents/skills/

and read both 'SKILL.md and its 'references/' files (transformers-js`, `train-sentence-transformers', hybrid-search-implementation`, `similarity-search-patterns`, `quantized-export', 'security-and-hardening`, `performance-optimization', `code-simplifier`, `agents-md', etc.). Also read [`AGENTS.md`](./AGENTS.md) for concise business logic and architectural context.

-**Acquire Missing Skills:** When introducing new algorithms, runtimes, or toolchains, search permissive (MIT/Apache-2.0) skill repositories on GitHub/skills.sh and install audited skills into`.agents/skills/.

**Continuously Update Skills:** Whenever real-world benchmarking exposes a limitation, latency bottleneck, or API change in an installed skill, update agents/skills/<skill>/ immediately so knowledge compounds.

##2. Project Architectural Invariants (@silent-mi`)

**Zero Chat/Zero Autonomous Click:** Never introduce generative text/chat Ul or autonomous `.click() / destructive

HTTP mutations into the runtime SDK.

-**Zero Fake Vectors & Fail-Closed RBAC / SHA-256:** Never generate string-hash pseudo-embeddings when.onnx is absent (0` vectors; run searchinstant() only), never leak restricted controls or doc clauses into public/docs manifests or cross-page sessionStorage handoffs, and never bypass LinearAdapter` `baseModelSha256 verification.

-**Self-Hosted/Offline-Capable Assets:** Never hardcode runtime fetches to huggingface.co` or external CDNS without local/first-party hosting support (allowLocalModels = true`, `allowRemoteModels = false by default), as enterprise firewalls (e.g., Zscaler) block external Al hubs.

-**Permissive Open-Source Only:** Only depend on MIT, Apache-2.0, BSD, or ISC licensed libraries and model checkpoints.

