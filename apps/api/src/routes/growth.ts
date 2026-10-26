import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { claimReferral, getOrCreateCart, listNeeds, productsForNeed, referralSummary } from '@orvia/core';
import { paginationSchema } from '@orvia/types';
import type { Ctx } from '@orvia/core';
import { route } from '../http';
import { CART_COOKIE } from '../plugins';

/** Growth surfaces: shop-by-need discovery and the referral (invite-a-friend) loop. */
export function growthRoutes(app: FastifyInstance, ctx: Ctx): void {
  route(app, ctx, {
    method: 'GET', url: '/needs', summary: 'Shop-by-need collections that currently have products', tags: ['Storefront'],
    handler: async ({ req }) => ({ needs: await listNeeds(req.country) }),
  });

  route(app, ctx, {
    method: 'GET', url: '/needs/:slug', summary: 'Products for one need', tags: ['Storefront'], query: paginationSchema,
    handler: async ({ req, query }) => productsForNeed((req.params as { slug: string }).slug, req.country, query.page, query.pageSize),
  });

  route(app, ctx, {
    method: 'GET', url: '/account/referrals', summary: 'My referral code, link and rewards', tags: ['Account'], auth: 'user',
    handler: async ({ user }) => referralSummary(ctx, user),
  });

  route(app, ctx, {
    method: 'POST', url: '/referrals/claim', summary: 'Attach a friend’s referral code to the current cart', tags: ['Cart'],
    rateLimit: { max: 30, timeWindow: '1 minute' }, body: z.object({ code: z.string().trim().min(4).max(40) }),
    handler: async ({ req, reply, body }) => {
      const cart = await getOrCreateCart(req.cookies[CART_COOKIE], req.user?.id, req.country);
      if (cart.token !== req.cookies[CART_COOKIE]) reply.setCookie(CART_COOKIE, cart.token, { path: '/', httpOnly: true, sameSite: 'lax', secure: ctx.cfg.COOKIE_SECURE, maxAge: 60 * 60 * 24 * 30 });
      return claimReferral(ctx, cart.token, body.code);
    },
  });
}
