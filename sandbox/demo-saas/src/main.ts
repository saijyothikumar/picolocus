/**
 * Demo SaaS Workbench Application Entry Point (v1.0.3)
 * License: Apache-2.0
 */

import { initPicolocus, PicolocusClient } from '@picolocus/web';
import { createOnnxEmbedder, estimateOnnxRamFootprintMb, measureClientMemory } from '@picolocus/onnx';
import type { EmbedderPlugin } from '@picolocus/core';

// Global reference for debugging and E2E access
let controller: PicolocusClient | null = null;
let activeEmbedder: EmbedderPlugin | null = null;
let isSsoConfigured = false;
let is2faEnabled = true;

// Tab Routing
function setupTabs(): (hash: string) => void {
  const links = document.querySelectorAll<HTMLAnchorElement>('nav a');
  const panes = document.querySelectorAll<HTMLElement>('.tab-pane');

  function activateTab(hash: string) {
    const raw = hash.replace(/^#\/?/, '').replace(/^\//, '');
    const cleanRoute = raw ? `#/${raw}` : '#/general';

    links.forEach((l) => {
      l.classList.toggle('active', l.getAttribute('href') === cleanRoute);
    });

    panes.forEach((p) => {
      const routeName = cleanRoute.replace('#/', '');
      const isActive = p.id === `pane-${routeName}` || p.id === `tab-${routeName}`;
      p.classList.toggle('active', isActive);
    });

    if (window.location.hash !== cleanRoute) {
      window.location.hash = cleanRoute;
    }
  }

  links.forEach((l) => {
    l.addEventListener('click', () => {
      const href = l.getAttribute('href');
      if (href) activateTab(href);
    });
  });

  window.addEventListener('hashchange', () => {
    activateTab(window.location.hash);
  });

  // Initial tab
  activateTab(window.location.hash);
  return activateTab;
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

// Interactive Tax Modal
function setupTaxModal(): void {
  const btnOpenTax = document.getElementById('btn-open-tax-modal');
  const taxDialog = document.getElementById('tax-dialog') as HTMLDialogElement | null;
  const btnCloseTax = document.getElementById('btn-close-tax');

  btnOpenTax?.addEventListener('click', () => {
    taxDialog?.showModal();
  });

  btnCloseTax?.addEventListener('click', () => {
    taxDialog?.close();
  });
}

// Business Consent Controls
function setupConsentControls(): void {
  const btnGrantConsent = document.getElementById('btn-grant-consent');
  const btnRevokeConsent = document.getElementById('btn-revoke-consent');
  const consentStatus = document.getElementById('consent-status');
  const ramBadge = document.getElementById('ram-telemetry');

  btnGrantConsent?.addEventListener('click', async () => {
    if (controller) {
      if (consentStatus) consentStatus.textContent = 'AI: Consented';
      if (btnGrantConsent) btnGrantConsent.style.display = 'none';
      if (btnRevokeConsent) btnRevokeConsent.style.display = 'inline-block';
      await controller.grantConsent();
      if (ramBadge && activeEmbedder) {
        const estMb = estimateOnnxRamFootprintMb(activeEmbedder);
        ramBadge.textContent = `RAM: ~${estMb} MB (ONNX)`;
      }
    }
  });

  btnRevokeConsent?.addEventListener('click', async () => {
    if (controller) {
      if (consentStatus) consentStatus.textContent = 'AI: Opt-In';
      if (btnGrantConsent) btnGrantConsent.style.display = 'inline-block';
      if (btnRevokeConsent) btnRevokeConsent.style.display = 'none';
      if (ramBadge) ramBadge.textContent = 'RAM: ~0 MB (Revoked)';
      await controller.revokeConsent();
    }
  });
}

// Dynamic SSO & 2FA Controls
function setupSecurityControls(): void {
  const toggleSso = document.getElementById('toggle-sso');
  const ssoIdpContainer = document.getElementById('sso-idp-container');
  const btnSetup2fa = document.getElementById('btn-setup-2fa');

  toggleSso?.addEventListener('click', () => {
    isSsoConfigured = !isSsoConfigured;
    toggleSso.textContent = isSsoConfigured ? 'Disable SSO' : 'Enable SSO';
    toggleSso.setAttribute('aria-checked', String(isSsoConfigured));
    if (ssoIdpContainer) {
      ssoIdpContainer.style.display = isSsoConfigured ? 'block' : 'none';
    }
    controller?.setAppState({ ssoConfigured: isSsoConfigured });
  });

  btnSetup2fa?.addEventListener('click', () => {
    is2faEnabled = !is2faEnabled;
    btnSetup2fa.textContent = is2faEnabled ? 'Disable 2FA' : 'Enable 2FA';
    btnSetup2fa.setAttribute('data-mi-state', is2faEnabled ? 'enabled' : 'disabled');
    controller?.setAppState({ is2faEnabled });
  });
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
      void controller.setUserContext({
        roles: [role],
        tier,
      });
      controller.setAppState({
        tier,
        role,
        ssoConfigured: isSsoConfigured,
        is2faEnabled,
      });
    }
  }

  roleSelect?.addEventListener('change', updateContext);
  tierSelect?.addEventListener('change', updateContext);

  updateContext();
}

// Picolocus Initialization with mdbr-leaf-ir ONNX
async function initSdk(activateTab: (hash: string) => void): Promise<void> {
  const urlParams = new URLSearchParams(window.location.search);
  const useOnnx = urlParams.has('onnx') && urlParams.get('onnx') !== 'false';
  const ramBadge = document.getElementById('ram-telemetry');

  const baseUrl = import.meta.env.BASE_URL.endsWith('/')
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`;

  const absoluteModelsUrl = new URL(`${baseUrl}models`, window.location.origin).href;

  if (useOnnx) {
    try {
      const isEager = urlParams.get('consent') === 'eager';
      activeEmbedder = createOnnxEmbedder({
        modelId: 'mdbr-leaf-ir',
        localModelPath: absoluteModelsUrl,
        idleTimeoutMs: 120000,
        consentMode: isEager ? 'eager' : 'opt-in',
        consentGranted: isEager,
      });

      const updateRamBadge = async () => {
        if (!ramBadge) return;
        const estMb = estimateOnnxRamFootprintMb(activeEmbedder);
        const mem = await measureClientMemory();
        const memStr = mem !== null ? ` | Heap: ${mem.toFixed(1)} MB` : '';
        ramBadge.textContent = `RAM: ~${estMb} MB (ONNX)${memStr}`;
      };

      await updateRamBadge();
      setInterval(updateRamBadge, 10000);

      const consentStatus = document.getElementById('consent-status');
      const btnGrantConsent = document.getElementById('btn-grant-consent');
      const btnRevokeConsent = document.getElementById('btn-revoke-consent');
      if (isEager && consentStatus && btnGrantConsent && btnRevokeConsent) {
        consentStatus.textContent = 'AI: Consented';
        btnGrantConsent.style.display = 'none';
        btnRevokeConsent.style.display = 'inline-block';
      }
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

  controller = await initPicolocus({
    user: {
      roles: [role],
      tier,
      appState: {
        tier,
        role,
        ssoConfigured: isSsoConfigured,
        is2faEnabled,
      },
    },
    manifestUrls: {
      public: `${baseUrl}manifests/manifest.public.json`,
      docs: `${baseUrl}manifests/manifest.docs.json`,
      byRole: {
        admin: `${baseUrl}manifests/manifest.admin.json`,
      },
    },
    embedder: activeEmbedder || undefined,
    autoHarvestDom: true,
    routingMode: 'hash',
    onNavigate: (route) => {
      const targetHash = route.startsWith('#') ? route : `#/${route.replace(/^\//, '')}`;
      activateTab(targetHash);
    },
  });

  controller.setAppState({
    tier,
    role,
    ssoConfigured: isSsoConfigured,
    is2faEnabled,
  });

  // Telemetry & RAM Monitoring Instrumentation
  interface TelemetryRecord {
    query: string;
    durationMs: number;
    usedJSHeapMB: number | null;
    decision: string;
    matchCount: number;
    topMatch?: string;
    topScore?: number;
    timestamp: number;
  }

  const telemetryStore = {
    records: [] as TelemetryRecord[],
    lastMemoryMB: null as number | null,
    async logSpike(tag: string): Promise<void> {
      const mem = await measureClientMemory();
      console.log(`%c[Picolocus Memory Check]%c ${tag} -> ${mem !== null ? mem.toFixed(1) + ' MB' : 'N/A'}`, 'color: #ec4899; font-weight: bold;', 'color: inherit;');
    },
    clear(): void {
      this.records = [];
    },
  };

  const originalQuery = controller.query.bind(controller);
  controller.query = async (text: string, user?: any) => {
    const t0 = performance.now();
    const memBefore = await measureClientMemory();
    const res = await originalQuery(text, user);
    const durationMs = performance.now() - t0;
    const memAfter = await measureClientMemory();

    const record: TelemetryRecord = {
      query: text,
      durationMs: Math.round(durationMs * 100) / 100,
      usedJSHeapMB: memAfter,
      decision: res.decision,
      matchCount: res.matches.length,
      topMatch: res.matches[0]?.label,
      topScore: res.matches[0]?.score ? Math.round(res.matches[0].score * 100) / 100 : undefined,
      timestamp: Date.now(),
    };

    telemetryStore.records.push(record);
    telemetryStore.lastMemoryMB = memAfter;

    // Real-time console monitoring
    const memDeltaStr =
      memBefore !== null && memAfter !== null
        ? ` | Heap: ${memAfter.toFixed(1)} MB (${memAfter >= memBefore ? '+' : ''}${(memAfter - memBefore).toFixed(1)} MB)`
        : '';
    console.log(
      `%c[Picolocus Telemetry]%c "${text}" -> ${res.decision} (${res.matches.length} matches, top: "${res.matches[0]?.label || 'none'}") in ${durationMs.toFixed(2)}ms${memDeltaStr}`,
      'color: #06b6d4; font-weight: bold;',
      'color: inherit;'
    );

    // Update on-screen RAM badge
    if (ramBadge) {
      const estMb = estimateOnnxRamFootprintMb(activeEmbedder);
      const heapStr = memAfter !== null ? ` | Heap: ${memAfter.toFixed(1)} MB` : '';
      const modeStr = activeEmbedder && controller?.isConsented() ? `~${estMb} MB (ONNX)` : `~0 MB (Lexical)`;
      ramBadge.textContent = `RAM: ${modeStr}${heapStr} | ${durationMs.toFixed(1)}ms`;
    }

    return res;
  };

  // Attach to window for test harness and telemetry access
  (window as any).__picolocus = controller;
  (window as any).__picolocus_telemetry = telemetryStore;
  (window as any).__silentMI = controller;
  (window as any).__silentMI_telemetry = telemetryStore;
}

// DOMContentLoaded lifecycle
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    const activateTab = setupTabs();
    setupDrawer();
    setupTaxModal();
    setupConsentControls();
    setupSecurityControls();
    setupControls();
    void initSdk(activateTab);
  });
} else {
  const activateTab = setupTabs();
  setupDrawer();
  setupTaxModal();
  setupConsentControls();
  setupSecurityControls();
  setupControls();
  void initSdk(activateTab);
}
