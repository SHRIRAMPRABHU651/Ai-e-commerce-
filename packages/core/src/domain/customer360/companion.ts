/**
 * Product Companion: documentation, care and aftercare facts for something the customer bought. PURE.
 * Honesty rule: every statement is copied from a product field that exists. Where the field is missing the result is an
 * explicit `not_provided` section, never generated guidance.
 */
export const NOT_PROVIDED = 'Not provided by the supplier yet';

export interface CompanionProduct {
  title: string;
  description?: string | null;
  bullets?: string[] | null;
  features?: string[] | null;
  tags?: string[] | null;
  category?: string | null;
  attributes?: Record<string, string> | Map<string, string> | null;
  compliance?: { safetyInfo?: { standards?: string[] | null; ageRange?: string | null } | null } | null;
  organic?: { evidence?: { claim: string; type: string; verified?: boolean; body?: string | null; certId?: string | null; expiresAt?: Date | string | null }[] | null } | null;
}

export type Provenance = 'verified' | 'supplier_provided';
export type Section<T> = ({ status: 'provided'; provenance: Provenance } & T) | { status: 'not_provided'; message: string };

const norm = (k: string) => k.trim().toLowerCase().replace(/[\s-]+/g, '_');
const attrEntries = (a: CompanionProduct['attributes']): [string, string][] => {
  if (!a) return [];
  const e = a instanceof Map ? [...a.entries()] : Object.entries(a);
  return e.map(([k, v]) => [String(k), String(v)] as [string, string]).filter(([, v]) => v.trim() !== '');
};
const pick = (entries: [string, string][], keys: readonly string[]): { key: string; value: string } | null => {
  const wanted = new Set(keys);
  const hit = entries.find(([k]) => wanted.has(norm(k)));
  return hit ? { key: hit[0], value: hit[1].trim() } : null;
};

export const CARE_KEYS = ['care', 'care_instructions', 'care_guide', 'washing', 'wash_instructions', 'cleaning', 'cleaning_instructions', 'maintenance'] as const;
export const USAGE_KEYS = ['usage', 'usage_instructions', 'how_to_use', 'directions', 'instructions', 'assembly', 'assembly_instructions'] as const;
export const WARRANTY_KEYS = ['warranty', 'warranty_period', 'warranty_months', 'warranty_terms'] as const;
export const COMPAT_KEYS = ['compatible_with', 'compatibility', 'fits', 'works_with'] as const;
export const REPLENISH_KEYS = ['replenish_after_days', 'reorder_after_days', 'usage_days'] as const;
export const CONSUMABLE_TAGS = ['consumable', 'refill', 'replenishable'] as const;

export interface Companion {
  overview: Section<{ description: string; bullets: string[] }>;
  usage: Section<{ text: string; field: string }>;
  care: Section<{ text: string; field: string }>;
  specs: Section<{ items: { name: string; value: string }[] }>;
  safety: Section<{ standards: string[]; ageRange?: string }>;
  verifiedClaims: { claim: string; type: string; note?: string }[];
  warranty: Section<{ text: string; field: string }>;
  compatibility: { explicit: string[] };
  consumable: boolean;
  replenishIntervalDays: number | null;
}

const missing = { status: 'not_provided' as const, message: NOT_PROVIDED };

export function buildCompanion(p: CompanionProduct, now: Date): Companion {
  const attrs = attrEntries(p.attributes);
  const used = new Set<string>();
  const care = pick(attrs, CARE_KEYS);
  const usage = pick(attrs, USAGE_KEYS);
  const warranty = pick(attrs, WARRANTY_KEYS);
  const compat = pick(attrs, COMPAT_KEYS);
  const repl = pick(attrs, REPLENISH_KEYS);
  for (const x of [care, usage, warranty, compat, repl]) if (x) used.add(x.key);

  const description = (p.description ?? '').trim();
  const bullets = (p.bullets ?? []).filter((b) => b.trim());
  const specs = attrs.filter(([k]) => !used.has(k)).map(([name, value]) => ({ name, value }));
  const si = p.compliance?.safetyInfo;
  const standards = (si?.standards ?? []).filter(Boolean);
  const ageRange = si?.ageRange ?? undefined;
  const replDays = repl && /^\d{1,4}$/.test(repl.value) ? Number(repl.value) : null;

  return {
    overview: description || bullets.length ? { status: 'provided', provenance: 'supplier_provided', description, bullets } : missing,
    usage: usage ? { status: 'provided', provenance: 'supplier_provided', text: usage.value, field: usage.key } : missing,
    care: care ? { status: 'provided', provenance: 'supplier_provided', text: care.value, field: care.key } : missing,
    specs: specs.length ? { status: 'provided', provenance: 'supplier_provided', items: specs } : missing,
    safety: standards.length || ageRange ? { status: 'provided', provenance: 'supplier_provided', standards, ageRange } : missing,
    // Only evidence an operator verified, and that has not expired, is shown as a claim.
    verifiedClaims: (p.organic?.evidence ?? [])
      .filter((e) => e.verified && (!e.expiresAt || new Date(e.expiresAt).getTime() > now.getTime()))
      .map((e) => ({ claim: e.claim, type: e.type, note: e.certId ? `Certificate ${e.certId}` : undefined })),
    warranty: warranty ? { status: 'provided', provenance: 'supplier_provided', text: warranty.value, field: warranty.key } : missing,
    compatibility: { explicit: compat ? compat.value.split(/[;,]/).map((s) => s.trim()).filter(Boolean).slice(0, 20) : [] },
    consumable: (p.tags ?? []).some((t) => (CONSUMABLE_TAGS as readonly string[]).includes(t.toLowerCase())),
    replenishIntervalDays: replDays,
  };
}

export interface ReplenishmentInput { consumable: boolean; intervalDays: number | null; purchasedAt: Date; now: Date; optedIn: boolean }
export interface ReplenishmentSuggestion { eligible: boolean; dueAt: Date | null; due: boolean; message: string }

/**
 * Replenishment is opt-in and makes no timing claim unless the product itself carries an interval attribute.
 * Without an interval it simply offers "buy again" on the page (never a reminder).
 */
export function replenishment(i: ReplenishmentInput): ReplenishmentSuggestion {
  if (!i.consumable) return { eligible: false, dueAt: null, due: false, message: 'This product is not marked as a consumable.' };
  if (i.intervalDays === null) return { eligible: true, dueAt: null, due: false, message: 'This looks like a consumable. The supplier has not given a usual usage period, so we will not guess when you need more.' };
  const dueAt = new Date(i.purchasedAt.getTime() + i.intervalDays * 86_400_000);
  const due = i.now.getTime() >= dueAt.getTime() - 7 * 86_400_000;
  return {
    eligible: true, dueAt, due,
    message: i.optedIn ? (due ? 'You may be running low (based on the supplier-stated usage period).' : 'We will suggest a reorder closer to the supplier-stated usage period.') : 'Turn on reorder suggestions in Preferences to see when you may need more.',
  };
}

/** Encode / decode the public order item id: `<orderId>_<lineIndex>`. Items are immutable so the index is stable. */
export const encodeOrderItemId = (orderId: string, index: number) => `${orderId}_${index}`;
export function decodeOrderItemId(id: string): { orderId: string; index: number } | null {
  const m = /^([a-f\d]{24})_(\d{1,3})$/i.exec(id);
  return m ? { orderId: m[1]!, index: Number(m[2]) } : null;
}
