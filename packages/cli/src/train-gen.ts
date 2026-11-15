/**
 * @silent-mi/cli - Training Workspace Generator (silent-mi init-train)
 * Generates silent-mi.train.json, JSON schema, RBAC-separated train_pairs.*.jsonl, and stratified goldens.jsonl.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ManifestItem, RoleManifest } from '@silent-mi/core';
import { SmokeRunner } from './smoke.js';

export interface TrainGenOptions {
  manifestsDir: string;
  trainingDir: string;
  modelsDir?: string;
  rank?: number;
  alpha?: number;
  loss?: string;
}

export class TrainingWorkspaceGenerator {
  static generate(options: TrainGenOptions): void {
    const {
      manifestsDir,
      trainingDir,
      modelsDir = 'sandbox/demo-saas/public/models',
      rank = 16,
      alpha = 1.0,
      loss = 'ridge',
    } = options;

    if (!existsSync(trainingDir)) {
      mkdirSync(trainingDir, { recursive: true });
    }

    console.log('[+] Generating training workspace in:', trainingDir);

    // 1. Emit silent-mi.train.json
    const trainConfig = {
      $schema: './silent-mi.train.schema.json',
      version: '1.0',
      modelId: 'bge-micro-v2',
      modelsDir,
      manifestsDir,
      pairsDir: trainingDir,
      goldensFile: join(trainingDir, 'goldens.jsonl'),
      outputDir: manifestsDir,
      rank,
      alpha,
      loss,
      evalGate: {
        minRecallAt1: 0.85,
        minMrrAt5Delta: 0.0,
        maxNegationViolations: 0,
      },
    };
    writeFileSync(join(trainingDir, 'silent-mi.train.json'), JSON.stringify(trainConfig, null, 2));

    // 2. Emit silent-mi.train.schema.json
    const trainSchema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      title: 'SilentMITrainConfig',
      type: 'object',
      required: ['version', 'manifestsDir', 'outputDir', 'evalGate'],
      properties: {
        version: { type: 'string', enum: ['1.0'] },
        modelId: { type: 'string' },
        modelsDir: { type: 'string' },
        manifestsDir: { type: 'string' },
        pairsDir: { type: 'string' },
        goldensFile: { type: 'string' },
        outputDir: { type: 'string' },
        rank: { type: 'integer', minimum: 1, maximum: 256 },
        alpha: { type: 'number', minimum: 0, maximum: 4 },
        loss: { type: 'string', enum: ['ridge', 'triplet'] },
        evalGate: {
          type: 'object',
          required: ['minRecallAt1', 'maxNegationViolations'],
          properties: {
            minRecallAt1: { type: 'number', minimum: 0, maximum: 1 },
            minMrrAt5Delta: { type: 'number' },
            maxNegationViolations: { type: 'integer', minimum: 0, maximum: 0 },
          },
        },
      },
    };
    writeFileSync(join(trainingDir, 'silent-mi.train.schema.json'), JSON.stringify(trainSchema, null, 2));

    // 3. Load manifests and emit RBAC-separated train_pairs.*.jsonl
    const allItems: ManifestItem[] = [];
    const files = existsSync(manifestsDir)
      ? readdirSync(manifestsDir).filter((f) => f.startsWith('manifest.') && f.endsWith('.json'))
      : [];

    for (const f of files) {
      const manifest = JSON.parse(readFileSync(join(manifestsDir, f), 'utf-8')) as RoleManifest;
      const items = manifest.items || [];
      allItems.push(...items);

      const scope = f.replace('manifest.', '').replace('.json', '');
      const pairsFileName = `train_pairs.${scope}.jsonl`;

      const pairs: string[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        // Positive query from label
        const query = item.label;
        // Hard negative: find another item in the same scope
        const hardNeg = items[(i + 1) % items.length];
        const negId = hardNeg && hardNeg.id !== item.id ? hardNeg.id : undefined;

        pairs.push(
          JSON.stringify({
            query,
            positiveId: item.id,
            negativeId: negId,
          })
        );
      }
      writeFileSync(join(trainingDir, pairsFileName), pairs.join('\n') + '\n');
    }

    // 4. Emit stratified goldens.jsonl
    const goldens = SmokeRunner.synthesizeGoldens(allItems);
    const goldenLines = goldens.map((g) => JSON.stringify(g)).join('\n') + '\n';
    writeFileSync(join(trainingDir, 'goldens.jsonl'), goldenLines);

    console.log('[OK] Generated training workspace successfully.');
  }
}
