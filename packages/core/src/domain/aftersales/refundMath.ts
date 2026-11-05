/**
 * Deterministic refund calculation. Pure integer arithmetic in minor units (cents/paise; USD, CAD and INR all have
 * exponent 2). Discount, tax and shipping are allocated by cumulative proportion so that returning every unit in
 * several steps refunds exactly the original total, with no rounding drift.
 *
 * An LLM never calls this to decide money: it is invoked by the staff-gated resolve action, and the result is then
 * passed to the guarded `refundOrder` (approval limits, idempotency) in orders.ts.
 */
import type { ReturnFault } from '@orvia/types';
import type { ShippingRefundRule } from './policy';

export const MINOR_UNIT_EXPONENT: Record<string, number> = { USD: 2, CAD: 2, INR: 2 };

export interface RefundMathLine {
  sku: string;
  unitPrice: number;
  /** Units ordered. */
  quantity: number;
  /** Units being returned in this request. */
  returnQty: number;
  /** Units already returned/refunded by earlier requests. */
  alreadyReturnedQty: number;
}

export interface RefundMathInput {
  currency: string;
  amounts: { subtotal: number; discount: number; shipping: number; tax: number; total: number; taxInclusive: boolean };
  lines: RefundMathLine[];
  /** Sum already refunded on the order (Refund ledger / costs.refunded). */
  alreadyRefunded: number;
  fault: ReturnFault;
  shippingRule: ShippingRefundRule;
  restockingFeeBps: number;
  returnShippingDeduction: number;
}

export interface RefundBreakdown {
  currency: string;
  goods: number;
  discountShare: number;
  goodsNet: number;
  shipping: number;
  tax: number;
  gross: number;
  restockingFee: number;
  returnShippingDeduction: number;
  /** Amount to refund, already capped by what is left to refund on the order. */
  refundable: number;
  remainingAfter: number;
  completesOrder: boolean;
  cappedByRemaining: boolean;
  roundingAdjustment: number;
}

const isInt = (n: number) => Number.isInteger(n);
/** round(a*b/c) in integers, c>0. */
const mulDiv = (a: number, b: number, c: number): number => (c <= 0 ? 0 : Math.round((a * b) / c));
const cum = (total: number, part: number, whole: number): number => (whole <= 0 ? 0 : part >= whole ? total : mulDiv(total, part, whole));

export function computeRefund(i: RefundMathInput): RefundBreakdown {
  if (!(i.currency in MINOR_UNIT_EXPONENT)) throw new Error(`Unsupported currency ${i.currency}`);
  const { subtotal, discount, shipping, tax, total } = i.amounts;
  for (const n of [subtotal, discount, shipping, tax, total, i.alreadyRefunded, i.restockingFeeBps, i.returnShippingDeduction]) if (!isInt(n) || n < 0) throw new Error('Money values must be non-negative integers in minor units');
  const sellerFault = i.fault === 'merchant' || i.fault === 'carrier';

  let goods = 0;
  let prevGoods = 0;
  let units = 0;
  let unitsAfter = 0;
  for (const l of i.lines) {
    if (!isInt(l.unitPrice) || l.unitPrice < 0 || l.returnQty < 0 || l.alreadyReturnedQty < 0 || l.returnQty + l.alreadyReturnedQty > l.quantity) throw new Error(`Invalid return quantity for ${l.sku}`);
    goods += l.unitPrice * l.returnQty;
    prevGoods += l.unitPrice * l.alreadyReturnedQty;
    units += l.quantity;
    unitsAfter += l.returnQty + l.alreadyReturnedQty;
  }
  const completesOrder = units > 0 && unitsAfter === units;
  const discountShare = cum(discount, prevGoods + goods, subtotal) - cum(discount, prevGoods, subtotal);
  const goodsNet = Math.max(0, goods - discountShare);

  let shippingRefund = 0;
  if (shipping > 0) {
    if (i.shippingRule === 'always' || (i.shippingRule === 'fault_only' && sellerFault)) shippingRefund = cum(shipping, prevGoods + goods, subtotal) - cum(shipping, prevGoods, subtotal);
    else if (i.shippingRule === 'full_return' && completesOrder) shippingRefund = shipping;
  }

  // Tax: shipping is taxed too (taxable = subtotal - discount + shipping). Inclusive prices already contain it.
  const taxableTotal = Math.max(0, subtotal - discount) + shipping;
  const taxableRefund = goodsNet + shippingRefund;
  const taxRefund = i.amounts.taxInclusive ? 0 : mulDiv(tax, taxableRefund, taxableTotal);

  const gross = goodsNet + shippingRefund + taxRefund;
  const restockingFee = sellerFault ? 0 : Math.floor((goodsNet * i.restockingFeeBps) / 10_000);
  const returnShippingDeduction = sellerFault ? 0 : Math.min(i.returnShippingDeduction, Math.max(0, gross - restockingFee));
  let net = Math.max(0, gross - restockingFee - returnShippingDeduction);

  const remaining = Math.max(0, total - i.alreadyRefunded);
  // Absorb rounding drift when this request finishes the order, grants every component and has no fees.
  let roundingAdjustment = 0;
  const grantsEverything = shippingRefund === shipping && restockingFee === 0 && returnShippingDeduction === 0 && i.alreadyRefunded + net <= total && Math.abs(remaining - net) <= 3;
  if (completesOrder && grantsEverything) {
    roundingAdjustment = remaining - net;
    net = remaining;
  }
  const refundable = Math.min(net, remaining);
  return {
    currency: i.currency,
    goods,
    discountShare,
    goodsNet,
    shipping: shippingRefund,
    tax: taxRefund,
    gross,
    restockingFee,
    returnShippingDeduction,
    refundable,
    remainingAfter: remaining - refundable,
    completesOrder,
    cappedByRemaining: net > remaining,
    roundingAdjustment,
  };
}

/** Exchange for a different-priced variant of the same product. Only equal-or-cheaper exchanges are supported. */
export function exchangeDifference(originalUnitPrice: number, replacementUnitPrice: number, quantity: number): { customerOwes: number; refundDue: number } {
  if (![originalUnitPrice, replacementUnitPrice, quantity].every(isInt) || quantity < 1) throw new Error('Invalid exchange values');
  const d = (replacementUnitPrice - originalUnitPrice) * quantity;
  return { customerOwes: Math.max(0, d), refundDue: Math.max(0, -d) };
}
