# @picolocus/core

> Zero-dependency hybrid search engine, negation-first intent gate, Int8 quantization, and declarative playbooks for Picolocus.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](../../LICENSE)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](#)

## Features

- **Negation-First Intent Gate:** Splits affirmative and negated clauses to avoid false matches (e.g. "do not delete" never highlights a "Delete" button).
- **Hybrid Scoring:** Blends keystroke-1 instant lexical search with flat `Int8Array` cosine similarity.
- **Declarative Playbooks:** State-dependent UI routing evaluated in `<0.02 ms` with zero `eval`.
- **Domain-Agnostic RBAC:** Generalized roles and tiers without hardcoded strings.
- **Zero Dependencies:** Pure TypeScript compiling to lightweight JS.

## Installation

```bash
npm install @picolocus/core
```

## Quick Start

```typescript
import { SilentMIEngine, PicolocusEngine } from '@picolocus/core';

const engine = new PicolocusEngine({
  calibration: {
    minConfidence: 0.29,
    oodSemanticFloor: 0.44,
  },
});

// Load compiled manifest
await engine.loadManifests({
  public: '/manifests/manifest.public.json',
});

// Synchronous keystroke-1 instant search (<0.5 ms)
const instantResponse = engine.searchInstant('export audit logs');
```

## License

Apache-2.0
