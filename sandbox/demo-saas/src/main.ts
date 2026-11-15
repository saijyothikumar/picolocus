/**
 * Demo SaaS Workbench Application Entry Point
 * License: Apache-2.0
 */

import { initSilentMI, SilentMIController } from '@silent-mi/web';
import { createOnnxEmbedder, estimateOnnxRamFootprintMb, measureClientMemory } from '@silent-mi/onnx';
import type { EmbedderPlugin } from '@silent-mi/core';

// Global reference for debugging and E2E access
let controller: SilentMIController | null = null;

// Tab Routing
function setupTabs(): void {
  const links = document.querySelectorAll<HTMLAnchorElement>('nav a');
  const panes = document.querySelectorAll<HTMLElement>('.tab-pane');

  function activateTab(hash: string) {
    const targetHash = hash || '#/general';
    links.forEach((l) => {
      l.classList.toggle('active', l.getAttribute('href') === targetHash);
    });

    panes.forEach((p) => {
      const paneId = `tab-${targetHash.replace('#/', '')}`;
      p.classList.toggle('active', p.id === paneId);
    });
  }

  window.addEventListener('hashchange', () => {
    activateTab(window.location.hash);
  });

  // Initial tab
  activateTab(window.location.hash);
}

// 240ms Animated Collapsible Drawer
function setupDrawer(): void {
  const secTrigger = document.getElementById('sec-trigger');
  const secDrawer = document.getElementById('sec-drawer');
  const secDrawerClose = document.getElementById('sec-drawer-close');

  if (!secTrigger || !secDrawer) return;

  let isOpen = false;

  function openDrawer() {
    isOpen = true;
    secDrawer!.style.display = 'block';
    // Trigger CSS transition
    requestAnimationFrame(() => {
      secDrawer!.style.opacity = '1';
      secDrawer!.style.maxHeight = '300px';
    });
  }

  function closeDrawer() {
    isOpen = false;
    secDrawer!.style.opacity = '0';
    secDrawer!.style.maxHeight = '0';
    setTimeout(() => {
      if (!isOpen) {
        secDrawer!.style.display = 'none';
      }
    }, 240);
  }

  secTrigger.addEventListener('click', () => {
    if (isOpen) {
      closeDrawer();
    } else {
      openDrawer();
    }
  });

  if (secDrawerClose) {
    secDrawerClose.addEventListener('click', closeDrawer);
  }
}

// Role & Tier Switchers
function setupControls(): void {
  const roleSelect = document.getElementById('role-switcher') as HTMLSelectElement | null;
  const tierSelect = document.getElementById('tier-switcher') as HTMLSelectElement | null;
  const adminNav = document.getElementById('nav-admin');

  function updateContext() {
    const role = roleSelect?.value || 'viewer';
    const tier = tierSelect?.value || 'free';

    // Update nav visibility for admin
    if (adminNav) {
      adminNav.style.display = role === 'admin' ? 'inline-block' : 'none';
      if (role !== 'admin' && window.location.hash === '#/admin') {
        window.location.hash = '#/general';
      }
    }

    if (controller) {
      controller.setUserContext({
        roles: [role],
        tier,
      });
    }
  }

  roleSelect?.addEventListener('change', updateContext);
  tierSelect?.addEventListener('change', updateContext);

  updateContext();
}

// Silent MI Initialization with optional ONNX
async function initSdk(): Promise<void> {
  const urlParams = new URLSearchParams(window.location.search);
  const useOnnx = urlParams.has('onnx') && urlParams.get('onnx') !== 'false';
  const ramBadge = document.getElementById('ram-telemetry');

  let embedderPlugin: EmbedderPlugin | undefined = undefined;

  if (useOnnx) {
    try {
      embedderPlugin = createOnnxEmbedder({
        onnxModelId: 'bge-micro-v2',
        localModelPath: '/models/model_quantized.onnx',
        idleTimeoutMs: 120000,
      });

      const updateRamBadge = async () => {
        if (!ramBadge) return;
        const estMb = estimateOnnxRamFootprintMb(embedderPlugin);
        const mem = await measureClientMemory();
        const memStr = mem !== null ? ` | Heap: ${mem.toFixed(1)} MB` : '';
        ramBadge.textContent = `RAM: ~${estMb} MB (ONNX)${memStr}`;
      };

      await updateRamBadge();
      setInterval(updateRamBadge, 10000);
    } catch (err) {
      console.warn('Failed to initialize ONNX embedder:', err);
    }
  } else {
    if (ramBadge) {
      ramBadge.textContent = 'RAM: ~0 MB (Lexical)';
    }
  }

  const role = (document.getElementById('role-switcher') as HTMLSelectElement)?.value || 'viewer';
  const tier = (document.getElementById('tier-switcher') as HTMLSelectElement)?.value || 'free';

  controller = await initSilentMI({
    user: {
      roles: [role],
      tier,
    },
    manifestUrls: {
      public: '/manifests/manifest.public.json',
      docs: '/manifests/manifest.docs.json',
      byRole: {
        admin: '/manifests/manifest.admin.json',
      },
    },
    embedder: embedderPlugin,
    autoHarvestDom: true,
  });

  // Attach to window for test harness access
  (window as unknown as { __silentMI: SilentMIController }).__silentMI = controller;
}

// DOMContentLoaded lifecycle
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    setupTabs();
    setupDrawer();
    setupControls();
    initSdk();
  });
} else {
  setupTabs();
  setupDrawer();
  setupControls();
  initSdk();
}
