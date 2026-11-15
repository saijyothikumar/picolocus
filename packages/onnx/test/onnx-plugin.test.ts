import { describe, it, expect, vi } from 'vitest';
import {
  createOnnxEmbedder,
  OnnxWorkerEmbedder,
  LatestOnlyQueue,
  configureTransformersEnv,
} from '../src/index.js';
import { NoopEmbedder } from '@silent-mi/core';

describe('ONNX Environment Configuration', () => {
  it('strictly enforces offline execution (allowLocalModels = true, allowRemoteModels = false)', () => {
    const mockEnv: any = {};
    configureTransformersEnv(mockEnv, {
      localModelPath: '/models/bge/',
      wasmPath: '/wasm/',
    });

    expect(mockEnv.allowLocalModels).toBe(true);
    expect(mockEnv.allowRemoteModels).toBe(false);
    expect(mockEnv.useBrowserCache).toBe(true);
    expect(mockEnv.localModelPath).toBe('/models/bge/');
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

    // Enqueue task 1 (starts immediately)
    const p1 = queue.enqueue(() => task1Promise);

    // Enqueue task 2 (queued)
    const p2 = queue.enqueue(() => Promise.resolve('task2-result'));

    // Enqueue task 3 immediately (supersedes task 2!)
    const p3 = queue.enqueue(() => Promise.resolve('task3-result'));

    // Complete task 1
    resolveTask1('task1-result');

    const [res1, res2, res3] = await Promise.all([p1, p2, p3]);

    expect(res1).toBe('task1-result');
    expect(res2).toBeNull(); // Cleanly superseded with null!
    expect(res3).toBe('task3-result');
  });
});

describe('OnnxWorkerEmbedder & Idle RAM Reaper', () => {
  it('createOnnxEmbedder returns NoopEmbedder when unconfigured (0 bytes ML overhead)', () => {
    const embedder = createOnnxEmbedder();
    expect(embedder).toBeInstanceOf(NoopEmbedder);
    expect(embedder.dimensions).toBe(0);
    expect(embedder.isEnabled).toBe(false);
    expect(embedder.modelSha256).toBe('none');

    const emptyEmbedder = createOnnxEmbedder({ onnxModelId: '' });
    expect(emptyEmbedder).toBeInstanceOf(NoopEmbedder);
  });

  it('preserves exact expectedModelSha256 and never fabricates fake hashes', () => {
    const embedder = new OnnxWorkerEmbedder({
      onnxModelId: 'bge-micro-v2',
      expectedModelSha256: 'sha256-verified-55aa',
    });
    expect(embedder.modelSha256).toBe('sha256-verified-55aa');

    const noHashEmbedder = new OnnxWorkerEmbedder({
      onnxModelId: 'bge-micro-v2',
    });
    expect(noHashEmbedder.modelSha256).toBe('none');
  });

  it('reapIdleWorker terminates worker and resets RAM footprint while keeping disposed: false', () => {
    const embedder = new OnnxWorkerEmbedder({
      onnxModelId: 'bge-micro-v2',
      idleTimeoutMs: 120000,
    });

    // Reaping idle worker
    embedder.reapIdleWorker();
    expect(embedder.isReady).toBe(false);
    expect(embedder.isEnabled).toBe(true); // Still enabled for future re-warm!
    expect(embedder.estimateOnnxRamFootprintMb()).toBe(0.0);

    // Terminal dispose
    embedder.dispose();
    expect(embedder.isEnabled).toBe(false);
  });

  it('dispose() immediately settles and rejects in-flight warmup promises via initReject', async () => {
    const embedder = new OnnxWorkerEmbedder({
      onnxModelId: 'bge-micro-v2',
    });

    let settled = false;
    let errorCaught: any = null;

    // Start warmup without resolving it
    const warmupPromise = embedder.warmup().catch((err) => {
      settled = true;
      errorCaught = err;
    });

    // Terminally dispose while warmup is in flight
    await embedder.dispose();
    await warmupPromise;

    expect(settled).toBe(true);
    expect(errorCaught).toBeDefined();
    expect(errorCaught?.message).toContain('disposed');
  });
});
