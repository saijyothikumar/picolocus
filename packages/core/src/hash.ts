/**
 * @picolocus/core - Canonical 32-bit FNV-1a Hashing Utilities
 * License: Apache-2.0
 */

/**
 * Computes a 32-bit FNV-1a hash of a string, returning an unsigned 32-bit integer.
 */
export function fnv1a32(str: string): number {
  let hash = 0x811c9dc5;
  const len = str.length;
  for (let i = 0; i < len; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Computes a 32-bit FNV-1a hash of a string, returning an 8-character lowercase hex string.
 */
export function fnv1a32Hex(str: string): string {
  return fnv1a32(str).toString(16).padStart(8, '0');
}

/**
 * Alias for fnv1a32 returning unsigned 32-bit integer.
 */
export const fnv1aHash = fnv1a32;
