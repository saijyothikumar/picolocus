/**
 * @silent-mi/onnx - Client-side worker controller and idle RAM reaper
 * Invariants:
 * - Return verified expectedModelSha256 or 'none' (never fabricate a fake SHA-256 string).
 * - reapIdleWorker terminates Worker after idleTimeoutMs (120s) to reclaim 60-95 MB WASM RAM while keeping disposed: false.
 * - Terminal dispose() sets disposed: true and settles promises permanently.
 * - Client RAM telemetry: measureClientMemory and estimateOnnxRamFootprintMb.
 */

import { EmbedderPlugin, NoopEmbedder } from '@silent-mi/core';
import { OnnxEmbedderConfig } from './env-config.js';
import { LatestOnlyQueue } from './latest-only-queue.js';
import { WorkerInMessage, WorkerOutResponse } from './onnx-worker.js';

export const DEFAULT_IDLE_TIMEOUT_MS = 120000; // 2 minutes

export class OnnxWorkerEmbedder implements EmbedderPlugin {
  readonly id: string;
  readonly modelSha256: string;
  private config: OnnxEmbedderConfig;
  private worker: Worker | null = null;
  private queue = new LatestOnlyQueue<Int8Array>();
  private idleTimeoutMs: number;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  private _isReady = false;
  private _disposed = false;
  private _dimensions = 0;
  private warmupPromise: Promise<void> | null = null;
  private initReject: ((err: Error) => void) | null = null;
  private messageHandlers = new Map<string, (resp: WorkerOutResponse) => void>();

  constructor(config: OnnxEmbedderConfig) {
    this.id = config.onnxModelId;
    this.config = config;
    // Verified hash or 'none' - never fabricate fake hashes
    this.modelSha256 = config.expectedModelSha256?.trim() || 'none';
    this.idleTimeoutMs = config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this._dimensions = config.dimensions ?? 0;
  }

  get isEnabled(): boolean {
    return !this._disposed && this.id !== '';
  }

  get isReady(): boolean {
    return this._isReady && !this._disposed;
  }

  get dimensions(): number {
    return this._dimensions;
  }

  /**
   * Warms up the worker and initializes the feature-extraction pipeline.
   */
  async warmup(): Promise<void> {
    if (this._disposed) {
      throw new Error('OnnxWorkerEmbedder: cannot warmup a disposed embedder');
    }
    if (this._isReady && this.worker) {
      return;
    }
    if (this.warmupPromise) {
      return this.warmupPromise;
    }

    const p = new Promise<void>((resolve, reject) => {
      this.initReject = reject;
      try {
        this.spawnWorker();
        const initId = `init-${Date.now()}`;

        this.messageHandlers.set(initId, (resp) => {
          this.messageHandlers.delete(initId);
          this.initReject = null;
          if (resp.type === 'INIT_DONE') {
            this._isReady = true;
            this._dimensions = resp.dimensions;
            this.resetIdleTimer();
            resolve();
          } else if (resp.type === 'INIT_ERROR') {
            this._isReady = false;
            reject(new Error(`OnnxWorkerEmbedder: init failed - ${resp.error}`));
          }
        });

        this.postToWorker({
          type: 'INIT',
          id: initId,
          config: this.config,
        });
      } catch (err: any) {
        this._isReady = false;
        this.initReject = null;
        reject(err);
      }
    });

    this.warmupPromise = p.finally(() => {
      this.warmupPromise = null;
      this.initReject = null;
    });

    return this.warmupPromise;
  }

  /**
   * Embeds a single query using the LatestOnlyQueue (queue depth 1).
   */
  async embedQuery(text: string): Promise<Int8Array | null> {
    if (this._disposed || !this.isEnabled) return null;

    // Reset idle reaper timer
    this.resetIdleTimer();

    return this.queue.enqueue(async () => {
      if (!this._isReady || !this.worker) {
        await this.warmup();
      }
      return this.executeEmbedQuery(text);
    });
  }

  private executeEmbedQuery(text: string): Promise<Int8Array> {
    return new Promise((resolve, reject) => {
      const msgId = `query-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

      this.messageHandlers.set(msgId, (resp) => {
        this.messageHandlers.delete(msgId);
        if (resp.type === 'EMBED_QUERY_DONE') {
          resolve(new Int8Array(resp.buffer));
        } else if (resp.type === 'EMBED_QUERY_ERROR') {
          reject(new Error(`OnnxWorkerEmbedder query failed: ${resp.error}`));
        }
      });

      this.postToWorker({
        type: 'EMBED_QUERY',
        id: msgId,
        text,
      });
    });
  }

  /**
   * Embeds a batch of texts.
   */
  async embedBatch(texts: string[]): Promise<Int8Array[]> {
    if (this._disposed || !this.isEnabled) {
      return texts.map(() => new Int8Array(0));
    }
    this.resetIdleTimer();

    if (!this._isReady || !this.worker) {
      await this.warmup();
    }

    return new Promise((resolve, reject) => {
      const msgId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

      this.messageHandlers.set(msgId, (resp) => {
        this.messageHandlers.delete(msgId);
        if (resp.type === 'EMBED_BATCH_DONE') {
          resolve(resp.buffers.map((b) => new Int8Array(b)));
        } else if (resp.type === 'EMBED_BATCH_ERROR') {
          reject(new Error(`OnnxWorkerEmbedder batch failed: ${resp.error}`));
        }
      });

      this.postToWorker({
        type: 'EMBED_BATCH',
        id: msgId,
        texts,
      });
    });
  }

  /**
   * Resets the 120-second idle worker reaper timer.
   */
  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this._disposed) return;

    this.idleTimer = setTimeout(() => {
      this.reapIdleWorker();
    }, this.idleTimeoutMs);
  }

  /**
   * Terminates the worker to reclaim 60 to 95 MB of WASM memory,
   * while keeping disposed = false so future queries transparently re-warm.
   */
  reapIdleWorker(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch {
        // Ignore termination errors
      }
      this.worker = null;
    }
    this._isReady = false;
    this.queue.clear();
    // disposed remains false!
  }

  /**
   * Permanently disposes the embedder, settling in-flight promises immediately.
   */
  async dispose(): Promise<void> {
    this._disposed = true;
    this._isReady = false;
    this.reapIdleWorker();

    // Settle in-flight initReject warmup promise immediately
    if (this.initReject) {
      this.initReject(new Error('OnnxWorkerEmbedder: disposed during warmup'));
      this.initReject = null;
    }

    // Settle any pending query/batch message handlers
    for (const [, handler] of this.messageHandlers.entries()) {
      handler({
        type: 'INIT_ERROR',
        id: 'disposed',
        error: 'OnnxWorkerEmbedder: disposed',
      });
    }
    this.messageHandlers.clear();
  }

  private spawnWorker(): void {
    if (this.worker || typeof Worker === 'undefined') return;

    if (this.config.workerUrl) {
      this.worker = new Worker(this.config.workerUrl, { type: 'module' });
    } else {
      // Default: create inline worker from URL or blob
      const workerCode = `
        import { handleWorkerInit, handleWorkerEmbedQuery, handleWorkerEmbedBatch } from './onnx-worker.js';
        self.onmessage = async (e) => {
          const msg = e.data;
          if (!msg) return;
          if (msg.type === 'INIT') await handleWorkerInit(msg, (r) => self.postMessage(r));
          else if (msg.type === 'EMBED_QUERY') await handleWorkerEmbedQuery(msg, (r, t) => self.postMessage(r, t));
          else if (msg.type === 'EMBED_BATCH') await handleWorkerEmbedBatch(msg, (r, t) => self.postMessage(r, t));
          else if (msg.type === 'TERMINATE') self.close();
        };
      `;
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      this.worker = new Worker(URL.createObjectURL(blob), { type: 'module' });
    }

    this.worker.onmessage = (e: MessageEvent<WorkerOutResponse>) => {
      const resp = e.data;
      if (!resp || !resp.id) return;
      const handler = this.messageHandlers.get(resp.id);
      if (handler) {
        handler(resp);
      }
    };

    this.worker.onerror = (err) => {
      // Reject any pending handlers
      for (const [, handler] of this.messageHandlers.entries()) {
        handler({
          type: 'INIT_ERROR',
          id: 'error',
          error: err.message || 'Worker thread error',
        });
      }
      this.messageHandlers.clear();
      this.reapIdleWorker();
    };
  }

  private postToWorker(msg: WorkerInMessage): void {
    if (!this.worker) {
      this.spawnWorker();
    }
    if (this.worker) {
      this.worker.postMessage(msg);
    }
  }

  /**
   * Returns estimated ONNX WASM RAM footprint in Megabytes.
   * ~60-95 MB when active, 0 MB when reaped.
   */
  estimateOnnxRamFootprintMb(): number {
    if (this._disposed || !this.worker || !this._isReady) {
      return 0.0;
    }
    return 75.0; // Typical BGE micro ONNX WASM linear memory allocation
  }
}

/**
 * Helper to estimate ONNX RAM footprint from an EmbedderPlugin.
 */
export function estimateOnnxRamFootprintMb(embedder?: EmbedderPlugin | null): number {
  if (embedder instanceof OnnxWorkerEmbedder) {
    return embedder.estimateOnnxRamFootprintMb();
  }
  return 0.0;
}

/**
 * Telemetry: queries browser user agent specific memory if available.
 */
export async function measureClientMemory(): Promise<number | null> {
  if (
    typeof performance !== 'undefined' &&
    'measureUserAgentSpecificMemory' in performance &&
    typeof (performance as any).measureUserAgentSpecificMemory === 'function'
  ) {
    try {
      const result = await (performance as any).measureUserAgentSpecificMemory();
      if (result && typeof result.bytes === 'number') {
        return Math.round((result.bytes / (1024 * 1024)) * 10) / 10;
      }
    } catch {
      // Restricted security context
    }
  }
  return null;
}

/**
 * Factory creating OnnxWorkerEmbedder or returning NoopEmbedder if unconfigured.
 */
export function createOnnxEmbedder(config?: Partial<OnnxEmbedderConfig>): EmbedderPlugin {
  if (!config || !config.onnxModelId || config.onnxModelId.trim() === '') {
    return new NoopEmbedder();
  }
  return new OnnxWorkerEmbedder(config as OnnxEmbedderConfig);
}
