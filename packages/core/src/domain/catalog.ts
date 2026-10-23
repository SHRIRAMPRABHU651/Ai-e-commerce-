import { Product, ProductVariant, Category } from '@orvia/database';
import { effectiveImages, hasUsableImage } from './images';
import { claimViolations } from './organic';
import { CATEGORY_TREE, PRODUCT_TRANSITIONS, SELLABLE_STATES, slugify } from '@orvia/types';
import type { CountryCode, ProductState } from '@orvia/types';
import { audit } from '../infra/audit';
import { DomainError, notFound } from '../infra/context';
import type { Actor, Ctx } from '../infra/context';
import { evaluateMarket } from './economics';
import type { MarketScenarioView } from './economics';
import { exportGate, exportGateMessage } from './exportGate';

export async function ensureCategories(): Promise<void> {
  let pos = 0;
  for (const top of CATEGORY_TREE) {
    await Category.updateOne({ slug: top.slug }, { $set: { name: top.name, path: [top.slug], dynamic: 'dynamic' in top ? !!top.dynamic : false, position: pos++ } }, { upsert: true });
    let cp = 0;
    for (const child of top.children) {
      const slug = slugify(child);
      await Category.updateOne({ slug }, { $set: { name: child, parentSlug: top.slug, path: [top.slug, slug], position: cp++ } }, { upsert: true });
    }
  }
}

export async function uniqueSlug(title: string): Promise<string> {
  const base = slugify(title).slice(0, 70) || 'product';
  let slug = base;
  for (let i = 2; await Product.exists({ slug }); i++) slug = `${base}-${i}`;
  return slug;
}

export function categorySlugFor(name: string): { category: string; topCategory: string } {
  const slug = slugify(name);
  for (const top of CATEGORY_TREE) {
    if (top.children.some((c) => slugify(c) === slug)) return { category: slug, topCategory: top.slug };
  }
  return { category: slug, topCategory: 'gadgets' };
}

export async function transitionProduct(ctx: Ctx, productId: string, to: ProductState, actor: Actor, reason: string): Promise<void> {
  const p = await Product.findById(productId);
  if (!p) throw notFound('Product');
  const from = p.state as ProductState;
  if (from === to) return;
  if (!PRODUCT_TRANSITIONS[from].includes(to)) throw new DomainError(`Illegal product transition ${from} → ${to}`, 'ILLEGAL_TRANSITION', 409);
  p.state = to;
  p.stateHistory.push({ state: to, at: new Date(), by: actor.id, reason });
  await p.save();
  await audit(ctx, actor, { action: 'product.transition', resource: 'product', resourceId: productId, previousValue: from, newValue: to, reason });
}

export const isSellable = (state: string): boolean => (SELLABLE_STATES as readonly string[]).includes(state);

export interface PublishCheck {
  ok: boolean;
  /** Everything blocking this publish for THIS caller (includes the approval requirement when not approved). */
  problems: string[];
  /** Blockers a human cannot waive (compliance, content, margin, export attestation). */
  hardProblems: string[];
  /** True when acquisition cost is only assumed for a live market: auto-publishing is forbidden, a person must approve. */
  needsHumanApproval: boolean;
  /** Risks that do not block: e.g. margin collapses at the pessimistic CAC. */
  warnings: string[];
  scenarios: MarketScenarioView[];
}

/**
 * Hard publish gates: compliance passed, content, media, at least one priced + stocked market whose
 * EXPECTED-case contribution (acquisition cost = measured CPA, else the configured expected share of price)
 * clears `minMarginPct`. If acquisition cost is only assumed, a person must approve: pass `humanApproved`
 * only from a path that is a person's explicit decision.
 */
export async function canPublish(ctx: Ctx, productId: string, opts: { humanApproved?: boolean } = {}): Promise<PublishCheck> {
  const p = await Product.findById(productId).lean();
  if (!p) throw notFound('Product');
  const hard: string[] = [];
  if (p.compliance?.status !== 'passed') hard.push(`Compliance status is "${p.compliance?.status ?? 'pending'}"`);
  if (!hasUsableImage((p.images ?? []).map((i) => i.url)) && !(p.markets ?? []).some((m) => m.enabled && hasUsableImage(m.images))) hard.push('No product image from the supplier — products without a real photo cannot be sold');
  if (!p.description || p.description.length < 20) hard.push('Missing description');
  const violations = claimViolations(p as never);
  if (violations.length) hard.push(`Unverified claim${violations.length > 1 ? 's' : ''} in the listing (${[...new Set(violations.map((v) => `"${v.match.toLowerCase()}" in ${v.field}`))].slice(0, 4).join(', ')}) — add verified certification evidence or remove the wording`);
  const pricing = await ctx.settings.get('pricing');
  const live = (p.markets ?? []).filter((m) => m.enabled && m.price > 0);
  if (!live.length) hard.push('No priced market');
  const warnings: string[] = [];
  const scenarios: MarketScenarioView[] = [];
  const assumedIn: string[] = [];
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  for (const m of live) {
    const gate = await exportGate(ctx, m.country);
    if (gate.required && !gate.attested) hard.push(exportGateMessage(m.country));
    if (!(m.landedCost > 0)) {
      hard.push(`No landed cost for ${m.country} — contribution cannot be evaluated`);
      continue;
    }
    const v = await evaluateMarket(ctx, m);
    scenarios.push(v);
    const exp = v.scenarios.expected;
    if (exp.margin < pricing.minMarginPct - 1e-9) {
      hard.push(`Expected-case margin ${pct(exp.margin)} is below the ${pct(pricing.minMarginPct)} minimum in ${m.country} (CAC ${pct(exp.cac / m.price)} of price, ${v.cpaSource === 'assumed' ? 'assumed' : `${v.cpaSource}, n=${v.cpaSampleSize}`})`);
    }
    const pes = v.scenarios.pessimistic;
    if (pes.profit < 0) warnings.push(`Loses money at pessimistic CAC in ${m.country}: ${pct(pes.margin)} margin at CAC ${pct(pes.cac / m.price)} of price`);
    else if (pes.margin < pricing.minMarginPct - 1e-9) warnings.push(`Below the ${pct(pricing.minMarginPct)} minimum at pessimistic CAC in ${m.country}: ${pct(pes.margin)} at CAC ${pct(pes.cac / m.price)} of price`);
    if (v.cpaSource === 'assumed') assumedIn.push(m.country);
  }
  const needsHumanApproval = assumedIn.length > 0;
  const problems = [...hard];
  if (needsHumanApproval && !opts.humanApproved) problems.push(`Acquisition cost in ${assumedIn.join(', ')} is assumed, not measured — a person must explicitly approve publishing`);
  return { ok: problems.length === 0, problems, hardProblems: hard, needsHumanApproval, warnings, scenarios };
}

export async function publishProduct(ctx: Ctx, productId: string, actor: Actor, reason = 'published', opts: { humanApproved?: boolean } = {}): Promise<void> {
  // Only a person's own action counts as approval; AI / system / webhook actors never do.
  const check = await canPublish(ctx, productId, { humanApproved: actor.type === 'user' || !!opts.humanApproved });
  if (!check.ok) throw new DomainError(`Cannot publish: ${check.problems.join('; ')}`, 'PUBLISH_BLOCKED', 422, check.problems);
  const p = await Product.findById(productId);
  if (!p) throw notFound('Product');
  if (p.state === 'ARCHIVED' || p.state === 'PAUSED' || p.state === 'OUT_OF_STOCK') {
    await transitionProduct(ctx, productId, 'PUBLISHED', actor, reason);
    return;
  }
  if (p.state !== 'DRAFT') {
    // walk the lifecycle: DISCOVERED -> ANALYZING -> APPROVED -> DRAFT -> PUBLISHED
    const chain: ProductState[] = ['DISCOVERED', 'ANALYZING', 'APPROVED', 'DRAFT'];
    const idx = chain.indexOf(p.state as ProductState);
    if (idx === -1) throw new DomainError(`Cannot publish from state ${p.state}`, 'ILLEGAL_TRANSITION', 409);
    for (const s of chain.slice(idx + 1)) await transitionProduct(ctx, productId, s, actor, 'auto-advance for publish');
  }
  await transitionProduct(ctx, productId, 'PUBLISHED', actor, reason);
}

export interface StoreProduct {
  id: string;
  slug: string;
  title: string;
  brand: string;
  description: string;
  bullets: string[];
  features: string[];
  benefits: string[];
  faqs: { q: string; a: string }[];
  images: { url: string; alt?: string; card?: string; thumb?: string; zoom?: string }[];
  category: string;
  topCategory: string;
  attributes: Record<string, string>;
  rating: { avg: number; count: number };
  sold: number;
  trendScore: number;
  state: string;
  price: number | null;
  compareAtPrice: number | null;
  currency: string;
  discountPct: number;
  available: boolean;
  stock: number;
  lowStock: boolean;
  shipsFrom: string | null;
  minDays: number | null;
  maxDays: number | null;
  returnWindowDays?: number;
  seo: { title?: string | null; metaDescription?: string | null };
  safety?: { standards: string[]; ageRange?: string | null };
  createdAt: string;
}

export const loadLeanProduct = (id: string) => Product.findById(id).lean();
type LeanProduct = Awaited<ReturnType<typeof loadLeanProduct>>;

/** Customer-facing projection for a country. Never exposes cost, supplier or margin data. */
export function toStoreProduct(p: NonNullable<LeanProduct>, country: CountryCode, returnWindowDays?: number): StoreProduct {
  const m = (p.markets ?? []).find((x) => x.country === country && x.enabled);
  const imgs = effectiveImages(p as never, country);
  const available = !!m && m.price > 0 && (m.stock ?? 0) > 0 && isSellable(p.state) && imgs.length > 0;
  const attrs = p.attributes ? Object.fromEntries(Object.entries(p.attributes as unknown as Record<string, string>)) : {};
  return {
    id: String(p._id),
    slug: p.slug,
    title: p.title,
    brand: p.brand ?? 'Orvia',
    description: p.description ?? '',
    bullets: p.bullets ?? [],
    features: p.features ?? [],
    benefits: p.benefits ?? [],
    faqs: (p.faqs ?? []).map((f) => ({ q: f.q ?? '', a: f.a ?? '' })),
    images: imgs,
    category: p.category ?? '',
    topCategory: p.topCategory ?? '',
    attributes: attrs,
    rating: { avg: p.stats?.ratingAvg ?? 0, count: p.stats?.ratingCount ?? 0 },
    sold: p.stats?.soldCount ?? 0,
    trendScore: p.stats?.trendScore ?? 0,
    state: p.state,
    price: m?.price ?? null,
    compareAtPrice: m && m.compareAtPrice > m.price ? m.compareAtPrice : null,
    currency: m?.currency ?? '',
    discountPct: m && m.compareAtPrice > m.price ? Math.round((1 - m.price / m.compareAtPrice) * 100) : 0,
    available,
    stock: Math.min(m?.stock ?? 0, 99),
    lowStock: !!m && (m.stock ?? 0) > 0 && (m.stock ?? 0) <= 10,
    shipsFrom: m?.shipsFrom ?? null,
    minDays: m?.minDays ?? null,
    maxDays: m?.maxDays ?? null,
    returnWindowDays,
    seo: { title: p.seo?.title, metaDescription: p.seo?.metaDescription },
    safety: p.compliance?.safetyInfo?.standards?.length ? { standards: p.compliance.safetyInfo.standards, ageRange: p.compliance.safetyInfo.ageRange } : undefined,
    createdAt: (p as unknown as { createdAt?: Date }).createdAt?.toISOString() ?? '',
  };
}

export async function getVariants(productId: string) {
  return ProductVariant.find({ productId, active: true }).select('sku label options image priceDelta').limit(60).lean();
}
