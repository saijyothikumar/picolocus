#!/usr/bin/env node
/**
 * @picolocus/cli - CLI Entry Point
 * Subcommands: scan, verify, smoke, test-queries, suggest
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AstScanner } from './scanner.js';
import { ProseChunker } from './chunker.js';
import { NodeEmbedderDiscoverer } from './node-embedder.js';
import { ManifestCompiler } from './compiler.js';
import { SmokeRunner } from './smoke.js';
import { TestQueriesRunner } from './test-queries.js';
import { ManifestItem } from '@picolocus/core';

interface CliConfig {
  scanDir?: string;
  manifestsDir?: string;
  modelsDir?: string;
  modelId?: string;
  harnessPath?: string;
  queriesPath?: string;
}

function parseArgs(args: string[]): { command: string; flags: Record<string, string | boolean> } {
  const command = args[0] || 'help';
  const flags: Record<string, string | boolean> = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }

  return { command, flags };
}

function loadConfig(configPath?: string): CliConfig {
  const candidatePaths = configPath
    ? [configPath]
    : [
        'picolocus.config.json',
        'sandbox/demo-saas/picolocus.config.json',
        'sandbox/demo-saas/silent-mi.config.json',
        'silent-mi.config.json',
      ];

  for (const target of candidatePaths) {
    if (existsSync(target)) {
      try {
        return JSON.parse(readFileSync(target, 'utf-8'));
      } catch {
        // Continue to next candidate
      }
    }
  }
  return {};
}

function findSourceFiles(dir: string): string[] {
  const files: string[] = [];
  if (!existsSync(dir)) return files;

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist' && entry.name !== '.git') {
        files.push(...findSourceFiles(full));
      }
    } else if (
      entry.isFile() &&
      (entry.name.endsWith('.html') || entry.name.endsWith('.tsx') || entry.name.endsWith('.jsx'))
    ) {
      files.push(full);
    }
  }
  return files;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { command, flags } = parseArgs(args);

  const configPath = typeof flags['config'] === 'string' ? flags['config'] : undefined;
  const config = loadConfig(configPath);

  const scanDir = (flags['dir'] as string) || config.scanDir || 'sandbox/demo-saas';
  const manifestsDir = (flags['out'] as string) || config.manifestsDir || 'sandbox/demo-saas/public/manifests';
  const modelsDir = (flags['models-dir'] as string) || config.modelsDir || 'sandbox/demo-saas/public/models';
  const modelId = (flags['model'] as string) || config.modelId;
  const explicitHarness = (flags['harness'] as string) || config.harnessPath;
  const harnessPath =
    explicitHarness && existsSync(explicitHarness)
      ? explicitHarness
      : existsSync(join(scanDir, 'picolocus.harness.json'))
        ? join(scanDir, 'picolocus.harness.json')
        : existsSync(join(scanDir, 'silent-mi.harness.json'))
          ? join(scanDir, 'silent-mi.harness.json')
          : undefined;

  switch (command) {
    case 'scan': {
      console.log(`[+] Scanning source files in: ${scanDir}`);
      const scanner = new AstScanner();
      const chunker = new ProseChunker();
      const files = findSourceFiles(scanDir);

      const items: ManifestItem[] = [];
      for (const file of files) {
        items.push(...scanner.scanFile(file));
        items.push(...chunker.chunkFile(file));
      }

      console.log(`[OK] Harvested ${items.length} items from ${files.length} files.`);

      const model = NodeEmbedderDiscoverer.discoverLocalModel(modelsDir, modelId);
      if (model) {
        console.log(`[OK] Linked local ONNX model: ${model.modelId} (SHA-256: ${model.modelSha256})`);
      } else {
        console.log('[INFO] No ONNX model linked. Compiling lexical manifests.');
      }

      await ManifestCompiler.compile(items, { outDir: manifestsDir, model, harnessPath });
      console.log(`[OK] Compiled physically separated manifests in: ${manifestsDir}`);
      break;
    }

    case 'verify': {
      console.log(`[+] Verifying manifests in: ${manifestsDir}`);
      const { valid, errors } = ManifestCompiler.verify(manifestsDir);
      if (!valid) {
        console.error('[FAIL] Manifest verification failed with errors:');
        for (const e of errors) {
          console.error(`  - ${e}`);
        }
        process.exit(1);
      }
      console.log('[OK] 0 RBAC leaks detected. Int8 vector bounds verified.');
      break;
    }

    case 'smoke': {
      const goldensPath = typeof flags['goldens'] === 'string' ? flags['goldens'] : undefined;
      const maxRssMb = typeof flags['max-rss-mb'] === 'string' ? parseInt(flags['max-rss-mb'], 10) : 250;
      const maxLatencyMs = typeof flags['max-latency-ms'] === 'string' ? parseInt(flags['max-latency-ms'], 10) : 35;
      const requireOnnx = Boolean(flags['require-onnx']);

      const res = await SmokeRunner.run({
        manifestsDir,
        modelsDir,
        goldensPath,
        modelId,
        maxRssMb,
        maxLatencyMs,
        requireOnnx,
      });

      if (!res.passed) {
        console.error(res.message);
        process.exit(1);
      }
      break;
    }

    case 'test-queries': {
      const queriesPath =
        (flags['queries'] as string) ||
        config.queriesPath ||
        join(scanDir, 'golden-queries.json');
      const requireOnnx = Boolean(flags['require-onnx']);

      const res = await TestQueriesRunner.run({
        manifestsDir,
        queriesPath,
        modelsDir,
        modelId,
        requireOnnx,
      });

      if (!res.passed) {
        console.error(res.message);
        process.exit(1);
      }
      break;
    }

    case 'suggest': {
      console.log(`[+] Auditing untagged interactive controls in: ${scanDir}`);
      const scanner = new AstScanner();
      const files = findSourceFiles(scanDir);
      let untaggedCount = 0;

      for (const file of files) {
        const items = scanner.scanFile(file);
        for (const it of items) {
          if (!it.roles && !it.requiredTier) {
            untaggedCount++;
          }
        }
      }
      console.log(`[OK] Found ${untaggedCount} untagged controls. All default to public tier.`);
      break;
    }

    default:
      console.log(`
@picolocus/cli v1.0.0

Usage: picolocus <command> [options] (aliases: pico, silent-mi)

Commands:
  scan          Scans HTML/TSX ASTs, discovers ONNX models, and compiles manifests
  verify        Verifies zero RBAC leaks and valid Int8 vector bounds in manifests
  smoke         Runs golden model tests and RSS memory smoke harness
  test-queries  Evaluates golden queries against manifests and live state
  suggest       Audits controls without explicit role/tier tags
      `);
      break;
  }
}

main().catch((err) => {
  console.error('[ERROR]', err);
  process.exit(1);
});
