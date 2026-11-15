/**
 * @silent-mi/core - Domain-agnostic contracts and types
 * Follows the core product thesis: "Show, Don't Chat - Guide, Don't Click"
 */

export type TargetType = 'action' | 'setting' | 'row' | 'doc_clause' | 'route' | 'upsell';
export type TierPolicy = 'hide' | 'upsell';
export type ItemSource = 'manifest' | 'dom';

export interface UserContext {
  role?: string;
  roles?: string[];
  tier?: string;
  entitlements?: string[];
  tenantSalt?: string;
}

export interface ManifestItem {
  id: string;
  targetType: TargetType;
  label: string;
  description?: string;
  synonyms?: string[];
  route?: string;
  selector?: string;
  parentTriggerSelector?: string;
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
}

export interface RoleManifest {
  version: '1.0';
  role: string;
  modelId: string;
  modelSha256: string;
  dimensions: number;
  items: ManifestItem[];
}

export interface JargonAdapterPayload {
  version: '1.0';
  tenantId: string;
  role: string;
  baseModelId: string;
  baseModelSha256: string;
  dimensions: number;
  rank: number;
  alpha: number;
  downScale: number;
  upScale: number;
  downProjInt8: number[];
  upProjInt8: number[];
}

export interface SearchMatch extends ManifestItem {
  score: number;
  lexicalScore: number;
  semanticScore: number;
  negationPenalty: number;
  tierLocked?: boolean;
  upsellTier?: string;
}

export interface SearchResult {
  query: string;
  affirmativeQuery: string;
  negatedTerms: string[];
  matches: SearchMatch[];
  rejectedAsOOD: boolean;
  topRawConfidence: number;
  latencyMs: number;
  usedSemanticVectors: boolean;
}

export interface EngineOptions {
  minConfidence?: number;
  oodSemanticFloor?: number;
  maxResults?: number;
  habitBoostWeight?: number;
  tierOrder?: string[];
  canAccessTier?: (userTier: string | undefined, requiredTier: string) => boolean;
  canAccessRoles?: (userRoles: string[], itemRoles: string[]) => boolean;
}
