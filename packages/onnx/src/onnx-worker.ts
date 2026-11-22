/**
 * @picolocus/onnx - WebWorker running AutoModel Matryoshka extraction off the UI thread (v1.0.4)
 * Standardized on MongoDB/mdbr-leaf-ir (256-dim Int8 Matryoshka sentence_embedding).
 * Features:
 * - Direct AutoModel/AutoTokenizer loading bypassing mean-pool corruption
 * - Asymmetric queryPrefix on 'query' vs documentPrefix on 'document'
 * - Download progress event streaming
 * - Cryptographic SHA-256 model verification
 * - In-worker Int8 quantization & zero-copy ArrayBuffer transfer
 * - CapabilityDiagnostic failure classification
 */

import { CapabilityDiagnostic, EmbedRole, quantizeFloat32ToInt8 } from '@picolocus/core';
import { configureTransformersEnv, ModelProgressEvent, OnnxEmbedderConfig } from './env-config.js';

export interface WorkerInitMessage {
  type: 'INIT';
  id: string;
  config: OnnxEmbedderConfig;
}

export interface WorkerEmbedQueryMessage {
  type: 'EMBED_QUERY';
  id: string;
  text: string;
  role?: EmbedRole;
}

export interface WorkerEmbedBatchMessage {
  type: 'EMBED_BATCH';
  id: string;
  texts: string[];
  role?: EmbedRole;
}

export interface WorkerTerminateMessage {
  type: 'TERMINATE';
}

export type WorkerInMessage =
  | WorkerInitMessage
  | WorkerEmbedQueryMessage
  | WorkerEmbedBatchMessage
  | WorkerTerminateMessage;

export interface WorkerInitDoneResponse {
  type: 'INIT_DONE';
  id: string;
  dimensions: number;
  modelSha256: string;
}

export interface WorkerProgressResponse {
  type: 'PROGRESS';
  event: ModelProgressEvent;
}

export interface WorkerErrorResponse {
  type: 'INIT_ERROR' | 'EMBED_QUERY_ERROR' | 'EMBED_BATCH_ERROR';
  id: string;
  error: string;
  code?: CapabilityDiagnostic;
}

export interface WorkerEmbedQueryResponse {
  type: 'EMBED_QUERY_DONE';
  id: string;
  buffer: ArrayBufferLike;
  scale: number;
  dimensions: number;
}

export interface WorkerEmbedBatchResponse {
  type: 'EMBED_BATCH_DONE';
  id: string;
  buffers: ArrayBufferLike[];
  scales: number[];
  dimensions: number;
}

export type WorkerOutResponse =
  | WorkerInitDoneResponse
  | WorkerProgressResponse
  | WorkerErrorResponse
  | WorkerEmbedQueryResponse
  | WorkerEmbedBatchResponse;

let tokenizer: any = null;
let model: any = null;
let modelDimensions = 256;
let modelSha256 = 'unverified';
let activeConfig: OnnxEmbedderConfig = {};

/**
 * Computes the cryptographic SHA-256 hex digest of a binary buffer.
 * Uses globalThis.crypto.subtle in modern browser workers and Node.js >= 19.
 */
export async function computeBufferSha256(data: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (
    typeof globalThis !== 'undefined' &&
    globalThis.crypto &&
    globalThis.crypto.subtle &&
    typeof globalThis.crypto.subtle.digest === 'function'
  ) {
    const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  try {
    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(bytes).digest('hex');
  } catch {
    return 'unverified';
  }
}

/**
 * Timing-safe string comparison to prevent side-channel timing leaks.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Validates a computed SHA-256 hex digest against an optional expected hash string.
 * Supports full 64-char hex, 16-char prefix, and formatted '<modelId>-sha256-<hash>' strings.
 */
export function verifyModelHash(
  computedSha256Hex: string,
  modelId: string,
  expected?: string
): { verified: boolean; formatted: string; expectedNormalized?: string } {
  if (!computedSha256Hex || computedSha256Hex === 'unverified') {
    return {
      verified: !expected || expected.trim() === '',
      formatted: 'unverified',
    };
  }
  // Expose full 64-character SHA-256 hex digest
  const formatted = `${modelId}-sha256-${computedSha256Hex}`;
  if (!expected || !expected.trim()) {
    return { verified: true, formatted };
  }
  const exp = expected.trim().toLowerCase();
  const prefix = `${modelId.toLowerCase()}-sha256-`;
  const expHex = exp.startsWith(prefix) ? exp.slice(prefix.length) : exp;
  const compHex = computedSha256Hex.toLowerCase();

  const verified =
    timingSafeEqualStr(compHex, expHex) ||
    timingSafeEqualStr(compHex.slice(0, expHex.length), expHex) ||
    timingSafeEqualStr(formatted.toLowerCase(), exp);

  return { verified, formatted, expectedNormalized: expHex };
}

// Injectable loader override for tests
let customLoader: ((config: OnnxEmbedderConfig) => Promise<{ tokenizer: any; model: any; sha256?: string }>) | null = null;

export function setTestModelLoader(loader: typeof customLoader): void {
  customLoader = loader;
}

function classifyError(err: any): CapabilityDiagnostic {
  const msg = String(err?.message || err).toLowerCase();
  if (msg.includes('wasm') || msg.includes('csp') || msg.includes('compile streaming') || msg.includes('eval')) {
    return 'csp_wasm_blocked';
  }
  if (msg.includes('network') || msg.includes('fetch') || msg.includes('failed to load') || msg.includes('offline') || msg.includes('404')) {
    return 'offline_or_fetch_failed';
  }
  if (msg.includes('quota') || msg.includes('storage') || msg.includes('out of memory')) {
    return 'quota_exceeded';
  }
  if (msg.includes('integrity') || msg.includes('sha256') || msg.includes('hash')) {
    return 'integrity_mismatch';
  }
  return 'worker_error';
}

/**
 * Initializes the model and tokenizer inside the worker.
 */
export async function handleWorkerInit(
  msg: WorkerInitMessage,
  post: (resp: WorkerOutResponse) => void
): Promise<void> {
  activeConfig = msg.config;
  const modelId = msg.config.modelId || msg.config.onnxModelId || 'mdbr-leaf-ir';
  const targetDim = msg.config.dimensions || 256;

  try {
    if (customLoader) {
      const loaded = await customLoader(msg.config);
      tokenizer = loaded.tokenizer;
      model = loaded.model;
      const loadedSha = loaded.sha256?.trim();
      const check = verifyModelHash(loadedSha || 'unverified', modelId, msg.config.expectedModelSha256);
      modelSha256 = loadedSha ? check.formatted : 'unverified';
      modelDimensions = targetDim;

      if (!check.verified) {
        model = null;
        tokenizer = null;
        post({
          type: 'INIT_ERROR',
          id: msg.id,
          error: `Model SHA-256 integrity mismatch: expected ${msg.config.expectedModelSha256}, got ${modelSha256}`,
          code: 'integrity_mismatch',
        });
        return;
      }

      post({
        type: 'INIT_DONE',
        id: msg.id,
        dimensions: modelDimensions,
        modelSha256,
      });
      return;
    }

    // Dynamic import of @huggingface/transformers
    // @ts-ignore
    const transformers: any = await import('@huggingface/transformers');
    configureTransformersEnv(transformers.env, msg.config);

    const onProgress = (p: any) => {
      if (p && p.file) {
        post({
          type: 'PROGRESS',
          event: {
            type: 'progress',
            file: p.file,
            loaded: p.loaded || 0,
            total: p.total || 0,
            percent: Math.round(((p.loaded || 0) / (p.total || 1)) * 100),
          },
        });
      }
    };

    const loadOptions: any = {
      progress_callback: onProgress,
    };

    // Prefer q4 for mdbr-leaf models with auto-fallback
    if (modelId.includes('mdbr-leaf') || modelId.includes('leaf')) {
      loadOptions.dtype = 'q4';
    } else {
      loadOptions.quantized = true;
    }

    tokenizer = await transformers.AutoTokenizer.from_pretrained(modelId, loadOptions);

    try {
      model = await transformers.AutoModel.from_pretrained(modelId, loadOptions);
    } catch (loadErr) {
      if (msg.config.autoFallbackDtype !== false) {
        // Fallback across q8/quantized and fp32
        loadOptions.dtype = 'q8';
        try {
          model = await transformers.AutoModel.from_pretrained(modelId, loadOptions);
        } catch {
          loadOptions.dtype = 'fp32';
          model = await transformers.AutoModel.from_pretrained(modelId, loadOptions);
        }
      } else {
        throw loadErr;
      }
    }

    // Only fetch candidate weights to compute cryptographic SHA-256 if expectedModelSha256 was explicitly requested
    let computedHex: string | null = null;
    if (msg.config.expectedModelSha256 && msg.config.localModelPath) {
      const basePath = msg.config.localModelPath.replace(/\/+$/, '');
      const candidates = ['onnx/model_q4.onnx', 'model_q4.onnx', 'onnx/model_quantized.onnx', 'model_quantized.onnx', 'model.onnx'];
      if (typeof fetch === 'function') {
        for (const cand of candidates) {
          try {
            const url = `${basePath}/${cand}`;
            const res = await fetch(url);
            if (res.ok) {
              const buf = await res.arrayBuffer();
              computedHex = await computeBufferSha256(buf);
              break;
            }
          } catch {
            // Try next candidate
          }
        }
      }

      if (!computedHex) {
        try {
          const { existsSync, readFileSync } = await import('node:fs');
          const { join } = await import('node:path');
          for (const cand of candidates) {
            const p = join(basePath, cand);
            if (existsSync(p)) {
              const buf = readFileSync(p);
              computedHex = await computeBufferSha256(buf);
              break;
            }
          }
        } catch {
          // Node fs not available or file not found
        }
      }
    }

    const check = verifyModelHash(computedHex || 'unverified', modelId, msg.config.expectedModelSha256);
    modelSha256 = computedHex ? check.formatted : 'unverified';
    modelDimensions = targetDim;

    if (!check.verified) {
      model = null;
      tokenizer = null;
      post({
        type: 'INIT_ERROR',
        id: msg.id,
        error: `Model SHA-256 integrity mismatch: expected ${msg.config.expectedModelSha256}, got ${modelSha256}`,
        code: 'integrity_mismatch',
      });
      return;
    }

    post({
      type: 'INIT_DONE',
      id: msg.id,
      dimensions: modelDimensions,
      modelSha256,
    });
  } catch (err: any) {
    post({
      type: 'INIT_ERROR',
      id: msg.id,
      error: err?.message || String(err),
      code: classifyError(err),
    });
  }
}

function applyPrefix(text: string, role: EmbedRole, config: OnnxEmbedderConfig): string {
  const modelId = (config.modelId || config.onnxModelId || '').toLowerCase();
  const isAsymmetric =
    modelId.includes('mdbr-leaf') ||
    modelId.includes('leaf') ||
    modelId.includes('arctic-embed') ||
    modelId.includes('bge');

  if (role === 'query') {
    if (config.queryPrefix !== undefined) {
      return config.queryPrefix + text;
    }
    if (isAsymmetric) {
      return 'Represent this sentence for searching relevant passages: ' + text;
    }
    return text;
  }

  // Document role
  const docPrefix = config.documentPrefix ?? '';
  return docPrefix ? docPrefix + text : text;
}

/**
 * Runs feature extraction, in-worker Int8 quantization, and returns zero-copy buffer.
 */
export async function handleWorkerEmbedQuery(
  msg: WorkerEmbedQueryMessage,
  post: (resp: WorkerOutResponse, transfer: Transferable[]) => void
): Promise<void> {
  if (!model || !tokenizer) {
    post(
      {
        type: 'EMBED_QUERY_ERROR',
        id: msg.id,
        error: 'ONNX model or tokenizer not initialized',
        code: 'worker_error',
      },
      []
    );
    return;
  }

  try {
    const role: EmbedRole = msg.role || 'query';
    const textWithPrefix = applyPrefix(msg.text, role, activeConfig);
    const maxLength = activeConfig.maxLength || 64;

    const inputs = await tokenizer(textWithPrefix, {
      padding: true,
      truncation: true,
      max_length: maxLength,
    });

    const outputs = await model(inputs);

    // Extract outputs.sentence_embedding (Matryoshka 2_Dense) or fall back to masked mean pool
    let embedding: Float32Array;
    if (outputs.sentence_embedding) {
      embedding = new Float32Array(outputs.sentence_embedding.data || outputs.sentence_embedding);
    } else if (outputs.last_hidden_state) {
      embedding = maskedMeanPool(outputs.last_hidden_state, inputs.attention_mask);
    } else {
      embedding = new Float32Array(outputs.data || outputs);
    }

    // Slice to target dimensions
    const sliced = embedding.length > modelDimensions ? embedding.slice(0, modelDimensions) : embedding;
    const { int8, scale } = quantizeFloat32ToInt8(sliced);

    post(
      {
        type: 'EMBED_QUERY_DONE',
        id: msg.id,
        buffer: int8.buffer,
        scale,
        dimensions: int8.length,
      },
      [int8.buffer as ArrayBuffer]
    );
  } catch (err: any) {
    post(
      {
        type: 'EMBED_QUERY_ERROR',
        id: msg.id,
        error: err?.message || String(err),
        code: classifyError(err),
      },
      []
    );
  }
}

/**
 * Runs batch feature extraction with zero-copy buffer transfers.
 */
export async function handleWorkerEmbedBatch(
  msg: WorkerEmbedBatchMessage,
  post: (resp: WorkerOutResponse, transfer: Transferable[]) => void
): Promise<void> {
  if (!model || !tokenizer) {
    post(
      {
        type: 'EMBED_BATCH_ERROR',
        id: msg.id,
        error: 'ONNX model or tokenizer not initialized',
        code: 'worker_error',
      },
      []
    );
    return;
  }

  try {
    const role: EmbedRole = msg.role || 'document';
    const buffers: ArrayBufferLike[] = [];
    const scales: number[] = [];
    const maxLength = activeConfig.maxLength || 64;

    for (const text of msg.texts) {
      const textWithPrefix = applyPrefix(text, role, activeConfig);
      const inputs = await tokenizer(textWithPrefix, {
        padding: true,
        truncation: true,
        max_length: maxLength,
      });

      const outputs = await model(inputs);
      let embedding: Float32Array;
      if (outputs.sentence_embedding) {
        embedding = new Float32Array(outputs.sentence_embedding.data || outputs.sentence_embedding);
      } else if (outputs.last_hidden_state) {
        embedding = maskedMeanPool(outputs.last_hidden_state, inputs.attention_mask);
      } else {
        embedding = new Float32Array(outputs.data || outputs);
      }

      const sliced = embedding.length > modelDimensions ? embedding.slice(0, modelDimensions) : embedding;
      const { int8, scale } = quantizeFloat32ToInt8(sliced);
      buffers.push(int8.buffer);
      scales.push(scale);
    }

    post(
      {
        type: 'EMBED_BATCH_DONE',
        id: msg.id,
        buffers,
        scales,
        dimensions: buffers[0]?.byteLength || modelDimensions,
      },
      buffers as Transferable[]
    );
  } catch (err: any) {
    post(
      {
        type: 'EMBED_BATCH_ERROR',
        id: msg.id,
        error: err?.message || String(err),
        code: classifyError(err),
      },
      []
    );
  }
}

function maskedMeanPool(lastHiddenState: any, attentionMask: any): Float32Array {
  const data = lastHiddenState.data || lastHiddenState;
  const dims = lastHiddenState.dims || [1, data.length / 384, 384];
  const hiddenSize = dims[2] || 384;
  const seqLen = dims[1] || 1;

  const maskData = attentionMask?.data || attentionMask || new Array(seqLen).fill(1);
  const pooled = new Float32Array(hiddenSize);
  let maskSum = 0;

  for (let s = 0; s < seqLen; s++) {
    const m = maskData[s] ? 1 : 0;
    if (m === 0) continue;
    maskSum += 1;
    const offset = s * hiddenSize;
    for (let h = 0; h < hiddenSize; h++) {
      pooled[h] = (pooled[h] ?? 0) + (data[offset + h] ?? 0);
    }
  }

  if (maskSum > 0) {
    for (let h = 0; h < hiddenSize; h++) {
      pooled[h] = (pooled[h] ?? 0) / maskSum;
    }
  }

  return pooled;
}

// In dedicated worker global scope (supporting both ES module and classic workers), attach onmessage handler
if (
  typeof self !== 'undefined' &&
  typeof (self as any).postMessage === 'function' &&
  typeof window === 'undefined'
) {
  self.onmessage = async (e: MessageEvent<WorkerInMessage>) => {
    const msg = e.data;
    if (!msg) return;

    if (msg.type === 'INIT') {
      await handleWorkerInit(msg, (resp) => (self as any).postMessage(resp));
    } else if (msg.type === 'EMBED_QUERY') {
      await handleWorkerEmbedQuery(msg, (resp, transfer) =>
        (self as any).postMessage(resp, transfer)
      );
    } else if (msg.type === 'EMBED_BATCH') {
      await handleWorkerEmbedBatch(msg, (resp, transfer) =>
        (self as any).postMessage(resp, transfer)
      );
    } else if (msg.type === 'TERMINATE') {
      (self as any).close();
    }
  };
}
