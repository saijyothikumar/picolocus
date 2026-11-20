/**
 * @picolocus/web - Geometric stability, Shadow DOM traversal, portal polling, and cross-page route safety
 */

/**
 * Detects whether the current environment has layout dimensions.
 * Real browsers return non-zero bounding boxes; layout-less JSDOM returns 0x0.
 */
export function hasRealBrowserLayout(doc?: Document): boolean {
  const d = doc ?? (typeof document !== 'undefined' ? document : null);
  if (!d || !d.documentElement) return false;
  try {
    const rect = d.documentElement.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  } catch {
    return false;
  }
}

export interface RectSnapshot {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * Traverses light DOM and open shadowRoot trees without throwing on non-standard selectors.
 */
export function querySelectorAllDeep(
  root?: ParentNode,
  selector?: string
): Element[] {
  const results: Element[] = [];
  if (!selector || typeof selector !== 'string') return results;
  const docRoot = root ?? (typeof document !== 'undefined' ? document : null);
  if (!docRoot || typeof docRoot.querySelectorAll !== 'function') return results;

  try {
    const direct = docRoot.querySelectorAll(selector);
    for (let i = 0; i < direct.length; i++) {
      const el = direct[i];
      if (el) results.push(el);
    }
  } catch {
    return results;
  }

  const targetSelector: string = selector;

  function searchShadow(node: ParentNode): void {
    try {
      const all = node.querySelectorAll('*');
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        if (el && el.shadowRoot) {
          try {
            const shadowMatches = el.shadowRoot.querySelectorAll(targetSelector);
            for (let j = 0; j < shadowMatches.length; j++) {
              const matched = shadowMatches[j];
              if (matched) results.push(matched);
            }
          } catch {
            // ignore non-standard selector exceptions inside shadowRoot
          }
          searchShadow(el.shadowRoot);
        }
      }
    } catch {
      // ignore
    }
  }

  // Also check if root itself is an element with an open shadowRoot
  if ((docRoot as Element).shadowRoot) {
    const shadow = (docRoot as Element).shadowRoot!;
    try {
      const initialShadow = shadow.querySelectorAll(targetSelector);
      for (let i = 0; i < initialShadow.length; i++) {
        const el = initialShadow[i];
        if (el) results.push(el);
      }
    } catch {
      // ignore
    }
    searchShadow(shadow);
  }

  searchShadow(docRoot);
  return results;
}

/**
 * Detects whether an element is visible in the viewport or layout tree.
 * Checks bounding box dimensions in real browsers, and traverses ancestor
 * styles (display: none, visibility: hidden, hidden attribute) in all environments.
 */
export function isElementVisible(el: Element): boolean {
  if (!el.isConnected) return false;
  try {
    const doc = el.ownerDocument || (typeof document !== 'undefined' ? document : null);
    const hasLayout = doc ? hasRealBrowserLayout(doc) : false;

    if (hasLayout) {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
    }

    let curr: Element | null = el;
    const rootDocEl = doc?.documentElement;
    while (curr && curr !== rootDocEl) {
      if (curr.hasAttribute('hidden') || curr.getAttribute('aria-hidden') === 'true') {
        return false;
      }
      if (typeof window !== 'undefined' && window.getComputedStyle) {
        const style = window.getComputedStyle(curr);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
          return false;
        }
      }
      curr = curr.parentElement;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * In responsive layouts, mobile drawers and desktop headers frequently share identical IDs or data attributes.
 * Prefer an element with width > 0 && height > 0 && display !== 'none' && visibility !== 'hidden'.
 * If multiple match, prefer the visible one; if none are visible, fall back to the first match.
 */
export function resolveBestVisibleElement(
  root?: ParentNode,
  selector?: string,
  traverseShadowDom = true
): Element | null {
  if (!selector) return null;
  const docRoot = root ?? (typeof document !== 'undefined' ? document : null);
  if (!docRoot) return null;

  const elements = traverseShadowDom
    ? querySelectorAllDeep(docRoot, selector)
    : Array.from(docRoot.querySelectorAll(selector));

  if (elements.length === 0) return null;
  if (elements.length === 1) return elements[0] ?? null;

  for (const el of elements) {
    if (isElementVisible(el)) {
      return el;
    }
  }

  // Fallback to first match if all are currently unrevealed
  return elements[0] ?? null;
}

/**
 * Waits until an element's top, left, width, and height stabilize within 0.5px
 * across 2 consecutive animation frames (up to maxWaitMs, default 900ms).
 * In layout-less JSDOM, resolves immediately without timeouts.
 */
export async function waitForStableRect(
  element: Element,
  maxWaitMs = 900
): Promise<RectSnapshot | null> {
  const doc = element.ownerDocument || (typeof document !== 'undefined' ? document : null);

  // Layout-less JSDOM check: resolve immediately
  if (!hasRealBrowserLayout(doc)) {
    try {
      const r = element.getBoundingClientRect();
      return { top: r.top, left: r.left, width: r.width, height: r.height };
    } catch {
      return null;
    }
  }

  return new Promise((resolve) => {
    const start = performance.now();
    let prevRect: RectSnapshot | null = null;
    let consecutiveStableFrames = 0;

    function check(): void {
      if (!element.isConnected) {
        resolve(null);
        return;
      }

      const r = element.getBoundingClientRect();
      const current: RectSnapshot = {
        top: r.top,
        left: r.left,
        width: r.width,
        height: r.height,
      };

      if (prevRect) {
        const dTop = Math.abs(current.top - prevRect.top);
        const dLeft = Math.abs(current.left - prevRect.left);
        const dWidth = Math.abs(current.width - prevRect.width);
        const dHeight = Math.abs(current.height - prevRect.height);

        if (dTop <= 0.5 && dLeft <= 0.5 && dWidth <= 0.5 && dHeight <= 0.5) {
          consecutiveStableFrames++;
          if (consecutiveStableFrames >= 2) {
            resolve(current);
            return;
          }
        } else {
          consecutiveStableFrames = 0;
        }
      }

      prevRect = current;

      if (performance.now() - start >= maxWaitMs) {
        // Timed out: return last measured rect
        resolve(prevRect);
        return;
      }

      requestAnimationFrame(check);
    }

    requestAnimationFrame(check);
  });
}

/**
 * Polls via MutationObserver plus requestAnimationFrame readiness check
 * so lazy portals resolve in <16ms when fast and allow up to timeoutMs (default 2500ms) on slow CPUs.
 */
export async function waitForElementSelector(
  selector: string,
  rootOrTimeout?: ParentNode | number,
  timeoutMsOrTraverse?: number | boolean,
  traverseShadowDom = true
): Promise<Element | null> {
  let root: ParentNode = typeof document !== 'undefined' ? document : ({} as ParentNode);
  let timeoutMs = 2500;
  let traverse = traverseShadowDom;

  if (typeof rootOrTimeout === 'number') {
    timeoutMs = rootOrTimeout;
    if (typeof timeoutMsOrTraverse === 'boolean') {
      traverse = timeoutMsOrTraverse;
    }
  } else if (rootOrTimeout && typeof rootOrTimeout === 'object') {
    root = rootOrTimeout;
    if (typeof timeoutMsOrTraverse === 'number') {
      timeoutMs = timeoutMsOrTraverse;
    }
  }

  if (!root || typeof (root as ParentNode).querySelector !== 'function') {
    return null;
  }

  const immediate = resolveBestVisibleElement(root, selector, traverse);
  if (immediate) return immediate;

  return new Promise((resolve) => {
    let resolved = false;
    let observer: MutationObserver | null = null;
    let rafId: number | null = null;
    let timerId: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      if (rafId !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }
    };

    const done = (el: Element | null) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(el);
    };

    const check = () => {
      const el = resolveBestVisibleElement(root, selector, traverse);
      if (el) {
        done(el);
      }
    };

    // MutationObserver setup if supported
    if (typeof MutationObserver !== 'undefined') {
      const targetNode =
        (root as Node).nodeType === 9 // Document
          ? (root as Document).documentElement || (root as Node)
          : (root as Node);
      if (targetNode) {
        try {
          observer = new MutationObserver(() => {
            check();
          });
          observer.observe(targetNode, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['style', 'class', 'hidden', 'aria-hidden'],
          });
        } catch {
          // ignore observer failure
        }
      }
    }

    // rAF loop readiness check
    const start = performance.now();
    const pollRaf = () => {
      check();
      if (!resolved) {
        if (performance.now() - start >= timeoutMs) {
          done(null);
          return;
        }
        if (typeof requestAnimationFrame === 'function') {
          rafId = requestAnimationFrame(pollRaf);
        }
      }
    };

    if (typeof requestAnimationFrame === 'function') {
      rafId = requestAnimationFrame(pollRaf);
    }

    timerId = setTimeout(() => {
      done(resolveBestVisibleElement(root, selector, traverse));
    }, timeoutMs);
  });
}

/**
 * Validates cross-page navigation routes.
 * Rejects javascript:, data:, vbscript:, protocol-relative //, /\, and cross-origin URLs.
 * Also guards against blockedRoutes (defaulting to ['/logout', '/signout']).
 */
export function resolveSafeSameOriginUrl(
  urlStr: string,
  baseOriginOrBlocked?: string | string[],
  blockedRoutes: string[] = ['/logout', '/signout']
): string | null {
  if (!urlStr || typeof urlStr !== 'string') return null;
  const trimmed = urlStr.trim();

  let effectiveOrigin: string | undefined;
  let effectiveBlocked: string[] = blockedRoutes;

  if (Array.isArray(baseOriginOrBlocked)) {
    effectiveBlocked = baseOriginOrBlocked;
  } else if (typeof baseOriginOrBlocked === 'string') {
    effectiveOrigin = baseOriginOrBlocked;
  }

  // Reject dangerous schemes
  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith('javascript:') ||
    lower.startsWith('data:') ||
    lower.startsWith('vbscript:') ||
    lower.startsWith('//') ||
    lower.startsWith('/\\') ||
    lower.startsWith('\\\\')
  ) {
    return null;
  }

  try {
    const defaultOrigin =
      effectiveOrigin ||
      (typeof window !== 'undefined' && window.location ? window.location.origin : 'http://localhost');
    const parsed = new URL(trimmed, defaultOrigin);

    // Enforce exact same origin
    const baseParsed = new URL(defaultOrigin);
    if (parsed.origin !== baseParsed.origin) {
      return null;
    }

    // Guard against blockedRoutes
    const normPath = parsed.pathname.toLowerCase();
    for (const blocked of effectiveBlocked) {
      const b = blocked.toLowerCase().trim();
      if (!b) continue;
      const cleanB = b.startsWith('/') ? b : `/${b}`;
      if (normPath === cleanB || normPath.startsWith(`${cleanB}/`) || normPath.endsWith(cleanB)) {
        return null;
      }
    }

    // Return the safe relative pathname + search + hash
    return parsed.pathname + parsed.search + parsed.hash;
  } catch {
    return null;
  }
}
