#`@silent-mi``.onnx Model Drop-In, Smoke Test & Adaptation Toolkit

## 1. Dropping in Pretrained.onnx Models on Your Test System

@silent-mi/onnx` and `@silent-mi/cli run **100% self-hosted** ('allowRemoteModels = false) so corporate firewalls never block runtime execution. Both automatically prioritize 'model_quantized.onnx` (`q8') ahead of model_q4.onnx (`q4), `model_fp16.onnx` (`fp16`), and `model.onnx` (`fp32').

Recommended permissive (MIT/Apache-2.0) micro checkpoints:

-TaylorAl/bge-micro-v2` (~17 MB`q8, 384-dim -> sliced to 128-dim Int8)

Snowflake/snowflake-arctic-embed-xs` (~22 MB`q8, 384-dim -> sliced to 128-dim Int8)

minishlab/potion-base-8M (~8 MB static embedding`.onnx`, `<1ms` CPU encode)

### Step-by-Step Verification on Another System

1. Place model files under sandbox/demo-saas/public/models/<model-name>/':

text

sandbox/demo-saas/public/

models/

bge-micro-v2/

config.json

tokenizer.json

tokenizer_config.json

onnx/

model_quantized.onnx (or model.onnx)

wasm/

(copy ort-wasm-simd-threaded*.wasm from node_modules/onnxruntime-web/dist/)
2. **Run the Strict Golden Smoke-Test & Node RAM Harness (`--require-onnx'):**

powershell

npm run smoke:model ----model bge-micro-v2--require-onnx

*(Passing--require-onnx guarantees the command exits with code 1 if the .onnx binary is missing or misnamed instead of falling back to lexical-only mode.)*

3. **Compile Int8` Manifests & Test Live in Browser (with Client RAM Readout):**

- Add "modelld": "bge-micro-v2" to 'sandbox/demo-saas/silent-mi.config.json', then run `npm run scan` and `npm run verify (this also records the exact cryptographic modelSha256` inside your manifests).

- Start `npm run dev and open **`http://localhost:5173/?onnx=bge-micro-v2`**

Open **Developer Diagnostics** at the bottom of the page (and press *** Shift + Esc ** in Edge/Chrome to inspect

-exact Browser Task Manager tab + WASM RAM; after 120 s` of inactivity, the idle reaper terminates the Worker to reclaim ~60-95 MB WASM RAM and transparently re-warms on the next query).

##2. Generating Training Options & Fitting Adapters (After Base `.onnx` Testing)

You can generate the complete training workspace (silent-mi.train.json', JSON Schema, RBAC-isolated train_pairs.*.jsonl with structural hard negatives, and stratified goldens.jsonl) from your manifests:

powershell

#1. Generate training options & hard-negative pairs from manifests (Node CLI, zero Python/GPU needed)

npm run init:train

# Optional flags: --jargon path/to/jargon.csv --feedback path/to/qa.jsonl --rank 16 --loss ridge
#2. Validate generated config, public + docs RBAC isolation, false-negative guards & adapter KB size (100% Python stdlib)

$env:PYTHONPATH = "python"

python-m silent_mi_trainer validate --config sandbox/demo-saas/training/silent-mi.train.json

Once you have verified your`.onnx model on your test machine and want to adapt domain jargon:

1. **Tier 1 fit-adapter (Recommended Default - CPU-only, `<15 seconds`, ZERO GPU, ZERO`.onnx` re-

export):**

powershell

pip install -e "./python[adapter]"

silent-mi-train fit-adapter --config sandbox/demo-saas/training/silent-mi.train.json

Fits a<= 15 KB gzipped (`<= 50 KB` raw) Int8 `LinearAdapter` (`adapter.public.json + isolated

adapter.<role>.json'), pins it cryptographically to the onnx file's exact 'baseModelSha256, and refuses to overwrite if the pre/post goldens.jsont gate detects any regression or negation violation. At runtime, `@silent-mi/web` applies the adapter only when `baseModelld and baseModelSha256 match the active.onnx model.

2. **Tier 2-static-model2vec (Optional Ultra-Light Base CPU-only, `~30 seconds, ZERO GPU):** Uses Model2Vec (pip install -e "./python[static]") to distill a teacher encoder into an `< 8 MB` static subword lookup model (<1 ms query latency).

3. **Tier 3-export-onnx`/`biencoder-finetune` (Optional Advanced):** Dynamic `QUInt8 ONNX weight quantization (pip install -e "./python[export]" then 'silent-mi-train export-onnx --input model.onnx --output model_quantized.onnx') or full MatryoshkaLoss (Cached Multiple Negatives RankingLoss) training (`pip install-e "./python[biencoder]"").


