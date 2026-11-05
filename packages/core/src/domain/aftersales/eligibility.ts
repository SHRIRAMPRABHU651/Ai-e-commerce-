/**
 * Return eligibility engine. Pure and deterministic: given facts it decides what may be *requested* and why not.
 * It never authorizes anything (staff authorize an RMA) and never promises a return the supplier policy cannot support.
 */
import { RETURN_REASONS } from '@orvia/types';
import type { ItemCondition, ResolutionType, ReturnFault, ReturnReasonCode } from '@orvia/types';
import { UNKNOWN_SUPPLIER_POLICY } from './policy';
import type { SupplierReturnPolicy } from './policy';

export interface Ineligibility { code: string; message: string }

export interface EligibilityLine {
  sku: string;
  title: string;
  quantity: number;
  category?: string;
  alreadyReturned: number;
  supplier: SupplierReturnPolicy | null;
  /** Customer-declared condition (optional when only previewing). */
  condition?: ItemCondition;
}

export interface EligibilityInput {
  now: Date;
  deliveredAt: Date | null;
  paymentOk: boolean;
  countryWindowDays: number;
  reason?: ReturnReasonCode;
  lines: EligibilityLine[];
  excludedCategories: string[];
  /** Another return on this order is still open (the legacy flow allows one at a time). */
  openReturn: boolean;
}

export type ReturnMethod = 'ship_back' | 'staff_decides' | 'none_needed';

export interface LineEligibility {
  sku: string;
  title: string;
  eligible: boolean;
  maxQuantity: number;
  reasons: Ineligibility[];
  resolutionsAllowed: ResolutionType[];
  returnMethod: ReturnMethod;
  /** Staff must confirm with the supplier/carrier before this can be authorized. */
  needsStaffReview: boolean;
  notes: string[];
}

export interface EligibilityResult {
  eligible: boolean;
  orderReasons: Ineligibility[];
  windowDays: number;
  windowEndsAt: Date | null;
  daysLeft: number | null;
  lines: LineEligibility[];
}

const DAY = 86_400_000;
const faultOf = (r: ReturnReasonCode | undefined): ReturnFault => (r ? RETURN_REASONS[r].fault : 'customer');
const CUSTOMER_OK_CONDITIONS: ItemCondition[] = ['unopened', 'opened_unused'];

export function evaluateEligibility(i: EligibilityInput): EligibilityResult {
  const fault = faultOf(i.reason);
  const sellerFault = fault === 'merchant' || fault === 'carrier';
  const orderReasons: Ineligibility[] = [];
  if (!i.paymentOk) orderReasons.push({ code: 'NOT_PAID', message: 'This order has no completed payment to return against.' });
  if (i.openReturn) orderReasons.push({ code: 'RETURN_OPEN', message: 'A return is already in progress for this order. Wait for it to finish before starting another.' });
  const notDeliveredClaim = i.reason === 'not_delivered';
  if (!i.deliveredAt && !notDeliveredClaim) orderReasons.push({ code: 'NOT_DELIVERED', message: 'Returns can be started once the order has been delivered. If it has not arrived, choose "Never arrived".' });

  const lines = i.lines.map((l): LineEligibility => {
    const reasons: Ineligibility[] = [];
    const notes: string[] = [];
    const sup = l.supplier ?? UNKNOWN_SUPPLIER_POLICY;
    const maxQuantity = Math.max(0, l.quantity - l.alreadyReturned);
    if (maxQuantity === 0) reasons.push({ code: 'ALREADY_RETURNED', message: 'All units of this item have already been returned or refunded.' });

    // Window: seller-fault claims use the country window (we answer to the customer); preference returns can be narrower
    // when the supplier will not take goods back after a shorter period.
    let window = i.countryWindowDays;
    if (!sellerFault && sup.returnWindowDays !== undefined && sup.returnWindowDays < window) window = sup.returnWindowDays;
    if (i.deliveredAt && !notDeliveredClaim && i.now.getTime() - i.deliveredAt.getTime() > window * DAY) {
      reasons.push({ code: 'WINDOW_PASSED', message: window < i.countryWindowDays ? `This item's supplier accepts returns for ${window} days after delivery, and that period has passed.` : `The ${window}-day return window has passed.` });
    }

    if (!sellerFault && l.category && i.excludedCategories.includes(l.category.toLowerCase())) {
      reasons.push({ code: 'CATEGORY_EXCLUDED', message: 'This type of item cannot be returned unless it is faulty or not what you ordered.' });
    }
    if (!sellerFault && sup.supportsReturns === 'no') {
      reasons.push({ code: 'SUPPLIER_NO_RETURNS', message: 'This item ships from a partner who does not accept change-of-mind returns. If it is faulty or not as described, choose that reason instead.' });
    }
    if (!sellerFault && sup.defectOnly && sup.supportsReturns !== 'no') {
      reasons.push({ code: 'SUPPLIER_DEFECT_ONLY', message: 'This item can only be returned if it is faulty, damaged or not as described.' });
    }
    if (!sellerFault && l.condition && !CUSTOMER_OK_CONDITIONS.includes(l.condition)) {
      reasons.push({ code: 'CONDITION_NOT_RETURNABLE', message: 'Items that have been used or damaged by the customer cannot be returned for a change of mind.' });
    }

    const eligible = reasons.length === 0;
    let needsStaffReview = false;
    let returnMethod: ReturnMethod = 'staff_decides';
    if (notDeliveredClaim) { returnMethod = 'none_needed'; needsStaffReview = true; notes.push('We will check tracking with the carrier before deciding.'); }
    else if (sup.supportsReturns === 'yes') returnMethod = 'ship_back';
    else if (sup.supportsReturns === 'no') { returnMethod = 'staff_decides'; notes.push('The supplier does not take returns back; our team decides whether you need to send it back.'); needsStaffReview = true; }
    else { needsStaffReview = true; notes.push('We will confirm the return method with the supplier before authorizing.'); }

    const resolutionsAllowed: ResolutionType[] = [];
    if (eligible) {
      resolutionsAllowed.push('refund');
      if (sellerFault && sup.supportsReplacement) resolutionsAllowed.push('replacement');
      if (sup.supportsExchange) resolutionsAllowed.push('exchange');
    }
    return { sku: l.sku, title: l.title, eligible, maxQuantity, reasons, resolutionsAllowed, returnMethod, needsStaffReview, notes };
  });

  const windowEndsAt = i.deliveredAt ? new Date(i.deliveredAt.getTime() + i.countryWindowDays * DAY) : null;
  const daysLeft = windowEndsAt ? Math.max(0, Math.ceil((windowEndsAt.getTime() - i.now.getTime()) / DAY)) : null;
  return {
    eligible: orderReasons.length === 0 && lines.some((l) => l.eligible),
    orderReasons,
    windowDays: i.countryWindowDays,
    windowEndsAt,
    daysLeft,
    lines,
  };
}

/** Validates the customer's selection against an evaluated result (server-side re-check of the wizard). */
export function validateSelection(result: EligibilityResult, selection: { sku: string; quantity: number }[], resolution: ResolutionType): Ineligibility[] {
  const problems: Ineligibility[] = [...result.orderReasons];
  const seen = new Set<string>();
  for (const s of selection) {
    if (seen.has(s.sku)) { problems.push({ code: 'DUPLICATE_ITEM', message: `Item ${s.sku} is listed twice.` }); continue; }
    seen.add(s.sku);
    const line = result.lines.find((l) => l.sku === s.sku);
    if (!line) { problems.push({ code: 'BAD_ITEMS', message: `Item ${s.sku} is not part of this order.` }); continue; }
    if (!line.eligible) { problems.push(...line.reasons.map((r) => ({ code: r.code, message: `${line.title}: ${r.message}` }))); continue; }
    if (s.quantity > line.maxQuantity) problems.push({ code: 'QUANTITY_EXCEEDED', message: `${line.title}: you can return at most ${line.maxQuantity}.` });
    if (!line.resolutionsAllowed.includes(resolution)) problems.push({ code: 'RESOLUTION_UNAVAILABLE', message: `${line.title}: a ${resolution} is not available for this item.` });
  }
  return problems;
}
