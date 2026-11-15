/**
 * @silent-mi/onnx - Transformers.js offline environment configuration
 * Invariant: allowLocalModels = true, allowRemoteModels = false (corporate proxy & Zscaler safety).
 */

export interface OnnxEmbedderConfig {
  onnxModelId: string;
  localModelPath?: string;
  wasmPath?: string;
  expectedModelSha256?: string;
  idleTimeoutMs?: number;
  dimensions?: number;
  workerUrl?: string | URL;
}

export function configureTransformersEnv(
  transformersEnv: any,
  config: Partial<OnnxEmbedderConfig> = {}
): void {
  if (!transformersEnv) return;

  // Enforce 100% offline self-hosted execution
  transformersEnv.allowLocalModels = true;
  transformersEnv.allowRemoteModels = false;
  transformersEnv.useBrowserCache = true;

  if (config.localModelPath) {
    transformersEnv.localModelPath = config.localModelPath;
  }

  if (!transformersEnv.backends) {
    transformersEnv.backends = {};
  }
  if (!transformersEnv.backends.onnx) {
    transformersEnv.backends.onnx = {};
  }
  if (!transformersEnv.backends.onnx.wasm) {
    transformersEnv.backends.onnx.wasm = {};
  }

  // Single-threaded WASM for broad browser compatibility and zero thread contention
  transformersEnv.backends.onnx.wasm.numThreads = 1;

  if (config.wasmPath) {
    transformersEnv.backends.onnx.wasm.wasmPaths = config.wasmPath;
  }
}
