/** rescue: shared types and zod schemas (owned by the rescue workstream). */
import { z } from 'zod';

/** What went wrong with an order line. Ordered by detection priority (first wins when several signals fire). */
export const RESCUE_FAILURE_KINDS = [
  'supplier_cancellation',
  'supplier_acceptance_failure',
  'stock_shortage',
  'failed_delivery',
  'suspected_lost',
  'carrier_exception',
  'invalid_tracking',
  'shipment_delay',
  'unusual_delivery_pattern',
] as const;
export type RescueFailureKind = (typeof RESCUE_FAILURE_KINDS)[number];

export const RESCUE_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type RescueSeverity = (typeof RESCUE_SEVERITIES)[number];

export const RESCUE_OPTION_KINDS = [
  'continue_shipment',
  'reorder_same_product_alt_supplier',
  'offer_equivalent_replacement',
  'offer_partial_refund',
  'offer_full_refund',
  'escalate_human',
] as const;
export type RescueOptionKind = (typeof RESCUE_OPTION_KINDS)[number];

/** Case lifecycle. `resolved`/`closed` are terminal; everything else counts as active (one active case per order line). */
export const RESCUE_STATES = [
  'detected',
  'planned',
  'awaiting_customer',
  'awaiting_staff',
  'executing',
  'monitoring',
  'escalated',
  'resolved',
  'closed',
] as const;
export type RescueState = (typeof RESCUE_STATES)[number];
export const RESCUE_ACTIVE_STATES: readonly RescueState[] = ['detected', 'planned', 'awaiting_customer', 'awaiting_staff', 'executing', 'monitoring', 'escalated'];

export const RESCUE_ACTOR_TYPES = ['system', 'customer', 'staff'] as const;
export type RescueActorType = (typeof RESCUE_ACTOR_TYPES)[number];

/** Provenance of a piece of evidence (honesty rule: never present an inference as a fact). */
export const RESCUE_PROVENANCE = ['verified', 'supplier_provided', 'customer_reported', 'ai_suggested'] as const;
export type RescueProvenance = (typeof RESCUE_PROVENANCE)[number];

export interface RescueEvidence {
  code: string;
  detail: string;
  provenance: RescueProvenance;
  at?: string;
}

/** Actions that may ever execute without a human or customer decision. Refunds and replacements are never in this set. */
export const RESCUE_AUTO_CAPABLE: readonly RescueOptionKind[] = ['continue_shipment', 'reorder_same_product_alt_supplier'];

const money = z.number().int().min(0).max(100_000_000);
const days = z.number().min(0).max(365);

/** Authorization + detection policy. Stored in system_settings key `rescue_policy`; every field has a safe default. */
export const rescuePolicySchema = z.object({
  /** Master switch for the scan job (detection still never mutates orders; only plans and executes within policy). */
  enabled: z.boolean(),
  /** When false the job only detects + plans + notifies staff; it never executes anything on its own. */
  autoExecuteEnabled: z.boolean(),
  /** Which action kinds MAY auto-execute (only RESCUE_AUTO_CAPABLE kinds are honoured, whatever is stored). */
  autoActions: z.array(z.enum(RESCUE_OPTION_KINDS)).max(6),
  /** Supplier ids from which a no-consent reorder is pre-approved. Empty = no auto reorder. */
  preApprovedSupplierIds: z.array(z.string().regex(/^[a-f0-9]{24}$/)).max(100),
  /** USD-equivalent minor units: max extra cost + refund one case may cost without staff approval. */
  maxCostPerCaseUsd: money,
  /** USD-equivalent minor units across all auto-executed cases per UTC day. */
  maxCostPerDayUsd: money,
  /** Auto reorder only if landed cost is within this multiple of the original supplier cost (0.25 = +25%). */
  costTolerancePct: z.number().min(0).max(5),
  /** ETA worsening (days vs the current promise) above which delivery terms count as materially changed. */
  maxEtaWorseningDays: days,
  /** Max partial refund offer as a fraction of the affected line value. */
  maxPartialRefundPct: z.number().min(0).max(1),
  /** Default partial refund offered (fraction of line value). */
  defaultPartialRefundPct: z.number().min(0).max(1),
  /** Hours a consent link stays valid. */
  consentTtlHours: z.number().min(1).max(24 * 14),
  /** Hours before a customer who has not answered is escalated to staff. */
  consentReminderEscalateHours: z.number().min(1).max(24 * 30),
  /** Execution attempts per action before it is dead-lettered into the exceptions queue. */
  maxAttempts: z.number().int().min(1).max(10),
  /** Max cases the scan job will create per run. */
  scanBatch: z.number().int().min(1).max(500),
  /** Max auto-executions per UTC day (circuit breaker). */
  maxAutoActionsPerDay: z.number().int().min(0).max(1000),
  detection: z.object({
    /** Paid orders with no supplier order after this many minutes are acceptance failures. */
    acceptanceGraceMinutes: z.number().min(5).max(24 * 60),
    /** Days past the promised ETA before a shipment counts as delayed. */
    delayGraceDays: days,
    /** Days of no tracking event on an in-transit parcel before it is "suspected lost". */
    lostAfterIdleDays: days,
    /** Days past ETA before it is "suspected lost". */
    lostAfterOverdueDays: days,
    /** Days after dispatch with no valid tracking number before it is flagged. */
    trackingGraceDays: days,
    /** Promise assumed when a shipment carries no ETA at all (labelled `policy`, never presented as a supplier promise). */
    fallbackPromiseDays: days,
  }),
});
export type RescuePolicy = z.infer<typeof rescuePolicySchema>;
export const rescuePolicyPatchSchema = rescuePolicySchema.partial().extend({ detection: rescuePolicySchema.shape.detection.partial().optional(), reason: z.string().trim().min(3).max(300) });

export const DEFAULT_RESCUE_POLICY: RescuePolicy = {
  enabled: true,
  autoExecuteEnabled: false,
  autoActions: ['continue_shipment', 'reorder_same_product_alt_supplier'],
  preApprovedSupplierIds: [],
  maxCostPerCaseUsd: 1500,
  maxCostPerDayUsd: 10_000,
  costTolerancePct: 0.25,
  maxEtaWorseningDays: 3,
  maxPartialRefundPct: 0.5,
  defaultPartialRefundPct: 0.2,
  consentTtlHours: 72,
  consentReminderEscalateHours: 96,
  maxAttempts: 4,
  scanBatch: 50,
  maxAutoActionsPerDay: 50,
  detection: { acceptanceGraceMinutes: 60, delayGraceDays: 2, lostAfterIdleDays: 10, lostAfterOverdueDays: 10, trackingGraceDays: 3, fallbackPromiseDays: 21 },
};

/* ------------------------------- API shapes ------------------------------- */
const oid = z.string().regex(/^[a-f0-9]{24}$/, 'Invalid id');

export const rescueListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  state: z.enum(RESCUE_STATES).optional(),
  active: z.enum(['true', 'false']).optional(),
  kind: z.enum(RESCUE_FAILURE_KINDS).optional(),
  severity: z.enum(RESCUE_SEVERITIES).optional(),
  q: z.string().trim().max(60).optional(),
});

export const rescueDecisionBody = z.object({
  action: z.enum(['approve', 'override', 'escalate', 'close', 'replan']),
  /** Required for approve/override: which option to run. */
  optionId: z.string().max(80).optional(),
  note: z.string().trim().min(3).max(500),
  /** Staff acknowledgement that the original shipment may still arrive (required to reorder over a live in-transit parcel). */
  acknowledgeDuplicateRisk: z.boolean().optional(),
});
export type RescueDecisionBody = z.infer<typeof rescueDecisionBody>;

export const rescueConsentBody = z.object({
  token: z.string().min(20).max(600).optional(),
  email: z.string().email().max(254).optional(),
  optionId: z.string().max(80),
  decision: z.enum(['accept', 'decline']),
});
export type RescueConsentBody = z.infer<typeof rescueConsentBody>;

export const rescueRecoveryQuery = z.object({
  token: z.string().min(20).max(600).optional(),
  email: z.string().email().max(254).optional(),
});
export { oid as rescueObjectId };
