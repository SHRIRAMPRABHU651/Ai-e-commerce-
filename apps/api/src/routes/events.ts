import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Cart, EventsCampaign, EventsExperiment, EventsSegment, EventsSession } from '@orvia/database';
import {
  SEGMENT_PRESETS, assignExperiment, attributionReport, campaignClickRedirect, campaignResults, computeSegment, convertByEvent, convertExperiment, DomainError, exposeExperiment, experimentResults,
  googleFeed, ingestBrowserEvent, integrationHealth, listOutbox, metaFeed, campaignProductPerformance, recordAttribution, recordClick, recordTrackingConsent, retryOutbox, startCampaign, testSendCampaign,
  unsubscribeEmail, verifyToken, audit, loadFeed,
} from '@orvia/core';
import type { Ctx } from '@orvia/core';
import { MARKETING_PROVIDER_KEYS, OUTBOX_STATUSES, SELLABLE_STATES, attributionBodySchema, campaignBodySchema, consentBodySchema, countrySchema, experimentBodySchema, isCountryCode, objectId, segmentBodySchema, trackEventBodySchema } from '@orvia/types';
import type { SegmentRule } from '@orvia/types';
import { route } from '../http';
import { CART_COOKIE } from '../plugins';

const R = 'marketing:read' as const;
const W = 'marketing:write' as const;
const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;
const keyOf = (req: { params: unknown }) => (req.params as { key: string }).key;
const page = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) });

/** Events workstream: conversion-event capture, consent, attribution, unsubscribe/click redirects, experiments, feeds and the /admin/campaigns API. */
export function eventsRoutes(app: FastifyInstance, ctx: Ctx): void {
  /* ----------------------------- public: browser capture ----------------------------- */
  route(app, ctx, {
    method: 'POST', url: '/events/track', summary: 'Report a browser event with the shared dedupe id (consent-gated server-side forwarding)', tags: ['Storefront'], rateLimit: { max: 240, timeWindow: '1 minute' }, body: trackEventBodySchema,
    handler: async ({ body, reply }) => {
      await convertByEvent(body.sessionId, body.name).catch(() => undefined);
      const r = await ingestBrowserEvent(ctx, body);
      return reply.status(202).send({ ok: true, queued: r.queued, suppressed: r.suppressed });
    },
  });
  route(app, ctx, {
    method: 'POST', url: '/events/consent', summary: 'Record the visitor’s tracking consent choice for this session', tags: ['Storefront'], rateLimit: { max: 60, timeWindow: '1 minute' }, body: consentBodySchema,
    handler: async ({ req, body, reply }) => { await recordTrackingConsent(ctx, body.sessionId, { analytics: body.analytics, marketing: body.marketing }, req.cookies[CART_COOKIE]); return reply.status(204).send(); },
  });
  route(app, ctx, {
    method: 'POST', url: '/events/attribution', summary: 'Store UTM / click-id attribution first-party (only for sessions that granted consent)', tags: ['Storefront'], rateLimit: { max: 60, timeWindow: '1 minute' }, body: attributionBodySchema,
    handler: async ({ req, body, reply }) => {
      const s = await EventsSession.findOne({ sessionId: body.sessionId }).select('consent').lean();
      if (!s?.consent?.analytics && !s?.consent?.marketing) return reply.status(204).send(); // no recorded consent: store nothing
      await recordAttribution(ctx, body, req.cookies[CART_COOKIE], { ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '') });
      return reply.status(204).send();
    },
  });

  /* ----------------------------- public: unsubscribe + click redirect ----------------------------- */
  const unsub = async (token: string) => {
    const d = verifyToken('unsub', token, ctx.cfg.JWT_SECRET);
    if (!d?.['e']) throw new DomainError('This unsubscribe link is not valid.', 'INVALID_TOKEN', 400);
    await unsubscribeEmail(ctx, d['e'], d['c'] ? 'campaign_link' : 'email_link', d['c']);
    return d['e'];
  };
  const q = z.object({ token: z.string().min(10).max(2000) });
  route(app, ctx, {
    method: 'GET', url: '/unsubscribe', summary: 'One-click unsubscribe from Orvia marketing email (signed token)', tags: ['Storefront'], rateLimit: { max: 30, timeWindow: '1 minute' }, query: q,
    handler: async ({ query, reply }) => {
      await unsub(query.token);
      return reply.type('text/html; charset=utf-8').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Unsubscribed</title><body style="font-family:sans-serif;max-width:480px;margin:4rem auto;padding:0 1rem"><h1>You are unsubscribed</h1><p>You will no longer receive marketing email from Orvia. Order and delivery messages about purchases you make are not affected.</p>');
    },
  });
  route(app, ctx, {
    method: 'POST', url: '/unsubscribe', summary: 'RFC 8058 one-click unsubscribe', tags: ['Storefront'], rateLimit: { max: 30, timeWindow: '1 minute' }, query: q,
    handler: async ({ query, reply }) => { await unsub(query.token); return reply.status(204).send(); },
  });
  route(app, ctx, {
    method: 'GET', url: '/r', summary: 'Signed campaign link redirect (counts the click)', tags: ['Storefront'], rateLimit: { max: 120, timeWindow: '1 minute' }, query: q,
    handler: async ({ query, reply }) => {
      const t = campaignClickRedirect(ctx, query.token);
      if (!t) throw new DomainError('Invalid link', 'INVALID_TOKEN', 400);
      await recordClick(ctx, t.campaignId, t.email).catch(() => undefined);
      return reply.redirect(t.url, 302);
    },
  });

  /* ----------------------------- public: experiments ----------------------------- */
  const visitor = z.object({ visitorId: z.string().min(8).max(64) });
  route(app, ctx, {
    method: 'GET', url: '/experiments/:key/assign', summary: 'Deterministic variant for a visitor (no exposure recorded)', tags: ['Storefront'], rateLimit: { max: 120, timeWindow: '1 minute' }, query: visitor,
    handler: async ({ req, query }) => (await assignExperiment(keyOf(req), query.visitorId)) ?? { key: keyOf(req), variant: null },
  });
  route(app, ctx, {
    method: 'POST', url: '/experiments/:key/expose', summary: 'Record that the visitor saw their variant', tags: ['Storefront'], rateLimit: { max: 120, timeWindow: '1 minute' }, body: visitor,
    handler: async ({ req, body }) => (await exposeExperiment(keyOf(req), body.visitorId)) ?? { key: keyOf(req), variant: null },
  });
  route(app, ctx, {
    method: 'POST', url: '/experiments/:key/convert', summary: 'Record a conversion for an exposed visitor', tags: ['Storefront'], rateLimit: { max: 120, timeWindow: '1 minute' }, body: visitor,
    handler: async ({ req, body }) => ({ recorded: await convertExperiment(keyOf(req), body.visitorId) }),
  });

  /* ----------------------------- public: feeds ----------------------------- */
  const feed = (url: string, kind: 'google' | 'meta') => route(app, ctx, {
    method: 'GET', url, summary: kind === 'google' ? 'Google Merchant Center feed (RSS/XML)' : 'Meta catalogue feed (CSV)', tags: ['Storefront'], rateLimit: { max: 30, timeWindow: '1 minute' },
    handler: async ({ req, reply }) => {
      const c = (req.params as { country: string }).country.replace(/\.(xml|csv)$/i, '').toUpperCase();
      if (!isCountryCode(c)) throw new DomainError('Unknown country', 'NOT_FOUND', 404);
      const f = kind === 'google' ? await googleFeed(ctx, c) : await metaFeed(ctx, c);
      return reply.header('cache-control', 'public, max-age=900').type(kind === 'google' ? 'application/xml; charset=utf-8' : 'text/csv; charset=utf-8').send(f.body);
    },
  });
  feed('/feeds/google/:country', 'google');
  feed('/feeds/meta/:country', 'meta');

  /* ----------------------------- admin: integration health + stream ----------------------------- */
  route(app, ctx, { method: 'GET', url: '/admin/campaigns/health', summary: 'Conversion-event integration health', tags: ['Admin'], auth: 'staff', permission: R, handler: () => integrationHealth(ctx) });
  route(app, ctx, {
    method: 'GET', url: '/admin/campaigns/outbox', summary: 'Event stream inspector (redacted)', tags: ['Admin'], auth: 'staff', permission: R,
    query: page.extend({ status: z.enum(OUTBOX_STATUSES).optional(), provider: z.enum(MARKETING_PROVIDER_KEYS).optional() }),
    handler: ({ query }) => listOutbox(query),
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/campaigns/outbox/retry', summary: 'Retry dead-lettered events', tags: ['Admin'], auth: 'staff', permission: W,
    body: z.object({ id: objectId.optional(), provider: z.enum(MARKETING_PROVIDER_KEYS).optional() }).refine((b) => b.id || b.provider, 'id or provider required'),
    handler: async ({ req, body }) => {
      const n = await retryOutbox(ctx, body);
      await audit(ctx, req.actor, { action: 'events.outbox.retry', resource: 'events_outbox', newValue: { ...body, retried: n } });
      return { retried: n };
    },
  });

  /* ----------------------------- admin: segments ----------------------------- */
  route(app, ctx, {
    method: 'GET', url: '/admin/campaigns/segments', summary: 'Segments + presets', tags: ['Admin'], auth: 'staff', permission: R,
    handler: async () => ({ items: (await EventsSegment.find().sort({ createdAt: -1 }).limit(100).lean()).map((s) => ({ id: String(s._id), name: s.name, description: s.description, rules: s.rules })), presets: SEGMENT_PRESETS }),
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/campaigns/segments/preview', summary: 'Compute a segment on demand (counts only; emails masked)', tags: ['Admin'], auth: 'staff', permission: R, body: z.object({ rules: segmentBodySchema.shape.rules }),
    handler: async ({ body }) => { const { members: _m, ...r } = await computeSegment(ctx, body.rules as SegmentRule[]); return r; },
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/campaigns/segments', summary: 'Create a segment', tags: ['Admin'], auth: 'staff', permission: W, body: segmentBodySchema,
    handler: async ({ req, body, reply }) => { const s = await EventsSegment.create({ ...body, createdBy: req.actor.id }); await audit(ctx, req.actor, { action: 'events.segment.created', resource: 'events_segment', resourceId: String(s._id) }); return reply.status(201).send({ id: String(s._id) }); },
  });
  route(app, ctx, {
    method: 'DELETE', url: '/admin/campaigns/segments/:id', summary: 'Delete a segment not used by an active campaign', tags: ['Admin'], auth: 'staff', permission: W,
    handler: async ({ req, reply }) => {
      if (await EventsCampaign.exists({ segmentId: idOf(req), status: { $in: ['scheduled', 'sending'] } })) throw new DomainError('Segment is used by an active campaign', 'CONFLICT', 409);
      await EventsSegment.deleteOne({ _id: idOf(req) });
      return reply.status(204).send();
    },
  });

  /* ----------------------------- admin: email campaigns ----------------------------- */
  route(app, ctx, {
    method: 'GET', url: '/admin/campaigns/email', summary: 'Email campaigns', tags: ['Admin'], auth: 'staff', permission: R, query: page,
    handler: async ({ query }) => {
      const [items, total] = await Promise.all([EventsCampaign.find().sort({ createdAt: -1 }).skip((query.page - 1) * query.pageSize).limit(query.pageSize).lean(), EventsCampaign.countDocuments()]);
      return { total, page: query.page, pageSize: query.pageSize, dailyLimit: ctx.cfg.EVENTS_EMAIL_DAILY_LIMIT, items: items.map((c) => ({ id: String(c._id), name: c.name, status: c.status, subject: c.subject, segmentId: String(c.segmentId), scheduledAt: c.scheduledAt, plan: c.plan, maxRecipients: c.maxRecipients, createdAt: c.createdAt })) };
    },
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/campaigns/email', summary: 'Create a draft email campaign', tags: ['Admin'], auth: 'staff', permission: W, body: campaignBodySchema,
    handler: async ({ req, body, reply }) => {
      if (!(await EventsSegment.exists({ _id: body.segmentId }))) throw new DomainError('Segment not found', 'NOT_FOUND', 404);
      const c = await EventsCampaign.create({ ...body, createdBy: req.actor.id, status: 'draft' });
      await audit(ctx, req.actor, { action: 'events.campaign.created', resource: 'email_campaign', resourceId: String(c._id) });
      return reply.status(201).send({ id: String(c._id) });
    },
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/campaigns/email/:id/test-send', summary: 'Send a [TEST] copy to your own account email', tags: ['Admin'], auth: 'staff', permission: W,
    handler: async ({ req, user, reply }) => { await testSendCampaign(ctx, idOf(req), user.email); return reply.status(202).send({ to: user.email }); },
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/campaigns/email/:id/schedule', summary: 'Schedule a draft campaign', tags: ['Admin'], auth: 'staff', permission: W, body: z.object({ scheduledAt: z.coerce.date() }),
    handler: async ({ req, body }) => {
      if (body.scheduledAt.getTime() < ctx.now().getTime() + 60_000) throw new DomainError('Schedule at least a minute in the future', 'VALIDATION', 422);
      const c = await EventsCampaign.findOneAndUpdate({ _id: idOf(req), status: { $in: ['draft', 'scheduled'] } }, { $set: { status: 'scheduled', scheduledAt: body.scheduledAt } }, { new: true });
      if (!c) throw new DomainError('Campaign is not editable', 'CONFLICT', 409);
      await audit(ctx, req.actor, { action: 'events.campaign.scheduled', resource: 'email_campaign', resourceId: idOf(req), newValue: { scheduledAt: body.scheduledAt } });
      return { status: c.status, scheduledAt: c.scheduledAt };
    },
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/campaigns/email/:id/send', summary: 'Send now (consent, unsubscribe list, frequency and daily caps enforced)', tags: ['Admin'], auth: 'staff', permission: W,
    handler: async ({ req }) => { const c = await startCampaign(ctx, idOf(req), req.actor); return { status: c.status, plan: c.plan }; },
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/campaigns/email/:id/cancel', summary: 'Cancel a draft/scheduled/sending campaign (queued sends stop)', tags: ['Admin'], auth: 'staff', permission: W,
    handler: async ({ req }) => {
      const c = await EventsCampaign.findOneAndUpdate({ _id: idOf(req), status: { $in: ['draft', 'scheduled', 'sending'] } }, { $set: { status: 'cancelled', finishedAt: ctx.now() } }, { new: true });
      if (!c) throw new DomainError('Campaign cannot be cancelled', 'CONFLICT', 409);
      await audit(ctx, req.actor, { action: 'events.campaign.cancelled', resource: 'email_campaign', resourceId: idOf(req) });
      return { status: c.status };
    },
  });
  route(app, ctx, { method: 'GET', url: '/admin/campaigns/email/:id/results', summary: 'Per-campaign results', tags: ['Admin'], auth: 'staff', permission: R, handler: ({ req }) => campaignResults(idOf(req)) });

  /* ----------------------------- admin: experiments ----------------------------- */
  route(app, ctx, {
    method: 'GET', url: '/admin/campaigns/experiments', summary: 'Experiments', tags: ['Admin'], auth: 'staff', permission: R,
    handler: async () => ({ items: (await EventsExperiment.find().sort({ createdAt: -1 }).limit(100).lean()).map((e) => ({ key: e.key, name: e.name, status: e.status, variants: e.variants, conversionEvent: e.conversionEvent, hypothesis: e.hypothesis, startedAt: e.startedAt })) }),
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/campaigns/experiments', summary: 'Create an experiment (draft)', tags: ['Admin'], auth: 'staff', permission: W, body: experimentBodySchema,
    handler: async ({ req, body, reply }) => {
      if (new Set(body.variants.map((v) => v.key)).size !== body.variants.length) throw new DomainError('Variant keys must be unique', 'VALIDATION', 422);
      try { await EventsExperiment.create({ ...body, createdBy: req.actor.id, status: 'draft' }); } catch (e) { if ((e as { code?: number }).code === 11000) throw new DomainError('Experiment key already exists', 'CONFLICT', 409); throw e; }
      await audit(ctx, req.actor, { action: 'events.experiment.created', resource: 'experiment', resourceId: body.key });
      return reply.status(201).send({ key: body.key });
    },
  });
  for (const [verb, from, to] of [['start', ['draft'], 'running'], ['stop', ['running'], 'stopped']] as const) {
    route(app, ctx, {
      method: 'POST', url: `/admin/campaigns/experiments/:key/${verb}`, summary: `${verb} an experiment (does not change the live site; a person ships any winner)`, tags: ['Admin'], auth: 'staff', permission: W,
      handler: async ({ req }) => {
        const e = await EventsExperiment.findOneAndUpdate({ key: keyOf(req), status: { $in: [...from] } }, { $set: { status: to, ...(to === 'running' ? { startedAt: ctx.now() } : { stoppedAt: ctx.now() }) } }, { new: true });
        if (!e) throw new DomainError(`Experiment cannot be ${verb}ed from its current state`, 'CONFLICT', 409);
        await audit(ctx, req.actor, { action: `events.experiment.${verb}`, resource: 'experiment', resourceId: e.key });
        return { status: e.status };
      },
    });
  }
  route(app, ctx, { method: 'GET', url: '/admin/campaigns/experiments/:key/results', summary: 'Experiment results with plain-language significance', tags: ['Admin'], auth: 'staff', permission: R, handler: ({ req }) => experimentResults(keyOf(req)) });

  /* ----------------------------- admin: reports ----------------------------- */
  const days = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });
  route(app, ctx, { method: 'GET', url: '/admin/campaigns/attribution', summary: 'Channel attribution (first/last touch) with contribution-based guidance', tags: ['Admin'], auth: 'staff', permission: R, query: days.extend({ model: z.enum(['last', 'first']).default('last') }), handler: ({ query }) => attributionReport(ctx, query.days, query.model) });
  route(app, ctx, { method: 'GET', url: '/admin/campaigns/products', summary: 'Product performance: views to carts to orders to net sales', tags: ['Admin'], auth: 'staff', permission: R, query: days, handler: ({ query }) => campaignProductPerformance(ctx, query.days) });
  route(app, ctx, {
    method: 'GET', url: '/admin/campaigns/lifecycle', summary: 'Abandoned-cart lifecycle (existing consent-based sequence)', tags: ['Admin'], auth: 'staff', permission: R,
    handler: async () => {
      const [stages, withEmail, converted] = await Promise.all([
        Cart.aggregate<{ _id: number; n: number }>([{ $match: { 'items.0': { $exists: true }, marketingConsent: true, email: { $exists: true } } }, { $group: { _id: '$abandonment.stage', n: { $sum: 1 } } }]),
        Cart.countDocuments({ 'items.0': { $exists: true }, email: { $exists: true } }), Cart.countDocuments({ convertedOrderId: { $exists: true } }),
      ]);
      return { consentedCartsByStage: stages.map((s) => ({ stage: s._id ?? 0, carts: s.n })), cartsWithEmail: withEmail, convertedCarts: converted, note: 'Recovery messages only go to shoppers who opted in; the sequence stops on purchase.' };
    },
  });
  route(app, ctx, {
    method: 'GET', url: '/admin/campaigns/feeds', summary: 'Feed eligibility per country', tags: ['Admin'], auth: 'staff', permission: R,
    handler: async () => ({ states: SELLABLE_STATES, countries: await Promise.all((['US', 'CA', 'IN'] as const).map(async (c) => { const f = await loadFeed(ctx, countrySchema.parse(c)); return { country: c, listed: f.items.length, excluded: f.excluded, google: `/api/v1/feeds/google/${c}.xml`, meta: `/api/v1/feeds/meta/${c}.csv` }; })) }),
  });
}
