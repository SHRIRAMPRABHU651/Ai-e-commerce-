/**
 * Honesty guards (pure):
 *  - AI-claim guard: AI-generated text can never become a safety claim, certificate or compliance statement.
 *  - No-leak serializer: customer-facing payloads never carry cost, margin or internal supplier identifiers.
 */
import type { PassportField, Provenance } from '@orvia/types';

/** Phrases that assert safety, certification, compliance or health/environmental properties. */
const CLAIM_PATTERNS: RegExp[] = [
  /\b(certified|certification|certificate|accredited|approved by|approval)\b/i,
  /\b(compl(y|ies|iant|iance)|conforms?|conformity|meets? (the )?(\w+ )?(standard|requirements?|regulations?))\b/i,
  /\b(safe|safety|safety[- ]tested|child[- ]safe|baby[- ]safe|pet[- ]safe|food[- ]safe|food[- ]grade|lab[- ]tested|tested (for|by|to)|passed (all )?tests?)\b/i,
  /\b(non[- ]?toxic|toxin[- ]free|bpa[- ]?free|phthalate[- ]?free|lead[- ]?free|hypoallergenic|flame[- ]retardant|fire[- ]resistant|nontoxic)\b/i,
  /\b(organic|biodegradable|compostable|eco[- ]?friendly|sustainabl[ey]|plant[- ]based|vegan|cruelty[- ]free|fair[- ]trade)\b/i,
  /\b(CE|UL|FCC|RoHS|REACH|CPSIA|CPSC|ASTM|EN ?71|EN ?62115|ISO ?\d+|FDA|BIS|CSA|GOTS|OEKO[- ]?TEX|USDA|FSC)\b/,
  /\b(medical[- ]grade|clinically (proven|tested)|dermatologist[- ]tested|FDA[- ]approved)\b/i,
];

export function containsRestrictedClaim(text: string): boolean {
  return CLAIM_PATTERNS.some((re) => re.test(text));
}

/** Remove every sentence that makes a safety/certification/compliance/health claim. */
export function stripUnsafeClaims(text: string): { text: string; removed: string[] } {
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const kept: string[] = [];
  const removed: string[] = [];
  for (const s of sentences) (containsRestrictedClaim(s) ? removed : kept).push(s);
  return { text: kept.join(' '), removed };
}

export type FieldKind = 'descriptive' | 'claim';
export class AiClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiClaimError';
  }
}

/**
 * Build a passport field. `claim` fields (safety, certificate, compliance, restriction) can never carry
 * `ai_suggested` provenance, and `descriptive` ai_suggested text is stripped of claim sentences.
 * Returns null when nothing safe remains.
 */
export function guardedField(opts: { kind: FieldKind; value: string; provenance: Provenance; source: string; observedAt?: string | null; freshness?: number | null }): PassportField | null {
  const { kind, provenance } = opts;
  let value = opts.value.trim();
  if (!value) return null;
  if (provenance === 'ai_suggested') {
    if (kind === 'claim') throw new AiClaimError('AI-suggested content cannot be presented as a safety claim, certificate or compliance statement');
    value = stripUnsafeClaims(value).text;
    if (!value) return null;
  }
  return { value, provenance, source: opts.source, observedAt: opts.observedAt ?? null, freshness: opts.freshness ?? null };
}

/** Assert (throws) that no ai_suggested field appears where claims live. Walks an arbitrary payload. */
export function assertNoAiClaims(claimFields: { provenance: Provenance; value?: string; title?: string }[]): void {
  for (const f of claimFields) if (f.provenance === 'ai_suggested') throw new AiClaimError(`AI-suggested content in a claim position: ${f.title ?? f.value ?? ''}`.slice(0, 160));
}

/* ------------------------------ no-leak serializer ------------------------------ */

/** Keys that must never reach a customer. Matched case-insensitively on exact key name. */
export const INTERNAL_KEYS = new Set([
  'productcost', 'shippingcost', 'fulfillmentfee', 'landedcost', 'expectedmargin', 'expectedprofit', 'margin', 'marginpct', 'profit',
  'supplierid', 'supplierref', 'suppliercode', 'bestsupplierid', 'supplierproductid', 'offerid', 'suppliercost', 'costs', 'cost', 'cpa', 'credentials', 'credentialsenc',
  'targetmarginpct', 'pricingconfig', 'intel', 'externalid', 'supplierorderid', 'pricehistoryinternal',
]);

/** Deep-clone `value` dropping every internal key. Dates are preserved as ISO strings. */
export function toCustomerSafe<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v instanceof Date) return v.toISOString();
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (INTERNAL_KEYS.has(k.toLowerCase())) continue;
        out[k] = walk(x);
      }
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/** Paths of any internal key (or any provided internal id value) found in a payload. Empty array = clean. */
export function findLeaks(value: unknown, internalValues: string[] = []): string[] {
  const hits: string[] = [];
  const vals = new Set(internalValues.filter(Boolean));
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (INTERNAL_KEYS.has(k.toLowerCase())) hits.push(`${path}.${k}`);
        walk(x, `${path}.${k}`);
      }
    } else if (typeof v === 'string' && vals.has(v)) hits.push(`${path}=<internal value>`);
  };
  walk(value, '$');
  return hits;
}
