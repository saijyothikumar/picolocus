/**
 * @silent-mi/cli - Physical RBAC Manifest Compiler & Verifier
 * Invariant: manifest.public.json and manifest.docs.json contain STRICTLY public items.
 * Restricted controls/doc clauses are physically isolated into manifest.<role>.json.
 */

import { ManifestItem, RoleManifest } from '@silent-mi/core';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DiscoveredModel } from './node-embedder.js';

export interface CompilerOptions {
  outDir: string;
  model?: DiscoveredModel | null;
}

export class ManifestCompiler {
  /**
   * Compiles scanned items into physically separated manifests.
   */
  static compile(items: ManifestItem[], options: CompilerOptions): Record<string, RoleManifest> {
    const { outDir, model } = options;
    if (!existsSync(outDir)) {
      mkdirSync(outDir, { recursive: true });
    }

    const modelId = model?.modelId || 'none';
    const modelSha256 = model?.modelSha256 || 'none';
    const dimensions = model?.dimensions || 0;

    const publicControls: ManifestItem[] = [];
    const publicDocs: ManifestItem[] = [];
    const roleMap = new Map<string, ManifestItem[]>();

    for (const item of items) {
      const isPublic = !item.roles || item.roles.length === 0 || item.roles.includes('public');

      if (isPublic) {
        if (item.targetType === 'doc_clause') {
          publicDocs.push(item);
        } else {
          publicControls.push(item);
        }
      } else {
        // Restricted item: isolate into manifest.<role>.json
        for (const role of item.roles!) {
          const rLower = role.toLowerCase().trim();
          if (rLower === 'public') continue;

          let list = roleMap.get(rLower);
          if (!list) {
            list = [];
            roleMap.set(rLower, list);
          }
          list.push(item);
        }
      }
    }

    const manifests: Record<string, RoleManifest> = {};

    // 1. Emit manifest.public.json
    const publicManifest: RoleManifest = {
      version: '1.0',
      role: 'public',
      modelId,
      modelSha256,
      dimensions,
      items: publicControls,
    };
    manifests['manifest.public.json'] = publicManifest;
    writeFileSync(join(outDir, 'manifest.public.json'), JSON.stringify(publicManifest, null, 2));

    // 2. Emit manifest.docs.json
    const docsManifest: RoleManifest = {
      version: '1.0',
      role: 'public',
      modelId,
      modelSha256,
      dimensions,
      items: publicDocs,
    };
    manifests['manifest.docs.json'] = docsManifest;
    writeFileSync(join(outDir, 'manifest.docs.json'), JSON.stringify(docsManifest, null, 2));

    // 3. Emit isolated manifest.<role>.json
    for (const [role, roleItems] of roleMap.entries()) {
      const roleFileName = `manifest.${role}.json`;
      const roleManifest: RoleManifest = {
        version: '1.0',
        role,
        modelId,
        modelSha256,
        dimensions,
        items: roleItems,
      };
      manifests[roleFileName] = roleManifest;
      writeFileSync(join(outDir, roleFileName), JSON.stringify(roleManifest, null, 2));
    }

    return manifests;
  }

  /**
   * Verifies compiled manifests for zero RBAC leaks and valid Int8 vector bounds.
   */
  static verify(manifestsDir: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!existsSync(manifestsDir)) {
      return { valid: false, errors: [`Manifests directory not found: ${manifestsDir}`] };
    }

    const publicPath = join(manifestsDir, 'manifest.public.json');
    const docsPath = join(manifestsDir, 'manifest.docs.json');

    if (!existsSync(publicPath)) {
      errors.push('Missing manifest.public.json');
    }
    if (!existsSync(docsPath)) {
      errors.push('Missing manifest.docs.json');
    }

    const files = readdirSync(manifestsDir).filter((f) => f.startsWith('manifest.') && f.endsWith('.json'));

    for (const file of files) {
      const fullPath = join(manifestsDir, file);
      try {
        const content = JSON.parse(readFileSync(fullPath, 'utf-8')) as RoleManifest;

        if (content.version !== '1.0') {
          errors.push(`${file}: Invalid version "${content.version}", expected "1.0"`);
        }

        const isPublicManifest = file === 'manifest.public.json' || file === 'manifest.docs.json';

        for (const item of content.items || []) {
          // Check 1: Zero RBAC leak check
          if (isPublicManifest && item.roles && item.roles.length > 0) {
            const hasRestrictedRole = item.roles.some((r) => r.toLowerCase() !== 'public');
            if (hasRestrictedRole) {
              errors.push(
                `RBAC LEAK in ${file}: Restricted item "${item.id}" (roles: ${item.roles.join(', ')}) found in public manifest!`
              );
            }
          }

          // Check 2: Int8 vector bounds check
          if (item.vector) {
            if (item.vector.length !== content.dimensions) {
              errors.push(
                `${file}: Item "${item.id}" vector length (${item.vector.length}) does not match manifest dimensions (${content.dimensions})`
              );
            }
            for (let vIdx = 0; vIdx < item.vector.length; vIdx++) {
              const val = item.vector[vIdx]!;
              if (val < -128 || val > 127 || !Number.isInteger(val)) {
                errors.push(`${file}: Item "${item.id}" vector element ${vIdx} (${val}) out of Int8 bounds [-128, 127]`);
              }
            }
          }
        }
      } catch (err: any) {
        errors.push(`Failed to parse ${file}: ${err.message}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
