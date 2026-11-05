/** Pure state machines for RMA, supplier claims and chargebacks. */
import type { ChargebackState, ClaimState, RmaState } from '@orvia/types';

export type Machine<S extends string> = Record<S, readonly S[]>;

export const RMA_MACHINE: Machine<RmaState> = {
  submitted: ['authorized', 'rejected', 'cancelled'],
  authorized: ['in_transit', 'received', 'refund_pending', 'replacement_pending', 'resolved', 'cancelled', 'rejected'],
  in_transit: ['received', 'cancelled', 'rejected'],
  received: ['inspected', 'rejected'],
  inspected: ['refund_pending', 'replacement_pending', 'resolved', 'rejected'],
  refund_pending: ['resolved', 'rejected'],
  replacement_pending: ['resolved', 'rejected'],
  resolved: [],
  rejected: [],
  cancelled: [],
};

export const CLAIM_MACHINE: Machine<ClaimState> = {
  draft: ['submitted', 'written_off'],
  submitted: ['acknowledged', 'accepted', 'partially_accepted', 'rejected', 'written_off'],
  acknowledged: ['accepted', 'partially_accepted', 'rejected', 'written_off'],
  accepted: ['recovered', 'written_off'],
  partially_accepted: ['recovered', 'written_off'],
  rejected: ['submitted', 'written_off'], // may be re-submitted with new evidence
  recovered: [],
  written_off: [],
};

/**
 * Chargeback states. Provider events drive most moves; staff drive `evidence_recorded`, `submitted` and `accepted`.
 * Terminal: won, lost, accepted, closed.
 */
export const CHARGEBACK_MACHINE: Machine<ChargebackState> = {
  warning: ['needs_response', 'under_review', 'closed', 'won', 'lost'],
  needs_response: ['evidence_recorded', 'submitted', 'under_review', 'accepted', 'won', 'lost', 'closed'],
  evidence_recorded: ['evidence_recorded', 'submitted', 'under_review', 'accepted', 'won', 'lost', 'closed'],
  submitted: ['under_review', 'won', 'lost', 'closed'],
  under_review: ['won', 'lost', 'closed'],
  won: [],
  lost: [],
  accepted: ['lost', 'closed'],
  closed: [],
};

export const canTransition = <S extends string>(m: Machine<S>, from: S, to: S): boolean => from === to ? false : (m[from] ?? []).includes(to);
export const isTerminal = <S extends string>(m: Machine<S>, s: S): boolean => (m[s] ?? []).length === 0;

/** Throwing variant used by services. */
export function assertTransition<S extends string>(m: Machine<S>, from: S, to: S, what: string): void {
  if (!canTransition(m, from, to)) throw new TransitionError(`${what} cannot go from "${from}" to "${to}"`);
}
export class TransitionError extends Error {
  constructor(msg: string) { super(msg); this.name = 'TransitionError'; }
}

/** Supplier-claim money rules: approved ≤ claimed, recovered ≤ approved. */
export function validateClaimAmounts(to: ClaimState, a: { claimed: number; approved?: number; recovered?: number }): string | null {
  if (to === 'accepted' && a.approved !== undefined && a.approved !== a.claimed) return 'An accepted claim must be approved for the full claimed amount; use "partially accepted" otherwise';
  if (to === 'partially_accepted' && !(a.approved !== undefined && a.approved > 0 && a.approved < a.claimed)) return 'Partially accepted needs an approved amount between 1 and the claimed amount minus 1';
  if (a.approved !== undefined && a.approved > a.claimed) return 'Approved amount cannot exceed the claimed amount';
  if (to === 'recovered') {
    if (a.recovered === undefined || a.recovered <= 0) return 'Enter the amount actually recovered';
    if (a.approved !== undefined && a.recovered > a.approved) return 'Recovered amount cannot exceed the approved amount';
  }
  return null;
}

/** Recoverable from a supplier: goods cost (and shipping cost when the supplier failed to deliver/delivered wrong goods), never more than we paid or refunded. */
export function maxRecoverable(kind: 'defect' | 'non_delivery' | 'wrong_item' | 'damaged_in_transit', c: { productCost: number; shippingCost: number; refundedToCustomer: number }): number {
  const cost = kind === 'defect' ? c.productCost : c.productCost + c.shippingCost;
  return Math.max(0, Math.min(cost, c.productCost + c.shippingCost));
}

/** Claim deadline: delivered/ordered date + the supplier's claim window (or the platform default). */
export function claimDeadline(basis: Date, supplierWindowDays: number | undefined, defaultWindowDays: number): Date {
  return new Date(basis.getTime() + (supplierWindowDays ?? defaultWindowDays) * 86_400_000);
}
