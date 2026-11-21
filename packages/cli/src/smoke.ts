/**
 * @picolocus/cli - Golden Model & RAM Smoke Test Harness
 * Flags: --models-dir, --goldens, --max-rss-mb, --max-latency-ms, --require-onnx
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ManifestItem, RoleManifest, SilentMIEngine } from '@picolocus/core';
import { NodeEmbedder, NodeEmbedderDiscoverer } from './node-embedder.js';

export interface SmokeOptions {
  manifestsDir: string;
  modelsDir?: string;
  goldensPath?: string;
  modelId?: string;
  maxRssMb?: number;
  maxLatencyMs?: number;
  requireOnnx?: boolean;
}

export interface GoldenCase {
  query: string;
  expectedId?: string;
  notExpectedId?: string;
  expectOOD?: boolean;
  expectTierLocked?: boolean;
  user?: { role?: string; roles?: string[]; tier?: string };
  category: 'positive' | 'negation' | 'ood' | 'upsell' | 'rbac';
}

export class SmokeRunner {
  static async run(options: SmokeOptions): Promise<{ passed: boolean; message: string }> {
    const {
      manifestsDir,
      modelsDir = 'sandbox/demo-saas/public/models',
      maxRssMb = 350,
      maxLatencyMs = 60,
      requireOnnx = false,
      modelId,
    } = options;

    console.log('[+] Starting Golden Smoke Harness...');

    // 1. ONNX Model Discovery check
    const discovered = NodeEmbedderDiscoverer.discoverLocalModel(modelsDir, modelId);
    if (requireOnnx && !discovered) {
      const err = `[FAIL] --require-onnx passed but no valid .onnx weight file found in ${modelsDir}`;
      console.error(err);
      return { passed: false, message: err };
    }

    let embedder: NodeEmbedder | null = null;
    if (discovered) {
      console.log(`[OK] Discovered ONNX model: ${discovered.modelId} (${discovered.quantType})`);
      console.log(`[OK] Verified SHA-256: ${discovered.modelSha256}`);
      try {
        embedder = new NodeEmbedder({
          modelDir: discovered.modelDir,
          dimensions: discovered.dimensions,
        });
        await embedder.load();
        await embedder.embed(['warmup query'], 'query');
        console.log(`[OK] Loaded NodeEmbedder (${discovered.dimensions}d Matryoshka q4).`);
      } catch (err: any) {
        if (requireOnnx) {
          const errStr = `[FAIL] Failed to load ONNX model with --require-onnx: ${err.message}`;
          console.error(errStr);
          return { passed: false, message: errStr };
        }
        console.warn(`[WARN] NodeEmbedder unavailable: ${err.message}`);
      }
    } else {
      console.log('[INFO] No ONNX model detected; running in zero-overhead lexical instant mode.');
    }

    // 2. Load All Manifest Items (public, docs, and role-specific)
    const publicPath = join(manifestsDir, 'manifest.public.json');
    if (!existsSync(publicPath)) {
      const err = `[FAIL] Missing manifest.public.json in ${manifestsDir}. Run scan first.`;
      console.error(err);
      return { passed: false, message: err };
    }

    const allItems: ManifestItem[] = [];
    const manifestFiles = readdirSync(manifestsDir).filter(
      (f) => f.startsWith('manifest.') && f.endsWith('.json')
    );

    for (const f of manifestFiles) {
      try {
        const manifest = JSON.parse(readFileSync(join(manifestsDir, f), 'utf-8')) as RoleManifest;
        if (Array.isArray(manifest.items)) {
          allItems.push(...manifest.items);
        }
      } catch {
        // Ignore single parse error
      }
    }

    const engine = new SilentMIEngine({
      minConfidence: 0.29,
      oodSemanticFloor: 0.44,
      tierOrder: ['free', 'pro', 'enterprise'],
    });
    engine.setItems(allItems);

    // 3. Load or Synthesize Golden Cases
    let goldens: GoldenCase[] = [];
    if (options.goldensPath && existsSync(options.goldensPath)) {
      const lines = readFileSync(options.goldensPath, 'utf-8').split('\n');
      for (const line of lines) {
        if (line.trim()) {
          goldens.push(JSON.parse(line));
        }
      }
    } else {
      goldens = this.synthesizeGoldens(allItems);
    }

    console.log(`[+] Executing ${goldens.length} golden test cases...`);

    // Warm up ONNX session and JIT to eliminate cold-start measurement skew
    if (embedder && embedder.isReady && goldens.length > 0) {
      const { vectors: warmVecs } = await embedder.embed([goldens[0]!.query], 'query');
      engine.search(goldens[0]!.query, warmVecs[0] || null, goldens[0]!.user);
    }

    // 4. Run Goldens
    let maxObservedLatency = 0;
    for (let i = 0; i < goldens.length; i++) {
      const g = goldens[i]!;
      const start = performance.now();

      let res;
      if (embedder && embedder.isReady) {
        const { vectors } = await embedder.embed([g.query], 'query');
        const qVec = vectors[0] || null;
        res = engine.search(g.query, qVec, g.user);
      } else {
        res = engine.searchInstant(g.query, g.user);
      }

      const elapsed = performance.now() - start;

      if (elapsed > maxObservedLatency) {
        maxObservedLatency = elapsed;
      }

      if (g.expectOOD && !res.rejectedAsOOD) {
        return {
          passed: false,
          message: `[FAIL] Golden case "${g.query}" expected OOD rejection but got ${res.matches.length} matches.`,
        };
      }

      if (g.expectedId) {
        const found = res.matches.some((m) => m.id === g.expectedId);
        if (!found) {
          return {
            passed: false,
            message: `[FAIL] Golden case "${g.query}" expected item "${g.expectedId}" in top matches.`,
          };
        }
      }

      if (g.notExpectedId) {
        const found = res.matches.some((m) => m.id === g.notExpectedId);
        if (found) {
          return {
            passed: false,
            message: `[FAIL] Golden case "${g.query}" unexpectedly matched penalized item "${g.notExpectedId}".`,
          };
        }
      }

      if (g.expectTierLocked) {
        const target = res.matches.find((m) => m.id === g.expectedId);
        if (!target || !target.tierLocked) {
          return {
            passed: false,
            message: `[FAIL] Golden case "${g.query}" expected tierLocked: true for "${g.expectedId}".`,
          };
        }
      }
    }

    // 5. Memory RSS Check
    const rssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
    console.log(`[OK] Max search latency: ${Math.round(maxObservedLatency * 100) / 100} ms (threshold: ${maxLatencyMs} ms)`);
    console.log(`[OK] Process RSS memory: ${rssMb} MB (threshold: ${maxRssMb} MB)`);

    if (maxObservedLatency > maxLatencyMs) {
      return {
        passed: false,
        message: `[FAIL] Latency threshold exceeded: ${maxObservedLatency} ms > ${maxLatencyMs} ms`,
      };
    }

    if (rssMb > maxRssMb) {
      return {
        passed: false,
        message: `[FAIL] RSS memory threshold exceeded: ${rssMb} MB > ${maxRssMb} MB`,
      };
    }

    console.log('[OK] Golden Model & RAM Smoke Gate PASSED.');
    return { passed: true, message: 'Smoke test passed' };
  }

  static synthesizeGoldens(items: ManifestItem[]): GoldenCase[] {
    const goldens: GoldenCase[] = [];

    // 1. Positive cases (prefer controls with concise UI labels)
    const publicItems = items.filter((i) => !i.roles || i.roles.length === 0 || i.roles.includes('public'));
    const publicControls = publicItems.filter((i) => i.targetType !== 'doc_clause');
    const samples = (publicControls.length >= 5 ? publicControls : publicItems).slice(0, 5);
    for (const s of samples) {
      goldens.push({
        query: s.label,
        expectedId: s.id,
        user: s.roles && s.roles.length > 0 ? { role: s.roles[0] } : undefined,
        category: 'positive',
      });
    }

    // 2. Negation cases
    const actionSample = items.find((i) => i.targetType === 'action');
    if (actionSample) {
      goldens.push({
        query: `do not ${actionSample.label.toLowerCase()}`,
        notExpectedId: actionSample.id,
        expectOOD: true,
        category: 'negation',
      });
    }

    // 3. OOD cases
    goldens.push({
      query: 'xzq999_unrelated_nonsense_query',
      expectOOD: true,
      category: 'ood',
    });

    // 4. Upsell cases
    const upsellSample = items.find((i) => i.tierPolicy === 'upsell');
    if (upsellSample) {
      goldens.push({
        query: upsellSample.label,
        expectedId: upsellSample.id,
        expectTierLocked: true,
        user: { tier: 'free' },
        category: 'upsell',
      });
    }

    // 5. RBAC cases
    const rbacSample = items.find(
      (i) => i.roles && i.roles.length > 0 && !i.roles.includes('public')
    );
    if (rbacSample) {
      // User without role cannot access
      goldens.push({
        query: rbacSample.label,
        notExpectedId: rbacSample.id,
        user: { role: 'viewer' },
        category: 'rbac',
      });
      // User with required role can access
      const allowedRole = rbacSample.roles![0]!;
      goldens.push({
        query: rbacSample.label,
        expectedId: rbacSample.id,
        user: { role: allowedRole },
        category: 'rbac',
      });
    }

    return goldens;
  }
}
