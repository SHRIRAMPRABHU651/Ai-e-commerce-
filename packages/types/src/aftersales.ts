/** aftersales: shared types and zod schemas (owned by the aftersales workstream). */
import { z } from 'zod';
import { objectId } from './schemas';

/* ------------------------------ taxonomy ------------------------------ */

/**
 * Return reason taxonomy. `fault` says who the reason points at (it drives shipping refunds, supplier
 * recovery and which items are returnable); `evidence` says whether photos are required.
 * The first six codes also exist in the original /returns endpoint and must keep working.
 */
export const RETURN_REASONS = {
  damaged: { label: 'Arrived damaged', group: 'defect', fault: 'merchant', evidence: 'required', supplierRecoverable: true },
  defective: { label: 'Does not work / defective', group: 'defect', fault: 'merchant', evidence: 'required', supplierRecoverable: true },
  wrong_item: { label: 'Wrong item received', group: 'fulfilment', fault: 'merchant', evidence: 'required', supplierRecoverable: true },
  missing_parts: { label: 'Missing parts or items', group: 'fulfilment', fault: 'merchant', evidence: 'recommended', supplierRecoverable: true },
  not_as_described: { label: 'Not as described', group: 'defect', fault: 'merchant', evidence: 'required', supplierRecoverable: true },
  not_delivered: { label: 'Never arrived', group: 'fulfilment', fault: 'carrier', evidence: 'none', supplierRecoverable: true },
  size_fit: { label: 'Size or fit', group: 'preference', fault: 'customer', evidence: 'none', supplierRecoverable: false },
  changed_mind: { label: 'Changed my mind', group: 'preference', fault: 'customer', evidence: 'none', supplierRecoverable: false },
  better_price: { label: 'Found a better price', group: 'preference', fault: 'customer', evidence: 'none', supplierRecoverable: false },
  other: { label: 'Something else', group: 'other', fault: 'unknown', evidence: 'recommended', supplierRecoverable: false },
} as const;
export type ReturnReasonCode = keyof typeof RETURN_REASONS;
export const RETURN_REASON_CODES = Object.keys(RETURN_REASONS) as [ReturnReasonCode, ...ReturnReasonCode[]];
export type ReturnFault = (typeof RETURN_REASONS)[ReturnReasonCode]['fault'];

export const ITEM_CONDITIONS = ['unopened', 'opened_unused', 'used', 'damaged', 'defective'] as const;
export type ItemCondition = (typeof ITEM_CONDITIONS)[number];

export const RESOLUTION_TYPES = ['refund', 'replacement', 'exchange'] as const;
export type ResolutionType = (typeof RESOLUTION_TYPES)[number];

/* ----------------------------- RMA workflow ----------------------------- */
export const RMA_STATES = [
  'submitted', // customer asked; waiting for staff
  'authorized', // RMA issued: customer has instructions
  'in_transit', // customer says they shipped / label scanned
  'received', // goods back at the supplier / Orvia
  'inspected', // condition checked
  'refund_pending', // refund created but waiting for approval or provider
  'replacement_pending', // replacement/exchange approved, being ordered
  'resolved', // money returned / replacement dispatched
  'rejected',
  'cancelled',
] as const;
export type RmaState = (typeof RMA_STATES)[number];

export const CLAIM_KINDS = ['defect', 'non_delivery', 'wrong_item', 'damaged_in_transit'] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];
export const CLAIM_STATES = ['draft', 'submitted', 'acknowledged', 'accepted', 'partially_accepted', 'rejected', 'recovered', 'written_off'] as const;
export type ClaimState = (typeof CLAIM_STATES)[number];

export const CHARGEBACK_STATES = ['warning', 'needs_response', 'evidence_recorded', 'submitted', 'under_review', 'won', 'lost', 'accepted', 'closed'] as const;
export type ChargebackState = (typeof CHARGEBACK_STATES)[number];
export const CHARGEBACK_PROVIDERS = ['stripe', 'razorpay', 'mock'] as const;

/* ------------------------------ evidence ------------------------------ */
export const EVIDENCE_LIMITS = {
  maxFilesPerReturn: 6,
  allowedMime: ['image/jpeg', 'image/png', 'image/webp'] as readonly string[],
  minBytes: 1_000,
} as const;

/* ------------------------------- schemas ------------------------------- */
export const startReturnSchema = z.object({
  orderId: objectId,
  reason: z.enum(RETURN_REASON_CODES),
  details: z.string().trim().max(2000).default(''),
  items: z.array(z.object({
    sku: z.string().trim().min(1).max(80),
    quantity: z.number().int().min(1).max(100),
    condition: z.enum(ITEM_CONDITIONS),
  })).min(1).max(10),
  resolution: z.enum(RESOLUTION_TYPES).default('refund'),
  /** Exchange only: the variant SKU the customer wants instead (same product). */
  exchangeSku: z.string().trim().max(80).optional(),
});
export type StartReturnInput = z.infer<typeof startReturnSchema>;

export const adminReturnQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  state: z.enum(RMA_STATES).optional(),
});

export const authorizeReturnSchema = z.object({ note: z.string().trim().max(500).default('') });
export const rejectReturnSchema = z.object({ note: z.string().trim().min(3).max(500) });
export const inspectReturnSchema = z.object({
  outcome: z.enum(['accepted', 'accepted_partial', 'rejected']),
  /** Quantity per sku actually accepted back (defaults to all requested for `accepted`). */
  acceptedItems: z.array(z.object({ sku: z.string().max(80), quantity: z.number().int().min(0).max(100) })).max(10).optional(),
  note: z.string().trim().max(500).default(''),
});
export const resolveRefundSchema = z.object({
  /** Optional goodwill override; must not exceed the computed maximum. */
  amount: z.number().int().min(1).optional(),
  note: z.string().trim().max(500).default(''),
});
export const recordLabelSchema = z.object({
  url: z.string().url().max(500).startsWith('https://'),
  carrier: z.string().trim().max(60).optional(),
  trackingNumber: z.string().trim().max(80).optional(),
});
export const replacementShipmentSchema = z.object({
  supplierOrderRef: z.string().trim().max(120).optional(),
  carrier: z.string().trim().max(60).optional(),
  trackingNumber: z.string().trim().max(80).optional(),
  delivered: z.boolean().default(false),
});
export const noteSchema = z.object({ text: z.string().trim().min(1).max(1000), internal: z.boolean().default(true) });

export const supplierPolicySchema = z.object({
  supportsReturns: z.enum(['yes', 'no', 'unknown']),
  supportsReplacement: z.boolean().default(false),
  supportsExchange: z.boolean().default(false),
  returnWindowDays: z.number().int().min(0).max(365).optional(),
  defectOnly: z.boolean().default(false),
  claimWindowDays: z.number().int().min(0).max(365).optional(),
  instructions: z.string().trim().max(2000).default(''),
  contactEmail: z.string().email().max(200).optional(),
  returnAddress: z.object({ name: z.string().max(120), line1: z.string().max(200), line2: z.string().max(200).optional(), city: z.string().max(100), region: z.string().max(100).optional(), postalCode: z.string().max(20), country: z.string().max(2) }).optional(),
  labelProvider: z.string().trim().max(40).optional(),
});

export const claimCreateSchema = z.object({
  returnId: objectId.optional(),
  orderId: objectId,
  supplierId: objectId,
  kind: z.enum(CLAIM_KINDS),
  claimedAmount: z.number().int().min(1),
  description: z.string().trim().max(1000).default(''),
});
export const claimTransitionSchema = z.object({
  to: z.enum(CLAIM_STATES),
  approvedAmount: z.number().int().min(0).optional(),
  recoveredAmount: z.number().int().min(0).optional(),
  note: z.string().trim().max(500).default(''),
});

export const chargebackListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  state: z.enum(CHARGEBACK_STATES).optional(),
});
export const chargebackEvidenceSchema = z.object({
  text: z.string().trim().min(5).max(4000),
  category: z.enum(['shipping_proof', 'delivery_proof', 'customer_communication', 'product_description', 'refund_policy', 'other']).default('other'),
});
export const mockDisputeSchema = z.object({
  intentId: z.string().min(3).max(120),
  status: z.enum(['needs_response', 'under_review', 'won', 'lost', 'warning']).default('needs_response'),
  amount: z.number().int().min(1).optional(),
  reason: z.string().max(60).default('fraudulent'),
  disputeId: z.string().max(80).optional(),
  eventId: z.string().max(120).optional(),
});
