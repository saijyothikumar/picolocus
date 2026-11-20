import { describe, it, expect, beforeEach } from 'vitest';
import {
  SilentMIEngine,
  NoopEmbedder,
  quantizeFloat32ToInt8,
  computeInt8Cosine,
  DEFAULT_DIMENSIONS,
  HabitMemory,
  fnv1a32Hex,
  parseQueryIntent,
  stemToken,
  extractExactTokens,
  analyzeActionPolarity,
  normalizeRoute,
  defineHarness,
  expandGlossaryTokens,
  evaluatePlaybookBranches,
  playbookToManifestItem,
  ManifestItem,
  HarnessConfig,
  PlaybookRule,
  UserContext,
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
    expect(batch[0]).toBeNull();
  });

  it('quantizeFloat32ToInt8 normalizes and clamps values within [-127, 127] at 256 dimensions', () => {
    expect(DEFAULT_DIMENSIONS).toBe(256);
    const raw = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      raw[i] = (i - 128) * 0.1;
    }
    const { int8, scale } = quantizeFloat32ToInt8(raw);

    expect(int8.length).toBe(256);
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

describe('HarnessConfig, Playbook & Glossary Expansion', () => {
  it('defines harness config cleanly and expands glossary bidirectionally', () => {
    const harness = defineHarness({
      version: '1.0',
      domainGlossary: {
        vat: ['gst', 'tax id', 'ein'],
        sso: ['saml', 'okta'],
      },
      items: [
        {
          id: 'item-vat',
          label: 'EU VAT Settings',
          whenUserAsks: ['add EU VAT number', 'company GST registration'],
          route: '/billing',
          selector: '#input-vat-id',
          source: 'manifest',
        },
      ],
    });

    expect(harness.version).toBe('1.0');
    expect(harness.items?.length).toBe(1);

    // Bidirectional expansion check
    const forward = expandGlossaryTokens(['vat'], harness.domainGlossary);
    expect(forward).toContain('vat');
    expect(forward).toContain('gst');

    const backward = expandGlossaryTokens(['gst'], harness.domainGlossary);
    expect(backward).toContain('gst');
    expect(backward).toContain('vat');
  });

  it('converts PlaybookRule to synthetic ManifestItem and evaluates conditional branches', () => {
    const rule: PlaybookRule = {
      id: 'playbook-sso',
      label: 'Configure SSO',
      whenUserAsks: ['connect Okta', 'set up SAML SSO'],
      branches: [
        {
          condition: { state: { plan: 'free' } },
          target: { route: '/billing', selector: '#btn-upgrade-enterprise' },
        },
        {
          condition: { state: { ssoEnabled: false } },
          target: { route: '/security', selector: '#toggle-enable-sso' },
        },
        {
          condition: { state: { ssoEnabled: true } },
          target: { route: '/security', triggerChain: ['#tab-security', '#btn-idp-modal'], selector: '#input-idp-metadata-url' },
        },
      ],
    };

    const synthetic = playbookToManifestItem(rule);
    expect(synthetic.id).toBe('playbook-sso');
    expect(synthetic.synonyms).toContain('connect Okta');

    // Branch 1: plan === 'free'
    const eval1 = evaluatePlaybookBranches(rule, { appState: { plan: 'free', ssoEnabled: false } });
    expect(eval1?.branchIndex).toBe(0);
    expect(eval1?.target.selector).toBe('#btn-upgrade-enterprise');

    // Branch 2: plan === 'pro', ssoEnabled === false
    const eval2 = evaluatePlaybookBranches(rule, { appState: { plan: 'pro', ssoEnabled: false } });
    expect(eval2?.branchIndex).toBe(1);
    expect(eval2?.target.selector).toBe('#toggle-enable-sso');

    // Branch 3: plan === 'pro', ssoEnabled === true
    const eval3 = evaluatePlaybookBranches(rule, { appState: { plan: 'pro', ssoEnabled: true } });
    expect(eval3?.branchIndex).toBe(2);
    expect(eval3?.target.selector).toBe('#input-idp-metadata-url');
    expect(eval3?.target.triggerChain).toEqual(['#tab-security', '#btn-idp-modal']);
  });
});

describe('Action Polarity & Route Normalization', () => {
  it('normalizes routes with basePath and hash routes', () => {
    expect(normalizeRoute('#/settings/billing')).toBe('/settings/billing');
    expect(normalizeRoute('/settings/billing/')).toBe('/settings/billing');
    expect(normalizeRoute('/app/dashboard', { basePath: '/app' })).toBe('/dashboard');
    expect(normalizeRoute('', { routingMode: 'hash' })).toBe('/');
  });

  it('enforces directional antonym rejection (export vs import) with polarity penalty 0.85', () => {
    const res = analyzeActionPolarity(['export', 'contacts'], ['import', 'contacts']);
    expect(res.polarityPenalty).toBe(0.85);
  });

  it('immunizes dual-pole items from directional penalty (Import & Export Contacts)', () => {
    const res = analyzeActionPolarity(['export', 'contacts'], ['import', 'and', 'export', 'contacts']);
    expect(res.polarityPenalty).toBe(0);
  });

  it('detects reversible toggle live state conflict without penalty', () => {
    // User searches "enable 2fa" when live button already says "Disable 2FA"
    const res = analyzeActionPolarity(['enable', '2fa'], ['enable', '2fa'], 'Disable 2FA', true);
    expect(res.polarityPenalty).toBe(0);
    expect(res.stateConflict).toBe('already_in_target_state');
  });
});

describe('HabitMemory Salted Bucket Keys & Security', () => {
  it('incorporates namespaceSalt into bucketKey and prevents prototype pollution in recordChoice', () => {
    const memory = new HabitMemory(null, 'tenant_salt');
    const key = memory.bucketKey('billing');
    expect(key).toMatch(/^[a-f0-9]{8}$/);

    memory.recordChoice('billing', 'item-1');
    expect(memory.getBoost('billing', 'item-1')).toBeGreaterThan(0);

    // Proto pollution attempt
    memory.recordChoice('billing', '__proto__');
    memory.loadFromJSON(JSON.stringify({ __proto__: { polluted: true } }));
    expect((({} as any).polluted)).toBeUndefined();
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
    expect(parsed.negatedTerms).not.toContain('tx');
  });

  it('stems English suffixes deterministically', () => {
    expect(stemToken('billing')).toBe('bill');
    expect(stemToken('deleting')).toBe('delet');
    expect(stemToken('created')).toBe('creat');
  });
});

describe('SilentMIEngine Scoring, Jev Decision Gate & Small-N Safety', () => {
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
      id: 'btn-import-contacts',
      targetType: 'action',
      label: 'Import Team Contacts',
      description: 'Import contacts from CSV or vCard.',
      source: 'manifest',
    },
  ];

  let engine: SilentMIEngine;

  beforeEach(() => {
    engine = new SilentMIEngine();
    engine.setItems(items);
  });

  it('matches 0-index transposition (f2a -> 2fa) and sets decision: choice', () => {
    const res = engine.searchInstant('f2a');
    expect(res.decision).toBe('choice');
    expect(res.matches[0]?.id).toBe('setting-2fa');
    expect(res.confidence).toBeGreaterThanOrEqual(0.29);
  });

  it('returns decision: noul for directional antonym query (export contacts against import contacts)', () => {
    const res = engine.searchInstant('export team contacts');
    expect(res.decision).toBe('noul');
    expect(res.matches.length).toBe(0);
    expect(res.rejectedAsOOD).toBe(true);
  });

  it('pure negation gate: "do not delete workspace" rejects all non-self-negated controls returning noul', () => {
    const res = engine.searchInstant('do not delete workspace');
    expect(res.decision).toBe('noul');
    expect(res.matches).toEqual([]);
    expect(res.rejectedAsOOD).toBe(true);
  });

  it('preserves self-negated policy clauses: "do not sell personal email" matches with decision: choice', () => {
    const res = engine.searchInstant('do not sell personal email');
    expect(res.decision).toBe('choice');
    expect(res.matches[0]?.id).toBe('clause-privacy-email');
  });

  it('handles small-N safety without division by zero on 1 or 2 items', () => {
    const smallEngine = new SilentMIEngine();
    smallEngine.setItems([items[0]!]); // N = 1
    const res1 = smallEngine.searchInstant('Delete Workspace');
    expect(res1.decision).toBe('choice');
    expect(res1.matches[0]?.id).toBe('btn-delete-workspace');
    expect(Number.isFinite(res1.zScore)).toBe(true);
  });

  it('evaluates dynamic playbooks with live appState in registerHarness', () => {
    const engineWithHarness = new SilentMIEngine();
    engineWithHarness.registerHarness({
      version: '1.0',
      playbooks: [
        {
          id: 'rule-sso',
          label: 'SSO Setup',
          whenUserAsks: ['setup sso', 'connect okta'],
          branches: [
            {
              condition: { state: { plan: 'free' } },
              target: { route: '/billing', selector: '#btn-upgrade' },
            },
            {
              condition: { state: { plan: 'pro' } },
              target: { route: '/security', selector: '#btn-configure-sso' },
            },
          ],
        },
      ],
    });

    const userPro: UserContext = { appState: { plan: 'pro' } };
    const resPro = engineWithHarness.searchInstant('setup sso', userPro);
    expect(resPro.decision).toBe('choice');
    expect(resPro.matches[0]?.selector).toBe('#btn-configure-sso');

    const userFree: UserContext = { appState: { plan: 'free' } };
    const resFree = engineWithHarness.searchInstant('setup sso', userFree);
    expect(resFree.decision).toBe('choice');
    expect(resFree.matches[0]?.selector).toBe('#btn-upgrade');
  });
});

describe('500-Vector 256d Int8 Dot Product Benchmark', () => {
  it('evaluates 500 vectors in <15 ms in flat typed memory', () => {
    const VEC_COUNT = 500;
    const DIM = 256;
    const vectors: Int8Array[] = new Array(VEC_COUNT);

    for (let i = 0; i < VEC_COUNT; i++) {
      const v = new Int8Array(DIM);
      for (let d = 0; d < DIM; d++) {
        v[d] = ((i + d) % 255) - 127;
      }
      vectors[i] = v;
    }

    const queryVec = new Int8Array(DIM);
    for (let d = 0; d < DIM; d++) {
      queryVec[d] = (d % 255) - 127;
    }

    const start = performance.now();
    let bestSim = -1;
    let bestIdx = -1;

    for (let i = 0; i < VEC_COUNT; i++) {
      const sim = computeInt8Cosine(queryVec, vectors[i]!);
      if (sim > bestSim) {
        bestSim = sim;
        bestIdx = i;
      }
    }
    const elapsed = performance.now() - start;

    expect(bestIdx).toBeGreaterThanOrEqual(0);
    expect(elapsed).toBeLessThan(15.0); // Strict performance budget
  });
});
