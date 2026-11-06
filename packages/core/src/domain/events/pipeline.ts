/**
 * Server-side conversion events: outbox enqueue, delivery, generators from orders/refunds/returns, session capture and health.
 * Pure rules live in eventModel.ts / outboxPolicy.ts / providers.ts; this file is the Mongo glue.
 */
import { Cart, Customer, EventsCursor, EventsOutbox, EventsSession, Order, Referral, ReturnRequest, Refund, User } from '@orvia/database';
import { ProviderError, enabledEventProviders } from '@orvia/config';
import type { CanonicalEvent, MarketingEventName, MarketingProviderKey, OutboxStatus } from '@orvia/types';
import type { Ctx } from '../../infra/context';
import { buildCanonicalEvent, buildEventId, consentForProvider, hasTrackingConsent, redactEvent, redactForDisplay, toMajor } from './eventModel';
import type { ConsentInputs } from './eventModel';
import { OUTBOX_LOCK_MS, decideAfterFailure, isExpiredForProvider } from './outboxPolicy';
import { buildEventProviders } from './providers';
import type { MarketingEventProvider } from './providers';
import { convertByEvent } from './marketingService';

const providerCache = new WeakMap<Ctx, MarketingEventProvider[]>();
export function eventProviders(ctx: Ctx): MarketingEventProvider[] {
  let p = providerCache.get(ctx);
  if (!p) providerCache.set(ctx, (p = buildEventProviders(ctx.cfg)));
  return p;
}
/** Test hook: replace the adapters (e.g. with a fake fetch). */
export function setEventProviders(ctx: Ctx, p: MarketingEventProvider[]): void {
  providerCache.set(ctx, p);
}

/* ------------------------------ consent lookup ------------------------------ */
export async function loadConsentInputs(q: { sessionId?: string | null; cartToken?: string | null; orderId?: string; email?: string | null }): Promise<ConsentInputs & { sessionDoc?: Awaited<ReturnType<typeof findSession>> }> {
  const cart = q.orderId ? await Cart.findOne({ convertedOrderId: q.orderId }).select('token marketingConsent').lean() : q.cartToken ? await Cart.findOne({ token: q.cartToken }).select('token marketingConsent').lean() : null;
  const sessionDoc = q.sessionId ? await findSession({ sessionId: q.sessionId }) : cart?.token ? await findSession({ cartToken: cart.token }) : null;
  const customer = q.email ? await Customer.findOne({ email: q.email.toLowerCase() }).select('marketingConsent').lean() : null;
  return { session: sessionDoc ? { consent: sessionDoc.consent ?? undefined } : null, cart: cart ? { marketingConsent: cart.marketingConsent } : null, customer: customer ? { marketingConsent: customer.marketingConsent } : null, sessionDoc };
}
const findSession = (f: { sessionId?: string; cartToken?: string }) => EventsSession.findOne(f).lean();

/* ------------------------------ enqueue ------------------------------ */
export interface EnqueueResult { queued: number; suppressed: number; skipped: number; duplicates: number }

/**
 * Fan an event out to every enabled provider that can represent it. Without consent the row is stored REDACTED as
 * `suppressed` (so admins can see the volume) and is never delivered. Duplicate (eventId, provider) pairs are ignored.
 */
export async function enqueueMarketingEvent(ctx: Ctx, event: CanonicalEvent, consent: ConsentInputs, o: { source: string; sessionId?: string }): Promise<EnqueueResult> {
  const out: EnqueueResult = { queued: 0, suppressed: 0, skipped: 0, duplicates: 0 };
  const now = ctx.now();
  for (const p of eventProviders(ctx).filter((x) => x.supports(event.name))) {
    let status: OutboxStatus = 'pending';
    let payload: CanonicalEvent = event;
    let skipReason: string | undefined;
    if (!consentForProvider(p.key, consent)) { status = 'suppressed'; payload = redactEvent(event); skipReason = 'no_consent'; }
    else if (isExpiredForProvider(p.key, new Date(event.occurredAt), now)) { status = 'skipped'; skipReason = 'too_old_for_provider'; }
    else if (!p.buildRequest(event)) { status = 'skipped'; skipReason = 'not_representable'; }
    try {
      const r = await EventsOutbox.updateOne(
        { eventId: event.eventId, provider: p.key },
        { $setOnInsert: { eventId: event.eventId, provider: p.key, name: event.name, status, payload, occurredAt: new Date(event.occurredAt), source: o.source, sessionId: o.sessionId, skipReason, nextAttemptAt: now, attempts: 0 } },
        { upsert: true },
      );
      if (r.upsertedCount === 0) out.duplicates++;
      else if (status === 'pending') out.queued++;
      else if (status === 'suppressed') out.suppressed++;
      else out.skipped++;
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e; // concurrent insert of the same (eventId, provider): fine
      out.duplicates++;
    }
  }
  return out;
}

/* ------------------------------ delivery ------------------------------ */
async function claimOne(ctx: Ctx) {
  const now = ctx.now();
  return EventsOutbox.findOneAndUpdate(
    { $or: [{ status: 'pending', nextAttemptAt: { $lte: now } }, { status: 'sending', lockedUntil: { $lt: now } }] },
    { $set: { status: 'sending', lockedUntil: new Date(now.getTime() + OUTBOX_LOCK_MS) }, $inc: { attempts: 1 } },
    { sort: { nextAttemptAt: 1 }, new: true },
  );
}

export async function deliverOutbox(ctx: Ctx, limit = 100): Promise<{ sent: number; logged: number; retried: number; dead: number; skipped: number }> {
  const out = { sent: 0, logged: 0, retried: 0, dead: 0, skipped: 0 };
  const providers = new Map(eventProviders(ctx).map((p) => [p.key, p]));
  for (let i = 0; i < limit; i++) {
    const row = await claimOne(ctx);
    if (!row) break;
    const provider = providers.get(row.provider as MarketingProviderKey);
    const event = row.payload as CanonicalEvent;
    const finish = (set: Record<string, unknown>) => EventsOutbox.updateOne({ _id: row._id }, { $set: { lockedUntil: null, ...set } });
    if (!provider) { await finish({ status: 'skipped', skipReason: 'provider_disabled' }); out.skipped++; continue; }
    // consent may have been withdrawn after the event was queued
    if (row.sessionId) {
      const s = await findSession({ sessionId: row.sessionId });
      if (s?.consent && (provider.key === 'ga4' ? s.consent.analytics === false && s.consent.marketing === false : s.consent.marketing === false)) {
        await finish({ status: 'suppressed', skipReason: 'consent_withdrawn', payload: redactEvent(event) });
        out.skipped++;
        continue;
      }
    }
    if (isExpiredForProvider(provider.key, row.occurredAt, ctx.now())) { await finish({ status: 'skipped', skipReason: 'too_old_for_provider' }); out.skipped++; continue; }
    try {
      const r = await provider.send(event);
      if (r.status === 'logged') {
        // log mode never claims delivery; keep it visible and out of the retry loop
        await finish({ status: 'skipped', skipReason: 'log_mode_not_delivered' });
        out.logged++;
      } else {
        await finish({ status: 'sent', sentAt: ctx.now(), lastError: null });
        out.sent++;
      }
    } catch (e) {
      const retryable = e instanceof ProviderError ? e.retryable : true;
      const d = decideAfterFailure({ failedAttempts: row.attempts, retryable, now: ctx.now(), rand: Math.random() });
      const msg = (e as Error).message.slice(0, 400);
      if (d.status === 'dead') { await finish({ status: 'dead', lastError: msg }); out.dead++; ctx.log.warn({ channel: 'events', provider: row.provider, event: row.name, err: msg }, 'marketing event dead-lettered'); }
      else { await finish({ status: 'pending', nextAttemptAt: d.nextAttemptAt, lastError: msg }); out.retried++; }
    }
  }
  return out;
}

/** Admin: put dead-lettered (or skipped-by-mistake) rows back in the queue. */
export async function retryOutbox(ctx: Ctx, f: { id?: string; provider?: MarketingProviderKey }, limit = 500): Promise<number> {
  const filter: Record<string, unknown> = { status: 'dead' };
  if (f.id) filter['_id'] = f.id;
  if (f.provider) filter['provider'] = f.provider;
  const ids = (await EventsOutbox.find(filter).select('_id').limit(limit).lean()).map((r) => r._id);
  if (!ids.length) return 0;
  const r = await EventsOutbox.updateMany({ _id: { $in: ids } }, { $set: { status: 'pending', attempts: 0, nextAttemptAt: ctx.now(), lastError: null } });
  return r.modifiedCount;
}

/* ------------------------------ generators ------------------------------ */
const OVERLAP_MS = 10 * 60_000;
const INITIAL_LOOKBACK_MS = 24 * 3_600_000;
const PAID = ['succeeded', 'partially_refunded', 'refunded'];

async function cursorStart(ctx: Ctx, key: string): Promise<Date> {
  const c = await EventsCursor.findOne({ key }).lean();
  return c?.lastAt ? new Date(c.lastAt.getTime() - OVERLAP_MS) : new Date(ctx.now().getTime() - INITIAL_LOOKBACK_MS);
}
const advance = (key: string, at: Date, id: string) => EventsCursor.updateOne({ key }, { $set: { lastAt: at, lastId: id } }, { upsert: true });

export interface GenResult { scanned: number; queued: number; suppressed: number; skipped: number; duplicates: number }
const emptyGen = (): GenResult => ({ scanned: 0, queued: 0, suppressed: 0, skipped: 0, duplicates: 0 });
const add = (g: GenResult, r: EnqueueResult) => { g.queued += r.queued; g.suppressed += r.suppressed; g.skipped += r.skipped; g.duplicates += r.duplicates; };

/** purchase + repeat_purchase from paid orders. Demo orders are never sent to ad platforms. */
export async function generatePurchaseEvents(ctx: Ctx, limit = 200): Promise<GenResult> {
  const g = emptyGen();
  if (!eventProviders(ctx).length) return g;
  const key = 'gen:purchase';
  const orders = await Order.find({ 'payment.paidAt': { $gte: await cursorStart(ctx, key) }, 'payment.status': { $in: PAID }, isDemo: { $ne: true } }).sort({ 'payment.paidAt': 1 }).limit(limit).lean();
  for (const o of orders) {
    g.scanned++;
    const paidAt = o.payment?.paidAt ?? o.createdAt;
    const consent = await loadConsentInputs({ orderId: String(o._id), email: o.email });
    const s = consent.sessionDoc;
    const base = {
      occurredAt: paidAt, email: o.email, phone: o.address?.phone, phoneCountry: o.address?.country ?? o.country, externalId: o.userId ? String(o.userId) : undefined,
      clickIds: s?.clickIds ?? undefined, browserIds: s?.browserIds ?? undefined,
      value: toMajor(Math.max(0, (o.amounts?.subtotal ?? 0) - (o.amounts?.discount ?? 0))), currency: o.currency, orderId: String(o._id), country: o.country,
      items: o.items.map((i) => ({ id: String(i.productId), name: i.title, price: toMajor(i.unitPrice ?? 0), quantity: i.quantity })),
      consent: { marketing: hasTrackingConsent(consent, 'marketing'), analytics: hasTrackingConsent(consent, 'analytics') },
    };
    const withClient = (ev: CanonicalEvent): CanonicalEvent => (s?.client && base.consent.marketing ? { ...ev, user: { ...ev.user, ip: s.client.ip ?? undefined, userAgent: s.client.userAgent ?? undefined } } : ev);
    add(g, await enqueueMarketingEvent(ctx, withClient(buildCanonicalEvent({ ...base, name: 'purchase', businessKey: String(o._id) })), consent, { source: `order:${o._id}`, sessionId: s?.sessionId }));
    const earlier = await Order.exists({ email: o.email, _id: { $ne: o._id }, 'payment.status': { $in: PAID }, 'payment.paidAt': { $lt: paidAt }, isDemo: { $ne: true } });
    if (earlier) add(g, await enqueueMarketingEvent(ctx, withClient(buildCanonicalEvent({ ...base, name: 'repeat_purchase', businessKey: String(o._id) })), consent, { source: `order:${o._id}`, sessionId: s?.sessionId }));
    if (s?.sessionId) await convertByEvent(s.sessionId, 'purchase').catch(() => undefined); // experiment conversion (idempotent)
    await advance(key, paidAt, String(o._id));
  }
  return g;
}

/** refund events from succeeded refunds (idempotent per refund id). */
export async function generateRefundEvents(ctx: Ctx, limit = 200): Promise<GenResult> {
  const g = emptyGen();
  if (!eventProviders(ctx).length) return g;
  const key = 'gen:refund';
  const refunds = await Refund.find({ status: 'succeeded', updatedAt: { $gte: await cursorStart(ctx, key) } }).sort({ updatedAt: 1 }).limit(limit).lean();
  for (const r of refunds) {
    g.scanned++;
    const o = await Order.findById(r.orderId).lean();
    if (!o || o.isDemo) { await advance(key, r.updatedAt, String(r._id)); continue; }
    const consent = await loadConsentInputs({ orderId: String(o._id), email: o.email });
    const s = consent.sessionDoc;
    const ev = buildCanonicalEvent({
      name: 'refund', businessKey: String(r._id), occurredAt: r.updatedAt, email: o.email, clickIds: s?.clickIds ?? undefined, browserIds: s?.browserIds ?? undefined,
      value: toMajor(Math.max(0, (o.amounts?.subtotal ?? 0) - (o.amounts?.discount ?? 0))), refundValue: toMajor(r.amount ?? 0), currency: o.currency, orderId: String(o._id), country: o.country,
      consent: { marketing: hasTrackingConsent(consent, 'marketing'), analytics: hasTrackingConsent(consent, 'analytics') },
    });
    add(g, await enqueueMarketingEvent(ctx, ev, consent, { source: `refund:${r._id}`, sessionId: s?.sessionId }));
    await advance(key, r.updatedAt, String(r._id));
  }
  return g;
}

/** return (request created), signup and referral events. These carry no money and use only the customer's own recorded preference. */
export async function generateLifecycleEvents(ctx: Ctx, limit = 200): Promise<GenResult> {
  const g = emptyGen();
  if (!eventProviders(ctx).length) return g;
  const emit = async (name: MarketingEventName, id: string, at: Date, email: string | undefined, extra: { orderId?: string; userId?: string } = {}) => {
    const consent = await loadConsentInputs({ orderId: extra.orderId, email });
    const ev = buildCanonicalEvent({ name, businessKey: id, occurredAt: at, email, externalId: extra.userId, orderId: extra.orderId, consent: { marketing: hasTrackingConsent(consent, 'marketing'), analytics: hasTrackingConsent(consent, 'analytics') } });
    add(g, await enqueueMarketingEvent(ctx, ev, consent, { source: `${name}:${id}`, sessionId: consent.sessionDoc?.sessionId }));
    g.scanned++;
  };
  const rkey = 'gen:return';
  for (const r of await ReturnRequest.find({ createdAt: { $gte: await cursorStart(ctx, rkey) } }).sort({ createdAt: 1 }).limit(limit).lean()) {
    const o = await Order.findById(r.orderId).select('email isDemo').lean();
    if (o && !o.isDemo) await emit('return', String(r._id), r.createdAt, o.email, { orderId: String(r.orderId) });
    await advance(rkey, r.createdAt, String(r._id));
  }
  const skey = 'gen:signup';
  for (const u of await User.find({ role: 'CUSTOMER', isDemo: { $ne: true }, createdAt: { $gte: await cursorStart(ctx, skey) } }).sort({ createdAt: 1 }).limit(limit).lean()) {
    await emit('signup', String(u._id), u.createdAt, u.email, { userId: String(u._id) });
    await advance(skey, u.createdAt, String(u._id));
  }
  const fkey = 'gen:referral';
  for (const r of await Referral.find({ status: 'rewarded', createdAt: { $gte: await cursorStart(ctx, fkey) } }).sort({ createdAt: 1 }).limit(limit).lean()) {
    await emit('referral', String(r._id), r.createdAt, r.referrerEmail, { orderId: String(r.orderId), userId: String(r.referrerUserId) });
    await advance(fkey, r.createdAt, String(r._id));
  }
  return g;
}

/** Public entry for other workstreams (loyalty, creators…): emit any canonical event with an explicit business key. */
export async function emitMarketingEvent(ctx: Ctx, input: { name: MarketingEventName; businessKey: string; occurredAt?: Date; email?: string; userId?: string; value?: number; currency?: string; orderId?: string; sessionId?: string }): Promise<EnqueueResult> {
  const consent = await loadConsentInputs({ sessionId: input.sessionId, orderId: input.orderId, email: input.email });
  const ev = buildCanonicalEvent({
    name: input.name, businessKey: input.businessKey, occurredAt: input.occurredAt ?? ctx.now(), email: input.email, externalId: input.userId, value: input.value, currency: input.currency, orderId: input.orderId,
    consent: { marketing: hasTrackingConsent(consent, 'marketing'), analytics: hasTrackingConsent(consent, 'analytics') },
  });
  return enqueueMarketingEvent(ctx, ev, consent, { source: `${input.name}:${input.businessKey}`, sessionId: input.sessionId });
}

/** Browser-originated event (view_item, add_to_cart…): same eventId as the pixel hit so platforms dedupe. */
export async function ingestBrowserEvent(ctx: Ctx, b: { eventId: string; name: MarketingEventName; sessionId: string; productId?: string; searchString?: string; sourceUrl?: string }): Promise<EnqueueResult> {
  const consent = await loadConsentInputs({ sessionId: b.sessionId });
  const s = consent.sessionDoc;
  const marketing = hasTrackingConsent(consent, 'marketing');
  const ev = buildCanonicalEvent({
    name: b.name, eventId: b.eventId, occurredAt: ctx.now(), sourceUrl: b.sourceUrl, searchString: b.searchString,
    items: b.productId ? [{ id: b.productId, quantity: 1 }] : undefined, clickIds: s?.clickIds ?? undefined, browserIds: s?.browserIds ?? undefined,
    consent: { marketing, analytics: hasTrackingConsent(consent, 'analytics') },
  });
  const withClient: CanonicalEvent = s?.client && marketing ? { ...ev, user: { ...ev.user, ip: s.client.ip ?? undefined, userAgent: s.client.userAgent ?? undefined } } : ev;
  return enqueueMarketingEvent(ctx, withClient, consent, { source: 'browser', sessionId: b.sessionId });
}

/* ------------------------------ sessions: consent + attribution ------------------------------ */
export async function recordTrackingConsent(ctx: Ctx, sessionId: string, c: { analytics: boolean; marketing: boolean }, cartToken?: string) {
  await EventsSession.updateOne({ sessionId }, { $set: { consent: { ...c, at: ctx.now() }, lastSeenAt: ctx.now(), ...(cartToken ? { cartToken } : {}) }, ...(c.marketing ? {} : { $unset: { client: 1 } }) }, { upsert: true });
}

type Touch = { utmSource?: string; utmMedium?: string; utmCampaign?: string; utmTerm?: string; utmContent?: string; clickId?: string; clickIdType?: string; referrerHost?: string; landingPath?: string; at: Date };
const hasSignal = (t: Touch) => !!(t.utmSource || t.utmMedium || t.utmCampaign || t.clickId || t.referrerHost);

/** Stores UTMs / click ids first-party on the session. Only called for sessions with recorded consent (route enforces). */
export async function recordAttribution(ctx: Ctx, b: { sessionId: string; utm: { source?: string; medium?: string; campaign?: string; term?: string; content?: string }; clickIds: Record<string, string | undefined>; browserIds: Record<string, string | undefined>; referrerHost?: string; landingPath?: string }, cartToken: string | undefined, client: { ip?: string; userAgent?: string }) {
  const at = ctx.now();
  const idType = (['gclid', 'fbclid', 'ttclid', 'gbraid', 'wbraid'] as const).find((k) => b.clickIds[k]);
  const touch: Touch = { utmSource: b.utm.source, utmMedium: b.utm.medium, utmCampaign: b.utm.campaign, utmTerm: b.utm.term, utmContent: b.utm.content, clickId: idType ? b.clickIds[idType] : undefined, clickIdType: idType, referrerHost: b.referrerHost, landingPath: b.landingPath, at };
  const existing = await EventsSession.findOne({ sessionId: b.sessionId }).select('firstTouch consent').lean();
  const marketing = existing?.consent?.marketing === true;
  const set: Record<string, unknown> = { lastSeenAt: at };
  if (cartToken) set['cartToken'] = cartToken;
  if (hasSignal(touch)) {
    set['lastTouch'] = touch;
    if (!existing?.firstTouch?.at) set['firstTouch'] = touch;
  }
  for (const k of ['fbclid', 'gclid', 'ttclid', 'gbraid', 'wbraid']) if (b.clickIds[k]) set[`clickIds.${k}`] = b.clickIds[k];
  for (const k of ['fbp', 'fbc', 'ttp', 'gaClientId']) if (b.browserIds[k]) set[`browserIds.${k}`] = b.browserIds[k];
  if (marketing && client.ip) set['client.ip'] = client.ip;
  if (marketing && client.userAgent) set['client.userAgent'] = client.userAgent.slice(0, 300);
  await EventsSession.updateOne({ sessionId: b.sessionId }, { $set: set }, { upsert: true });
}

/* ------------------------------ health + inspector ------------------------------ */
export async function integrationHealth(ctx: Ctx) {
  const enabled = new Set(enabledEventProviders(ctx.cfg));
  const all: MarketingProviderKey[] = ['meta', 'tiktok', 'ga4', 'google_ads'];
  const live = new Map(eventProviders(ctx).map((p) => [p.key, p]));
  const since = new Date(ctx.now().getTime() - 24 * 3_600_000);
  const rows = [];
  for (const k of all) {
    const p = live.get(k);
    const [pending, dead, sent24, lastOk, lastErr] = await Promise.all([
      EventsOutbox.countDocuments({ provider: k, status: { $in: ['pending', 'sending'] } }),
      EventsOutbox.countDocuments({ provider: k, status: 'dead' }),
      EventsOutbox.countDocuments({ provider: k, status: 'sent', sentAt: { $gte: since } }),
      EventsOutbox.findOne({ provider: k, status: 'sent' }).sort({ sentAt: -1 }).select('sentAt').lean(),
      EventsOutbox.findOne({ provider: k, lastError: { $exists: true, $ne: null } }).sort({ updatedAt: -1 }).select('lastError updatedAt').lean(),
    ]);
    rows.push({
      provider: k, label: p?.label ?? k, enabled: enabled.has(k), configured: p?.isConfigured() ?? false, missingCredentials: enabled.has(k) ? (p?.missingCredentials() ?? []) : [],
      mode: p?.mode ?? null, adapterStatus: 'implemented_against_public_docs_unverified', pending, dead, sentLast24h: sent24, lastSuccessAt: lastOk?.sentAt ?? null, lastError: lastErr?.lastError ?? null,
    });
  }
  const [suppressed24] = await Promise.all([EventsOutbox.countDocuments({ status: 'suppressed', createdAt: { $gte: since } })]);
  return { mode: ctx.cfg.EVENTS_MODE, providers: rows, suppressedNoConsentLast24h: suppressed24 };
}

export async function listOutbox(f: { status?: OutboxStatus; provider?: MarketingProviderKey; page: number; pageSize: number }) {
  const q: Record<string, unknown> = {};
  if (f.status) q['status'] = f.status;
  if (f.provider) q['provider'] = f.provider;
  const [items, total] = await Promise.all([
    EventsOutbox.find(q).sort({ createdAt: -1 }).skip((f.page - 1) * f.pageSize).limit(f.pageSize).lean(),
    EventsOutbox.countDocuments(q),
  ]);
  return {
    total, page: f.page, pageSize: f.pageSize,
    items: items.map((r) => ({ id: String(r._id), provider: r.provider, name: r.name, status: r.status, attempts: r.attempts, nextAttemptAt: r.nextAttemptAt, sentAt: r.sentAt, lastError: r.lastError, skipReason: r.skipReason, source: r.source, occurredAt: r.occurredAt, event: redactForDisplay(r.payload as CanonicalEvent) })),
  };
}

export { buildEventId };
