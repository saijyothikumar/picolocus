#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

const targetVersion = process.argv[2]?.trim();
if (!targetVersion || !/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/.test(targetVersion)) {
  console.error('Usage: node scripts/sync-version.mjs <semver-version>');
  console.error('Example: node scripts/sync-version.mjs 1.0.4');
  process.exit(1);
}

console.log(`[+] Synchronizing entire monorepo to version: v${targetVersion}`);

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
  wsPkg.publishConfig = { access: 'public' };

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

// 4. package-lock.json (Lockfile parity)
const lockPath = resolve(rootDir, 'package-lock.json');
try {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  lock.version = targetVersion;
  if (lock.packages && lock.packages['']) {
    lock.packages[''].version = targetVersion;
  }
  for (const ws of workspaces) {
    const key = `packages/${ws}`;
    if (lock.packages && lock.packages[key]) {
      lock.packages[key].version = targetVersion;
      if (lock.packages[key].dependencies) {
        for (const dep of Object.keys(lock.packages[key].dependencies)) {
          if (dep.startsWith('@picolocus/')) {
            lock.packages[key].dependencies[dep] = `^${targetVersion}`;
          }
        }
      }
    }
  }
  if (lock.packages && lock.packages['sandbox/demo-saas']) {
    lock.packages['sandbox/demo-saas'].version = targetVersion;
    if (lock.packages['sandbox/demo-saas'].dependencies) {
      for (const dep of Object.keys(lock.packages['sandbox/demo-saas'].dependencies)) {
        if (dep.startsWith('@picolocus/')) {
          lock.packages['sandbox/demo-saas'].dependencies[dep] = `^${targetVersion}`;
        }
      }
    }
  }
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n', 'utf8');
  console.log('  [OK] Updated package-lock.json');
} catch (err) {
  console.warn('  [WARN] Failed to update package-lock.json:', err.message);
}

// 5. CLI Banner in bin.ts
const binPath = resolve(rootDir, 'packages', 'cli', 'src', 'bin.ts');
let binCode = readFileSync(binPath, 'utf8');
binCode = binCode.replace(/@picolocus\/cli v\d+\.\d+\.\d+/g, `@picolocus/cli v${targetVersion}`);
binCode = binCode.replace(/console\.log\('v\d+\.\d+\.\d+'\);/g, `console.log('v${targetVersion}');`);
binCode = binCode.replace(/picolocus v\d+\.\d+\.\d+/g, `picolocus v${targetVersion}`);
writeFileSync(binPath, binCode, 'utf8');
console.log('  [OK] Updated packages/cli/src/bin.ts');

// 6. Documentation files & Tarball references
const docs = [
  'README.md',
  'LLMS.md',
  'AGENTS.md',
  'GEMINI.md',
  'packages/core/README.md',
  'packages/cli/README.md',
  'packages/web/README.md',
  'packages/onnx/README.md',
];
for (const doc of docs) {
  const docPath = resolve(rootDir, doc);
  try {
    let docContent = readFileSync(docPath, 'utf8');
    docContent = docContent.replace(/picolocus-web-\d+\.\d+\.\d+\.tgz/g, `picolocus-web-${targetVersion}.tgz`);
    docContent = docContent.replace(/picolocus-core-\d+\.\d+\.\d+\.tgz/g, `picolocus-core-${targetVersion}.tgz`);
    docContent = docContent.replace(/picolocus-cli-\d+\.\d+\.\d+\.tgz/g, `picolocus-cli-${targetVersion}.tgz`);
    docContent = docContent.replace(/picolocus-onnx-\d+\.\d+\.\d+\.tgz/g, `picolocus-onnx-${targetVersion}.tgz`);
    docContent = docContent.replace(/@picolocus\/(\w+)@\d+\.\d+\.\d+/g, `@picolocus/$1@${targetVersion}`);
    writeFileSync(docPath, docContent, 'utf8');
    console.log(`  [OK] Updated ${doc}`);
  } catch {
    // Optional doc
  }
}

// 7. Source file headers in packages/ and sandbox/
function updateHeaders(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      updateHeaders(full);
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
      try {
        const content = readFileSync(full, 'utf8');
        if (/\(v\d+\.\d+\.\d+\)/.test(content)) {
          const updated = content.replace(/\(v\d+\.\d+\.\d+\)/g, `(v${targetVersion})`);
          if (updated !== content) {
            writeFileSync(full, updated, 'utf8');
            console.log(`  [OK] Updated header in ${full.replace(rootDir, '')}`);
          }
        }
      } catch {
        // Skip
      }
    }
  }
}

updateHeaders(resolve(rootDir, 'packages'));
updateHeaders(resolve(rootDir, 'sandbox'));

console.log(`[+] Monorepo synchronization complete: all packages at v${targetVersion}`);
