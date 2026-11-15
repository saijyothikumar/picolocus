import { describe, it, expect, beforeEach } from 'vitest';
import {
  SilentMIEngine,
  NoopEmbedder,
  quantizeFloat32ToInt8,
  computeInt8Cosine,
  LinearAdapter,
  HabitMemory,
  fnv1a32Hex,
  parseQueryIntent,
  stemToken,
  extractExactTokens,
  ManifestItem,
  JargonAdapterPayload,
} from '../src/index.js';

describe('NoopEmbedder and Int8 Quantization', () => {
  it('NoopEmbedder returns 0 dimensions and isEnabled: false (Zero Fake Vectors)', async () => {
    const embedder = new NoopEmbedder();
    expect(embedder.dimensions).toBe(0);
    expect(embedder.isEnabled).toBe(false);
    expect(embedder.modelSha256).toBe('none');
    expect(await embedder.embedQuery('test')).toBeNull();
    const batch = await embedder.embedBatch(['a', 'b']);
    expect(batch.length).toBe(2);
    expect(batch[0]?.length).toBe(0);
  });

  it('quantizeFloat32ToInt8 normalizes and clamps values within [-127, 127]', () => {
    const raw = new Float32Array([3.0, -4.0, 0.0, 12.0]);
    const { int8, scale } = quantizeFloat32ToInt8(raw);

    expect(int8.length).toBe(4);
    expect(scale).toBeGreaterThan(0);
    for (let i = 0; i < int8.length; i++) {
      expect(int8[i]!).toBeGreaterThanOrEqual(-127);
      expect(int8[i]!).toBeLessThanOrEqual(127);
    }
  });

  it('computeInt8Cosine accurately scores parallel and orthogonal vectors', () => {
    const a = new Int8Array([100, 0, 0]);
    const b = new Int8Array([100, 0, 0]);
    const c = new Int8Array([0, 100, 0]);
    const d = new Int8Array([-100, 0, 0]);

    expect(computeInt8Cosine(a, b)).toBeCloseTo(1.0, 2);
    expect(computeInt8Cosine(a, c)).toBeCloseTo(0.0, 2);
    expect(computeInt8Cosine(a, d)).toBeCloseTo(-1.0, 2);
  });
});

describe('LinearAdapter Cryptographic Pinning & Low-Rank Projection', () => {
  const validPayload: JargonAdapterPayload = {
    version: '1.0',
    tenantId: 'tenant-123',
    role: 'public',
    baseModelId: 'bge-micro-v2',
    baseModelSha256: 'sha256-verified-hash-abc123',
    dimensions: 4,
    rank: 2,
    alpha: 1.0,
    downScale: 0.01,
    upScale: 0.01,
    // DownProj: 2 x 4 = 8
    downProjInt8: [10, -10, 5, -5, 2, -2, 1, -1],
    // UpProj: 4 x 2 = 8
    upProjInt8: [8, -8, 4, -4, 2, -2, 1, -1],
  };

  it('validates schema strictly and rejects invalid configurations', () => {
    expect(() => new LinearAdapter(validPayload)).not.toThrow();

    expect(() => new LinearAdapter({ ...validPayload, version: '2.0' as any })).toThrow();
    expect(() => new LinearAdapter({ ...validPayload, dimensions: 0 })).toThrow();
    expect(() => new LinearAdapter({ ...validPayload, rank: 0 })).toThrow();
    expect(() => new LinearAdapter({ ...validPayload, downScale: -1 })).toThrow();
    expect(() => new LinearAdapter({ ...validPayload, alpha: 5.5 })).toThrow();
    expect(() => new LinearAdapter({ ...validPayload, baseModelId: '' })).toThrow();
    expect(() => new LinearAdapter({ ...validPayload, baseModelSha256: '' })).toThrow();
    expect(() => new LinearAdapter({ ...validPayload, downProjInt8: [1, 2] })).toThrow();
  });

  it('strictly enforces cryptographic SHA-256 pinning without wildcard or local-onnx bypass', () => {
    const adapter = new LinearAdapter(validPayload);
    expect(adapter.matchesBaseModel('bge-micro-v2', 'sha256-verified-hash-abc123')).toBe(true);

    // Mismatches must return false
    expect(adapter.matchesBaseModel('other-model', 'sha256-verified-hash-abc123')).toBe(false);
    expect(adapter.matchesBaseModel('bge-micro-v2', 'sha256-tampered')).toBe(false);

    // Wildcard bypasses must be blocked
    expect(adapter.matchesBaseModel('*', '*')).toBe(false);
    expect(adapter.matchesBaseModel('bge-micro-v2', '*')).toBe(false);
    expect(adapter.matchesBaseModel('bge-micro-v2', 'local-onnx')).toBe(false);
    expect(adapter.matchesBaseModel('bge-micro-v2', 'none')).toBe(false);
  });

  it('projects in low-rank residual bottleneck with pre-allocated scratch buffers', () => {
    const adapter = new LinearAdapter(validPayload);
    const input = new Int8Array([50, -40, 30, -20]);
    const projected = adapter.project(input);

    expect(projected.int8.length).toBe(4);
    expect(projected.scale).toBeGreaterThan(0);
  });
});

describe('HabitMemory Security & Decay', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as any).localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, String(value)),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
    };
  });

  it('keys habits solely by salted FNV-1a hex hashes and caps boost at 0.08', () => {
    const memory = new HabitMemory('salt_xyz');
    const query = 'billing settings';
    const queryHash = memory.hashQuery(query);

    expect(queryHash).toMatch(/^[a-f0-9]{8}$/);
    expect(memory.getBoost(queryHash, 'item-billing')).toBe(0);

    memory.recordConfirmation(query, 'item-billing');
    const boost1 = memory.getBoost(queryHash, 'item-billing');
    expect(boost1).toBeGreaterThan(0);
    expect(boost1).toBeLessThanOrEqual(0.08);

    // Confirmation boost accumulation
    for (let i = 0; i < 10; i++) {
      memory.recordConfirmation(query, 'item-billing');
    }
    const maxBoost = memory.getBoost(queryHash, 'item-billing');
    expect(maxBoost).toBe(0.08);
  });

  it('prevents prototype pollution attacks by stripping __proto__', () => {
    const maliciousJson = JSON.stringify({
      __proto__: { polluted: true },
      constructor: { prototype: { admin: true } },
      regular_hash: { itemId: 'item-1', count: 2.0 },
    });
    localStorage.setItem('silent_mi_habits_v1', maliciousJson);

    const memory = new HabitMemory();
    expect((({} as any).polluted)).toBeUndefined();
    expect((({} as any).admin)).toBeUndefined();
    expect(memory.getBoost('regular_hash', 'item-1')).toBeGreaterThan(0);
  });
});

describe('Negation-First Intent Gate & Suffix Stemmer', () => {
  it('truncates queries to 512 characters', () => {
    const longQuery = 'a'.repeat(600);
    const parsed = parseQueryIntent(longQuery);
    expect(parsed.truncatedQuery.length).toBe(512);
  });

  it('extracts literal exact tokens (#id, $amount, prefixes)', () => {
    const query = 'Show invoice #TX-903 for $412.00 with usr-admin and err-404';
    const tokens = extractExactTokens(query);
    expect(tokens).toContain('#tx-903');
    expect(tokens).toContain('$412.00');
    expect(tokens).toContain('usr-admin');
    expect(tokens).toContain('err-404');
  });

  it('splits negated clauses and prevents exact ID poisoning (invoice paid except #TX-903)', () => {
    const query = 'invoice paid except #TX-903';
    const parsed = parseQueryIntent(query);

    expect(parsed.hasNegation).toBe(true);
    expect(parsed.negatedExactTokens).toContain('#tx-903');
    // Crucial check: "tx" must NOT be extracted into primary negated terms to avoid poisoning #TX-904
    expect(parsed.negatedTerms).not.toContain('tx');
  });

  it('separates primary negated terms from secondary shared nouns', () => {
    const query = 'pause workspace billing, do not delete workspace';
    const parsed = parseQueryIntent(query);

    expect(parsed.hasNegation).toBe(true);
    expect(parsed.isPureNegation).toBe(false);
    expect(parsed.affirmativeTokens).toContain('pause');
    expect(parsed.affirmativeTokens).toContain('workspace');
    expect(parsed.affirmativeTokens).toContain('billing');

    // "delete" is primary negated term
    expect(parsed.negatedTerms).toContain('delete');
    // "workspace" appears in both affirmative and negated clauses, so it is secondary shared noun
    expect(parsed.secondarySharedTerms).toContain('workspace');
  });

  it('identifies pure negation queries (do not delete workspace)', () => {
    const query = 'do not delete workspace';
    const parsed = parseQueryIntent(query);
    expect(parsed.hasNegation).toBe(true);
    expect(parsed.isPureNegation).toBe(true);
    expect(parsed.negatedTerms).toContain('delete');
    expect(parsed.negatedTerms).toContain('workspace');
  });

  it('stems English suffixes deterministically', () => {
    expect(stemToken('billing')).toBe('bill');
    expect(stemToken('deleting')).toBe('delet');
    expect(stemToken('created')).toBe('creat');
    expect(stemToken('categories')).toBe('category');
    expect(stemToken('boxes')).toBe('box');
    expect(stemToken('invoices')).toBe('invoice');
    expect(stemToken('payment')).toBe('pay');
    expect(stemToken('subscription')).toBe('subscript');
  });
});

describe('SilentMIEngine Scoring, Negation & RBAC Invariants', () => {
  const items: ManifestItem[] = [
    {
      id: 'btn-delete-workspace',
      targetType: 'action',
      label: 'Delete Workspace',
      description: 'Permanently remove this workspace and all associated projects.',
      source: 'manifest',
    },
    {
      id: 'btn-pause-billing',
      targetType: 'action',
      label: 'Pause Billing',
      description: 'Temporarily pause workspace billing without deleting workspace.',
      source: 'manifest',
    },
    {
      id: 'clause-privacy-email',
      targetType: 'doc_clause',
      label: 'Email Privacy Policy',
      verbatimText: 'We do not sell, rent, or trade your personal email.',
      source: 'manifest',
    },
    {
      id: 'setting-2fa',
      targetType: 'setting',
      label: 'Two-Factor Authentication (2FA)',
      description: 'Configure multi-factor security code.',
      synonyms: ['2fa', 'mfa'],
      source: 'manifest',
    },
    {
      id: 'row-tx-903',
      targetType: 'row',
      label: 'Invoice #TX-903',
      description: 'Paid invoice for $412.00',
      liveStatus: 'paid',
      source: 'dom',
    },
    {
      id: 'row-tx-904',
      targetType: 'row',
      label: 'Invoice #TX-904',
      description: 'Paid invoice for $150.00',
      liveStatus: 'paid',
      source: 'dom',
    },
    {
      id: 'setting-admin-audit',
      targetType: 'setting',
      label: 'Audit Log Export',
      roles: ['admin', 'auditor'],
      source: 'manifest',
    },
    {
      id: 'setting-sso',
      targetType: 'setting',
      label: 'SAML SSO Integration',
      requiredTier: 'enterprise',
      tierPolicy: 'upsell',
      source: 'manifest',
    },
  ];

  let engine: SilentMIEngine;

  beforeEach(() => {
    engine = new SilentMIEngine({
      tierOrder: ['free', 'pro', 'enterprise'],
    });
    engine.setItems(items);
  });

  it('matches direct label prefix, exact, and 0-index transposition (f2a -> 2fa)', () => {
    // 0-index transposition test
    const res = engine.searchInstant('f2a');
    expect(res.matches.length).toBeGreaterThan(0);
    expect(res.matches[0]?.id).toBe('setting-2fa');
  });

  it('penalizes negated targets: "pause billing, do not delete workspace" ranks pause billing #1 and penalizes delete workspace', () => {
    const res = engine.searchInstant('pause billing, do not delete workspace');
    expect(res.matches.length).toBeGreaterThan(0);
    expect(res.matches[0]?.id).toBe('btn-pause-billing');

    // btn-delete-workspace must suffer heavy negation penalty (+0.85)
    const deleteMatch = res.matches.find((m) => m.id === 'btn-delete-workspace');
    expect(deleteMatch).toBeUndefined(); // Pushed well below minConfidence 0.29
  });

  it('Pure Negation Gate: "do not delete workspace" rejects all non-self-negated controls (rejectedAsOOD: true)', () => {
    const res = engine.searchInstant('do not delete workspace');
    // Must NOT match Delete Workspace action!
    const deleteMatch = res.matches.find((m) => m.id === 'btn-delete-workspace');
    expect(deleteMatch).toBeUndefined();
    expect(res.rejectedAsOOD).toBe(true);
    expect(res.matches).toEqual([]);
  });

  it('Preserves self-negated policy clauses: "do not sell personal email" matches privacy policy', () => {
    const res = engine.searchInstant('do not sell personal email');
    expect(res.matches.length).toBeGreaterThan(0);
    expect(res.matches[0]?.id).toBe('clause-privacy-email');
  });

  it('Prevents ID poisoning: "invoice paid except #TX-903" penalizes #TX-903 while matching #TX-904', () => {
    const res = engine.searchInstant('invoice paid except #TX-903');
    const matchedIds = res.matches.map((m) => m.id);
    expect(matchedIds).toContain('row-tx-904');
    expect(matchedIds).not.toContain('row-tx-903');
  });

  it('Enforces RBAC: public user cannot access admin items; admin user can', () => {
    const publicRes = engine.searchInstant('Audit Log');
    expect(publicRes.matches.find((m) => m.id === 'setting-admin-audit')).toBeUndefined();

    const adminRes = engine.searchInstant('Audit Log', { roles: ['admin'] });
    expect(adminRes.matches.find((m) => m.id === 'setting-admin-audit')).toBeDefined();
  });

  it('Enforces Tier Policy: enterprise feature is locked with upsellTier for free tier user', () => {
    const res = engine.searchInstant('SAML SSO', { tier: 'free' });
    expect(res.matches.length).toBeGreaterThan(0);
    const ssoMatch = res.matches.find((m) => m.id === 'setting-sso');
    expect(ssoMatch).toBeDefined();
    expect(ssoMatch?.tierLocked).toBe(true);
    expect(ssoMatch?.upsellTier).toBe('enterprise');

    // Entitlement override
    const entRes = engine.searchInstant('SAML SSO', { tier: 'free', entitlements: ['enterprise'] });
    const entMatch = entRes.matches.find((m) => m.id === 'setting-sso');
    expect(entMatch?.tierLocked).toBe(false);
  });
});
