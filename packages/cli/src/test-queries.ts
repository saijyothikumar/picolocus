/**
 * @picolocus/cli - Test Queries Runner & Evaluator
 * Evaluates golden queries against compiled manifests, evaluating top ID, decision, and safety gates.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ManifestItem, RoleManifest, SilentMIEngine, UserContext } from '@picolocus/core';
import { NodeEmbedder, NodeEmbedderDiscoverer } from './node-embedder.js';

export interface QueryTestCase {
  query: string;
  expectedTopId?: string;
  expectedDecision?: 'choice' | 'disambiguate' | 'noul';
  expectOOD?: boolean;
  expectTierLocked?: boolean;
  expectStateConflict?: string;
  notExpectedIds?: string[];
  user?: UserContext;
  category?: string;
}

export interface TestQueriesOptions {
  manifestsDir: string;
  queriesPath: string;
  modelsDir?: string;
  modelId?: string;
  requireOnnx?: boolean;
  tierOrder?: string[];
}

export class TestQueriesRunner {
  static async run(options: TestQueriesOptions): Promise<{ passed: boolean; message: string }> {
    const {
      manifestsDir,
      queriesPath,
      modelsDir = 'sandbox/demo-saas/public/models',
      modelId,
      requireOnnx = false,
    } = options;

    console.log(`[+] Running Test Queries from: ${queriesPath}`);

    if (!existsSync(queriesPath)) {
      const err = `[FAIL] Queries file not found: ${queriesPath}`;
      console.error(err);
      return { passed: false, message: err };
    }

    // 1. Check ONNX Model
    const discovered = NodeEmbedderDiscoverer.discoverLocalModel(modelsDir, modelId);
    if (requireOnnx && !discovered) {
      const err = `[FAIL] --require-onnx passed but no valid .onnx weight file found in ${modelsDir}`;
      console.error(err);
      return { passed: false, message: err };
    }

    let embedder: NodeEmbedder | null = null;
    if (discovered) {
      console.log(`[OK] Discovered ONNX model: ${discovered.modelId} (${discovered.quantType})`);
      try {
        embedder = new NodeEmbedder({
          modelDir: discovered.modelDir,
          dimensions: discovered.dimensions,
        });
        await embedder.load();
        console.log(`[OK] Initialized NodeEmbedder with ${discovered.dimensions}d Matryoshka vectors.`);
      } catch (err: any) {
        if (requireOnnx) {
          const msg = `[FAIL] Failed to initialize NodeEmbedder with --require-onnx: ${err.message}`;
          console.error(msg);
          return { passed: false, message: msg };
        }
        console.warn(`[WARN] NodeEmbedder initialization failed: ${err.message}. Running in lexical mode.`);
      }
    } else {
      console.log('[INFO] No ONNX model linked; evaluating in pure lexical mode.');
    }

    // 2. Load Manifest Items
    if (!existsSync(manifestsDir)) {
      const err = `[FAIL] Manifests directory not found: ${manifestsDir}. Run scan first.`;
      console.error(err);
      return { passed: false, message: err };
    }

    const allItems: ManifestItem[] = [];
    const manifestFiles = readdirSync(manifestsDir).filter(
      (f) => f.startsWith('manifest.') && f.endsWith('.json')
    );

    const tierOrder = options.tierOrder || ['default'];
    const engine = new SilentMIEngine({
      minConfidence: 0.29,
      oodSemanticFloor: 0.44,
      tierOrder,
    });

    for (const f of manifestFiles) {
      try {
        const manifest = JSON.parse(readFileSync(join(manifestsDir, f), 'utf-8')) as RoleManifest;
        if (Array.isArray(manifest.items)) {
          allItems.push(...manifest.items);
        }
        if (Array.isArray(manifest.playbooks)) {
          for (const pb of manifest.playbooks) {
            engine.registerPlaybook(pb);
          }
        }
        if (manifest.domainGlossary) {
          engine.registerGlossary(manifest.domainGlossary);
        }
      } catch {
        // Ignore single parse error
      }
    }

    engine.setItems(allItems);

    // 3. Load Test Cases
    const rawQueries = readFileSync(queriesPath, 'utf-8');
    let testCases: QueryTestCase[] = [];
    try {
      const parsed = JSON.parse(rawQueries);
      testCases = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      // Try JSONL
      const lines = rawQueries.split('\n').filter((l) => l.trim().length > 0);
      testCases = lines.map((l) => JSON.parse(l));
    }

    console.log(`[+] Executing ${testCases.length} query assertions...`);
    let passedCount = 0;
    const failures: string[] = [];
    const categoryStats = new Map<string, { total: number; passed: number }>();

    for (let i = 0; i < testCases.length; i++) {
      const tc = testCases[i]!;
      const cat = tc.category || 'general';
      if (!categoryStats.has(cat)) {
        categoryStats.set(cat, { total: 0, passed: 0 });
      }
      categoryStats.get(cat)!.total++;

      // Normalize array selectors from JSON to Set
      if (
        tc.user?.domContext?.disabledSelectors &&
        Array.isArray(tc.user.domContext.disabledSelectors)
      ) {
        tc.user.domContext.disabledSelectors = new Set(tc.user.domContext.disabledSelectors);
      }
      if (
        tc.user?.domContext?.visibleSelectors &&
        Array.isArray(tc.user.domContext.visibleSelectors)
      ) {
        tc.user.domContext.visibleSelectors = new Set(tc.user.domContext.visibleSelectors);
      }

      const start = performance.now();

      let res;
      if (embedder && embedder.isReady) {
        const { vectors } = await embedder.embed([tc.query], 'query');
        const qVec = vectors[0] || null;
        res = engine.search(tc.query, qVec, tc.user);
      } else {
        res = engine.searchInstant(tc.query, tc.user);
      }

      const elapsed = Math.round((performance.now() - start) * 100) / 100;
      const topMatch = res.matches[0];
      let casePassed = true;
      const caseErrors: string[] = [];

      // Check OOD
      if (tc.expectOOD !== undefined && res.rejectedAsOOD !== tc.expectOOD) {
        casePassed = false;
        caseErrors.push(`expected rejectedAsOOD: ${tc.expectOOD}, got: ${res.rejectedAsOOD}`);
      }

      // Check Expected Top ID
      if (tc.expectedTopId && (!topMatch || topMatch.id !== tc.expectedTopId)) {
        casePassed = false;
        caseErrors.push(
          `expected top ID "${tc.expectedTopId}", got "${topMatch?.id ?? 'none'}"`
        );
      }

      // Check Expected Decision
      if (tc.expectedDecision && res.decision !== tc.expectedDecision) {
        casePassed = false;
        caseErrors.push(
          `expected decision "${tc.expectedDecision}", got "${res.decision}"`
        );
      }

      // Check Tier Locked
      if (tc.expectTierLocked && (!topMatch || !topMatch.tierLocked)) {
        casePassed = false;
        caseErrors.push(`expected tierLocked: true for top match`);
      }

      // Check State Conflict
      if (tc.expectStateConflict && (!topMatch || topMatch.stateConflict !== tc.expectStateConflict)) {
        casePassed = false;
        caseErrors.push(
          `expected stateConflict "${tc.expectStateConflict}", got "${topMatch?.stateConflict ?? 'none'}"`
        );
      }

      // Check Not Expected IDs
      if (tc.notExpectedIds && tc.notExpectedIds.length > 0) {
        for (const badId of tc.notExpectedIds) {
          if (res.matches.some((m) => m.id === badId)) {
            casePassed = false;
            caseErrors.push(`matched penalized/forbidden ID "${badId}"`);
          }
        }
      }

      if (casePassed) {
        passedCount++;
        categoryStats.get(cat)!.passed++;
        console.log(`  [OK] "${tc.query}" -> ${topMatch?.id ?? 'OOD'} [${res.decision}] (${elapsed} ms)`);
      } else {
        const failMsg = `Query "${tc.query}": ${caseErrors.join(', ')}`;
        failures.push(failMsg);
        console.error(`  [FAIL] "${tc.query}": ${caseErrors.join(', ')}`);
      }
    }

    console.log('\n[CATEGORY ACCURACY BREAKDOWN]');
    console.log('-'.repeat(64));
    console.log(
      'Category'.padEnd(38) +
      'Passed / Total'.padEnd(16) +
      'Accuracy'
    );
    console.log('-'.repeat(64));
    for (const [catName, stats] of categoryStats.entries()) {
      const rate = ((stats.passed / stats.total) * 100).toFixed(1) + '%';
      const countStr = `${stats.passed} / ${stats.total}`;
      console.log(catName.padEnd(38) + countStr.padEnd(16) + rate);
    }
    console.log('-'.repeat(64));
    const totalRate = ((passedCount / testCases.length) * 100).toFixed(1) + '%';
    console.log(
      `OVERALL ACCURACY:`.padEnd(38) +
      `${passedCount} / ${testCases.length}`.padEnd(16) +
      totalRate
    );
    console.log('-'.repeat(64));

    if (failures.length > 0) {
      return {
        passed: false,
        message: `${failures.length} query assertions failed:\n${failures.join('\n')}`,
      };
    }

    return { passed: true, message: `All ${testCases.length} test queries passed with 100.0% accuracy.` };
  }
}
