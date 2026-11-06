/** Catalogue ingestion, human-approved product matching, quote comparison, and CSV offer updates for manual suppliers. */
import { Product, Supplier, SupplierOffer, SupplierProduct, SuppliernetCatalogItem, SuppliernetIngestionJob, SuppliernetMatchCandidate, SuppliernetSlaSnapshot } from '@orvia/database';
import { parseCsv, parseMoney } from '@orvia/suppliers';
import { convertMinor } from '@orvia/types';
import type { CountryCode, Currency } from '@orvia/types';
import { audit } from '../../infra/audit';
import { DomainError, notFound } from '../../infra/context';
import type { Actor, Ctx } from '../../infra/context';
import { usableImages } from '../images';
import { compareSuppliers, syncProductOffers } from '../offers';
import { refreshProductMarkets } from '../pricing';
import { invalidateSearchIndex } from '../search';
import { fulfillmentModeOf, setManualOffer } from '../supplierOps';
import { providerFor, servesCountry, supplierRoutable } from '../supplierAccess';
import { fetchLiveOffer } from '@orvia/suppliers';
import { normalizeGtin, normalizeTitle, rankMatches } from './matching';
import type { MatchItem } from './matching';
import { toSlaFacts } from './sla';

const objId = (v: unknown) => String(v);

/* -------------------------------- ingestion -------------------------------- */
export async function ingestSupplierCatalog(ctx: Ctx, supplierId: string, o: { trigger: 'manual' | 'schedule' | 'upload'; actor: Actor; maxItems?: number }) {
  const sup = await Supplier.findById(supplierId);
  if (!sup) throw notFound('Supplier');
  const job = await SuppliernetIngestionJob.create({ supplierId, trigger: o.trigger, status: 'running', startedAt: ctx.now(), startedBy: o.actor.id });
  const maxItems = Math.min(o.maxItems ?? 500, 2000);
  try {
    const provider = await providerFor(ctx, sup);
    let cursor: string | undefined;
    let seen = 0, created = 0, updated = 0, rejected = 0;
    const rowErrors: string[] = [];
    for (let page = 0; page < 40 && seen < maxItems; page++) {
      const r = await provider.searchProducts({ limit: 50, cursor });
      for (const it of r.items) {
        if (seen >= maxItems) break;
        seen++;
        if (!it.externalId || !it.title) { rejected++; if (rowErrors.length < 20) rowErrors.push(`Row without id/title skipped`); continue; }
        const existing = await SupplierProduct.findOne({ supplierId, externalId: it.externalId }).select('_id').lean();
        const sp = await SupplierProduct.findOneAndUpdate(
          { supplierId, externalId: it.externalId },
          { $set: { title: it.title, description: it.description, images: usableImages(it.images), category: it.category, variants: it.variants, cost: it.baseCostUsd, currency: 'USD', lastSyncAt: ctx.now() }, $setOnInsert: { importStatus: 'new' } },
          { upsert: true, new: true },
        );
        if (existing) updated++; else created++;
        const a = it.attributes ?? {};
        await SuppliernetCatalogItem.updateOne({ supplierId, externalId: it.externalId }, { $set: { supplierProductId: sp!._id, title: it.title, normalizedTitle: normalizeTitle(it.title), brand: a['brand'] ?? a['Brand'], gtin: normalizeGtin(a['gtin'] ?? a['ean'] ?? a['upc']) ?? undefined, mpn: a['mpn'], category: it.category, attributes: a, priceMinor: it.baseCostUsd, currency: 'USD', lastSeenAt: ctx.now() } }, { upsert: true });
      }
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    const candidates = await generateCandidates(ctx, supplierId, { limit: 200 });
    await SuppliernetIngestionJob.updateOne({ _id: job._id }, { $set: { status: 'completed', finishedAt: ctx.now(), seen, created, updated, rejected, candidates, rowErrors } });
    await audit(ctx, o.actor, { action: 'suppliernet.catalogue_ingested', resource: 'supplier', resourceId: supplierId, newValue: { seen, created, updated, rejected, candidates } });
    return { jobId: objId(job._id), seen, created, updated, rejected, candidates, rowErrors };
  } catch (e) {
    await SuppliernetIngestionJob.updateOne({ _id: job._id }, { $set: { status: 'failed', finishedAt: ctx.now(), error: (e as Error).message.slice(0, 500) } });
    throw e;
  }
}

/* -------------------------------- matching --------------------------------- */
export async function generateCandidates(_ctx: Ctx, supplierId: string, o: { limit?: number } = {}): Promise<number> {
  const unlinked = await SupplierProduct.find({ supplierId, productId: { $exists: false } }).sort({ lastSyncAt: -1 }).limit(o.limit ?? 200).lean();
  if (!unlinked.length) return 0;
  const products = await Product.find({ state: { $nin: ['BANNED', 'ARCHIVED'] } }).select('title brand category attributes').limit(3000).lean();
  const links = await SupplierProduct.find({ productId: { $in: products.map((p) => p._id) } }).select('productId').limit(10_000).lean();
  const ids = await SuppliernetCatalogItem.find({ supplierProductId: { $in: links.map((l) => l._id) } }).select('supplierProductId gtin mpn brand imageHashes').lean();
  const spToProduct = new Map(links.map((l) => [objId(l._id), objId(l.productId)]));
  const idByProduct = new Map<string, { gtin?: string; mpn?: string; brand?: string; imageHashes: string[] }>();
  for (const c of ids) {
    const pid = spToProduct.get(objId(c.supplierProductId));
    if (!pid) continue;
    const cur = idByProduct.get(pid) ?? { imageHashes: [] };
    idByProduct.set(pid, { gtin: cur.gtin ?? c.gtin ?? undefined, mpn: cur.mpn ?? c.mpn ?? undefined, brand: cur.brand ?? c.brand ?? undefined, imageHashes: [...cur.imageHashes, ...(c.imageHashes ?? [])] });
  }
  const targets = products.map((p) => {
    const x = idByProduct.get(objId(p._id));
    const attrs = p.attributes ? Object.fromEntries(p.attributes as unknown as Map<string, string>) : {};
    const item: MatchItem = { title: p.title, brand: x?.brand ?? (p.brand && p.brand !== 'Orvia' ? p.brand : undefined), gtin: x?.gtin, mpn: x?.mpn, category: p.category, attributes: attrs, imageHashes: x?.imageHashes };
    return { id: objId(p._id), item };
  });
  let made = 0;
  const catalog = await SuppliernetCatalogItem.find({ supplierId, supplierProductId: { $in: unlinked.map((u) => u._id) } }).lean();
  const catBySp = new Map(catalog.map((c) => [objId(c.supplierProductId), c]));
  for (const sp of unlinked) {
    const c = catBySp.get(objId(sp._id));
    const source: MatchItem = { title: sp.title ?? '', brand: c?.brand, gtin: c?.gtin, mpn: c?.mpn, category: sp.category, attributes: (c?.attributes as Record<string, string> | undefined) ?? undefined, imageHashes: c?.imageHashes };
    for (const r of rankMatches(source, targets, { minScore: 0.55, limit: 3 })) {
      await SuppliernetMatchCandidate.updateOne(
        { supplierProductId: sp._id, productId: r.target.id },
        { $set: { supplierId }, $setOnInsert: { status: 'pending' } },
        { upsert: true },
      );
      await SuppliernetMatchCandidate.updateOne({ supplierProductId: sp._id, productId: r.target.id, status: 'pending' }, { $set: { score: r.score, confidence: r.confidence, reasons: r.reasons, conflicts: r.conflicts } });
      made++;
    }
  }
  return made;
}

export async function decideMatch(ctx: Ctx, candidateId: string, decision: 'approve' | 'reject', note: string | undefined, actor: Actor) {
  const c = await SuppliernetMatchCandidate.findById(candidateId);
  if (!c) throw notFound('Match candidate');
  if (c.status !== 'pending') throw new DomainError(`Candidate already ${c.status}`, 'CONFLICT', 409);
  if (decision === 'reject') {
    c.status = 'rejected'; c.decidedBy = actor.id; c.decidedAt = ctx.now(); c.note = note; await c.save();
    await audit(ctx, actor, { action: 'suppliernet.match_rejected', resource: 'product', resourceId: objId(c.productId), newValue: { candidateId } });
    return { status: 'rejected' as const };
  }
  const sp = await SupplierProduct.findById(c.supplierProductId);
  if (!sp) throw notFound('Supplier product');
  if (sp.productId) throw new DomainError('This supplier product is already linked to a product', 'CONFLICT', 409);
  if (await SupplierProduct.exists({ productId: c.productId, supplierId: c.supplierId })) throw new DomainError('This product is already sourced from that supplier', 'CONFLICT', 409);
  sp.productId = c.productId;
  sp.importStatus = 'imported';
  await sp.save();
  c.status = 'approved'; c.decidedBy = actor.id; c.decidedAt = ctx.now(); c.note = note; await c.save();
  await SuppliernetMatchCandidate.updateMany({ supplierProductId: sp._id, status: 'pending' }, { $set: { status: 'rejected', decidedBy: 'system', decidedAt: ctx.now(), note: 'Another candidate was approved for this supplier product' } });
  const sync = await syncProductOffers(ctx, objId(c.productId));
  const markets = await refreshProductMarkets(ctx, objId(c.productId));
  invalidateSearchIndex();
  await audit(ctx, actor, { action: 'suppliernet.match_approved', resource: 'product', resourceId: objId(c.productId), newValue: { candidateId, supplierId: objId(c.supplierId), externalId: sp.externalId, score: c.score } });
  return { status: 'approved' as const, sync, markets: Array.isArray(markets) ? markets.length : undefined };
}

/* ----------------------------- quote comparison ----------------------------- */
export type Freshness = 'live' | 'fresh' | 'stale' | 'unknown';
export function freshnessLabel(asOf: Date | null | undefined, now: Date, staleAfterMinutes: number, live = false): { label: Freshness; ageMinutes: number | null } {
  if (live) return { label: 'live', ageMinutes: 0 };
  if (!asOf) return { label: 'unknown', ageMinutes: null };
  const age = Math.max(0, Math.round((now.getTime() - asOf.getTime()) / 60_000));
  return { label: age <= staleAfterMinutes ? 'fresh' : 'stale', ageMinutes: age };
}

export async function compareQuotes(ctx: Ctx, productId: string, country: CountryCode, o: { live: boolean }) {
  const sourcing = await ctx.settings.get('sourcing');
  const fx = (await ctx.settings.get('ops')).fx;
  const links = await SupplierProduct.find({ productId }).limit(20).lean();
  const sups = await Supplier.find({ _id: { $in: links.map((l) => l.supplierId) } }).lean();
  const offers = await SupplierOffer.find({ productId, destination: country }).limit(50).lean();
  let ranked: Awaited<ReturnType<typeof compareSuppliers>> | null = null;
  try { ranked = await compareSuppliers(ctx, productId, country); } catch { ranked = null; }
  const snaps = await SuppliernetSlaSnapshot.find({ supplierId: { $in: sups.map((s) => s._id) } }).sort({ computedAt: -1 }).limit(100).lean();
  const now = ctx.now();
  const rows = [];
  for (const link of links) {
    const s = sups.find((x) => objId(x._id) === objId(link.supplierId));
    if (!s) continue;
    const serves = servesCountry(s, country);
    const stored = offers.find((x) => objId(x.supplierId) === objId(s._id));
    const snap = snaps.find((x) => objId(x.supplierId) === objId(s._id));
    const gate = supplierRoutable(ctx, s);
    const base = { supplierId: objId(s._id), supplierCode: s.code, supplierName: s.name, provider: s.provider, onboardingState: s.network?.state ?? null, productionReady: !!s.network?.productionReady, routableInProduction: gate.ok, routingBlock: gate.reason ?? null, servesDestination: serves, sla: toSlaFacts(objId(s._id), (snap ?? null) as never), mode: fulfillmentModeOf(s) };
    type OfferData = { productCost: number; shippingCost: number; fulfillmentFee: number; currency: Currency; minDays: number; maxDays: number; stock: number; available: boolean };
    let live: OfferData | null = null;
    let liveError: string | null = null;
    if (o.live && serves && s.active && s.healthState !== 'FAILING') {
      try { live = (await fetchLiveOffer(await providerFor(ctx, s), link.externalId, country, 1, link.variants?.[0]?.sku ?? undefined)) as OfferData; } catch (e) { liveError = (e as Error).message.slice(0, 200); }
    }
    const d = live ?? (stored ? { productCost: stored.productCost, shippingCost: stored.shippingCost, fulfillmentFee: stored.fulfillmentFee, currency: stored.currency as Currency, minDays: stored.minDays, maxDays: stored.maxDays, stock: stored.stock, available: stored.available } : null);
    const asOf = live ? now : stored ? (stored.source === 'manual' ? stored.confirmedAt : stored.syncedAt) ?? null : null;
    const fr = freshnessLabel(asOf, now, sourcing.staleAfterMinutes, !!live);
    const total = d ? d.productCost + d.shippingCost + d.fulfillmentFee : null;
    const rk = ranked?.rows.find((r) => r.supplierId === objId(s._id));
    rows.push({
      ...base, offer: d && { ...d, totalMinor: total, totalUsdMinor: total === null ? null : convertMinor(total, d.currency, 'USD', fx) },
      freshness: { source: live ? 'live' : stored?.source === 'manual' ? 'manual_entry' : stored ? 'stored_sync' : 'none', asOf, ...fr },
      liveError, ranking: rk ? (rk as unknown as { expectedProfit?: number; cxScore?: number; eligible?: boolean }) && { expectedProfit: (rk as unknown as { expectedProfit?: number }).expectedProfit, cxScore: rk.cxScore, eligible: (rk as unknown as { eligible?: boolean }).eligible } : null,
    });
  }
  rows.sort((a, b) => (a.offer?.totalUsdMinor ?? Infinity) - (b.offer?.totalUsdMinor ?? Infinity));
  return { productId, country, live: o.live, generatedAt: now, rows, recommendation: ranked?.recommendation ?? null, note: 'Prices are each supplier’s own quote; freshness shows how old each datum is. Reliability comes from measured SLA facts, which are "insufficient data" until enough orders exist.' };
}

/* ------------------------- manual supplier CSV offers ----------------------- */
/** Supplier/operator CSV: external_id, price, shipping, stock, min_days, max_days[, currency]. Manual suppliers only. */
export async function applyOfferCsv(ctx: Ctx, supplierId: string, csv: string, actor: Actor) {
  const sup = await Supplier.findById(supplierId);
  if (!sup) throw notFound('Supplier');
  if (sup.provider !== 'manual') throw new DomainError('CSV price/stock uploads are only for manual suppliers; API and feed suppliers are refreshed from their own source', 'VALIDATION', 409);
  const parsed = parseCsv(csv, { maxRows: 1000 });
  const need = ['external_id', 'price', 'stock'];
  const header = parsed.header.map((h) => h.toLowerCase());
  const miss = need.filter((n) => !header.includes(n));
  if (miss.length) throw new DomainError(`Missing column(s): ${miss.join(', ')}`, 'VALIDATION', 422);
  const countries = (sup.servesCountries?.length ? sup.servesCountries : ['US', 'CA', 'IN']).filter((c) => ['US', 'CA', 'IN'].includes(c)) as CountryCode[];
  const errors: string[] = [...parsed.errors];
  let applied = 0;
  const get = (r: Record<string, string>, k: string) => r[parsed.header[header.indexOf(k)] ?? ''] ?? '';
  for (const [i, r] of parsed.rows.entries()) {
    const line = i + 2;
    const ext = get(r, 'external_id');
    const price = parseMoney(get(r, 'price'), 'major');
    const ship = header.includes('shipping') && get(r, 'shipping') ? parseMoney(get(r, 'shipping'), 'major') : 0;
    const stock = /^\d{1,7}$/.test(get(r, 'stock')) ? Number(get(r, 'stock')) : null;
    const cur = (get(r, 'currency') || 'USD').toUpperCase();
    const minD = header.includes('min_days') && get(r, 'min_days') ? Number(get(r, 'min_days')) : 7;
    const maxD = header.includes('max_days') && get(r, 'max_days') ? Number(get(r, 'max_days')) : 14;
    if (!ext || price === null || ship === null || stock === null || !['USD', 'CAD', 'INR'].includes(cur) || !Number.isInteger(minD) || !Number.isInteger(maxD) || maxD < minD || minD < 0) { errors.push(`Row ${line}: invalid values`); continue; }
    const sp = await SupplierProduct.findOne({ supplierId, externalId: ext }).select('productId').lean();
    if (!sp?.productId) { errors.push(`Row ${line}: ${ext} is not linked to an ORVIA product`); continue; }
    try {
      await setManualOffer(ctx, { productId: objId(sp.productId), supplierId, externalId: ext, countries, currency: cur as 'USD' | 'CAD' | 'INR', productCost: price, shippingCost: ship, stock, minDays: minD, maxDays: maxD, warehouseCountry: countries[0] ?? 'US' }, actor);
      applied++;
    } catch (e) { errors.push(`Row ${line}: ${(e as Error).message}`); }
  }
  return { applied, rejected: parsed.rows.length - applied, errors: errors.slice(0, 50) };
}
