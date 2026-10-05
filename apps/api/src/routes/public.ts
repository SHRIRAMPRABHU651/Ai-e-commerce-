import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Category, Product, ProductVariant, SupplierOffer } from '@orvia/database';
import {
  bestSellers, countryTrending, deals, frequentlyBoughtTogether, getCountry, getCountryConfigs, listReviews, newArrivals, recentlyViewed, recommendedForYou,
  searchProducts, similar, suggest, toStoreProduct, trackEvent, trending, DomainError, isSellable,
} from '@orvia/core';
import { estimateDelivery } from '@orvia/shipping';
import { countrySchema, objectId, paginationSchema, searchQuerySchema, slugify, CATEGORY_TREE } from '@orvia/types';
import type { Ctx } from '@orvia/core';
import { route } from '../http';
import { COUNTRY_COOKIE } from '../plugins';

export function publicRoutes(app: FastifyInstance, ctx: Ctx): void {
  route(app, ctx, {
    method: 'GET', url: '/meta', summary: 'Storefront bootstrap: countries, categories, payment mode', tags: ['Storefront'],
    handler: async ({ req }) => {
      const configs = Object.values(await getCountryConfigs()).filter((c) => c.enabled);
      const cats = await Category.find({}).sort({ position: 1 }).select('slug name parentSlug dynamic').limit(200).lean();
      return {
        detectedCountry: req.country,
        countries: configs.map((c) => ({ code: c.code, name: c.name, currency: c.currency, locale: c.locale, taxInclusive: c.taxInclusive, shippingMethods: c.shippingMethods, paymentMethods: c.paymentMethods, legalNotice: c.legalNotice, returnWindowDays: c.returnWindowDays })),
        categories: CATEGORY_TREE.map((t) => ({ slug: t.slug, name: t.name, dynamic: 'dynamic' in t ? !!t.dynamic : false, children: cats.filter((c) => c.parentSlug === t.slug).map((c) => ({ slug: c.slug, name: c.name })) })),
        payment: { mode: ctx.cfg.PAYMENT_MODE, stripePublishableKey: ctx.cfg.STRIPE_PUBLISHABLE_KEY ?? null },
        environment: ctx.cfg.APP_ENV,
      };
    },
  });

  route(app, ctx, {
    method: 'PUT', url: '/preferences/country', summary: 'Set preferred country (cookie)', tags: ['Storefront'], body: z.object({ country: countrySchema }),
    handler: async ({ body, reply }) => {
      await getCountry(body.country);
      reply.setCookie(COUNTRY_COOKIE, body.country, { path: '/', sameSite: 'lax', secure: ctx.cfg.COOKIE_SECURE, maxAge: 60 * 60 * 24 * 365 });
      return { country: body.country };
    },
  });

  route(app, ctx, {
    method: 'GET', url: '/home', summary: 'Homepage sections for the current country', tags: ['Storefront'], query: z.object({ viewed: z.string().max(400).optional() }),
    handler: async ({ req, query }) => {
      const c = req.country;
      const viewed = (query.viewed ?? '').split(',').filter((i) => /^[a-f\d]{24}$/i.test(i)).slice(0, 12);
      const [trendingNow, forYou, dealsList, fresh, best, local, recents] = await Promise.all([
        trending(c, 8), recommendedForYou({ country: c, userId: req.user?.id, viewedIds: viewed }, 8), deals(c, 8), newArrivals(c, 8), bestSellers(c, 8), countryTrending(c, 8), recentlyViewed(viewed, c),
      ]);
      const cats = await Product.aggregate<{ _id: string; n: number }>([{ $match: { state: { $in: ['PUBLISHED', 'TESTING', 'WINNER', 'SCALING', 'DECLINING'] }, 'markets.country': c } }, { $group: { _id: '$topCategory', n: { $sum: 1 } } }]);
      const cfg = await getCountry(c);
      return {
        country: c, currency: cfg.currency, trending: trendingNow, recommended: forYou, deals: dealsList, newArrivals: fresh, bestSellers: best, countryTrending: local, recentlyViewed: recents,
        categories: CATEGORY_TREE.filter((t) => !('dynamic' in t && t.dynamic)).map((t) => ({ slug: t.slug, name: t.name, count: cats.find((x) => x._id === t.slug)?.n ?? 0 })),
      };
    },
  });

  route(app, ctx, {
    method: 'GET', url: '/products', summary: 'Search / browse products', tags: ['Storefront'], query: searchQuerySchema,
    handler: async ({ req, query }) => searchProducts(query, query.country ?? req.country),
  });

  route(app, ctx, {
    method: 'GET', url: '/search/suggest', summary: 'Search suggestions (typo tolerant)', tags: ['Storefront'], query: z.object({ q: z.string().trim().min(1).max(60) }),
    rateLimit: { max: 120, timeWindow: '1 minute' },
    handler: async ({ req, query }) => ({ suggestions: await suggest(query.q, req.country) }),
  });

  route(app, ctx, {
    method: 'GET', url: '/products/:slug', summary: 'Product detail', tags: ['Storefront'], query: z.object({ viewed: z.string().max(400).optional() }),
    handler: async ({ req }) => {
      const slug = (req.params as { slug: string }).slug;
      const p = await Product.findOne({ slug }).lean();
      if (!p || !isSellable(p.state)) throw new DomainError('Product not found', 'NOT_FOUND', 404);
      const country = req.country;
      const cfg = await getCountry(country);
      const sp = toStoreProduct(p, country, cfg.returnWindowDays);
      const variants = await ProductVariant.find({ productId: p._id, active: true }).select('sku label options image priceDelta').limit(60).lean();
      const m = p.markets.find((x) => x.country === country && x.enabled);
      const delivery = m?.minDays && m.maxDays ? estimateDelivery(m.minDays, m.maxDays, cfg.locale) : null;
      const availableIn = p.markets.filter((x) => x.enabled && x.price > 0 && x.stock > 0).map((x) => x.country);
      const [reviews, sim, fbt] = await Promise.all([listReviews(String(p._id), 1, 5), similar(String(p._id), country, 8), frequentlyBoughtTogether(String(p._id), country, 4)]);
      const top = (CATEGORY_TREE.find((t) => t.slug === p.topCategory)) ?? null;
      void SupplierOffer;
      return {
        product: sp, variants: variants.map((v) => ({ sku: v.sku, label: v.label ?? 'Default', options: v.options ?? {}, image: v.image })),
        delivery, shipsFrom: m?.shipsFrom ?? null, availableIn, paymentMethods: cfg.paymentMethods, legalNotice: cfg.legalNotice,
        shipping: cfg.shippingMethods.map((s) => ({ code: s.code, label: s.label, fee: s.fee, freeOver: s.freeOver })),
        reviews, similar: sim, frequentlyBoughtTogether: fbt,
        breadcrumbs: [{ label: 'Home', href: '/' }, ...(top ? [{ label: top.name, href: `/c/${top.slug}` }] : []), ...(p.category && p.category !== p.topCategory ? [{ label: p.category.replace(/-/g, ' '), href: `/c/${p.category}` }] : []), { label: p.title, href: `/p/${p.slug}` }],
        slugCategory: slugify(p.category ?? ''),
      };
    },
  });

  route(app, ctx, {
    method: 'GET', url: '/products/:slug/reviews', summary: 'Product reviews', tags: ['Storefront'], query: paginationSchema,
    handler: async ({ req, query }) => {
      const p = await Product.findOne({ slug: (req.params as { slug: string }).slug }).select('_id').lean();
      if (!p) throw new DomainError('Product not found', 'NOT_FOUND', 404);
      return listReviews(String(p._id), query.page, Math.min(query.pageSize, 20));
    },
  });

  route(app, ctx, {
    method: 'GET', url: '/recommendations/recently-viewed', summary: 'Recently viewed products by id', tags: ['Storefront'], query: z.object({ ids: z.string().max(400) }),
    handler: async ({ req, query }) => ({ items: await recentlyViewed(query.ids.split(',').filter((i) => objectId.safeParse(i).success).slice(0, 12), req.country) }),
  });

  route(app, ctx, {
    method: 'POST', url: '/events', summary: 'Track storefront event', tags: ['Storefront'], rateLimit: { max: 240, timeWindow: '1 minute' },
    body: z.object({ type: z.enum(['page_view', 'product_view', 'add_to_cart', 'checkout_start', 'search']), sessionId: z.string().min(8).max(64), productId: objectId.optional(), category: z.string().max(80).optional(), meta: z.record(z.union([z.string().max(100), z.number()])).optional() }),
    handler: async ({ req, body, reply }) => {
      await trackEvent(ctx, { ...body, country: req.country, userId: req.user?.id });
      return reply.status(202).send({ ok: true });
    },
  });
}
