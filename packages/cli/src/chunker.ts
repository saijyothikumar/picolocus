/**
 * @picolocus/cli - Prose & Document Clause Chunker
 * Chunks paragraphs (35 to 650 chars) from HTML and Markdown into sentence clauses.
 * Strictly ignores [data-mi-untrusted] and [data-mi-ignore] subtrees.
 */

import { parse as parseHtml, HTMLElement as ParsedHTMLElement } from 'node-html-parser';
import { ManifestItem, TierPolicy } from '@picolocus/core';
import { readFileSync } from 'node:fs';
import { ScannedAuthMeta } from './scanner.js';

function fnv1a32(str: string): number {
  let hash = 0x811c9dc5;
  const len = str.length;
  for (let i = 0; i < len; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export class ProseChunker {
  /**
   * Chunks HTML document text into sentence clauses.
   */
  chunkHtml(htmlContent: string, docUrl = '/docs'): ManifestItem[] {
    const root = parseHtml(htmlContent);
    const items: ManifestItem[] = [];

    // Remove any [data-mi-ignore] or [data-mi-untrusted] elements from the tree
    const untrustedElements = root.querySelectorAll('[data-mi-untrusted], [data-mi-ignore="true"], [data-smi-ui]');
    for (const el of untrustedElements) {
      el.remove();
    }

    const containers = root.querySelectorAll('[data-mi-doc], article p, main p, section p, p');

    for (let i = 0; i < containers.length; i++) {
      const p = containers[i]!;
      if (
        p.getAttribute('data-mi-ignore') === 'true' ||
        p.hasAttribute('data-smi-ui') ||
        p.hasAttribute('data-mi-untrusted') ||
        p.getAttribute('data-mi-untrusted') === 'true'
      ) {
        continue;
      }

      // Check ancestor auth
      const auth = this.resolveAncestorAuth(p);
      if (auth.ignored) continue;

      const text = p.text?.trim() || '';
      if (text.length < 35 || text.length > 650) continue;

      const sentences = text.split(/(?<=[.!?])\s+/);
      for (let sIdx = 0; sIdx < sentences.length; sIdx++) {
        const sentence = sentences[sIdx]?.trim();
        if (!sentence || sentence.length < 25) continue;

        const clauseId = `doc-clause-${fnv1a32(sentence).toString(16)}`;
        const clauseAnchor = `clause-${sIdx + 1}`;

        items.push({
          id: clauseId,
          targetType: 'doc_clause',
          label: sentence.slice(0, 60) + (sentence.length > 60 ? '...' : ''),
          verbatimText: sentence,
          docUrl,
          clauseAnchor,
          roles: auth.roles,
          requiredTier: auth.tier,
          tierPolicy: auth.tierPolicy,
          source: 'manifest',
        });
      }
    }

    return items;
  }

  /**
   * Chunks markdown document text into sentence clauses.
   */
  chunkMarkdown(markdownContent: string, docUrl = '/docs'): ManifestItem[] {
    const items: ManifestItem[] = [];
    const paragraphs = markdownContent.split(/\n\s*\n/);

    for (const para of paragraphs) {
      const trimmed = para.replace(/^[#*-]\s+/gm, '').trim();
      if (trimmed.length < 35 || trimmed.length > 650) continue;

      const sentences = trimmed.split(/(?<=[.!?])\s+/);
      for (let sIdx = 0; sIdx < sentences.length; sIdx++) {
        const sentence = sentences[sIdx]?.trim();
        if (!sentence || sentence.length < 25) continue;

        const clauseId = `md-clause-${fnv1a32(sentence).toString(16)}`;
        items.push({
          id: clauseId,
          targetType: 'doc_clause',
          label: sentence.slice(0, 60) + (sentence.length > 60 ? '...' : ''),
          verbatimText: sentence,
          docUrl,
          clauseAnchor: `clause-${sIdx + 1}`,
          source: 'manifest',
        });
      }
    }

    return items;
  }

  chunkFile(filePath: string, docUrl?: string): ManifestItem[] {
    const content = readFileSync(filePath, 'utf-8');
    const normalizedUrl = (docUrl || filePath).replace(/\\/g, '/');
    if (filePath.endsWith('.md')) {
      return this.chunkMarkdown(content, normalizedUrl);
    }
    return this.chunkHtml(content, normalizedUrl);
  }

  private resolveAncestorAuth(el: ParsedHTMLElement): ScannedAuthMeta {
    let curr: ParsedHTMLElement | null = el;
    let ignored = false;
    let roles: string[] | undefined;
    let tier: string | undefined;
    let tierPolicy: TierPolicy | undefined;

    while (curr) {
      if (
        curr.getAttribute('data-mi-ignore') === 'true' ||
        curr.hasAttribute('data-smi-ui') ||
        curr.hasAttribute('data-mi-untrusted') ||
        curr.getAttribute('data-mi-untrusted') === 'true'
      ) {
        ignored = true;
        break;
      }
      if (!roles && curr.hasAttribute('data-mi-roles')) {
        roles = curr
          .getAttribute('data-mi-roles')!
          .split(',')
          .map((r) => r.trim().toLowerCase())
          .filter(Boolean);
      }
      if (!tier && curr.hasAttribute('data-mi-tier')) {
        tier = curr.getAttribute('data-mi-tier')!.trim().toLowerCase();
      }
      if (!tierPolicy && curr.hasAttribute('data-mi-tier-policy')) {
        const pol = curr.getAttribute('data-mi-tier-policy')!.trim().toLowerCase();
        if (pol === 'hide' || pol === 'upsell') {
          tierPolicy = pol;
        }
      }
      curr = curr.parentNode instanceof ParsedHTMLElement ? curr.parentNode : null;
    }

    return { ignored, roles, tier, tierPolicy };
  }
}
