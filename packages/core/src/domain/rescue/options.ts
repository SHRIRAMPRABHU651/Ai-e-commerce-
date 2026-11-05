/**
 * Delivery Rescue: recovery option generation, deterministic financial impact and recommendation. Pure.
 * All money is integer minor units in the ORDER currency. An LLM may attach `aiExplanation` text elsewhere; it
 * never influences anything computed here.
 */
import type { RescueFailureKind, RescueOptionKind, RescuePolicy, RescueSeverity } from '@orvia/types';
import type { GuardDecision } from './guard';
import type { RankedAlt } from './ranker';

const DAY = 86_400_000;

export interface ReplacementCandidate {
  productId: string;
  title: string;
  sku: string;
  supplierId: string;
  supplierName: string;
  externalId: string;
  supplierSku?: string;
  /** Whole-line landed cost (replacement unit cost x qty + shipping + duties), order currency. */
  landedCost: number;
  /** What the replacement normally sells for (shown to the customer; they are NEVER charged extra). */
  unitPrice: number;
  minDays: number;
  maxDays: number;
  stock: number;
  category?: string;
}

export interface OriginalPlan {
  hasLiveShipment: boolean;
  status: string | null;
  supplierId: string | null;
  /** Whole-line landed cost of the original supplier order; 0 when unknown (costKnown=false). */
  cost: number;
  costKnown: boolean;
  /** not_placed: no supplier order exists. cancellable: placed but not dispatched. dispatched: in transit. */
  cancelPath: 'not_placed' | 'cancellable' | 'dispatched';
}

export interface OptionsInput {
  kind: RescueFailureKind;
  severity: RescueSeverity;
  currency: string;
  title: string;
  quantity: number;
  lineValue: number;
  /** Remaining refundable amount on the whole order. */
  orderRefundable: number;
  orderIsSingleLine: boolean;
  original: OriginalPlan;
  promiseAt: Date;
  now: Date;
  alternatives: RankedAlt[];
  replacements: ReplacementCandidate[];
  /** Duplicate-order guard evaluated for this line with NO staff acknowledgement. */
  guard: GuardDecision;
  policy: RescuePolicy;
  fmt?: (minor: number) => string;
}

export interface OptionImpact {
  /** New supplier spend net of what is recovered from cancelling the original (signed; negative = cheaper). */
  extraCost: number;
  refund: number;
  /** Original supplier spend that cannot be recovered. */
  sunkCost: number;
  /** Margin forgone (full refund). */
  lostMargin: number;
  /** Change in the line's contribution vs "everything went to plan" (negative = we lose money). */
  contributionDelta: number;
  /** Money we put at risk for limits: max(0, extraCost) + refund. */
  exposure: number;
}

export interface RescueOption {
  id: string;
  kind: RescueOptionKind;
  label: string;
  /** Plain-language description for the customer. */
  customerText: string;
  /** Technical description for staff. */
  staffText: string;
  feasible: boolean;
  infeasibleReason?: string;
  materialChange: boolean;
  materialReasons: string[];
  /** Customer must agree before this runs. */
  requiresCustomerConsent: boolean;
  /** Reorder over a possibly-still-arriving parcel: staff must acknowledge duplicate risk. */
  needsDuplicateAck: boolean;
  impact: OptionImpact;
  eta: { minDays: number | null; maxDays: number | null; worseningDays: number | null };
  supplier?: { id: string; name: string; code?: string; externalId: string; sku?: string; score?: number; breakdown?: RankedAlt['breakdown'] };
  replacement?: { productId: string; title: string; sku: string; supplierId: string; supplierName: string; externalId: string; supplierSku?: string };
  /** Landed cost the plan assumed; execution re-quotes live and refuses a material drift. */
  plannedLandedCost: number;
}

export interface OptionSet {
  options: RescueOption[];
  recommendedId: string;
  recommendationReason: string;
}

const zeroImpact: OptionImpact = { extraCost: 0, refund: 0, sunkCost: 0, lostMargin: 0, contributionDelta: 0, exposure: 0 };
const CONTINUABLE: RescueFailureKind[] = ['shipment_delay', 'carrier_exception', 'invalid_tracking', 'unusual_delivery_pattern'];
const KEEP_PRODUCT: RescueFailureKind[] = ['shipment_delay', 'carrier_exception', 'invalid_tracking'];
const UNFULFILLABLE: RescueFailureKind[] = ['supplier_cancellation', 'supplier_acceptance_failure', 'stock_shortage'];

export const worseningDays = (now: Date, promiseAt: Date, maxDays: number): number => Math.max(0, Math.ceil((now.getTime() + maxDays * DAY - promiseAt.getTime()) / DAY));

function swapImpact(o: OriginalPlan, newLanded: number): OptionImpact {
  const recovered = o.cancelPath !== 'dispatched';
  const sunk = recovered ? 0 : o.cost;
  const extra = newLanded - o.cost + sunk; // = newLanded when original is sunk and its cost was already counted
  return { extraCost: extra, refund: 0, sunkCost: sunk, lostMargin: 0, contributionDelta: -extra, exposure: Math.max(0, extra) };
}

export function generateOptions(i: OptionsInput): OptionSet {
  const fmt = i.fmt ?? ((n: number) => `${(n / 100).toFixed(2)} ${i.currency}`);
  const opts: RescueOption[] = [];
  const base = (o: Omit<RescueOption, 'needsDuplicateAck' | 'plannedLandedCost' | 'materialReasons' | 'requiresCustomerConsent'> & Partial<Pick<RescueOption, 'needsDuplicateAck' | 'plannedLandedCost' | 'materialReasons' | 'requiresCustomerConsent'>>): RescueOption => ({
    needsDuplicateAck: false,
    plannedLandedCost: 0,
    materialReasons: [],
    requiresCustomerConsent: o.materialChange && o.kind !== 'escalate_human',
    ...o,
  });

  // 1. continue / monitor
  const canContinue = CONTINUABLE.includes(i.kind) && i.original.hasLiveShipment;
  opts.push(base({
    id: 'continue_shipment', kind: 'continue_shipment', label: 'Keep waiting for the original shipment',
    customerText: 'Keep your original order moving. We keep watching it and will tell you straight away if anything changes.',
    staffText: 'No action; keep monitoring tracking. Case re-checks on the next scan.',
    feasible: canContinue, infeasibleReason: canContinue ? undefined : 'There is no live shipment to continue, or the problem needs action.',
    materialChange: false, impact: zeroImpact,
    eta: { minDays: null, maxDays: null, worseningDays: null },
  }));

  // 2. same product, alternative supplier
  const guardOk = i.guard.allow || i.guard.code === 'goods_in_transit';
  const reorderKindOk = i.kind !== 'unusual_delivery_pattern' && i.kind !== 'failed_delivery';
  const eligibleAlts = i.alternatives.filter((a) => a.eligible).slice(0, 2);
  if (eligibleAlts.length) {
    for (const a of eligibleAlts) {
      const impact = swapImpact(i.original, a.landedCost);
      const worse = worseningDays(i.now, i.promiseAt, a.maxDays);
      const material = worse > i.policy.maxEtaWorseningDays;
      const feasible = reorderKindOk && guardOk;
      opts.push(base({
        id: `reorder_same_product_alt_supplier:${a.supplierId}`, kind: 'reorder_same_product_alt_supplier', label: `Send the same product from ${a.supplierName}`,
        customerText: `We send you the same product from another approved supplier. It should arrive within ${a.minDays}-${a.maxDays} days${worse > 0 ? `, about ${worse} day${worse === 1 ? '' : 's'} later than first promised` : ''}. You pay nothing extra.`,
        staffText: `Reorder ${i.quantity}x from ${a.supplierName} (${a.supplierCode}); landed ${fmt(a.landedCost)} vs original ${i.original.costKnown ? fmt(i.original.cost) : 'unknown'}; ETA ${a.minDays}-${a.maxDays}d (+${worse}d vs promise); rank ${a.score}.`,
        feasible, infeasibleReason: feasible ? undefined : !reorderKindOk ? 'Re-ordering will not fix this kind of failure.' : (i.guard.allow ? undefined : i.guard.reason),
        materialChange: material, materialReasons: material ? [`Delivery moves ${worse} days later than promised (limit ${i.policy.maxEtaWorseningDays}).`] : [],
        needsDuplicateAck: !i.guard.allow && i.guard.code === 'goods_in_transit',
        impact, eta: { minDays: a.minDays, maxDays: a.maxDays, worseningDays: worse },
        supplier: { id: a.supplierId, name: a.supplierName, code: a.supplierCode, externalId: a.externalId, sku: a.sku, score: a.score, breakdown: a.breakdown },
        plannedLandedCost: a.landedCost,
      }));
    }
  } else {
    opts.push(base({
      id: 'reorder_same_product_alt_supplier', kind: 'reorder_same_product_alt_supplier', label: 'Send the same product from another supplier',
      customerText: '', staffText: 'No approved alternative supplier can serve this product to this destination with enough stock.',
      feasible: false, infeasibleReason: i.alternatives.length ? (i.alternatives.find((a) => a.ineligibleReason)?.ineligibleReason ?? 'No eligible alternative') : 'No other approved supplier is linked to this product for this destination.',
      materialChange: false, impact: zeroImpact, eta: { minDays: null, maxDays: null, worseningDays: null },
    }));
  }

  // 3. equivalent replacement (always a material change: different product)
  const rep = [...i.replacements].sort((a, b) => a.landedCost - b.landedCost || a.productId.localeCompare(b.productId))[0];
  if (rep) {
    const impact = swapImpact(i.original, rep.landedCost);
    const worse = worseningDays(i.now, i.promiseAt, rep.maxDays);
    const reorderFeasibleNow = opts.some((o) => o.kind === 'reorder_same_product_alt_supplier' && o.feasible);
    const kindOk = UNFULFILLABLE.includes(i.kind) || i.kind === 'suspected_lost';
    const feasible = kindOk && guardOk && rep.stock >= i.quantity && !reorderFeasibleNow;
    opts.push(base({
      id: `offer_equivalent_replacement:${rep.productId}`, kind: 'offer_equivalent_replacement', label: `Replace with a similar product: ${rep.title}`,
      customerText: `We cannot supply "${i.title}". As an alternative we can send "${rep.title}" instead, a different but similar product${rep.unitPrice > 0 ? ` (normally ${fmt(rep.unitPrice)}; you pay nothing extra)` : ''}. Expected in ${rep.minDays}-${rep.maxDays} days. Please check it suits you before accepting; otherwise choose a refund.`,
      staffText: `Replacement ${rep.title} (${rep.sku}) from ${rep.supplierName}, same category${rep.category ? ` "${rep.category}"` : ''}; this is NOT the same product (material change). Landed ${fmt(rep.landedCost)}.`,
      feasible, infeasibleReason: feasible ? undefined : 'A replacement is only offered when the original cannot be supplied or is lost, and the same product is not available elsewhere.',
      materialChange: true, materialReasons: ['Different product from the one ordered.'],
      needsDuplicateAck: !i.guard.allow && i.guard.code === 'goods_in_transit',
      impact, eta: { minDays: rep.minDays, maxDays: rep.maxDays, worseningDays: worse },
      replacement: { productId: rep.productId, title: rep.title, sku: rep.sku, supplierId: rep.supplierId, supplierName: rep.supplierName, externalId: rep.externalId, supplierSku: rep.supplierSku },
      plannedLandedCost: rep.landedCost,
    }));
  }

  // 4. partial refund (customer keeps the order)
  const pct = Math.min(i.policy.defaultPartialRefundPct, i.policy.maxPartialRefundPct);
  const partial = Math.min(Math.round(i.lineValue * pct), i.orderRefundable);
  const canPartial = KEEP_PRODUCT.includes(i.kind) && i.original.hasLiveShipment && partial > 0;
  opts.push(base({
    id: 'offer_partial_refund', kind: 'offer_partial_refund', label: 'Keep waiting and receive a partial refund',
    customerText: `Keep your order and we refund ${fmt(partial)} (${Math.round(pct * 100)}%) as an apology for the delay.`,
    staffText: `Partial refund ${fmt(partial)} through the standard refund function (its limits apply); shipment continues.`,
    feasible: canPartial, infeasibleReason: canPartial ? undefined : 'A partial refund only applies while the customer still receives the product.',
    materialChange: true, materialReasons: ['Price terms change: part of the payment is returned.'],
    impact: { ...zeroImpact, refund: partial, contributionDelta: -partial, exposure: partial },
    eta: { minDays: null, maxDays: null, worseningDays: null },
  }));

  // 5. full refund
  const refundAmt = Math.min(i.orderIsSingleLine ? i.orderRefundable : i.lineValue, i.orderRefundable);
  const lostMargin = Math.max(0, i.lineValue - (i.original.costKnown ? i.original.cost : 0));
  const sunk = i.original.cancelPath === 'dispatched' ? i.original.cost : 0;
  const reorderFeasible = opts.some((o) => o.kind === 'reorder_same_product_alt_supplier' && o.feasible);
  const unfulfillable = (UNFULFILLABLE.includes(i.kind) || i.kind === 'suspected_lost') && !reorderFeasible && !opts.some((o) => o.kind === 'offer_equivalent_replacement' && o.feasible);
  opts.push(base({
    id: 'offer_full_refund', kind: 'offer_full_refund', label: 'Cancel and get a full refund',
    customerText: `Cancel ${i.orderIsSingleLine ? 'your order' : `"${i.title}"`} and receive a full refund of ${fmt(refundAmt)}.`,
    staffText: `Refund ${fmt(refundAmt)} through the standard refund function (limits apply); cancel the supplier order first if one is live and cancellable.${sunk ? ` Original supplier cost ${fmt(sunk)} is sunk (parcel dispatched).` : ''}`,
    feasible: refundAmt > 0, infeasibleReason: refundAmt > 0 ? undefined : 'Nothing left to refund.',
    materialChange: true, materialReasons: ['The order is cancelled and refunded.'],
    requiresCustomerConsent: !unfulfillable,
    impact: { extraCost: 0, refund: refundAmt, sunkCost: sunk, lostMargin, contributionDelta: -(i.lineValue - (i.original.costKnown ? i.original.cost : 0)) - sunk, exposure: refundAmt },
    eta: { minDays: null, maxDays: null, worseningDays: null },
  }));

  // 6. human
  opts.push(base({
    id: 'escalate_human', kind: 'escalate_human', label: 'Ask a team member to handle this',
    customerText: 'A member of our team will look at your order personally and contact you.',
    staffText: 'Hand the case to staff with all evidence and options.',
    feasible: true, materialChange: false, impact: zeroImpact, eta: { minDays: null, maxDays: null, worseningDays: null },
  }));

  const rec = recommend(i, opts);
  return { options: opts, recommendedId: rec.id, recommendationReason: rec.reason };
}

/** Deterministic recommendation ladder. Returns the option id and a plain explanation of why. */
export function recommend(i: Pick<OptionsInput, 'kind' | 'severity' | 'policy' | 'guard'>, opts: RescueOption[]): { id: string; reason: string } {
  const feas = (k: RescueOptionKind) => opts.filter((o) => o.kind === k && o.feasible);
  const cheapest = (xs: RescueOption[]) => [...xs].sort((a, b) => a.impact.exposure - b.impact.exposure || (a.eta.maxDays ?? 0) - (b.eta.maxDays ?? 0) || a.id.localeCompare(b.id));
  const pickReorder = () => {
    const rs = feas('reorder_same_product_alt_supplier');
    // prefer options that do not need consent and do not need a duplicate acknowledgement, then best rank (list order = rank order)
    return rs.find((o) => !o.materialChange && !o.needsDuplicateAck) ?? rs.find((o) => !o.needsDuplicateAck) ?? rs[0];
  };
  if (i.kind === 'unusual_delivery_pattern') return { id: feas('escalate_human')[0]!.id, reason: 'The tracking pattern is unusual (e.g. delivered implausibly fast). A person should check it before anything is changed.' };
  const cont = feas('continue_shipment')[0];
  const mildKinds: RescueFailureKind[] = ['shipment_delay', 'carrier_exception', 'invalid_tracking'];
  if (cont && mildKinds.includes(i.kind) && (i.severity === 'low' || i.severity === 'medium')) {
    return { id: cont.id, reason: i.kind === 'invalid_tracking' ? 'The shipment exists but its tracking data is unreliable; keep monitoring before spending money.' : 'The parcel is still moving and the delay is small; keep waiting and re-check on the next scan.' };
  }
  const reorder = pickReorder();
  if (reorder && i.kind !== 'failed_delivery') {
    return { id: reorder.id, reason: `Same product is available from ${reorder.supplier?.name}; ${reorder.materialChange ? 'delivery would be later than promised, so the customer must agree.' : 'no material change for the customer.'}` };
  }
  const rep = cheapest(feas('offer_equivalent_replacement'))[0];
  if (rep && i.kind !== 'failed_delivery') return { id: rep.id, reason: 'The same product cannot be supplied elsewhere; a similar product is the closest option and needs the customer’s agreement.' };
  const partial = feas('offer_partial_refund')[0];
  if (partial && (i.severity === 'medium' || i.severity === 'high')) return { id: partial.id, reason: 'The parcel is still moving but badly late; offer a partial refund while it continues.' };
  if (cont && mildKinds.includes(i.kind)) return { id: cont.id, reason: 'No alternative supply is available; keep waiting and keep watching.' };
  if (i.kind === 'failed_delivery' || (i.kind === 'suspected_lost' && !reorder)) {
    const full = feas('offer_full_refund')[0];
    if (full && i.kind === 'suspected_lost') return { id: full.id, reason: 'The parcel appears lost and cannot be re-sent safely; a full refund is the fair outcome.' };
    return { id: feas('escalate_human')[0]!.id, reason: i.kind === 'failed_delivery' ? 'Delivery failed; the address or recipient needs a human check before anything is re-sent.' : 'No safe automatic path.' };
  }
  const full = feas('offer_full_refund')[0];
  if (full) return { id: full.id, reason: 'No supplier can fulfil this order; a full refund is the fair outcome.' };
  return { id: feas('escalate_human')[0]!.id, reason: 'No safe automatic path.' };
}
