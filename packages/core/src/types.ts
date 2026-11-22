/**
 * @picolocus/core - Domain-agnostic contracts and types (v1.0.2)
 * Follows the core product thesis: "Show, Don't Chat - Guide, Don't Click"
 */

export type ActionKind = 'spotlight' | 'breadcrumb' | 'highlight_clause' | 'dynamic_row';
export type TargetType = ActionKind | 'action' | 'setting' | 'row' | 'doc_clause' | 'route' | 'upsell';
export type TierPolicy = 'hide' | 'spotlight_upsell' | 'upsell';
export type ItemSource = 'manifest' | 'dom';
export type ProvenanceKind =
  | 'manifest'
  | 'harness_item'
  | 'playbook_branch'
  | 'trusted_dom'
  | 'data_row';
export type StateConflictKind = 'already_in_target_state' | 'disabled_control';
export type EmbedRole = 'query' | 'document';
export type CapabilityDiagnostic =
  | 'csp_wasm_blocked'
  | 'offline_or_fetch_failed'
  | 'quota_exceeded'
  | 'integrity_mismatch'
  | 'worker_error';

export interface PlaybookDomSnapshot {
  visibleSelectors?: ReadonlySet<string>;
  disabledSelectors?: ReadonlySet<string>;
  checkedSelectors?: Readonly<Record<string, boolean>>;
  liveLabels?: Readonly<Record<string, string>>;
}

export interface UserContext {
  role?: string;
  roles?: string[];
  tier?: string;
  entitlements?: string[];
  tenantSalt?: string;
  appState?: Readonly<Record<string, string | number | boolean | null>>;
  domContext?: PlaybookDomSnapshot;
}

export interface ManifestItem {
  id: string;
  targetType?: TargetType;
  kind?: ActionKind;
  label: string;
  description?: string;
  synonyms?: string[];
  whenUserAsks?: string[];
  route?: string;
  selector?: string;
  parentTriggerSelector?: string;
  triggerChain?: string[];
  roles?: string[];
  requiredTier?: string;
  tierPolicy?: TierPolicy;
  docUrl?: string;
  clauseAnchor?: string;
  verbatimText?: string;
  quantScale?: number;
  vector?: number[];
  liveStatus?: string;
  source: ItemSource;
  calloutTitle?: string;
  calloutText?: string;
  provenance?: ProvenanceKind;
  rowTextFingerprint?: number;
  playbookRule?: PlaybookRule;
}

export interface PlaybookEvalContext {
  user?: UserContext;
  appState?: Readonly<Record<string, string | number | boolean | null>>;
  domContext?: PlaybookDomSnapshot;
}

export interface PlaybookCondition {
  state?: Record<string, string | number | boolean | null>;
  userRole?: string | string[];
  userTier?: string | string[];
  domVisible?: string | string[];
  domAbsent?: string | string[];
  domDisabled?: string | string[];
  domChecked?: Record<string, boolean>;
  predicate?: (ctx: PlaybookEvalContext) => boolean;
}

export interface PlaybookTarget {
  route: string;
  triggerChain?: string[];
  selector?: string;
  kind?: ActionKind;
  verbatimSentence?: string;
  calloutTitle?: string;
  calloutText?: string;
}

export interface PlaybookBranch {
  id?: string;
  condition?: PlaybookCondition;
  target: PlaybookTarget;
  default?: boolean;
}

export interface PlaybookRule {
  id: string;
  label: string;
  whenUserAsks: string[];
  description?: string;
  sectionTitle?: string;
  roles?: string[];
  requiredTier?: string;
  tierPolicy?: TierPolicy;
  branches: readonly PlaybookBranch[];
}

export interface HarnessConfig {
  version: '1.0';
  domainGlossary?: Record<string, readonly string[]>;
  items?: ManifestItem[];
  playbooks?: PlaybookRule[];
}

export interface CalibrationProfile {
  minConfidence: number;
  oodSemanticFloor: number;
  minLexicalWithoutSemantic: number;
  marginThreshold: number;
  zScoreThreshold: number;
  disambiguationTieDelta: number;
  routeBoost: number;
  visibleBoost: number;
}

export interface LexiconConfig {
  reversibleTogglePairs?: Array<[string, string]>;
  directionalAntonymPairs?: Array<[string, string]>;
}

export interface RoleManifest {
  version: '1.0';
  role: string;
  modelId: string;
  modelSha256: string;
  dimensions: number;
  items: ManifestItem[];
  domainGlossary?: Record<string, readonly string[]>;
  playbooks?: PlaybookRule[];
}

export interface SearchMatch extends ManifestItem {
  score: number;
  lexicalScore: number;
  semanticScore: number;
  negationPenalty: number;
  upsellLocked: boolean;
  tierLocked?: boolean;
  upsellTier?: string;
  disambiguationIndex?: number;
  stateConflict?: StateConflictKind;
  matchedBranchIndex?: number;
}

export interface SearchExplainTrace {
  lexicalScore: number;
  semanticScore: number;
  negationPenalty: number;
  polarityPenalty: number;
  rawScore: number;
  zScore: number;
  margin: number;
  decision: 'choice' | 'disambiguate' | 'noul';
  matchedTokens?: string[];
  negatedTokens?: string[];
  matchedBranchIndex?: number;
  stateConflict?: StateConflictKind;
}

export interface SearchResponse {
  query: string;
  affirmativeQuery: string;
  negatedTerms: string[];
  matches: SearchMatch[];
  rejectedAsOOD: boolean;
  topRawConfidence: number;
  latencyMs: number;
  usedSemanticVectors: boolean;
  decision: 'choice' | 'disambiguate' | 'noul';
  confidence: number;
  margin: number;
  zScore: number;
  explain?: SearchExplainTrace;
}

export type SearchResult = SearchResponse;

export interface EmbedderPlugin {
  readonly id: string;
  readonly isEnabled: boolean;
  readonly isReady: boolean;
  readonly dimensions: number;
  readonly modelSha256: string;
  warmup(): Promise<void>;
  embedQuery(text: string): Promise<Int8Array | null>;
  embedBatch?(texts: readonly string[], role?: EmbedRole): Promise<Array<Int8Array | null>>;
  embedDirect?(text: string, role?: EmbedRole): Promise<Int8Array | null>;
  embedLatest?(text: string, role?: EmbedRole): Promise<Int8Array | null>;
  grantConsent?(): Promise<boolean>;
  revokeConsent?(): Promise<void>;
  isConsented?(): boolean;
  dispose(): Promise<void>;
}

export interface DecisionHeadPlugin {
  rerank(query: string, candidates: readonly SearchMatch[]): Promise<readonly number[]> | readonly number[];
}

export interface EngineOptions {
  minConfidence?: number;
  oodSemanticFloor?: number;
  minLexicalWithoutSemantic?: number;
  maxResults?: number;
  habitBoostWeight?: number;
  tierOrder?: string[];
  calibration?: Partial<CalibrationProfile>;
  lexicon?: LexiconConfig;
  canAccessTier?: (userTier: string | undefined, requiredTier: string) => boolean;
  canAccessRoles?: (userRoles: string[], itemRoles: string[]) => boolean;
}
