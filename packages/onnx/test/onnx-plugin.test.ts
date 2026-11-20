import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createOnnxEmbedder,
  SemanticEmbedderClient,
  OnnxWorkerEmbedder,
  LatestOnlyQueue,
  configureTransformersEnv,
  setTestModelLoader,
  handleWorkerInit,
} from '../src/index.js';
import { NoopEmbedder } from '@picolocus/core';

describe('ONNX Environment Configuration', () => {
  it('strictly enforces offline execution (allowLocalModels = true, allowRemoteModels = false)', () => {
    const mockEnv: any = {};
    configureTransformersEnv(mockEnv, {
      localModelPath: '/models/mdbr-leaf-ir/',
      wasmPath: '/wasm/',
    });

    expect(mockEnv.allowLocalModels).toBe(true);
    expect(mockEnv.allowRemoteModels).toBe(false);
    expect(mockEnv.useBrowserCache).toBe(true);
    expect(mockEnv.localModelPath).toBe('/models/mdbr-leaf-ir/');
    expect(mockEnv.backends.onnx.wasm.wasmPaths).toBe('/wasm/');
    expect(mockEnv.backends.onnx.wasm.numThreads).toBe(1);
  });
});

describe('LatestOnlyQueue (Queue Depth 1)', () => {
  it('supersedes intermediate queued queries with null on rapid typing', async () => {
    const queue = new LatestOnlyQueue<string>();

    let resolveTask1: (val: string) => void = () => {};
    const task1Promise = new Promise<string>((r) => {
      resolveTask1 = r;
    });

    const p1 = queue.enqueue(() => task1Promise);
    const p2 = queue.enqueue(() => Promise.resolve('task2-result'));
    const p3 = queue.enqueue(() => Promise.resolve('task3-result'));

    resolveTask1('task1-result');

    const [res1, res2, res3] = await Promise.all([p1, p2, p3]);

    expect(res1).toBe('task1-result');
    expect(res2).toBeNull();
    expect(res3).toBe('task3-result');
  });
});

describe('SemanticEmbedderClient Business Opt-In Consent & Lifecycle', () => {
  it('defaults strictly to opt-in with zero activity before grantConsent()', async () => {
    const client = new SemanticEmbedderClient({
      modelId: 'mdbr-leaf-ir',
    });

    expect(client.isConsented()).toBe(false);
    expect(client.isEnabled).toBe(false);

    // Calling warmup, embedQuery, or embedBatch before consent are safe no-ops
    await client.warmup();
    expect(client.isReady).toBe(false);

    const queryResult = await client.embedQuery('test query');
    expect(queryResult).toBeNull();

    const batchResult = await client.embedBatch(['doc 1', 'doc 2']);
    expect(batchResult).toEqual([null, null]);
  });

  it('preserves exact expectedModelSha256 and rejects integrity mismatch', async () => {
    const client = new SemanticEmbedderClient({
      modelId: 'mdbr-leaf-ir',
      expectedModelSha256: 'mdbr-leaf-ir-sha256-abc1234567890def',
    });
    expect(client.modelSha256).toBe('mdbr-leaf-ir-sha256-abc1234567890def');

    // Worker init integrity check test
    setTestModelLoader(async () => {
      return {
        tokenizer: () => ({}),
        model: () => ({}),
        sha256: 'mdbr-leaf-ir-sha256-different_hash',
      };
    });

    let receivedResp: any = null;
    await handleWorkerInit(
      {
        type: 'INIT',
        id: 'test-init',
        config: {
          modelId: 'mdbr-leaf-ir',
          expectedModelSha256: 'mdbr-leaf-ir-sha256-abc1234567890def',
        },
      },
      (resp) => {
        receivedResp = resp;
      }
    );

    expect(receivedResp).toBeDefined();
    expect(receivedResp.type).toBe('INIT_ERROR');
    expect(receivedResp.code).toBe('integrity_mismatch');

    setTestModelLoader(null);
  });

  it('reapIdleWorker terminates worker and resets RAM footprint while keeping optedIn: true', () => {
    const client = new SemanticEmbedderClient({
      modelId: 'mdbr-leaf-ir',
      consentGranted: true,
      idleTimeoutMs: 120000,
    });

    expect(client.isConsented()).toBe(true);
    expect(client.estimateOnnxRamFootprintMb()).toBe(0.0);

    // Reaping idle worker
    client.reapIdleWorker('test');
    expect(client.isReady).toBe(false);
    expect(client.isConsented()).toBe(true); // Still consented for transparent re-warm!
    expect(client.estimateOnnxRamFootprintMb()).toBe(0.0);

    client.dispose();
  });

  it('revokeConsent() sets optedIn = false and purges cache API', async () => {
    let deletedKey = '';
    (globalThis as any).caches = {
      delete: async (k: string) => {
        deletedKey = k;
        return true;
      },
    };

    const client = new SemanticEmbedderClient({
      modelId: 'mdbr-leaf-ir',
      consentGranted: true,
    });

    expect(client.isConsented()).toBe(true);

    await client.revokeConsent();

    expect(client.isConsented()).toBe(false);
    expect(client.isEnabled).toBe(false);
    expect(deletedKey).toBeDefined();

    delete (globalThis as any).caches;
  });
});

describe('15-Second Tab-Sleep Visibility Reaping', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('arms 15-second timer when visibilityState turns hidden and reaps worker', () => {
    let visibilityState = 'visible';
    let visibilityCallback: (() => void) | null = null;

    (globalThis as any).document = {
      get visibilityState() {
        return visibilityState;
      },
      addEventListener: (evt: string, cb: any) => {
        if (evt === 'visibilitychange') visibilityCallback = cb;
      },
      removeEventListener: () => {},
    };

    const client = new SemanticEmbedderClient({
      modelId: 'mdbr-leaf-ir',
      consentGranted: true,
      hiddenReapDelayMs: 15000,
    });

    const reapSpy = vi.spyOn(client, 'reapIdleWorker');

    // Simulate tab hiding
    visibilityState = 'hidden';
    visibilityCallback?.();

    // Fast-forward 14 seconds (not yet reaped)
    vi.advanceTimersByTime(14000);
    expect(reapSpy).not.toHaveBeenCalled();

    // Fast-forward another 1.1 seconds (15.1s elapsed -> reaped!)
    vi.advanceTimersByTime(1100);
    expect(reapSpy).toHaveBeenCalledWith('tab_hidden');

    client.dispose();
    delete (globalThis as any).document;
  });

  it('cancels tab-sleep timer if tab becomes visible before 15 seconds', () => {
    let visibilityState = 'visible';
    let visibilityCallback: (() => void) | null = null;

    (globalThis as any).document = {
      get visibilityState() {
        return visibilityState;
      },
      addEventListener: (evt: string, cb: any) => {
        if (evt === 'visibilitychange') visibilityCallback = cb;
      },
      removeEventListener: () => {},
    };

    const client = new SemanticEmbedderClient({
      modelId: 'mdbr-leaf-ir',
      consentGranted: true,
      hiddenReapDelayMs: 15000,
    });

    const reapSpy = vi.spyOn(client, 'reapIdleWorker');

    // Tab hides
    visibilityState = 'hidden';
    visibilityCallback?.();

    // User switches back to tab after 5 seconds
    vi.advanceTimersByTime(5000);
    visibilityState = 'visible';
    visibilityCallback?.();

    // Advance past 15 seconds total
    vi.advanceTimersByTime(20000);
    expect(reapSpy).not.toHaveBeenCalled();

    client.dispose();
    delete (globalThis as any).document;
  });
});
