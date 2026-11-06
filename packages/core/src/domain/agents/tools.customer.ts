/**
 * Customer-facing tools. Every identity-dependent tool binds the user from `AuthContext` (the authenticated session),
 * checks ownership in the query, and returns the same "not found" answer for missing and foreign orders (no oracle).
 * `write_guarded` tools call existing deterministic domain functions that carry their own eligibility/limits; this layer
 * adds the explicit customer confirmation and nothing else. No tool here can approve, issue or execute a refund.
 */
import { z } from 'zod';
import { AgentsEscalation, AgentsReplacementRequest, AftersalesReturn, Order, RescueCase, Shipment } from '@orvia/database';
import type { CountryCode } from '@orvia/types';
import { MEMORY_KINDS, RETURN_REASON_CODES, ITEM_CONDITIONS, RESOLUTION_TYPES, countrySchema } from '@orvia/types';
import { DomainError } from '../../infra/context';
import type { Ctx } from '../../infra/context';
import { getProductPassport, getPurchaseConfidence } from '../trust';
import { runCompare, runFind, createPriceAlert } from '../find';
import { computeRefund, getEligibility, loadPolicy, orderAftersales, startReturn } from '../aftersales';
import { recoveryView } from '../rescue';
import { saveMemoryItem } from '../customer360';
import { recommendResolution, PROBLEMS } from './advocate';
import type { AdvocateFacts } from './advocate';
import type { AnyTool, AuthContext } from './framework';
import { redact } from './injection';

export interface AgentIO { ctx: Ctx }

const objectId = z.string().regex(/^[a-f\d]{24}$/i);
const orderNumber = z.string().trim().min(3).max(40).regex(/^[A-Za-z0-9-]+$/);
const strict = <T extends z.ZodRawShape>(s: T) => z.strictObject(s);
const ALL: ('guest' | 'customer')[] = ['guest', 'customer'];
const NOT_FOUND = { found: false as const };

const country = (auth: AuthContext): CountryCode => countrySchema.safeParse(auth.country).data ?? 'US';
const who = (auth: AuthContext) => ({ userId: auth.userId, email: auth.email });

/** The same refusal text for "does not exist" and "not yours". */
async function ownedOrder(auth: AuthContext, number: string) {
  const o = await Order.findOne({ orderNumber: number.toUpperCase() });
  if (!o) return null;
  const mine = (!!auth.userId && String(o.userId) === auth.userId) || (!!auth.emailVerified && !!auth.email && o.email.toLowerCase() === auth.email.toLowerCase());
  return mine ? o : null;
}

/** Guest contract: order number AND the email on the order (both supplied by the visitor, never by the model). */
async function guestOrder(auth: AuthContext, number: string) {
  const o = await Order.findOne({ orderNumber: number.toUpperCase() });
  if (!o || !auth.email || o.email.toLowerCase() !== auth.email.toLowerCase()) return null;
  return o;
}

const shipmentOut = z.object({ status: z.string(), carrier: z.string().nullable(), trackingNumber: z.string().nullable(), trackingUrl: z.string().nullable(), estimatedDelivery: z.string().nullable() });
const orderOut = z.discriminatedUnion('found', [
  z.object({ found: z.literal(false) }),
  z.object({
    found: z.literal(true), orderNumber: z.string(), status: z.string(), createdAt: z.string().nullable(), total: z.number().nullable(), currency: z.string(), delivered: z.boolean(), deliveredAt: z.string().nullable(),
    items: z.array(z.object({ title: z.string(), quantity: z.number(), sku: z.string() })).max(30), shipments: z.array(shipmentOut).max(20),
  }),
]);

async function orderPayload(o: InstanceType<typeof Order>): Promise<z.infer<typeof orderOut>> {
  const ships = await Shipment.find({ orderId: o._id }).select('status carrier trackingNumber trackingUrl estimatedDelivery').limit(20).lean();
  return {
    found: true, orderNumber: o.orderNumber, status: o.status, createdAt: ((o as unknown as { createdAt?: Date }).createdAt ?? null)?.toISOString() ?? null, total: o.amounts?.total ?? null, currency: o.currency,
    delivered: !!o.deliveredAt, deliveredAt: o.deliveredAt?.toISOString() ?? null,
    items: o.items.slice(0, 30).map((i) => ({ title: i.title, quantity: i.quantity, sku: i.sku })),
    shipments: ships.map((s) => ({ status: s.status, carrier: s.carrier ?? null, trackingNumber: s.trackingNumber ?? null, trackingUrl: s.trackingUrl ?? null, estimatedDelivery: s.estimatedDelivery?.toISOString().slice(0, 10) ?? null })),
  };
}

/** Deterministic domain refusals (4xx) are policy answers, not crashes: they become a structured result. The tool's zod output schema validates `fail` too. */
const answer = async <T,>(fn: () => Promise<T>, fail: (m: string, code: string) => unknown): Promise<T> => {
  try { return await fn(); } catch (e) {
    if (e instanceof DomainError && e.status >= 400 && e.status < 500) return fail(e.message, e.code) as T;
    throw e;
  }
};

/* ---------------------------------- public tools ---------------------------------- */
const findProducts: AnyTool<AgentIO> = {
  name: 'find_products', description: 'Search the catalogue with the deterministic Find engine (intent parser + ranking). Returns real products only.', sideEffect: 'read', audience: ALL,
  input: strict({ query: z.string().trim().min(1).max(300), budgetMax: z.number().positive().max(1_000_000).optional(), sort: z.enum(['relevance', 'price_asc', 'price_desc', 'rating', 'value', 'fastest', 'popular']).optional(), limit: z.number().int().min(1).max(8).default(5) }),
  output: z.object({
    total: z.number(), currency: z.string(), understood: z.object({ keywords: z.array(z.string()), budgetMax: z.number().nullable(), deadline: z.string().nullable(), notes: z.array(z.string()) }),
    items: z.array(z.object({ id: z.string(), slug: z.string(), title: z.string(), image: z.string().nullable(), price: z.number(), currency: z.string(), rating: z.number().nullable(), reviewCount: z.number(), inStock: z.boolean(), minDays: z.number().nullable(), maxDays: z.number().nullable(), deliveryFit: z.string(), why: z.array(z.string()) })).max(8),
  }),
  limits: { maxCallsPerRun: 4, maxOutputBytes: 12_000 },
  async run({ ctx }, i, auth) {
    const r = await runFind(ctx, country(auth), { query: i.query, budgetMax: i.budgetMax, sort: i.sort, useAI: false, limit: i.limit });
    return {
      total: r.total, currency: r.currency,
      understood: { keywords: r.understood.keywords.slice(0, 8), budgetMax: r.understood.budget?.max ?? null, deadline: r.understood.deadline?.date ?? null, notes: r.understood.notes.slice(0, 4) },
      items: r.items.slice(0, i.limit).map((p) => ({ id: p.id, slug: p.slug, title: p.title, image: p.image, price: p.price, currency: p.currency, rating: p.rating.count > 0 ? p.rating.avg : null, reviewCount: p.rating.count, inStock: p.stock > 0, minDays: p.minDays, maxDays: p.maxDays, deliveryFit: p.deliveryFit, why: p.whyMatched.slice(0, 3).map((w) => w.text) })),
    };
  },
};

const compareProducts: AnyTool<AgentIO> = {
  name: 'compare_products', description: 'Side-by-side comparison of 2-4 products from the deterministic compare engine.', sideEffect: 'read', audience: ALL,
  input: strict({ ids: z.array(objectId).min(2).max(4) }),
  output: z.object({
    currency: z.string(), products: z.array(z.object({ id: z.string(), slug: z.string(), title: z.string(), price: z.number(), deliveredEstimate: z.number(), available: z.boolean() })),
    keyDifferences: z.array(z.string()).max(10), bestFor: z.array(z.object({ label: z.string(), productId: z.string(), detail: z.string() })).max(6), rows: z.array(z.object({ label: z.string(), values: z.array(z.string().nullable()), differs: z.boolean() })).max(20),
  }),
  limits: { maxCallsPerRun: 2, maxOutputBytes: 14_000 },
  async run({ ctx }, i, auth) {
    const r = await runCompare(ctx, country(auth), i.ids);
    return { currency: r.currency, products: r.products.map((p) => ({ id: p.id, slug: p.slug, title: p.title, price: p.price, deliveredEstimate: p.deliveredEstimate, available: p.available })), keyDifferences: r.keyDifferences.slice(0, 10), bestFor: r.bestFor.slice(0, 6), rows: r.rows.slice(0, 20) };
  },
};

const FactOut = z.object({ label: z.string(), value: z.string(), provenance: z.string() });
const productFacts: AnyTool<AgentIO> = {
  name: 'product_facts', description: 'Verified product facts (specifications, materials, certificates, warranty evidence) from the Digital Product Passport. Anything not listed is unknown.', sideEffect: 'read', audience: ALL,
  input: strict({ slug: z.string().trim().min(1).max(160).regex(/^[a-z0-9-]+$/i) }),
  output: z.object({ found: z.boolean(), title: z.string().optional(), facts: z.array(FactOut).max(30), documents: z.array(z.object({ title: z.string(), kind: z.string(), provenance: z.string(), expired: z.boolean() })).max(10), warranty: z.string().nullable(), missing: z.array(z.string()).max(6), delivery: z.string().nullable() }),
  limits: { maxCallsPerRun: 3, maxOutputBytes: 10_000 },
  async run({ ctx }, i, auth) {
    return answer(async () => {
      const p = await getProductPassport(ctx, i.slug, auth.country);
      const facts = [...p.specifications.map((s) => ({ label: s.key, f: s.field })), ...p.materials.map((m) => ({ label: 'material', f: m })), ...p.dimensions.map((d) => ({ label: d.key, f: d.field }))]
        .filter((x) => x.f.provenance === 'verified' || x.f.provenance === 'supplier_provided').slice(0, 30).map((x) => ({ label: String(x.label), value: String(x.f.value), provenance: x.f.provenance }));
      const warrantyFact = facts.find((f) => /warrant/i.test(f.label));
      const documents = p.documents.slice(0, 10).map((d) => ({ title: d.title, kind: d.kind, provenance: d.provenance, expired: !!d.expired }));
      const missing: string[] = [];
      if (!warrantyFact) missing.push('warranty');
      if (!documents.length) missing.push('certifications');
      if (!facts.length) missing.push('specifications');
      return { found: true, title: p.product.title, facts, documents, warranty: warrantyFact ? `${warrantyFact.label}: ${warrantyFact.value}` : null, missing, delivery: p.delivery.promised ? `${p.delivery.promised.minDays}-${p.delivery.promised.maxDays} days promised by the supplier` : null };
    }, () => ({ found: false, facts: [], documents: [], warranty: null, missing: ['product'], delivery: null }));
  },
};

const purchaseConfidence: AnyTool<AgentIO> = {
  name: 'purchase_confidence', description: 'Honest delivery window, return window and caveats for buying a product in this country.', sideEffect: 'read', audience: ALL,
  input: strict({ slug: z.string().trim().min(1).max(160).regex(/^[a-z0-9-]+$/i), quantity: z.number().int().min(1).max(10).default(1) }),
  output: z.object({ found: z.boolean(), title: z.string().optional(), available: z.boolean().optional(), minDays: z.number().nullable(), maxDays: z.number().nullable(), deliveryStatement: z.string().nullable(), returnWindowDays: z.number().nullable(), returnNote: z.string().nullable(), uncertainty: z.array(z.string()).max(6) }),
  limits: { maxCallsPerRun: 2, maxOutputBytes: 6_000 },
  async run({ ctx }, i, auth) {
    return answer(async () => {
      const r = await getPurchaseConfidence(ctx, i.slug, auth.country, i.quantity);
      return { found: true, title: r.product.title, available: r.product.available, minDays: r.delivery.minDays, maxDays: r.delivery.maxDays, deliveryStatement: r.delivery.statement, returnWindowDays: r.returns.windowDays, returnNote: r.returns.note, uncertainty: r.uncertainty.slice(0, 6) };
    }, () => ({ found: false, minDays: null, maxDays: null, deliveryStatement: null, returnWindowDays: null, returnNote: null, uncertainty: [] }));
  },
};

const requestHuman: AnyTool<AgentIO> = {
  name: 'request_human', description: 'Hand the conversation to a person: creates a record in the staff queue. No confirmation needed.', sideEffect: 'propose', audience: ALL,
  input: strict({ reason: z.string().trim().min(3).max(300) }),
  output: z.object({ queued: z.boolean() }),
  limits: { maxCallsPerRun: 1, maxOutputBytes: 400 },
  async run(_io, i, auth) {
    await AgentsEscalation.create({ agentId: 'shopping_assistant', reason: 'customer_requested', summary: `Customer asked for a person: ${redact(i.reason, 300)}`.slice(0, 400), userId: auth.userId, context: { actor: auth.kind } });
    return { queued: true };
  },
};

/* ------------------------------- account tools (verified customer) ------------------------------- */
const guestOrderLookup: AnyTool<AgentIO> = {
  name: 'guest_order_lookup', description: 'Look up an order with the order number plus the email on the order (guest contract). Returns status and tracking only.', sideEffect: 'read', audience: ['guest'],
  input: strict({ orderNumber }),
  output: orderOut,
  limits: { maxCallsPerRun: 2, maxOutputBytes: 6_000 },
  async run(_io, i, auth) {
    const o = await guestOrder(auth, i.orderNumber);
    return o ? orderPayload(o) : NOT_FOUND;
  },
};

const myOrders: AnyTool<AgentIO> = {
  name: 'my_orders', description: 'List the signed-in customer\'s recent orders (find previous purchases).', sideEffect: 'read', audience: ['customer'],
  input: strict({ limit: z.number().int().min(1).max(10).default(5), titleContains: z.string().trim().min(2).max(60).optional() }),
  output: z.object({ items: z.array(z.object({ orderNumber: z.string(), status: z.string(), createdAt: z.string().nullable(), itemCount: z.number(), firstItem: z.string().nullable(), titles: z.array(z.string()).max(6) })).max(10) }),
  limits: { maxCallsPerRun: 2, maxOutputBytes: 6_000 },
  async run(_io, i, auth) {
    const q: Record<string, unknown> = { $or: [{ userId: auth.userId }, ...(auth.emailVerified && auth.email ? [{ email: auth.email }] : [])] };
    if (i.titleContains) q['items.title'] = { $regex: i.titleContains.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    const orders = await Order.find(q).sort({ createdAt: -1 }).limit(i.limit).select('orderNumber status items createdAt').lean();
    return { items: orders.map((o) => ({ orderNumber: o.orderNumber, status: o.status, createdAt: ((o as unknown as { createdAt?: Date }).createdAt ?? null)?.toISOString() ?? null, itemCount: o.items.length, firstItem: o.items[0]?.title ?? null, titles: o.items.slice(0, 6).map((x) => x.title) })) };
  },
};

const getOrder: AnyTool<AgentIO> = {
  name: 'get_order', description: 'Status, items and delivery tracking of one of the signed-in customer\'s orders. Ownership is checked in code.', sideEffect: 'read', audience: ['customer'],
  input: strict({ orderNumber }),
  output: orderOut,
  limits: { maxCallsPerRun: 3, maxOutputBytes: 6_000 },
  async run({ ctx }, i, auth) {
    const o = await ownedOrder(auth, i.orderNumber);
    if (!o) {
      ctx.log.warn({ channel: 'security', actor: auth.actorRef, tool: 'get_order' }, 'assistant order lookup found no owned order');
      return NOT_FOUND;
    }
    return orderPayload(o);
  },
};

const eligibilityOut = z.object({
  found: z.boolean(), orderNumber: z.string().optional(), eligible: z.boolean().optional(), windowDays: z.number().nullable().optional(), daysLeft: z.number().nullable().optional(), orderReasons: z.array(z.string()).max(5).optional(),
  lines: z.array(z.object({ sku: z.string(), title: z.string(), eligible: z.boolean(), maxQuantity: z.number(), reasons: z.array(z.string()).max(4), resolutions: z.array(z.string()).max(3) })).max(30).optional(),
});
const returnEligibility: AnyTool<AgentIO> = {
  name: 'return_eligibility', description: 'Which items of an owned order can be returned, and why not. Computed by the deterministic after-sales rules.', sideEffect: 'read', audience: ['customer'],
  input: strict({ orderNumber, reason: z.enum(RETURN_REASON_CODES).optional() }),
  output: eligibilityOut,
  limits: { maxCallsPerRun: 3, maxOutputBytes: 8_000 },
  async run({ ctx }, i, auth) {
    if (!(await ownedOrder(auth, i.orderNumber))) return NOT_FOUND;
    return answer(async () => {
      const e = await getEligibility(ctx, i.orderNumber.toUpperCase(), who(auth), i.reason);
      return {
        found: true, orderNumber: e.order.orderNumber, eligible: e.result.eligible, windowDays: e.result.windowDays, daysLeft: e.result.daysLeft, orderReasons: e.result.orderReasons.map((r) => r.message).slice(0, 5),
        lines: e.result.lines.slice(0, 30).map((l) => ({ sku: l.sku, title: l.title, eligible: l.eligible, maxQuantity: l.maxQuantity, reasons: l.reasons.map((r) => r.message).slice(0, 4), resolutions: l.resolutionsAllowed })),
      };
    }, () => NOT_FOUND);
  },
};

const refundProgress: AnyTool<AgentIO> = {
  name: 'refund_progress', description: 'Return and refund progress for an owned order (timeline built from real refund and return records).', sideEffect: 'read', audience: ['customer'],
  input: strict({ orderNumber }),
  output: z.object({ found: z.boolean(), orderNumber: z.string().optional(), headline: z.string().optional(), steps: z.array(z.object({ label: z.string(), status: z.string(), detail: z.string().optional() })).max(12).optional(), returnState: z.string().nullable().optional(), rmaNumber: z.string().nullable().optional(), refunds: z.array(z.object({ status: z.string(), amount: z.number(), currency: z.string().nullable() })).max(10).optional() }),
  limits: { maxCallsPerRun: 2, maxOutputBytes: 6_000 },
  async run({ ctx }, i, auth) {
    if (!(await ownedOrder(auth, i.orderNumber))) return NOT_FOUND;
    return answer(async () => {
      const a = await orderAftersales(ctx, i.orderNumber.toUpperCase(), who(auth));
      return {
        found: true, orderNumber: a.orderNumber, headline: a.refund.headline, steps: a.refund.steps.slice(0, 12).map((s) => ({ label: s.label, status: s.status, detail: s.detail })),
        returnState: a.return?.state ?? null, rmaNumber: a.return?.rmaNumber ?? null, refunds: a.refund.refunds.map((r) => ({ status: String(r.status), amount: r.amount ?? 0, currency: r.currency ?? null })),
      };
    }, () => NOT_FOUND);
  },
};

const rescueStatus: AnyTool<AgentIO> = {
  name: 'rescue_status', description: 'Delivery Rescue status for an owned order: the problem the recovery engine detected and the options it offers (the engine decides; this only reads).', sideEffect: 'read', audience: ['customer'],
  input: strict({ orderNumber }),
  output: z.object({ found: z.boolean(), cases: z.array(z.object({ state: z.string(), problem: z.string(), statusText: z.string(), offers: z.array(z.object({ id: z.string(), kind: z.string(), label: z.string(), text: z.string(), refund: z.number().nullable(), etaMaxDays: z.number().nullable() })).max(6) })).max(5) }),
  limits: { maxCallsPerRun: 2, maxOutputBytes: 8_000 },
  async run({ ctx }, i, auth) {
    if (!(await ownedOrder(auth, i.orderNumber))) return { found: false, cases: [] };
    return answer(async () => {
      const v = await recoveryView(ctx, i.orderNumber, { userId: auth.userId, email: auth.emailVerified ? auth.email : undefined });
      return { found: true, cases: v.cases.slice(0, 5).map((c) => ({ state: c.state, problem: c.problem, statusText: c.statusText, offers: c.offers.slice(0, 6).map((o) => ({ id: o.id, kind: o.kind, label: o.label, text: o.text, refund: o.refund ?? null, etaMaxDays: o.etaDays?.max ?? null })) })) };
    }, () => ({ found: false, cases: [] }));
  },
};

/** Policy facts + deterministic recommendation for a customer problem (used by the Customer Advocate). Read only. */
const resolutionContext: AnyTool<AgentIO> = {
  name: 'resolution_context', description: 'Gather rescue state, return eligibility, refund math and published policy for a delayed/damaged/missing/wrong item, then list the policy-permitted resolutions with the fairest one marked.', sideEffect: 'read', audience: ['customer'],
  input: strict({ orderNumber, problem: z.enum(PROBLEMS) }),
  output: z.object({
    found: z.boolean(), orderNumber: z.string().optional(), problem: z.string().optional(), currency: z.string().optional(), refundMinor: z.number().nullable().optional(), recommended: z.string().nullable().optional(), recommendedLabel: z.string().nullable().optional(), needsStaff: z.boolean().optional(), fairnessNote: z.string().optional(),
    options: z.array(z.object({ kind: z.string(), label: z.string(), permitted: z.boolean(), reason: z.string(), refundMinor: z.number().nullable().optional(), offerId: z.string().optional(), rescueKind: z.string().optional() })).max(12).optional(), shippingRefundRule: z.string().optional(), windowDays: z.number().nullable().optional(),
  }),
  limits: { maxCallsPerRun: 1, maxOutputBytes: 8_000 },
  async run({ ctx }, i, auth) {
    const o = await ownedOrder(auth, i.orderNumber);
    if (!o) return NOT_FOUND;
    const [policy, rescue, openRma] = await Promise.all([
      loadPolicy(), recoveryView(ctx, o.orderNumber, { userId: auth.userId, email: auth.emailVerified ? auth.email : undefined }).catch(() => null),
      AftersalesReturn.exists({ orderId: o._id, state: { $nin: ['rejected', 'cancelled', 'resolved'] } }),
    ]);
    const reason = i.problem === 'damaged' ? 'damaged' : i.problem === 'wrong_item' ? 'wrong_item' : i.problem === 'missing' ? 'not_delivered' : i.problem === 'delayed' ? 'not_delivered' : 'other';
    const e = await getEligibility(ctx, o.orderNumber, who(auth), reason).catch(() => null);
    const fault = i.problem === 'other' ? 'unknown' : 'merchant';
    let refundMinor: number | null = null;
    if (e?.result.eligible) {
      const eligibleLines = e.result.lines.filter((l) => l.eligible && l.maxQuantity > 0);
      try {
        refundMinor = computeRefund({
          currency: o.currency, amounts: { subtotal: o.amounts?.subtotal ?? 0, discount: o.amounts?.discount ?? 0, shipping: o.amounts?.shipping ?? 0, tax: o.amounts?.tax ?? 0, total: o.amounts?.total ?? 0, taxInclusive: !!o.amounts?.taxInclusive },
          lines: o.items.map((it) => ({ sku: it.sku, unitPrice: it.unitPrice ?? 0, quantity: it.quantity, returnQty: eligibleLines.find((l) => l.sku === it.sku)?.maxQuantity ?? 0, alreadyReturnedQty: 0 })),
          alreadyRefunded: o.costs?.refunded ?? 0, fault, shippingRule: policy.shippingRefund[o.country as CountryCode], restockingFeeBps: policy.restockingFeeBps, returnShippingDeduction: policy.returnShippingDeduction[o.country as CountryCode],
        }).refundable;
      } catch { refundMinor = null; }
    }
    const rc = rescue?.cases.find((c) => !['resolved', 'closed'].includes(c.state)) ?? null;
    const stored = rc ? await RescueCase.findOne({ orderId: o._id, state: { $nin: ['resolved', 'closed'] } }).select('recommendedId options').lean() : null;
    const recKind = stored ? ((stored.options ?? []) as unknown as { id: string; kind: string }[]).find((x) => x.id === stored.recommendedId)?.kind ?? null : null;
    const facts: AdvocateFacts = {
      problem: i.problem, currency: o.currency, orderOk: ['succeeded', 'partially_refunded'].includes(o.payment?.status ?? '') && o.status !== 'CANCELLED', delivered: !!o.deliveredAt,
      rescue: rc ? { state: rc.state, recommendedKind: recKind, offers: rc.offers.map((x) => ({ id: x.id, kind: x.kind, label: x.label, refund: x.refund ?? null, etaMaxDays: x.etaDays?.max ?? null })) } : null,
      eligibility: e ? { eligible: e.result.eligible, replacementAllowed: e.result.lines.some((l) => l.eligible && l.resolutionsAllowed.includes('replacement')), reasons: [...e.result.orderReasons.map((r) => r.message), ...e.result.lines.flatMap((l) => l.reasons.map((r) => r.message))].slice(0, 4), daysLeft: e.result.daysLeft } : null,
      refundMinor, openCase: !!openRma,
    };
    const rec = recommendResolution(facts);
    return {
      found: true, orderNumber: o.orderNumber, problem: i.problem, currency: o.currency, refundMinor, recommended: rec.recommended, recommendedLabel: rec.recommendedLabel, needsStaff: rec.needsStaff, fairnessNote: rec.fairnessNote,
      options: rec.options.slice(0, 12).map((x) => ({ kind: x.kind, label: x.label, permitted: x.permitted, reason: x.reason, refundMinor: x.refundMinor ?? null, offerId: x.offerId, rescueKind: x.rescueKind })), shippingRefundRule: policy.shippingRefund[o.country as CountryCode], windowDays: e?.result.windowDays ?? null,
    };
  },
};

/* ------------------------------- guarded customer actions ------------------------------- */
const startReturnTool: AnyTool<AgentIO> = {
  name: 'start_return', description: 'Start a return for one item of an owned order. Runs the deterministic eligibility check and creates the return request; staff authorise and the refund is decided by refund rules and approval limits, never here.', sideEffect: 'write_guarded', audience: ['customer'],
  input: strict({ orderNumber, sku: z.string().trim().min(1).max(80), quantity: z.number().int().min(1).max(100).default(1), reason: z.enum(RETURN_REASON_CODES), condition: z.enum(ITEM_CONDITIONS), resolution: z.enum(RESOLUTION_TYPES).default('refund'), details: z.string().trim().max(1000).default('') }),
  output: z.object({ started: z.boolean(), rmaNumber: z.string().nullable(), state: z.string().nullable(), code: z.string().nullable(), message: z.string() }),
  describe: (i) => `Start a ${i.resolution} return for ${i.quantity} x ${i.sku} on order ${i.orderNumber.toUpperCase()} (reason: ${i.reason.replace(/_/g, ' ')})`,
  limits: { maxCallsPerRun: 1, maxOutputBytes: 1_000 },
  async run({ ctx }, i, auth) {
    const o = await ownedOrder(auth, i.orderNumber);
    if (!o) return { started: false, rmaNumber: null, state: null, code: 'NOT_FOUND', message: 'We could not find that order on your account.' };
    return answer(async () => {
      const doc = await startReturn(ctx, { orderId: String(o._id), reason: i.reason, details: i.details, items: [{ sku: i.sku, quantity: i.quantity, condition: i.condition }], resolution: i.resolution }, { ...who(auth), actor: { id: auth.userId ?? 'customer', type: 'user' } });
      return { started: true, rmaNumber: doc.rmaNumber, state: doc.state, code: null, message: 'Your return request was created. Our team will review it and you will see the next steps on the order page.' };
    }, (message, code) => ({ started: false, rmaNumber: null, state: null, code, message }));
  },
};

const REPLACE_REASONS = ['damaged', 'defective', 'wrong_item', 'missing_parts', 'not_as_described'] as const;
const requestReplacement: AnyTool<AgentIO> = {
  name: 'request_replacement', description: 'Ask for a replacement of an item that arrived faulty or wrong. This creates a PENDING request that staff approve or reject; nothing is shipped or refunded by this tool.', sideEffect: 'propose', requiresConfirmation: true, audience: ['customer'],
  input: strict({ orderNumber, sku: z.string().trim().min(1).max(80), quantity: z.number().int().min(1).max(10).default(1), reason: z.enum(REPLACE_REASONS), details: z.string().trim().max(1000).default('') }),
  output: z.object({ requested: z.boolean(), requestId: z.string().nullable(), message: z.string() }),
  describe: (i) => `Request a replacement for ${i.quantity} x ${i.sku} on order ${i.orderNumber.toUpperCase()} (reason: ${i.reason.replace(/_/g, ' ')}); a team member must approve it`,
  limits: { maxCallsPerRun: 1, maxOutputBytes: 800 },
  async run({ ctx }, i, auth) {
    const o = await ownedOrder(auth, i.orderNumber);
    if (!o) return { requested: false, requestId: null, message: 'We could not find that order on your account.' };
    const line = o.items.find((x) => x.sku === i.sku);
    if (!line) return { requested: false, requestId: null, message: 'That item is not on this order.' };
    const e = await getEligibility(ctx, o.orderNumber, who(auth), i.reason).catch(() => null);
    const l = e?.result.lines.find((x) => x.sku === i.sku);
    if (!l?.eligible || !l.resolutionsAllowed.includes('replacement')) return { requested: false, requestId: null, message: l?.reasons[0]?.message ?? 'A replacement is not available for this item under the current return rules. A team member can still look at it.' };
    const existing = await AgentsReplacementRequest.findOne({ orderId: o._id, sku: i.sku, state: 'pending' }).select('_id').lean();
    if (existing) return { requested: true, requestId: String(existing._id), message: 'You already have a pending replacement request for this item.' };
    const esc = await AgentsEscalation.create({ agentId: 'shopping_assistant', reason: 'replacement_request', summary: `Replacement requested: ${i.quantity} x ${line.title} on ${o.orderNumber} (${i.reason})`, userId: auth.userId, orderNumber: o.orderNumber, context: { sku: i.sku, reason: i.reason } });
    const r = await AgentsReplacementRequest.create({ userId: auth.userId, orderId: o._id, orderNumber: o.orderNumber, sku: i.sku, quantity: Math.min(i.quantity, l.maxQuantity || i.quantity), reason: i.reason, details: i.details, escalationId: esc._id });
    return { requested: true, requestId: String(r._id), message: 'Your replacement request was sent to our team. They will approve or decline it and you will be notified. Nothing has been shipped or charged.' };
  },
};

const createPriceAlertTool: AnyTool<AgentIO> = {
  name: 'create_price_alert', description: 'Track a product\'s price (Price Guard). Emails the customer when it drops by the chosen percentage or reaches the target.', sideEffect: 'write_guarded', audience: ['customer'],
  input: strict({ productId: objectId, targetPrice: z.number().positive().max(1_000_000).optional(), dropPercent: z.number().min(1).max(90).default(5) }),
  output: z.object({ created: z.boolean(), alreadyTracking: z.boolean(), message: z.string() }),
  describe: (i) => `Track the price of product ${i.productId}${i.targetPrice ? ` with a target of ${i.targetPrice}` : ` and alert on a drop of ${i.dropPercent}% or more`}`,
  limits: { maxCallsPerRun: 1, maxOutputBytes: 600 },
  async run({ ctx }, i, auth) {
    return answer(async () => {
      await createPriceAlert(ctx, auth.userId as string, country(auth), { productId: i.productId, targetPrice: i.targetPrice, dropPercent: i.dropPercent, notifyOnDrop: true, notifyOnStock: true, notifyOnBetterOffer: true });
      return { created: true, alreadyTracking: false, message: 'Price alert created. We will email you when the price drops.' };
    }, (message, code) => ({ created: false, alreadyTracking: code === 'ALREADY_TRACKING', message }));
  },
};

const savePreference: AnyTool<AgentIO> = {
  name: 'save_preference', description: 'Save a short note to the customer\'s Commerce Memory (only with their explicit confirmation, and only if memory is switched on in their privacy settings).', sideEffect: 'write_guarded', audience: ['customer'],
  input: strict({ kind: z.enum(MEMORY_KINDS).default('note'), title: z.string().trim().min(2).max(120), note: z.string().trim().max(300).optional() }),
  output: z.object({ saved: z.boolean(), reason: z.string().nullable(), message: z.string() }),
  describe: (i) => `Remember "${i.title}" in your Commerce Memory`,
  limits: { maxCallsPerRun: 1, maxOutputBytes: 500 },
  async run({ ctx }, i, auth) {
    const r = await saveMemoryItem(ctx, auth.userId as string, { kind: i.kind, title: i.title, payload: i.note ? { text: i.note } : {} }, 'assistant');
    if (r.saved) return { saved: true, reason: null, message: 'Saved. You can view or delete it any time in your privacy settings.' };
    const why = { memory_off: 'Commerce Memory is switched off in your privacy settings, so I did not save anything.', limit: 'Your memory is full. Delete an item in your privacy settings to add more.', too_large: 'That note is too long to save.' }[r.reason];
    return { saved: false, reason: r.reason, message: why };
  },
};

export const CUSTOMER_TOOLS: AnyTool<AgentIO>[] = [findProducts, compareProducts, productFacts, purchaseConfidence, requestHuman, guestOrderLookup, myOrders, getOrder, returnEligibility, refundProgress, rescueStatus, resolutionContext, startReturnTool, requestReplacement, createPriceAlertTool, savePreference];
