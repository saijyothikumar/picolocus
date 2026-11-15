/**
 * @silent-mi/core - Embedder Plugin port & zero-hash vector quantization primitives
 * Invariant: ZERO fake string-hash pseudo-embeddings anywhere.
 */

export interface EmbedderPlugin {
  readonly id: string;
  readonly isEnabled: boolean;
  readonly isReady: boolean;
  readonly dimensions: number;
  readonly modelSha256: string;
  warmup(): Promise<void>;
  embedQuery(text: string): Promise<Int8Array | null>;
  embedBatch(texts: string[]): Promise<Int8Array[]>;
  dispose(): Promise<void>;
}

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

  async embedBatch(texts: string[]): Promise<Int8Array[]> {
    return texts.map(() => new Int8Array(0));
  }

  async dispose(): Promise<void> {
    // No-op
  }
}

export interface QuantizedInt8Vector {
  int8: Int8Array;
  scale: number;
}

/**
 * L2-normalizes a Float32Array, computes scale as maxAbs / 127,
 * and rounds values clamped within -127 to 127 into an Int8Array.
 */
export function quantizeFloat32ToInt8(floatVec: Float32Array): QuantizedInt8Vector {
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

/**
 * Computes cosine similarity between two Int8Array vectors.
 * Because vectors are pre-quantized from L2-normalized floats,
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
