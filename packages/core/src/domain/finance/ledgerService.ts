/**
 * Persisting ledger service: posts balanced journals idempotently, syncs them from existing paid orders / shipments /
 * refunds / ad metrics (read-only against those collections), and answers ledger queries.
 */
import mongoose from 'mongoose';
import { AdMetric, FinanceLedgerEntry, FinanceState, Order, Refund, Shipment } from '@orvia/database';
import type { Currency, JournalDraft, LedgerAccount } from '@orvia/types';
import { LEDGER_ACCOUNTS } from '@orvia/types';
import { audit } from '../../infra/audit';
import type { Actor, Ctx } from '../../infra/context';
import { currentFx } from './fxService';
import { accountBalance, buildAdSpend, buildChargeback, buildOrderPaid, buildPaymentFee, buildPspSettlement, buildRefund, buildSupplierCost, buildSupplierSettlement, ikey, reverseJournal, totalsFromBalances } from './ledger';

const DAY = 86_400_000;
const oid = (id: string) => new mongoose.Types.ObjectId(id);

const toRefs = (r: JournalDraft['refs']) => {
  const o: Record<string, unknown> = {};
  for (const k of ['orderId', 'paymentId', 'refundId', 'shipmentId', 'supplierId', 'campaignId', 'metricId'] as const) if (r[k] && mongoose.isValidObjectId(r[k])) o[k] = oid(r[k] as string);
  if (r.supplierOrderId) o['supplierOrderId'] = r.supplierOrderId;
  if (r.settlementId) o['settlementId'] = r.settlementId;
  return o;
};

/** Insert one journal. A repeated idempotency key is a no-op (`posted: false`). */
export async function postJournal(ctx: Ctx, d: JournalDraft, o: { backfill?: boolean; by?: string } = {}): Promise<{ posted: boolean }> {
  const snap = await currentFx(ctx);
  const perUsd = d.currency === 'USD' ? 1 : snap.rates[d.currency];
  try {
    await FinanceLedgerEntry.create({
      idempotencyKey: d.idempotencyKey, kind: d.kind, currency: d.currency, postedAt: d.postedAt, memo: d.memo, lines: d.lines, reverses: d.reverses,
      refs: toRefs(d.refs),
      fx: { perUsd, source: snap.source, asOf: snap.fetchedAt, basis: o.backfill ? 'backfill_current_rate' : 'posting_time' },
      createdBy: o.by ?? 'system',
    });
    return { posted: true };
  } catch (e) {
    if ((e as { code?: number }).code === 11000) return { posted: false };
    throw e;
  }
}

/* ------------------------------- sync from source data ------------------------------- */

interface Watermarks { orders: string; shipments: string; refunds: string; ads: string }
const EPOCH = new Date(0).toISOString();
async function getMarks(): Promise<Watermarks> {
  const d = await FinanceState.findOne({ key: 'ledger_sync' }).lean();
  return { orders: EPOCH, shipments: EPOCH, refunds: EPOCH, ads: EPOCH, ...((d?.value as Partial<Watermarks>) ?? {}) };
}
const setMarks = (m: Watermarks) => FinanceState.updateOne({ key: 'ledger_sync' }, { $set: { value: m } }, { upsert: true });

const PAID = ['succeeded', 'partially_refunded', 'refunded'];
const COST_STATES = ['CREATED', 'SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'RETURNED'];

export interface SyncResult { orders: number; shipments: number; refunds: number; ads: number; reversals: number; skipped: number; more: boolean }

type OrderLean = { _id: mongoose.Types.ObjectId; orderNumber: string; currency: string; amounts?: { total?: number; tax?: number; discount?: number; shipping?: number }; payment?: { paidAt?: Date; fee?: number }; costs?: { paymentFee?: number }; isDemo?: boolean };

async function existingKeys(keys: string[]): Promise<Set<string>> {
  if (!keys.length) return new Set();
  return new Set((await FinanceLedgerEntry.find({ idempotencyKey: { $in: keys } }).select('idempotencyKey').lean()).map((e) => e.idempotencyKey));
}

/**
 * One bounded pass. Safe to run repeatedly and concurrently: every posting has a unique idempotency key.
 * Four independent sweeps (orders by createdAt, shipments/refunds by updatedAt, ad metrics by date) plus a sweep of
 * the last 3 days of orders to catch ones paid after creation. Never writes to Orders/Payments/Refunds/Shipments.
 */
export async function syncLedger(ctx: Ctx, o: { limit?: number; reset?: boolean } = {}): Promise<SyncResult> {
  const limit = Math.min(1000, o.limit ?? 300);
  const marks: Watermarks = o.reset ? { orders: EPOCH, shipments: EPOCH, refunds: EPOCH, ads: EPOCH } : await getMarks();
  const res: SyncResult = { orders: 0, shipments: 0, refunds: 0, ads: 0, reversals: 0, skipped: 0, more: false };
  const backfill = !!o.reset || marks.orders === EPOCH;
  const now = ctx.now();

  // 1. paid orders → order_paid + payment_fee
  const fwd = await Order.find({ createdAt: { $gt: new Date(marks.orders) }, 'payment.status': { $in: PAID }, isDemo: { $ne: true } }).sort({ createdAt: 1 }).limit(limit).select('orderNumber currency amounts payment costs.paymentFee createdAt isDemo').lean();
  const recent = await Order.find({ createdAt: { $gte: new Date(now.getTime() - 3 * DAY) }, 'payment.status': { $in: PAID }, isDemo: { $ne: true } }).sort({ createdAt: -1 }).limit(limit).select('orderNumber currency amounts payment costs.paymentFee createdAt isDemo').lean();
  const seen = new Set<string>();
  const orders = [...fwd, ...recent].filter((x) => (seen.has(String(x._id)) ? false : (seen.add(String(x._id)), true))) as unknown as (OrderLean & { createdAt: Date })[];
  const known = await existingKeys(orders.flatMap((x) => [ikey.orderPaid(String(x._id)), ikey.paymentFee(String(x._id))]));
  for (const x of orders) {
    const id = String(x._id);
    const postedAt = x.payment?.paidAt ?? x.createdAt;
    const cur = x.currency as Currency;
    if (!known.has(ikey.orderPaid(id)) && x.amounts?.total) {
      const r = await postJournal(ctx, buildOrderPaid({ orderId: id, orderNumber: x.orderNumber, currency: cur, postedAt, total: x.amounts.total, tax: x.amounts.tax ?? 0, discount: x.amounts.discount ?? 0, shipping: x.amounts.shipping ?? 0 }), { backfill });
      if (r.posted) res.orders++;
    }
    const fee = x.payment?.fee ?? x.costs?.paymentFee ?? 0;
    if (fee > 0 && !known.has(ikey.paymentFee(id))) {
      const r = await postJournal(ctx, buildPaymentFee({ orderId: id, orderNumber: x.orderNumber, currency: cur, postedAt, fee }), { backfill });
      if (r.posted) res.orders++;
    }
  }
  if (fwd.length) marks.orders = new Date(Math.max(...fwd.map((x) => new Date((x as unknown as { createdAt: Date }).createdAt).getTime()))).toISOString();
  if (fwd.length >= limit) res.more = true;

  // 2. supplier orders → supplier_cost (and reversal when cancelled/failed after posting)
  const ships = await Shipment.find({ updatedAt: { $gt: new Date(marks.shipments) } }).sort({ updatedAt: 1 }).limit(limit).select('orderId supplierId supplierOrderId status cost updatedAt').lean();
  const shipOrders = new Map((await Order.find({ _id: { $in: ships.map((s) => s.orderId) } }).select('orderNumber currency isDemo').lean()).map((x) => [String(x._id), x]));
  const costKeys = await existingKeys(ships.flatMap((s) => [ikey.supplierCost(String(s._id)), ikey.supplierCostReversal(String(s._id))]));
  for (const s of ships) {
    const ord = shipOrders.get(String(s.orderId));
    if (!ord || ord.isDemo) { res.skipped++; continue; }
    const sid = String(s._id);
    const cost = (s.cost ?? {}) as { productCost?: number; shippingCost?: number; duties?: number; currency?: string };
    const total = (cost.productCost ?? 0) + (cost.shippingCost ?? 0) + (cost.duties ?? 0);
    const cur = (cost.currency ?? ord.currency) as Currency;
    const draft = total > 0 ? buildSupplierCost({ orderId: String(s.orderId), shipmentId: sid, supplierId: String(s.supplierId), supplierOrderId: s.supplierOrderId ?? undefined, currency: cur, postedAt: s.updatedAt, productCost: cost.productCost ?? 0, shippingCost: cost.shippingCost ?? 0, duties: cost.duties ?? 0 }) : null;
    if (draft && COST_STATES.includes(s.status) && !costKeys.has(draft.idempotencyKey)) {
      const r = await postJournal(ctx, draft, { backfill });
      if (r.posted) res.shipments++;
    } else if (draft && ['CANCELLED', 'FAILED'].includes(s.status) && costKeys.has(draft.idempotencyKey) && !costKeys.has(ikey.supplierCostReversal(sid))) {
      const orig = await FinanceLedgerEntry.findOne({ idempotencyKey: draft.idempotencyKey }).lean();
      if (orig) {
        const r = await postJournal(ctx, reverseJournal({ kind: 'supplier_cost', idempotencyKey: orig.idempotencyKey, currency: orig.currency as Currency, lines: orig.lines as never, refs: draft.refs }, ctx.now(), 'supplier_cost_reversal', ikey.supplierCostReversal(sid)), { backfill });
        if (r.posted) res.reversals++;
      }
    }
  }
  if (ships.length) marks.shipments = new Date(ships[ships.length - 1]!.updatedAt).toISOString();
  if (ships.length >= limit) res.more = true;

  // 3. succeeded refunds
  const refs = await Refund.find({ status: 'succeeded', updatedAt: { $gt: new Date(marks.refunds) } }).sort({ updatedAt: 1 }).limit(limit).select('orderId paymentId amount currency updatedAt').lean();
  const refOrders = new Map((await Order.find({ _id: { $in: refs.map((r) => r.orderId) } }).select('currency amounts isDemo').lean()).map((x) => [String(x._id), x]));
  const refKeys = await existingKeys(refs.map((r) => ikey.refund(String(r._id))));
  for (const r of refs) {
    const ord = refOrders.get(String(r.orderId));
    if (!ord || ord.isDemo || !r.amount) { res.skipped++; continue; }
    if (refKeys.has(ikey.refund(String(r._id)))) continue;
    const p = await postJournal(ctx, buildRefund({ orderId: String(r.orderId), refundId: String(r._id), paymentId: r.paymentId ? String(r.paymentId) : undefined, currency: (r.currency ?? ord.currency) as Currency, postedAt: r.updatedAt, amount: r.amount, orderTotal: ord.amounts?.total ?? 0, orderTax: ord.amounts?.tax ?? 0 }), { backfill });
    if (p.posted) res.refunds++;
  }
  if (refs.length) marks.refunds = new Date(refs[refs.length - 1]!.updatedAt).toISOString();
  if (refs.length >= limit) res.more = true;

  // 4. ad spend: only days at least 2 days old (platforms restate recent days), USD minor units
  const cutoff = new Date(now.getTime() - 2 * DAY);
  const ads = await AdMetric.find({ isDemo: { $ne: true }, spend: { $gt: 0 }, date: { $gt: new Date(marks.ads), $lte: cutoff } }).sort({ date: 1 }).limit(limit).select('campaignId platform date spend').lean();
  const adKeys = await existingKeys(ads.map((a) => ikey.adSpend(String(a._id))));
  for (const a of ads) {
    if (adKeys.has(ikey.adSpend(String(a._id)))) continue;
    const p = await postJournal(ctx, buildAdSpend({ metricId: String(a._id), campaignId: String(a.campaignId), platform: a.platform ?? undefined, currency: 'USD', postedAt: a.date, amount: a.spend }), { backfill });
    if (p.posted) res.ads++;
  }
  if (ads.length) marks.ads = new Date(ads[ads.length - 1]!.date).toISOString();
  if (ads.length >= limit) res.more = true;

  await setMarks(marks);
  return res;
}

/** Idempotent rebuild from existing data: resets the watermarks and loops until caught up (bounded). */
export async function backfillLedger(ctx: Ctx, o: { maxBatches?: number; limit?: number; actor?: Actor } = {}): Promise<SyncResult & { batches: number }> {
  const total: SyncResult & { batches: number } = { orders: 0, shipments: 0, refunds: 0, ads: 0, reversals: 0, skipped: 0, more: false, batches: 0 };
  for (let i = 0; i < (o.maxBatches ?? 50); i++) {
    const r = await syncLedger(ctx, { limit: o.limit, reset: i === 0 });
    total.batches++;
    for (const k of ['orders', 'shipments', 'refunds', 'ads', 'reversals', 'skipped'] as const) total[k] += r[k];
    total.more = r.more;
    if (!r.more) break;
  }
  if (o.actor) await audit(ctx, o.actor, { action: 'finance.ledger.backfill', resource: 'finance_ledger', newValue: total, reason: 'ledger backfill from existing orders' });
  return total;
}

/* ------------------------------- manual postings ------------------------------- */

export type ManualPosting =
  | { type: 'chargeback'; id: string; orderId?: string; currency: Currency; amount: number; fee: number; postedAt?: Date }
  | { type: 'psp_settlement'; id: string; currency: Currency; amount: number; postedAt?: Date }
  | { type: 'supplier_settlement'; id: string; supplierId: string; currency: Currency; amount: number; postedAt?: Date }
  | { type: 'ad_spend'; id: string; currency: Currency; amount: number; platform?: string; postedAt?: Date };

/** Money events that have no source collection yet are entered by a person; audited, idempotent on `id`. */
export async function postManual(ctx: Ctx, p: ManualPosting, actor: Actor): Promise<{ posted: boolean; idempotencyKey: string }> {
  const at = p.postedAt ?? ctx.now();
  const base = { currency: p.currency, postedAt: at };
  const draft =
    p.type === 'chargeback' ? buildChargeback({ ...base, chargebackId: p.id, orderId: p.orderId, amount: p.amount, fee: p.fee })
    : p.type === 'psp_settlement' ? buildPspSettlement({ ...base, settlementId: p.id, amount: p.amount })
    : p.type === 'supplier_settlement' ? buildSupplierSettlement({ ...base, settlementId: p.id, supplierId: p.supplierId, amount: p.amount })
    : buildAdSpend({ ...base, metricId: `manual-${p.id}`, platform: p.platform, amount: p.amount });
  const r = await postJournal(ctx, draft, { by: actor.id });
  if (r.posted) await audit(ctx, actor, { action: `finance.ledger.${p.type}`, resource: 'finance_ledger', resourceId: draft.idempotencyKey, newValue: { currency: p.currency, amount: p.amount }, reason: 'manual ledger posting' });
  return { posted: r.posted, idempotencyKey: draft.idempotencyKey };
}

/* ---------------------------------- queries ---------------------------------- */

export interface LedgerFilter { account?: LedgerAccount; kind?: string; orderId?: string; from?: Date; to?: Date; currency?: string }
const filterToMatch = (f: LedgerFilter): Record<string, unknown> => ({
  ...(f.kind ? { kind: f.kind } : {}),
  ...(f.account ? { 'lines.account': f.account } : {}),
  ...(f.orderId && mongoose.isValidObjectId(f.orderId) ? { 'refs.orderId': oid(f.orderId) } : {}),
  ...(f.currency ? { currency: f.currency } : {}),
  ...(f.from || f.to ? { postedAt: { ...(f.from ? { $gte: f.from } : {}), ...(f.to ? { $lte: f.to } : {}) } } : {}),
});

export async function ledgerPage(f: LedgerFilter, page: number, pageSize: number) {
  const match = filterToMatch(f);
  const [items, total] = await Promise.all([
    FinanceLedgerEntry.find(match).sort({ postedAt: -1, _id: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
    FinanceLedgerEntry.countDocuments(match),
  ]);
  return { items, total, page, pageSize };
}

/** Account balances per currency (normal direction), optionally for a period. */
export async function ledgerBalances(f: Pick<LedgerFilter, 'from' | 'to'> = {}): Promise<Record<string, Partial<Record<LedgerAccount, number>>>> {
  const rows = await FinanceLedgerEntry.aggregate<{ _id: { currency: string; account: LedgerAccount; side: 'debit' | 'credit' }; amount: number }>([
    { $match: filterToMatch(f) },
    { $unwind: '$lines' },
    { $group: { _id: { currency: '$currency', account: '$lines.account', side: '$lines.side' }, amount: { $sum: '$lines.amount' } } },
  ]);
  const out: Record<string, Partial<Record<LedgerAccount, number>>> = {};
  for (const cur of new Set(rows.map((r) => r._id.currency))) {
    const lines = rows.filter((r) => r._id.currency === cur).map((r) => ({ account: r._id.account, side: r._id.side, amount: r.amount }));
    out[cur] = Object.fromEntries(LEDGER_ACCOUNTS.map((a) => [a, accountBalance(a, lines)]).filter(([, v]) => v !== 0)) as Partial<Record<LedgerAccount, number>>;
  }
  return out;
}

export { totalsFromBalances };

const csv = (v: unknown): string => {
  const s = String(v ?? '');
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** CSV of ledger lines (one row per line), capped at `limit` entries. Amounts in major units. */
export async function ledgerCsv(f: LedgerFilter, limit = 5000): Promise<string> {
  const entries = await FinanceLedgerEntry.find(filterToMatch(f)).sort({ postedAt: -1, _id: -1 }).limit(Math.min(limit, 20_000)).lean();
  const rows = ['posted_at,idempotency_key,kind,currency,account,side,amount,order_id,memo'];
  for (const e of entries) for (const l of e.lines) rows.push([new Date(e.postedAt).toISOString(), e.idempotencyKey, e.kind, e.currency, l.account, l.side, (l.amount / 100).toFixed(2), e.refs?.orderId ? String(e.refs.orderId) : '', e.memo].map(csv).join(','));
  return rows.join('\n') + '\n';
}
