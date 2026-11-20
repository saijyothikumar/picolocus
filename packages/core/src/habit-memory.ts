/**
 * @picolocus/core - HabitMemory local user preference tracking (v1.0.0)
 * Invariant: Never stores raw user query text; keyed solely by salted 32-bit FNV-1a hex hashes.
 * Invariant: Strip __proto__, constructor, and prototype to prevent prototype pollution.
 */

export interface HabitEntry {
  itemId: string;
  count: number;
}

export const HABIT_STORAGE_KEY = 'silent_mi_habits_v2';
export const MAX_HABIT_ENTRIES = 32;
export const HABIT_DECAY_RATE = 0.985;
export const MAX_HABIT_COUNT = 5.0;
export const MIN_HABIT_PRUNE_THRESHOLD = 0.05;
export const MAX_HABIT_BOOST = 0.08;

/**
 * 32-bit FNV-1a hash of a string, returning an 8-character lowercase hex string.
 */
export function fnv1a32Hex(str: string): string {
  let hash = 0x811c9dc5;
  const len = str.length;
  for (let i = 0; i < len; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export class HabitMemory {
  private readonly namespaceSalt: string;
  private entries: Map<string, HabitEntry>;

  constructor(initialJson?: string | null, namespaceSalt = '') {
    this.namespaceSalt = namespaceSalt;
    this.entries = new Map<string, HabitEntry>();
    if (initialJson) {
      this.loadFromJSON(initialJson);
    }
  }

  /**
   * Generates a salted FNV-1a bucket key for a normalized affirmative query.
   */
  bucketKey(normalizedAffirmativeQuery: string): string {
    const raw = `${this.namespaceSalt}:${normalizedAffirmativeQuery.trim().toLowerCase()}`;
    return fnv1a32Hex(raw);
  }

  /**
   * Alias for backward compatibility.
   */
  hashQuery(normalizedAffirmativeQuery: string): string {
    return this.bucketKey(normalizedAffirmativeQuery);
  }

  /**
   * Computes habit boost capped strictly at 0.08.
   */
  getBoost(queryOrHash: string, itemId: string, maxWeight = MAX_HABIT_BOOST): number {
    const key = queryOrHash.length === 8 && /^[0-9a-f]{8}$/.test(queryOrHash)
      ? queryOrHash
      : this.bucketKey(queryOrHash);

    const entry = this.entries.get(key);
    if (!entry || entry.itemId !== itemId) {
      return 0.0;
    }
    const ratio = Math.max(0, Math.min(1.0, entry.count / MAX_HABIT_COUNT));
    return Math.min(maxWeight, ratio * maxWeight);
  }

  /**
   * Records an explicit user choice/confirmation for an item.
   * Allocates bucket maps using Object.create(null) and rejects proto pollution keys.
   */
  recordChoice(normalizedAffirmativeQuery: string, itemId: string): void {
    if (itemId === '__proto__' || itemId === 'constructor' || itemId === 'prototype') {
      return;
    }

    const key = this.bucketKey(normalizedAffirmativeQuery);
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      return;
    }

    // 1. Decay all existing entries
    for (const [k, entry] of this.entries.entries()) {
      entry.count *= HABIT_DECAY_RATE;
      if (entry.count < MIN_HABIT_PRUNE_THRESHOLD) {
        this.entries.delete(k);
      }
    }

    // 2. Add or update current entry
    const existing = this.entries.get(key);
    if (existing && existing.itemId === itemId) {
      existing.count = Math.min(MAX_HABIT_COUNT, existing.count + 1.0);
    } else {
      this.entries.set(key, {
        itemId,
        count: Math.min(MAX_HABIT_COUNT, 1.0),
      });
    }

    // 3. Keep at most MAX_HABIT_ENTRIES
    if (this.entries.size > MAX_HABIT_ENTRIES) {
      const sorted = Array.from(this.entries.entries()).sort(
        (a, b) => b[1].count - a[1].count
      );
      this.entries.clear();
      for (let i = 0; i < MAX_HABIT_ENTRIES && i < sorted.length; i++) {
        const item = sorted[i];
        if (item) {
          this.entries.set(item[0], item[1]);
        }
      }
    }
  }

  recordConfirmation(normalizedAffirmativeQuery: string, itemId: string): void {
    this.recordChoice(normalizedAffirmativeQuery, itemId);
  }

  /**
   * Deserializes JSON safely using Object.create(null) while rejecting prototype keys.
   */
  loadFromJSON(jsonString: string): void {
    try {
      if (!jsonString) return;
      const parsed: unknown = JSON.parse(jsonString);
      if (!parsed || typeof parsed !== 'object') return;

      const safeObj = Object.create(null) as Record<string, unknown>;
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        safeObj[k] = v;
      }

      this.entries.clear();
      for (const [k, v] of Object.entries(safeObj)) {
        if (v && typeof v === 'object' && 'itemId' in v && 'count' in v) {
          const entry = v as { itemId: unknown; count: unknown };
          if (
            typeof entry.itemId === 'string' &&
            entry.itemId !== '__proto__' &&
            entry.itemId !== 'constructor' &&
            entry.itemId !== 'prototype' &&
            typeof entry.count === 'number' &&
            Number.isFinite(entry.count) &&
            entry.count >= MIN_HABIT_PRUNE_THRESHOLD
          ) {
            this.entries.set(k, {
              itemId: entry.itemId,
              count: Math.min(MAX_HABIT_COUNT, entry.count),
            });
          }
        }
      }
    } catch {
      // Fail closed
    }
  }

  /**
   * Serializes entries to JSON string.
   */
  toJSON(): string {
    const out = Object.create(null) as Record<string, HabitEntry>;
    for (const [k, v] of this.entries.entries()) {
      out[k] = v;
    }
    return JSON.stringify(out);
  }

  clear(): void {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }
}
