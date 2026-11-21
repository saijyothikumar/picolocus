/**
 * @picolocus/web - Non-modal bottom-right docked Locator Bar UI
 * Invariants:
 * - Strict Trusted Types & CSP compliance: ZERO innerHTML, outerHTML, or eval.
 * - Constructed purely via createElement, textContent, replaceChildren in Light DOM [data-smi-ui="true"].
 * - Keyboard shortcuts: Ctrl+K / Cmd+K (guarded !shiftKey && !altKey), Enter/Shift+Enter stepping.
 * - Expandable Details List with click-to-jump habit confirmation.
 * - Minimize to floating Locate pill while preserving session state.
 * - Opt-in consent banner for semantic AI model download.
 */

import { EmbedderPlugin, SearchMatch } from '@picolocus/core';
import { MatchStepSession } from './actions.js';

export interface SpotlightI18n {
  placeholder: string;
  locateButton: string;
  enableAiTitle: string;
  enableAiBtn: string;
  dismissAiBtn: string;
  targetNotFound: string;
}

export const DEFAULT_I18N: SpotlightI18n = {
  placeholder: 'Locate control, row, or policy (Ctrl+K)...',
  locateButton: '🔍 Locate (Ctrl+K)',
  enableAiTitle: 'Enable AI Semantic Search (~14MB model)',
  enableAiBtn: 'Enable',
  dismissAiBtn: 'Dismiss',
  targetNotFound: 'Target control not found on current page.',
};

export interface SpotlightBarCallbacks {
  onQueryChange: (query: string) => void;
  onSelectMatch: (match: SearchMatch) => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  onGrantConsent?: () => void | Promise<void>;
}

export interface SpotlightBarOptions {
  cspNonce?: string;
  hotkey?: string;
  i18n?: Partial<SpotlightI18n>;
  embedder?: EmbedderPlugin | null;
}

export class SpotlightBar {
  private container: HTMLDivElement;
  private pillButton: HTMLButtonElement;
  private inputEl: HTMLInputElement;
  private countBadge: HTMLSpanElement;
  private prevButton: HTMLButtonElement;
  private nextButton: HTMLButtonElement;
  private detailsToggleButton: HTMLButtonElement;
  private minimizeButton: HTMLButtonElement;
  private closeButton: HTMLButtonElement;
  private detailsContainer: HTMLDivElement;
  private detailsList: HTMLUListElement;
  private consentBanner: HTMLDivElement | null = null;

  private isMinimized = false;
  private isDetailsExpanded = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private callbacks: SpotlightBarCallbacks;
  private session: MatchStepSession;
  private styleSheetInjected = false;
  private globalKeydownListener: ((e: KeyboardEvent) => void) | null = null;
  private embedder: EmbedderPlugin | null;
  private i18n: SpotlightI18n;
  private cspNonce?: string;
  private hotkey: string;

  constructor(
    session: MatchStepSession,
    callbacks: SpotlightBarCallbacks,
    options: SpotlightBarOptions = {}
  ) {
    this.session = session;
    this.callbacks = callbacks;
    this.embedder = options.embedder || null;
    this.cspNonce = options.cspNonce;
    this.hotkey = options.hotkey || 'Ctrl+K';
    this.i18n = { ...DEFAULT_I18N, ...options.i18n };

    this.injectStyles();

    // 1. Build Floating Locate Pill (for minimized state)
    this.pillButton = document.createElement('button');
    this.pillButton.className = 'pico-pill silent-mi-pill';
    this.pillButton.setAttribute('data-smi-ui', 'true');
    this.pillButton.setAttribute('aria-label', this.i18n.locateButton);
    this.pillButton.textContent = this.i18n.locateButton;
    this.pillButton.style.display = 'none';
    this.pillButton.addEventListener('click', () => this.restore());

    // 2. Build Docked Locator Bar Container
    this.container = document.createElement('div');
    this.container.className = 'pico-bar silent-mi-bar';
    this.container.setAttribute('data-smi-ui', 'true');

    // Controls Row
    const headerRow = document.createElement('div');
    headerRow.className = 'pico-row silent-mi-row';
    headerRow.setAttribute('data-smi-ui', 'true');

    // Search input
    this.inputEl = document.createElement('input');
    this.inputEl.type = 'text';
    this.inputEl.className = 'pico-input silent-mi-input';
    this.inputEl.setAttribute('data-smi-ui', 'true');
    this.inputEl.placeholder = this.i18n.placeholder;
    this.inputEl.setAttribute('aria-label', 'Picolocus Micro-Intelligence Search');

    // Match count badge
    this.countBadge = document.createElement('span');
    this.countBadge.className = 'pico-count silent-mi-count';
    this.countBadge.setAttribute('data-smi-ui', 'true');
    this.countBadge.textContent = '0';

    // Prev / Next buttons
    this.prevButton = document.createElement('button');
    this.prevButton.className = 'pico-btn silent-mi-btn';
    this.prevButton.setAttribute('data-smi-ui', 'true');
    this.prevButton.setAttribute('aria-label', 'Previous match (Shift+Enter)');
    this.prevButton.textContent = '‹';
    this.prevButton.addEventListener('click', () => this.callbacks.onPrev());

    this.nextButton = document.createElement('button');
    this.nextButton.className = 'pico-btn silent-mi-btn';
    this.nextButton.setAttribute('data-smi-ui', 'true');
    this.nextButton.setAttribute('aria-label', 'Next match (Enter)');
    this.nextButton.textContent = '›';
    this.nextButton.addEventListener('click', () => this.callbacks.onNext());

    // Details toggle button
    this.detailsToggleButton = document.createElement('button');
    this.detailsToggleButton.className = 'pico-btn silent-mi-btn';
    this.detailsToggleButton.setAttribute('data-smi-ui', 'true');
    this.detailsToggleButton.setAttribute('aria-label', 'Toggle details list');
    this.detailsToggleButton.textContent = '≡';
    this.detailsToggleButton.addEventListener('click', () => this.toggleDetails());

    // Minimize button
    this.minimizeButton = document.createElement('button');
    this.minimizeButton.className = 'pico-btn silent-mi-btn';
    this.minimizeButton.setAttribute('data-smi-ui', 'true');
    this.minimizeButton.setAttribute('aria-label', 'Minimize locator');
    this.minimizeButton.textContent = '–';
    this.minimizeButton.addEventListener('click', () => this.minimize());

    // Close button
    this.closeButton = document.createElement('button');
    this.closeButton.className = 'pico-btn silent-mi-btn';
    this.closeButton.setAttribute('data-smi-ui', 'true');
    this.closeButton.setAttribute('aria-label', 'Close locator');
    this.closeButton.textContent = '✕';
    this.closeButton.addEventListener('click', () => this.callbacks.onClose());

    headerRow.append(
      this.inputEl,
      this.countBadge,
      this.prevButton,
      this.nextButton,
      this.detailsToggleButton,
      this.minimizeButton,
      this.closeButton
    );

    // Expandable Details Container
    this.detailsContainer = document.createElement('div');
    this.detailsContainer.className = 'pico-details silent-mi-details';
    this.detailsContainer.setAttribute('data-smi-ui', 'true');
    this.detailsContainer.style.display = 'none';

    this.detailsList = document.createElement('ul');
    this.detailsList.className = 'pico-list silent-mi-list';
    this.detailsList.setAttribute('data-smi-ui', 'true');
    this.detailsContainer.appendChild(this.detailsList);

    this.container.append(headerRow, this.detailsContainer);

    // Consent banner if embedder exists but is not consented
    this.updateConsentUi();

    // Mount to DOM
    if (typeof document !== 'undefined' && document.body) {
      document.body.appendChild(this.pillButton);
      document.body.appendChild(this.container);
    }

    this.setupListeners();
  }

  public hasSemanticModel(): boolean {
    return Boolean(
      this.embedder?.isEnabled &&
        (typeof this.embedder.isConsented !== 'function' || this.embedder.isConsented() !== false)
    );
  }

  public setEmbedder(embedder: EmbedderPlugin | null): void {
    this.embedder = embedder;
    this.updateConsentUi();
  }

  public updateConsentUi(): void {
    if (
      this.embedder &&
      typeof this.embedder.isConsented === 'function' &&
      !this.embedder.isConsented()
    ) {
      if (!this.consentBanner) {
        this.consentBanner = document.createElement('div');
        this.consentBanner.className = 'pico-consent silent-mi-consent';
        this.consentBanner.setAttribute('data-smi-ui', 'true');

        const label = document.createElement('span');
        label.setAttribute('data-smi-ui', 'true');
        label.textContent = this.i18n.enableAiTitle;

        const btnGroup = document.createElement('div');
        btnGroup.style.display = 'flex';
        btnGroup.style.gap = '6px';

        const enableBtn = document.createElement('button');
        enableBtn.className = 'pico-btn silent-mi-btn';
        enableBtn.setAttribute('data-smi-ui', 'true');
        enableBtn.style.background = '#6366f1';
        enableBtn.style.color = '#ffffff';
        enableBtn.textContent = this.i18n.enableAiBtn;
        enableBtn.addEventListener('click', async () => {
          if (this.callbacks.onGrantConsent) {
            await this.callbacks.onGrantConsent();
          }
          this.hideConsentBanner();
        });

        const dismissBtn = document.createElement('button');
        dismissBtn.className = 'pico-btn silent-mi-btn';
        dismissBtn.setAttribute('data-smi-ui', 'true');
        dismissBtn.textContent = this.i18n.dismissAiBtn;
        dismissBtn.addEventListener('click', () => {
          this.hideConsentBanner();
        });

        btnGroup.append(enableBtn, dismissBtn);
        this.consentBanner.append(label, btnGroup);
        this.container.prepend(this.consentBanner);
      }
    } else {
      this.hideConsentBanner();
    }
  }

  private hideConsentBanner(): void {
    if (this.consentBanner) {
      this.consentBanner.remove();
      this.consentBanner = null;
    }
  }

  private injectStyles(): void {
    if (typeof document === 'undefined' || this.styleSheetInjected) return;
    const styleId = 'silent-mi-bar-styles';
    if (document.getElementById(styleId)) {
      this.styleSheetInjected = true;
      return;
    }

    const style = document.createElement('style');
    style.id = styleId;
    style.setAttribute('data-smi-ui', 'true');
    if (this.cspNonce) {
      style.nonce = this.cspNonce;
      style.setAttribute('nonce', this.cspNonce);
    }
    style.textContent = `
      .pico-bar,
      .silent-mi-bar {
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 999999;
        background: #0f172a;
        color: #f8fafc;
        border: 1px solid #334155;
        border-radius: 10px;
        box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.4);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 13px;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        min-width: 380px;
        max-width: 480px;
      }
      .pico-row,
      .silent-mi-row {
        display: flex;
        align-items: center;
        padding: 6px 8px;
        gap: 6px;
      }
      .pico-consent,
      .silent-mi-consent {
        display: flex;
        align-items: center;
        justify-content: space-between;
        background: #1e1b4b;
        border-bottom: 1px solid #4338ca;
        padding: 6px 10px;
        font-size: 11px;
        color: #c7d2fe;
      }
      .pico-input,
      .silent-mi-input {
        flex: 1;
        background: #1e293b;
        color: #f8fafc;
        border: 1px solid #475569;
        border-radius: 6px;
        padding: 6px 10px;
        font-size: 13px;
        outline: none;
      }
      .pico-input:focus,
      .silent-mi-input:focus {
        border-color: #6366f1;
        box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.3);
      }
      .pico-count,
      .silent-mi-count {
        font-size: 11px;
        font-weight: 600;
        color: #94a3b8;
        padding: 2px 6px;
        background: #1e293b;
        border-radius: 4px;
        white-space: nowrap;
      }
      .pico-btn,
      .silent-mi-btn {
        background: #1e293b;
        color: #cbd5e1;
        border: 1px solid #334155;
        border-radius: 6px;
        padding: 5px 8px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .pico-btn:hover,
      .silent-mi-btn:hover {
        background: #334155;
        color: #f8fafc;
      }
      .pico-pill,
      .silent-mi-pill {
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 999999;
        background: #6366f1;
        color: #ffffff;
        border: none;
        border-radius: 20px;
        padding: 8px 16px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 13px;
        font-weight: 600;
        box-shadow: 0 4px 12px rgba(99, 102, 241, 0.4);
        cursor: pointer;
      }
      .pico-pill:hover,
      .silent-mi-pill:hover {
        background: #4f46e5;
      }
      .pico-details,
      .silent-mi-details {
        max-height: 220px;
        overflow-y: auto;
        border-top: 1px solid #334155;
        background: #090d16;
      }
      .pico-list,
      .silent-mi-list {
        list-style: none;
        margin: 0;
        padding: 4px 0;
      }
      .pico-item,
      .silent-mi-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 6px 12px;
        cursor: pointer;
        gap: 8px;
        font-size: 12px;
      }
      .pico-item:hover, .pico-item[data-active="true"],
      .silent-mi-item:hover, .silent-mi-item[data-active="true"] {
        background: #1e293b;
      }
      .pico-kind,
      .silent-mi-kind {
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        padding: 2px 5px;
        border-radius: 3px;
        background: #334155;
        color: #cbd5e1;
      }
      .pico-score,
      .silent-mi-score {
        font-size: 11px;
        color: #818cf8;
        font-weight: 600;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
    this.styleSheetInjected = true;
  }

  private setupListeners(): void {
    // 160ms input debounce
    this.inputEl.addEventListener('input', () => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.callbacks.onQueryChange(this.inputEl.value);
      }, 160);
    });

    // Enter / Shift+Enter stepping & Escape to close
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.minimize();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
          this.debounceTimer = null;
          this.callbacks.onQueryChange(this.inputEl.value);
          return;
        }
        if (e.shiftKey) {
          this.callbacks.onPrev();
        } else {
          this.callbacks.onNext();
        }
      }
    });

    // Global Shortcut listener
    this.globalKeydownListener = (e: KeyboardEvent) => {
      const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
      const modifierPressed = isMac ? e.metaKey : e.ctrlKey;

      if (this.hotkey === 'Ctrl+K' || this.hotkey === 'Cmd+K') {
        if (modifierPressed && e.key.toLowerCase() === 'k' && !e.shiftKey && !e.altKey) {
          e.preventDefault();
          this.toggle();
        }
      } else {
        // Custom hotkey format: e.g. "Ctrl+Shift+K"
        const parts = this.hotkey.toLowerCase().split('+');
        const needsCtrl = parts.includes('ctrl') || parts.includes('cmd');
        const needsShift = parts.includes('shift');
        const needsAlt = parts.includes('alt');
        const keyPart = parts[parts.length - 1];

        if (
          (!needsCtrl || modifierPressed) &&
          (!needsShift || e.shiftKey) &&
          (!needsAlt || e.altKey) &&
          e.key.toLowerCase() === keyPart
        ) {
          e.preventDefault();
          this.toggle();
        }
      }
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('keydown', this.globalKeydownListener);
    }
  }

  toggle(): void {
    if (this.isMinimized) {
      this.restore();
    } else if (this.container.style.display === 'none') {
      this.show();
    } else {
      this.inputEl.focus();
    }
  }

  show(): void {
    this.pillButton.style.display = 'none';
    this.container.style.display = 'flex';
    this.isMinimized = false;
    this.inputEl.focus();
  }

  hide(): void {
    this.container.style.display = 'none';
    this.pillButton.style.display = 'none';
  }

  minimize(): void {
    this.container.style.display = 'none';
    this.pillButton.style.display = 'block';
    this.isMinimized = true;
  }

  restore(): void {
    this.pillButton.style.display = 'none';
    this.container.style.display = 'flex';
    this.isMinimized = false;
    this.inputEl.focus();
  }

  toggleDetails(): void {
    this.isDetailsExpanded = !this.isDetailsExpanded;
    this.detailsContainer.style.display = this.isDetailsExpanded ? 'block' : 'none';
    this.detailsToggleButton.style.background = this.isDetailsExpanded ? '#4338ca' : '#1e293b';
  }

  updateMatches(matches: SearchMatch[], currentIndex: number): void {
    const total = matches.length;
    this.countBadge.textContent = `${total > 0 ? currentIndex + 1 : 0}/${total}`;

    // Render Details List with pure DOM nodes (Zero innerHTML)
    const items: HTMLLIElement[] = [];
    for (let i = 0; i < matches.length; i++) {
      const match = matches[i]!;
      const li = document.createElement('li');
      li.className = 'pico-item silent-mi-item';
      li.setAttribute('data-smi-ui', 'true');
      li.tabIndex = 0;
      li.setAttribute('role', 'button');
      if (i === currentIndex) {
        li.setAttribute('data-active', 'true');
      }

      const leftSpan = document.createElement('span');
      leftSpan.setAttribute('data-smi-ui', 'true');
      leftSpan.style.display = 'flex';
      leftSpan.style.alignItems = 'center';
      leftSpan.style.gap = '6px';

      const kindBadge = document.createElement('span');
      kindBadge.className = 'pico-kind silent-mi-kind';
      kindBadge.setAttribute('data-smi-ui', 'true');
      kindBadge.textContent = match.targetType || 'action';

      const labelText = document.createTextNode(` ${match.label}`);
      leftSpan.append(kindBadge, labelText);

      const rightSpan = document.createElement('span');
      rightSpan.className = 'pico-score silent-mi-score';
      rightSpan.setAttribute('data-smi-ui', 'true');

      if (match.tierLocked) {
        rightSpan.textContent = `🔒 ${match.upsellTier || 'Upgrade'}`;
        rightSpan.style.color = '#f59e0b';
      } else {
        rightSpan.textContent = `${Math.round(match.score * 100)}%`;
      }

      li.append(leftSpan, rightSpan);

      li.addEventListener('click', () => {
        this.session.jumpTo(i);
        this.callbacks.onSelectMatch(match);
      });

      li.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.session.jumpTo(i);
          this.callbacks.onSelectMatch(match);
        }
      });

      items.push(li);
    }

    this.detailsList.replaceChildren(...items);
  }

  setInputValue(val: string): void {
    this.inputEl.value = val;
  }

  destroy(): void {
    if (this.globalKeydownListener && typeof document !== 'undefined') {
      document.removeEventListener('keydown', this.globalKeydownListener);
      this.globalKeydownListener = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.container.remove();
    this.pillButton.remove();
  }
}
