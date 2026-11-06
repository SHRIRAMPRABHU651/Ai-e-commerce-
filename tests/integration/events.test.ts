import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Customer, EventsOutbox, EventsCampaignRecipient, EventsExperiment, EventsSegment, EventsUnsubscribe, Notification } from '@orvia/database';
import { deliverOutbox, enqueueMarketingEvent, buildCanonicalEvent, setEventProviders, MetaCapiProvider, startCampaign, sendCampaignEmail, unsubscribeUrl, retryOutbox } from '@orvia/core';
import type { Ctx } from '@orvia/core';
import { closeCtx, testCtx } from '../helpers/ctx';
import { startApi } from '../helpers/client';
import type { Client } from '../helpers/client';

// NOTE: written for CI (needs MongoDB); not executed in the authoring sandbox.
let ctx: Ctx;
let mk: (h?: Record<string, string>) => Client;
const calls: { url: string; body: any }[] = [];
let failNext = 0;
const fakeFetch = (async (url: string, init: { body: string }) => {
  calls.push({ url, body: JSON.parse(init.body) });
  if (failNext > 0) { failNext--; return new Response('{"error":"boom"}', { status: 500 }); }
  return new Response('{"events_received":1}', { status: 200 });
}) as unknown as typeof fetch;

beforeAll(async () => {
  ctx = await testCtx('events', { EVENTS_PROVIDERS: 'meta', EVENTS_MODE: 'live', META_PIXEL_ID: '123', META_CAPI_ACCESS_TOKEN: 'tok' });
  setEventProviders(ctx, [new MetaCapiProvider(ctx.cfg, 'live', fakeFetch)]);
  mk = (await startApi(ctx)).client;
}, 180_000);
afterAll(closeCtx);

const ev = (id: string) => buildCanonicalEvent({ name: 'purchase', businessKey: id, occurredAt: new Date(), email: 'buyer@example.com', value: 10, currency: 'USD', orderId: id, consent: { marketing: true, analytics: true } });

describe('outbox', () => {
  it('suppresses without consent, dedupes by event id, delivers with the shared id, retries then dead-letters', async () => {
    const none = await enqueueMarketingEvent(ctx, ev('o-nocons'), {}, { source: 't' });
    expect(none.suppressed).toBe(1);
    expect((await EventsOutbox.findOne({ eventId: 'purchase:o-nocons' }))!.payload).toMatchObject({ user: {} });
    const c = { cart: { marketingConsent: true } };
    expect((await enqueueMarketingEvent(ctx, ev('o1'), c, { source: 't' })).queued).toBe(1);
    expect((await enqueueMarketingEvent(ctx, ev('o1'), c, { source: 't' })).duplicates).toBe(1);
    expect(await EventsOutbox.countDocuments({ eventId: 'purchase:o1' })).toBe(1);
    const r = await deliverOutbox(ctx);
    expect(r.sent).toBe(1);
    expect(calls.at(-1)!.body.data[0].event_id).toBe('purchase:o1');
    expect(JSON.stringify(calls.at(-1)!.body)).not.toContain('buyer@example.com');
    // retry path
    await enqueueMarketingEvent(ctx, ev('o2'), c, { source: 't' });
    failNext = 1;
    expect((await deliverOutbox(ctx)).retried).toBe(1);
    const row = await EventsOutbox.findOne({ eventId: 'purchase:o2' });
    expect(row!.status).toBe('pending');
    expect(row!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    // dead letter after max attempts, then admin retry
    await EventsOutbox.updateOne({ _id: row!._id }, { $set: { attempts: 7, nextAttemptAt: new Date() } });
    failNext = 1;
    expect((await deliverOutbox(ctx)).dead).toBe(1);
    expect(await retryOutbox(ctx, { id: String(row!._id) })).toBe(1);
  });
});

describe('browser capture + consent + unsubscribe', () => {
  it('stores nothing without consent and honours consent after it', async () => {
    const c = mk();
    const sid = 'session-aaaaaaaa';
    expect((await c.post('/api/v1/events/attribution', { sessionId: sid, utm: { source: 'x' } })).status).toBe(204);
    const { EventsSession } = await import('@orvia/database');
    expect(await EventsSession.findOne({ sessionId: sid })).toBeNull();
    expect((await c.post('/api/v1/events/consent', { sessionId: sid, analytics: true, marketing: true })).status).toBe(204);
    await c.post('/api/v1/events/attribution', { sessionId: sid, utm: { source: 'google', medium: 'cpc' }, clickIds: { gclid: 'G1' } });
    const s = await EventsSession.findOne({ sessionId: sid });
    expect(s!.clickIds!.gclid).toBe('G1');
    expect(s!.firstTouch!.utmSource).toBe('google');
    const t = await c.post('/api/v1/events/track', { eventId: 'add_to_cart:abc-123', name: 'add_to_cart', sessionId: sid });
    expect(t.status).toBe(202);
    expect(await EventsOutbox.countDocuments({ eventId: 'add_to_cart:abc-123' })).toBe(1);
  });
  it('rejects invalid event ids and tampered unsubscribe tokens', async () => {
    const c = mk();
    expect((await c.post('/api/v1/events/track', { eventId: 'bad id', name: 'page_view', sessionId: 'session-bbbbbbbb' })).status).toBe(400);
    expect((await c.get('/api/v1/unsubscribe?token=garbage.token.value')).status).toBe(400);
  });
});

describe('campaigns never reach non-consenting addresses', () => {
  it('sends only to consenting, non-unsubscribed customers and withdraws consent on unsubscribe', async () => {
    await Customer.create([{ email: 'yes@example.com', marketingConsent: true, country: 'US' }, { email: 'no@example.com', marketingConsent: false, country: 'US' }, { email: 'out@example.com', marketingConsent: true, country: 'US' }]);
    await EventsUnsubscribe.create({ email: 'out@example.com', source: 'test' });
    const seg = await EventsSegment.create({ name: 'US', rules: [{ field: 'country', op: 'in', value: ['US'] }] });
    const { EventsCampaign } = await import('@orvia/database');
    const camp = await EventsCampaign.create({ name: 'c', segmentId: seg._id, subject: 'Hello', message: 'Body', status: 'draft' });
    await startCampaign(ctx, String(camp._id), { id: 'tester', type: 'system' });
    expect((await EventsCampaignRecipient.find({ campaignId: camp._id })).map((r) => r.email)).toEqual(['yes@example.com']);
    await ctx.queue.drain();
    const sent = await Notification.find({ dedupeKey: new RegExp(`^camp:${camp._id}:`) });
    expect(sent.map((n) => n.to)).toEqual(['yes@example.com']);
    expect(sent[0]!.body).toContain('Unsubscribe');
    // re-check at send time: consent withdrawn after planning
    await Customer.updateOne({ email: 'yes@example.com' }, { $set: { marketingConsent: false } });
    expect((await sendCampaignEmail(ctx, { campaignId: String(camp._id), email: 'yes@example.com' })).sent).toBe(false);
    // unsubscribe link works and flips consent
    await Customer.updateOne({ email: 'yes@example.com' }, { $set: { marketingConsent: true } });
    const url = new URL(unsubscribeUrl(ctx.cfg.API_URL, 'yes@example.com', ctx.cfg.JWT_SECRET));
    expect((await mk().get(url.pathname + url.search)).status).toBe(200);
    expect((await Customer.findOne({ email: 'yes@example.com' }))!.marketingConsent).toBe(false);
    expect(await EventsUnsubscribe.exists({ email: 'yes@example.com' })).toBeTruthy();
  });
});

describe('experiments + feeds + admin permissions', () => {
  it('assigns deterministically, exposes once, converts only exposed visitors', async () => {
    await EventsExperiment.create({ key: 'hero-test', name: 'Hero', variants: [{ key: 'control', weight: 50 }, { key: 'b', weight: 50 }], conversionEvent: 'purchase', status: 'running' });
    const c = mk();
    const a = await c.get('/api/v1/experiments/hero-test/assign?visitorId=visitor-12345');
    const b = await c.get('/api/v1/experiments/hero-test/assign?visitorId=visitor-12345');
    expect(a.body.variant).toBe(b.body.variant);
    expect((await c.post('/api/v1/experiments/hero-test/convert', { visitorId: 'visitor-12345' })).body.recorded).toBe(false);
    await c.post('/api/v1/experiments/hero-test/expose', { visitorId: 'visitor-12345' });
    await c.post('/api/v1/experiments/hero-test/expose', { visitorId: 'visitor-12345' });
    expect((await c.post('/api/v1/experiments/hero-test/convert', { visitorId: 'visitor-12345' })).body.recorded).toBe(true);
  });
  it('serves feeds and protects admin routes', async () => {
    const c = mk();
    const g = await c.get('/api/v1/feeds/google/US');
    expect(g.status).toBe(200);
    expect(g.raw.startsWith('<?xml')).toBe(true);
    expect((await c.get('/api/v1/feeds/meta/ZZ')).status).toBe(404);
    expect((await c.get('/api/v1/admin/campaigns/health')).status).toBe(401);
  });
});
