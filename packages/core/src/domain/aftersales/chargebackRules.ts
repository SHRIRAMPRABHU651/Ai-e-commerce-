/** Pure chargeback rules: status mapping, deadline tracking, reserve accounting, rate metric. */
import type { ChargebackState } from '@orvia/types';
import { CHARGEBACK_MACHINE, canTransition } from './stateMachines';

/** Provider moves only forward; a late or replayed event never reopens a terminal dispute. Returns the state to store. */
export function nextChargebackState(current: ChargebackState, incoming: ChargebackState): ChargebackState {
  if (current === incoming) return current;
  // a recorded/submitted state is ours; a provider "needs_response" replay must not undo it
  if (incoming === 'needs_response' && ['evidence_recorded', 'submitted', 'under_review'].includes(current)) return current;
  if (incoming === 'warning' && current !== 'warning') return current;
  return canTransition(CHARGEBACK_MACHINE, current, incoming) ? incoming : current;
}

export type DeadlineState = 'none' | 'ok' | 'due_soon' | 'overdue';
export function deadlineState(now: Date, dueBy: Date | null | undefined, state: ChargebackState, soonHours = 72): DeadlineState {
  if (!dueBy || !['warning', 'needs_response', 'evidence_recorded'].includes(state)) return 'none';
  const ms = dueBy.getTime() - now.getTime();
  if (ms < 0) return 'overdue';
  return ms <= soonHours * 3_600_000 ? 'due_soon' : 'ok';
}

/**
 * Reserve accounting hook for the finance workstream.
 * While a dispute is open we reserve the disputed amount plus fee (funds are normally withdrawn by the PSP at
 * dispute creation). On `won` the amount is released (fee is usually not returned); on `lost`/`accepted` it becomes a loss.
 */
export interface ReserveView { held: number; lost: number; released: number; fee: number }
export function chargebackReserve(c: { state: ChargebackState; amount: number; fee?: number }): ReserveView {
  const fee = c.fee ?? 0;
  switch (c.state) {
    case 'warning': return { held: 0, lost: 0, released: 0, fee: 0 }; // inquiry: funds not withdrawn
    case 'needs_response':
    case 'evidence_recorded':
    case 'submitted':
    case 'under_review': return { held: c.amount + fee, lost: 0, released: 0, fee };
    case 'won': return { held: 0, lost: fee, released: c.amount, fee };
    case 'lost':
    case 'accepted': return { held: 0, lost: c.amount + fee, released: 0, fee };
    case 'closed': return { held: 0, lost: 0, released: c.amount, fee };
  }
}

export function sumReserves(items: { state: ChargebackState; amount: number; fee?: number }[]): ReserveView {
  return items.reduce<ReserveView>((a, c) => {
    const r = chargebackReserve(c);
    return { held: a.held + r.held, lost: a.lost + r.lost, released: a.released + r.released, fee: a.fee + r.fee };
  }, { held: 0, lost: 0, released: 0, fee: 0 });
}

export interface ChargebackRate {
  disputes: number;
  transactions: number;
  countRate: number | null;
  amountRate: number | null;
  reliable: boolean;
  note?: string;
}
/** Disputes ÷ successful transactions. Under `minTransactions` the rate is statistically unreliable and reported as insufficient data. */
export function chargebackRate(a: { disputes: number; transactions: number; disputedAmount: number; transactedAmount: number }, minTransactions = 100): ChargebackRate {
  const reliable = a.transactions >= minTransactions;
  return {
    disputes: a.disputes,
    transactions: a.transactions,
    countRate: a.transactions > 0 ? a.disputes / a.transactions : null,
    amountRate: a.transactedAmount > 0 ? a.disputedAmount / a.transactedAmount : null,
    reliable,
    ...(reliable ? {} : { note: `Insufficient data: fewer than ${minTransactions} transactions in the window` }),
  };
}

/** Card-network monitoring programmes escalate around 0.9%-1% disputes/transactions; we only flag, we do not assert exact thresholds. */
export const CHARGEBACK_ATTENTION_RATE = 0.0075;
