/**
 * ORVIA Find: deterministic natural-language intent parser. PURE (no IO, no randomness, `now` is injected).
 *
 * The parser only EXTRACTS structure from the text (filters, keywords, hints). It never executes or obeys the text:
 * whatever a query says ("ignore previous instructions", "show supplier cost") can at most become a harmless keyword,
 * and every filter value is either a number/date parsed by a regular expression or a slug from our own allow-lists
 * (NEEDS, CATEGORY_TREE). Money, dates and availability are decided later by deterministic code.
 */
import { CATEGORY_TREE, NEEDS, slugify } from '@orvia/types';
import type { CountryCode } from '@orvia/types';
import { COUNTRY_TZ, MONTHS, WEEKDAYS, addDays, dayOfWeek, daysInMonth, formatYmd, makeYmd, todayIn, weekStart } from './dates';
import type { Ymd } from './dates';

export type Cur = 'USD' | 'CAD' | 'INR';
export type SortIntent = 'relevance' | 'price_asc' | 'price_desc' | 'rating' | 'value' | 'fastest' | 'popular';

export interface ParseContext {
  now: Date;
  country: CountryCode;
  marketCurrency: Cur;
}
export interface ParsedBudget {
  min?: number;
  max?: number;
  /** currency the customer wrote (defaults to the market currency) */
  currency: Cur;
  /** "$" / "dollars" with no country hint */
  ambiguousDollar: boolean;
}
export interface IntentAttribute {
  kind: 'material' | 'size' | 'color' | 'age' | 'species';
  value: string;
}
export interface ParsedIntent {
  raw: string;
  text: string;
  keywords: string[];
  /** Related terms added by the optional AI refinement or image search. Soft signals only: never required for a match. */
  extraTerms: string[];
  needs: string[];
  /** sub-category slugs (slugified CATEGORY_TREE children) */
  categories: string[];
  topCategories: string[];
  budget: ParsedBudget | null;
  gift: { recipient?: string; occasion?: string } | null;
  audience: { kind: 'pet' | 'kids' | null; species?: 'dog' | 'cat'; ageYears?: number };
  attributes: IntentAttribute[];
  deadline: { date: Ymd; label: string } | null;
  sort: SortIntent;
  compare: boolean;
  notes: string[];
}

export const QUERY_MAX = 300;

/** Strips control/zero-width characters and markup-ish punctuation, collapses whitespace, bounds length. */
export function sanitizeQuery(q: string): string {
  return q
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏ -‮⁠﻿]/g, ' ')
    .replace(/[<>{}[\]\\|`^~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, QUERY_MAX);
}

/* ------------------------------ lexicons ------------------------------ */
const STOPWORDS = new Set(
  ('a an the for to of and or with without my me i we our you your it its is are was be can could would should do does need needs needed want wants looking look find show get give buy shop some something anything any ' +
    'that this these those there here on in at by from as into out up down so very really just also please ideas idea suggest suggestions suggestion recommend recommendations recommend products product items item stuff things thing ' +
    'good nice great best cool awesome new one ones who whom what which where when how much many more most less too than then if but not no yes want like love lovely kind sort type any cheap cheapest budget price priced pricing cost costs ' +
    'around about roughly approximately approx below under over above between within before after until till still deliver delivered delivery arrive arrives arriving ship shipped shipping day days week weeks month months year years old')
    .split(/\s+/),
);

const MATERIALS = ['wood', 'wooden', 'bamboo', 'silicone', 'stainless steel', 'steel', 'cotton', 'leather', 'plastic', 'metal', 'glass', 'ceramic', 'rubber', 'nylon', 'wool', 'linen', 'polyester', 'aluminum', 'aluminium', 'canvas', 'felt', 'fleece', 'foam', 'paper', 'cardboard', 'plush', 'velvet'];
const COLORS = ['red', 'blue', 'green', 'black', 'white', 'pink', 'purple', 'yellow', 'orange', 'grey', 'gray', 'brown', 'beige', 'navy', 'gold', 'silver', 'teal'];
const SIZES = ['extra small', 'extra large', 'travel size', 'xxxl', 'xxl', 'xs', 'xl', 'small', 'medium', 'large', 'mini', 'compact', 'jumbo', 'big'];

const RECIPIENTS = ['mom', 'mum', 'mother', 'dad', 'father', 'wife', 'husband', 'girlfriend', 'boyfriend', 'partner', 'friend', 'best friend', 'sister', 'brother', 'son', 'daughter', 'grandma', 'grandmother', 'grandpa', 'grandfather', 'boss', 'teacher', 'colleague', 'coworker', 'neighbour', 'neighbor', 'niece', 'nephew', 'cousin', 'baby', 'toddler', 'teen', 'teenager', 'kid', 'kids', 'child', 'children', 'dog', 'cat', 'puppy', 'kitten', 'pet', 'him', 'her', 'couple', 'parents', 'newborn'];
const OCCASIONS: [RegExp, string][] = [
  [/\bbirthdays?\b/, 'birthday'],
  [/\banniversar(?:y|ies)\b/, 'anniversary'],
  [/\b(?:christmas|xmas)\b/, 'christmas'],
  [/\bvalentine(?:'?s)?(?: day)?\b/, "valentine's day"],
  [/\bwedding\b/, 'wedding'],
  [/\bhousewarming\b/, 'housewarming'],
  [/\bgraduation\b/, 'graduation'],
  [/\bbaby shower\b/, 'baby shower'],
  [/\bmother'?s day\b/, "mother's day"],
  [/\bfather'?s day\b/, "father's day"],
  [/\bdiwali\b/, 'diwali'],
  [/\braksha bandhan\b/, 'raksha bandhan'],
  [/\beid\b/, 'eid'],
  [/\bthanksgiving\b/, 'thanksgiving'],
  [/\bretirement\b/, 'retirement'],
  [/\bsecret santa\b/, 'secret santa'],
];
const PET_WORDS: Record<string, 'dog' | 'cat' | null> = { dog: 'dog', dogs: 'dog', puppy: 'dog', puppies: 'dog', canine: 'dog', cat: 'cat', cats: 'cat', kitten: 'cat', kittens: 'cat', feline: 'cat', pet: null, pets: null };
const KID_WORDS = new Set(['kid', 'kids', 'child', 'children', 'toddler', 'toddlers', 'baby', 'babies', 'infant', 'newborn', 'son', 'daughter', 'niece', 'nephew', 'boy', 'girl', 'boys', 'girls', 'preschooler', 'preschool']);

/** Phrases that signal one of the platform's needs (docs/ORVIA_FIND.md). Slugs are validated against NEEDS at module load. */
const NEED_PHRASES: Record<string, string[]> = {
  'screen-free-play': ['screen free', 'no screens', 'offline play', 'quiet play', 'hands on play', 'less screen time', 'off screens'],
  'learn-and-grow': ['learn', 'learning', 'educational', 'stem', 'educate', 'build skills', 'skill building', 'curious'],
  'time-savers': ['time saver', 'time savers', 'save time', 'saves time', 'quick', 'easy clean', 'tidy', 'less effort', 'declutter'],
  'travel-ready': ['travel', 'trip', 'road trip', 'portable', 'commute', 'on the go', 'flight', 'holiday trip', 'camping'],
  'pet-wellbeing': ['enrichment', 'bored dog', 'bored cat', 'slow feeder', 'happy pet', 'pet care', 'slow feeding'],
  'thoughtful-gifts': ['personalized', 'personalised', 'personalize', 'custom', 'engraved', 'monogram', 'thoughtful', 'meaningful'],
  'stand-out': ['unique', 'stand out', 'quirky', 'statement', 'one of a kind', 'different'],
  'desk-upgrades': ['desk', 'office', 'work from home', 'wfh', 'study', 'workspace', 'laptop'],
  'rest-and-comfort': ['comfort', 'comfy', 'cozy', 'cosy', 'sleep', 'relax', 'relaxing', 'massage', 'calming', 'wind down'],
};

const TOP_SYNONYMS: Record<string, string[]> = {
  pet: ['pet', 'pets', 'dog', 'dogs', 'puppy', 'cat', 'cats', 'kitten'],
  kids: ['kid', 'kids', 'child', 'children', 'toddler', 'baby'],
  fashion: ['fashion', 'clothing', 'clothes', 'apparel', 'shirt', 'tshirt', 'hoodie', 'jacket', 'outfit', 'jewelry', 'jewellery', 'wear'],
  gadgets: ['gadget', 'gadgets', 'tech', 'electronics', 'device'],
};

/* ------------------------------ text helpers ------------------------------ */
const canon: Record<string, string> = { removal: 'remove', removing: 'remove', removers: 'remove', remover: 'remove', feeders: 'feed', feeder: 'feed', feeding: 'feed', organizer: 'organiz', organizers: 'organiz', organisation: 'organiz', organization: 'organiz', organisers: 'organiz', organiser: 'organiz', organizing: 'organiz', organising: 'organiz', organize: 'organiz', organise: 'organiz' };
/** Very small English stemmer used for matching only (never displayed). */
export function stem(w: string): string {
  let x = w.toLowerCase();
  if (canon[x]) return canon[x]!;
  if (x.length > 4 && x.endsWith('ies')) x = `${x.slice(0, -3)}y`;
  else if (x.length > 5 && x.endsWith('ing')) x = x.slice(0, -3);
  else if (x.length > 4 && /(ss|x|z|ch|sh)es$/.test(x)) x = x.slice(0, -2);
  else if (x.length > 3 && x.endsWith('s') && !x.endsWith('ss')) x = x.slice(0, -1);
  return x;
}
const words = (s: string): string[] => s.toLowerCase().replace(/[^a-z0-9\s']/g, ' ').split(/\s+/).filter(Boolean);
const escRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phraseRe = (p: string) => new RegExp(`(?<![a-z0-9])${escRe(p).replace(/\s+/g, '\\s+')}(?![a-z0-9])`, 'i');

/** Sub-category lookup built from CATEGORY_TREE: slug, readable name, stemmed significant tokens, head noun. */
const GENERIC = new Set(['and', 'the']);
interface CatDef { slug: string; name: string; top: string; sig: string[]; head: string; }
export const CATEGORY_DEFS: CatDef[] = CATEGORY_TREE.flatMap((t) =>
  t.children.map((name) => {
    const sig = words(name).filter((w) => !GENERIC.has(w)).map(stem);
    const all = words(name).map(stem);
    return { slug: slugify(name), name, top: t.slug, sig: sig.length ? sig : all, head: (sig.length ? sig : all).at(-1) ?? '' };
  }),
);
for (const slug of Object.keys(NEED_PHRASES)) if (!NEEDS.some((n) => n.slug === slug)) throw new Error(`find: unknown need slug ${slug}`);

/* ------------------------------ budget ------------------------------ */
const PRE = '(?:₹|rs\\.?|inr|us\\$|usd|c\\$|ca\\$|cdn\\$|cad|\\$)';
const SUF = '(?:rupees?|rs\\.?|inr|us dollars?|usd|canadian dollars?|cad|dollars?|bucks)';
const NUM = '(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)';
const UNIT_GUARD = /^\s*(?:years?|yrs?|months?|mos?|weeks?|days?|hours?|hrs?|kgs?|g|grams?|cm|mm|inch(?:es)?|"|lbs?|pounds?|oz|ounces?|ml|l|litres?|liters?|ft|feet|pcs|pieces?|piece|packs?|pack|%|percent|items?|sets?|stars?)\b/i;
const MAX_KW = '(?:under|below|less than|lower than|up to|upto|within|max(?:imum)?(?: of)?|at most|not more than|no more than|cheaper than|not exceeding|budget(?: of| is)?|<=?)';
const MIN_KW = '(?:over|above|more than|at least|minimum(?: of)?|min|starting at|>=?)';
const ABOUT_KW = '(?:around|about|approx(?:imately)?|roughly|~)';

function curOf(tok: string | undefined, market: Cur): { cur: Cur; ambiguous: boolean; explicit: boolean } {
  if (!tok) return { cur: market, ambiguous: false, explicit: false };
  const t = tok.toLowerCase().replace(/\s+/g, ' ').trim();
  if (/^(₹|rs\.?|inr|rupees?)$/.test(t)) return { cur: 'INR', ambiguous: false, explicit: true };
  if (/^(c\$|ca\$|cdn\$|cad|canadian dollars?)$/.test(t)) return { cur: 'CAD', ambiguous: false, explicit: true };
  if (/^(us\$|usd|us dollars?)$/.test(t)) return { cur: 'USD', ambiguous: false, explicit: true };
  // "$", "dollars", "bucks": follow the market when it is a dollar market, otherwise USD
  return { cur: market === 'INR' ? 'USD' : market, ambiguous: true, explicit: true };
}
const amount = (n: string, k: string | undefined): number => {
  const v = Number(n.replace(/,/g, '')) * (k ? 1000 : 1);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
};

function extractBudget(s: string, market: Cur, notes: string[]): { budget: ParsedBudget | null; rest: string } {
  const money = `(?:(${PRE})\\s*)?${NUM}\\s*(k)?(?![a-z0-9])\\s*(${SUF}(?![a-z]))?`;
  const blank = (str: string, i: number, len: number) => str.slice(0, i) + ' '.repeat(len) + str.slice(i + len);
  let out = s;

  // 1. ranges: "between $20 and $40", "₹500-1000", "20 to 40 dollars"
  const range = new RegExp(`(between\\s+)?${money}\\s*(?:and|to|-|–)\\s*${money}`, 'gi');
  for (const m of out.matchAll(range)) {
    const [, between, pre1, n1, k1, suf1, pre2, n2, k2, suf2] = m;
    const tok = pre2 ?? suf2 ?? pre1 ?? suf1;
    if (!tok && !between) continue; // "6-8 years" style ranges are not budgets
    if (!tok && UNIT_GUARD.test(out.slice(m.index! + m[0].length))) continue;
    const c = curOf(tok, market);
    let a = amount(n1!, k1);
    let b = amount(n2!, k2);
    if (a > b) [a, b] = [b, a];
    out = blank(out, m.index!, m[0].length);
    return { budget: { min: a, max: b, currency: c.cur, ambiguousDollar: c.ambiguous }, rest: out };
  }

  // 2. keyword + amount: "under $40", "at least 20 dollars", "around ₹2000"
  const kw = new RegExp(`(${MAX_KW}|${MIN_KW}|${ABOUT_KW})\\s*${money}`, 'gi');
  for (const m of out.matchAll(kw)) {
    const [, word, pre, n, k, suf] = m;
    const tok = pre ?? suf;
    const after = out.slice(m.index! + m[0].length);
    if (!tok && UNIT_GUARD.test(after)) continue; // "under 5 years", "under 2 kg"
    const isMin = new RegExp(`^${MIN_KW}$`, 'i').test(word!);
    if (isMin && !tok) continue; // "over 20" without a currency is too ambiguous to treat as money
    const c = curOf(tok, market);
    const v = amount(n!, k);
    if (v <= 0) continue;
    if (new RegExp(`^${ABOUT_KW}$`, 'i').test(word!)) notes.push(`Treated “${word} ${v}” as a maximum`);
    out = blank(out, m.index!, m[0].length);
    return { budget: isMin ? { min: v, currency: c.cur, ambiguousDollar: c.ambiguous } : { max: v, currency: c.cur, ambiguousDollar: c.ambiguous }, rest: out };
  }

  // 3. bare amount with an explicit currency marker: "gifts ₹2000", "$40 gift", "40 dollars"
  const bare = new RegExp(`(?:(${PRE})\\s*${NUM}\\s*(k)?(?![a-z0-9])|${NUM}\\s*(k)?\\s*(${SUF}(?![a-z])))`, 'gi');
  for (const m of out.matchAll(bare)) {
    const pre = m[1];
    const n = pre ? m[2]! : m[4]!;
    const k = pre ? m[3] : m[5];
    const tok = pre ?? m[6];
    const v = amount(n, k);
    if (v <= 0 || !tok) continue;
    const c = curOf(tok, market);
    notes.push(`Treated the amount ${v} as your maximum budget`);
    out = blank(out, m.index!, m[0].length);
    return { budget: { max: v, currency: c.cur, ambiguousDollar: c.ambiguous }, rest: out };
  }
  return { budget: null, rest: out };
}

/** Converts a parsed budget into minor units of the market currency. `fx` = units of currency per 1 USD. */
export function budgetToMinor(b: ParsedBudget, marketCurrency: Cur, fx: Record<Cur, number>): { min?: number; max?: number; converted: boolean } {
  const conv = (v: number) => {
    if (b.currency === marketCurrency) return Math.round(v * 100);
    const usd = v / (fx[b.currency] || 1);
    return Math.round(usd * (fx[marketCurrency] || 1) * 100);
  };
  return { ...(b.min !== undefined ? { min: conv(b.min) } : {}), ...(b.max !== undefined ? { max: conv(b.max) } : {}), converted: b.currency !== marketCurrency };
}

/* ------------------------------ deadline ------------------------------ */
const WD = `(${WEEKDAYS.join('|')}|tues|thurs)`;
const MON_ALT = `(${MONTHS.join('|')}|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)`;
const monthIndex = (t: string): number => {
  const i = MONTHS.findIndex((m) => m === t || m.startsWith(t.slice(0, 3)));
  return i + 1;
};
const NUMWORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fourteen: 14 };
const PFX = '(?:(by|before|until|till|on|for|within)\\s+)?';

interface Dl { date: Ymd; label: string }

/** `before X` means strictly before: the deadline becomes the day before X. */
const adj = (prefix: string | undefined, d: Ymd, subtractForFor = false): Ymd => (prefix?.toLowerCase() === 'before' || (subtractForFor && prefix?.toLowerCase() === 'for') ? addDays(d, -1) : d);

function nextMonthDay(today: Ymd, month: number, day: number): Ymd | null {
  const y = Number(today.slice(0, 4));
  const d1 = makeYmd(y, month, day);
  if (!d1) return null;
  return d1 >= today ? d1 : makeYmd(y + 1, month, day);
}

function extractDeadline(s: string, today: Ymd, notes: string[]): { deadline: Dl | null; rest: string } {
  const blank = (m: RegExpMatchArray) => s.slice(0, m.index!) + ' '.repeat(m[0].length) + s.slice(m.index! + m[0].length);
  const label = (m: RegExpMatchArray) => m[0].trim().replace(/\s+/g, ' ');
  let m: RegExpMatchArray | null;
  const done = (date: Ymd | null, mm: RegExpMatchArray): { deadline: Dl | null; rest: string } => {
    if (!date) return { deadline: null, rest: s };
    if (date < today) {
      notes.push(`Ignored “${label(mm)}” because that date has already passed`);
      return { deadline: null, rest: blank(mm) };
    }
    return { deadline: { date, label: label(mm) }, rest: blank(mm) };
  };

  if ((m = s.match(/\b(\d{4}-\d{2}-\d{2})\b/))) return done(makeYmd(Number(m[1]!.slice(0, 4)), Number(m[1]!.slice(5, 7)), Number(m[1]!.slice(8, 10))), m);

  // "within N days/weeks", "in N days"
  if ((m = s.match(new RegExp(`\\b(?:in|within)\\s+(\\d{1,2}|${Object.keys(NUMWORDS).join('|')})\\s+(day|days|week|weeks)\\b`, 'i')))) {
    const n = /^\d/.test(m[1]!) ? Number(m[1]) : NUMWORDS[m[1]!.toLowerCase()]!;
    return done(addDays(today, n * (m[2]!.startsWith('week') ? 7 : 1)), m);
  }
  if ((m = s.match(/\b(?:in|within)\s+(?:a|1)\s+week\b/i))) return done(addDays(today, 7), m);

  if ((m = s.match(new RegExp(`\\b${PFX}(today|tonight)\\b`, 'i'))) && m[1]) return done(today, m);
  if ((m = s.match(new RegExp(`\\b${PFX}tomorrow\\b`, 'i')))) return done(adj(m[1], addDays(today, 1)), m);

  // occasions with a fixed calendar date
  const fixed: [RegExp, number, number, string][] = [
    [/\b(?:christmas|xmas)\b/i, 12, 25, 'christmas'],
    [/\bvalentine(?:'?s)?(?: day)?\b/i, 2, 14, 'valentine'],
    [/\bhalloween\b/i, 10, 31, 'halloween'],
    [/\bnew year(?:'?s)?(?: day)?\b/i, 1, 1, 'new year'],
  ];
  for (const [re, mo, d] of fixed) {
    const r = s.match(new RegExp(`\\b(by|before|for|until|till)\\s+(?:the\\s+)?${re.source.replace(/^\\b/, '')}`, 'i'));
    if (r) {
      const base = nextMonthDay(today, mo, d);
      return done(base ? adj(r[1], base, true) : null, r);
    }
  }

  // "by end of (the) week/month"
  if ((m = s.match(/\b(?:by|before|until|for)?\s*(?:the\s+)?end of (?:the\s+)?(week|month)\b/i))) {
    if (m[1]!.toLowerCase() === 'week') {
      const fri = addDays(weekStart(today), 4);
      return done(fri >= today ? fri : addDays(fri, 7), m);
    }
    const y = Number(today.slice(0, 4));
    const mo = Number(today.slice(5, 7));
    return done(makeYmd(y, mo, daysInMonth(y, mo)), m);
  }
  if ((m = s.match(/\b(by|before|for)\s+next week\b/i))) return done(adj(m[1], addDays(weekStart(today), 7)), m);

  // weekday: "before friday", "by next tuesday", "this saturday"
  if ((m = s.match(new RegExp(`\\b${PFX}(this|next|coming)?\\s*${WD}\\b`, 'i')))) {
    const word = m[3]!.toLowerCase();
    const wd = word === 'tues' ? 2 : word === 'thurs' ? 4 : WEEKDAYS.indexOf(word as (typeof WEEKDAYS)[number]);
    const mod = m[2]?.toLowerCase();
    let delta = (wd - dayOfWeek(today) + 7) % 7;
    if (mod === 'this' || mod === 'coming') {
      /* upcoming occurrence including today */
    } else if (delta === 0) delta = 7; // "by friday" said on a friday means next friday
    let d = addDays(today, delta);
    if (mod === 'next' && weekStart(d) === weekStart(today)) d = addDays(d, 7);
    return done(adj(m[1], d), m);
  }

  // "15 december", "december 15th", "the 20th"
  if ((m = s.match(new RegExp(`\\b${PFX}(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+${MON_ALT}\\b`, 'i')))) return done(adj(m[1], nextMonthDay(today, monthIndex(m[3]!.toLowerCase()), Number(m[2])) ?? '9999-12-31'), m);
  if ((m = s.match(new RegExp(`\\b${PFX}${MON_ALT}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i')))) return done(adj(m[1], nextMonthDay(today, monthIndex(m[2]!.toLowerCase()), Number(m[3])) ?? '9999-12-31'), m);
  if ((m = s.match(/\b(by|before|on|for)\s+the\s+(\d{1,2})(?:st|nd|rd|th)\b/i))) {
    const y = Number(today.slice(0, 4));
    const mo = Number(today.slice(5, 7));
    const day = Number(m[2]);
    let d = makeYmd(y, mo, day);
    if (!d || d < today) {
      const ny = mo === 12 ? y + 1 : y;
      d = makeYmd(ny, mo === 12 ? 1 : mo + 1, day);
    }
    return done(d ? adj(m[1], d) : null, m);
  }
  return { deadline: null, rest: s };
}

/* ------------------------------ main parser ------------------------------ */
export function parseIntent(rawQuery: string, ctx: ParseContext): ParsedIntent {
  const raw = sanitizeQuery(rawQuery);
  const notes: string[] = [];
  let s = raw.toLowerCase().replace(/[’‘]/g, "'");

  const today = todayIn(COUNTRY_TZ[ctx.country], ctx.now);

  // order matters: deadline first (so "by 20th" is not read as a number), then money
  const dl = extractDeadline(s, today, notes);
  s = dl.rest;
  const bg = extractBudget(s, ctx.marketCurrency, notes);
  s = bg.rest;

  const has = (p: string) => phraseRe(p).test(s);
  const strip = (re: RegExp) => { s = s.replace(re, ' '); };

  // sort intent
  let sort: SortIntent = 'relevance';
  const sortRules: [RegExp, SortIntent][] = [
    [/\b(?:cheapest|lowest price|lowest priced|least expensive|most affordable|cheap(?:er)? option)\b/, 'price_asc'],
    [/\b(?:best value|good value|great value|value for money|bang for (?:the |my )?buck|worth the money)\b/, 'value'],
    [/\b(?:top rated|best rated|highest rated|best reviewed|top reviewed|well reviewed|highly rated|best reviews)\b/, 'rating'],
    [/\b(?:fastest|quickest|fast delivery|fast shipping|express|quick delivery)\b/, 'fastest'],
    [/\b(?:most popular|best sellers?|bestsellers?|best selling|bestselling|popular)\b/, 'popular'],
    [/\b(?:most expensive|priciest|premium|luxury)\b/, 'price_desc'],
  ];
  for (const [re, v] of sortRules) {
    const mm = s.match(re);
    if (mm) {
      if (sort === 'relevance') sort = v;
      strip(re);
    }
  }

  // comparison intent
  let compare = false;
  const cmp = /\b(?:compare|comparison|versus|vs\.?|difference between|which is better|side by side)\b/;
  if (cmp.test(s)) { compare = true; strip(cmp); }

  // gift / occasion / recipient
  let occasion: string | undefined;
  for (const [re, name] of OCCASIONS) if (re.test(s)) { occasion = name; break; }
  const giftWord = /\b(?:gifts?|presents?|surprise|stocking fillers?)\b/;
  const isGift = giftWord.test(s) || !!occasion;
  let recipient: string | undefined;
  const rr = s.match(new RegExp(`\\b(?:for|to)\\s+(?:my|a|an|the|our|his|her|your)?\\s*(${[...RECIPIENTS].sort((a, b) => b.length - a.length).map(escRe).join('|')})\\b`));
  if (rr) recipient = rr[1];
  if (isGift) strip(giftWord);

  // audience (pet / kids) and age
  const tokens = words(s);
  let audienceKind: 'pet' | 'kids' | null = null;
  let species: 'dog' | 'cat' | undefined;
  for (const t of tokens) {
    if (t in PET_WORDS) { audienceKind = 'pet'; species = species ?? PET_WORDS[t] ?? undefined; }
  }
  let ageYears: number | undefined;
  const ageM = s.match(/\b(\d{1,2})\s*[- ]?\s*(?:years?|yrs?)[\s-]*old\b/) ?? s.match(/\bage[sd]?\s+(\d{1,2})\b/) ?? s.match(/\b(\d{1,2})\s*(?:yo|y\/o)\b/);
  if (ageM) {
    const a = Number(ageM[1]);
    if (a > 17) notes.push('Age looks like an adult, so no children’s age filter was applied');
    else ageYears = a;
  }
  if (!audienceKind && (tokens.some((t) => KID_WORDS.has(t)) || (ageYears !== undefined && ageYears <= 14))) audienceKind = 'kids';

  // attributes
  const attributes: IntentAttribute[] = [];
  for (const v of MATERIALS) if (has(v)) attributes.push({ kind: 'material', value: v });
  const sizes = SIZES.filter((v) => has(v));
  for (const v of sizes) attributes.push({ kind: 'size', value: v });
  for (const v of COLORS) if (has(v)) attributes.push({ kind: 'color', value: v });
  if (ageYears !== undefined) attributes.push({ kind: 'age', value: String(ageYears) });
  if (species) attributes.push({ kind: 'species', value: species });

  // needs
  const needs = NEEDS.filter((n) => (NEED_PHRASES[n.slug] ?? []).some((p) => has(p))).map((n) => n.slug);
  if (isGift && /\b(?:personali[sz]ed|custom|engraved|monogram)\b/.test(s) && !needs.includes('thoughtful-gifts')) needs.push('thoughtful-gifts');

  // categories: all significant tokens, or >= 60% (min 2) with the head noun present
  const stems = new Set(tokens.map(stem));
  const categories = CATEGORY_DEFS.filter((c) => {
    if (c.sig.length === 1 && c.sig[0] === 'accessory') return false; // too generic on its own
    const hit = c.sig.filter((t) => stems.has(t)).length;
    return hit === c.sig.length || (c.sig.length >= 3 && hit >= 2 && hit / c.sig.length >= 0.6 && stems.has(c.head));
  }).map((c) => c.slug);
  const topCategories = new Set<string>();
  for (const [top, syn] of Object.entries(TOP_SYNONYMS)) if (syn.some((w) => tokens.includes(w))) topCategories.add(top);
  if (audienceKind === 'pet') topCategories.add('pet');
  if (audienceKind === 'kids') topCategories.add('kids');
  for (const c of categories) { const def = CATEGORY_DEFS.find((d) => d.slug === c); if (def) topCategories.add(def.top); }

  // keywords = remaining content words
  const consumed = new Set<string>();
  for (const a of attributes) for (const w of words(a.value)) consumed.add(w);
  const keywords: string[] = [];
  for (const t of tokens) {
    if (t.length < 2 || STOPWORDS.has(t) || /^\d+$/.test(t) || t === "'" ) continue;
    const clean = t.replace(/'s$/, '').replace(/'/g, '');
    if (clean.length < 2 || STOPWORDS.has(clean) || consumed.has(clean)) continue;
    if (!keywords.includes(clean)) keywords.push(clean);
    if (keywords.length >= 12) break;
  }

  const budget = bg.budget;
  if (budget?.ambiguousDollar && ctx.marketCurrency === 'INR') notes.push('“$” was read as US dollars and converted to rupees at the platform exchange rate');
  if (isGift && recipient && !['dog', 'cat', 'puppy', 'kitten', 'pet', 'kid', 'kids', 'child', 'children', 'baby', 'toddler', 'newborn', 'son', 'daughter', 'niece', 'nephew'].includes(recipient)) {
    notes.push(`We do not know ${recipient}’s taste, so gift results are ranked by your keywords and need, not by who it is for`);
  }

  return {
    raw,
    text: s.replace(/\s+/g, ' ').trim(),
    keywords,
    extraTerms: [],
    needs,
    categories,
    topCategories: [...topCategories],
    budget,
    gift: isGift ? { ...(recipient ? { recipient } : {}), ...(occasion ? { occasion } : {}) } : null,
    audience: { kind: audienceKind, ...(species ? { species } : {}), ...(ageYears !== undefined ? { ageYears } : {}) },
    attributes,
    deadline: dl.deadline,
    sort,
    compare,
    notes,
  };
}

/** Human description of the deadline for chips. */
export const describeDeadline = (d: { date: Ymd; label: string }): string => `Arrive by ${formatYmd(d.date)}`;
