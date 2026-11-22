#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

const targetVersion = process.argv[2]?.trim();
if (!targetVersion || !/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/.test(targetVersion)) {
  console.error('Usage: node scripts/sync-version.mjs <semver-version>');
  console.error('Example: node scripts/sync-version.mjs 1.0.4');
  process.exit(1);
}

console.log(`[+] Synchronizing monorepo version to: ${targetVersion}`);

// 1. Root package.json
const rootPkgPath = resolve(rootDir, 'package.json');
const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
rootPkg.version = targetVersion;
writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + '\n', 'utf8');
console.log('  [OK] Updated root package.json');

// 2. Workspace packages
const workspaces = ['core', 'cli', 'web', 'onnx'];
for (const ws of workspaces) {
  const wsPkgPath = resolve(rootDir, 'packages', ws, 'package.json');
  const wsPkg = JSON.parse(readFileSync(wsPkgPath, 'utf8'));
  wsPkg.version = targetVersion;

  if (wsPkg.dependencies) {
    for (const dep of Object.keys(wsPkg.dependencies)) {
      if (dep.startsWith('@picolocus/')) {
        wsPkg.dependencies[dep] = `^${targetVersion}`;
      }
    }
  }
  if (wsPkg.devDependencies) {
    for (const dep of Object.keys(wsPkg.devDependencies)) {
      if (dep.startsWith('@picolocus/')) {
        wsPkg.devDependencies[dep] = `^${targetVersion}`;
      }
    }
  }
  if (wsPkg.peerDependencies) {
    for (const dep of Object.keys(wsPkg.peerDependencies)) {
      if (dep.startsWith('@picolocus/')) {
        wsPkg.peerDependencies[dep] = `^${targetVersion}`;
      }
    }
  }

  writeFileSync(wsPkgPath, JSON.stringify(wsPkg, null, 2) + '\n', 'utf8');
  console.log(`  [OK] Updated packages/${ws}/package.json`);
}

// 3. Sandbox Demo SaaS
const demoPkgPath = resolve(rootDir, 'sandbox', 'demo-saas', 'package.json');
const demoPkg = JSON.parse(readFileSync(demoPkgPath, 'utf8'));
demoPkg.version = targetVersion;
if (demoPkg.dependencies) {
  for (const dep of Object.keys(demoPkg.dependencies)) {
    if (dep.startsWith('@picolocus/')) {
      demoPkg.dependencies[dep] = `^${targetVersion}`;
    }
  }
}
writeFileSync(demoPkgPath, JSON.stringify(demoPkg, null, 2) + '\n', 'utf8');
console.log('  [OK] Updated sandbox/demo-saas/package.json');

// 4. CLI Banner in bin.ts
const binPath = resolve(rootDir, 'packages', 'cli', 'src', 'bin.ts');
let binCode = readFileSync(binPath, 'utf8');
binCode = binCode.replace(/picolocus v\d+\.\d+\.\d+/g, `picolocus v${targetVersion}`);
writeFileSync(binPath, binCode, 'utf8');
console.log('  [OK] Updated packages/cli/src/bin.ts');

// 5. Documentation files
const docs = ['README.md', 'LLMS.md', 'AGENTS.md', 'GEMINI.md'];
for (const doc of docs) {
  const docPath = resolve(rootDir, doc);
  try {
    let docContent = readFileSync(docPath, 'utf8');
    docContent = docContent.replace(/v\d+\.\d+\.\d+/g, `v${targetVersion}`);
    docContent = docContent.replace(/@picolocus\/(\w+)@\d+\.\d+\.\d+/g, `@picolocus/$1@${targetVersion}`);
    writeFileSync(docPath, docContent, 'utf8');
    console.log(`  [OK] Updated ${doc}`);
  } catch {
    // Optional doc
  }
}

console.log(`[+] Monorepo synchronization complete: all packages at v${targetVersion}`);
