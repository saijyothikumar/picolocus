#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

const rootPkg = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8'));
const canonicalVersion = rootPkg.version;

if (!canonicalVersion) {
  console.error('[ERROR] Root package.json is missing a "version" field.');
  process.exit(1);
}

let errors = 0;

function checkPkg(pkgPath, label) {
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    if (pkg.version !== canonicalVersion) {
      console.error(`[MISMATCH] ${label} version is "${pkg.version}", expected "${canonicalVersion}".`);
      errors++;
    }

    const checkDeps = (depsObj, kind) => {
      if (!depsObj) return;
      for (const [name, req] of Object.entries(depsObj)) {
        if (name.startsWith('@picolocus/')) {
          const expected = `^${canonicalVersion}`;
          if (req !== expected && req !== canonicalVersion) {
            console.error(`[MISMATCH] ${label} ${kind}["${name}"] is "${req}", expected "${expected}".`);
            errors++;
          }
        }
      }
    };

    checkDeps(pkg.dependencies, 'dependencies');
    checkDeps(pkg.devDependencies, 'devDependencies');
    checkDeps(pkg.peerDependencies, 'peerDependencies');
  } catch (err) {
    console.error(`[ERROR] Failed to read ${label}:`, err.message);
    errors++;
  }
}

// Check all workspaces
const workspaces = ['core', 'cli', 'web', 'onnx'];
for (const ws of workspaces) {
  checkPkg(resolve(rootDir, 'packages', ws, 'package.json'), `packages/${ws}/package.json`);
}

// Check demo app
checkPkg(resolve(rootDir, 'sandbox', 'demo-saas', 'package.json'), 'sandbox/demo-saas/package.json');

// Check CLI banner in bin.ts
try {
  const binContent = readFileSync(resolve(rootDir, 'packages', 'cli', 'src', 'bin.ts'), 'utf8');
  if (!binContent.includes(`v${canonicalVersion}`)) {
    console.error(`[MISMATCH] packages/cli/src/bin.ts does not contain "v${canonicalVersion}".`);
    errors++;
  }
} catch (err) {
  console.error('[ERROR] Failed to check bin.ts:', err.message);
  errors++;
}

if (errors > 0) {
  console.error(`\n[FAIL] Found ${errors} version synchronization error(s). Run 'node scripts/sync-version.mjs ${canonicalVersion}' to fix.`);
  process.exit(1);
}

console.log(`[OK] All monorepo packages, dependencies, and CLI banners verified consistent at v${canonicalVersion}.`);
