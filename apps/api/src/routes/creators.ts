import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CollectionComment, CreatorLink, CreatorProfile, ReferralCode } from '@orvia/database';
import {
  addAdjustment, addComment, adjustLoyalty, adminCreatorsTable, adminListPayouts, adminLoyaltyAccounts, applyToBeCreator, approvePayout, captureAttribution, clickCount, creatorBalances, createCollection, createLink,
  deactivateLink, deleteCollection, getLoyaltyRules, getLoyaltyStatus, getOrCreateCart, getProfileByUser, getRules, holdCreatorPayouts, listCommissions, listFlags, listLinks, listLoyaltyActivity, listMyCollections,
  listMyPayouts, markPayoutPaid, moderateComment, moderationQueue, payoutStatement, performanceFor, privateView, publicCollection, publicComments, publicCreator, recordChargeback, redeemPoints, referralOverview,
  rejectPayout, reportComment, requestPayout, requireApprovedCreator, resolveFlag, reviewApplication, setAvatar, setCreatorStatus, setRules, updateCollection, updateCreatorTerms, updateProfile, DomainError, ImageRejected, notFound,
} from '@orvia/core';
import type { Ctx } from '@orvia/core';
import { attributionCaptureSchema, collectionInputSchema, collectionPatchSchema, commentInputSchema, creatorApplySchema, creatorProfileSchema, linkInputSchema, objectId, paginationSchema, payoutRequestSchema, redeemInputSchema, reportInputSchema } from '@orvia/types';
import { route } from '../http';
import { CART_COOKIE } from '../plugins';

const idParam = (req: { params: unknown }, k = 'id') => (req.params as Record<string, string>)[k]!;
const checkId = (v: string) => { if (!objectId.safeParse(v).success) throw new DomainError('Not found', 'NOT_FOUND', 404); return v; };
const staffPage = paginationSchema.extend({ status: z.string().max(30).optional(), q: z.string().trim().max(60).optional() });

/** creators workstream: public pages, attribution, creator portal, payouts, loyalty and staff review. */
export function creatorsRoutes(app: FastifyInstance, ctx: Ctx): void {
  /* ------------------------------ public ------------------------------ */
  route(app, ctx, {
    method: 'GET', url: '/creators/:handle', summary: 'Public creator page data', tags: ['Creators'], rateLimit: { max: 120, timeWindow: '1 minute' },
    handler: async ({ req }) => { const r = await publicCreator(idParam(req, 'handle'), req.country); if (!r) throw notFound('Creator'); return r; },
  });
  route(app, ctx, {
    method: 'GET', url: '/creators/:handle/collections/:slug', summary: 'Published creator collection with products and approved comments', tags: ['Creators'], rateLimit: { max: 120, timeWindow: '1 minute' },
    handler: async ({ req }) => {
      const r = await publicCollection(idParam(req, 'handle'), idParam(req, 'slug'), req.country);
      if (!r) throw notFound('Collection');
      return { ...r, comments: r.collection.discussionEnabled ? await publicComments(r.collection.id) : { total: 0, items: [] } };
    },
  });

  route(app, ctx, {
    method: 'POST', url: '/creators/attribution', summary: 'Record a creator landing (click) and attach first-party attribution to the cart', tags: ['Creators'], auth: 'optional',
    rateLimit: { max: 60, timeWindow: '1 minute' }, body: attributionCaptureSchema,
    handler: async ({ req, reply, body }) => {
      const cart = await getOrCreateCart(req.cookies[CART_COOKIE], req.user?.id, req.country);
      if (cart.token !== req.cookies[CART_COOKIE]) reply.setCookie(CART_COOKIE, cart.token, { path: '/', httpOnly: true, sameSite: 'lax', secure: ctx.cfg.COOKIE_SECURE, maxAge: 60 * 60 * 24 * 30 });
      await cart.save();
      const r = await captureAttribution(ctx, { ...body, cartToken: cart.token, userId: req.user?.id, ip: req.ip, userAgent: req.headers['user-agent'], acceptLanguage: req.headers['accept-language'] });
      return { recorded: r.recorded, attributed: r.attributed }; // never reveals why (no creator enumeration)
    },
  });

  route(app, ctx, {
    method: 'POST', url: '/creators/collections/:id/comments', summary: 'Comment on a published collection (moderated)', tags: ['Creators'], auth: 'user',
    rateLimit: { max: 10, timeWindow: '1 minute' }, body: commentInputSchema,
    handler: async ({ req, body, user }) => addComment(ctx, user, checkId(idParam(req)), body.body),
  });
  route(app, ctx, {
    method: 'POST', url: '/creators/comments/:id/report', summary: 'Report a comment', tags: ['Creators'], auth: 'user', rateLimit: { max: 20, timeWindow: '1 minute' }, body: reportInputSchema,
    handler: async ({ req, body, user }) => reportComment(ctx, user.id, checkId(idParam(req)), body.reason),
  });

  /* ------------------------------ creator portal (customer session) ------------------------------ */
  route(app, ctx, {
    method: 'GET', url: '/creator/me', summary: 'My creator profile (null when not applied)', tags: ['Creators'], auth: 'user',
    handler: async ({ user }) => { const p = await getProfileByUser(user.id); return { creator: p ? privateView(p) : null }; },
  });
  route(app, ctx, {
    method: 'POST', url: '/creator/apply', summary: 'Apply to become a creator', tags: ['Creators'], auth: 'user', rateLimit: { max: 5, timeWindow: '1 hour' }, body: creatorApplySchema,
    handler: async ({ reply, body, user }) => reply.status(201).send({ creator: await applyToBeCreator(ctx, user, body) }),
  });
  route(app, ctx, {
    method: 'PATCH', url: '/creator/profile', summary: 'Update my creator profile', tags: ['Creators'], auth: 'user', body: creatorProfileSchema,
    handler: async ({ body, user }) => ({ creator: await updateProfile(ctx, user.id, body) }),
  });
  route(app, ctx, {
    method: 'POST', url: '/creator/avatar', summary: 'Upload my avatar (multipart, field "file")', tags: ['Creators'], auth: 'user', rateLimit: { max: 10, timeWindow: '1 hour' },
    handler: async ({ req, user }) => {
      if (!req.isMultipart()) throw new DomainError('Send the image as multipart/form-data', 'VALIDATION', 415);
      let file: Buffer | undefined;
      try {
        for await (const part of req.parts()) {
          if (part.type !== 'file') continue;
          if (file) { part.file.resume(); continue; }
          if (!/^image\/(jpeg|png|webp|avif)$/i.test(part.mimetype)) throw new ImageRejected('Only JPEG, PNG, WebP or AVIF images are accepted', 'type');
          file = await part.toBuffer();
          if (part.file.truncated) throw new ImageRejected('Image is too large', 'size');
        }
      } catch (e) { if (e instanceof DomainError) throw e; throw new ImageRejected('Invalid upload', 'size'); }
      if (!file) throw new DomainError('No image file received', 'VALIDATION', 400);
      return setAvatar(ctx, user.id, file);
    },
  });
  route(app, ctx, {
    method: 'GET', url: '/creator/collections', summary: 'My collections', tags: ['Creators'], auth: 'user',
    handler: async ({ user }) => ({ items: await listMyCollections(String((await requireApprovedCreator(user.id))._id)) }),
  });
  route(app, ctx, {
    method: 'POST', url: '/creator/collections', summary: 'Create a collection', tags: ['Creators'], auth: 'user', body: collectionInputSchema,
    handler: async ({ reply, body, user }) => reply.status(201).send(await createCollection(ctx, await requireApprovedCreator(user.id), body)),
  });
  route(app, ctx, {
    method: 'PATCH', url: '/creator/collections/:id', summary: 'Edit, reorder, publish or unpublish a collection', tags: ['Creators'], auth: 'user', body: collectionPatchSchema,
    handler: async ({ req, body, user }) => updateCollection(ctx, await requireApprovedCreator(user.id), checkId(idParam(req)), body),
  });
  route(app, ctx, {
    method: 'DELETE', url: '/creator/collections/:id', summary: 'Delete a collection', tags: ['Creators'], auth: 'user',
    handler: async ({ req, user }) => { await deleteCollection(ctx, await requireApprovedCreator(user.id), checkId(idParam(req))); return { ok: true }; },
  });
  route(app, ctx, {
    method: 'GET', url: '/creator/links', summary: 'My share links', tags: ['Creators'], auth: 'user',
    handler: async ({ user }) => ({ items: await listLinks(ctx, await requireApprovedCreator(user.id)) }),
  });
  route(app, ctx, {
    method: 'POST', url: '/creator/links', summary: 'Create a trackable share link for a product or collection', tags: ['Creators'], auth: 'user', body: linkInputSchema,
    handler: async ({ reply, body, user }) => reply.status(201).send(await createLink(ctx, await requireApprovedCreator(user.id), body)),
  });
  route(app, ctx, {
    method: 'DELETE', url: '/creator/links/:id', summary: 'Remove a share link', tags: ['Creators'], auth: 'user',
    handler: async ({ req, user }) => { await deactivateLink(ctx, await requireApprovedCreator(user.id), checkId(idParam(req))); return { ok: true }; },
  });
  route(app, ctx, {
    method: 'GET', url: '/creator/performance', summary: 'My performance and balances', tags: ['Creators'], auth: 'user',
    handler: async ({ user }) => {
      const c = await requireApprovedCreator(user.id);
      const id = String(c._id);
      const [perf, balances, links, rules] = await Promise.all([performanceFor([id]), creatorBalances(id), CreatorLink.find({ creatorId: id, active: true }).sort({ clicks: -1 }).limit(5).select('label clicks').lean(), getRules()]);
      return { windowDays: 90, ...perf.get(id)!, balances, topLinks: links.map((l) => ({ label: l.label, clicks: l.clicks })), totalClicks: await clickCount(id), attributionDays: rules.attributionDays, payoutThreshold: rules.payoutThreshold };
    },
  });
  route(app, ctx, {
    method: 'GET', url: '/creator/commissions', summary: 'My commission ledger', tags: ['Creators'], auth: 'user', query: paginationSchema,
    handler: async ({ query, user }) => listCommissions(String((await requireApprovedCreator(user.id))._id), query.page, query.pageSize),
  });
  route(app, ctx, {
    method: 'GET', url: '/creator/payouts', summary: 'My payouts', tags: ['Creators'], auth: 'user',
    handler: async ({ user }) => ({ items: await listMyPayouts(String((await requireApprovedCreator(user.id))._id)) }),
  });
  route(app, ctx, {
    method: 'POST', url: '/creator/payouts', summary: 'Request a payout of my payable balance', tags: ['Creators'], auth: 'user', rateLimit: { max: 5, timeWindow: '1 hour' }, body: payoutRequestSchema,
    handler: async ({ reply, body, user }) => reply.status(201).send(await requestPayout(ctx, await requireApprovedCreator(user.id), body)),
  });
  route(app, ctx, {
    method: 'GET', url: '/creator/payouts/:id/statement', summary: 'Payout statement (json, csv or printable html)', tags: ['Creators'], auth: 'user', query: z.object({ format: z.enum(['json', 'csv', 'html']).default('json') }),
    handler: async ({ req, reply, query, user }) => {
      const c = await requireApprovedCreator(user.id);
      const s = await payoutStatement(String(c._id), checkId(idParam(req)), query.format);
      if (query.format === 'json') return s.statement;
      return reply.header('content-type', s.contentType).header('content-disposition', `${query.format === 'csv' ? 'attachment' : 'inline'}; filename="statement-${idParam(req)}.${query.format}"`).header('x-content-type-options', 'nosniff').header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'").send(s.body);
    },
  });

  /* ------------------------------ loyalty (customer) ------------------------------ */
  route(app, ctx, {
    method: 'GET', url: '/account/loyalty', summary: 'My loyalty points, tier and activity', tags: ['Account'], auth: 'user', query: paginationSchema,
    handler: async ({ query, user }) => {
      const [status, rules, activity] = await Promise.all([getLoyaltyStatus(ctx, user.id), getLoyaltyRules(), listLoyaltyActivity(user.id, query.page, Math.min(query.pageSize, 50))]);
      return { status, rules: { pointsPerUsd: rules.pointsPerUsd, pointsPerUsdValue: rules.pointsPerUsdValue, minRedeemPoints: rules.minRedeemPoints, maxRedeemPoints: rules.maxRedeemPoints, redemptionValidDays: rules.redemptionValidDays, pointsExpireDays: rules.pointsExpireDays, tiers: rules.tiers }, activity };
    },
  });
  route(app, ctx, {
    method: 'POST', url: '/account/loyalty/redeem', summary: 'Redeem points for a single-use discount code', tags: ['Account'], auth: 'user', rateLimit: { max: 10, timeWindow: '1 hour' }, body: redeemInputSchema,
    handler: async ({ reply, body, user }) => reply.status(201).send(await redeemPoints(ctx, user.id, body.points)),
  });

  /* ------------------------------ staff: creators ------------------------------ */
  route(app, ctx, {
    method: 'GET', url: '/admin/creators', summary: 'Creators with performance', tags: ['Admin'], auth: 'staff', permission: 'creators:read', query: staffPage,
    handler: async ({ query }) => adminCreatorsTable({ status: query.status, search: query.q, page: query.page, pageSize: query.pageSize }),
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/creators/:id/review', summary: 'Approve or reject an application', tags: ['Admin'], auth: 'staff', permission: 'creators:write', body: z.object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().max(300).optional() }),
    handler: async ({ req, body }) => { await reviewApplication(ctx, req.actor, checkId(idParam(req)), body.decision, body.note); return { ok: true }; },
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/creators/:id/status', summary: 'Suspend or reinstate a creator', tags: ['Admin'], auth: 'staff', permission: 'creators:write', body: z.object({ status: z.enum(['approved', 'suspended']), reason: z.string().trim().max(300).optional() }),
    handler: async ({ req, body }) => { await setCreatorStatus(ctx, req.actor, checkId(idParam(req)), body.status, body.reason); return { ok: true }; },
  });
  route(app, ctx, {
    method: 'PATCH', url: '/admin/creators/:id/terms', summary: 'Commission override and payout checklist (collected flags and opaque references only)', tags: ['Admin'], auth: 'staff', permission: 'creators:write',
    body: z.object({ rateOverride: z.number().min(0).max(0.5).nullable().optional(), kycStatus: z.enum(['not_started', 'collected', 'verified', 'rejected']).optional(), taxInfoCollected: z.boolean().optional(), kycReference: z.string().trim().max(80).optional(), taxInfoReference: z.string().trim().max(80).optional(), method: z.enum(['bank_transfer', 'upi', 'paypal', 'other']).optional() }),
    handler: async ({ req, body }) => { await updateCreatorTerms(ctx, req.actor, checkId(idParam(req)), body); return { ok: true }; },
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/creators/:id/hold', summary: 'Hold or release payouts for a creator', tags: ['Admin'], auth: 'staff', permission: 'creators:write', body: z.object({ held: z.boolean(), reason: z.string().trim().max(300).optional() }),
    handler: async ({ req, body }) => { await holdCreatorPayouts(ctx, req.actor, checkId(idParam(req)), body.held, body.reason); return { ok: true }; },
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/creators/:id/adjustments', summary: 'Manual ledger adjustment (audited)', tags: ['Admin'], auth: 'staff', permission: 'creators:write',
    body: z.object({ amount: z.number().int(), currency: z.enum(['USD', 'CAD', 'INR']), note: z.string().trim().min(5).max(200) }),
    handler: async ({ req, body }) => { await addAdjustment(ctx, req.actor, checkId(idParam(req)), body.amount, body.currency, body.note); return { ok: true }; },
  });
  route(app, ctx, {
    method: 'GET', url: '/admin/creators/rules', summary: 'Commission rules', tags: ['Admin'], auth: 'staff', permission: 'creators:read', handler: async () => ({ rules: await getRules() }),
  });
  route(app, ctx, {
    method: 'PUT', url: '/admin/creators/rules', summary: 'Update commission rules', tags: ['Admin'], auth: 'staff', permission: 'creators:write', body: z.record(z.string(), z.unknown()),
    handler: async ({ req, body }) => ({ rules: await setRules(ctx, req.actor, body, 'rules') }),
  });
  route(app, ctx, {
    method: 'GET', url: '/admin/creators/payouts', summary: 'Payout queue', tags: ['Admin'], auth: 'staff', permission: 'creators:read', query: staffPage,
    handler: async ({ query }) => adminListPayouts(query.status ?? 'requested', query.page, query.pageSize),
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/creators/payouts/:id/approve', summary: 'Approve a payout (checklist enforced)', tags: ['Admin'], auth: 'staff', permission: 'creators:write',
    handler: async ({ req }) => approvePayout(ctx, req.actor, checkId(idParam(req))),
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/creators/payouts/:id/reject', summary: 'Reject a payout and release its ledger rows', tags: ['Admin'], auth: 'staff', permission: 'creators:write', body: z.object({ reason: z.string().trim().min(3).max(300) }),
    handler: async ({ req, body }) => rejectPayout(ctx, req.actor, checkId(idParam(req)), body.reason),
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/creators/payouts/:id/paid', summary: 'Record that the transfer was executed manually', tags: ['Admin'], auth: 'staff', permission: 'creators:write',
    body: z.object({ method: z.enum(['bank_transfer', 'upi', 'paypal', 'other']), externalReference: z.string().trim().min(3).max(120) }),
    handler: async ({ req, body }) => markPayoutPaid(ctx, req.actor, checkId(idParam(req)), body),
  });
  route(app, ctx, {
    method: 'GET', url: '/admin/creators/flags', summary: 'Fraud review queue', tags: ['Admin'], auth: 'staff', permission: 'creators:read', query: staffPage,
    handler: async ({ query }) => listFlags(query.status ?? 'open', query.page, query.pageSize),
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/creators/flags/:id/resolve', summary: 'Clear or confirm a fraud flag (confirmed reverses the commission)', tags: ['Admin'], auth: 'staff', permission: 'creators:write', body: z.object({ resolution: z.enum(['cleared', 'confirmed']), note: z.string().trim().min(3).max(300) }),
    handler: async ({ req, body }) => { await resolveFlag(ctx, req.actor, checkId(idParam(req)), body.resolution, body.note); return { ok: true }; },
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/creators/orders/:id/chargeback', summary: 'Record a chargeback against an attributed order (claws back commission)', tags: ['Admin'], auth: 'staff', permission: 'creators:write', body: z.object({ note: z.string().trim().min(3).max(300) }),
    handler: async ({ req, body }) => recordChargeback(ctx, req.actor, checkId(idParam(req)), body.note),
  });
  route(app, ctx, {
    method: 'GET', url: '/admin/creators/referrals', summary: 'Referral programme overview (codes, rewards, rejections with reasons)', tags: ['Admin'], auth: 'staff', permission: 'creators:read', query: staffPage,
    handler: async ({ query }) => referralOverview(query.page, query.pageSize, query.status === 'rewarded' || query.status === 'rejected' ? query.status : undefined),
  });
  route(app, ctx, {
    method: 'GET', url: '/admin/creators/comments', summary: 'Comment moderation queue', tags: ['Admin'], auth: 'staff', permission: 'creators:read', query: staffPage,
    handler: async ({ query }) => moderationQueue(query.status ?? 'pending', query.page, query.pageSize),
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/creators/comments/:id/moderate', summary: 'Publish, reject or remove a comment', tags: ['Admin'], auth: 'staff', permission: 'creators:write', body: z.object({ decision: z.enum(['published', 'rejected', 'removed']) }),
    handler: async ({ req, body }) => moderateComment(ctx, req.actor, checkId(idParam(req)), body.decision),
  });
  route(app, ctx, {
    method: 'GET', url: '/admin/creators/overview', summary: 'Counts for the admin page', tags: ['Admin'], auth: 'staff', permission: 'creators:read',
    handler: async () => {
      const [pending, approved, flags, payouts, comments, codes] = await Promise.all([
        CreatorProfile.countDocuments({ status: 'pending' }), CreatorProfile.countDocuments({ status: 'approved' }), (await import('@orvia/database')).CreatorFlag.countDocuments({ status: 'open' }),
        (await import('@orvia/database')).CreatorPayout.countDocuments({ status: { $in: ['requested', 'approved'] } }), CollectionComment.countDocuments({ status: 'pending' }), ReferralCode.countDocuments({}),
      ]);
      return { pendingApplications: pending, approvedCreators: approved, openFlags: flags, openPayouts: payouts, pendingComments: comments, referralCodes: codes };
    },
  });

  /* ------------------------------ staff: loyalty ------------------------------ */
  route(app, ctx, {
    method: 'GET', url: '/admin/loyalty/accounts', summary: 'Loyalty balances', tags: ['Admin'], auth: 'staff', permission: 'loyalty:read', query: staffPage,
    handler: async ({ query }) => adminLoyaltyAccounts({ search: query.q, page: query.page, pageSize: query.pageSize }),
  });
  route(app, ctx, {
    method: 'GET', url: '/admin/loyalty/rules', summary: 'Loyalty rules', tags: ['Admin'], auth: 'staff', permission: 'loyalty:read', handler: async () => ({ rules: await getLoyaltyRules() }),
  });
  route(app, ctx, {
    method: 'PUT', url: '/admin/loyalty/rules', summary: 'Update loyalty rules', tags: ['Admin'], auth: 'staff', permission: 'loyalty:write', body: z.record(z.string(), z.unknown()),
    handler: async ({ req, body }) => ({ rules: await setRules(ctx, req.actor, body, 'loyalty') }),
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/loyalty/adjust', summary: 'Audited manual points adjustment', tags: ['Admin'], auth: 'staff', permission: 'loyalty:write',
    body: z.object({ userId: objectId, points: z.number().int().min(-100_000).max(100_000), reason: z.string().trim().min(5).max(200) }),
    handler: async ({ req, body }) => adjustLoyalty(ctx, req.actor, body.userId, body.points, body.reason),
  });
}
