/** suppliernet: shared types and zod schemas (owned by the suppliernet workstream). */
import { z } from 'zod';
import { objectId } from './schemas';

/* ------------------------------ onboarding ------------------------------ */
export const SUPPLIER_ONBOARDING_STATES = ['invited', 'profile_submitted', 'documents', 'technical_integration', 'verification', 'probation', 'approved', 'suspended'] as const;
export type SupplierOnboardingState = (typeof SUPPLIER_ONBOARDING_STATES)[number];

/** Business/integration archetypes. Metadata + capability flags only: the adapter (`provider`) decides how ORVIA talks to them. */
export const SUPPLIER_TYPES = ['api', 'feed', 'manual', 'manufacturer', 'wholesaler', 'regional_distributor', 'print_on_demand', 'local_fulfilment'] as const;
export type SupplierType = (typeof SUPPLIER_TYPES)[number];

export const SUPPLIER_CAPABILITY_FLAGS = ['apiOrdering', 'stockFeed', 'priceFeed', 'tracking', 'cancellation', 'returns', 'customBranding', 'bulkPricing', 'madeToOrder'] as const;
export type SupplierCapabilityFlag = (typeof SUPPLIER_CAPABILITY_FLAGS)[number];

const countryCodeLoose = z.string().length(2).transform((s) => s.toUpperCase());

export const supplierProfileSchema = z.object({
  legalName: z.string().trim().min(2).max(160),
  tradingName: z.string().trim().max(160).optional(),
  country: countryCodeLoose,
  registrationNumber: z.string().trim().max(80).optional(),
  taxId: z.string().trim().max(80).optional(),
  website: z.string().url().max(300).optional(),
  contact: z.object({
    name: z.string().trim().min(1).max(120),
    email: z.string().email().max(200),
    phone: z.string().trim().max(40).optional(),
  }),
  supplierType: z.enum(SUPPLIER_TYPES),
  categories: z.array(z.string().trim().min(1).max(60)).min(1).max(30),
  shippingRegions: z.array(countryCodeLoose).min(1).max(60),
  leadTimes: z.object({ handlingDays: z.number().int().min(0).max(60), minTransitDays: z.number().int().min(0).max(120), maxTransitDays: z.number().int().min(0).max(120) }),
  returnPolicy: z.object({ returnsAccepted: z.boolean(), windowDays: z.number().int().min(0).max(365).default(0), restockingFeePct: z.number().min(0).max(100).default(0), returnShippingPaidBy: z.enum(['supplier', 'orvia', 'customer']).default('customer'), notes: z.string().max(1000).optional() }),
  warrantyTerms: z.object({ months: z.number().int().min(0).max(240).default(0), notes: z.string().max(1000).optional() }).default({ months: 0 }),
  /** What the supplier CLAIMS it can do. Never treated as proven: verification steps prove it. */
  declaredCapabilities: z.array(z.enum(SUPPLIER_CAPABILITY_FLAGS)).max(20).default([]),
  slaClaims: z.object({ shipWithinHours: z.number().int().min(1).max(720).optional(), respondWithinHours: z.number().int().min(1).max(720).optional(), stockUpdateEveryHours: z.number().int().min(1).max(720).optional() }).default({}),
});
export type SupplierProfileInput = z.infer<typeof supplierProfileSchema>;

export const inviteSupplierSchema = z.object({
  code: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, 'lowercase letters, digits and dashes (3-40 chars)'),
  name: z.string().trim().min(2).max(120),
  email: z.string().email().max(200),
  contactName: z.string().trim().min(1).max(120).optional(),
  supplierType: z.enum(SUPPLIER_TYPES),
  /** Adapter used to talk to this supplier. `manual` until the technical integration step. */
  provider: z.enum(['manual', 'rest', 'feed', 'cj']).default('manual'),
  servesCountries: z.array(countryCodeLoose).max(60).default([]),
});

/* ------------------------------- documents ------------------------------ */
export const SUPPLIER_DOCUMENT_KINDS = ['business_registration', 'tax_certificate', 'product_certificate', 'insurance', 'bank_confirmation', 'quality_report', 'other'] as const;
export type SupplierDocumentKind = (typeof SUPPLIER_DOCUMENT_KINDS)[number];
/** Documents that must be verified (and unexpired) before technical integration. */
export const REQUIRED_DOCUMENT_KINDS: readonly SupplierDocumentKind[] = ['business_registration'];
export const SUPPLIER_DOCUMENT_STATUSES = ['pending', 'verified', 'rejected'] as const;
export const DOCUMENT_ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const;
export const DOCUMENT_MAX_BYTES = 8_000_000;

/* ------------------------------ verification ---------------------------- */
export const VERIFICATION_STEP_KINDS = ['catalogue_availability', 'price_quote_accuracy', 'stock_accuracy_sample', 'test_order_placement', 'cancellation', 'shipment_tracking', 'delivery_observed', 'return_refund_handling'] as const;
export type VerificationStepKind = (typeof VERIFICATION_STEP_KINDS)[number];
export const VERIFICATION_STEP_STATUSES = ['not_started', 'in_progress', 'passed', 'failed'] as const;
export type VerificationStepStatus = (typeof VERIFICATION_STEP_STATUSES)[number];
/** Steps that must have passed (with evidence) before a supplier may enter probation; the rest need real shipments. */
export const PRE_PROBATION_STEPS: readonly VerificationStepKind[] = ['catalogue_availability', 'price_quote_accuracy', 'stock_accuracy_sample', 'test_order_placement', 'cancellation', 'shipment_tracking'];

export const manualEvidenceSchema = z.object({
  summary: z.string().trim().min(10).max(1500),
  outcome: z.enum(['pass', 'fail']),
  /** At least one concrete reference is required so an attestation is checkable. */
  orderId: objectId.optional(),
  shipmentId: objectId.optional(),
  supplierOrderId: z.string().trim().max(120).optional(),
  documentId: objectId.optional(),
  externalReference: z.string().trim().max(200).optional(),
  metrics: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(),
});
export type ManualEvidenceInput = z.infer<typeof manualEvidenceSchema>;

export const probeSchema = z.object({
  country: z.string().length(2).optional(),
  externalId: z.string().trim().max(120).optional(),
  sku: z.string().trim().max(120).optional(),
  sampleSize: z.number().int().min(1).max(20).optional(),
  /** Test-order safety: typed confirmation, and for non-sandbox suppliers an explicit cost acknowledgement. */
  confirm: z.string().max(40).optional(),
  acknowledgeLiveCost: z.boolean().optional(),
  supplierOrderId: z.string().trim().max(120).optional(),
  address: z.object({ fullName: z.string().min(1).max(120), line1: z.string().min(1).max(200), line2: z.string().max(200).optional(), city: z.string().min(1).max(100), region: z.string().max(100).default(''), postalCode: z.string().min(1).max(20), country: z.string().length(2), phone: z.string().max(30).optional() }).optional(),
});
export type ProbeInput = z.infer<typeof probeSchema>;

export const stockObservationsSchema = z.object({
  observations: z.array(z.object({ externalId: z.string().min(1).max(120), sku: z.string().max(120).optional(), observed: z.number().int().min(0).max(1_000_000), source: z.string().min(3).max(200) })).min(1).max(50),
  summary: z.string().trim().min(10).max(1000),
});

/* ---------------------------------- SLA --------------------------------- */
export const slaDefinitionSchema = z.object({
  windowDays: z.number().int().min(7).max(180).default(30),
  minSample: z.number().int().min(1).max(500).default(10),
  minFulfilmentRate: z.number().min(0).max(1).default(0.95),
  minOnTimeRate: z.number().min(0).max(1).default(0.9),
  maxCancellationRate: z.number().min(0).max(1).default(0.05),
  minStockAccuracy: z.number().min(0).max(1).default(0.9),
  maxRefundRate: z.number().min(0).max(1).default(0.08),
  maxDefectRate: z.number().min(0).max(1).default(0.03),
  maxResponseMs: z.number().int().min(100).max(120_000).default(8000),
  /** A metric this far past its target (relative to the target) is `critical`, which triggers demotion. */
  criticalMargin: z.number().min(0.01).max(1).default(0.15),
});
export type SlaDefinition = z.infer<typeof slaDefinitionSchema>;

/* -------------------------------- disputes ------------------------------ */
export const DISPUTE_TYPES = ['late', 'defective', 'not_delivered', 'price_mismatch', 'wrong_item', 'other'] as const;
export const DISPUTE_STATES = ['open', 'awaiting_supplier', 'awaiting_orvia', 'resolved_credit', 'resolved_no_action', 'rejected', 'escalated', 'closed'] as const;
export type DisputeState = (typeof DISPUTE_STATES)[number];
export const disputeCreateSchema = z.object({
  supplierId: objectId,
  type: z.enum(DISPUTE_TYPES),
  orderId: objectId.optional(),
  shipmentId: objectId.optional(),
  statementId: objectId.optional(),
  amountMinor: z.number().int().min(0).max(100_000_000).default(0),
  currency: z.enum(['USD', 'CAD', 'INR']).default('USD'),
  summary: z.string().trim().min(10).max(2000),
});
export const evidenceItemSchema = z.object({ note: z.string().trim().min(3).max(2000), documentId: objectId.optional(), url: z.string().url().max(500).optional() });

export const RETURN_AUTH_STATES = ['requested', 'authorized', 'rejected', 'received_by_supplier', 'refunded_by_supplier', 'cancelled'] as const;
export type ReturnAuthState = (typeof RETURN_AUTH_STATES)[number];

/* ------------------------------- statements ----------------------------- */
export const STATEMENT_STATUSES = ['submitted', 'matched', 'discrepancies', 'disputed', 'settled'] as const;
export const statementLineSchema = z.object({
  supplierOrderId: z.string().trim().max(120).optional(),
  orderRef: z.string().trim().max(60).optional(),
  description: z.string().trim().max(300).optional(),
  amountMinor: z.number().int().min(-100_000_000).max(100_000_000),
});
export const statementCreateSchema = z.object({
  number: z.string().trim().min(1).max(60),
  currency: z.enum(['USD', 'CAD', 'INR']),
  periodStart: z.coerce.date().optional(),
  periodEnd: z.coerce.date().optional(),
  lines: z.array(statementLineSchema).min(1).max(2000),
});
export const statementCsvSchema = z.object({
  number: z.string().trim().min(1).max(60),
  currency: z.enum(['USD', 'CAD', 'INR']),
  periodStart: z.coerce.date().optional(),
  periodEnd: z.coerce.date().optional(),
  csv: z.string().min(5).max(900_000),
});
export const settlementSchema = z.object({ reference: z.string().trim().min(2).max(120), amountMinor: z.number().int().min(0).max(1_000_000_000), note: z.string().max(500).optional() });

/* ---------------------------- matching & catalogue ---------------------- */
export const MATCH_STATUSES = ['pending', 'approved', 'rejected'] as const;
export const matchDecisionSchema = z.object({ note: z.string().trim().max(500).optional() });

export const feedConfigSchema = z.object({
  url: z.string().url().max(500),
  format: z.enum(['csv', 'json']),
  delimiter: z.string().length(1).default(','),
  /** JSON only: dot path to the array of rows (default: the document itself). */
  listPath: z.string().max(100).optional(),
  currency: z.enum(['USD', 'CAD', 'INR']).default('USD'),
  priceUnit: z.enum(['major', 'minor']).default('major'),
  warehouseCountry: z.string().length(2).default('US'),
  /** Authentication for the feed fetch (the secret itself is the supplier's encrypted `apiKey`). */
  auth: z.object({ type: z.enum(['none', 'bearer', 'header', 'query']).default('none'), name: z.string().max(60).default('Authorization') }).default({ type: 'none', name: 'Authorization' }),
  cacheSeconds: z.number().int().min(30).max(86_400).default(300),
  maxRows: z.number().int().min(1).max(50_000).default(20_000),
  imageSeparator: z.string().max(3).default('|'),
  /** Column / key names in the supplier's feed. */
  fields: z.object({
    id: z.string().default('id'),
    title: z.string().default('title'),
    description: z.string().optional(),
    images: z.string().optional(),
    category: z.string().optional(),
    brand: z.string().optional(),
    gtin: z.string().optional(),
    mpn: z.string().optional(),
    price: z.string().default('price'),
    shippingCost: z.string().optional(),
    stock: z.string().default('stock'),
    minDays: z.string().optional(),
    maxDays: z.string().optional(),
    variantSku: z.string().optional(),
  }).prefault({}),
  defaults: z.object({ shippingCost: z.number().min(0).default(0), minDays: z.number().int().min(0).default(7), maxDays: z.number().int().min(0).default(14) }).prefault({}),
});
export type FeedConfig = z.infer<typeof feedConfigSchema>;

export const quoteCompareQuerySchema = z.object({
  productId: objectId,
  country: z.enum(['US', 'CA', 'IN']),
  live: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});

export const productionReadinessSchema = z.object({ ready: z.boolean() });
