---
name: transformers-js
description: Offline-first WebAssembly worker architecture, mean pooling, and Int8 quantization
license: Apache-2.0
---

# Transformers.js Offline Worker Architecture

## Invariants
1. **Offline & Proxy Safe:** Set `allowLocalModels = true` and `allowRemoteModels = false` to guarantee execution behind strict enterprise firewalls (e.g. Zscaler).
2. **Web Worker Isolation:** Keep WASM execution off the main UI thread.
3. **Latest-Only Coalescing:** Use queue depth 1 so fast typing supersedes stale queued queries.
4. **Zero-Copy Transfers:** Quantize float embeddings to `Int8Array` inside the worker and transfer underlying `ArrayBuffer` directly.
5. **Idle Resource Reclamation:** Terminate worker after 120s of inactivity to release 60–95 MB WASM memory, preserving transparent re-warming on demand.
