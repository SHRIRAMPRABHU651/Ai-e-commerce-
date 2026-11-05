/**
 * ORVIA Find: ranking, filtering and "why matched" over plain candidate objects. PURE.
 * Every reason in `whyMatched` is built from a real matched field or an applied filter; nothing is invented.
 */
import { NEEDS, needBySlug } from '@orvia/types';
import type { DeliveryFit, WhyMatched } from '@orvia/types';
import { addDays, diffDays, formatYmd } from './dates';
import type { Ymd } from './dates';
import { CATEGORY_DEFS, stem } from './intent';
import type { ParsedIntent, SortIntent } from './intent';
import type { SemanticIndex } from './semantic';
import { editDistance } from './text';


export interface FindCandidate {
  id: string;
  slug: string;
  title: string;
  brand: string;
  image: string | null;
  /** sub-category slug */
  category: string;
  topCategory: string;
  tags: string[];
  keywords: string[];
  description: string;
  attributes: Record<string, string>;
  /** minor units of `currency` */
  price: number;
  currency: string;
  stock: number;
  rating: { avg: number; count: number };
  sold: number;
  trend: number;
  minDays: number | null;
  maxDays: number | null;
  ageRange?: string | null;
}

export interface ShippingFee {
  fee: number;
  freeOver: number | null;
}
/** Item price plus the standard shipping fee for a single-item basket, before tax/duty. An estimate, not a quote. */
export const deliveredEstimate = (price: number, ship: ShippingFee | null | undefined): number =>
  price + (ship && !(ship.freeOver !== null && price >= ship.freeOver) ? ship.fee : 0);

/** Reviews below this count are shown but never used to rank or award "highest rated". */
export const MIN_RATING_COUNT = 3;

/* ------------------------------ delivery honesty ------------------------------ */
export interface DeliveryAssessment {
  fit: DeliveryFit;
  /** the order cannot arrive by the date even in the best case: exclude */
  impossible: boolean;
  earliest: Ymd | null;
  latest: Ymd | null;
}
/**
 * Compares the product's own honest delivery window (min/max days from ordering today) with the customer's date.
 * `ok` still only means "the estimate window ends on or before your date"; delivery is never guaranteed.
 */
export function assessDelivery(today: Ymd, deadline: Ymd | null, minDays: number | null, maxDays: number | null): DeliveryAssessment {
  const hi = maxDays ?? minDays;
  const lo = minDays ?? maxDays;
  const earliest = lo === null ? null : addDays(today, lo);
  const latest = hi === null ? null : addDays(today, hi);
  if (!deadline) return { fit: 'ok', impossible: false, earliest, latest };
  if (latest === null || earliest === null) return { fit: 'unknown', impossible: false, earliest, latest };
  if (earliest > deadline) return { fit: 'may_not_arrive', impossible: true, earliest, latest };
  if (latest > deadline) return { fit: 'may_not_arrive', impossible: false, earliest, latest };
  return { fit: 'ok', impossible: false, earliest, latest };
}

/** "3+", "3-8", "3 to 8 years", "6 months+" -> { min, max } in years; null when unparseable. */
export function parseAgeRange(s: string | null | undefined): { min: number; max: number | null } | null {
  if (!s) return null;
  const t = s.toLowerCase();
  const months = /month/.test(t);
  const f = (n: number) => (months ? n / 12 : n);
  let m = t.match(/(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})/);
  if (m) return { min: f(Number(m[1])), max: f(Number(m[2])) };
  m = t.match(/(\d{1,2})\s*\+/) ?? t.match(/(?:ages?|from|over|above)\s*(\d{1,2})/);
  if (m) return { min: f(Number(m[1])), max: null };
  return null;
}

/* ------------------------------ ontology ------------------------------ */
const SYN_GROUPS: string[][] = [
  ['dog', 'puppy', 'canine', 'pup'],
  ['cat', 'kitten', 'feline'],
  ['toy', 'plaything'],
  ['phone', 'mobile', 'smartphone', 'cellphone'],
  ['kid', 'child', 'children', 'toddler'],
  ['baby', 'infant', 'newborn'],
  ['desk', 'workspace'],
  ['bag', 'backpack', 'tote', 'handbag'],
  ['cozy', 'cosy', 'comfy'],
  ['travel', 'portable'],
  ['personalized', 'personalised', 'custom', 'customized', 'customised', 'engraved'],
  ['organiz', 'storage'],
  ['gift', 'present'],
  ['leash', 'lead'],
  ['wood', 'wooden'],
  ['bottle', 'flask'],
  ['hair', 'fur'],
  ['brush', 'comb', 'groom'],
  ['feed', 'bowl'],
  ['light', 'lamp', 'led'],
  ['sleep', 'bed', 'pillow'],
  ['puzzle', 'brain'],
  ['chew', 'teether'],
  ['shirt', 'tshirt', 'tee'],
  ['jewelry', 'jewellery'],
  ['aluminum', 'aluminium'],
].map((g) => g.map(stem));
const SYN = new Map<string, Set<string>>();
for (const g of SYN_GROUPS) for (const w of g) SYN.set(w, new Set([...(SYN.get(w) ?? []), ...g.filter((x) => x !== w)]));

const toks = (s: string): string[] => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length > 1).map(stem);

interface Prepared {
  c: FindCandidate;
  title: Set<string>;
  tags: Set<string>;
  attrs: Set<string>;
  cat: Set<string>;
  desc: Set<string>;
  titleLc: string;
}
const prepCache = new WeakMap<FindCandidate, Prepared>();
function prepare(c: FindCandidate): Prepared {
  let hit = prepCache.get(c);
  if (!hit) { hit = build(c); prepCache.set(c, hit); }
  return hit;
}
function build(c: FindCandidate): Prepared {
  return {
    c,
    title: new Set(toks(`${c.title} ${c.brand}`)),
    tags: new Set(toks([...c.tags, ...c.keywords].join(' '))),
    attrs: new Set(toks(Object.values(c.attributes).join(' '))),
    cat: new Set(toks(`${c.category.replace(/-/g, ' ')} ${c.topCategory}`)),
    desc: new Set(toks(c.description.slice(0, 600))),
    titleLc: c.title.toLowerCase(),
  };
}

interface TermHit { weight: number; where: string }
function matchTerm(p: Prepared, term: string): TermHit | null {
  const t = stem(term);
  const fields: [Set<string>, number, string][] = [[p.title, 10, 'the title'], [p.tags, 6, 'its tags'], [p.attrs, 6, 'its attributes'], [p.cat, 5, 'its category'], [p.desc, 2, 'the description']];
  for (const [set, w, where] of fields) if (set.has(t)) return { weight: w, where };
  const syns = SYN.get(t);
  if (syns) for (const [set, w, where] of fields) for (const s of syns) if (set.has(s)) return { weight: w * 0.7, where: `${where} (as “${s}”)` };
  if (t.length >= 5) {
    for (const [set, w, where] of fields.slice(0, 3)) for (const x of set) if (Math.abs(x.length - t.length) <= 1 && editDistance(t, x, 1) <= 1) return { weight: w * 0.5, where: `${where} (close spelling of “${x}”)` };
  }
  return null;
}

/* ------------------------------ ranking ------------------------------ */
export interface RankOptions {
  today: Ymd;
  /** minor units of the market currency; already converted */
  budget?: { min?: number; max?: number } | null;
  deadline?: Ymd | null;
  sort: SortIntent;
  minRating?: number;
  ship?: ShippingFee | null;
  semantic?: SemanticIndex;
  limit?: number;
  /** include products that cannot arrive in time (flagged) instead of excluding them */
  keepLate?: boolean;
}
export interface RankedItem {
  cand: FindCandidate;
  score: number;
  whyMatched: WhyMatched[];
  deliveryFit: DeliveryFit;
  latestArrival: Ymd | null;
  delivered: number;
}
export interface RankResult {
  items: RankedItem[];
  total: number;
  excluded: { tooLate: number; overBudget: number };
}

const money = (minor: number, cur: string) => new Intl.NumberFormat(cur === 'INR' ? 'en-IN' : cur === 'CAD' ? 'en-CA' : 'en-US', { style: 'currency', currency: cur, maximumFractionDigits: minor % 100 === 0 ? 0 : 2 }).format(minor / 100);

/** Smoothed rating so that one 5-star review does not beat 200 reviews at 4.7 (Bayesian average toward the set mean). */
export function smoothedRating(avg: number, count: number, prior: number, strength = 5): number {
  return (count * avg + strength * prior) / (count + strength);
}

export function rankCandidates(intent: ParsedIntent, cands: FindCandidate[], o: RankOptions): RankResult {
  const excluded = { tooLate: 0, overBudget: 0 };
  const limit = o.limit ?? 24;
  const needDefs = intent.needs.map((s) => needBySlug(s)).filter((n): n is NonNullable<typeof n> => !!n);
  const catSet = new Set(intent.categories);
  const kw = intent.keywords;
  const hasConcept = kw.length > 0 || intent.extraTerms.length > 0 || needDefs.length > 0 || catSet.size > 0 || intent.attributes.length > 0 || intent.topCategories.length > 0;
  const semScores = o.semantic && kw.length + needDefs.length + intent.extraTerms.length > 0 ? o.semantic.query([...kw, ...intent.extraTerms, ...intent.attributes.map((a) => a.value), ...needDefs.map((n) => n.name)].join(' ')) : new Map<string, number>();

  // hard filters first
  const pool: FindCandidate[] = [];
  for (const c of cands) {
    if (c.stock <= 0 || c.price <= 0) continue;
    if (o.budget?.max !== undefined && c.price > o.budget.max) { excluded.overBudget++; continue; }
    if (o.budget?.min !== undefined && c.price < o.budget.min) { excluded.overBudget++; continue; }
    if (o.minRating && !(c.rating.count >= MIN_RATING_COUNT && c.rating.avg >= o.minRating)) continue;
    // child-safety: never show a toy whose stated minimum age is above the child's age
    if (intent.audience.ageYears !== undefined && intent.audience.kind === 'kids') {
      const ar = parseAgeRange(c.ageRange);
      if (ar && intent.audience.ageYears < ar.min) continue;
    }
    pool.push(c);
  }

  const withRatings = pool.filter((c) => c.rating.count >= MIN_RATING_COUNT);
  const prior = withRatings.length ? withRatings.reduce((a, c) => a + c.rating.avg, 0) / withRatings.length : 0;

  interface Scored { r: RankedItem; rel: number; hasMatch: boolean; da: DeliveryAssessment }
  const scored: Scored[] = [];
  for (const c of pool) {
    const da = assessDelivery(o.today, o.deadline ?? null, c.minDays, c.maxDays);
    if (da.impossible && !o.keepLate) { excluded.tooLate++; continue; }
    const p = prepare(c);
    const why: WhyMatched[] = [];
    let score = 0;
    let hasMatch = false;
    let needHit = false;
    let catHit = false;
    let attrHit = false;
    let audHit = false;

    // needs (real catalogue rules from NEEDS)
    for (const n of needDefs) {
      const catHit = n.match.categories?.includes(c.category);
      const kwHit = n.match.keywords?.find((k) => new RegExp(`\\b${k}\\b`, 'i').test(`${c.title} ${c.tags.join(' ')}`));
      if (catHit || kwHit) {
        score += 14; hasMatch = true; needHit = true;
        why.push({ kind: 'need', text: `Fits “${n.name}”${catHit ? ` (category ${c.category.replace(/-/g, ' ')})` : ` (matches “${kwHit}”)`}` });
      }
    }
    // categories
    if (catSet.has(c.category)) {
      const def = CATEGORY_DEFS.find((d) => d.slug === c.category);
      score += 12; hasMatch = true; catHit = true;
      why.push({ kind: 'category', text: `In the ${def?.name ?? c.category} category` });
    }
    // keywords
    let matchedTerms = 0;
    for (const term of kw) {
      const h = matchTerm(p, term);
      if (h) { matchedTerms++; score += h.weight; hasMatch = true; why.push({ kind: 'keyword', text: `Matches “${term}” in ${h.where}` }); }
    }
    // related terms (AI refinement / image search): soft evidence only
    let extraHit = false;
    for (const term of intent.extraTerms) {
      const h = matchTerm(p, term);
      if (h) { extraHit = true; score += h.weight * 0.5; hasMatch = true; why.push({ kind: 'keyword', text: `Also matches the related term “${term}” in ${h.where}` }); }
    }
    // attributes
    for (const a of intent.attributes) {
      if (a.kind === 'age' || a.kind === 'species') continue;
      const have = new Set([...p.attrs, ...p.tags, ...p.title]);
      const hit = toks(a.value).every((t) => have.has(t));
      const attrVal = Object.entries(c.attributes).find(([, v]) => stem(v.toLowerCase()) === stem(a.value));
      if (hit) {
        score += 5; hasMatch = true; attrHit = true;
        why.push({ kind: 'attribute', text: attrVal ? `${attrVal[0]}: ${attrVal[1]}` : `${a.kind}: ${a.value} (mentioned in its listing)` });
      }
    }
    // audience
    if (intent.audience.kind && c.topCategory === intent.audience.kind) {
      score += 6;
      why.push({ kind: 'category', text: `Listed under ${intent.audience.kind === 'pet' ? 'Pet' : 'Kids'}` });
      audHit = true;
    } else if (intent.topCategories.includes(c.topCategory)) {
      score += 3; audHit = true;
    }
    if (intent.audience.ageYears !== undefined && c.ageRange && intent.audience.kind === 'kids') {
      const ar = parseAgeRange(c.ageRange);
      if (ar && intent.audience.ageYears >= ar.min && (ar.max === null || intent.audience.ageYears <= ar.max)) { score += 4; why.push({ kind: 'attribute', text: `Listed age range ${c.ageRange} includes ${intent.audience.ageYears}` }); }
    }
    // gift
    if (intent.gift) {
      const gift = NEEDS.find((n) => n.slug === 'thoughtful-gifts');
      if (gift && (gift.match.categories?.includes(c.category) || gift.match.keywords?.some((k) => new RegExp(`\\b${k}\\b`, 'i').test(`${c.title} ${c.tags.join(' ')}`)))) {
        score += 4;
        if (!why.some((w) => w.kind === 'need' && w.text.includes('Thoughtful gifts'))) why.push({ kind: 'gift', text: 'Personalised or gift-oriented item' + (intent.gift.occasion ? ` (you mentioned ${intent.gift.occasion})` : '') });
      }
    }
    // semantic text similarity (TF-IDF cosine; real, but statistical not neural)
    const sim = semScores.get(c.id) ?? 0;
    if (sim > 0) {
      score += sim * 15;
      if (!hasMatch && sim >= 0.2) { hasMatch = true; why.push({ kind: 'similar_text', text: 'Its listing uses similar wording to your search' }); }
    }

    // relevance gate: at least half of the keywords, or a need/category hit, or text similarity (or, with no keywords, attribute/audience hits)
    if (hasConcept) {
      const kwOk = kw.length > 0 && matchedTerms >= Math.ceil(kw.length / 2);
      const relevant = kwOk || extraHit || needHit || catHit || sim >= 0.25 || (kw.length === 0 && (attrHit || audHit));
      if (!relevant) continue;
    }

    // quality signals (small, only from real data)
    if (c.rating.count >= MIN_RATING_COUNT) score += smoothedRating(c.rating.avg, c.rating.count, prior || c.rating.avg) - 3; // about -1..+2
    score += Math.min(2, Math.log10(1 + c.sold) / 2) + Math.min(2, c.trend / 50);

    // filter explanations
    if (o.budget?.max !== undefined) why.push({ kind: 'budget', text: `${money(c.price, c.currency)} is within your ${money(o.budget.max, c.currency)} budget (item price, before shipping)` });
    if (o.deadline) {
      if (da.fit === 'ok') why.push({ kind: 'delivery', text: `Estimated to arrive by ${formatYmd(da.latest!)}, before ${formatYmd(o.deadline)} (an estimate, not a guarantee)` });
      else if (da.fit === 'may_not_arrive') why.push({ kind: 'delivery', text: `May not arrive in time: estimate runs to ${formatYmd(da.latest!)}, after ${formatYmd(o.deadline)}` });
      else why.push({ kind: 'delivery', text: 'Delivery time for this country is not available, so we cannot say whether it arrives in time' });
    }
    if (c.rating.count >= MIN_RATING_COUNT && (intent.sort === 'rating' || o.sort === 'rating')) why.push({ kind: 'rating', text: `Rated ${c.rating.avg.toFixed(1)} from ${c.rating.count} reviews` });

    scored.push({ r: { cand: c, score, whyMatched: why, deliveryFit: da.fit, latestArrival: da.latest, delivered: deliveredEstimate(c.price, o.ship) }, rel: score, hasMatch, da });
  }

  // ordering
  const maxRel = Math.max(1, ...scored.map((s) => s.rel));
  const prices = scored.map((s) => s.r.delivered);
  const minP = Math.min(...prices, Infinity);
  const maxP = Math.max(...prices, -Infinity);
  const priceNorm = (p: number) => (maxP === minP ? 0.5 : 1 - (p - minP) / (maxP - minP));
  const rateOf = (c: FindCandidate) => (c.rating.count >= MIN_RATING_COUNT ? smoothedRating(c.rating.avg, c.rating.count, prior || c.rating.avg) : 0);
  const sortWhy = (s: SortIntent): WhyMatched | null => {
    switch (s) {
      case 'price_asc': return { kind: 'sort', text: 'Sorted by lowest estimated delivered price' };
      case 'price_desc': return { kind: 'sort', text: 'Sorted by highest price' };
      case 'rating': return { kind: 'sort', text: `Sorted by rating; products with fewer than ${MIN_RATING_COUNT} reviews are ranked last` };
      case 'value': return { kind: 'sort', text: 'Value order: relevance, smoothed rating and price (see docs for the formula)' };
      case 'fastest': return { kind: 'sort', text: 'Sorted by the shortest estimated delivery window' };
      case 'popular': return { kind: 'sort', text: 'Sorted by units sold' };
      default: return null;
    }
  };
  const cmp: Record<SortIntent, (a: Scored, b: Scored) => number> = {
    relevance: (a, b) => b.rel - a.rel,
    price_asc: (a, b) => a.r.delivered - b.r.delivered || b.rel - a.rel,
    price_desc: (a, b) => b.r.delivered - a.r.delivered || b.rel - a.rel,
    rating: (a, b) => rateOf(b.r.cand) - rateOf(a.r.cand) || b.r.cand.rating.count - a.r.cand.rating.count || b.rel - a.rel,
    fastest: (a, b) => (a.r.cand.maxDays ?? 999) - (b.r.cand.maxDays ?? 999) || (a.r.cand.minDays ?? 999) - (b.r.cand.minDays ?? 999) || b.rel - a.rel,
    popular: (a, b) => b.r.cand.sold - a.r.cand.sold || b.rel - a.rel,
    value: (a, b) => {
      const v = (s: Scored) => 0.5 * (s.rel / maxRel) + 0.3 * (rateOf(s.r.cand) / 5) + 0.2 * priceNorm(s.r.delivered);
      return v(b) - v(a);
    },
  };
  scored.sort(cmp[o.sort] ?? cmp.relevance);
  // on-time products first when a deadline is given and we kept late ones
  if (o.deadline && o.keepLate) scored.sort((a, b) => Number(a.da.fit !== 'ok') - Number(b.da.fit !== 'ok'));
  const sw = sortWhy(o.sort);
  const items = scored.slice(0, limit).map((s) => {
    if (sw) s.r.whyMatched.push(sw);
    if (!s.r.whyMatched.length) s.r.whyMatched.push({ kind: 'sort', text: 'Available in your country and matches your filters' });
    return s.r;
  });
  return { items, total: scored.length, excluded };
}

/** Days between today and a deadline, for chips. */
export const daysUntil = (today: Ymd, d: Ymd): number => diffDays(today, d);
