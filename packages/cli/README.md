# @picolocus/cli

> Build-time HTML/TSX AST Scanner, Physical RBAC Manifest Compiler, Smoke Runner, and Golden Query Simulator for Picolocus.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](../../LICENSE)

## Features

- **AST Scanner:** Extracts developer-annotated UI controls (`data-mi-*`, `data-pico-*`) from HTML and JSX/TSX.
- **Prose Chunker:** Splits documentation and policy articles into verbatim sentence clauses.
- **Physical Manifest Isolation:** Compiles distinct, physically separated manifests (`manifest.public.json`, `manifest.docs.json`, `manifest.<role>.json`).
- **RBAC Leak Verifier:** Fails builds if restricted controls leak into public bundles.
- **Smoke & Golden Query Runner:** Evaluates accuracy, latency, and memory bounds against local ONNX checkpoints.

## Installation

```bash
npm install -D @picolocus/cli
```

## CLI Usage

Binary aliases: `picolocus`, `pico`, `silent-mi`.

```bash
# Scan source files and compile manifests
picolocus scan --config picolocus.config.json

# Verify zero RBAC leaks and valid Int8 vector bounds
picolocus verify --config picolocus.config.json

# Audit untagged interactive controls
picolocus suggest --dir src/

# Run golden query assertions
picolocus test-queries --config picolocus.config.json --queries golden-queries.json --require-onnx

# Run model and memory smoke harness
picolocus smoke --config picolocus.config.json --models-dir public/models --require-onnx
```

## License

Apache-2.0
