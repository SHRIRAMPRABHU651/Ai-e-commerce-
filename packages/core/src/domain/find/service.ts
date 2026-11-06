/**
 * ORVIA Find + Price Guard: IO layer (catalogue loading, endpoints' domain functions, jobs).
 * All decisions live in the pure modules next to this file; this file only reads/writes the database.
 */
import { FindPriceAlert, FindPriceSnapshot, FindSavedSearch, Product, User } from '@orvia/database';
import { COUNTRY_CODES, NEEDS, PRICE_ALERT_MAX_PER_USER, SAVED_SEARCH_MAX_PER_USER, SELLABLE_STATES } from '@orvia/types';
import type { CompareResponse, CountryCode, FindItem, FindRequest, FindResponse, FindUnderstood, PriceHistoryResponse, PriceAlertInput, SavedSearchInput } from '@orvia/types';
import { DomainError, notFound } from '../../infra/context';
import type { Ctx } from '../../infra/context';
import { getCountry, getCountryConfigs } from '../../infra/countries';
import { toStoreProduct } from '../catalog';
import { listableImageFilter } from '../images';
import { notify } from '../notify';
import { COUNTRY_TZ, addDays, isYmd, todayIn } from './dates';
import { intentFromImageAttributes, intentRefinementSchema, refineIntent } from './aiRefine';
import { buildComparison } from './compare';
import type { CompareProduct } from './compare';
import { checkSearchImage } from './imageInput';
import { CATEGORY_DEFS, budgetToMinor, parseIntent } from './intent';
import type { Cur, ParsedIntent } from './intent';
import { alertDedupeKey, decideAlertEvents, shouldSnapshot, summarizeHistory } from './priceGuard';
import type { AlertEvent, Snap } from './priceGuard';
import { buildPresets } from './presets';
import type { FindPreset } from './presets';
import { deliveredEstimate, rankCandidates } from './ranking';
import type { FindCandidate, RankedItem, ShippingFee } from './ranking';
import { TfIdfSemanticIndex } from './semantic';
import type { SemanticIndex } from './semantic';
import { findBetterOffers, rankAlternatives } from './similar';

const MAX_CATALOG = 3000;
const CATALOG_TTL = 30_000;

/* ------------------------------ catalogue ------------------------------ */
interface Catalog { at: number; cands: FindCandidate[]; byId: Map<string, FindCandidate>; semantic: SemanticIndex; ship: ShippingFee | null; currency: Cur }
const cache = new Map<CountryCode, Catalog>();
export const invalidateFindCache = (): void => cache.clear();

type LeanProduct = Parameters<typeof toStoreProduct>[0];
function toCandidate(p: LeanProduct, country: CountryCode, returnDays?: number): FindCandidate & { returnWindowDays: number | null; shipsFrom: string | null; available: boolean; safetyStandards: string[] } {
  const sp = toStoreProduct(p, country, returnDays);
  const img = sp.images[0];
  return {
    id: sp.id, slug: sp.slug, title: sp.title, brand: sp.brand, image: img?.card ?? img?.url ?? null, category: sp.category, topCategory: sp.topCategory,
    tags: (p as { tags?: string[] }).tags ?? [], keywords: (p as { seo?: { keywords?: string[] } }).seo?.keywords ?? [],
    description: [sp.description, ...sp.bullets].join(' ').slice(0, 800), attributes: sp.attributes,
    price: sp.price ?? 0, currency: sp.currency, stock: sp.available ? sp.stock : 0, rating: sp.rating, sold: sp.sold, trend: sp.trendScore,
    minDays: sp.minDays, maxDays: sp.maxDays, ageRange: sp.safety?.ageRange ?? null,
    returnWindowDays: sp.returnWindowDays ?? null, shipsFrom: sp.shipsFrom, available: sp.available, safetyStandards: sp.safety?.standards ?? [],
  };
}
const PROJECTION = 'title slug brand description bullets features benefits tags seo category topCategory attributes images markets stats compliance state createdAt';

async function standardShipping(country: CountryCode): Promise<{ ship: ShippingFee | null; cur: Cur; returnDays: number }> {
  const cfg = await getCountry(country);
  const std = cfg.shippingMethods.find((m) => m.code === 'standard') ?? cfg.shippingMethods[0];
  return { ship: std ? { fee: std.fee, freeOver: std.freeOver } : null, cur: cfg.currency, returnDays: cfg.returnWindowDays };
}

async function loadCatalog(country: CountryCode): Promise<Catalog> {
  const hit = cache.get(country);
  if (hit && Date.now() - hit.at < CATALOG_TTL) return hit;
  const { ship, cur, returnDays } = await standardShipping(country);
  const rows = await Product.find({
    state: { $in: SELLABLE_STATES },
    $and: [listableImageFilter()],
    markets: { $elemMatch: { country, enabled: true, price: { $gt: 0 }, stock: { $gt: 0 } } },
  }).select(PROJECTION).sort({ 'stats.trendScore': -1, 'stats.soldCount': -1 }).limit(MAX_CATALOG).lean();
  const cands = rows.map((p) => toCandidate(p as unknown as LeanProduct, country, returnDays)).filter((c) => c.available && c.price > 0);
  const semantic = new TfIdfSemanticIndex();
  semantic.build(cands.map((c) => ({ id: c.id, text: `${c.title} ${c.title} ${c.tags.join(' ')} ${c.keywords.join(' ')} ${Object.values(c.attributes).join(' ')} ${c.category.replace(/-/g, ' ')} ${c.description}` })));
  const c: Catalog = { at: Date.now(), cands, byId: new Map(cands.map((x) => [x.id, x])), semantic, ship, currency: cur };
  cache.set(country, c);
  return c;
}

async function loadOne(id: string, country: CountryCode) {
  const p = await Product.findOne({ _id: id, state: { $in: SELLABLE_STATES } }).select(PROJECTION).lean();
  if (!p) return null;
  const { returnDays } = await standardShipping(country);
  const c = toCandidate(p as unknown as LeanProduct, country, returnDays);
  return c.price > 0 ? c : null;
}

async function fxTable(): Promise<Record<Cur, number>> {
  const cfgs = await getCountryConfigs();
  const fx: Record<Cur, number> = { USD: 1, CAD: 1, INR: 1 };
  for (const code of COUNTRY_CODES) fx[cfgs[code].currency] = cfgs[code].fxPerUsd;
  return fx;
}

/* ------------------------------ find ------------------------------ */
const DISCLAIMER = 'Results come from products currently available in your country. Delivery dates are estimates from each product\'s listed window, not guarantees. Budgets apply to the item price before shipping.';

const toItem = (r: RankedItem): FindItem => ({
  id: r.cand.id, slug: r.cand.slug, title: r.cand.title, brand: r.cand.brand, image: r.cand.image, category: r.cand.category, price: r.cand.price, currency: r.cand.currency,
  deliveredEstimate: r.delivered, rating: r.cand.rating, minDays: r.cand.minDays, maxDays: r.cand.maxDays, latestArrival: r.latestArrival, deliveryFit: r.deliveryFit,
  stock: Math.min(r.cand.stock, 99), score: Math.round(r.score * 10) / 10, whyMatched: r.whyMatched,
});

function understood(intent: ParsedIntent, cur: Cur, fx: Record<Cur, number>, parser: FindUnderstood['parser']): FindUnderstood {
  const b = intent.budget ? budgetToMinor(intent.budget, cur, fx) : null;
  return {
    needs: intent.needs.map((s) => ({ slug: s, name: NEEDS.find((n) => n.slug === s)?.name ?? s })),
    categories: intent.categories.map((s) => ({ slug: s, name: CATEGORY_DEFS.find((c) => c.slug === s)?.name ?? s })),
    keywords: [...intent.keywords, ...intent.extraTerms],
    attributes: intent.attributes.map((a) => ({ kind: a.kind, value: a.value })),
    budget: b ? { ...(b.min !== undefined ? { min: b.min / 100 } : {}), ...(b.max !== undefined ? { max: b.max / 100 } : {}), currency: cur, ...(b.converted ? { converted: true } : {}) } : null,
    gift: intent.gift,
    deadline: intent.deadline ? { date: intent.deadline.date, label: intent.deadline.label } : null,
    sort: intent.sort,
    compare: intent.compare,
    notes: intent.notes,
    parser,
  };
}

interface FindOpts { useAI?: boolean; limit?: number; imageIntent?: (base: ParsedIntent) => ParsedIntent }

async function execute(ctx: Ctx, country: CountryCode, req: Partial<FindRequest> & { query: string }, o: FindOpts = {}): Promise<FindResponse> {
  const cat = await loadCatalog(country);
  const fx = await fxTable();
  const now = ctx.now();
  const today = todayIn(COUNTRY_TZ[country], now);
  let intent = parseIntent(req.query, { now, country, marketCurrency: cat.currency });
  if (o.imageIntent) intent = o.imageIntent(intent);
  let parser: FindUnderstood['parser'] = 'deterministic';
  let ai: FindResponse['engine']['ai'] = 'not_used';
  if ((o.useAI ?? req.useAI ?? true) && ctx.ai.primary) {
    const primary = ctx.ai.primary;
    const out = await refineIntent(intent, (prompt) => primary.generateStructuredOutput(prompt, intentRefinementSchema), cat.currency);
    intent = out.intent;
    if (out.status === 'refined') { parser = 'ai_refined'; ai = 'refined'; } else if (out.status === 'fallback') { parser = 'ai_fallback'; ai = 'unavailable_fallback'; }
  }
  // explicit structured inputs override what was parsed from the text
  if (req.budgetMax !== undefined || req.budgetMin !== undefined) {
    intent = { ...intent, budget: { ...(req.budgetMin !== undefined ? { min: req.budgetMin } : intent.budget?.min !== undefined ? { min: intent.budget.min } : {}), ...(req.budgetMax !== undefined ? { max: req.budgetMax } : intent.budget?.max !== undefined ? { max: intent.budget.max } : {}), currency: req.budgetMax !== undefined || req.budgetMin !== undefined ? cat.currency : intent.budget!.currency, ambiguousDollar: false } };
  }
  if (req.deliverBy) {
    if (!isYmd(req.deliverBy) || req.deliverBy < today || req.deliverBy > addDays(today, 365)) throw new DomainError('deliverBy must be a date between today and one year from now', 'VALIDATION', 400);
    intent = { ...intent, deadline: { date: req.deliverBy, label: `by ${req.deliverBy}` } };
  }
  if (req.sort) intent = { ...intent, sort: req.sort };
  const budget = intent.budget ? budgetToMinor(intent.budget, cat.currency, fx) : null;
  const ranked = rankCandidates(intent, cat.cands, {
    today, budget, deadline: intent.deadline?.date ?? null, sort: intent.sort, minRating: req.minRating, ship: cat.ship, semantic: cat.semantic, limit: o.limit ?? req.limit ?? 24,
  });
  return {
    understood: understood(intent, cat.currency, fx, parser),
    items: ranked.items.map(toItem), total: ranked.total, excluded: ranked.excluded, country, currency: cat.currency,
    engine: { lexical: true, semantic: cat.semantic.kind === 'tfidf' ? 'tf-idf cosine text similarity (not neural embeddings)' : 'none', ai },
    disclaimer: DISCLAIMER,
  };
}

export const runFind = (ctx: Ctx, country: CountryCode, req: FindRequest): Promise<FindResponse> => execute(ctx, country, req);

/** Image search: a vision model extracts keywords; the same deterministic pipeline then ranks the real catalogue. Nothing is stored. */
export async function runImageFind(ctx: Ctx, country: CountryCode, file: { buffer: Buffer; mimetype: string }, text: string): Promise<FindResponse> {
  if (!ctx.ai.visionConfigured) throw new DomainError('Image search needs an AI vision provider (GEMINI_API_KEY) that is not configured on this server.', 'not_configured', 503);
  const chk = checkSearchImage(file.buffer, file.mimetype, ctx.cfg.MEDIA_MAX_BYTES);
  if (!chk.ok) {
    const msg = { empty: 'No image received', too_large: `Image is larger than ${Math.round(ctx.cfg.MEDIA_MAX_BYTES / 1_000_000)} MB`, type_mismatch: 'The file content does not match its type', unsupported_type: 'Only JPEG, PNG and WebP images are accepted' }[chk.reason];
    throw new DomainError(msg, 'VALIDATION', chk.reason === 'too_large' ? 413 : 400);
  }
  let attrs;
  try {
    attrs = await ctx.ai.describeImage({ base64: file.buffer.toString('base64'), mimeType: chk.mime });
  } catch (e) {
    ctx.log.warn({ channel: 'ai', err: (e as Error).message }, 'image search: vision call failed');
    throw new DomainError('We could not analyse that image right now. Try again, or describe what you are looking for in words.', 'ai_unavailable', 502);
  }
  if (!attrs) throw new DomainError('Image search is not configured.', 'not_configured', 503);
  const res = await execute(ctx, country, { query: text.trim() || attrs.subject }, { useAI: false, imageIntent: (base) => intentFromImageAttributes(base, attrs) });
  return { ...res, understood: { ...res.understood, parser: 'ai_refined' }, engine: { ...res.engine, ai: 'refined' } };
}

/* ------------------------------ presets ------------------------------ */
const presetCache = new Map<CountryCode, { at: number; items: (FindPreset & { count: number })[] }>();
export async function listPresets(ctx: Ctx, country: CountryCode): Promise<(FindPreset & { count: number })[]> {
  const hit = presetCache.get(country);
  if (hit && Date.now() - hit.at < 60_000) return hit.items;
  const cat = await loadCatalog(country);
  const out: (FindPreset & { count: number })[] = [];
  for (const p of buildPresets(cat.currency)) {
    const r = await execute(ctx, country, { query: p.query }, { useAI: false, limit: 1 });
    if (r.total > 0) out.push({ ...p, count: r.total });
  }
  presetCache.set(country, { at: Date.now(), items: out });
  return out;
}

/* ------------------------------ compare / alternatives / better offer ------------------------------ */
export async function runCompare(ctx: Ctx, country: CountryCode, ids: string[]): Promise<CompareResponse> {
  void ctx;
  const unique = [...new Set(ids)];
  if (unique.length < 2) throw new DomainError('Choose at least two different products', 'VALIDATION', 400);
  const { ship } = await standardShipping(country);
  const found = await Promise.all(unique.map((id) => loadOne(id, country)));
  const missing = unique.filter((_, i) => !found[i]);
  if (missing.length) throw new DomainError('One or more products are not available to compare in this country', 'NOT_FOUND', 404, { missing });
  const products: CompareProduct[] = found.map((c) => ({ ...c!, delivered: deliveredEstimate(c!.price, ship) }));
  return buildComparison(products, country);
}

export async function alternativesFor(ctx: Ctx, country: CountryCode, productId: string) {
  void ctx;
  const base = await loadOne(productId, country);
  if (!base) throw notFound('Product');
  const cat = await loadCatalog(country);
  const alts = rankAlternatives(base, cat.cands, cat.ship, 6);
  return {
    product: { id: base.id, title: base.title, available: base.available },
    items: alts.map((a) => ({ id: a.cand.id, slug: a.cand.slug, title: a.cand.title, image: a.cand.image, price: a.cand.price, currency: a.cand.currency, deliveredEstimate: a.delivered, rating: a.cand.rating, reasons: a.reasons })),
  };
}

export async function betterOfferFor(ctx: Ctx, country: CountryCode, productId: string) {
  void ctx;
  const base = await loadOne(productId, country);
  if (!base || !base.available) return { offer: null };
  const cat = await loadCatalog(country);
  const best = findBetterOffers(base, cat.cands, cat.ship, { limit: 1 })[0];
  if (!best) return { offer: null };
  return { offer: { id: best.cand.id, slug: best.cand.slug, title: best.cand.title, image: best.cand.image, price: best.cand.price, currency: best.cand.currency, deliveredEstimate: best.delivered, yourDeliveredEstimate: deliveredEstimate(base.price, cat.ship), savingPct: best.savingPct, reasons: best.reasons } };
}

/* ------------------------------ price history ------------------------------ */
const fmtMoney = (cur: string) => (minor: number) => new Intl.NumberFormat(cur === 'INR' ? 'en-IN' : cur === 'CAD' ? 'en-CA' : 'en-US', { style: 'currency', currency: cur, maximumFractionDigits: minor % 100 === 0 ? 0 : 2 }).format(minor / 100);

const lastSnapshot = async (productId: string, country: CountryCode): Promise<Snap | null> => {
  const s = await FindPriceSnapshot.findOne({ productId, country }).sort({ observedAt: -1 }).lean();
  return s ? { at: s.observedAt, price: s.price, inStock: s.inStock } : null;
};

/** Writes a snapshot if (and only if) shouldSnapshot says so. */
export async function recordSnapshot(productId: string, country: CountryCode, cur: { price: number; currency: string; inStock: boolean }, now: Date, source: 'scheduled' | 'on_demand'): Promise<boolean> {
  const last = await lastSnapshot(productId, country);
  if (!shouldSnapshot(last, cur, now, source === 'on_demand')) return false;
  await FindPriceSnapshot.create({ productId, country, price: cur.price, currency: cur.currency, inStock: cur.inStock, observedAt: now, source });
  return true;
}

export async function getPriceHistory(ctx: Ctx, country: CountryCode, productId: string, days: number): Promise<PriceHistoryResponse> {
  const now = ctx.now();
  const rows = await FindPriceSnapshot.find({ productId, country }).sort({ observedAt: 1 }).limit(500).lean();
  const snaps: Snap[] = rows.map((r) => ({ at: r.observedAt, price: r.price, inStock: r.inStock }));
  const cur = rows.at(-1)?.currency ?? (await standardShipping(country)).cur;
  const s = summarizeHistory(snaps, now, days, fmtMoney(cur));
  return {
    productId, country, currency: cur, observations: s.observations, firstObservedAt: s.firstObservedAt?.toISOString() ?? null,
    points: snaps.map((x) => ({ at: x.at.toISOString(), price: x.price, inStock: x.inStock })), current: s.current,
    lowest: s.lowest ? { price: s.lowest.price, at: s.lowest.at.toISOString(), windowDays: s.lowest.windowDays } : null, statement: s.statement, sufficient: s.sufficient,
  };
}

/** Scheduled job: snapshot per-country prices of sellable products that changed since the last observation. Bounded per run. */
export async function snapshotPrices(ctx: Ctx, opts: { maxProducts?: number } = {}): Promise<{ products: number; written: number }> {
  const max = opts.maxProducts ?? 5000;
  const now = ctx.now();
  let written = 0;
  let seen = 0;
  let lastId: unknown = null;
  while (seen < max) {
    const rows = await Product.find({ state: { $in: SELLABLE_STATES }, ...(lastId ? { _id: { $gt: lastId } } : {}) }).select('markets').sort({ _id: 1 }).limit(200).lean();
    if (!rows.length) break;
    lastId = rows.at(-1)!._id;
    seen += rows.length;
    const ids = rows.map((r) => r._id);
    const lasts = await FindPriceSnapshot.aggregate([
      { $match: { productId: { $in: ids } } },
      { $sort: { observedAt: -1 } },
      { $group: { _id: { p: '$productId', c: '$country' }, price: { $first: '$price' }, inStock: { $first: '$inStock' }, at: { $first: '$observedAt' } } },
    ]);
    const lastMap = new Map<string, Snap>(lasts.map((l: { _id: { p: unknown; c: string }; price: number; inStock: boolean; at: Date }) => [`${String(l._id.p)}:${l._id.c}`, { at: l.at, price: l.price, inStock: l.inStock }]));
    const docs: Record<string, unknown>[] = [];
    for (const p of rows) {
      for (const m of p.markets ?? []) {
        if (!m.enabled || !(m.price > 0)) continue;
        const cur = { price: m.price, inStock: (m.stock ?? 0) > 0 };
        if (shouldSnapshot(lastMap.get(`${String(p._id)}:${m.country}`) ?? null, cur, now)) docs.push({ productId: p._id, country: m.country, price: m.price, currency: m.currency ?? '', inStock: cur.inStock, observedAt: now, source: 'scheduled' });
      }
    }
    if (docs.length) { await FindPriceSnapshot.insertMany(docs, { ordered: false }); written += docs.length; }
  }
  return { products: seen, written };
}

/* ------------------------------ saved searches ------------------------------ */
const ssView = (s: { _id: unknown; name: string; query: string; country: string; budgetMax?: number | null; deliverBy?: string | null; alert?: { newMatches?: boolean; lastNotifiedAt?: Date | null } | null; createdAt?: Date }) => ({
  id: String(s._id), name: s.name, query: s.query, country: s.country, budgetMax: s.budgetMax ?? null, deliverBy: s.deliverBy ?? null,
  alertNewMatches: !!s.alert?.newMatches, lastNotifiedAt: s.alert?.lastNotifiedAt ?? null, createdAt: s.createdAt,
});

export async function listSavedSearches(userId: string) {
  return (await FindSavedSearch.find({ userId }).sort({ createdAt: -1 }).limit(SAVED_SEARCH_MAX_PER_USER).lean()).map(ssView);
}
export async function createSavedSearch(ctx: Ctx, userId: string, country: CountryCode, input: SavedSearchInput) {
  if ((await FindSavedSearch.countDocuments({ userId })) >= SAVED_SEARCH_MAX_PER_USER) throw new DomainError(`You can save up to ${SAVED_SEARCH_MAX_PER_USER} searches`, 'LIMIT_REACHED', 409);
  const c = input.country ?? country;
  let seenIds: string[] = [];
  if (input.alertNewMatches) seenIds = (await execute(ctx, c, { query: input.query, budgetMax: input.budgetMax, deliverBy: input.deliverBy }, { useAI: false, limit: 48 })).items.map((i) => i.id);
  const doc = await FindSavedSearch.create({ userId, name: input.name, query: input.query, country: c, budgetMax: input.budgetMax, deliverBy: input.deliverBy, alert: { newMatches: input.alertNewMatches, seenIds } });
  return ssView(doc.toObject());
}
export async function updateSavedSearch(userId: string, id: string, patch: Partial<SavedSearchInput>) {
  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) set['name'] = patch.name;
  if (patch.alertNewMatches !== undefined) set['alert.newMatches'] = patch.alertNewMatches;
  const doc = await FindSavedSearch.findOneAndUpdate({ _id: id, userId }, { $set: set }, { new: true }).lean(); // userId in the filter: owner only
  if (!doc) throw notFound('Saved search');
  return ssView(doc);
}
export async function deleteSavedSearch(userId: string, id: string) {
  const r = await FindSavedSearch.deleteOne({ _id: id, userId });
  if (!r.deletedCount) throw notFound('Saved search');
  return { ok: true };
}

/* ------------------------------ price alerts ------------------------------ */
type AlertDoc = { _id: unknown; productId: unknown; country: string; currency: string; active: boolean; baselinePrice: number; targetPrice?: number | null; dropPercent: number; notifyOnDrop: boolean; notifyOnStock: boolean; notifyOnBetterOffer: boolean; lastSeenPrice?: number | null; lastSeenInStock?: boolean | null; lastNotifiedAt?: Date | null; notifiedCount?: number; createdAt?: Date };
const alertView = (a: AlertDoc, p?: FindCandidate | null, emailVerified?: boolean) => ({
  id: String(a._id), productId: String(a.productId), country: a.country, currency: a.currency, active: a.active, baselinePrice: a.baselinePrice, targetPrice: a.targetPrice ?? null,
  dropPercent: a.dropPercent, notifyOnDrop: a.notifyOnDrop, notifyOnStock: a.notifyOnStock, notifyOnBetterOffer: a.notifyOnBetterOffer, lastNotifiedAt: a.lastNotifiedAt ?? null, notifiedCount: a.notifiedCount ?? 0, createdAt: a.createdAt,
  product: p ? { slug: p.slug, title: p.title, image: p.image, price: p.price, inStock: p.stock > 0 } : null,
  ...(emailVerified === undefined ? {} : { emailVerified }),
});

export async function listPriceAlerts(userId: string) {
  const alerts = await FindPriceAlert.find({ userId }).sort({ createdAt: -1 }).limit(PRICE_ALERT_MAX_PER_USER).lean();
  const u = await User.findById(userId).select('emailVerified').lean();
  const out = [];
  for (const a of alerts) {
    const p = await loadOne(String(a.productId), a.country as CountryCode);
    out.push(alertView(a as AlertDoc, p, !!u?.emailVerified));
  }
  return { items: out, limit: PRICE_ALERT_MAX_PER_USER };
}

export async function alertStatus(userId: string, productId: string, country: CountryCode) {
  const a = await FindPriceAlert.findOne({ userId, productId, country, active: true }).lean();
  return { alert: a ? alertView(a as AlertDoc) : null };
}

export async function createPriceAlert(ctx: Ctx, userId: string, country: CountryCode, input: PriceAlertInput) {
  const c = input.country ?? country;
  const p = await loadOne(input.productId, c);
  if (!p) throw notFound('Product');
  const existing = await FindPriceAlert.findOne({ userId, productId: input.productId, country: c });
  if (existing?.active) throw new DomainError('You are already tracking this product', 'ALREADY_TRACKING', 409, { id: String(existing._id) });
  if ((await FindPriceAlert.countDocuments({ userId, active: true })) >= PRICE_ALERT_MAX_PER_USER) throw new DomainError(`You can track up to ${PRICE_ALERT_MAX_PER_USER} products`, 'LIMIT_REACHED', 409);
  const target = input.targetPrice !== undefined ? Math.round(input.targetPrice * 100) : null;
  if (target !== null && target >= p.price) throw new DomainError('Your target price must be below the current price', 'VALIDATION', 400);
  const inStock = p.available && p.stock > 0;
  const fields = {
    userId, productId: input.productId, country: c, currency: p.currency, active: true, baselinePrice: p.price, targetPrice: target, dropPercent: input.dropPercent,
    notifyOnDrop: input.notifyOnDrop, notifyOnStock: input.notifyOnStock, notifyOnBetterOffer: input.notifyOnBetterOffer,
    lastSeenInStock: inStock, lastSeenPrice: p.price, lastNotifiedDropPrice: null, targetNotifiedPrice: null, betterOfferNotifiedId: null, betterOfferNotifiedPrice: null,
  };
  const doc = existing ? await FindPriceAlert.findOneAndUpdate({ _id: existing._id, userId }, { $set: fields }, { new: true }) : await FindPriceAlert.create(fields);
  await recordSnapshot(input.productId, c, { price: p.price, currency: p.currency, inStock }, ctx.now(), 'on_demand');
  const u = await User.findById(userId).select('emailVerified').lean();
  return alertView(doc!.toObject() as AlertDoc, p, !!u?.emailVerified);
}

export async function updatePriceAlert(userId: string, id: string, patch: { targetPrice?: number | null; dropPercent?: number; notifyOnDrop?: boolean; notifyOnStock?: boolean; notifyOnBetterOffer?: boolean; active?: boolean }) {
  const set: Record<string, unknown> = {};
  for (const k of ['dropPercent', 'notifyOnDrop', 'notifyOnStock', 'notifyOnBetterOffer', 'active'] as const) if (patch[k] !== undefined) set[k] = patch[k];
  if (patch.targetPrice !== undefined) { set['targetPrice'] = patch.targetPrice === null ? null : Math.round(patch.targetPrice * 100); set['targetNotifiedPrice'] = null; }
  const doc = await FindPriceAlert.findOneAndUpdate({ _id: id, userId }, { $set: set }, { new: true }).lean(); // owner-only
  if (!doc) throw notFound('Price alert');
  return alertView(doc as AlertDoc);
}
export async function deletePriceAlert(userId: string, id: string) {
  const r = await FindPriceAlert.deleteOne({ _id: id, userId });
  if (!r.deletedCount) throw notFound('Price alert');
  return { ok: true };
}

const messageFor = (e: AlertEvent, title: string, baseline: number, f: (m: number) => string, other?: string): { subject: string; message: string } => {
  switch (e.type) {
    case 'price_drop': return { subject: `Price drop: ${title}`, message: `${title} is now ${f(e.price)} in your country. You started tracking it at ${f(baseline)}.` };
    case 'target_met': return { subject: `Your target price was reached: ${title}`, message: `${title} is now ${f(e.price)}, at or below your target of ${f(e.target)}.` };
    case 'back_in_stock': return { subject: `Back in stock: ${title}`, message: `${title} is available again at ${f(e.price)}. Stock can run out, so we cannot promise how long it will last.` };
    case 'better_offer': return { subject: `A lower-priced similar product to ${title}`, message: `${other ?? 'A similar product'} has an estimated delivered price of ${f(e.price)}, lower than ${title}, with comparable customer ratings. It is a different listing, so please compare the details before you decide.` };
  }
};

/** Scheduled job: evaluate active alerts against live catalogue state; notify only the owner, only verified emails, deduped. */
export async function runPriceAlerts(ctx: Ctx, opts: { limit?: number } = {}): Promise<{ checked: number; sent: number; skippedUnverified: number }> {
  const now = ctx.now();
  const day = now.toISOString().slice(0, 10);
  const alerts = await FindPriceAlert.find({ active: true }).sort({ lastCheckedAt: 1 }).limit(opts.limit ?? 500).lean();
  const users = new Map((await User.find({ _id: { $in: [...new Set(alerts.map((a) => String(a.userId)))] } }).select('email name emailVerified disabled').lean()).map((u) => [String(u._id), u]));
  let sent = 0;
  let skipped = 0;
  for (const a of alerts) {
    try {
      const country = a.country as CountryCode;
      const p = await loadOne(String(a.productId), country);
      const f = fmtMoney(a.currency);
      if (!p) { await FindPriceAlert.updateOne({ _id: a._id }, { $set: { lastCheckedAt: now, lastSeenInStock: false } }); continue; }
      const inStock = p.available && p.stock > 0;
      let better: { productId: string; delivered: number; title: string } | null = null;
      if (a.notifyOnBetterOffer && inStock) {
        const cat = await loadCatalog(country);
        const b = findBetterOffers(p, cat.cands, cat.ship, { limit: 1 })[0];
        if (b) better = { productId: b.cand.id, delivered: b.delivered, title: b.cand.title };
      }
      const { events, next } = decideAlertEvents(
        { baselinePrice: a.baselinePrice, targetPrice: a.targetPrice ?? null, dropPercent: a.dropPercent, notifyOnDrop: a.notifyOnDrop, notifyOnStock: a.notifyOnStock, notifyOnBetterOffer: a.notifyOnBetterOffer, lastSeenInStock: a.lastSeenInStock ?? null, lastNotifiedDropPrice: a.lastNotifiedDropPrice ?? null, targetNotifiedPrice: a.targetNotifiedPrice ?? null, betterOfferNotifiedId: a.betterOfferNotifiedId ?? null, betterOfferNotifiedPrice: a.betterOfferNotifiedPrice ?? null },
        { price: p.price, inStock, betterOffer: better ? { productId: better.productId, delivered: better.delivered } : null },
      );
      const u = users.get(String(a.userId));
      let notified = 0;
      if (events.length && (!u || u.disabled || !u.emailVerified || !u.email)) { skipped++; // consent-aware: never email unverified/unknown addresses; state is NOT advanced so it can still fire after verification
        await FindPriceAlert.updateOne({ _id: a._id }, { $set: { lastCheckedAt: now, lastSeenPrice: p.price } });
        continue;
      }
      for (const e of events) {
        const m = messageFor(e, p.title, a.baselinePrice, f, better?.title);
        const url = `${ctx.cfg.WEB_URL}/p/${e.type === 'better_offer' ? (await loadOne(e.productId, country))?.slug ?? p.slug : p.slug}`;
        const id = await notify(ctx, { template: 'price_alert', to: u!.email, userId: String(a.userId), data: { name: u!.name, subject: m.subject, message: m.message, url }, dedupeKey: alertDedupeKey(String(a._id), e, day) });
        if (id) notified++;
      }
      sent += notified;
      await FindPriceAlert.updateOne({ _id: a._id }, { $set: { ...next, lastCheckedAt: now, lastSeenPrice: p.price, ...(notified ? { lastNotifiedAt: now } : {}) }, ...(notified ? { $inc: { notifiedCount: notified } } : {}) });
    } catch (err) {
      ctx.log.error({ channel: 'app', alert: String(a._id), err: (err as Error).message }, 'price alert evaluation failed');
    }
  }
  return { checked: alerts.length, sent, skippedUnverified: skipped };
}

/** Scheduled job: saved searches with "new matches" alerts; at most one email a day per search, only genuinely new products. */
export async function runSavedSearchAlerts(ctx: Ctx, opts: { limit?: number } = {}): Promise<{ checked: number; sent: number }> {
  const now = ctx.now();
  const day = now.toISOString().slice(0, 10);
  const due = await FindSavedSearch.find({ 'alert.newMatches': true, $or: [{ 'alert.lastCheckedAt': null }, { 'alert.lastCheckedAt': { $lt: new Date(now.getTime() - 20 * 3_600_000) } }] }).limit(opts.limit ?? 200);
  let sent = 0;
  for (const s of due) {
    try {
      const res = await execute(ctx, s.country as CountryCode, { query: s.query, budgetMax: s.budgetMax ?? undefined, deliverBy: s.deliverBy && s.deliverBy >= day ? s.deliverBy : undefined }, { useAI: false, limit: 48 });
      const seen = new Set(s.alert?.seenIds ?? []);
      const fresh = res.items.filter((i) => !seen.has(i.id));
      const u = await User.findById(s.userId).select('email name emailVerified disabled').lean();
      const ok = !!u && !u.disabled && u.emailVerified && !!u.email;
      let notified = false;
      if (fresh.length && ok) {
        const names = fresh.slice(0, 3).map((i) => i.title).join(', ');
        const id = await notify(ctx, { template: 'price_alert', to: u.email, userId: String(s.userId), data: { name: u.name, subject: `New matches for “${s.name}”`, message: `${fresh.length} new product${fresh.length === 1 ? '' : 's'} match your saved search “${s.query}”, for example ${names}.`, url: `${ctx.cfg.WEB_URL}/find?q=${encodeURIComponent(s.query)}` }, dedupeKey: `find:ss:${String(s._id)}:${day}` });
        notified = !!id;
        if (notified) sent++;
      }
      const keep = ok && fresh.length && !notified ? s.alert?.seenIds ?? [] : [...new Set([...res.items.map((i) => i.id), ...(s.alert?.seenIds ?? [])])].slice(0, 300);
      await FindSavedSearch.updateOne({ _id: s._id }, { $set: { 'alert.lastCheckedAt': now, 'alert.seenIds': keep, ...(notified ? { 'alert.lastNotifiedAt': now } : {}) } });
    } catch (err) {
      ctx.log.error({ channel: 'app', savedSearch: String(s._id), err: (err as Error).message }, 'saved search alert failed');
    }
  }
  return { checked: due.length, sent };
}

