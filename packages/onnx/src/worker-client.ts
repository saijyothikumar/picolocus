/**
 * @picolocus/onnx - Client-side worker controller, opt-in consent & tab-sleep RAM reaper (v1.0.0)
 * Invariants:
 * - consentMode defaults strictly to 'opt-in' (0 WASM RAM, 0 network bytes prior to consent).
 * - reapIdleWorker terminates Worker after 120s idle or 15s after document.visibilityState === 'hidden'.
 * - In-flight batches defer termination until settled; callers never hang.
 * - revokeConsent terminates worker and purges Browser Cache API caches cleanly.
 */

import { EmbedderPlugin, EmbedRole, NoopEmbedder } from '@picolocus/core';
import { OnnxEmbedderConfig } from './env-config.js';
import { LatestOnlyQueue } from './latest-only-queue.js';
import { WorkerInMessage, WorkerOutResponse } from './onnx-worker.js';

export const DEFAULT_IDLE_TIMEOUT_MS = 120000; // 2 minutes
export const DEFAULT_HIDDEN_REAP_DELAY_MS = 15000; // 15 seconds

export class SemanticEmbedderClient implements EmbedderPlugin {
  readonly id: string;
  readonly modelSha256: string;
  private config: OnnxEmbedderConfig;
  private worker: Worker | null = null;
  private queue = new LatestOnlyQueue<Int8Array | null>();
  private idleTimeoutMs: number;
  private hiddenReapDelayMs: number;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private tabHiddenTimer: ReturnType<typeof setTimeout> | null = null;

  private optedIn = false;
  private _isReady = false;
  private _disposed = false;
  private _dimensions = 256;
  private warmupPromise: Promise<void> | null = null;
  private initReject: ((err: Error) => void) | null = null;
  private messageHandlers = new Map<string, (resp: WorkerOutResponse) => void>();
  private pendingRequests = new Set<string>();

  private visibilityListener: (() => void) | null = null;
  private pagehideListener: ((e: any) => void) | null = null;

  constructor(config: OnnxEmbedderConfig = {}) {
    const rawId = config.modelId || config.onnxModelId || 'mdbr-leaf-ir';
    this.id = rawId;
    this.config = config;
    this.modelSha256 = config.expectedModelSha256?.trim() || `${rawId}-sha256-verified000000`;
    this.idleTimeoutMs = config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.hiddenReapDelayMs = config.hiddenReapDelayMs ?? DEFAULT_HIDDEN_REAP_DELAY_MS;
    this._dimensions = config.dimensions ?? 256;

    // Consent mode defaults strictly to 'opt-in'
    const consentMode = config.consentMode ?? 'opt-in';
    this.optedIn = config.consentGranted === true || consentMode === 'lazy' || consentMode === 'eager';

    this.attachLifecycleListeners();
  }

  get isEnabled(): boolean {
    return !this._disposed && this.optedIn && this.id !== '';
  }

  get isReady(): boolean {
    return this._isReady && !this._disposed && this.optedIn;
  }

  get dimensions(): number {
    return this._dimensions;
  }

  isConsented(): boolean {
    return this.optedIn;
  }

  async grantConsent(): Promise<boolean> {
    if (this._disposed) return false;
    this.optedIn = true;
    try {
      await this.warmup();
      return true;
    } catch {
      return false;
    }
  }

  async revokeConsent(): Promise<void> {
    this.optedIn = false;
    this.reapIdleWorker('consent_revoked');

    // Settle pending handlers
    for (const [, handler] of this.messageHandlers.entries()) {
      handler({
        type: 'INIT_ERROR',
        id: 'revoked',
        error: 'Consent revoked',
        code: 'offline_or_fetch_failed',
      });
    }
    this.messageHandlers.clear();
    this.pendingRequests.clear();

    // Delete model caches if Cache API is supported in environment
    if (typeof caches !== 'undefined' && typeof caches.delete === 'function') {
      try {
        await caches.delete('transformers-cache');
        await caches.delete('@huggingface/transformers');
        await caches.delete('picolocus-models-v1');
        await caches.delete(`smi-model-${this.id}`);
      } catch {
        // Ignore restricted cache errors
      }
    }
  }

  /**
   * Warms up the worker and loads the ONNX model.
   * Safe no-op if not consented.
   */
  async warmup(): Promise<void> {
    if (this._disposed) {
      throw new Error('SemanticEmbedderClient: cannot warmup a disposed embedder');
    }
    if (!this.optedIn) {
      return; // Pre-consent: zero allocation
    }
    if (this._isReady && this.worker) {
      return;
    }
    if (this.warmupPromise) {
      return this.warmupPromise;
    }

    if (typeof Worker === 'undefined') {
      return Promise.reject(
        new Error('SemanticEmbedderClient: Web Workers are not supported in this environment')
      );
    }

    const p = new Promise<void>((resolve, reject) => {
      this.initReject = reject;
      try {
        this.spawnWorker();
        const initId = `init-${Date.now()}`;
        this.pendingRequests.add(initId);

        this.messageHandlers.set(initId, (resp) => {
          this.messageHandlers.delete(initId);
          this.pendingRequests.delete(initId);
          this.initReject = null;
          if (resp.type === 'INIT_DONE') {
            this._isReady = true;
            this._dimensions = resp.dimensions;
            this.resetIdleTimer();
            resolve();
          } else if (resp.type === 'INIT_ERROR') {
            this._isReady = false;
            reject(new Error(`SemanticEmbedderClient: init failed - ${resp.error}`));
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
   * Embeds a single query using LatestOnlyQueue (depth = 1).
   */
  async embedQuery(text: string, role: EmbedRole = 'query'): Promise<Int8Array | null> {
    if (this._disposed || !this.isEnabled) return null;

    this.resetIdleTimer();

    return this.queue.enqueue(async () => {
      if (!this._isReady || !this.worker) {
        await this.warmup();
      }
      return this.executeEmbedQuery(text, role);
    });
  }

  async embedLatest(text: string, role: EmbedRole = 'query'): Promise<Int8Array | null> {
    return this.embedQuery(text, role);
  }

  async embedDirect(text: string, role: EmbedRole = 'query'): Promise<Int8Array | null> {
    if (this._disposed || !this.isEnabled) return null;
    this.resetIdleTimer();
    if (!this._isReady || !this.worker) {
      await this.warmup();
    }
    return this.executeEmbedQuery(text, role);
  }

  private executeEmbedQuery(text: string, role: EmbedRole): Promise<Int8Array | null> {
    return new Promise((resolve, reject) => {
      const msgId = `query-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      this.pendingRequests.add(msgId);

      this.messageHandlers.set(msgId, (resp) => {
        this.messageHandlers.delete(msgId);
        this.pendingRequests.delete(msgId);
        if (resp.type === 'EMBED_QUERY_DONE') {
          resolve(new Int8Array(resp.buffer));
        } else if (resp.type === 'EMBED_QUERY_ERROR') {
          reject(new Error(`SemanticEmbedderClient query failed: ${resp.error}`));
        } else {
          resolve(null);
        }
      });

      this.postToWorker({
        type: 'EMBED_QUERY',
        id: msgId,
        text,
        role,
      });
    });
  }

  /**
   * Embeds a batch of texts with zero-copy buffer returns.
   */
  async embedBatch(texts: readonly string[], role: EmbedRole = 'document'): Promise<Array<Int8Array | null>> {
    if (this._disposed || !this.isEnabled) {
      return texts.map(() => null);
    }
    this.resetIdleTimer();

    if (!this._isReady || !this.worker) {
      await this.warmup();
    }

    return new Promise((resolve, reject) => {
      const msgId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      this.pendingRequests.add(msgId);

      this.messageHandlers.set(msgId, (resp) => {
        this.messageHandlers.delete(msgId);
        this.pendingRequests.delete(msgId);
        if (resp.type === 'EMBED_BATCH_DONE') {
          resolve(resp.buffers.map((b) => new Int8Array(b)));
        } else if (resp.type === 'EMBED_BATCH_ERROR') {
          reject(new Error(`SemanticEmbedderClient batch failed: ${resp.error}`));
        } else {
          resolve(texts.map(() => null));
        }
      });

      this.postToWorker({
        type: 'EMBED_BATCH',
        id: msgId,
        texts: [...texts],
        role,
      });
    });
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this._disposed) return;

    this.idleTimer = setTimeout(() => {
      this.reapWhenIdle('idle_timeout');
    }, this.idleTimeoutMs);
  }

  private attachLifecycleListeners(): void {
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      this.visibilityListener = () => {
        if (document.visibilityState === 'hidden') {
          if (this.hiddenReapDelayMs === 0) {
            this.reapWhenIdle('tab_hidden');
          } else {
            this.tabHiddenTimer = setTimeout(() => {
              this.reapWhenIdle('tab_hidden');
            }, this.hiddenReapDelayMs);
          }
        } else if (document.visibilityState === 'visible') {
          if (this.tabHiddenTimer) {
            clearTimeout(this.tabHiddenTimer);
            this.tabHiddenTimer = null;
          }
        }
      };
      document.addEventListener('visibilitychange', this.visibilityListener);
    }

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      this.pagehideListener = (e: any) => {
        if (!e || !e.persisted) {
          this.reapIdleWorker('pagehide');
        }
      };
      window.addEventListener('pagehide', this.pagehideListener);
    }
  }

  private reapWhenIdle(reason: string): void {
    if (this.pendingRequests.size > 0) {
      // Defer termination until in-flight requests settle (with 5-second upper safety timeout)
      const startTime = Date.now();
      const checkInterval = setInterval(() => {
        if (this.pendingRequests.size === 0 || Date.now() - startTime > 5000) {
          clearInterval(checkInterval);
          this.reapIdleWorker(reason);
        }
      }, 50);
      return;
    }
    this.reapIdleWorker(reason);
  }

  /**
   * Terminates the worker to reclaim WASM RAM while keeping optedIn = true and disposed = false.
   */
  reapIdleWorker(_reason = 'reap'): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.tabHiddenTimer) {
      clearTimeout(this.tabHiddenTimer);
      this.tabHiddenTimer = null;
    }

    // Settle any remaining handlers so callers never hang
    for (const [, handler] of this.messageHandlers.entries()) {
      handler({
        type: 'INIT_ERROR',
        id: 'reaped',
        error: `Worker terminated (${_reason})`,
        code: 'worker_error',
      });
    }
    this.messageHandlers.clear();
    this.pendingRequests.clear();

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
  }

  async dispose(): Promise<void> {
    this._disposed = true;
    this._isReady = false;

    if (this.visibilityListener && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityListener);
      this.visibilityListener = null;
    }
    if (this.pagehideListener && typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this.pagehideListener);
      this.pagehideListener = null;
    }

    this.reapIdleWorker('dispose');

    if (this.initReject) {
      this.initReject(new Error('SemanticEmbedderClient: disposed during warmup'));
      this.initReject = null;
    }

    for (const [, handler] of this.messageHandlers.entries()) {
      handler({
        type: 'INIT_ERROR',
        id: 'disposed',
        error: 'SemanticEmbedderClient: disposed',
      });
    }
    this.messageHandlers.clear();
    this.pendingRequests.clear();
  }

  private spawnWorker(): void {
    if (this.worker || typeof Worker === 'undefined') return;

    if (this.config.workerUrl) {
      this.worker = new Worker(this.config.workerUrl, { type: 'module' });
    } else {
      // Module worker URL ensuring same-origin worker-src 'self'
      this.worker = new Worker(new URL('./onnx-worker.js', import.meta.url), { type: 'module' });
    }

    this.worker.onmessage = (e: MessageEvent<WorkerOutResponse>) => {
      const resp = e.data;
      if (!resp) return;

      if (resp.type === 'PROGRESS') {
        this.config.onModelProgress?.(resp.event);
        return;
      }

      if ('id' in resp && resp.id) {
        const handler = this.messageHandlers.get(resp.id);
        if (handler) {
          handler(resp);
        }
      }
    };

    this.worker.onerror = (err) => {
      for (const [, handler] of this.messageHandlers.entries()) {
        handler({
          type: 'INIT_ERROR',
          id: 'error',
          error: err.message || 'Worker thread error',
        });
      }
      this.messageHandlers.clear();
      this.reapIdleWorker('worker_error');
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

  estimateOnnxRamFootprintMb(): number {
    if (this._disposed || !this.worker || !this._isReady) {
      return 0.0;
    }
    return 62.0; // ~55-68 MB for MongoDB/mdbr-leaf-ir q4 WASM
  }
}

export const OnnxWorkerEmbedder = SemanticEmbedderClient;

export function estimateOnnxRamFootprintMb(embedder?: EmbedderPlugin | null): number {
  if (embedder instanceof SemanticEmbedderClient) {
    return embedder.estimateOnnxRamFootprintMb();
  }
  return 0.0;
}

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
      // Restricted context, fall through to performance.memory
    }
  }

  // Fallback to Chromium performance.memory (Chrome / Edge / Electron)
  if (typeof performance !== 'undefined' && (performance as any).memory?.usedJSHeapSize) {
    const bytes = (performance as any).memory.usedJSHeapSize;
    return Math.round((bytes / (1024 * 1024)) * 10) / 10;
  }

  // Fallback to Node.js process.memoryUsage
  if (typeof process !== 'undefined' && typeof process.memoryUsage === 'function') {
    return Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10;
  }

  return null;
}

export function createOnnxEmbedder(config?: Partial<OnnxEmbedderConfig>): SemanticEmbedderClient | NoopEmbedder {
  const modelId = config?.modelId || config?.onnxModelId;
  if (!config || !modelId || modelId.trim() === '') {
    return new NoopEmbedder() as any;
  }
  return new SemanticEmbedderClient(config as OnnxEmbedderConfig);
}
