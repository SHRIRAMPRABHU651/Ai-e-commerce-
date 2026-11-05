/** trust: shared types and zod schemas for ORVIA TrustGraph (owned by the trust workstream). */
import { z } from 'zod';

/** Where a fact comes from. Only `verified` may be shown as verified; AI text is never a claim. */
export const PROVENANCES = ['verified', 'supplier_provided', 'customer_reported', 'ai_suggested'] as const;
export type Provenance = (typeof PROVENANCES)[number];

export const PROVENANCE_LABELS: Record<Provenance, string> = {
  verified: 'Verified',
  supplier_provided: 'Supplier-provided',
  customer_reported: 'Customer-reported',
  ai_suggested: 'AI-suggested',
};

/** insufficient_data: no numeric score is shown. provisional: shown with a range and a warning. established: enough history. */
export const TRUST_STATUSES = ['insufficient_data', 'provisional', 'established'] as const;
export type TrustStatus = (typeof TRUST_STATUSES)[number];

export const EVIDENCE_SUBJECTS = ['product', 'supplier', 'manufacturer'] as const;
export const EVIDENCE_KINDS = ['specification', 'material', 'dimension', 'certificate', 'document', 'test_report', 'manufacturer', 'image_rights', 'other'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const evidenceInputSchema = z.object({
  subject: z.enum(EVIDENCE_SUBJECTS),
  subjectId: z.string().regex(/^[a-f\d]{24}$/i),
  kind: z.enum(EVIDENCE_KINDS),
  /** Attribute / claim key, e.g. "material", "weight", "EN71". */
  key: z.string().trim().min(1).max(120),
  value: z.string().trim().min(1).max(1000),
  provenance: z.enum(PROVENANCES),
  source: z.string().trim().min(2).max(300),
  sourceUrl: z.string().url().max(500).optional(),
  observedAt: z.coerce.date().optional(),
  expiresAt: z.coerce.date().optional(),
  jurisdiction: z.array(z.string().length(2)).max(10).optional(),
  note: z.string().max(500).optional(),
});
export type EvidenceInput = z.infer<typeof evidenceInputSchema>;

export const countryQuerySchema = z.object({ country: z.enum(['US', 'CA', 'IN']).optional() });
export const confidenceQuerySchema = z.object({
  country: z.enum(['US', 'CA', 'IN']).optional(),
  quantity: z.coerce.number().int().min(1).max(20).default(1),
  region: z.string().trim().max(10).optional(),
});
export const trustListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(TRUST_STATUSES).optional(),
  q: z.string().trim().max(80).optional(),
});
export const trustRecomputeSchema = z.object({
  scope: z.enum(['all', 'suppliers', 'products']).default('all'),
  supplierId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  productId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
});

/* ------------------------------ scoring results ------------------------------ */

export interface TrustEvidenceRef {
  label: string;
  value: string;
  provenance: Provenance;
  source: string;
  observedAt?: string | null;
}

export interface TrustComponent {
  key: string;
  label: string;
  /** 0..1, higher is better. null when there is no data for this component. */
  value: number | null;
  /** The raw observed rate before shrinkage (for transparency). */
  observed: number | null;
  /** Observations behind the component. */
  sampleSize: number;
  /** 0..1: how much the value is driven by data instead of the prior. */
  confidence: number;
  weight: number;
  evidence: TrustEvidenceRef[];
  note?: string;
}

export interface TrustScoreBase {
  /** 0..100; null when status is insufficient_data. */
  score: number | null;
  /** Plausible range for the score; null when no score. */
  range: { low: number; high: number } | null;
  status: TrustStatus;
  confidence: number;
  sampleSize: number;
  components: TrustComponent[];
  /** Plain-language limits of this score. */
  caveats: string[];
  /** What we do know even when no score is shown. */
  known: string[];
}

export interface SupplierTrustResult extends TrustScoreBase {
  freshness: number | null;
  destination: string | null;
}

export interface SupplierTrustSnapshotView extends SupplierTrustResult {
  supplierId: string;
  supplierName: string;
  computedAt: string;
  destinations: Record<string, SupplierTrustResult>;
}

export type RiskLevel = 'low' | 'medium' | 'high' | 'unknown';
export interface ProductRiskResult extends TrustScoreBase {
  /** 0..100 where higher means MORE risk. null when insufficient. */
  level: RiskLevel;
  destination: string | null;
  restricted: boolean;
}

/* ------------------------------ passport / confidence ------------------------------ */

export interface PassportField<T = string> {
  value: T;
  provenance: Provenance;
  source: string;
  observedAt?: string | null;
  /** Evidence freshness 0..1 when it can expire. */
  freshness?: number | null;
}

export interface PassportDocument {
  title: string;
  kind: 'certificate' | 'standard' | 'organic_claim' | 'document';
  provenance: Provenance;
  source: string;
  url?: string | null;
  observedAt?: string | null;
  expiresAt?: string | null;
  expired?: boolean;
  jurisdiction?: string[];
}

export interface DeliveryBand {
  /** Calendar days from order placement. null when there is neither history nor a supplier estimate. */
  minDays: number | null;
  maxDays: number | null;
  basis: 'observed' | 'promised_only';
  sampleSize: number;
  /** Observed share delivered inside the promised window (Wilson lower bound). null if no history. */
  onTimeRateLow: number | null;
  /** 0..1 */
  confidence: number;
  statement: string;
}

export interface ProductPassport {
  generatedAt: string;
  country: string;
  product: { slug: string; title: string; brand: PassportField; lifecycle: PassportField };
  identity: {
    manufacturer: PassportField | null;
    supplier: PassportField | null;
  };
  summary: PassportField | null;
  specifications: { key: string; field: PassportField }[];
  materials: PassportField[];
  dimensions: { key: string; field: PassportField }[];
  images: { url: string; alt?: string; provenance: Provenance; source: string; usageRights: string }[];
  documents: PassportDocument[];
  restrictions: { country: string; restricted: boolean; reasons: string[]; provenance: Provenance }[];
  stock: { freshness: 'fresh' | 'aging' | 'stale' | 'unknown'; observedAt: string | null; note: string; provenance: Provenance };
  priceHistory: { available: boolean; points: { at: string; price: number; currency: string }[]; note: string; provenance: Provenance };
  delivery: { promised: { minDays: number; maxDays: number } | null; actual: DeliveryBand; provenance: Provenance };
  quality: { delivered: number; returnRate: number | null; defectRate: number | null; sampleSize: number; status: TrustStatus; provenance: Provenance; note: string };
  risk: { score: number | null; level: RiskLevel; status: TrustStatus; confidence: number; sampleSize: number; components: TrustComponent[]; known: string[]; caveats: string[]; provenance: Provenance };
  feedback: { ratingAvg: number | null; ratingCount: number; verifiedCount: number; distribution: Record<string, number>; provenance: Provenance; note: string };
  alternatives: { slug: string; title: string; price: number | null; currency: string; image: string | null }[];
}

export interface PurchaseConfidenceReport {
  generatedAt: string;
  country: string;
  quantity: number;
  product: { slug: string; title: string; available: boolean };
  /** Always-present honesty statements. */
  uncertainty: string[];
  infoCompleteness: { verifiedShare: number; supplierProvidedShare: number; missing: string[]; label: string };
  supplierReliability: { status: TrustStatus; score: number | null; range: { low: number; high: number } | null; confidence: number; sampleSize: number; label: string; known: string[] };
  delivery: DeliveryBand & { promised: { minDays: number; maxDays: number } | null; estimateLabel: string | null; shipsFrom: string | null };
  returns: { windowDays: number; note: string; provenance: Provenance };
  pricing: { currency: string; unitPrice: number; subtotal: number; shipping: number; tax: number; total: number; taxIsEstimate: true; taxInclusive: boolean; importChargesNote: string | null } | null;
  restrictions: { restricted: boolean; reasons: string[] };
  knownLimitations: string[];
}

/* ------------------------------ fair deal ------------------------------ */

export const FAIR_DEAL_DIMENSIONS = ['price', 'quality_evidence', 'supplier_reliability', 'delivery_confidence', 'return_conditions', 'warranty'] as const;
export type FairDealDimension = (typeof FAIR_DEAL_DIMENSIONS)[number];
export type FairDealWeights = Record<FairDealDimension, number>;

export interface FairDealOfferInput {
  /** Opaque offer id (internal; never shown to customers). */
  offerId: string;
  /** The product being offered. All offers must be for the same product. */
  productId: string;
  /** Internal supplier reference; stripped from customer-facing output. */
  supplierRef: string;
  supplierDisplayName: string;
  available: boolean;
  /** Total delivered price in minor units (including shipping and estimated tax/duties). */
  totalDeliveredPrice: number;
  currency: string;
  /** 0..1 share of verified product facts. */
  evidenceCompleteness: number | null;
  supplierTrust: { score: number | null; status: TrustStatus; confidence: number } | null;
  delivery: { minDays: number; maxDays: number; confidence: number; basis: 'observed' | 'promised_only' } | null;
  returnWindowDays: number | null;
  warrantyMonths: number | null;
}

export interface FairDealDimensionScore {
  dimension: FairDealDimension;
  /** 0..1 */
  score: number;
  weight: number;
  contribution: number;
  known: boolean;
  note: string;
}

export interface FairDealRanked {
  rank: number;
  offerId: string;
  supplierRef: string;
  supplierDisplayName: string;
  totalDeliveredPrice: number;
  currency: string;
  fairValueScore: number;
  isCheapest: boolean;
  /** True if the product differs from the requested one (requires prior customer consent). */
  substitute: boolean;
  dimensions: FairDealDimensionScore[];
  unknowns: FairDealDimension[];
  summary: string;
}

export interface FairDealResult {
  ranked: FairDealRanked[];
  excluded: { offerId: string; reason: string }[];
  weights: FairDealWeights;
  note: string;
}
