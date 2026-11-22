/**
 * @picolocus/core - Embedder Plugin port & zero-hash vector quantization primitives (v1.0.3)
 * Invariant: ZERO fake string-hash pseudo-embeddings anywhere.
 */

import { EmbedderPlugin, EmbedRole } from './types.js';

export const DEFAULT_DIMENSIONS = 256;

export type { EmbedderPlugin, EmbedRole };

export class NoopEmbedder implements EmbedderPlugin {
  readonly id = 'noop-embedder';
  readonly isEnabled = false;
  readonly isReady = true;
  readonly dimensions = 0;
  readonly modelSha256 = 'none';

  async warmup(): Promise<void> {
    // No-op
  }

  async embedQuery(_text: string): Promise<Int8Array | null> {
    return null;
  }

  async embedBatch(texts: readonly string[], _role?: EmbedRole): Promise<Array<Int8Array | null>> {
    return texts.map(() => null);
  }

  async embedDirect(_text: string, _role?: EmbedRole): Promise<Int8Array | null> {
    return null;
  }

  async embedLatest(_text: string, _role?: EmbedRole): Promise<Int8Array | null> {
    return null;
  }

  async grantConsent(): Promise<boolean> {
    return false;
  }

  async revokeConsent(): Promise<void> {
    // No-op
  }

  isConsented(): boolean {
    return false;
  }

  async dispose(): Promise<void> {
    // No-op
  }
}

import { fnv1aHash } from './hash.js';

export interface QuantizedInt8Vector {
  int8: Int8Array;
  scale: number;
}

export { fnv1aHash };

/**
 * L2-normalizes a Float32Array, computes scale as maxAbs / 127,
 * and rounds values clamped within -127 to 127 into an Int8Array.
 */
export function quantizeFloat32ToInt8(floatVec: Float32Array | number[]): QuantizedInt8Vector {
  const len = floatVec.length;
  if (len === 0) {
    return { int8: new Int8Array(0), scale: 1.0 };
  }

  // 1. Compute L2 norm
  let sumSq = 0;
  for (let i = 0; i < len; i++) {
    const val = floatVec[i]!;
    sumSq += val * val;
  }
  const norm = Math.sqrt(sumSq);
  const invNorm = norm > 1e-12 ? 1.0 / norm : 1.0;

  // 2. Find maxAbs on normalized vector
  let maxAbs = 0;
  for (let i = 0; i < len; i++) {
    const absVal = Math.abs(floatVec[i]! * invNorm);
    if (absVal > maxAbs) {
      maxAbs = absVal;
    }
  }

  const scale = maxAbs > 0 ? maxAbs / 127.0 : 1.0;
  const invScale = 1.0 / scale;

  // 3. Quantize and clamp to [-127, 127]
  const int8 = new Int8Array(len);
  for (let i = 0; i < len; i++) {
    const normalizedVal = floatVec[i]! * invNorm;
    let q = Math.round(normalizedVal * invScale);
    if (q > 127) q = 127;
    else if (q < -127) q = -127;
    int8[i] = q;
  }

  return { int8, scale };
}

export const quantizeFloatToInt8 = quantizeFloat32ToInt8;

/**
 * Computes cosine similarity between two Int8Array vectors in flat memory.
 * cos(a, b) = dot(a, b) / (norm(a) * norm(b)).
 */
export function computeInt8Cosine(a: Int8Array, b: Int8Array): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0.0;
  }
  let dot = 0;
  let normASq = 0;
  let normBSq = 0;
  const len = a.length;
  for (let i = 0; i < len; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    normASq += ai * ai;
    normBSq += bi * bi;
  }
  if (normASq === 0 || normBSq === 0) return 0.0;
  const sim = dot / (Math.sqrt(normASq) * Math.sqrt(normBSq));
  return Math.max(-1.0, Math.min(1.0, sim));
}

export const cosineInt8 = computeInt8Cosine;
