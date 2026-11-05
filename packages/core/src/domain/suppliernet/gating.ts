/**
 * Pure rules for supplier onboarding, verification and production gating. No IO: everything the database layer knows is
 * passed in, so this file is unit-tested without MongoDB.
 */
import { PRE_PROBATION_STEPS, SUPPLIER_ONBOARDING_STATES, VERIFICATION_STEP_KINDS } from '@orvia/types';
import type { DisputeState, ManualEvidenceInput, SupplierOnboardingState, VerificationStepKind } from '@orvia/types';

const DAY = 86_400_000;

/* ----------------------------- onboarding state machine ----------------------------- */
export const ONBOARDING_TRANSITIONS: Record<SupplierOnboardingState, readonly SupplierOnboardingState[]> = {
  invited: ['profile_submitted', 'suspended'],
  profile_submitted: ['documents', 'invited', 'suspended'],
  documents: ['technical_integration', 'profile_submitted', 'suspended'],
  technical_integration: ['verification', 'documents', 'suspended'],
  verification: ['probation', 'technical_integration', 'suspended'],
  probation: ['approved', 'verification', 'suspended'],
  // demotion path (SLA breach / expired verification) and suspension
  approved: ['probation', 'verification', 'suspended'],
  // reinstatement never jumps to approved: the supplier must earn it again through probation
  suspended: ['probation', 'verification'],
};

export interface TransitionFacts {
  from: SupplierOnboardingState;
  to: SupplierOnboardingState;
  profileComplete: boolean;
  /** All REQUIRED_DOCUMENT_KINDS have a verified, unexpired document. */
  requiredDocsVerified: boolean;
  /** Adapter configured and its health check / feed load succeeds (or manual supplier). */
  integrationReady: boolean;
  /** All PRE_PROBATION_STEPS are currently passed (unexpired, with evidence). */
  preProbationPassed: boolean;
  /** production_ready = every required step currently passed. */
  productionReady: boolean;
  probationStartedAt?: Date | null;
  minProbationDays: number;
  reason?: string;
  now: Date;
}

export function checkTransition(f: TransitionFacts): { ok: boolean; blockers: string[] } {
  const b: string[] = [];
  if (!SUPPLIER_ONBOARDING_STATES.includes(f.to)) return { ok: false, blockers: ['Unknown state'] };
  if (f.from === f.to) return { ok: false, blockers: ['Supplier is already in that state'] };
  if (!ONBOARDING_TRANSITIONS[f.from].includes(f.to)) b.push(`Cannot move from ${f.from} to ${f.to}`);
  if (f.to === 'suspended' && !(f.reason && f.reason.trim().length >= 5)) b.push('A reason (5+ characters) is required to suspend a supplier');
  if ((f.to === 'profile_submitted' || f.to === 'documents') && f.from !== 'suspended' && !f.profileComplete) b.push('Profile is incomplete');
  if (f.to === 'technical_integration' && f.from === 'documents' && !f.requiredDocsVerified) b.push('Required documents are not verified (or have expired)');
  if (f.to === 'verification' && f.from === 'technical_integration' && !f.integrationReady) b.push('Technical integration is not ready (adapter not configured or health check failing)');
  if (f.to === 'probation' && (f.from === 'verification' || f.from === 'suspended')) {
    if (!f.requiredDocsVerified) b.push('Required documents are not verified (or have expired)');
    if (!f.preProbationPassed) b.push('Verification steps required before probation have not all passed with evidence');
  }
  if (f.to === 'approved') {
    if (!f.requiredDocsVerified) b.push('Required documents are not verified (or have expired)');
    if (!f.productionReady) b.push('Not production_ready: every required verification step must be passed, with evidence, inside its validity window');
    const started = f.probationStartedAt ? f.probationStartedAt.getTime() : null;
    if (started === null || f.now.getTime() - started < f.minProbationDays * DAY) b.push(`Probation must last at least ${f.minProbationDays} day(s)`);
  }
  return { ok: b.length === 0, blockers: b };
}

/* -------------------------------- verification --------------------------------------- */
/** How long a passed step stays valid before the supplier must be re-verified. */
export const STEP_VALIDITY_DAYS: Record<VerificationStepKind, number> = {
  catalogue_availability: 90,
  price_quote_accuracy: 90,
  stock_accuracy_sample: 60,
  test_order_placement: 180,
  cancellation: 180,
  shipment_tracking: 180,
  delivery_observed: 365,
  return_refund_handling: 365,
};

export interface StepLike {
  kind: VerificationStepKind;
  required: boolean;
  status: 'not_started' | 'in_progress' | 'passed' | 'failed';
  passedAt?: Date | null;
  validUntil?: Date | null;
  evidence?: { outcome: 'pass' | 'fail' | 'info' }[];
}

export type EffectiveStepStatus = 'not_started' | 'in_progress' | 'failed' | 'passed' | 'expired' | 'no_evidence';

/** A step only counts while it is passed, unexpired AND backed by at least one passing evidence record. */
export function effectiveStepStatus(s: StepLike | undefined, now: Date): EffectiveStepStatus {
  if (!s) return 'not_started';
  if (s.status === 'passed') {
    if (!s.evidence?.some((e) => e.outcome === 'pass')) return 'no_evidence';
    if (!s.validUntil || s.validUntil.getTime() <= now.getTime()) return 'expired';
    return 'passed';
  }
  return s.status;
}

export interface SupplierReadiness {
  ready: boolean;
  /** required steps not passed (any reason) */
  missing: VerificationStepKind[];
  expired: VerificationStepKind[];
  failed: VerificationStepKind[];
  /** earliest expiry among the required steps; the supplier must be re-verified before then */
  validUntil: Date | null;
}

export function evaluateReadiness(steps: StepLike[], now: Date, only?: readonly VerificationStepKind[]): SupplierReadiness {
  const kinds = only ?? VERIFICATION_STEP_KINDS;
  const byKind = new Map(steps.map((s) => [s.kind, s]));
  const missing: VerificationStepKind[] = [];
  const expired: VerificationStepKind[] = [];
  const failed: VerificationStepKind[] = [];
  let validUntil: Date | null = null;
  for (const k of kinds) {
    const s = byKind.get(k);
    // a step that is explicitly not required (e.g. returns for a supplier that does not accept returns) is skipped
    if (s && !s.required && !only) continue;
    if (!s && !only && k === 'return_refund_handling') continue;
    const e = effectiveStepStatus(s, now);
    if (e === 'passed') {
      if (!validUntil || (s!.validUntil && s!.validUntil < validUntil)) validUntil = s!.validUntil ?? validUntil;
      continue;
    }
    missing.push(k);
    if (e === 'expired') expired.push(k);
    if (e === 'failed') failed.push(k);
  }
  return { ready: missing.length === 0, missing, expired, failed, validUntil: missing.length === 0 ? validUntil : null };
}

export const preProbationReadiness = (steps: StepLike[], now: Date): SupplierReadiness => evaluateReadiness(steps, now, PRE_PROBATION_STEPS);

export const validUntilFor = (kind: VerificationStepKind, passedAt: Date): Date => new Date(passedAt.getTime() + STEP_VALIDITY_DAYS[kind] * DAY);

/** Which steps are required for a supplier: returns only when the supplier says it accepts returns. */
export function requiredStepKinds(p: { returnsAccepted?: boolean }): VerificationStepKind[] {
  return VERIFICATION_STEP_KINDS.filter((k) => k !== 'return_refund_handling' || p.returnsAccepted === true);
}

/** Steps whose validity runs out within `leadDays` (re-verification schedule). */
export function stepsDueForReverification(steps: StepLike[], now: Date, leadDays: number): VerificationStepKind[] {
  return steps.filter((s) => s.required && s.status === 'passed' && s.validUntil && s.validUntil.getTime() - now.getTime() <= leadDays * DAY).map((s) => s.kind);
}

/* -------------------------------- evidence rules ------------------------------------- */
const REF_KEYS = ['orderId', 'shipmentId', 'supplierOrderId', 'documentId', 'externalReference'] as const;

/**
 * Manual attestation must be checkable: a real summary and at least one concrete reference (order, shipment, supplier
 * order id, uploaded document or an external reference such as an RMA number). Some steps need a specific reference.
 */
export function validateManualEvidence(kind: VerificationStepKind, e: ManualEvidenceInput): string[] {
  const problems: string[] = [];
  if (!REF_KEYS.some((k) => !!e[k])) problems.push('Attach at least one reference: an order, shipment, supplier order id, uploaded document or external reference');
  if (kind === 'test_order_placement' && !(e.supplierOrderId || e.orderId)) problems.push('A test order needs the supplier order id or the linked order');
  if (kind === 'cancellation' && !(e.supplierOrderId || e.externalReference)) problems.push('A cancellation needs the supplier order id or the supplier’s cancellation reference');
  if (kind === 'shipment_tracking' && !(e.shipmentId || e.supplierOrderId)) problems.push('Tracking evidence needs the shipment or supplier order id');
  if (kind === 'delivery_observed' && !(e.shipmentId || e.orderId)) problems.push('Delivery evidence needs the shipment or order that was delivered');
  if (kind === 'return_refund_handling' && !(e.externalReference || e.documentId)) problems.push('Return/refund evidence needs the supplier’s RMA/refund reference or a document');
  if (kind === 'price_quote_accuracy') {
    const m = e.metrics ?? {};
    if (typeof m['quotedMinor'] !== 'number' || typeof m['chargedMinor'] !== 'number') problems.push('Price accuracy needs metrics.quotedMinor and metrics.chargedMinor (numbers); pass/fail is computed from them');
  }
  return problems;
}

export interface PriceAccuracy { ok: boolean; diffMinor: number; diffPct: number }
/** Quote vs what the supplier actually charged. Pass only when the charge is not above the quote beyond the tolerance. */
export function evaluatePriceAccuracy(quotedMinor: number, chargedMinor: number, tolerancePct = 0.02): PriceAccuracy {
  const diffMinor = chargedMinor - quotedMinor;
  const diffPct = quotedMinor > 0 ? diffMinor / quotedMinor : chargedMinor === 0 ? 0 : 1;
  return { ok: diffPct <= tolerancePct, diffMinor, diffPct };
}

export interface StockSample { claimed: number; observed: number }
/** A sample is accurate when observed stock is within max(1 unit, 10 %) of the claim, and never zero when stock was claimed. */
export function isStockSampleAccurate(s: StockSample): boolean {
  if (s.claimed > 0 && s.observed === 0) return false;
  return Math.abs(s.claimed - s.observed) <= Math.max(1, Math.round(s.claimed * 0.1));
}
export function evaluateStockAccuracy(samples: StockSample[], opts: { threshold?: number; minSample?: number } = {}): { ok: boolean; accuracy: number | null; sample: number; reason?: string } {
  const minSample = opts.minSample ?? 5;
  const threshold = opts.threshold ?? 0.9;
  if (samples.length < minSample) return { ok: false, accuracy: null, sample: samples.length, reason: `At least ${minSample} observed samples are needed (got ${samples.length})` };
  const accuracy = samples.filter(isStockSampleAccurate).length / samples.length;
  return { ok: accuracy >= threshold, accuracy, sample: samples.length, reason: accuracy >= threshold ? undefined : `Accuracy ${(accuracy * 100).toFixed(0)}% is below the ${(threshold * 100).toFixed(0)}% threshold` };
}

/* --------------------------------- routing guard ------------------------------------- */
export interface RoutingSupplierFacts {
  active?: boolean;
  network?: { state?: string | null; productionReady?: boolean | null; productionReadyUntil?: Date | null } | null;
}

/**
 * Production routing guard. When enforcement is off (default outside production) nothing changes. When on, only
 * `approved` + `production_ready` suppliers whose readiness has not lapsed may receive new orders.
 */
export function routingEligibility(s: RoutingSupplierFacts, enforce: boolean, now: Date = new Date()): { ok: boolean; reason?: string } {
  if (!enforce) return { ok: true };
  const n = s.network;
  if (!n?.state) return { ok: false, reason: 'supplier has not completed ORVIA onboarding (no verification record)' };
  if (n.state !== 'approved') return { ok: false, reason: `supplier is ${n.state}, not approved` };
  if (!n.productionReady) return { ok: false, reason: 'supplier is not production_ready' };
  if (!n.productionReadyUntil || n.productionReadyUntil.getTime() <= now.getTime()) return { ok: false, reason: 'supplier verification has expired; re-verification required' };
  return { ok: true };
}

/* --------------------------------- demotion ------------------------------------------ */
export type SlaWorst = 'ok' | 'warning' | 'critical' | 'insufficient_data';
/**
 * Automatic demotion on SLA breach: a critical breach moves an approved supplier back to probation (it stops being
 * routable in production). It never auto-suspends and never promotes.
 */
export function decideDemotion(current: SupplierOnboardingState, worst: SlaWorst): { demote: boolean; to?: SupplierOnboardingState; reason?: string } {
  if (current === 'approved' && worst === 'critical') return { demote: true, to: 'probation', reason: 'Automatic demotion: critical SLA breach' };
  return { demote: false };
}

/* --------------------------------- disputes ------------------------------------------ */
export const DISPUTE_TRANSITIONS: Record<DisputeState, readonly DisputeState[]> = {
  open: ['awaiting_supplier', 'resolved_no_action', 'rejected', 'escalated'],
  awaiting_supplier: ['awaiting_orvia', 'escalated', 'resolved_credit', 'resolved_no_action', 'rejected'],
  awaiting_orvia: ['awaiting_supplier', 'resolved_credit', 'resolved_no_action', 'rejected', 'escalated'],
  escalated: ['awaiting_supplier', 'resolved_credit', 'resolved_no_action', 'rejected'],
  resolved_credit: ['closed'], resolved_no_action: ['closed'], rejected: ['closed'], closed: [],
};
export const canDisputeTransition = (from: DisputeState, to: DisputeState): boolean => DISPUTE_TRANSITIONS[from].includes(to);
