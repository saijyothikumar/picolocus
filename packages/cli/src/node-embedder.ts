/**
 * @picolocus/cli - Node.js local ONNX model discovery, SHA-256 calculator, & NodeEmbedder
 * Invariant: Computes real SHA-256 hashes of .onnx weights, or compiles zero-dimension lexical manifests.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { quantizeFloatToInt8 } from '@picolocus/core';

export interface DiscoveredModel {
  modelId: string;
  modelDir: string;
  onnxFilePath: string;
  modelSha256: string;
  quantType: 'q8' | 'q4' | 'fp16' | 'fp32';
  dimensions: number;
}

export const ONNX_FILE_PRIORITY = [
  { name: 'model_q4.onnx', quant: 'q4' as const },
  { name: 'model_quantized.onnx', quant: 'q8' as const },
  { name: 'model_int8.onnx', quant: 'q8' as const },
  { name: 'model_fp16.onnx', quant: 'fp16' as const },
  { name: 'model.onnx', quant: 'fp32' as const },
];

export class NodeEmbedderDiscoverer {
  /**
   * Computes the real SHA-256 hex hash of an ONNX weight file.
   */
  static computeSha256(filePath: string): string {
    const buffer = readFileSync(filePath);
    return createHash('sha256').update(buffer).digest('hex');
  }

  /**
   * Formats a canonical model version string.
   */
  static formatModelHash(modelId: string, modelSha256: string): string {
    return `${modelId}-sha256-${modelSha256.slice(0, 16)}`;
  }

  /**
   * Auto-discovers local .onnx models in the given models directory.
   */
  static discoverLocalModel(modelsDir: string, modelId?: string): DiscoveredModel | null {
    if (!existsSync(modelsDir)) return null;

    let targetDir = modelsDir;
    let targetModelId = modelId || '';

    if (modelId) {
      targetDir = join(modelsDir, modelId);
      if (!existsSync(targetDir)) return null;
    } else {
      // Discover first subdirectory in modelsDir
      const entries = readdirSync(modelsDir);
      for (const e of entries) {
        const full = join(modelsDir, e);
        if (statSync(full).isDirectory()) {
          targetDir = full;
          targetModelId = e;
          break;
        }
      }
    }

    if (!targetModelId) return null;

    // Search prioritized ONNX files (direct or inside onnx/ subdir)
    const searchDirs = [targetDir, join(targetDir, 'onnx')];

    for (const prio of ONNX_FILE_PRIORITY) {
      for (const dir of searchDirs) {
        const candidate = join(dir, prio.name);
        if (existsSync(candidate)) {
          const modelSha256 = this.computeSha256(candidate);
          return {
            modelId: targetModelId,
            modelDir: targetDir,
            onnxFilePath: candidate,
            modelSha256,
            quantType: prio.quant,
            dimensions: 256, // Sliced Int8 Matryoshka dimension for mdbr-leaf-ir
          };
        }
      }
    }

    return null;
  }
}

export class NodeEmbedder {
  private tokenizer: any = null;
  private model: any = null;
  private modelDir: string;
  private dimensions: number;
  private queryPrefix: string;
  private documentPrefix: string;
  public isReady = false;

  constructor(options: {
    modelDir: string;
    dimensions?: number;
    queryPrefix?: string;
    documentPrefix?: string;
    dtype?: string;
  }) {
    this.modelDir = options.modelDir;
    this.dimensions = options.dimensions || 256;
    this.queryPrefix = options.queryPrefix ?? 'Represent this sentence for searching relevant passages: ';
    this.documentPrefix = options.documentPrefix ?? '';
  }

  async load(): Promise<void> {
    if (this.isReady) return;
    try {
      // Dynamic import of transformers to allow offline/zero-dependency CLI runs
      const moduleName = '@huggingface/transformers';
      const transformers = (await import(moduleName)) as any;
      const { AutoTokenizer, AutoModel, env } = transformers;

      if (env) {
        env.allowLocalModels = true;
        env.allowRemoteModels = false;
      }

      this.tokenizer = await AutoTokenizer.from_pretrained(this.modelDir, {
        local_files_only: true,
      });

      this.model = await AutoModel.from_pretrained(this.modelDir, {
        local_files_only: true,
        dtype: 'q4',
      });

      this.isReady = true;
    } catch (err: any) {
      throw new Error(`Failed to load local ONNX model from ${this.modelDir}: ${err.message}`);
    }
  }

  async embed(
    texts: string[],
    role: 'query' | 'document' = 'document'
  ): Promise<{ vectors: Int8Array[]; quantScales: number[] }> {
    if (!this.isReady) {
      await this.load();
    }

    const prefix = role === 'query' ? this.queryPrefix : this.documentPrefix;
    const formatted = texts.map((t) => (prefix ? `${prefix}${t}` : t));

    const inputs = await this.tokenizer(formatted, {
      padding: true,
      truncation: true,
      max_length: 256,
    });

    const outputs = await this.model(inputs);

    const vectors: Int8Array[] = [];
    const quantScales: number[] = [];
    const batchSize = texts.length;

    // Check if model emitted pooled sentence_embedding directly
    if (outputs.sentence_embedding) {
      const data = outputs.sentence_embedding.data as Float32Array;
      const hiddenDim = outputs.sentence_embedding.dims[1] as number;

      for (let b = 0; b < batchSize; b++) {
        const offset = b * hiddenDim;
        const sliced = new Float32Array(this.dimensions);
        for (let d = 0; d < this.dimensions; d++) {
          sliced[d] = data[offset + d] ?? 0;
        }

        // L2 normalize
        let norm = 0;
        for (let d = 0; d < this.dimensions; d++) {
          norm += (sliced[d] ?? 0) * (sliced[d] ?? 0);
        }
        norm = Math.sqrt(norm) || 1e-12;
        for (let d = 0; d < this.dimensions; d++) {
          sliced[d] = (sliced[d] ?? 0) / norm;
        }

        const { int8, scale } = quantizeFloatToInt8(sliced);
        vectors.push(int8);
        quantScales.push(scale);
      }
    } else if (outputs.last_hidden_state) {
      // Masked mean pooling fallback
      const data = outputs.last_hidden_state.data as Float32Array;
      const dims = outputs.last_hidden_state.dims as number[];
      const seqLen = dims[1] ?? 1;
      const hiddenDim = dims[2] ?? this.dimensions;
      const maskData = inputs.attention_mask.data as BigInt64Array | Int32Array;

      for (let b = 0; b < batchSize; b++) {
        const pooled = new Float32Array(this.dimensions);
        let maskSum = 0;

        for (let s = 0; s < seqLen; s++) {
          const maskVal = Number(maskData[b * seqLen + s] ?? 0);
          if (maskVal > 0) {
            maskSum += maskVal;
            const tokenOffset = (b * seqLen + s) * hiddenDim;
            for (let d = 0; d < this.dimensions; d++) {
              pooled[d] = (pooled[d] ?? 0) + (data[tokenOffset + d] ?? 0);
            }
          }
        }

        const divisor = maskSum > 0 ? maskSum : 1;
        let norm = 0;
        for (let d = 0; d < this.dimensions; d++) {
          pooled[d] = (pooled[d] ?? 0) / divisor;
          norm += (pooled[d] ?? 0) * (pooled[d] ?? 0);
        }

        norm = Math.sqrt(norm) || 1e-12;
        for (let d = 0; d < this.dimensions; d++) {
          pooled[d] = (pooled[d] ?? 0) / norm;
        }

        const { int8, scale } = quantizeFloatToInt8(pooled);
        vectors.push(int8);
        quantScales.push(scale);
      }
    }

    return { vectors, quantScales };
  }
}
