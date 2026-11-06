/**
 * Customer Advocate: deterministic resolution recommendation + outcome metrics (pure, no IO).
 * The advocate looks at a problem from the customer's side, but ONLY among options that policy and the deterministic engines
 * already permit. It recommends; the rescue engine / aftersales service / staff approval limits execute. An LLM may explain
 * the recommendation in words, never change it and never add an option.
 */
import { ADVOCATE_MIN_SAMPLE } from '@orvia/types';

export const PROBLEMS = ['delayed', 'damaged', 'missing', 'wrong_item', 'other'] as const;
export type Problem = (typeof PROBLEMS)[number];
export type ResolutionKind = 'wait' | 'replacement' | 'refund' | 'rescue_offer' | 'staff_review';

export interface AdvocateRescueOffer { id: string; kind: string; label: string; refund: number | null; etaMaxDays: number | null }
export interface AdvocateFacts {
  problem: Problem;
  currency: string;
  /** Order is paid and not cancelled. */
  orderOk: boolean;
  delivered: boolean;
  /** Deterministic rescue engine state for this order (null when there is no case). */
  rescue: { state: string; recommendedKind: string | null; offers: AdvocateRescueOffer[] } | null;
  /** Aftersales eligibility for the affected goods (null when it could not be evaluated). */
  eligibility: { eligible: boolean; replacementAllowed: boolean; reasons: string[]; daysLeft: number | null } | null;
  /** Refund the deterministic refund math would produce for the eligible goods (minor units), or null. */
  refundMinor: number | null;
  /** An open return/claim already exists for this order. */
  openCase: boolean;
}
export interface ResolutionOption { kind: ResolutionKind; label: string; permitted: boolean; reason: string; refundMinor?: number | null; offerId?: string; rescueKind?: string }
export interface AdvocateRecommendation { options: ResolutionOption[]; recommended: ResolutionKind | null; recommendedLabel: string | null; needsStaff: boolean; fairnessNote: string }

const money = (minor: number, cur: string) => `${(minor / 100).toFixed(2)} ${cur}`;

/** Published ordering (also in docs): the customer-fairest permitted option for each problem. */
export function recommendResolution(f: AdvocateFacts): AdvocateRecommendation {
  const options: ResolutionOption[] = [];
  const addRescue = (): void => {
    for (const o of f.rescue?.offers ?? []) {
      options.push({ kind: 'rescue_offer', rescueKind: o.kind, label: o.label, permitted: true, reason: `Offered by our delivery recovery engine${o.refund ? ` (refund ${money(o.refund, f.currency)})` : ''}; you stay in control, nothing happens until you accept.`, refundMinor: o.refund, offerId: o.id });
    }
  };
  if (!f.orderOk) {
    options.push({ kind: 'staff_review', label: 'Ask a team member to look at this order', permitted: true, reason: 'This order is not in a paid, active state, so automatic options do not apply.' });
    return { options, recommended: 'staff_review', recommendedLabel: options[0]!.label, needsStaff: true, fairnessNote: 'No automatic option applies; a person will review.' };
  }
  if (f.openCase) options.push({ kind: 'staff_review', label: 'Follow up on your open request', permitted: true, reason: 'There is already an open return or claim for this order, so we will not start a second one.' });

  addRescue();
  const elig = f.eligibility;
  const refundable = f.refundMinor !== null && f.refundMinor > 0;
  if (elig?.eligible && !f.openCase) {
    options.push({ kind: 'refund', label: 'Return the item for a refund', permitted: true, refundMinor: f.refundMinor, reason: refundable ? `Eligible under the return policy; the refund is calculated as ${money(f.refundMinor!, f.currency)} by our refund rules.` : 'Eligible under the return policy; the exact amount is calculated by our refund rules after inspection.' });
    if (elig.replacementAllowed) options.push({ kind: 'replacement', label: 'Request a replacement', permitted: true, reason: 'The supplier policy allows a replacement. This creates a request that our team approves; it is not automatic.' });
    else options.push({ kind: 'replacement', label: 'Request a replacement', permitted: false, reason: 'A replacement is not available for this item under the supplier policy.' });
  } else if (elig && !elig.eligible) {
    options.push({ kind: 'refund', label: 'Return the item for a refund', permitted: false, reason: elig.reasons[0] ?? 'Not eligible under the return policy.' });
  }
  if (f.problem === 'delayed' && !f.delivered) options.push({ kind: 'wait', label: 'Keep waiting for delivery', permitted: true, reason: 'The order has not been delivered yet; tracking continues and you will be notified.' });
  if (!options.some((o) => o.permitted && o.kind !== 'staff_review')) options.push({ kind: 'staff_review', label: 'Ask a team member to look at this order', permitted: true, reason: 'No automatic option is permitted, so a person decides.' });
  else if (!options.some((o) => o.kind === 'staff_review')) options.push({ kind: 'staff_review', label: 'Ask a team member to look at this order', permitted: true, reason: 'You can always ask a person to review your case.' });

  const has = (k: ResolutionKind) => options.find((o) => o.kind === k && o.permitted);
  const rescueRec = f.rescue?.offers.find((o) => o.kind === f.rescue?.recommendedKind);
  let pick: ResolutionOption | undefined;
  let note = '';
  switch (f.problem) {
    case 'damaged':
    case 'wrong_item':
      pick = has('replacement') ?? has('refund') ?? options.find((o) => o.kind === 'rescue_offer');
      note = 'For faulty or wrong goods the fault is ours, so the fairest permitted option is a replacement, or a refund where a replacement is not available.';
      break;
    case 'missing':
      pick = (rescueRec && options.find((o) => o.offerId === rescueRec.id)) ?? has('refund') ?? options.find((o) => o.kind === 'rescue_offer');
      note = 'For missing goods the fairest permitted option is the delivery recovery engine\'s recommendation, otherwise a refund.';
      break;
    case 'delayed':
      pick = (rescueRec && options.find((o) => o.offerId === rescueRec.id)) ?? (f.rescue ? options.find((o) => o.kind === 'rescue_offer') : undefined) ?? has('wait');
      note = 'For a late order the fairest permitted option is what the recovery engine recommends once it has decided the order is at risk; before that, waiting with live tracking.';
      break;
    default:
      pick = undefined;
      note = 'This does not fit a standard problem, so a person should decide.';
  }
  if (!pick) pick = options.find((o) => o.kind === 'staff_review' && o.permitted);
  return { options, recommended: pick?.kind ?? null, recommendedLabel: pick?.label ?? null, needsStaff: pick?.kind === 'staff_review', fairnessNote: note };
}

/* ----------------------------------- metrics ----------------------------------- */
export type Metric = { status: 'ok'; value: number; n: number } | { status: 'insufficient_data'; n: number; needed: number };
const metric = (values: number[], needed: number): Metric => (values.length >= needed ? { status: 'ok', value: values.reduce((a, b) => a + b, 0) / values.length, n: values.length } : { status: 'insufficient_data', n: values.length, needed });

export interface FinalOutcome { kind: 'refund' | 'replacement' | 'wait' | 'other'; refundMinor?: number | null }
export interface AdvocateRecord {
  recommendedKind: ResolutionKind | null;
  /** When the recommendation was a rescue-engine offer: that offer's kind. */
  recommendedRescueKind?: string | null;
  recommendedRefundMinor?: number | null;
  rating?: number | null;
  /** Final engine/staff outcome once known. */
  final?: FinalOutcome | null;
  /** Resolved without a second advocate run and without an escalation. Only meaningful when `final` is known. */
  firstContact?: boolean;
  /** Repeat paid order after resolution; null while the observation window has not elapsed. */
  repeatPurchase?: boolean | null;
}
export interface AdvocateMetrics {
  minSample: number;
  cases: number;
  resolved: number;
  satisfaction: Metric;
  firstContactResolution: Metric;
  refundAccuracy: { kindMatch: Metric; exactAmount: Metric };
  retention: Metric;
}

/** Maps a recommendation to the class of final outcome it should lead to. */
export function expectedFinalKind(k: ResolutionKind | null, rescueKind?: string | null): FinalOutcome['kind'] | null {
  if (k === 'refund' || k === 'replacement' || k === 'wait') return k;
  if (k !== 'rescue_offer') return null;
  if (rescueKind === 'offer_full_refund' || rescueKind === 'offer_partial_refund') return 'refund';
  if (rescueKind === 'offer_equivalent_replacement' || rescueKind === 'reorder_same_product_alt_supplier') return 'replacement';
  if (rescueKind === 'continue_shipment') return 'wait';
  return 'other';
}

/** Metrics from real stored records. Every metric is "insufficient_data" below `minSample` observations; nothing is extrapolated. */
export function computeAdvocateMetrics(records: AdvocateRecord[], minSample = ADVOCATE_MIN_SAMPLE): AdvocateMetrics {
  const resolved = records.filter((r) => r.final);
  const rated = records.filter((r) => typeof r.rating === 'number').map((r) => r.rating as number);
  const fcr = resolved.map((r) => (r.firstContact ? 1 : 0));
  const comparable = resolved.filter((r) => r.recommendedKind && r.recommendedKind !== 'staff_review' && expectedFinalKind(r.recommendedKind, r.recommendedRescueKind) !== null);
  const kindMatch = comparable.map((r) => (expectedFinalKind(r.recommendedKind, r.recommendedRescueKind) === r.final!.kind ? 1 : 0));
  const amountPairs = comparable.filter((r) => expectedFinalKind(r.recommendedKind, r.recommendedRescueKind) === 'refund' && r.final!.kind === 'refund' && typeof r.recommendedRefundMinor === 'number' && typeof r.final!.refundMinor === 'number');
  const exact = amountPairs.map((r) => (r.recommendedRefundMinor === r.final!.refundMinor ? 1 : 0));
  const retained = resolved.filter((r) => r.repeatPurchase === true || r.repeatPurchase === false).map((r) => (r.repeatPurchase ? 1 : 0));
  return {
    minSample, cases: records.length, resolved: resolved.length,
    satisfaction: metric(rated, minSample),
    firstContactResolution: metric(fcr, minSample),
    refundAccuracy: { kindMatch: metric(kindMatch, minSample), exactAmount: metric(exact, minSample) },
    retention: metric(retained, minSample),
  };
}
