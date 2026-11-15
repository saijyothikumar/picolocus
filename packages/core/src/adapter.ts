/**
 * @silent-mi/core - LinearAdapter low-rank CPU residual projection
 * Enforces cryptographic SHA-256 base model pinning and fast Int8 math.
 */

import { JargonAdapterPayload } from './types.js';
import { quantizeFloat32ToInt8, QuantizedInt8Vector } from './embedder.js';

export class LinearAdapter {
  readonly payload: JargonAdapterPayload;
  private readonly dimensions: number;
  private readonly rank: number;
  private readonly alpha: number;
  private readonly downScale: number;
  private readonly upScale: number;
  private readonly downProj: Int8Array;
  private readonly upProj: Int8Array;

  // Pre-allocated scratch buffers to ensure < 0.05 ms execution with zero GC pressure
  private readonly hScratch: Float32Array;
  private readonly yScratch: Float32Array;

  constructor(payload: JargonAdapterPayload) {
    LinearAdapter.validatePayload(payload);
    this.payload = payload;
    this.dimensions = payload.dimensions;
    this.rank = payload.rank;
    this.alpha = payload.alpha;
    this.downScale = payload.downScale;
    this.upScale = payload.upScale;
    this.downProj = new Int8Array(payload.downProjInt8);
    this.upProj = new Int8Array(payload.upProjInt8);

    this.hScratch = new Float32Array(this.rank);
    this.yScratch = new Float32Array(this.dimensions);
  }

  static validatePayload(p: unknown): asserts p is JargonAdapterPayload {
    if (!p || typeof p !== 'object') {
      throw new Error('LinearAdapter: payload must be a non-null object');
    }
    const payload = p as Partial<JargonAdapterPayload>;

    if (payload.version !== '1.0') {
      throw new Error(`LinearAdapter: unsupported version "${payload.version}", expected "1.0"`);
    }

    if (
      typeof payload.dimensions !== 'number' ||
      !Number.isInteger(payload.dimensions) ||
      payload.dimensions < 1 ||
      payload.dimensions > 4096
    ) {
      throw new Error(`LinearAdapter: dimensions must be an integer between 1 and 4096, got ${payload.dimensions}`);
    }

    if (
      typeof payload.rank !== 'number' ||
      !Number.isInteger(payload.rank) ||
      payload.rank < 1 ||
      payload.rank > 256
    ) {
      throw new Error(`LinearAdapter: rank must be an integer between 1 and 256, got ${payload.rank}`);
    }

    if (
      typeof payload.downScale !== 'number' ||
      !Number.isFinite(payload.downScale) ||
      payload.downScale <= 0
    ) {
      throw new Error('LinearAdapter: downScale must be a positive finite number');
    }

    if (
      typeof payload.upScale !== 'number' ||
      !Number.isFinite(payload.upScale) ||
      payload.upScale <= 0
    ) {
      throw new Error('LinearAdapter: upScale must be a positive finite number');
    }

    if (
      typeof payload.alpha !== 'number' ||
      !Number.isFinite(payload.alpha) ||
      payload.alpha < 0 ||
      payload.alpha > 4
    ) {
      throw new Error(`LinearAdapter: alpha must be a finite number in [0, 4], got ${payload.alpha}`);
    }

    if (!payload.baseModelId || typeof payload.baseModelId !== 'string' || payload.baseModelId.trim() === '') {
      throw new Error('LinearAdapter: baseModelId must be a non-empty string');
    }

    if (!payload.baseModelSha256 || typeof payload.baseModelSha256 !== 'string' || payload.baseModelSha256.trim() === '') {
      throw new Error('LinearAdapter: baseModelSha256 must be a non-empty string');
    }

    const expectedMatLen = payload.dimensions * payload.rank;
    if (!Array.isArray(payload.downProjInt8) || payload.downProjInt8.length !== expectedMatLen) {
      throw new Error(
        `LinearAdapter: downProjInt8 length must be dimensions * rank (${expectedMatLen}), got ${payload.downProjInt8?.length}`
      );
    }

    if (!Array.isArray(payload.upProjInt8) || payload.upProjInt8.length !== expectedMatLen) {
      throw new Error(
        `LinearAdapter: upProjInt8 length must be dimensions * rank (${expectedMatLen}), got ${payload.upProjInt8?.length}`
      );
    }

    // Verify matrix values are within valid Int8 bounds
    for (let i = 0; i < expectedMatLen; i++) {
      const vDown = payload.downProjInt8[i];
      if (typeof vDown !== 'number' || !Number.isFinite(vDown) || vDown < -128 || vDown > 127) {
        throw new Error(`LinearAdapter: downProjInt8 element at index ${i} is out of Int8 bounds: ${vDown}`);
      }
      const vUp = payload.upProjInt8[i];
      if (typeof vUp !== 'number' || !Number.isFinite(vUp) || vUp < -128 || vUp > 127) {
        throw new Error(`LinearAdapter: upProjInt8 element at index ${i} is out of Int8 bounds: ${vUp}`);
      }
    }
  }

  /**
   * Cryptographic pinning invariant:
   * Requires exact equality on BOTH baseModelId and baseModelSha256.
   * Zero wildcard ('*') or local-onnx bypass allowed.
   */
  matchesBaseModel(modelId: string, modelSha256: string): boolean {
    if (!modelId || !modelSha256) return false;
    if (modelId === '*' || modelSha256 === '*' || modelSha256 === 'none' || modelSha256 === 'local-onnx') {
      return false;
    }
    return this.payload.baseModelId === modelId && this.payload.baseModelSha256 === modelSha256;
  }

  /**
   * Applies the low-rank residual bottleneck:
   * out = quantizeFloat32ToInt8((qInt8 / 127) + alpha * B_up * (A_down * (qInt8 / 127)))
   * Target execution latency: < 0.05 ms using pre-allocated Float32Array scratch buffers.
   */
  project(qInt8: Int8Array): QuantizedInt8Vector {
    if (qInt8.length !== this.dimensions) {
      throw new Error(`LinearAdapter: input dimension mismatch. Expected ${this.dimensions}, got ${qInt8.length}`);
    }

    const D = this.dimensions;
    const R = this.rank;
    const inv127 = 1.0 / 127.0;
    const downMultiplier = this.downScale * inv127;

    // 1. Bottleneck down-projection: h = A_down * (qInt8 / 127)
    // A_down has shape (R, D) stored contiguously
    for (let r = 0; r < R; r++) {
      let sum = 0;
      const rowOffset = r * D;
      for (let d = 0; d < D; d++) {
        sum += this.downProj[rowOffset + d]! * qInt8[d]!;
      }
      this.hScratch[r] = sum * downMultiplier;
    }

    // 2. Up-projection and residual addition: y = (qInt8 / 127) + alpha * (B_up * h)
    // B_up has shape (D, R) stored contiguously
    const alphaUp = this.alpha * this.upScale;
    for (let d = 0; d < D; d++) {
      let delta = 0;
      const rowOffset = d * R;
      for (let r = 0; r < R; r++) {
        delta += this.upProj[rowOffset + r]! * this.hScratch[r]!;
      }
      this.yScratch[d] = qInt8[d]! * inv127 + alphaUp * delta;
    }

    // 3. Re-quantize to normalized Int8
    return quantizeFloat32ToInt8(this.yScratch);
  }
}
