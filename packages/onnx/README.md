# @picolocus/onnx

> Optional WebWorker ONNX Embedder Plugin with explicit business consent and 120s tab-sleep idle RAM reaper for Picolocus.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](../../LICENSE)

## Features

- **Off-Thread Neural Embeddings:** Runs Transformers.js in an isolated WebWorker off the UI thread.
- **Explicit Business Consent:** 0 network requests, 0 model downloads, and 0 WASM allocations prior to explicit consent.
- **120s Idle Reaper:** Automatically terminates the Worker after 120s idle (or 15s in background tabs) to reclaim ~60-95 MB of WASM RAM.
- **Client Memory Profiling:** Native `measureClientMemory` integration to monitor real-time heap usage.

## Installation

```bash
npm install @picolocus/onnx
```

*Peer dependency: `@huggingface/transformers`.*

## Quick Start

```typescript
import { initPicolocus } from '@picolocus/web';
import { createOnnxEmbedder } from '@picolocus/onnx';

const embedder = createOnnxEmbedder({
  modelId: 'mdbr-leaf-ir',
  localModelPath: '/models/mdbr-leaf-ir',
  idleTimeoutMs: 120000,
});

const pico = await initPicolocus({
  embedder,
  manifestUrls: { public: '/manifests/manifest.public.json' },
});

// Explicit consent gate
await pico.grantConsent();
```

## License

Apache-2.0
