---
name: security-and-hardening
description: Runtime security, CSP/Trusted Types compliance, and prototype pollution defense
license: MIT
---

# Security and Hardening

## Invariants
1. **Zero Dynamic HTML:** Never use `innerHTML`, `outerHTML`, `insertAdjacentHTML`, or `eval`. Construct all nodes using `createElement` and `textContent`.
2. **Safe Navigation URLs:** Validate cross-page URLs against strict same-origin rules; reject `javascript:`, `data:`, `vbscript:`, protocol-relative `//`, and `/\`.
3. **Storage Sanitization:** Parse JSON using `Object.create(null)` dictionaries and strip `__proto__`, `constructor`, and `prototype` keys.
4. **Physical RBAC Separation:** Restricted items must never enter public manifests or public training pairs.
5. **Cryptographic Pinning:** Linear adapters must verify exact SHA-256 base model hashes without wildcard fallbacks.
