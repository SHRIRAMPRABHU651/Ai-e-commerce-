import { pickSupplierSku, providerFor } from './supplierAccess';
import { fulfillmentModeOf } from './supplierOps';
import { randomBytes } from 'node:crypto';
import { calcPaymentFee, paymentFeeModelFor } from '@orvia/analytics';
import { Cart, Customer, Order, OrderItem, Payment, Product, ProductVariant, AnalyticsEvent, WebhookEvent, Shipment, Supplier, Refund } from '@orvia/database';
import { metrics } from '@orvia/config';
import { convertMinor } from '@orvia/types';
import type { CheckoutInput, CountryCode, Currency } from '@orvia/types';
import { audit } from '../infra/audit';
import { getCountry } from '../infra/countries';
import { aiActor, conflict, DomainError, notFound, SYSTEM } from '../infra/context';
import type { Actor, Ctx } from '../infra/context';
import { proposeOrExecute, registerExecutor } from './automation';
import { priceCart } from './cart';
import { raiseException } from './exceptions';
import { assessFraud, validateAddress } from './fraud';
import { notify } from './notify';
import { recomputeOrderStatus } from './orderStatus';
import { selectSupplierLive } from './offers';
import { redeemPromotion, releasePromotion } from './promotions';
import { Promotion } from '@orvia/database';

const orderNumber = (): string => `ORV-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`;

export interface CheckoutContext {
  cartToken: string;
  userId?: string;
  ip?: string;
  ipCountry?: string;
  actor: Actor;
}

export interface CheckoutResult {
  order: { id: string; orderNumber: string; status: string; total: number; currency: string; country: string };
  payment: { provider: string; intentId: string; clientSecret?: string; clientConfig: Record<string, string> } | null;
  reused: boolean;
}

/**
 * Create an order from the server-side priced cart and open a payment with the country's provider.
 * Idempotent on `idempotencyKey`: double-submits return the same order, never a second one.
 */
export async function createOrderFromCart(ctx: Ctx, cc: CheckoutContext, input: CheckoutInput): Promise<CheckoutResult> {
  const existing = await Order.findOne({ idempotencyKey: input.idempotencyKey });
  if (existing) return openPayment(ctx, existing, true);

  const cart = await Cart.findOne({ token: cc.cartToken });
  if (!cart) throw notFound('Cart');
  if (cart.convertedOrderId) throw conflict('This cart was already checked out', 'CART_CONVERTED');
  const country = input.address.country as CountryCode;
  if (cart.country !== country) throw new DomainError('Shipping country must match the store country. Change country in the header and try again.', 'COUNTRY_MISMATCH', 422);
  const cfg = await getCountry(country);
  const addr = validateAddress(input.address);
  if (!addr.ok) throw new DomainError(addr.problems.join('. '), 'BAD_ADDRESS', 422, addr.problems);
  const view = await priceCart(ctx, cc.cartToken, { region: input.address.region, shippingMethod: input.shippingMethod, email: input.email });
  if (view.lines.length === 0) throw new DomainError('Your cart is empty', 'EMPTY_CART', 422);
  if (view.checkoutBlocked) throw new DomainError(`Some items changed: ${view.issues.join('; ')}`, 'CART_CHANGED', 409, view.issues);
  if (input.couponCode && input.couponCode.toUpperCase() !== (cart.couponCode ?? '')) {
    cart.couponCode = input.couponCode.toUpperCase();
    await cart.save();
    return createOrderFromCart(ctx, cc, { ...input, couponCode: cart.couponCode });
  }
  if (view.couponError) throw new DomainError(view.couponError, 'BAD_COUPON', 422);

  const ops = await ctx.settings.get('ops');
  const totalUsd = convertMinor(view.totals.total, cfg.currency, 'USD', ops.fx);
  const prior = await Order.countDocuments({ email: input.email, status: { $nin: ['CANCELLED', 'PENDING_PAYMENT'] } });
  const failedAttempts = await Order.countDocuments({ email: input.email, 'payment.status': 'failed', createdAt: { $gte: new Date(ctx.now().getTime() - 86_400_000) } });
  const fraud = await assessFraud({ email: input.email, userId: cc.userId, ip: cc.ip, ipCountry: cc.ipCountry, shippingCountry: country, totalUsd, shippingMethod: view.shippingMethod, address: input.address, isFirstOrder: prior === 0, failedAttempts }, ops, ctx.now());

  const items = view.lines.map((l) => ({ productId: l.productId, sku: l.sku, title: l.variantLabel ? `${l.title} — ${l.variantLabel}` : l.title, image: l.image, quantity: l.quantity, unitPrice: l.unitPrice, lineKey: `${l.productId}:${l.sku}` }));
  let order;
  try {
    order = await Order.create({
      orderNumber: orderNumber(), idempotencyKey: input.idempotencyKey, userId: cc.userId, email: input.email, country, currency: cfg.currency, items,
      address: input.address, shippingMethod: view.shippingMethod,
      amounts: { subtotal: view.totals.subtotal, discount: view.totals.discount, shipping: view.totals.shipping, tax: view.totals.tax, total: view.totals.total, taxInclusive: view.totals.taxInclusive },
      couponCode: cart.couponCode ?? undefined, status: 'PENDING_PAYMENT', timeline: [{ status: 'PENDING_PAYMENT', at: ctx.now(), note: 'order created', actor: cc.actor.id }],
      fraud: { score: fraud.score, level: fraud.level, signals: fraud.signals, ip: cc.ip }, payment: { status: 'pending' }, isDemo: ctx.cfg.APP_ENV !== 'production' && ctx.cfg.PAYMENT_MODE === 'mock',
    });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) {
      const again = await Order.findOne({ idempotencyKey: input.idempotencyKey });
      if (again) return openPayment(ctx, again, true);
    }
    throw e;
  }
  await OrderItem.insertMany(items.map((i) => ({ orderId: order._id, productId: i.productId, sku: i.sku, title: i.title, quantity: i.quantity, unitPrice: i.unitPrice, country, createdAt: ctx.now() })));
  const promoApplied = view.promotions.find((p) => p.code);
  if (promoApplied) await redeemPromotion(promoApplied.promotionId);
  await Customer.updateOne({ email: input.email }, { $setOnInsert: { email: input.email, name: input.address.fullName, country, userId: cc.userId }, $set: { marketingConsent: cart.marketingConsent ?? false } }, { upsert: true });
  await audit(ctx, cc.actor, { action: 'order.created', resource: 'order', resourceId: String(order._id), newValue: { orderNumber: order.orderNumber, total: view.totals.total, currency: cfg.currency, fraud: fraud.level } });
  metrics.inc('orvia_orders_created_total', { country });
  return openPayment(ctx, order, false);
}

async function openPayment(ctx: Ctx, order: InstanceType<typeof Order>, reused: boolean): Promise<CheckoutResult> {
  const summary = { id: String(order._id), orderNumber: order.orderNumber, status: order.status, total: order.amounts?.total ?? 0, currency: order.currency, country: order.country };
  if (order.status !== 'PENDING_PAYMENT') return { order: summary, payment: null, reused };
  const cfg = await getCountry(order.country);
  const provider = ctx.payments.forCountry(cfg.paymentProviders);
  const existing = await Payment.findOne({ orderId: order._id, provider: provider.key }).select('+clientSecret').lean();
  if (existing) {
    return { order: summary, payment: { provider: provider.key, intentId: existing.intentId, clientSecret: existing.clientSecret ?? undefined, clientConfig: provider.key === 'mock' ? { mode: 'mock' } : {} }, reused };
  }
  const res = await provider.createPayment({ orderId: String(order._id), orderNumber: order.orderNumber, amount: summary.total, currency: order.currency as Currency, email: order.email, idempotencyKey: order.idempotencyKey });
  try {
    await Payment.create({ orderId: order._id, provider: res.provider, intentId: res.intentId, clientSecret: res.clientSecret, amount: summary.total, currency: order.currency, status: 'pending' });
  } catch (e) {
    if ((e as { code?: number }).code !== 11000) throw e;
  }
  await Order.updateOne({ _id: order._id }, { $set: { 'payment.provider': res.provider, 'payment.intentId': res.intentId } });
  return { order: summary, payment: { provider: res.provider, intentId: res.intentId, clientSecret: res.clientSecret, clientConfig: res.clientConfig }, reused };
}

export type WebhookOutcome = 'processed' | 'duplicate' | 'ignored' | 'unknown_intent' | 'rejected';

/** Payment webhook: verify signature -> dedupe event -> re-verify with provider -> atomically mark paid -> fulfil. */
export async function handlePaymentWebhook(ctx: Ctx, providerKey: string, rawBody: string, headers: Record<string, string | string[] | undefined>): Promise<WebhookOutcome> {
  const provider = ctx.payments.get(providerKey);
  const evt = provider.verifyWebhook(rawBody, headers); // throws WebhookSignatureError
  if (evt.type === 'ignored') return 'ignored';
  try {
    await WebhookEvent.create({ provider: providerKey, eventId: evt.id, type: evt.type, processedAt: ctx.now() });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) {
      metrics.inc('orvia_webhook_duplicates_total', { provider: providerKey });
      return 'duplicate';
    }
    throw e;
  }
  const pay = await Payment.findOne({ provider: providerKey, intentId: evt.intentId });
  if (!pay) {
    await WebhookEvent.updateOne({ provider: providerKey, eventId: evt.id }, { $set: { outcome: 'unknown_intent' } });
    return 'unknown_intent';
  }
  const order = await Order.findById(pay.orderId);
  if (!order) return 'unknown_intent';
  if (evt.type === 'payment.failed') {
    pay.status = 'failed';
    pay.failureReason = evt.failureReason;
    await pay.save();
    await Order.updateOne({ _id: order._id, 'payment.status': 'pending' }, { $set: { 'payment.status': 'failed' }, $push: { timeline: { status: 'PENDING_PAYMENT', at: ctx.now(), note: `payment failed: ${evt.failureReason ?? 'unknown'}`, actor: 'webhook' } } });
    ctx.log.warn({ channel: 'payment', order: order.orderNumber, reason: evt.failureReason }, 'payment failed');
    return 'processed';
  }
  if (evt.type !== 'payment.succeeded') return 'ignored';

  const r = await settlePayment(ctx, order, pay, provider, providerKey, evt.id);
  return r;
}

/**
 * Confirm a payment with the provider (never trust a webhook body or the browser) and atomically mark the
 * order paid exactly once. Shared by the webhook handler and the payment-verification job.
 */
export async function settlePayment(ctx: Ctx, order: InstanceType<typeof Order>, pay: InstanceType<typeof Payment>, provider: ReturnType<Ctx['payments']['get']>, providerKey: string, eventId?: string): Promise<WebhookOutcome> {
  const verified = await provider.getPayment(pay.intentId);
  const expected = order.amounts?.total ?? 0;
  if (verified.status !== 'succeeded') return 'ignored';
  if (verified.amount < expected || verified.currency.toUpperCase() !== order.currency) {
    await raiseException(ctx, {
      kind: 'PAYMENT_FAILURE', priority: 'high', orderId: String(order._id), customerEmail: order.email,
      issue: `Payment verification mismatch (provider amount ${verified.amount} ${verified.currency} vs expected ${expected} ${order.currency})`,
      aiRecommendation: 'Do not fulfil. Check the payment in the provider dashboard.', suggestedAction: 'Investigate payment', actionCode: 'dismiss', dedupeKey: `paymismatch:${order._id}`,
    });
    if (eventId) await WebhookEvent.updateOne({ provider: providerKey, eventId }, { $set: { outcome: 'rejected' } });
    return 'rejected';
  }
  const fee = calcPaymentFee(expected, paymentFeeModelFor(order.country));
  const marked = await Order.findOneAndUpdate(
    { _id: order._id, 'payment.status': { $in: ['pending', 'failed'] }, status: { $in: ['PENDING_PAYMENT'] } },
    { $set: { 'payment.status': 'succeeded', 'payment.paidAt': ctx.now(), 'payment.fee': fee, 'costs.paymentFee': fee, status: 'PAID' }, $push: { timeline: { status: 'PAID', at: ctx.now(), note: 'payment confirmed by provider', actor: 'webhook' } } },
    { new: true },
  );
  if (!marked) return 'duplicate';
  pay.status = 'succeeded';
  await pay.save();
  await onPaid(ctx, marked);
  return 'processed';
}

/** Safety net for lost webhooks: poll the provider for stale unpaid orders. */
export async function verifyPendingPayments(ctx: Ctx): Promise<{ checked: number; settled: number }> {
  const older = new Date(ctx.now().getTime() - 3 * 60_000);
  const orders = await Order.find({ status: 'PENDING_PAYMENT', 'payment.intentId': { $exists: true }, createdAt: { $lt: older, $gt: new Date(ctx.now().getTime() - 6 * 3_600_000) } }).limit(100);
  let settled = 0;
  for (const o of orders) {
    const pay = await Payment.findOne({ orderId: o._id });
    if (!pay) continue;
    try {
      const provider = ctx.payments.get(pay.provider);
      const r = await settlePayment(ctx, o, pay, provider, pay.provider);
      if (r === 'processed') settled++;
    } catch (e) {
      ctx.log.warn({ channel: 'payment', order: o.orderNumber, err: (e as Error).message }, 'payment verification failed');
    }
  }
  return { checked: orders.length, settled };
}

async function onPaid(ctx: Ctx, order: InstanceType<typeof Order>): Promise<void> {
  await Cart.updateMany({ userId: order.userId ?? undefined, email: order.email, convertedOrderId: { $exists: false } }, { $set: { convertedOrderId: order._id, 'abandonment.stopped': true } });
  for (const it of order.items) {
    await Product.updateOne({ _id: it.productId }, { $inc: { 'stats.soldCount': it.quantity } });
  }
  await AnalyticsEvent.insertMany(order.items.map((it) => ({ type: 'purchase', productId: it.productId, country: order.country, ts: ctx.now(), meta: { orderId: String(order._id), qty: it.quantity } })));
  await Customer.updateOne({ email: order.email }, { $inc: { ordersCount: 1, lifetimeValue: order.amounts?.total ?? 0 }, $set: { lastOrderAt: ctx.now() } });
  await audit(ctx, { id: 'webhook', type: 'webhook' }, { action: 'order.paid', resource: 'order', resourceId: String(order._id), newValue: { total: order.amounts?.total }, provider: order.payment?.provider ?? undefined });
  metrics.inc('orvia_orders_paid_total', { country: order.country });
  const money = fmt(order.amounts?.total ?? 0, order.currency);
  const url = `${ctx.cfg.WEB_URL}/orders/${order.orderNumber}`;
  await notify(ctx, { template: 'order_confirmation', to: order.email, data: { name: order.address?.fullName ?? undefined, orderNumber: order.orderNumber, total: money, items: order.items.map((i) => `${i.quantity}× ${i.title}`).join(', '), url }, orderId: String(order._id), dedupeKey: `order-confirm:${order._id}` });
  const ops = await ctx.settings.get('ops');
  if (order.fraud?.level === 'high' || order.fraud?.score && order.fraud.score >= ops.fraudHighScore) {
    await raiseException(ctx, {
      kind: 'FRAUD', priority: 'high', orderId: String(order._id), customerEmail: order.email, issue: `High fraud risk (${order.fraud?.score}): ${(order.fraud?.signals ?? []).join('; ')}`,
      aiRecommendation: 'Verify the customer before ordering from the supplier; cancel and refund if suspicious.', suggestedAction: 'Approve fulfilment or cancel & refund', actionCode: 'approve_fulfillment', dedupeKey: `fraud:${order._id}`,
    });
    return;
  }
  await requestFulfillment(ctx, String(order._id));
}

const fmt = (minor: number, currency: string) => new Intl.NumberFormat('en', { style: 'currency', currency }).format(minor / 100);

/** Routes fulfilment through the automation mode (OFF / ASSISTED approval / AUTOMATIC queue). */
export async function requestFulfillment(ctx: Ctx, orderId: string): Promise<void> {
  const mode = await ctx.settings.automationMode('order_fulfillment');
  if (mode === 'OFF') {
    ctx.log.info({ channel: 'order', orderId }, 'fulfilment automation is OFF; order waits for manual action');
    return;
  }
  if (mode === 'ASSISTED') {
    await proposeOrExecute(ctx, { automationKey: 'order_fulfillment', agent: 'OrderAgent', kind: 'fulfill_order', resource: 'order', resourceId: orderId, summary: `Place supplier order(s) for paid order ${orderId}`, payload: { orderId }, confidence: 0.9, dedupeKey: `fulfill-dec:${orderId}` });
    return;
  }
  await Order.updateOne({ _id: orderId }, { $set: { 'fulfillment.state': 'queued' } });
  await ctx.queue.enqueue('fulfill_order', { orderId }, { dedupeKey: `fulfill:${orderId}`, maxAttempts: (await ctx.settings.get('ops')).fulfillmentMaxAttempts });
}

registerExecutor('fulfill_order', async (ctx, payload) => {
  const orderId = String(payload['orderId']);
  await Order.updateOne({ _id: orderId }, { $set: { 'fulfillment.state': 'queued' } });
  await ctx.queue.enqueue('fulfill_order', { orderId, manual: true }, { dedupeKey: `fulfill:${orderId}`, maxAttempts: (await ctx.settings.get('ops')).fulfillmentMaxAttempts });
  return { queued: true };
});

export interface FulfillResult {
  orderId: string;
  placed: number;
  skipped: number;
  failed: number;
  state: string;
}

/**
 * Fulfilment engine. Safe to run repeatedly (job retries, crashes): a unique (orderId,lineKey) shipment row
 * is inserted BEFORE calling the supplier and the supplier receives a deterministic idempotency key, and a
 * pending row pins the chosen supplier so a retry can never order the same unit from a different supplier.
 */
export async function fulfillOrder(ctx: Ctx, orderId: string, opts: { force?: boolean; actor?: Actor } = {}): Promise<FulfillResult> {
  const actor = opts.actor ?? aiActor('FulfillmentAgent');
  const order = await Order.findById(orderId);
  if (!order) throw notFound('Order');
  const res: FulfillResult = { orderId, placed: 0, skipped: 0, failed: 0, state: order.fulfillment?.state ?? 'none' };
  if (order.payment?.status !== 'succeeded') throw new DomainError('Order is not paid', 'NOT_PAID', 409);
  if (['CANCELLED', 'REFUNDED'].includes(order.status)) return { ...res, state: 'cancelled' };
  if (order.exceptionOpen && !opts.force) {
    ctx.log.info({ channel: 'order', orderId }, 'fulfilment skipped: open exception');
    return { ...res, state: 'held' };
  }
  const addr = order.address && validateAddress({ country: order.country as CountryCode, region: order.address.region ?? '', postalCode: order.address.postalCode ?? '', line1: order.address.line1 ?? '', city: order.address.city ?? '' });
  if (addr && !addr.ok && !opts.force) {
    await raiseException(ctx, { kind: 'OTHER', priority: 'medium', orderId, customerEmail: order.email, issue: `Shipping address failed validation: ${addr.problems.join('; ')}`, aiRecommendation: 'Contact the customer to correct the address.', suggestedAction: 'Contact customer', actionCode: 'contact_customer', dedupeKey: `addr:${orderId}` });
    return { ...res, state: 'held' };
  }
  await Order.updateOne({ _id: orderId }, { $set: { 'fulfillment.state': 'processing' }, $inc: { 'fulfillment.attempts': 1 } });
  let retryableError: Error | null = null;

  for (const it of order.items) {
    const done = await Shipment.findOne({ orderId: order._id, lineKey: it.lineKey, status: { $nin: ['FAILED', 'CANCELLED'] } });
    if (done && ['CREATED', 'SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'].includes(done.status)) {
      res.skipped++;
      continue;
    }
    const variant = await ProductVariant.findOne({ sku: it.sku }).select('supplierSku label').lean();
    const excluded: string[] = (await Shipment.find({ orderId: order._id, lineKey: it.lineKey, status: 'FAILED' }).select('supplierId').lean()).map((s) => String(s.supplierId));
    let placed = false;
    // pending row from a previous attempt pins the supplier (the supplier may already hold this order)
    let pending = done && done.status === 'PENDING_CREATE' ? done : null;
    for (let tries = 0; tries < 3 && !placed; tries++) {
      let supplierDoc;
      let externalId: string;
      let sku: string | undefined;
      let costInfo: { productCost: number; shippingCost: number; duties: number } | null = null;
      if (pending) {
        supplierDoc = await Supplier.findById(pending.supplierId);
        const SP = (await import('@orvia/database')).SupplierProduct;
        const link = await SP.findOne({ productId: it.productId, supplierId: pending.supplierId }).lean();
        externalId = link?.externalId ?? '';
        sku = link?.variants?.[0]?.sku ?? undefined;
      } else {
        let sel;
        try {
          sel = await selectSupplierLive(ctx, { productId: String(it.productId), sku: variant?.supplierSku ?? it.sku, country: order.country as CountryCode, quantity: it.quantity, unitPrice: it.unitPrice, excludeSupplierIds: excluded });
        } catch (e) {
          const err = e as Error & { retryable?: boolean };
          if (err.retryable) {
            retryableError = err;
            break;
          }
          await raiseException(ctx, { kind: 'SUPPLIER_FAILURE', priority: 'high', orderId, customerEmail: order.email, issue: `No supplier could fulfil "${it.title}": ${err.message}`, aiRecommendation: 'Source manually from another supplier or cancel and refund.', suggestedAction: 'Change supplier or cancel & refund', actionCode: 'retry_supplier_order', dedupeKey: `nosupplier:${orderId}:${it.lineKey}` });
          res.failed++;
          break;
        }
        if (sel.best.expectedProfit < 0 && !opts.force) {
          await raiseException(ctx, { kind: 'NEGATIVE_MARGIN', priority: 'high', orderId, customerEmail: order.email, issue: `Fulfilling "${it.title}" would lose ${fmt(-sel.best.expectedProfit, order.currency)} (best supplier ${sel.best.supplierName})`, aiRecommendation: 'Approve if you accept the loss, otherwise cancel and refund.', suggestedAction: 'Approve fulfilment or cancel & refund', actionCode: 'approve_fulfillment', details: { expectedProfit: sel.best.expectedProfit, supplier: sel.best.supplierCode }, dedupeKey: `negorder:${orderId}:${it.lineKey}` });
          res.failed++;
          break;
        }
        supplierDoc = await Supplier.findById(sel.best.supplierId);
        const mode = supplierDoc ? fulfillmentModeOf(supplierDoc) : 'MANUAL';
        if (supplierDoc && mode !== 'AUTOMATED' && !opts.force) {
          await raiseException(ctx, {
            kind: 'MANUAL_FULFILLMENT', priority: 'medium', orderId, customerEmail: order.email, productId: String(it.productId),
            issue: `"${it.title}" is routed to ${supplierDoc.name}, which is in ${mode} mode — ${mode === 'ASSISTED' ? 'approve to place the order through its API' : 'place the order with the supplier and record the supplier order id'}.`,
            aiRecommendation: `Best supplier: ${supplierDoc.name} (${sel.best.warehouseCountry} warehouse, ~${sel.best.maxDays} days).`,
            suggestedAction: mode === 'ASSISTED' ? 'Approve fulfilment' : 'Record manual fulfilment', actionCode: mode === 'ASSISTED' ? 'approve_fulfillment' : 'review_product',
            details: { supplier: supplierDoc.code, supplierId: String(supplierDoc._id), lineKey: it.lineKey, mode }, dedupeKey: `manual:${orderId}:${it.lineKey}`,
          });
          res.failed++;
          break;
        }
        externalId = sel.best.externalId;
        sku = sel.best.sku;
        costInfo = { productCost: sel.best.productCost * it.quantity, shippingCost: sel.best.shippingCost, duties: sel.best.duties };
        try {
          pending = await Shipment.create({ orderId: order._id, lineKey: it.lineKey, productId: it.productId, sku: it.sku, quantity: it.quantity, supplierId: sel.best.supplierId, idempotencyKey: `ship:${orderId}:${it.lineKey}:${excluded.length}`, status: 'PENDING_CREATE', cost: { ...costInfo, currency: order.currency } });
        } catch (e) {
          if ((e as { code?: number }).code === 11000) {
            res.skipped++; // a concurrent worker owns this line
            break;
          }
          throw e;
        }
      }
      if (!supplierDoc || !pending) break;
      try {
        const provider = await providerFor(ctx, supplierDoc);
        const SPm = (await import('@orvia/database')).SupplierProduct;
        const spLink = await SPm.findOne({ productId: it.productId, supplierId: supplierDoc._id }).select('variants').lean();
        const so = await provider.createOrder({ idempotencyKey: pending.idempotencyKey, orderRef: order.orderNumber, externalId, sku: pickSupplierSku(spLink?.variants, variant) ?? sku ?? externalId, quantity: it.quantity, destination: { fullName: order.address?.fullName ?? '', line1: order.address?.line1 ?? '', line2: order.address?.line2 ?? '', city: order.address?.city ?? '', region: order.address?.region ?? '', postalCode: order.address?.postalCode ?? '', country: order.country as CountryCode, phone: order.address?.phone ?? '' } });
        const fx = (await ctx.settings.get('ops')).fx;
        const conv = (n: number) => convertMinor(n, so.cost.currency, order.currency as Currency, fx);
        pending.supplierOrderId = so.supplierOrderId;
        pending.status = 'CREATED';
        pending.carrier = so.carrier;
        pending.trackingNumber = so.trackingNumber;
        pending.events.push({ status: 'CREATED', description: 'Order placed with supplier', at: ctx.now() } as never);
        pending.cost = { productCost: costInfo?.productCost ?? conv(so.cost.productCost), shippingCost: costInfo?.shippingCost ?? conv(so.cost.shippingCost), duties: costInfo?.duties ?? 0, currency: order.currency } as never;
        pending.attempts += 1;
        pending.lastError = undefined;
        await pending.save();
        await Supplier.updateOne({ _id: supplierDoc._id }, { $inc: { 'stats.ordersTotal': 1 } });
        await audit(ctx, actor, { action: 'supplier.order.created', resource: 'order', resourceId: orderId, newValue: { supplier: supplierDoc.code, supplierOrderId: so.supplierOrderId, line: it.lineKey }, provider: supplierDoc.code, reason: 'best expected profit + customer experience' });
        metrics.inc('orvia_supplier_orders_total', { supplier: supplierDoc.code, outcome: 'ok' });
        res.placed++;
        placed = true;
      } catch (e) {
        const err = e as Error & { retryable?: boolean };
        pending.attempts += 1;
        pending.lastError = err.message;
        metrics.inc('orvia_supplier_failures_total', { supplier: supplierDoc.code });
        metrics.inc('orvia_supplier_orders_total', { supplier: supplierDoc.code, outcome: 'fail' });
        if (err.retryable !== false && (e as { name?: string }).name !== 'DomainError' && (e as { retryable?: boolean }).retryable !== false) {
          // transient: keep the pending row (pins supplier + idempotency key) and let the queue retry with backoff
          await pending.save();
          retryableError = err;
          break;
        }
        // definitive refusal (e.g. out of stock): mark failed and try the next-best supplier
        pending.status = 'FAILED';
        await pending.save();
        await Supplier.updateOne({ _id: supplierDoc._id }, { $inc: { 'stats.ordersFailed': 1 } });
        excluded.push(String(supplierDoc._id));
        pending = null;
        if (tries === 2) {
          res.failed++;
          await raiseException(ctx, { kind: 'SUPPLIER_FAILURE', priority: 'high', orderId, customerEmail: order.email, issue: `Suppliers rejected "${it.title}": ${err.message}`, aiRecommendation: 'Try another supplier manually or cancel and refund.', suggestedAction: 'Retry supplier order / change supplier', actionCode: 'retry_supplier_order', dedupeKey: `reject:${orderId}:${it.lineKey}` });
        }
      }
    }
  }

  if (retryableError) {
    await Order.updateOne({ _id: orderId }, { $set: { 'fulfillment.state': 'processing', 'fulfillment.lastError': retryableError.message } });
    throw retryableError; // queue retries with exponential backoff; dead-letter -> exception
  }
  const ships = await Shipment.find({ orderId: order._id, status: { $in: ['CREATED', 'SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'] } }).lean();
  const allPlaced = ships.length === order.items.length;
  const supplierCost = ships.reduce((a, s) => a + (s.cost?.productCost ?? 0), 0);
  const shippingCost = ships.reduce((a, s) => a + (s.cost?.shippingCost ?? 0), 0);
  const duties = ships.reduce((a, s) => a + (s.cost?.duties ?? 0), 0);
  const revenueNet = (order.amounts?.subtotal ?? 0) - (order.amounts?.discount ?? 0) + (order.amounts?.shipping ?? 0) - (order.amounts?.taxInclusive ? (order.amounts?.tax ?? 0) : 0);
  const fee = order.costs?.paymentFee ?? 0;
  const contribution = revenueNet - supplierCost - shippingCost - duties - fee;
  await Order.updateOne({ _id: orderId }, { $set: { 'fulfillment.state': allPlaced ? 'placed' : ships.length ? 'partial' : 'failed', 'fulfillment.lastError': null, 'costs.supplierCost': supplierCost, 'costs.shippingCost': shippingCost, 'costs.duties': duties, 'profit.contribution': contribution, 'profit.margin': revenueNet > 0 ? contribution / revenueNet : 0 } });
  res.state = allPlaced ? 'placed' : ships.length ? 'partial' : 'failed';
  if (ships.length) await recomputeOrderStatus(orderId, 'supplier order(s) placed');
  if (allPlaced) await ctx.queue.enqueue('sync_tracking', { orderId }, { delayMs: 30_000, dedupeKey: `track-first:${orderId}` });
  return res;
}

registerExecutor('approve_fulfillment', async (ctx, p, actor) => fulfillOrder(ctx, String(p['orderId']), { force: true, actor }));

/** Dead-letter hook: exhausted retries become a visible exception rather than a silent failure. */
export async function onJobDead(ctx: Ctx, job: { name: string; payload: unknown }, err: Error): Promise<void> {
  const p = (job.payload ?? {}) as { orderId?: string };
  if (job.name === 'fulfill_order' && p.orderId) {
    const order = await Order.findById(p.orderId).select('email').lean();
    await Order.updateOne({ _id: p.orderId }, { $set: { 'fulfillment.state': 'failed', 'fulfillment.lastError': err.message } });
    await raiseException(ctx, { kind: 'SUPPLIER_FAILURE', priority: 'critical', orderId: p.orderId, customerEmail: order?.email, issue: `Supplier order failed after all retries: ${err.message}`, aiRecommendation: 'Retry once the supplier API recovers, or switch supplier.', suggestedAction: 'Retry supplier order', actionCode: 'retry_supplier_order', dedupeKey: `dead:${p.orderId}` });
  } else {
    ctx.log.error({ channel: 'queue', job: job.name, err: err.message }, 'job dead-lettered');
  }
}

/** Admin: retry fulfilment (optionally forcing past a held exception). */
export async function retrySupplierOrder(ctx: Ctx, orderId: string, actor: Actor, opts: { force?: boolean } = {}) {
  const order = await Order.findById(orderId);
  if (!order) throw notFound('Order');
  if (order.payment?.status !== 'succeeded') throw new DomainError('Order is not paid', 'NOT_PAID', 409);
  await audit(ctx, actor, { action: 'order.retry_fulfillment', resource: 'order', resourceId: orderId, reason: opts.force ? 'forced past exception' : 'manual retry' });
  const { ExceptionModel: Ex } = await import('@orvia/database');
  // a retry is the resolution of supplier-failure exceptions; fraud / margin holds still need explicit approval
  await Ex.updateMany({ orderId, kind: 'SUPPLIER_FAILURE', status: { $in: ['open', 'in_progress'] } }, { $set: { status: 'resolved', resolution: `Retried by ${actor.id}`, resolvedBy: actor.id, resolvedAt: new Date() } });
  const stillOpen = await Ex.countDocuments({ orderId, status: { $in: ['open', 'in_progress'] } });
  if (!stillOpen) await Order.updateOne({ _id: orderId }, { $set: { exceptionOpen: false } });
  if (opts.force) {
    const { ExceptionModel } = await import('@orvia/database');
    await ExceptionModel.updateMany({ orderId, status: { $in: ['open', 'in_progress'] } }, { $set: { status: 'resolved', resolution: `Approved by ${actor.id}`, resolvedBy: actor.id, resolvedAt: new Date() } });
    await Order.updateOne({ _id: orderId }, { $set: { exceptionOpen: false } });
  }
  await Order.updateOne({ _id: orderId }, { $set: { 'fulfillment.state': 'queued' } });
  await ctx.queue.enqueue('fulfill_order', { orderId, force: !!opts.force }, { dedupeKey: `fulfill:${orderId}` });
}

/** Change supplier for an unshipped line: cancel at the old supplier, then re-place excluding it. */
export async function changeSupplier(ctx: Ctx, orderId: string, lineKey: string, actor: Actor) {
  const sh = await Shipment.findOne({ orderId, lineKey, status: { $nin: ['FAILED', 'CANCELLED'] } });
  if (sh && sh.supplierOrderId) {
    const sup = await Supplier.findById(sh.supplierId);
    if (sup) {
      const prov = await providerFor(ctx, sup);
      const c = await prov.cancelOrder(sh.supplierOrderId);
      if (!c.cancelled) throw conflict(`Cannot change supplier: ${c.reason ?? 'already shipped'}`);
    }
    sh.status = 'FAILED';
    sh.lastError = `Cancelled by ${actor.id} to change supplier`;
    await sh.save();
  } else if (sh) {
    sh.status = 'FAILED';
    await sh.save();
  }
  await audit(ctx, actor, { action: 'order.change_supplier', resource: 'order', resourceId: orderId, reason: lineKey });
  await Order.updateOne({ _id: orderId }, { $set: { 'fulfillment.state': 'queued' } });
  await ctx.queue.enqueue('fulfill_order', { orderId, force: true }, { dedupeKey: `fulfill:${orderId}` });
}

/* ---------------------------- tracking sync ---------------------------- */
const ACTIVE = ['CREATED', 'SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY'];
const TEMPLATE_FOR: Record<string, 'shipped' | 'out_for_delivery' | 'delivered'> = { SHIPPED: 'shipped', IN_TRANSIT: 'shipped', OUT_FOR_DELIVERY: 'out_for_delivery', DELIVERED: 'delivered' };

export async function syncTracking(ctx: Ctx, opts: { orderId?: string; limit?: number } = {}): Promise<{ checked: number; updated: number; failures: number }> {
  const out = { checked: 0, updated: 0, failures: 0 };
  const q = opts.orderId ? { orderId: opts.orderId, status: { $in: ACTIVE } } : { status: { $in: ACTIVE }, supplierOrderId: { $exists: true } };
  const ships = await Shipment.find(q).sort({ lastTrackedAt: 1 }).limit(opts.limit ?? 200);
  for (const sh of ships) {
    out.checked++;
    const sup = await Supplier.findById(sh.supplierId);
    if (!sup || !sh.supplierOrderId) continue;
    try {
      const prov = await providerFor(ctx, sup);
      const t = await prov.getTracking(sh.supplierOrderId);
      sh.lastTrackedAt = ctx.now();
      if (!t.available) {
        // honest: no tracking yet. Never invent any. Escalate if it stays missing too long.
        const ageDays = (ctx.now().getTime() - ((sh as unknown as { createdAt: Date }).createdAt?.getTime() ?? 0)) / 86_400_000;
        if (ageDays > 5 * (ctx.cfg.isProduction ? 1 : 1) && ctx.cfg.MOCK_TIME_SCALE <= 1) {
          await raiseException(ctx, { kind: 'TRACKING', priority: 'medium', orderId: String(sh.orderId), issue: 'No tracking number from supplier after 5 days', aiRecommendation: 'Contact the supplier.', suggestedAction: 'Contact supplier', actionCode: 'dismiss', dedupeKey: `notrack:${sh._id}` });
        }
        await sh.save();
        continue;
      }
      const changed = t.status !== sh.status || (t.trackingNumber && t.trackingNumber !== sh.trackingNumber);
      sh.carrier = t.carrier ?? sh.carrier;
      sh.trackingNumber = t.trackingNumber ?? sh.trackingNumber;
      sh.trackingUrl = t.trackingUrl ?? sh.trackingUrl;
      if (t.estimatedDelivery) sh.estimatedDelivery = new Date(t.estimatedDelivery);
      sh.events = t.events.map((e) => ({ status: e.status, description: e.description, location: e.location, at: new Date(e.at) })) as never;
      if (changed) {
        sh.status = t.status as typeof sh.status;
        out.updated++;
      }
      await sh.save();
      if (changed) {
        const order = await Order.findById(sh.orderId);
        if (order) {
          await recomputeOrderStatus(String(order._id), `shipment ${t.status.toLowerCase()}`);
          const tpl = TEMPLATE_FOR[t.status];
          if (tpl) {
            await notify(ctx, { template: tpl, to: order.email, orderId: String(order._id), data: { name: order.address?.fullName ?? undefined, orderNumber: order.orderNumber, trackingNumber: sh.trackingNumber ?? undefined, carrier: sh.carrier ?? undefined, eta: sh.estimatedDelivery?.toDateString(), url: `${ctx.cfg.WEB_URL}/orders/${order.orderNumber}` }, dedupeKey: `ship:${sh._id}:${tpl}` });
          }
          if (t.status === 'DELIVERED') {
            await ctx.queue.enqueue('review_request', { orderId: String(order._id) }, { delayMs: ctx.cfg.isProduction ? 3 * 86_400_000 : 60_000, dedupeKey: `review-req:${order._id}` });
            const late = sh.estimatedDelivery && ctx.now() > sh.estimatedDelivery;
            if (late) await Supplier.updateOne({ _id: sup._id }, { $inc: { 'stats.ordersLate': 1 } });
          }
        }
      }
    } catch (e) {
      out.failures++;
      sh.lastError = (e as Error).message;
      sh.lastTrackedAt = ctx.now();
      await sh.save();
      ctx.log.warn({ channel: 'supplier', supplier: sup.code, err: (e as Error).message }, 'tracking sync failed');
    }
  }
  // overdue shipments
  const overdue = await Shipment.find({ status: { $in: ACTIVE }, estimatedDelivery: { $lt: new Date(ctx.now().getTime() - 3 * (ctx.cfg.isProduction ? 86_400_000 : 86_400_000 / Math.max(1, ctx.cfg.MOCK_TIME_SCALE / 600))) } }).limit(50).lean();
  for (const s of overdue) {
    await raiseException(ctx, { kind: 'TRACKING', priority: 'high', orderId: String(s.orderId), issue: `Shipment is overdue (estimated ${s.estimatedDelivery?.toDateString()})`, aiRecommendation: 'Contact supplier; consider reship or refund.', suggestedAction: 'Contact supplier / refund', actionCode: 'dismiss', dedupeKey: `overdue:${s._id}` });
  }
  return out;
}

/* ------------------------- cancel / refund / returns ------------------------- */
export async function cancelOrder(ctx: Ctx, orderId: string, actor: Actor, reason: string) {
  const order = await Order.findById(orderId);
  if (!order) throw notFound('Order');
  if (['CANCELLED', 'REFUNDED'].includes(order.status)) return order;
  const ships = await Shipment.find({ orderId });
  const live = ships.filter((s) => !['FAILED', 'CANCELLED'].includes(s.status));
  for (const s of live) {
    if (['SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'].includes(s.status)) throw conflict('Order already shipped. Use the returns flow instead.', 'ALREADY_SHIPPED');
  }
  for (const s of live) {
    if (!s.supplierOrderId) {
      s.status = 'CANCELLED';
      await s.save();
      continue;
    }
    const sup = await Supplier.findById(s.supplierId);
    const prov = sup ? await providerFor(ctx, sup) : null;
    const c = prov ? await prov.cancelOrder(s.supplierOrderId) : { cancelled: false, reason: 'supplier missing' };
    if (!c.cancelled) throw conflict(`Supplier could not cancel: ${c.reason ?? 'already shipped'}`, 'SUPPLIER_CANCEL_FAILED');
    s.status = 'CANCELLED';
    await s.save();
  }
  const wasPaid = order.payment?.status === 'succeeded';
  order.status = 'CANCELLED';
  order.cancelledAt = ctx.now();
  order.exceptionOpen = false;
  order.timeline.push({ status: 'CANCELLED', at: ctx.now(), note: reason, actor: actor.id });
  await order.save();
  if (order.couponCode) {
    const promo = await Promotion.findOne({ code: order.couponCode }).select('_id').lean();
    if (promo) await releasePromotion(String(promo._id));
  }
  await audit(ctx, actor, { action: 'order.cancelled', resource: 'order', resourceId: orderId, reason });
  if (wasPaid) await refundOrder(ctx, orderId, { actor, reason: `cancellation: ${reason}`, keyHint: 'cancel', bypassApproval: true });
  await notify(ctx, { template: 'cancellation', to: order.email, orderId, data: { name: order.address?.fullName ?? undefined, orderNumber: order.orderNumber }, dedupeKey: `cancel:${orderId}` });
  const { ExceptionModel } = await import('@orvia/database');
  await ExceptionModel.updateMany({ orderId, status: { $in: ['open', 'in_progress'] } }, { $set: { status: 'resolved', resolution: 'Order cancelled', resolvedBy: actor.id, resolvedAt: new Date() } });
  return order;
}

export async function refundOrder(ctx: Ctx, orderId: string, o: { actor: Actor; amount?: number; reason: string; keyHint?: string; bypassApproval?: boolean }) {
  const order = await Order.findById(orderId);
  if (!order) throw notFound('Order');
  if (order.payment?.status !== 'succeeded' && order.payment?.status !== 'partially_refunded') throw new DomainError('Order has no captured payment to refund', 'NOT_PAID', 409);
  const total = order.amounts?.total ?? 0;
  const already = order.costs?.refunded ?? 0;
  const amount = Math.min(o.amount ?? total - already, total - already);
  if (amount <= 0) throw new DomainError('Nothing left to refund', 'NOTHING_TO_REFUND', 409);
  const key = `refund:${orderId}:${o.keyHint ?? amount}:${already}`;
  const existing = await Refund.findOne({ idempotencyKey: key });
  if (existing) return existing;
  const ops = await ctx.settings.get('ops');
  const auto = await ctx.settings.get('automation');
  const usd = convertMinor(amount, order.currency as Currency, 'USD', ops.fx);
  const needsApproval = !o.bypassApproval && usd > auto.autoRefundLimitUsd && !(o.actor.role === 'SUPER_ADMIN' || o.actor.role === 'ADMIN');
  const refund = await Refund.create({ orderId, amount, currency: order.currency, reason: o.reason, status: needsApproval ? 'pending_approval' : 'processing', idempotencyKey: key, requestedBy: o.actor.id });
  if (needsApproval) {
    await raiseException(ctx, { kind: 'HIGH_VALUE_REFUND', priority: 'high', orderId, customerEmail: order.email, issue: `Refund of ${fmt(amount, order.currency)} needs approval`, aiRecommendation: 'Approve if the claim is legitimate.', suggestedAction: 'Approve refund', actionCode: 'refund_order', details: { refundId: String(refund._id) }, dedupeKey: `refund-appr:${refund._id}` });
    return refund;
  }
  return executeRefund(ctx, String(refund._id), o.actor);
}

export async function executeRefund(ctx: Ctx, refundId: string, actor: Actor) {
  const refund = await Refund.findById(refundId);
  if (!refund) throw notFound('Refund');
  if (refund.status === 'succeeded') return refund;
  const order = await Order.findById(refund.orderId);
  if (!order) throw notFound('Order');
  const pay = await Payment.findOne({ orderId: order._id });
  if (!pay) throw notFound('Payment');
  const provider = ctx.payments.get(pay.provider);
  try {
    const r = await provider.refund({ intentId: pay.intentId, amount: refund.amount, currency: refund.currency ?? order.currency, idempotencyKey: refund.idempotencyKey, reason: refund.reason ?? undefined });
    refund.providerRefundId = r.refundId;
    refund.status = r.status === 'failed' ? 'failed' : 'succeeded';
    await refund.save();
    if (refund.status === 'succeeded') {
      const refunded = (order.costs?.refunded ?? 0) + refund.amount;
      const full = refunded >= (order.amounts?.total ?? 0);
      await Order.updateOne({ _id: order._id }, { $set: { 'costs.refunded': refunded, 'payment.status': full ? 'refunded' : 'partially_refunded', ...(full && order.status !== 'CANCELLED' ? { status: 'REFUNDED' } : {}) }, $push: { timeline: { status: full ? 'REFUNDED' : order.status, at: ctx.now(), note: `refund ${refund.amount}`, actor: actor.id } } });
      pay.refundedAmount = refunded;
      pay.status = full ? 'refunded' : 'partially_refunded';
      await pay.save();
      await notify(ctx, { template: 'refund', to: order.email, orderId: String(order._id), data: { name: order.address?.fullName ?? undefined, orderNumber: order.orderNumber, amount: fmt(refund.amount, order.currency), url: `${ctx.cfg.WEB_URL}/orders/${order.orderNumber}` }, dedupeKey: `refund-mail:${refund._id}` });
      await audit(ctx, actor, { action: 'order.refunded', resource: 'order', resourceId: String(order._id), newValue: { amount: refund.amount }, provider: pay.provider, reason: refund.reason ?? undefined });
    }
    return refund;
  } catch (e) {
    refund.status = 'failed';
    refund.failureReason = (e as Error).message;
    await refund.save();
    throw e;
  }
}

export async function approveRefund(ctx: Ctx, refundId: string, actor: Actor) {
  const refund = await Refund.findOneAndUpdate({ _id: refundId, status: 'pending_approval' }, { $set: { status: 'processing' } }, { new: true });
  if (!refund) throw conflict('Refund is not awaiting approval');
  const { ExceptionModel } = await import('@orvia/database');
  await ExceptionModel.updateMany({ dedupeKey: `refund-appr:${refundId}` }, { $set: { status: 'resolved', resolution: `Approved by ${actor.id}`, resolvedBy: actor.id, resolvedAt: new Date() } });
  return executeRefund(ctx, refundId, actor);
}

export async function expireUnpaidOrders(ctx: Ctx, olderThanMinutes = 120): Promise<number> {
  const cutoff = new Date(ctx.now().getTime() - olderThanMinutes * 60_000);
  const stale = await Order.find({ status: 'PENDING_PAYMENT', createdAt: { $lt: cutoff } }).limit(100);
  for (const o of stale) await cancelOrder(ctx, String(o._id), SYSTEM, 'Payment not completed in time');
  return stale.length;
}
