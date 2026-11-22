/**
 * @picolocus/onnx - Transformers.js offline environment configuration (v1.0.2)
 * Invariant: allowLocalModels = true, allowRemoteModels = false (corporate proxy & Zscaler safety).
 * Standardized on MongoDB/mdbr-leaf-ir (q4 ONNX + single-threaded WASM).
 */

export interface ModelProgressEvent {
  type: 'progress';
  file: string;
  loaded: number;
  total: number;
  percent: number;
}

export interface OnnxEmbedderConfig {
  modelId?: string;
  onnxModelId?: string;
  localModelPath?: string;
  wasmPath?: string;
  expectedModelSha256?: string;
  idleTimeoutMs?: number;
  hiddenReapDelayMs?: number;
  dimensions?: number;
  maxLength?: number;
  workerUrl?: string | URL;
  consentMode?: 'opt-in' | 'lazy' | 'eager';
  consentGranted?: boolean;
  queryPrefix?: string;
  documentPrefix?: string;
  autoFallbackDtype?: boolean;
  onModelProgress?: (event: ModelProgressEvent) => void;
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
