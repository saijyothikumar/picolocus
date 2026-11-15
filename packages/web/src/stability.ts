/**
 * @silent-mi/web - Geometric stability, portal polling, and cross-page route safety
 */

/**
 * Detects whether the current environment has layout dimensions.
 * Real browsers return non-zero bounding boxes; layout-less JSDOM returns 0x0.
 */
export function hasRealBrowserLayout(doc: Document = document): boolean {
  if (!doc.documentElement) return false;
  try {
    const rect = doc.documentElement.getBoundingClientRect();
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
 * Waits until an element's top, left, width, and height stabilize within 0.5px
 * across 2 consecutive animation frames (up to maxWaitMs, default 900ms).
 * In layout-less JSDOM, resolves immediately without timeouts.
 */
export async function waitForStableRect(
  element: Element,
  maxWaitMs = 900
): Promise<RectSnapshot | null> {
  const doc = element.ownerDocument || document;

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
 * Polls via requestAnimationFrame (up to maxWaitMs, default 650ms)
 * for lazy-mounted React or Vue drawer portals.
 */
export async function waitForElementSelector(
  selector: string,
  root: ParentNode = document,
  maxWaitMs = 650
): Promise<Element | null> {
  const immediate = root.querySelector(selector);
  if (immediate) return immediate;

  return new Promise((resolve) => {
    const start = performance.now();

    function poll(): void {
      const el = root.querySelector(selector);
      if (el) {
        resolve(el);
        return;
      }
      if (performance.now() - start >= maxWaitMs) {
        resolve(null);
        return;
      }
      requestAnimationFrame(poll);
    }

    requestAnimationFrame(poll);
  });
}

/**
 * Validates cross-page navigation routes.
 * Rejects javascript:, data:, vbscript:, protocol-relative //, /\, and cross-origin URLs.
 */
export function resolveSafeSameOriginUrl(
  urlStr: string,
  baseOrigin?: string
): string | null {
  if (!urlStr || typeof urlStr !== 'string') return null;
  const trimmed = urlStr.trim();

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
      baseOrigin ||
      (typeof window !== 'undefined' && window.location ? window.location.origin : 'http://localhost');
    const parsed = new URL(trimmed, defaultOrigin);

    // Enforce exact same origin
    const baseParsed = new URL(defaultOrigin);
    if (parsed.origin !== baseParsed.origin) {
      return null;
    }

    // Return the safe relative pathname + search + hash
    return parsed.pathname + parsed.search + parsed.hash;
  } catch {
    return null;
  }
}
