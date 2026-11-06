/**
 * Pure product-matching similarity. Produces scored candidate matches with human-readable reasons.
 * Nothing here links anything: a person approves every candidate (no auto-merging).
 */

export interface MatchItem {
  title: string;
  brand?: string | null;
  gtin?: string | null;
  mpn?: string | null;
  category?: string | null;
  attributes?: Record<string, string> | null;
  /** Optional 64-bit perceptual hashes as 16-char hex strings (computed from product photos when enabled). */
  imageHashes?: string[] | null;
}

export interface MatchReason { kind: string; detail: string; weight: number }
export interface MatchResult { score: number; confidence: 'high' | 'medium' | 'low'; reasons: MatchReason[]; conflicts: string[] }

const STOP = new Set(['the', 'a', 'an', 'for', 'with', 'and', 'of', 'new', 'hot', 'sale', 'free', 'shipping', 'best', 'quality', 'high', 'premium', 'original', 'brand', 'set', 'pack', 'in', 'to', 'by', 'on', 'pcs', 'pc']);

export function stripDiacritics(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

type Dim = 'volumeMl' | 'massG' | 'lengthMm' | 'count';
const UNIT: Record<string, [Dim, number]> = {
  ml: ['volumeMl', 1], l: ['volumeMl', 1000], litre: ['volumeMl', 1000], liter: ['volumeMl', 1000], oz: ['volumeMl', 29.57], floz: ['volumeMl', 29.57],
  g: ['massG', 1], kg: ['massG', 1000], lb: ['massG', 453.6], lbs: ['massG', 453.6],
  mm: ['lengthMm', 1], cm: ['lengthMm', 10], m: ['lengthMm', 1000], in: ['lengthMm', 25.4], inch: ['lengthMm', 25.4],
  pcs: ['count', 1], pc: ['count', 1], ct: ['count', 1], pack: ['count', 1],
};

/** Measures such as "500 ml", "1.5L", "10cm", "12 pcs" in canonical units. `oz` is treated as fluid ounces only next to a volume-like title; ambiguous mass/volume is skipped. */
export function extractMeasures(title: string): Partial<Record<Dim, number[]>> {
  const out: Partial<Record<Dim, number[]>> = {};
  const t = stripDiacritics(title.toLowerCase());
  const re = /(\d+(?:[.,]\d+)?)\s*(ml|litre|liter|l|g|kg|lbs|lb|mm|cm|m|inch|in|pcs|pc|ct|pack)\b/g;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    const [dim, mult] = UNIT[m[2]!]!;
    const v = Number(m[1]!.replace(',', '.')) * mult;
    if (Number.isFinite(v) && v > 0) (out[dim] ??= []).push(Math.round(v * 100) / 100);
  }
  return out;
}

export function normalizeTitle(title: string): string {
  return stripDiacritics(title.toLowerCase()).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((t) => t && !STOP.has(t)).join(' ');
}
const tokens = (n: string): string[] => n.split(' ').filter((t) => t.length >= 2 || /\d/.test(t));

function bigrams(s: string): Map<string, number> {
  const c = s.replace(/\s+/g, '');
  const m = new Map<string, number>();
  for (let i = 0; i < c.length - 1; i++) { const g = c.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1); }
  return m;
}

/** 0..1: blend of token Jaccard and character-bigram Dice on normalised titles. */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a), nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = new Set(tokens(na)), tb = new Set(tokens(nb));
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const jac = ta.size + tb.size - inter > 0 ? inter / (ta.size + tb.size - inter) : 0;
  const ba = bigrams(na), bb = bigrams(nb);
  let shared = 0, tot = 0;
  for (const [g, n] of ba) { shared += Math.min(n, bb.get(g) ?? 0); tot += n; }
  for (const n of bb.values()) tot += n;
  const dice = tot > 0 ? (2 * shared) / tot : 0;
  return 0.5 * jac + 0.5 * dice;
}

/** GTIN-8/12/13/14 -> zero-padded 14 digits, or null when it is not a structurally valid GS1 number (check digit). */
export function normalizeGtin(raw: string | null | undefined): string | null {
  const d = (raw ?? '').replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(d.length)) return null;
  const p = d.padStart(14, '0');
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(p[i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === Number(p[13]) ? p : null;
}

export const normalizeMpn = (raw: string | null | undefined): string => stripDiacritics((raw ?? '').toLowerCase()).replace(/[^a-z0-9]/g, '');
const normBrand = (raw: string | null | undefined): string => stripDiacritics((raw ?? '').toLowerCase()).replace(/[^a-z0-9]/g, '');

export function hammingHex(a: string, b: string): number | null {
  if (!/^[0-9a-f]{16}$/i.test(a) || !/^[0-9a-f]{16}$/i.test(b)) return null;
  let d = 0;
  for (let i = 0; i < 16; i++) { let x = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16); while (x) { d += x & 1; x >>= 1; } }
  return d;
}

const ATTR_KEYS = ['color', 'colour', 'size', 'material', 'model', 'capacity', 'flavor', 'flavour', 'age'] as const;
const normAttr = (v: string | undefined) => stripDiacritics((v ?? '').toLowerCase()).replace(/[^a-z0-9]/g, '');

export function scoreMatch(a: MatchItem, b: MatchItem): MatchResult {
  const reasons: MatchReason[] = [];
  const conflicts: string[] = [];
  const sim = titleSimilarity(a.title, b.title);
  let s = sim * 0.62;
  if (sim > 0) reasons.push({ kind: 'title', detail: `Title similarity ${(sim * 100).toFixed(0)}%`, weight: Math.round(sim * 0.62 * 100) / 100 });

  const ga = normalizeGtin(a.gtin), gb = normalizeGtin(b.gtin);
  let gtinExact = false;
  if (ga && gb) {
    if (ga === gb) { gtinExact = true; reasons.push({ kind: 'gtin', detail: `Identical GTIN ${ga.replace(/^0+/, '')}`, weight: 0.9 }); }
    else conflicts.push('GTINs differ: these are different products');
  }
  const ma = normalizeMpn(a.mpn), mb = normalizeMpn(b.mpn);
  const ba = normBrand(a.brand), bb = normBrand(b.brand);
  if (ma.length >= 4 && ma === mb) {
    const w = ba && ba === bb ? 0.85 : 0.5;
    s = Math.max(s, w) + 0.05;
    reasons.push({ kind: 'mpn', detail: `Same manufacturer part number ${a.mpn}${ba && ba === bb ? ' and brand' : ''}`, weight: w });
  } else if (ma.length >= 4 && mb.length >= 4 && ma !== mb && ba && ba === bb) {
    s -= 0.1;
    conflicts.push('Same brand but different manufacturer part numbers');
  }
  if (ba && bb) {
    if (ba === bb) { s += 0.08; reasons.push({ kind: 'brand', detail: `Same brand "${a.brand}"`, weight: 0.08 }); }
    else { s -= 0.2; conflicts.push(`Brands differ ("${a.brand}" vs "${b.brand}")`); }
  }

  // measurements: a different size/volume/count is a different SKU even when the titles look alike
  const meA = extractMeasures(a.title), meB = extractMeasures(b.title);
  let measureConflict = false;
  for (const dim of Object.keys(meA) as Dim[]) {
    const x = meA[dim], y = meB[dim];
    if (!x?.length || !y?.length) continue;
    const same = x.some((v) => y.some((w) => Math.abs(v - w) / Math.max(v, w) <= 0.02));
    if (same) { s += 0.04; reasons.push({ kind: 'measure', detail: `Same ${dim} (${x[0]})`, weight: 0.04 }); } else { measureConflict = true; conflicts.push(`Different ${dim} (${x[0]} vs ${y[0]})`); }
  }
  if (measureConflict) s *= 0.6;

  // attributes
  const at = a.attributes ?? {}, bt = b.attributes ?? {};
  let attrHits = 0;
  for (const k of ATTR_KEYS) {
    const x = normAttr(at[k]), y = normAttr(bt[k]);
    if (!x || !y) continue;
    if (x === y) attrHits++;
    else { s -= 0.1; conflicts.push(`${k} differs ("${at[k]}" vs "${bt[k]}")`); }
  }
  if (attrHits) { s += Math.min(0.1, attrHits * 0.04); reasons.push({ kind: 'attributes', detail: `${attrHits} matching attribute(s)`, weight: Math.min(0.1, attrHits * 0.04) }); }

  // images
  let bestHam: number | null = null;
  for (const x of a.imageHashes ?? []) for (const y of b.imageHashes ?? []) { const d = hammingHex(x, y); if (d !== null && (bestHam === null || d < bestHam)) bestHam = d; }
  if (bestHam !== null && bestHam <= 10) {
    const w = bestHam <= 5 ? 0.25 : 0.1;
    s += w;
    reasons.push({ kind: 'image', detail: `Similar product photo (perceptual hash distance ${bestHam}/64)`, weight: w });
  }

  if (a.category && b.category && normAttr(a.category) !== normAttr(b.category) && sim < 0.8) s -= 0.05;

  if (gtinExact) s = Math.max(s, 0.92);
  if (conflicts.some((c) => c.startsWith('GTINs differ'))) s = Math.min(s, 0.2);
  const score = Math.max(0, Math.min(1, Math.round(s * 1000) / 1000));
  const confidence: MatchResult['confidence'] = conflicts.length === 0 && (gtinExact || score >= 0.85) ? 'high' : conflicts.length <= 1 && score >= 0.65 ? 'medium' : 'low';
  return { score, confidence, reasons, conflicts };
}

export interface RankedMatch<T> extends MatchResult { target: T }
/** Best candidates for `source` among `targets`, at or above `minScore`. Bounded by `limit`. */
export function rankMatches<T extends { item: MatchItem }>(source: MatchItem, targets: T[], o: { minScore?: number; limit?: number } = {}): RankedMatch<T>[] {
  const min = o.minScore ?? 0.55;
  return targets
    .map((t) => ({ target: t, ...scoreMatch(source, t.item) }))
    .filter((r) => r.score >= min)
    .sort((x, y) => y.score - x.score)
    .slice(0, o.limit ?? 5);
}

/** dHash of a pre-resized 9x8 grayscale buffer (72 bytes) as 16 hex chars. Pure so it can be tested without sharp. */
export function dHashFromGray9x8(gray: ArrayLike<number>): string {
  let bits = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += gray[y * 9 + x]! > gray[y * 9 + x + 1]! ? '1' : '0';
  let hex = '';
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}
