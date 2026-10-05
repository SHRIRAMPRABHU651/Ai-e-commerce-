import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AddressModel, Order, Product, ReturnRequest, Shipment, SupportTicket, User, Wishlist } from '@orvia/database';
import {
  addToCart, applyCoupon, cancelOrder, createOrderFromCart, createReview, DomainError, getCountry, getOrCreateCart, handlePaymentWebhook, handleSupport,
  isSellable, notFound, priceCart, requestReturn, setCartContact, setCartQuantity, toStoreProduct, voteHelpful,
} from '@orvia/core';
import { addressSchema, cartItemInput, checkoutSchema, objectId, paginationSchema, reviewSchema, returnRequestSchema, countrySchema } from '@orvia/types';
import type { Ctx } from '@orvia/core';
import { route } from '../http';
import { CART_COOKIE } from '../plugins';

async function orderView(ctx: Ctx, o: InstanceType<typeof Order>) {
  const ships = await Shipment.find({ orderId: o._id }).select('status carrier trackingNumber trackingUrl estimatedDelivery events lineKey').lean();
  const rets = await ReturnRequest.find({ orderId: o._id }).select('status reason createdAt itemSkus').lean();
  const cfg = await getCountry(o.country).catch(() => null);
  const notShipped = !ships.some((s) => ['SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'].includes(s.status));
  return {
    id: String(o._id), orderNumber: o.orderNumber, status: o.status, createdAt: (o as unknown as { createdAt: Date }).createdAt, country: o.country, currency: o.currency, email: o.email,
    items: o.items.map((i) => ({ productId: String(i.productId), sku: i.sku, title: i.title, image: i.image, quantity: i.quantity, unitPrice: i.unitPrice })),
    amounts: o.amounts, address: o.address, shippingMethod: o.shippingMethod, couponCode: o.couponCode,
    payment: { status: o.payment?.status, provider: o.payment?.provider },
    timeline: o.timeline.map((t) => ({ status: t.status, at: t.at, note: ['system', 'webhook'].includes(t.actor ?? '') ? t.note : undefined })),
    shipments: ships.map((s) => ({ status: s.status, carrier: s.carrier, trackingNumber: s.trackingNumber, trackingUrl: s.trackingUrl, estimatedDelivery: s.estimatedDelivery, events: s.events })),
    returns: rets,
    canCancel: notShipped && ['PENDING_PAYMENT', 'PAID', 'SUPPLIER_PROCESSING', 'EXCEPTION'].includes(o.status),
    canReturn: !!o.deliveredAt && !!cfg && Date.now() - o.deliveredAt.getTime() < cfg.returnWindowDays * 86_400_000 && rets.every((r) => ['rejected', 'refunded'].includes(r.status)),
    returnWindowDays: cfg?.returnWindowDays,
  };
}

const owns = (req: FastifyRequest, o: { userId?: unknown; email: string }, email?: string) =>
  (req.user && (String(o.userId) === req.user.id || o.email === req.user.email)) || (!!email && o.email.toLowerCase() === email.toLowerCase());

export function shopRoutes(app: FastifyInstance, ctx: Ctx): void {
  const issued = new WeakMap<FastifyRequest, string>();
  const cartToken = (req: FastifyRequest) => issued.get(req) ?? req.cookies[CART_COOKIE];
  const ensureCart = async (req: FastifyRequest, reply: import('fastify').FastifyReply) => {
    const cart = await getOrCreateCart(cartToken(req), req.user?.id, req.country);
    issued.set(req, cart.token);
    if (cart.token !== req.cookies[CART_COOKIE]) reply.setCookie(CART_COOKIE, cart.token, { path: '/', httpOnly: true, sameSite: 'lax', secure: ctx.cfg.COOKIE_SECURE, maxAge: 60 * 60 * 24 * 30 });
    if (cart.country !== req.country) {
      // country switched: re-home the cart so prices are re-evaluated for the new market
      cart.country = req.country;
      await cart.save();
    }
    return cart.token;
  };
  const view = async (req: FastifyRequest, reply: import('fastify').FastifyReply, region?: string, shippingMethod?: string) => priceCart(ctx, await ensureCart(req, reply), { region, shippingMethod, email: req.user?.email });

  route(app, ctx, { method: 'GET', url: '/cart', summary: 'Get priced cart', tags: ['Cart'], query: z.object({ region: z.string().max(10).optional(), shipping: z.string().max(20).optional() }), handler: async ({ req, reply, query }) => view(req, reply, query.region, query.shipping) });
  route(app, ctx, {
    method: 'POST', url: '/cart/items', summary: 'Add to cart', tags: ['Cart'], body: cartItemInput,
    handler: async ({ req, reply, body }) => {
      const t = await ensureCart(req, reply);
      await addToCart(ctx, t, body);
      return view(req, reply);
    },
  });
  route(app, ctx, {
    method: 'PATCH', url: '/cart/items', summary: 'Change quantity (0 removes)', tags: ['Cart'], body: z.object({ productId: objectId, sku: z.string().max(80), quantity: z.number().int().min(0).max(10) }),
    handler: async ({ req, reply, body }) => {
      await setCartQuantity(ctx, await ensureCart(req, reply), body.productId, body.sku, body.quantity);
      return view(req, reply);
    },
  });
  route(app, ctx, {
    method: 'POST', url: '/cart/coupon', summary: 'Apply or remove a coupon', tags: ['Cart'], body: z.object({ code: z.string().trim().max(40).nullable() }),
    handler: async ({ req, reply, body }) => {
      await applyCoupon(ctx, await ensureCart(req, reply), body.code);
      return view(req, reply);
    },
  });
  route(app, ctx, {
    method: 'POST', url: '/cart/contact', summary: 'Attach email + marketing consent to the cart', tags: ['Cart'], body: z.object({ email: z.string().email().max(254), marketingConsent: z.boolean().default(false) }),
    handler: async ({ req, reply, body }) => {
      await setCartContact(ctx, await ensureCart(req, reply), body.email.toLowerCase(), body.marketingConsent);
      return { ok: true };
    },
  });

  route(app, ctx, {
    method: 'POST', url: '/checkout', summary: 'Create order + payment from cart (idempotent)', tags: ['Checkout'], body: checkoutSchema, rateLimit: { max: 20, timeWindow: '1 minute' },
    handler: async ({ req, reply, body }) => {
      const token = cartToken(req);
      if (!token) throw new DomainError('Your cart is empty', 'EMPTY_CART', 422);
      const r = await createOrderFromCart(ctx, { cartToken: token, userId: req.user?.id, ip: req.ip, ipCountry: req.ipCountry, actor: req.actor }, body);
      return reply.status(r.reused ? 200 : 201).send(r);
    },
  });

  route(app, ctx, {
    method: 'POST', url: '/webhooks/payments/:provider', summary: 'Payment provider webhook (signature verified)', tags: ['Webhooks'],
    handler: async ({ req, reply }) => {
      const provider = (req.params as { provider: string }).provider;
      if (!['stripe', 'razorpay', 'mock'].includes(provider)) throw notFound('Provider');
      const outcome = await handlePaymentWebhook(ctx, provider, req.rawBody ?? '', req.headers);
      return reply.status(200).send({ received: true, outcome });
    },
  });

  route(app, ctx, {
    method: 'GET', url: '/orders/lookup', summary: 'Guest order lookup (order number + email) or signed-in owner', tags: ['Orders'], query: z.object({ orderNumber: z.string().max(40), email: z.string().email().max(254).optional() }),
    rateLimit: { max: 20, timeWindow: '1 minute' },
    handler: async ({ req, query }) => {
      const o = await Order.findOne({ orderNumber: query.orderNumber.toUpperCase() });
      if (!o || !owns(req, o, query.email)) throw new DomainError('We could not find that order', 'NOT_FOUND', 404);
      return orderView(ctx, o);
    },
  });
  route(app, ctx, {
    method: 'POST', url: '/orders/:orderNumber/cancel', summary: 'Cancel an unshipped order', tags: ['Orders'], body: z.object({ email: z.string().email().optional(), reason: z.string().max(300).default('Customer request') }),
    handler: async ({ req, body }) => {
      const o = await Order.findOne({ orderNumber: (req.params as { orderNumber: string }).orderNumber.toUpperCase() });
      if (!o || !owns(req, o, body.email)) throw new DomainError('We could not find that order', 'NOT_FOUND', 404);
      await cancelOrder(ctx, String(o._id), req.actor, body.reason);
      return orderView(ctx, (await Order.findById(o._id))!);
    },
  });

  // ---- account
  route(app, ctx, {
    method: 'GET', url: '/account/orders', summary: 'My orders', tags: ['Account'], auth: 'user', query: paginationSchema,
    handler: async ({ user, query }) => {
      const q = { $or: [{ userId: user.id }, { email: user.email }] };
      const [items, total] = await Promise.all([Order.find(q).sort({ createdAt: -1 }).skip((query.page - 1) * query.pageSize).limit(query.pageSize).select('orderNumber status amounts currency country items createdAt payment.status').lean(), Order.countDocuments(q)]);
      return { items: items.map((o) => ({ orderNumber: o.orderNumber, status: o.status, total: o.amounts?.total, currency: o.currency, country: o.country, createdAt: (o as unknown as { createdAt: Date }).createdAt, itemCount: o.items.length, firstItem: o.items[0] ? { title: o.items[0].title, image: o.items[0].image } : null, paymentStatus: o.payment?.status })), total, page: query.page, pageSize: query.pageSize };
    },
  });
  route(app, ctx, {
    method: 'GET', url: '/account/addresses', summary: 'My saved addresses', tags: ['Account'], auth: 'user',
    handler: async ({ user }) => ({ items: await AddressModel.find({ userId: user.id }).sort({ isDefault: -1 }).limit(20).lean() }),
  });
  route(app, ctx, {
    method: 'POST', url: '/account/addresses', summary: 'Save an address', tags: ['Account'], auth: 'user', body: addressSchema.extend({ isDefault: z.boolean().default(false) }),
    handler: async ({ user, body, reply }) => {
      if ((await AddressModel.countDocuments({ userId: user.id })) >= 10) throw new DomainError('Address limit reached', 'LIMIT', 409);
      if (body.isDefault) await AddressModel.updateMany({ userId: user.id }, { $set: { isDefault: false } });
      return reply.status(201).send(await AddressModel.create({ ...body, userId: user.id }));
    },
  });
  route(app, ctx, {
    method: 'DELETE', url: '/account/addresses/:id', summary: 'Delete address', tags: ['Account'], auth: 'user',
    handler: async ({ req, user }) => (await AddressModel.deleteOne({ _id: (req.params as { id: string }).id, userId: user.id }), { ok: true }),
  });
  route(app, ctx, {
    method: 'PATCH', url: '/account/profile', summary: 'Update profile', tags: ['Account'], auth: 'user', body: z.object({ name: z.string().trim().min(1).max(80) }),
    handler: async ({ user, body }) => (await User.updateOne({ _id: user.id }, { $set: { name: body.name } }), { ok: true }),
  });

  route(app, ctx, {
    method: 'GET', url: '/account/wishlist', summary: 'My wishlist', tags: ['Account'], auth: 'user',
    handler: async ({ req, user }) => {
      const w = await Wishlist.findOne({ userId: user.id }).lean();
      const items = await Product.find({ _id: { $in: w?.productIds ?? [] } }).lean();
      return { items: items.filter((p) => isSellable(p.state)).map((p) => toStoreProduct(p, req.country)) };
    },
  });
  route(app, ctx, {
    method: 'POST', url: '/account/wishlist', summary: 'Add to wishlist', tags: ['Account'], auth: 'user', body: z.object({ productId: objectId }),
    handler: async ({ user, body }) => (await Wishlist.updateOne({ userId: user.id }, { $addToSet: { productIds: body.productId } }, { upsert: true }), { ok: true }),
  });
  route(app, ctx, {
    method: 'DELETE', url: '/account/wishlist/:productId', summary: 'Remove from wishlist', tags: ['Account'], auth: 'user',
    handler: async ({ req, user }) => (await Wishlist.updateOne({ userId: user.id }, { $pull: { productIds: (req.params as { productId: string }).productId } }), { ok: true }),
  });
  route(app, ctx, {
    method: 'GET', url: '/account/wishlist/ids', summary: 'My wishlist ids (for heart state)', tags: ['Account'], auth: 'optional',
    handler: async ({ req }) => ({ ids: req.user ? ((await Wishlist.findOne({ userId: req.user.id }).lean())?.productIds ?? []).map(String) : [] }),
  });

  route(app, ctx, {
    method: 'GET', url: '/account/returns', summary: 'My return requests', tags: ['Returns'], auth: 'user',
    handler: async ({ user }) => ({ items: await ReturnRequest.find({ $or: [{ userId: user.id }, { email: user.email }] }).sort({ createdAt: -1 }).limit(50).lean() }),
  });
  route(app, ctx, {
    method: 'POST', url: '/returns', summary: 'Request a return', tags: ['Returns'], auth: 'user', body: returnRequestSchema,
    handler: async ({ req, user, body, reply }) => reply.status(201).send(await requestReturn(ctx, body, { userId: user.id, email: user.email, actor: req.actor })),
  });

  route(app, ctx, {
    method: 'POST', url: '/products/:productId/reviews', summary: 'Write a review', tags: ['Reviews'], auth: 'user', body: reviewSchema,
    handler: async ({ req, user, body, reply }) => reply.status(201).send(await createReview(ctx, user.id, user.name, (req.params as { productId: string }).productId, body)),
  });
  route(app, ctx, {
    method: 'POST', url: '/reviews/:id/helpful', summary: 'Mark a review helpful', tags: ['Reviews'], auth: 'user',
    handler: async ({ req, user }) => ({ helpfulVotes: await voteHelpful((req.params as { id: string }).id, user.id) }),
  });

  route(app, ctx, {
    method: 'POST', url: '/support/chat', summary: 'AI support assistant (grounded in orders, shipments and products)', tags: ['Support'], rateLimit: { max: 30, timeWindow: '1 minute' },
    body: z.object({ message: z.string().trim().min(1).max(1000), email: z.string().email().optional(), orderNumber: z.string().max(40).optional(), ticketId: objectId.optional(), confirmCancel: z.boolean().optional(), country: countrySchema.optional() }),
    handler: async ({ req, body }) => handleSupport(ctx, { message: body.message, country: body.country ?? req.country, email: req.user?.email ?? body.email, userId: req.user?.id, orderNumber: body.orderNumber, ticketId: body.ticketId, confirmCancel: body.confirmCancel }),
  });
  route(app, ctx, {
    method: 'GET', url: '/support/tickets', summary: 'My support tickets', tags: ['Support'], auth: 'user',
    handler: async ({ user }) => ({ items: await SupportTicket.find({ $or: [{ userId: user.id }, { email: user.email }] }).sort({ updatedAt: -1 }).limit(30).select('subject status updatedAt messages').lean() }),
  });
}
