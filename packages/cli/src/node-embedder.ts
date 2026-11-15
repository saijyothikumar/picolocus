/**
 * @silent-mi/cli - Node.js local ONNX model discovery & SHA-256 calculator
 * Invariant: Computes real SHA-256 hashes of .onnx weights, or compiles zero-dimension lexical manifests.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export interface DiscoveredModel {
  modelId: string;
  onnxFilePath: string;
  modelSha256: string;
  quantType: 'q8' | 'q4' | 'fp16' | 'fp32';
  dimensions: number;
}

export const ONNX_FILE_PRIORITY = [
  { name: 'model_quantized.onnx', quant: 'q8' as const },
  { name: 'model_q4.onnx', quant: 'q4' as const },
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
            onnxFilePath: candidate,
            modelSha256,
            quantType: prio.quant,
            dimensions: 128, // Standard sliced Int8 embedding dimension
          };
        }
      }
    }

    return null;
  }
}
