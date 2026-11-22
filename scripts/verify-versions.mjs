#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
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

function checkPkg(pkgPath, label, isPublishedWorkspace = false) {
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    if (pkg.version !== canonicalVersion) {
      console.error(`[MISMATCH] ${label} version is "${pkg.version}", expected "${canonicalVersion}".`);
      errors++;
    }

    if (isPublishedWorkspace) {
      if (!pkg.publishConfig || pkg.publishConfig.access !== 'public') {
        console.error(`[MISMATCH] ${label} is missing 'publishConfig: { "access": "public" }'.`);
        errors++;
      }
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

// 1. Check all published workspaces
const workspaces = ['core', 'cli', 'web', 'onnx'];
for (const ws of workspaces) {
  checkPkg(resolve(rootDir, 'packages', ws, 'package.json'), `packages/${ws}/package.json`, true);
}

// 2. Check demo app
checkPkg(resolve(rootDir, 'sandbox', 'demo-saas', 'package.json'), 'sandbox/demo-saas/package.json', false);

// 3. Check package-lock.json
try {
  const lock = JSON.parse(readFileSync(resolve(rootDir, 'package-lock.json'), 'utf8'));
  if (lock.version !== canonicalVersion) {
    console.error(`[MISMATCH] package-lock.json top-level version is "${lock.version}", expected "${canonicalVersion}".`);
    errors++;
  }
  if (lock.packages && lock.packages[''] && lock.packages[''].version !== canonicalVersion) {
    console.error(`[MISMATCH] package-lock.json packages[""].version is "${lock.packages[''].version}", expected "${canonicalVersion}".`);
    errors++;
  }
  for (const ws of workspaces) {
    const key = `packages/${ws}`;
    if (lock.packages && lock.packages[key] && lock.packages[key].version !== canonicalVersion) {
      console.error(`[MISMATCH] package-lock.json packages["${key}"].version is "${lock.packages[key].version}", expected "${canonicalVersion}".`);
      errors++;
    }
  }
} catch (err) {
  console.error('[ERROR] Failed to verify package-lock.json:', err.message);
  errors++;
}

// 4. Check CLI banner in bin.ts
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

// 5. Check source file header comments in packages/ and sandbox/
function checkSourceHeaders(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      checkSourceHeaders(full);
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
      try {
        const content = readFileSync(full, 'utf8');
        const match = content.match(/\(v(\d+\.\d+\.\d+)\)/);
        if (match && match[1] !== canonicalVersion) {
          console.error(`[MISMATCH] Header in ${full.replace(rootDir, '')} has "(v${match[1]})", expected "(v${canonicalVersion})".`);
          errors++;
        }
      } catch {
        // Skip
      }
    }
  }
}

checkSourceHeaders(resolve(rootDir, 'packages'));
checkSourceHeaders(resolve(rootDir, 'sandbox'));

if (errors > 0) {
  console.error(`\n[FAIL] Found ${errors} version synchronization error(s). Run 'node scripts/sync-version.mjs ${canonicalVersion}' to fix.`);
  process.exit(1);
}

console.log(`[OK] All monorepo packages, lockfile, CLI banners, and source headers verified consistent at v${canonicalVersion}.`);
