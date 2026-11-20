/**
 * @picolocus/cli - HTML and TSX/JSX AST Scanner
 * Invariants:
 * - Inherits ancestor data-mi-ignore, data-mi-roles, data-mi-tier, and data-mi-tier-policy attributes.
 * - Strictly ignores [data-mi-untrusted] subtrees to enforce UGC isolation.
 * - Extracts trigger chains (data-mi-triggers), user asks (data-mi-asks), and callout metadata.
 */

import { parse as parseHtml, HTMLElement as ParsedHTMLElement, Node as ParsedNode } from 'node-html-parser';
import ts from 'typescript';
import { ActionKind, ManifestItem, TargetType, TierPolicy } from '@picolocus/core';
import { readFileSync } from 'node:fs';

export interface ScannedAuthMeta {
  ignored: boolean;
  roles?: string[];
  tier?: string;
  tierPolicy?: TierPolicy;
  route?: string;
}

export class AstScanner {
  /**
   * Scans an HTML string or file.
   */
  scanHtml(htmlContent: string, filePath?: string): ManifestItem[] {
    const root = parseHtml(htmlContent);
    const items: ManifestItem[] = [];

    const walk = (node: ParsedNode, inheritedAuth: ScannedAuthMeta) => {
      if (!(node instanceof ParsedHTMLElement)) return;

      const currentAuth = this.computeAuthMeta(node, inheritedAuth);
      if (currentAuth.ignored) return;

      const tagName = node.tagName?.toLowerCase();
      const isControl =
        tagName === 'button' ||
        tagName === 'a' ||
        tagName === 'input' ||
        tagName === 'select' ||
        tagName === 'textarea' ||
        node.hasAttribute('data-mi-id') ||
        node.getAttribute('role') === 'button';

      if (isControl) {
        const label =
          node.getAttribute('data-mi-label') ||
          node.getAttribute('aria-label') ||
          node.getAttribute('placeholder') ||
          node.text?.trim() ||
          '';

        if (label.length >= 2) {
          const id =
            node.getAttribute('data-mi-id') ||
            node.id ||
            `ctrl-${items.length + 1}`;

          let targetType: TargetType = 'action';
          if (
            tagName === 'input' ||
            tagName === 'select' ||
            tagName === 'textarea' ||
            node.getAttribute('role') === 'switch'
          ) {
            targetType = 'setting';
          }

          let triggerChain: string[] | undefined;
          let parentTriggerSelector: string | undefined;

          const triggersAttr = node.getAttribute('data-mi-triggers');
          if (triggersAttr) {
            triggerChain = triggersAttr
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
            if (triggerChain.length > 0) {
              parentTriggerSelector = triggerChain[0];
            }
          }

          const explicitParent = node.getAttribute('data-mi-parent');
          if (explicitParent) {
            parentTriggerSelector = explicitParent;
            if (!triggerChain) {
              triggerChain = [explicitParent];
            }
          }

          const asksAttr = node.getAttribute('data-mi-asks');
          const whenUserAsks = asksAttr
            ? asksAttr
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
            : undefined;

          const calloutTitle = node.getAttribute('data-mi-callout-title') || undefined;
          const calloutText = node.getAttribute('data-mi-callout-text') || undefined;
          const actionAttr = node.getAttribute('data-mi-action');
          const kind = actionAttr ? (actionAttr as ActionKind) : undefined;
          const liveStatus = node.getAttribute('data-mi-state') || undefined;

          const kwAttr = node.getAttribute('data-mi-keywords');
          const synonyms = kwAttr
            ? kwAttr
                .split(',')
                .map((k) => k.trim())
                .filter(Boolean)
            : undefined;

          items.push({
            id,
            targetType,
            kind,
            label,
            description: node.getAttribute('data-mi-description') || node.getAttribute('title') || undefined,
            route: node.getAttribute('href') || node.getAttribute('data-mi-route') || currentAuth.route || undefined,
            selector: node.id ? `#${node.id}` : `[data-mi-id="${id}"]`,
            parentTriggerSelector,
            triggerChain,
            whenUserAsks,
            calloutTitle,
            calloutText,
            liveStatus,
            synonyms,
            roles: currentAuth.roles,
            requiredTier: currentAuth.tier,
            tierPolicy: currentAuth.tierPolicy,
            source: 'manifest',
          });
        }
      }

      for (const child of node.childNodes) {
        walk(child, currentAuth);
      }
    };

    walk(root, { ignored: false });
    return items;
  }

  /**
   * Scans a TSX/JSX file using TypeScript compiler AST.
   */
  scanTsx(sourceText: string, filePath = 'file.tsx'): ManifestItem[] {
    const sourceFile = ts.createSourceFile(
      filePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );

    const items: ManifestItem[] = [];

    const walk = (node: ts.Node, inheritedAuth: ScannedAuthMeta) => {
      let currentAuth = inheritedAuth;

      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const opening = ts.isJsxElement(node) ? node.openingElement : node;
        const tagName = opening.tagName.getText(sourceFile);
        const attrs = this.extractJsxAttributes(opening.attributes, sourceFile);

        currentAuth = this.computeJsxAuthMeta(attrs, inheritedAuth);
        if (currentAuth.ignored) return;

        const isControl =
          tagName === 'button' ||
          tagName === 'a' ||
          tagName === 'input' ||
          tagName === 'select' ||
          tagName === 'textarea' ||
          'data-mi-id' in attrs ||
          attrs['role'] === 'button';

        if (isControl) {
          const label =
            attrs['data-mi-label'] ||
            attrs['aria-label'] ||
            attrs['placeholder'] ||
            this.extractJsxTextContent(node, sourceFile);

          if (label && label.trim().length >= 2) {
            const id = attrs['data-mi-id'] || attrs['id'] || `jsx-ctrl-${items.length + 1}`;
            let targetType: TargetType = 'action';
            if (tagName === 'input' || tagName === 'select' || tagName === 'textarea' || attrs['role'] === 'switch') {
              targetType = 'setting';
            }

            let triggerChain: string[] | undefined;
            let parentTriggerSelector: string | undefined;

            if (attrs['data-mi-triggers']) {
              triggerChain = attrs['data-mi-triggers']
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
              if (triggerChain.length > 0) {
                parentTriggerSelector = triggerChain[0];
              }
            }

            if (attrs['data-mi-parent']) {
              parentTriggerSelector = attrs['data-mi-parent'];
              if (!triggerChain) {
                triggerChain = [parentTriggerSelector];
              }
            }

            const whenUserAsks = attrs['data-mi-asks']
              ? attrs['data-mi-asks']
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean)
              : undefined;

            const calloutTitle = attrs['data-mi-callout-title'] || undefined;
            const calloutText = attrs['data-mi-callout-text'] || undefined;
            const kind = attrs['data-mi-action'] ? (attrs['data-mi-action'] as ActionKind) : undefined;
            const liveStatus = attrs['data-mi-state'] || undefined;

            const synonyms = attrs['data-mi-keywords']
              ? attrs['data-mi-keywords']
                  .split(',')
                  .map((k) => k.trim())
                  .filter(Boolean)
              : undefined;

            items.push({
              id,
              targetType,
              kind,
              label: label.trim(),
              description: attrs['data-mi-description'] || attrs['title'] || undefined,
              route: attrs['href'] || attrs['data-mi-route'] || currentAuth.route || undefined,
              selector: attrs['id'] ? `#${attrs['id']}` : `[data-mi-id="${id}"]`,
              parentTriggerSelector,
              triggerChain,
              whenUserAsks,
              calloutTitle,
              calloutText,
              liveStatus,
              synonyms,
              roles: currentAuth.roles,
              requiredTier: currentAuth.tier,
              tierPolicy: currentAuth.tierPolicy,
              source: 'manifest',
            });
          }
        }
      }

      ts.forEachChild(node, (child) => walk(child, currentAuth));
    };

    walk(sourceFile, { ignored: false });
    return items;
  }

  scanFile(filePath: string): ManifestItem[] {
    const content = readFileSync(filePath, 'utf-8');
    if (filePath.endsWith('.html') || filePath.endsWith('.htm')) {
      return this.scanHtml(content, filePath);
    }
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx')) {
      return this.scanTsx(content, filePath);
    }
    return [];
  }

  private computeAuthMeta(el: ParsedHTMLElement, parent: ScannedAuthMeta): ScannedAuthMeta {
    if (
      el.getAttribute('data-mi-ignore') === 'true' ||
      el.hasAttribute('data-smi-ui') ||
      el.hasAttribute('data-mi-untrusted') ||
      el.getAttribute('data-mi-untrusted') === 'true'
    ) {
      return { ignored: true };
    }

    let roles = parent.roles;
    if (el.hasAttribute('data-mi-roles')) {
      roles = el
        .getAttribute('data-mi-roles')!
        .split(',')
        .map((r) => r.trim().toLowerCase())
        .filter(Boolean);
    }

    let tier = parent.tier;
    if (el.hasAttribute('data-mi-tier')) {
      tier = el.getAttribute('data-mi-tier')!.trim().toLowerCase();
    }

    let tierPolicy = parent.tierPolicy;
    if (el.hasAttribute('data-mi-tier-policy')) {
      const pol = el.getAttribute('data-mi-tier-policy')!.trim().toLowerCase();
      if (pol === 'hide' || pol === 'upsell') {
        tierPolicy = pol;
      }
    }

    let route = parent.route;
    if (el.hasAttribute('data-mi-route')) {
      route = el.getAttribute('data-mi-route')!.trim();
    }

    return { ignored: false, roles, tier, tierPolicy, route };
  }

  private computeJsxAuthMeta(attrs: Record<string, string>, parent: ScannedAuthMeta): ScannedAuthMeta {
    if (
      attrs['data-mi-ignore'] === 'true' ||
      'data-smi-ui' in attrs ||
      'data-mi-untrusted' in attrs ||
      attrs['data-mi-untrusted'] === 'true'
    ) {
      return { ignored: true };
    }

    let roles = parent.roles;
    if (attrs['data-mi-roles']) {
      roles = attrs['data-mi-roles']
        .split(',')
        .map((r) => r.trim().toLowerCase())
        .filter(Boolean);
    }

    let tier = parent.tier;
    if (attrs['data-mi-tier']) {
      tier = attrs['data-mi-tier'].trim().toLowerCase();
    }

    let tierPolicy = parent.tierPolicy;
    if (attrs['data-mi-tier-policy']) {
      const pol = attrs['data-mi-tier-policy'].trim().toLowerCase();
      if (pol === 'hide' || pol === 'upsell') {
        tierPolicy = pol;
      }
    }

    let route = parent.route;
    if (attrs['data-mi-route']) {
      route = attrs['data-mi-route'].trim();
    }

    return { ignored: false, roles, tier, tierPolicy, route };
  }

  private extractJsxAttributes(attrsNode: ts.JsxAttributes, sourceFile: ts.SourceFile): Record<string, string> {
    const res: Record<string, string> = {};
    for (const prop of attrsNode.properties) {
      if (ts.isJsxAttribute(prop)) {
        const name = prop.name.getText(sourceFile);
        if (prop.initializer) {
          if (ts.isStringLiteral(prop.initializer)) {
            res[name] = prop.initializer.text;
          } else if (ts.isJsxExpression(prop.initializer) && prop.initializer.expression) {
            res[name] = prop.initializer.expression.getText(sourceFile).replace(/^['"]|['"]$/g, '');
          }
        } else {
          res[name] = 'true';
        }
      }
    }
    return res;
  }

  private extractJsxTextContent(node: ts.Node, sourceFile: ts.SourceFile): string {
    if (ts.isJsxElement(node)) {
      let text = '';
      for (const child of node.children) {
        if (ts.isJsxText(child)) {
          text += child.getText(sourceFile).trim() + ' ';
        }
      }
      return text.trim();
    }
    return '';
  }
}
