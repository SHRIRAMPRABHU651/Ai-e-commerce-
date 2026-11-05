/** Provider-neutral dispute (chargeback) model and status mapping shared by the adapters. Pure. */
import type { ChargebackState } from '@orvia/types';

export interface ProviderDispute {
  disputeId: string;
  /** Payment intent / order id as our Payment.intentId knows it. May be empty when only a charge/payment id is known. */
  intentId?: string;
  /** Provider charge/payment id used to resolve `intentId` through `resolveIntentFromCharge`. */
  chargeId?: string;
  amount: number;
  currency: string;
  reason?: string;
  /** Provider's raw status string (kept for display/audit). */
  providerStatus: string;
  /** Mapped, provider-neutral state. */
  state: ChargebackState;
  evidenceDueBy?: Date;
  openedAt?: Date;
  /** Provider-imposed dispute fee in minor units, when reported. */
  fee?: number;
}

export interface DisputeEvidenceInput {
  disputeId: string;
  summary: string;
  productDescription?: string;
  refundPolicy?: string;
  /** Submit for review (final) rather than save as a draft. */
  submit: boolean;
}

/** Stripe `dispute.status` -> internal state. */
export function mapStripeDisputeStatus(s: string): ChargebackState {
  switch (s) {
    case 'warning_needs_response': return 'warning';
    case 'warning_under_review': return 'warning';
    case 'warning_closed': return 'closed';
    case 'needs_response': return 'needs_response';
    case 'under_review': return 'under_review';
    case 'won': return 'won';
    case 'lost': return 'lost';
    case 'charge_refunded': return 'closed';
    default: return 'needs_response';
  }
}

/** Razorpay dispute `status` (+ webhook event name) -> internal state. */
export function mapRazorpayDisputeStatus(status: string, event?: string): ChargebackState {
  if (event === 'payment.dispute.won' || status === 'won') return 'won';
  if (event === 'payment.dispute.lost' || status === 'lost') return 'lost';
  if (event === 'payment.dispute.closed' || status === 'closed') return 'closed';
  if (event === 'payment.dispute.under_review' || status === 'under_review') return 'under_review';
  return 'needs_response'; // created / open / action_required
}
