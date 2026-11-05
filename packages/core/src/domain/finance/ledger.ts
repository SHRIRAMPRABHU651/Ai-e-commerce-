/**
 * Pure double-entry journal builders. No IO.
 *
 * Conventions
 *  - Every journal is in ONE currency (the order's / supplier's / ad account's) and must balance: sum(debits) === sum(credits).
 *  - Amounts are positive integers in minor units; the side says which way they move.
 *  - Normal balances: assets & expenses & contra-revenue are debit-normal; revenue & liabilities are credit-normal.
 *  - Entries are append-only. A mistake is corrected with a reversal (`reverseJournal`), never an edit.
 *  - Idempotency keys are deterministic functions of the business object, so reposting is a no-op (unique index).
 */
import { ACCOUNT_KIND } from '@orvia/types';
import type { Currency, JournalDraft, JournalLine, JournalRefs, LedgerAccount } from '@orvia/types';

export class LedgerError extends Error {}

const isMoney = (n: number) => Number.isInteger(n) && n >= 0;

/** Net of debits minus credits for a set of lines. */
export const imbalance = (lines: JournalLine[]): number => lines.reduce((a, l) => a + (l.side === 'debit' ? l.amount : -l.amount), 0);

/** Drops zero lines, merges duplicates, validates integers and balance. Throws LedgerError when the journal cannot balance. */
export function finalizeJournal(d: JournalDraft): JournalDraft {
  const merged = new Map<string, JournalLine>();
  for (const l of d.lines) {
    if (!isMoney(l.amount)) throw new LedgerError(`${d.kind}: line amount must be a non-negative integer (${l.account}=${l.amount})`);
    if (l.amount === 0) continue;
    const k = `${l.account}|${l.side}`;
    const e = merged.get(k);
    if (e) e.amount += l.amount;
    else merged.set(k, { ...l });
  }
  const lines = [...merged.values()];
  if (lines.length < 2) throw new LedgerError(`${d.kind}: nothing to post`);
  const diff = imbalance(lines);
  if (diff !== 0) throw new LedgerError(`${d.kind} ${d.idempotencyKey}: unbalanced by ${diff}`);
  return { ...d, lines };
}

export const assertBalanced = (d: JournalDraft): void => {
  const diff = imbalance(d.lines);
  if (diff !== 0) throw new LedgerError(`${d.kind} ${d.idempotencyKey}: unbalanced by ${diff}`);
};

/* ----------------------------- idempotency keys ----------------------------- */

export const ikey = {
  orderPaid: (orderId: string) => `order_paid:${orderId}`,
  paymentFee: (orderId: string) => `payment_fee:${orderId}`,
  supplierCost: (shipmentId: string) => `supplier_cost:${shipmentId}`,
  supplierCostReversal: (shipmentId: string) => `supplier_cost_reversal:${shipmentId}`,
  refund: (refundId: string) => `refund:${refundId}`,
  chargeback: (id: string) => `chargeback:${id}`,
  pspSettlement: (settlementId: string) => `psp_settlement:${settlementId}`,
  supplierSettlement: (settlementId: string) => `supplier_settlement:${settlementId}`,
  adSpend: (metricId: string) => `ad_spend:${metricId}`,
  reserve: (kind: 'hold' | 'release', id: string) => `reserve_${kind}:${id}`,
  reversal: (key: string) => `rev:${key}`,
};

/* --------------------------------- builders --------------------------------- */

interface Common { currency: Currency; postedAt: Date }
const dr = (account: LedgerAccount, amount: number): JournalLine => ({ account, side: 'debit', amount });
const cr = (account: LedgerAccount, amount: number): JournalLine => ({ account, side: 'credit', amount });

export interface OrderPaidInput extends Common {
  orderId: string;
  orderNumber?: string;
  paymentId?: string;
  /** Amount the customer paid (includes tax). */
  total: number;
  /** Tax contained in `total` (inclusive markets) or added on top (exclusive): either way it is part of `total`. */
  tax: number;
  discount: number;
  shipping: number;
}

/**
 * Customer pays `total`.   Dr psp_receivable total, Dr discounts discount | Cr revenue_product, Cr revenue_shipping, Cr tax_payable.
 * Gross sales (ex-tax, pre-discount) = revenue_product + revenue_shipping; net sales = gross sales − discounts − refunds − chargebacks.
 */
export function buildOrderPaid(i: OrderPaidInput): JournalDraft {
  const gross = i.total - i.tax + i.discount; // revenue before discounts, ex-tax
  const shippingRev = Math.max(0, Math.min(i.shipping, gross));
  return finalizeJournal({
    kind: 'order_paid',
    idempotencyKey: ikey.orderPaid(i.orderId),
    currency: i.currency,
    postedAt: i.postedAt,
    memo: `Order ${i.orderNumber ?? i.orderId} paid`,
    refs: { orderId: i.orderId, paymentId: i.paymentId },
    lines: [dr('psp_receivable', i.total), dr('discounts', i.discount), cr('revenue_product', gross - shippingRev), cr('revenue_shipping', shippingRev), cr('tax_payable', i.tax)],
  });
}

export interface PaymentFeeInput extends Common { orderId: string; orderNumber?: string; fee: number; paymentId?: string }
/** PSP fee netted from what the PSP owes us. Dr payment_fees | Cr psp_receivable. */
export function buildPaymentFee(i: PaymentFeeInput): JournalDraft {
  return finalizeJournal({ kind: 'payment_fee', idempotencyKey: ikey.paymentFee(i.orderId), currency: i.currency, postedAt: i.postedAt, memo: `Payment fee, order ${i.orderNumber ?? i.orderId}`, refs: { orderId: i.orderId, paymentId: i.paymentId }, lines: [dr('payment_fees', i.fee), cr('psp_receivable', i.fee)] });
}

export interface SupplierCostInput extends Common {
  orderId: string;
  shipmentId: string;
  supplierId?: string;
  supplierOrderId?: string;
  productCost: number;
  shippingCost: number;
  duties: number;
}
/** We owe the supplier for goods + shipping + duties. Dr cogs_product, shipping_cost, duties_cost | Cr supplier_payable. */
export function buildSupplierCost(i: SupplierCostInput): JournalDraft {
  return finalizeJournal({
    kind: 'supplier_cost',
    idempotencyKey: ikey.supplierCost(i.shipmentId),
    currency: i.currency,
    postedAt: i.postedAt,
    memo: `Supplier order ${i.supplierOrderId ?? i.shipmentId}`,
    refs: { orderId: i.orderId, shipmentId: i.shipmentId, supplierId: i.supplierId, supplierOrderId: i.supplierOrderId },
    lines: [dr('cogs_product', i.productCost), dr('shipping_cost', i.shippingCost), dr('duties_cost', i.duties), cr('supplier_payable', i.productCost + i.shippingCost + i.duties)],
  });
}

export interface RefundInput extends Common {
  orderId: string;
  refundId: string;
  paymentId?: string;
  amount: number;
  /** Order totals, used to give back the proportional tax. */
  orderTotal: number;
  orderTax: number;
}
/** Money returned to the customer. Dr refunds (ex-tax part), Dr tax_payable (tax part) | Cr psp_receivable. */
export function buildRefund(i: RefundInput): JournalDraft {
  const taxPart = i.orderTotal > 0 ? Math.min(i.amount, Math.round((i.amount * i.orderTax) / i.orderTotal)) : 0;
  return finalizeJournal({
    kind: 'refund',
    idempotencyKey: ikey.refund(i.refundId),
    currency: i.currency,
    postedAt: i.postedAt,
    memo: `Refund for order ${i.orderId}`,
    refs: { orderId: i.orderId, refundId: i.refundId, paymentId: i.paymentId },
    lines: [dr('refunds', i.amount - taxPart), dr('tax_payable', taxPart), cr('psp_receivable', i.amount)],
  });
}

export interface ChargebackInput extends Common { chargebackId: string; orderId?: string; paymentId?: string; amount: number; fee: number }
/** Card dispute lost: the PSP claws back the amount plus a dispute fee. Dr chargebacks, Dr payment_fees | Cr psp_receivable. */
export function buildChargeback(i: ChargebackInput): JournalDraft {
  return finalizeJournal({
    kind: 'chargeback',
    idempotencyKey: ikey.chargeback(i.chargebackId),
    currency: i.currency,
    postedAt: i.postedAt,
    memo: `Chargeback ${i.chargebackId}`,
    refs: { orderId: i.orderId, paymentId: i.paymentId },
    lines: [dr('chargebacks', i.amount), dr('payment_fees', i.fee), cr('psp_receivable', i.amount + i.fee)],
  });
}

export interface PspSettlementInput extends Common { settlementId: string; amount: number }
/** PSP pays out to our bank (net of fees already netted in receivable). Dr cash | Cr psp_receivable. */
export function buildPspSettlement(i: PspSettlementInput): JournalDraft {
  return finalizeJournal({ kind: 'psp_settlement', idempotencyKey: ikey.pspSettlement(i.settlementId), currency: i.currency, postedAt: i.postedAt, memo: `PSP payout ${i.settlementId}`, refs: { settlementId: i.settlementId }, lines: [dr('cash', i.amount), cr('psp_receivable', i.amount)] });
}

export interface SupplierSettlementInput extends Common { settlementId: string; supplierId: string; amount: number }
/** We pay the supplier. Dr supplier_payable | Cr cash. */
export function buildSupplierSettlement(i: SupplierSettlementInput): JournalDraft {
  return finalizeJournal({ kind: 'supplier_settlement', idempotencyKey: ikey.supplierSettlement(i.settlementId), currency: i.currency, postedAt: i.postedAt, memo: `Supplier payment ${i.settlementId}`, refs: { settlementId: i.settlementId, supplierId: i.supplierId }, lines: [dr('supplier_payable', i.amount), cr('cash', i.amount)] });
}

export interface AdSpendInput extends Common { metricId: string; campaignId?: string; platform?: string; amount: number }
/** Advertising spend charged to our card/prepaid balance. Dr ad_spend | Cr cash. */
export function buildAdSpend(i: AdSpendInput): JournalDraft {
  return finalizeJournal({ kind: 'ad_spend', idempotencyKey: ikey.adSpend(i.metricId), currency: i.currency, postedAt: i.postedAt, memo: `Ad spend${i.platform ? ` (${i.platform})` : ''}`, refs: { metricId: i.metricId, campaignId: i.campaignId }, lines: [dr('ad_spend', i.amount), cr('cash', i.amount)] });
}

export interface ReserveInput extends Common { id: string; amount: number }
/** PSP rolling reserve held back from payouts. Dr psp_reserve | Cr psp_receivable. */
export const buildReserveHold = (i: ReserveInput): JournalDraft => finalizeJournal({ kind: 'reserve_hold', idempotencyKey: ikey.reserve('hold', i.id), currency: i.currency, postedAt: i.postedAt, memo: `PSP reserve held ${i.id}`, refs: {}, lines: [dr('psp_reserve', i.amount), cr('psp_receivable', i.amount)] });
/** Reserve released back to receivable. Dr psp_receivable | Cr psp_reserve. */
export const buildReserveRelease = (i: ReserveInput): JournalDraft => finalizeJournal({ kind: 'reserve_release', idempotencyKey: ikey.reserve('release', i.id), currency: i.currency, postedAt: i.postedAt, memo: `PSP reserve released ${i.id}`, refs: {}, lines: [dr('psp_receivable', i.amount), cr('psp_reserve', i.amount)] });

/** Swap every side. Used for cancelled supplier orders and corrections. */
export function reverseJournal(orig: { kind: JournalDraft['kind']; idempotencyKey: string; currency: Currency; lines: JournalLine[]; refs: JournalRefs }, postedAt: Date, kind: JournalDraft['kind'] = 'adjustment', key?: string): JournalDraft {
  return finalizeJournal({
    kind,
    idempotencyKey: key ?? ikey.reversal(orig.idempotencyKey),
    currency: orig.currency,
    postedAt,
    memo: `Reversal of ${orig.idempotencyKey}`,
    refs: orig.refs,
    reverses: orig.idempotencyKey,
    lines: orig.lines.map((l) => ({ ...l, side: l.side === 'debit' ? 'credit' : 'debit' })),
  });
}

/* ------------------------------ account balances ------------------------------ */

/** Balance in the account's normal direction (positive = normal). */
export function accountBalance(account: LedgerAccount, lines: { account: LedgerAccount; side: 'debit' | 'credit'; amount: number }[]): number {
  let d = 0;
  let c = 0;
  for (const l of lines) {
    if (l.account !== account) continue;
    if (l.side === 'debit') d += l.amount;
    else c += l.amount;
  }
  const debitNormal = ['asset', 'expense', 'contra_revenue'].includes(ACCOUNT_KIND[account]);
  return debitNormal ? d - c : c - d;
}

export interface LedgerTotals {
  /** Revenue before discounts, ex-tax (product + shipping charged). Not the same as order-total GMV, which includes tax. */
  grossSales: number;
  discounts: number;
  refunds: number;
  chargebacks: number;
  netSales: number;
  taxCollected: number;
  cogs: number;
  shippingCost: number;
  duties: number;
  paymentFees: number;
  adSpend: number;
  grossProfit: number;
  /** Net sales − product cost − shipping − duties − payment fees: before advertising and operating costs. */
  contributionBeforeAds: number;
  contributionAfterAds: number;
}

/** Derive reporting totals from account balances (one currency). */
export function totalsFromBalances(b: Partial<Record<LedgerAccount, number>>): LedgerTotals {
  const g = (a: LedgerAccount) => b[a] ?? 0;
  const discounts = g('discounts');
  const grossSales = g('revenue_product') + g('revenue_shipping');
  const netSales = grossSales - discounts - g('refunds') - g('chargebacks');
  const grossProfit = netSales - g('cogs_product');
  const contributionBeforeAds = netSales - g('cogs_product') - g('shipping_cost') - g('duties_cost') - g('payment_fees');
  return {
    grossSales, discounts, refunds: g('refunds'), chargebacks: g('chargebacks'), netSales, taxCollected: g('tax_payable'),
    cogs: g('cogs_product'), shippingCost: g('shipping_cost'), duties: g('duties_cost'), paymentFees: g('payment_fees'), adSpend: g('ad_spend'),
    grossProfit, contributionBeforeAds, contributionAfterAds: contributionBeforeAds - g('ad_spend'),
  };
}
