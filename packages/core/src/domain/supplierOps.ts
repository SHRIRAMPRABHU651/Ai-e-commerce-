import { Order, Product, Shipment, Supplier, SupplierOffer, SupplierProduct } from '@orvia/database';
import { MANDATORY_FOR_AUTOMATION, SUPPLIER_TEST_KINDS, capabilitiesForSupplier } from '@orvia/suppliers';
import type { FulfillmentMode, SupplierTestKind } from '@orvia/suppliers';
import type { CountryCode } from '@orvia/types';
import { audit } from '../infra/audit';
import { DomainError, notFound } from '../infra/context';
import type { Actor, Ctx } from '../infra/context';
import { raiseException, resolveExceptionsFor } from './exceptions';
import { providerFor } from './supplierAccess';
import { manualOfferTtl } from './manualSupplier';
import { recomputeOrderStatus } from './orderStatus';
import { syncProductOffers } from './offers';

type SupplierLike = { provider: string; fulfillmentMode?: string | null };

export const fulfillmentModeOf = (s: SupplierLike): FulfillmentMode =>
  s.provider === 'manual' ? 'MANUAL' : ((s.fulfillmentMode as FulfillmentMode | undefined) ?? (s.provider === 'mock' ? 'AUTOMATED' : 'ASSISTED'));

export interface TestResult {
  kind: SupplierTestKind;
  status: 'pass' | 'fail' | 'unsupported' | 'skipped';
  message: string;
  at: string;
  evidence?: Record<string, unknown>;
}

const VALID_DAYS = 30;

export function automationReadiness(s: { provider: string; validation?: unknown }): { ok: boolean; missing: string[]; checked: Record<string, string> } {
  const v = (s.validation ?? {}) as Record<string, TestResult | undefined>;
  const missing: string[] = [];
  const checked: Record<string, string> = {};
  for (const k of MANDATORY_FOR_AUTOMATION) {
    const r = v[k];
    const fresh = r && Date.now() - new Date(r.at).getTime() < VALID_DAYS * 86_400_000;
    checked[k] = r ? (fresh ? r.status : 'expired') : 'not run';
    if (!r || r.status !== 'pass' || !fresh) missing.push(k);
  }
  return { ok: missing.length === 0, missing, checked };
}

/** Switching to AUTOMATED requires every mandatory check to have passed recently; mock suppliers are dev-only. */
export async function setFulfillmentMode(ctx: Ctx, supplierId: string, mode: FulfillmentMode, actor: Actor): Promise<void> {
  const s = await Supplier.findById(supplierId);
  if (!s) throw notFound('Supplier');
  if (s.provider === 'manual' && mode !== 'MANUAL') throw new DomainError('A manual supplier can only use MANUAL fulfilment (it has no ordering API)', 'VALIDATION', 422);
  if (mode === 'AUTOMATED' && s.provider !== 'mock') {
    const caps = capabilitiesForSupplier(s);
    if (caps && (caps.capabilities.createOrder !== 'supported' || caps.capabilities.tracking !== 'supported')) throw new DomainError('This supplier’s API mapping does not support order creation and tracking, so it cannot be AUTOMATED', 'VALIDATION', 409);
    const r = automationReadiness(s);
    if (!r.ok) throw new DomainError(`Cannot enable AUTOMATED fulfilment until these checks pass: ${r.missing.join(', ')}`, 'VALIDATION', 409, { missing: r.missing });
  }
  const prev = fulfillmentModeOf(s);
  s.fulfillmentMode = mode;
  await s.save();
  await audit(ctx, actor, { action: 'supplier.fulfillment_mode_changed', resource: 'supplier', resourceId: supplierId, previousValue: prev, newValue: mode });
}

/** Run one validation check against a supplier's real API and store the outcome. */
export async function runSupplierTest(ctx: Ctx, supplierId: string, kind: SupplierTestKind, params: Record<string, unknown>, actor: Actor): Promise<TestResult> {
  if (!SUPPLIER_TEST_KINDS.includes(kind)) throw new DomainError('Unknown test', 'VALIDATION', 422);
  const s = await Supplier.findById(supplierId);
  if (!s) throw notFound('Supplier');
  const at = new Date().toISOString();
  const done = async (r: Omit<TestResult, 'kind' | 'at'>): Promise<TestResult> => {
    const result: TestResult = { kind, at, ...r };
    await Supplier.updateOne({ _id: s._id }, { $set: { [`validation.${kind}`]: result } });
    await audit(ctx, actor, { action: 'supplier.validation_run', resource: 'supplier', resourceId: supplierId, newValue: { kind, status: result.status, message: result.message }, provider: s.code });
    return result;
  };
  const caps = capabilitiesForSupplier(s);
  const need: Partial<Record<SupplierTestKind, keyof NonNullable<typeof caps>['capabilities']>> = { catalog: 'catalog', product: 'productDetails', inventory: 'inventory', price: 'pricing', shipping: 'shippingQuotes', order: 'createOrder', tracking: 'tracking', cancel: 'cancelOrder' };
  const cap = need[kind];
  if (cap && caps && caps.capabilities[cap] === 'unsupported') return done({ status: 'unsupported', message: `Not supported by this supplier (${cap})` });
  let provider;
  try {
    provider = await providerFor(ctx, s);
  } catch (e) {
    return done({ status: 'fail', message: (e as Error).message });
  }
  const country = (params['country'] as CountryCode | undefined) ?? ((s.servesCountries?.[0] as CountryCode | undefined) ?? 'US');
  try {
    if (kind === 'connection' || kind === 'health') {
      const h = await provider.healthCheck();
      return done({ status: h.ok ? 'pass' : 'fail', message: h.message });
    }
    const ext = async (): Promise<string> => {
      if (typeof params['externalId'] === 'string' && params['externalId']) return params['externalId'];
      const first = (await provider.searchProducts({ limit: 1 })).items[0];
      if (!first) throw new Error('The catalogue returned no products to test with — pass an externalId');
      return first.externalId;
    };
    if (kind === 'catalog') {
      const r = await provider.searchProducts({ limit: 5 });
      if (!r.items.length) return done({ status: 'fail', message: 'Catalogue search returned no products' });
      const bad = r.items.filter((i) => !i.externalId || !i.title);
      const withImages = r.items.filter((i) => i.images.length).length;
      return done({ status: bad.length ? 'fail' : 'pass', message: `${r.items.length} product(s); ${withImages} with photos${bad.length ? `; ${bad.length} missing id/title` : ''}`, evidence: { sample: r.items.slice(0, 3).map((i) => ({ id: i.externalId, title: i.title, images: i.images.length })) } });
    }
    if (kind === 'product') {
      const p = await provider.getProduct(await ext());
      if (!p) return done({ status: 'fail', message: 'Product not found' });
      return done({ status: p.title ? 'pass' : 'fail', message: `"${p.title}" — ${p.images.length} photo(s), ${p.variants.length} variant(s)`, evidence: { images: p.images.length, variants: p.variants.length } });
    }
    if (kind === 'inventory') {
      const i = await provider.getInventory(await ext(), params['sku'] as string | undefined);
      return done({ status: 'pass', message: `stock ${i.total} across ${i.byWarehouse.length} warehouse(s)`, evidence: { total: i.total } });
    }
    if (kind === 'price') {
      const q = await provider.getPrice(await ext(), country, params['sku'] as string | undefined);
      return done({ status: q.productCost >= 0 && q.currency ? 'pass' : 'fail', message: `cost ${(q.productCost / 100).toFixed(2)} ${q.currency} → ${country}, ships from ${q.warehouseCountry}`, evidence: { currency: q.currency } });
    }
    if (kind === 'shipping') {
      const q = await provider.getShippingQuote(await ext(), country, 1);
      return done({ status: q.available ? 'pass' : 'fail', message: q.available ? `${(q.shippingCost / 100).toFixed(2)} ${q.currency}, ${q.minDays}-${q.maxDays} days to ${country}` : `no shipping to ${country}` });
    }
    if (kind === 'order') {
      // Never place a real order without an explicit operator decision.
      if (params['confirm'] !== 'PLACE TEST ORDER') return done({ status: 'skipped', message: 'Type PLACE TEST ORDER to confirm. This places a REAL order with the supplier unless the supplier is in sandbox mode.' });
      if (!s.sandbox && params['acknowledgeLive'] !== true) return done({ status: 'skipped', message: 'This supplier has no sandbox: acknowledge that a real order (and its cost) will be created.' });
      const addr = params['address'] as { fullName: string; line1: string; city: string; region: string; postalCode: string; country: string; phone?: string } | undefined;
      if (!addr?.line1) return done({ status: 'skipped', message: 'A delivery address is required for the test order.' });
      const o = await provider.createOrder({ idempotencyKey: `validation:${s.code}:${Date.now()}`, orderRef: `TEST-${Date.now().toString(36).toUpperCase()}`, externalId: await ext(), sku: String(params['sku'] ?? ''), quantity: 1, destination: addr as never });
      return done({ status: 'pass', message: `order created: ${o.supplierOrderId}`, evidence: { supplierOrderId: o.supplierOrderId } });
    }
    const orderId = String(params['supplierOrderId'] ?? (s.validation as Record<string, TestResult> | undefined)?.['order']?.evidence?.['supplierOrderId'] ?? '');
    if (kind === 'tracking') {
      if (!orderId) return done({ status: 'skipped', message: 'Provide a supplierOrderId (or pass the order test first).' });
      const t = await provider.getTracking(orderId);
      return done({ status: 'pass', message: t.available ? `tracking ${t.trackingNumber} (${t.status})` : `order status ${t.status}; the supplier has not issued tracking yet (we never invent it)`, evidence: { available: t.available } });
    }
    if (kind === 'cancel') {
      if (params['confirm'] !== 'CANCEL TEST ORDER') return done({ status: 'skipped', message: 'Type CANCEL TEST ORDER to confirm.' });
      if (!orderId) return done({ status: 'skipped', message: 'Provide a supplierOrderId.' });
      const c = await provider.cancelOrder(orderId);
      return done({ status: c.cancelled ? 'pass' : 'fail', message: c.cancelled ? 'cancelled' : `not cancelled: ${c.reason ?? 'unknown'}` });
    }
    return done({ status: 'skipped', message: 'Nothing to run' });
  } catch (e) {
    return done({ status: 'fail', message: (e as Error).message.slice(0, 400) });
  }
}

/** Worker: probe every active supplier; repeated failures take it out of rotation for new orders. */
export async function runSupplierHealthChecks(ctx: Ctx): Promise<{ checked: number; failing: number }> {
  const sourcing = await ctx.settings.get('sourcing');
  manualOfferTtl.hours = sourcing.manualOfferTtlHours;
  const sups = await Supplier.find({}).limit(200);
  let checked = 0, failing = 0;
  for (const s of sups) {
    if (!s.active) { s.healthState = 'DISABLED'; await s.save(); continue; }
    const t0 = Date.now();
    let ok = false, message = '', configured = true;
    try {
      const p = await providerFor(ctx, s);
      const h = await Promise.race([p.healthCheck(), new Promise<{ ok: boolean; message: string }>((_r, rej) => setTimeout(() => rej(new Error('health check timed out')), 10_000))]);
      ok = h.ok; message = h.message;
    } catch (e) {
      message = (e as Error).message;
      configured = !/not configured|API key not set|invalid API mapping|No adapter|disabled/i.test(message);
    }
    checked++;
    const prev = s.healthState;
    s.lastHealthAt = new Date();
    s.avgResponseMs = Math.round((s.avgResponseMs ?? Date.now() - t0) * 0.7 + (Date.now() - t0) * 0.3);
    s.apiStatusMessage = message;
    if (ok) { s.consecutiveFailures = 0; s.healthState = 'HEALTHY'; s.apiStatus = 'ok'; }
    else if (!configured) { s.healthState = 'NOT_CONFIGURED'; s.apiStatus = 'unconfigured'; }
    else {
      s.consecutiveFailures = (s.consecutiveFailures ?? 0) + 1;
      s.healthState = s.consecutiveFailures >= sourcing.failingAfterChecks ? 'FAILING' : 'DEGRADED';
      s.apiStatus = 'down';
    }
    await s.save();
    if (s.healthState === 'FAILING') {
      failing++;
      if (prev !== 'FAILING') await raiseException(ctx, { kind: 'SUPPLIER_FAILURE', priority: 'high', issue: `Supplier ${s.name} is FAILING (${s.consecutiveFailures} failed checks): ${message}. New orders are routed to other suppliers.`, aiRecommendation: 'Check the supplier’s API status and credentials.', suggestedAction: 'Check supplier', dedupeKey: `health:${s._id}` });
    } else if (s.healthState === 'HEALTHY' && prev === 'FAILING') await resolveExceptionsFor(ctx, `health:${s._id}`);
  }
  return { checked, failing };
}

/** Operator enters (or re-confirms) an offer for a manual supplier. Offers expire after sourcing.manualOfferTtlHours. */
export async function setManualOffer(ctx: Ctx, input: {
  productId: string; supplierId: string; externalId?: string; countries: CountryCode[]; currency: 'USD' | 'CAD' | 'INR'; productCost: number; shippingCost: number; stock: number; minDays: number; maxDays: number; warehouseCountry: string; images?: string[];
}, actor: Actor): Promise<{ offers: number }> {
  const sup = await Supplier.findById(input.supplierId);
  const product = await Product.findById(input.productId).select('title description').lean();
  if (!sup || !product) throw notFound('Supplier or product');
  if (sup.provider !== 'manual') throw new DomainError('Manual offers can only be entered for a manual supplier', 'VALIDATION', 422);
  const externalId = input.externalId ?? `manual-${input.productId}`;
  const sp = await SupplierProduct.findOneAndUpdate({ supplierId: sup._id, externalId }, { $set: { productId: input.productId, title: product.title, description: product.description, ...(input.images ? { images: input.images } : {}), lastSyncAt: new Date(), importStatus: 'imported' } }, { upsert: true, new: true });
  const now = new Date();
  for (const c of input.countries) {
    await SupplierOffer.updateOne({ productId: input.productId, supplierId: sup._id, destination: c }, { $set: { supplierProductId: sp._id, externalId, warehouseCountry: input.warehouseCountry, currency: input.currency, productCost: input.productCost, shippingCost: input.shippingCost, fulfillmentFee: 0, minDays: input.minDays, maxDays: input.maxDays, stock: input.stock, available: input.stock > 0, source: 'manual', confirmedAt: now, syncedAt: now } }, { upsert: true });
  }
  await audit(ctx, actor, { action: 'supplier.manual_offer_set', resource: 'product', resourceId: input.productId, newValue: { supplier: sup.code, countries: input.countries, productCost: input.productCost, shippingCost: input.shippingCost, stock: input.stock } });
  await syncProductOffers(ctx, input.productId);
  return { offers: input.countries.length };
}

/** Operator placed the order by hand: record the supplier order id (and tracking, if known) so the rest of the pipeline continues. */
export async function recordManualFulfillment(ctx: Ctx, orderId: string, input: { lineKey?: string; supplierId: string; supplierOrderId: string; trackingNumber?: string; carrier?: string }, actor: Actor): Promise<{ shipmentId: string }> {
  const order = await Order.findById(orderId);
  if (!order) throw notFound('Order');
  if (order.payment?.status !== 'succeeded') throw new DomainError('Order is not paid', 'NOT_PAID', 409);
  const sup = await Supplier.findById(input.supplierId);
  if (!sup) throw notFound('Supplier');
  const existing = await Shipment.find({ orderId: order._id, status: { $nin: ['FAILED', 'CANCELLED'] } }).select('lineKey').lean();
  const item = input.lineKey ? order.items.find((i) => i.lineKey === input.lineKey) : order.items.find((i) => !existing.some((e) => e.lineKey === i.lineKey));
  if (!item) throw new DomainError('Unknown order line, or every line already has a supplier order', 'VALIDATION', 422);
  const dup = await Shipment.findOne({ orderId: order._id, lineKey: item.lineKey, status: { $nin: ['FAILED', 'CANCELLED'] } });
  if (dup) throw new DomainError('This order line already has a supplier order', 'CONFLICT', 409);
  const ship = await Shipment.findOneAndUpdate(
    { orderId: order._id, lineKey: item.lineKey, status: { $nin: ['FAILED', 'CANCELLED'] } },
    { $set: { productId: item.productId, sku: item.sku, quantity: item.quantity, supplierId: sup._id, idempotencyKey: `manual:${orderId}:${item.lineKey}`, supplierOrderId: input.supplierOrderId, status: 'CREATED', trackingNumber: input.trackingNumber, carrier: input.carrier, attempts: 1, lastError: null }, $push: { events: { status: 'CREATED', description: 'Order placed manually with supplier', at: new Date() } } },
    { upsert: true, new: true },
  );
  await Supplier.updateOne({ _id: sup._id }, { $inc: { 'stats.ordersTotal': 1 }, $set: { lastSuccessfulOrderAt: new Date() } });
  await audit(ctx, actor, { action: 'supplier.order.recorded_manually', resource: 'order', resourceId: orderId, newValue: { supplier: sup.code, supplierOrderId: input.supplierOrderId, line: item.lineKey }, provider: sup.code });
  await resolveExceptionsFor(ctx, `manual:${orderId}:${item.lineKey}`);
  await recomputeOrderStatus(orderId, 'supplier order recorded manually');
  await ctx.queue.enqueue('sync_tracking', { orderId }, { delayMs: 30_000, dedupeKey: `track-first:${orderId}` });
  return { shipmentId: String(ship!._id) };
}
