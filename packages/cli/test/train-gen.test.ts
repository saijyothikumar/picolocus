import { describe, it, expect } from 'vitest';
import { TrainingWorkspaceGenerator } from '../src/train-gen.js';
import { ManifestCompiler } from '../src/compiler.js';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Training Workspace Generator (silent-mi init-train)', () => {
  it('generates schema, training config, RBAC-separated pairs, and goldens', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'silent-mi-train-test-'));
    const manifestsDir = join(tempDir, 'manifests');
    const trainingDir = join(tempDir, 'training');

    try {
      const sampleItems = [
        { id: '1', label: 'Item 1', targetType: 'action' as const, source: 'manifest' as const },
        { id: '2', label: 'Item 2', targetType: 'setting' as const, source: 'manifest' as const },
        { id: '3', label: 'Item 3', targetType: 'action' as const, roles: ['admin'], source: 'manifest' as const },
      ];

      ManifestCompiler.compile(sampleItems, { outDir: manifestsDir });

      TrainingWorkspaceGenerator.generate({
        manifestsDir,
        trainingDir,
        rank: 16,
        alpha: 1.0,
      });

      // Verify files generated
      expect(existsSync(join(trainingDir, 'silent-mi.train.json'))).toBe(true);
      expect(existsSync(join(trainingDir, 'silent-mi.train.schema.json'))).toBe(true);
      expect(existsSync(join(trainingDir, 'train_pairs.public.jsonl'))).toBe(true);
      expect(existsSync(join(trainingDir, 'train_pairs.admin.jsonl'))).toBe(true);
      expect(existsSync(join(trainingDir, 'goldens.jsonl'))).toBe(true);

      const config = JSON.parse(readFileSync(join(trainingDir, 'silent-mi.train.json'), 'utf-8'));
      expect(config.version).toBe('1.0');
      expect(config.rank).toBe(16);
      expect(config.alpha).toBe(1.0);
      expect(config.evalGate.minRecallAt1).toBe(0.85);

      const publicPairs = readFileSync(join(trainingDir, 'train_pairs.public.jsonl'), 'utf-8').trim().split('\n');
      expect(publicPairs.length).toBeGreaterThan(0);
      const firstPair = JSON.parse(publicPairs[0]!);
      expect(firstPair.query).toBeDefined();
      expect(firstPair.positiveId).toBeDefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
