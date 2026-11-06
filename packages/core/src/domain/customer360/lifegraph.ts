/**
 * LifeGraph: customer-declared needs and preferences as typed nodes/edges. PURE (no IO) so it is unit-testable and
 * reusable by discovery / recommendations via `personalizationSignals`.
 *
 * Safety model: an ALLOWLIST of attribute kinds. Anything not on it is rejected. On top of that a deny-guard rejects
 * kinds and free-text values that look like sensitive characteristics (health, religion, ethnicity, sexuality, politics,
 * precise location, children's exact ages, ...). The guard also filters purchase-derived nodes so we never "infer" a
 * sensitive trait from what someone bought.
 */
import type { LifeGraphPurpose, LifeGraphSource } from '@orvia/types';

export interface KindSpec {
  /** Edge label from the customer root to this node. */
  rel: string;
  purpose: LifeGraphPurpose;
  /** Closed vocabulary; `null` means a catalogue slug validated by `SLUG_RE`. */
  values: readonly string[] | null;
  label: string;
  /** May this kind be derived from purchases (always visible + deletable)? */
  derivable?: boolean;
  /** Can be attached under a parent node (e.g. occasion under gift recipient). */
  parentKind?: string;
  /** At most one node of this kind per customer. */
  single?: boolean;
}

export const LIFEGRAPH_KINDS: Record<string, KindSpec> = {
  pet_type: { rel: 'has_pet', purpose: 'personalization', label: 'Pets', values: ['dog', 'cat', 'bird', 'small_animal', 'fish', 'reptile', 'other_pet'] },
  eco_preference: { rel: 'prefers', purpose: 'eco_filtering', label: 'Eco preference', values: ['prefer_verified_eco'], single: true },
  budget_range: { rel: 'shops_within', purpose: 'recommendations', label: 'Budget range', values: ['budget', 'mid', 'premium'], single: true },
  category_interest: { rel: 'interested_in', purpose: 'recommendations', label: 'Categories of interest', values: null, derivable: true },
  gift_recipient: { rel: 'buys_gifts_for', purpose: 'gift_help', label: 'Gift recipients', values: ['partner', 'parent', 'child', 'friend', 'colleague', 'pet', 'other'] },
  gift_occasion: { rel: 'for_occasion', purpose: 'gift_help', label: 'Gift occasions', values: ['birthday', 'holiday', 'anniversary', 'housewarming', 'other'], parentKind: 'gift_recipient' },
  // Deliberately coarse: a band chosen by the customer, never a date of birth or exact age.
  child_age_band: { rel: 'shops_for_children_aged', purpose: 'recommendations', label: 'Children (coarse age band, optional)', values: ['0-2', '3-5', '6-8', '9-12', '13-17'] },
  style_preference: { rel: 'likes_style', purpose: 'personalization', label: 'Style', values: ['minimal', 'colourful', 'classic', 'sporty'] },
  delivery_priority: { rel: 'values', purpose: 'personalization', label: 'Delivery priority', values: ['fastest', 'cheapest', 'lowest_impact'], single: true },
};

export const ALLOWED_KINDS = Object.keys(LIFEGRAPH_KINDS);
export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+){0,5}$/;

/** Attribute kinds we refuse by name (checked before the allowlist so the error is explicit). */
export const DENIED_KIND_FAMILIES: Record<string, RegExp> = {
  health: /health|medical|medication|diagnos|condition|illness|disease|disabilit|pregnan|fertil|mental|therapy|allerg/i,
  religion: /relig|faith|church|mosque|temple|belief/i,
  ethnicity: /ethnic|race|racial|nationality|origin|caste|skin_?colou?r/i,
  sexuality: /sex|gender_?identity|orientation|lgbt|transgender/i,
  politics: /politic|party|vote|voting|ideolog/i,
  location: /location|address|gps|geo|coordinates|home_?town|postcode|postal|zip/i,
  children_exact: /child.*(age|birth|dob)|birth|dob|date_?of_?birth|exact_?age|^age$/i,
  finance: /income|salary|debt|credit_?score|bankrupt|net_?worth/i,
  other_sensitive: /union|criminal|immigration|biometric|genetic/i,
};

/** Free-text / slug values that look like a sensitive characteristic. Conservative on purpose (false positives are fine). */
const SENSITIVE_VALUE_RE = new RegExp(
  [
    // health
    'health', 'medical', 'medic(ation|ine)', 'diagnos', 'disease', 'illness', 'cancer', 'diabet', 'depress', 'anxiety', 'adhd', 'autis', '\\bhiv\\b', '\\baids\\b', 'pregnan', 'fertility', 'incontinen', 'disabilit', 'mobility-aid', 'therap', 'addict', 'sobriety', '\\bmental', 'allerg', 'chronic', 'prosthe', 'hearing-aid', 'weight-loss',
    // religion
    'relig', 'christian', 'muslim', 'islam', '\\bjew(ish)?\\b', 'judais', 'hindu', 'sikh', 'buddh', 'atheis', 'church', 'mosque', 'synagogue', 'prayer', 'halal', 'kosher',
    // ethnicity / race
    'ethnic', 'racial', '\\brace\\b', '\\bcaste\\b', 'immigra', 'refugee',
    // sexuality / gender identity
    'sexual', '\\bgay\\b', 'lesbian', 'bisexual', 'lgbt', 'queer', 'transgender', 'gender-identity', 'fetish',
    // politics
    'politic', 'democrat', 'republican', 'conservative', 'liberal', 'labou?r-party', '\\btrump\\b', '\\belection', 'campaign-donat', 'trade-union',
    // precise location
    '\\bstreet\\b', '\\baddress\\b', 'gps', 'latitude', 'longitude', '\\b\\d{5}(-\\d{4})?\\b', '[a-z]\\d[a-z] ?\\d[a-z]\\d',
    // exact ages / birth dates
    'birth(?!day)', '\\bdob\\b', '\\b\\d{1,2} ?(yo|y/o|years?-?old)\\b', '\\bage-?\\d{1,2}\\b',
    // finance / legal
    'bankrupt', 'debt', 'criminal', 'convict',
  ].join('|'),
  'i',
);

export type GuardResult = { ok: true } | { ok: false; reason: string; family?: string };

/** Deny-guard for an attribute kind name. */
export function guardKind(kind: string): GuardResult {
  if (Object.prototype.hasOwnProperty.call(LIFEGRAPH_KINDS, kind)) return { ok: true }; // exact allowlisted names are safe by construction
  for (const [family, re] of Object.entries(DENIED_KIND_FAMILIES)) {
    if (re.test(kind)) return { ok: false, reason: `"${kind}" looks like a sensitive characteristic (${family.replace('_', ' ')}) and is never collected`, family };
  }
  if (!Object.prototype.hasOwnProperty.call(LIFEGRAPH_KINDS, kind)) return { ok: false, reason: `"${kind}" is not a permitted LifeGraph attribute` };
  return { ok: true };
}

/** Deny-guard for a value (free text or slug). */
export function guardValue(value: string): GuardResult {
  if (SENSITIVE_VALUE_RE.test(value)) return { ok: false, reason: 'This looks like a sensitive characteristic, which LifeGraph never stores', family: 'sensitive_value' };
  return { ok: true };
}

export interface NodeInput { kind: string; value: string; parentKind?: string }
export type NodeValidation = { ok: true; kind: string; value: string; spec: KindSpec } | { ok: false; reason: string };

/** Validate a customer-declared node: allowlisted kind, permitted value, deny-guard on both. */
export function validateNode(input: { kind: string; value: string }): NodeValidation {
  const k = input.kind.trim();
  const v = input.value.trim();
  const gk = guardKind(k);
  if (!gk.ok) return gk;
  const spec = LIFEGRAPH_KINDS[k]!;
  if (spec.values) {
    if (!spec.values.includes(v)) return { ok: false, reason: `"${v}" is not an allowed value for ${spec.label}. Choose one of: ${spec.values.join(', ')}` };
  } else {
    if (!SLUG_RE.test(v)) return { ok: false, reason: 'Use a catalogue category (lowercase letters, numbers and hyphens)' };
    const gv = guardValue(v); // only free-form values need the text guard; closed vocabularies are safe by construction
    if (!gv.ok) return gv;
  }
  return { ok: true, kind: k, value: v, spec };
}

/* ------------------------------ derivation ------------------------------ */
/** Derive category interests from purchases. Counts a category only if bought at least `minPurchases` times and passes the guard. */
export function deriveFromPurchases(purchasedCategories: string[], minPurchases = 2): { kind: string; value: string }[] {
  const counts = new Map<string, number>();
  for (const c of purchasedCategories) if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  const out: { kind: string; value: string }[] = [];
  for (const [value, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    if (n < minPurchases) continue;
    const v = validateNode({ kind: 'category_interest', value });
    if (v.ok) out.push({ kind: 'category_interest', value });
    if (out.length >= 5) break;
  }
  return out;
}

/* ------------------------------ graph + signals ------------------------------ */
export interface GraphNode { id: string; kind: string; value: string; source: LifeGraphSource; parentId?: string }
export interface Graph {
  nodes: { id: string; type: string; label: string }[];
  edges: { from: string; rel: string; to: string }[];
}

/** Typed nodes/edges view: `self` -rel-> node, and parent -rel-> child for chained nodes (recipient -for_occasion-> occasion). */
export function toGraph(nodes: GraphNode[]): Graph {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const g: Graph = { nodes: [{ id: 'self', type: 'customer', label: 'You' }], edges: [] };
  for (const n of nodes) {
    const spec = LIFEGRAPH_KINDS[n.kind];
    if (!spec) continue; // unknown kinds (e.g. from an older version) are never surfaced to consumers
    g.nodes.push({ id: n.id, type: n.kind, label: n.value });
    const parent = n.parentId ? byId.get(n.parentId) : undefined;
    g.edges.push({ from: parent ? parent.id : 'self', rel: spec.rel, to: n.id });
  }
  return g;
}

export interface LifeGraphInput { enabled: boolean; personalizationConsent: boolean; nodes: GraphNode[] }
export interface PersonalizationSignals {
  active: boolean;
  categories: string[];
  derivedCategories: string[];
  petTypes: string[];
  ecoVerifiedOnly: boolean;
  budget?: 'budget' | 'mid' | 'premium';
  styles: string[];
  giftRecipients: string[];
  /** Human explanations, always phrased as what the customer told us. */
  reasons: { signal: string; text: string }[];
}

const EMPTY: PersonalizationSignals = { active: false, categories: [], derivedCategories: [], petTypes: [], ecoVerifiedOnly: false, styles: [], giftRecipients: [], reasons: [] };

/**
 * Pure signal extraction for discovery / recommendations. Returns an inactive, empty result unless the customer has
 * switched LifeGraph on AND given personalization consent. Unknown / non-allowlisted nodes are ignored.
 */
export function personalizationSignals(g: LifeGraphInput): PersonalizationSignals {
  if (!g.enabled || !g.personalizationConsent) return { ...EMPTY, categories: [], derivedCategories: [], petTypes: [], styles: [], giftRecipients: [], reasons: [] };
  const s: PersonalizationSignals = { ...EMPTY, active: true, categories: [], derivedCategories: [], petTypes: [], styles: [], giftRecipients: [], reasons: [] };
  for (const n of g.nodes) {
    if (!validateNode(n).ok) continue; // re-check on read: stored data is never trusted
    const declared = n.source === 'declared';
    const hu = (x: string) => x.replace(/[-_]/g, ' ');
    switch (n.kind) {
      case 'category_interest':
        if (declared) { s.categories.push(n.value); s.reasons.push({ signal: `category:${n.value}`, text: `because you told us you are interested in ${hu(n.value)}` }); }
        else { s.derivedCategories.push(n.value); s.reasons.push({ signal: `category:${n.value}`, text: `because you have bought ${hu(n.value)} before` }); }
        break;
      case 'pet_type': s.petTypes.push(n.value); s.reasons.push({ signal: `pet:${n.value}`, text: `because you told us you have a ${hu(n.value)}` }); break;
      case 'eco_preference': s.ecoVerifiedOnly = true; s.reasons.push({ signal: 'eco', text: 'because you told us you prefer products with verified eco evidence' }); break;
      case 'budget_range': s.budget = n.value as 'budget' | 'mid' | 'premium'; s.reasons.push({ signal: `budget:${n.value}`, text: `because you told us your budget is ${n.value}` }); break;
      case 'style_preference': s.styles.push(n.value); s.reasons.push({ signal: `style:${n.value}`, text: `because you told us you like a ${n.value} style` }); break;
      case 'gift_recipient': s.giftRecipients.push(n.value); break;
      default: break;
    }
  }
  return s;
}

/* ------------------------------ ranking boost ------------------------------ */
export interface Candidate { id: string; category?: string; topCategory?: string; tags: string[]; price: number | null; ecoVerified: boolean }
export interface Ranked { id: string; score: number; reasons: string[] }

/** Tag vocabulary that corresponds to each pet type. A tag match is the only way a pet signal boosts a product. */
const PET_TAGS: Record<string, string[]> = { dog: ['dog', 'dogs', 'puppy'], cat: ['cat', 'cats', 'kitten'], bird: ['bird', 'birds'], small_animal: ['small-animal', 'rabbit', 'hamster'], fish: ['fish', 'aquarium'], reptile: ['reptile'], other_pet: [] };

/**
 * Re-rank recommendation candidates using LifeGraph signals. Base order is preserved as the tiebreaker (the input array
 * is already ordered by the existing recommender). Each boost carries an explanation; a candidate with no boost gets none.
 * Budget is relative to the candidate set (terciles), so no absolute price claims are made.
 */
export function rankWithSignals(candidates: Candidate[], sig: PersonalizationSignals): Ranked[] {
  const prices = candidates.map((c) => c.price).filter((p): p is number => p !== null).sort((a, b) => a - b);
  const lo = prices[Math.floor(prices.length / 3)] ?? 0;
  const hi = prices[Math.floor((prices.length * 2) / 3)] ?? Infinity;
  const out = candidates.map((c, i) => {
    let score = 0;
    const reasons: string[] = [];
    if (sig.active) {
      const tags = c.tags.map((t) => t.toLowerCase());
      const hit = (list: string[]) => list.find((x) => x === c.category || x === c.topCategory || tags.includes(x));
      const dec = hit(sig.categories);
      if (dec) { score += 3; reasons.push(`Because you told us you are interested in ${dec.replace(/-/g, ' ')}`); }
      const der = hit(sig.derivedCategories);
      if (der && !dec) { score += 1.5; reasons.push(`Because you have bought ${der.replace(/-/g, ' ')} before`); }
      for (const p of sig.petTypes) if (PET_TAGS[p]?.some((t) => tags.includes(t))) { score += 3; reasons.push(`Because you told us you have a ${p.replace(/_/g, ' ')}`); break; }
      if (sig.ecoVerifiedOnly && c.ecoVerified) { score += 2; reasons.push('Because you told us you prefer verified eco evidence, and this product has it'); }
      if (sig.budget && c.price !== null) {
        const band = c.price <= lo ? 'budget' : c.price >= hi ? 'premium' : 'mid';
        if (band === sig.budget) { score += 1; reasons.push(`Because you told us your budget is ${sig.budget}`); }
      }
      for (const st of sig.styles) if (tags.includes(st)) { score += 1; reasons.push(`Because you told us you like a ${st} style`); break; }
    }
    return { id: c.id, score, reasons, i };
  });
  return out.sort((a, b) => b.score - a.score || a.i - b.i).map(({ id, score, reasons }) => ({ id, score, reasons }));
}
