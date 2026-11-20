# @picolocus/web

> Zero-dependency Pure CSS Highlighter, DOM Indexer, N-step Breadcrumb Guidance, and Docked Locator Bar for Picolocus.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](../../LICENSE)
[![Bundle Size](https://img.shields.io/badge/bundle%20size-24.7%20KB%20gzipped-success.svg)](#)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](#)

## Features

- **Non-Destructive Highlighting:** Highlights UI controls with CSS attributes (`[data-pico-active="true"]`) without `<mark>` tag wrapping.
- **Verbatim Text Highlights:** Highlights document clauses via native browser `CSS.highlights` Range API.
- **Zero Focus Stealing:** Users can continue typing in host inputs while matches are highlighted.
- **N-Step Breadcrumb Stepping:** Guides users across closed drawers, tabs, and modals via visual breadcrumbs without auto-clicking host buttons.
- **Docked Locator Bar:** Floating/docked search interface with keyboard shortcuts (Ctrl+K), Prev/Next stepping, and expandable Details list.

## Installation

```bash
npm install @picolocus/web
```

Or drop in a single script tag:

```html
<script src="/picolocus.iife.js" data-pico-auto></script>
```

## Quick Start

```typescript
import { initPicolocus } from '@picolocus/web';

const pico = await initPicolocus({
  manifestUrls: {
    public: '/manifests/manifest.public.json',
    docs: '/manifests/manifest.docs.json',
    byRole: { admin: '/manifests/manifest.admin.json' },
  },
  showBar: true,
  autoHarvestDom: true,
  routingMode: 'hash',
});

// Query and guide visually
const res = await pico.query('export audit logs');
if (res.matches.length > 0) {
  await pico.guide(res.matches[0]);
}
```

## License

Apache-2.0
