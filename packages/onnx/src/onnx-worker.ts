/**
 * @silent-mi/onnx - WebWorker running feature-extraction off the main UI thread
 * Features:
 * - Offline pipeline configuration
 * - Mean pooling and L2 normalization
 * - In-worker Int8 quantization
 * - Zero-copy ArrayBuffer transfer
 */

import { quantizeFloat32ToInt8 } from '@silent-mi/core';
import { configureTransformersEnv, OnnxEmbedderConfig } from './env-config.js';

export interface WorkerInitMessage {
  type: 'INIT';
  id: string;
  config: OnnxEmbedderConfig;
}

export interface WorkerEmbedQueryMessage {
  type: 'EMBED_QUERY';
  id: string;
  text: string;
}

export interface WorkerEmbedBatchMessage {
  type: 'EMBED_BATCH';
  id: string;
  texts: string[];
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
}

export interface WorkerErrorResponse {
  type: 'INIT_ERROR' | 'EMBED_QUERY_ERROR' | 'EMBED_BATCH_ERROR';
  id: string;
  error: string;
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
  | WorkerErrorResponse
  | WorkerEmbedQueryResponse
  | WorkerEmbedBatchResponse;

let extractor: any = null;
let modelDimensions = 0;

/**
 * Initializes the feature extraction pipeline inside the worker.
 */
export async function handleWorkerInit(
  msg: WorkerInitMessage,
  post: (resp: WorkerOutResponse) => void
): Promise<void> {
  try {
    // Dynamically import optional peer dependency
    // @ts-ignore
    const transformers: any = await import('@huggingface/transformers');
    configureTransformersEnv(transformers.env, msg.config);

    extractor = await transformers.pipeline('feature-extraction', msg.config.onnxModelId, {
      quantized: true,
      progress_callback: undefined,
    });

    // Warm up and detect dimensions
    const testOut = await extractor('test', { pooling: 'mean', normalize: true });
    modelDimensions = testOut.data.length;

    post({
      type: 'INIT_DONE',
      id: msg.id,
      dimensions: modelDimensions,
    });
  } catch (err: any) {
    post({
      type: 'INIT_ERROR',
      id: msg.id,
      error: err?.message || String(err),
    });
  }
}

/**
 * Runs feature extraction, in-worker Int8 quantization, and returns zero-copy buffer.
 */
export async function handleWorkerEmbedQuery(
  msg: WorkerEmbedQueryMessage,
  post: (resp: WorkerOutResponse, transfer: Transferable[]) => void
): Promise<void> {
  if (!extractor) {
    post(
      {
        type: 'EMBED_QUERY_ERROR',
        id: msg.id,
        error: 'ONNX extractor not initialized',
      },
      []
    );
    return;
  }

  try {
    const output = await extractor(msg.text, { pooling: 'mean', normalize: true });
    const floats = new Float32Array(output.data);
    const { int8, scale } = quantizeFloat32ToInt8(floats);

    // Transfer underlying ArrayBuffer zero-copy
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
      },
      []
    );
  }
}

/**
 * Runs batch feature extraction.
 */
export async function handleWorkerEmbedBatch(
  msg: WorkerEmbedBatchMessage,
  post: (resp: WorkerOutResponse, transfer: Transferable[]) => void
): Promise<void> {
  if (!extractor) {
    post(
      {
        type: 'EMBED_BATCH_ERROR',
        id: msg.id,
        error: 'ONNX extractor not initialized',
      },
      []
    );
    return;
  }

  try {
    const buffers: ArrayBufferLike[] = [];
    const scales: number[] = [];

    for (const text of msg.texts) {
      const output = await extractor(text, { pooling: 'mean', normalize: true });
      const floats = new Float32Array(output.data);
      const { int8, scale } = quantizeFloat32ToInt8(floats);
      buffers.push(int8.buffer);
      scales.push(scale);
    }

    post(
      {
        type: 'EMBED_BATCH_DONE',
        id: msg.id,
        buffers,
        scales,
        dimensions: buffers[0]?.byteLength || 0,
      },
      buffers as Transferable[]
    );
  } catch (err: any) {
    post(
      {
        type: 'EMBED_BATCH_ERROR',
        id: msg.id,
        error: err?.message || String(err),
      },
      []
    );
  }
}

// In dedicated worker global scope, attach onmessage handler
if (typeof self !== 'undefined' && typeof (self as any).importScripts === 'function') {
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
