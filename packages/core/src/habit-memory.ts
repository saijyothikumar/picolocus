/**
 * @silent-mi/core - HabitMemory local user preference tracking
 * Invariant: Never stores raw user query text; keyed solely by salted 32-bit FNV-1a hex hashes.
 * Invariant: Strip __proto__, constructor, and prototype to prevent prototype pollution.
 */

export interface HabitEntry {
  itemId: string;
  count: number;
}

export const HABIT_STORAGE_KEY = 'silent_mi_habits_v1';
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
  private readonly storageKey: string;
  private readonly tenantSalt: string;
  // Null-prototype map for prototype safety
  private entries: Map<string, HabitEntry>;

  constructor(tenantSalt = '', storageKey = HABIT_STORAGE_KEY) {
    this.tenantSalt = tenantSalt;
    this.storageKey = storageKey;
    this.entries = this.loadSafe();
  }

  /**
   * Generates a salted FNV-1a hash for a normalized affirmative query.
   */
  hashQuery(normalizedAffirmativeQuery: string): string {
    const raw = `${this.tenantSalt}:${normalizedAffirmativeQuery.trim().toLowerCase()}`;
    return fnv1a32Hex(raw);
  }

  /**
   * Computes habit boost capped strictly at 0.08.
   */
  getBoost(queryHash: string, itemId: string, maxWeight = MAX_HABIT_BOOST): number {
    const entry = this.entries.get(queryHash);
    if (!entry || entry.itemId !== itemId) {
      return 0.0;
    }
    const ratio = Math.max(0, Math.min(1.0, entry.count / MAX_HABIT_COUNT));
    return Math.min(maxWeight, ratio * maxWeight);
  }

  /**
   * Records an explicit user confirmation for an item.
   * Applies 0.985 exponential decay across all entries,
   * adds +1.0 clamped to 5.0 for the confirmed item,
   * prunes entries below 0.05, and keeps at most 32 entries.
   */
  recordConfirmation(normalizedAffirmativeQuery: string, itemId: string): void {
    const queryHash = this.hashQuery(normalizedAffirmativeQuery);

    // 1. Decay all existing entries
    for (const [key, entry] of this.entries.entries()) {
      entry.count *= HABIT_DECAY_RATE;
      if (entry.count < MIN_HABIT_PRUNE_THRESHOLD) {
        this.entries.delete(key);
      }
    }

    // 2. Add or update current entry
    const existing = this.entries.get(queryHash);
    if (existing && existing.itemId === itemId) {
      existing.count = Math.min(MAX_HABIT_COUNT, existing.count + 1.0);
    } else {
      this.entries.set(queryHash, {
        itemId,
        count: Math.min(MAX_HABIT_COUNT, 1.0),
      });
    }

    // 3. Keep at most MAX_HABIT_ENTRIES (sorted by highest count)
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

    this.saveSafe();
  }

  clear(): void {
    this.entries.clear();
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(this.storageKey);
      }
    } catch {
      // Ignore storage errors in restricted contexts
    }
  }

  private loadSafe(): Map<string, HabitEntry> {
    const map = new Map<string, HabitEntry>();
    try {
      if (typeof localStorage === 'undefined') return map;
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return map;

      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return map;

      // Use Object.create(null) to strip prototype keys
      const safeObj = Object.create(null) as Record<string, unknown>;
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        safeObj[k] = v;
      }

      for (const [k, v] of Object.entries(safeObj)) {
        if (v && typeof v === 'object' && 'itemId' in v && 'count' in v) {
          const entry = v as { itemId: unknown; count: unknown };
          if (
            typeof entry.itemId === 'string' &&
            typeof entry.count === 'number' &&
            Number.isFinite(entry.count) &&
            entry.count >= MIN_HABIT_PRUNE_THRESHOLD
          ) {
            map.set(k, {
              itemId: entry.itemId,
              count: Math.min(MAX_HABIT_COUNT, entry.count),
            });
          }
        }
      }
    } catch {
      // Fail closed with empty map
    }
    return map;
  }

  private saveSafe(): void {
    try {
      if (typeof localStorage === 'undefined') return;
      const out = Object.create(null) as Record<string, HabitEntry>;
      for (const [k, v] of this.entries.entries()) {
        out[k] = v;
      }
      localStorage.setItem(this.storageKey, JSON.stringify(out));
    } catch {
      // Ignore storage errors
    }
  }
}
