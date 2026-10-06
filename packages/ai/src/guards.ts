/** Output guardrails: AI text must be grounded in source data. */

const UNIT = '(?:mm|cm|m|in|inch|inches|kg|g|lb|lbs|oz|ml|l|mah|w|v|hz|mp|gb|tb|hours?|hrs?|minutes?|mins?|days?|pcs?|pieces?|piece|pack|set|x|%|years?|yrs?|\\+|ft)';
const SPEC_RE = new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*-?\\s*${UNIT}\\b`, 'gi');
const NUM_RE = /\d+(?:[.,]\d+)?/g;

export function extractSpecs(text: string): string[] {
  return [...text.matchAll(SPEC_RE)].map((m) => m[0].toLowerCase().replace(/\s+/g, ''));
}

/** Specs (number+unit) present in the output but absent from the source are treated as invented. */
export function findInventedSpecs(sourceText: string, output: string): string[] {
  const src = sourceText.toLowerCase();
  const srcNums = new Set((src.match(NUM_RE) ?? []).map((n) => n.replace(',', '.')));
  const srcSpecs = new Set(extractSpecs(src));
  const invented: string[] = [];
  for (const spec of extractSpecs(output)) {
    const num = (spec.match(NUM_RE)?.[0] ?? '').replace(',', '.');
    if (!srcSpecs.has(spec) && !srcNums.has(num)) invented.push(spec);
  }
  return [...new Set(invented)];
}

const FORBIDDEN_CLAIMS = [
  /\bcures?\b/i, /\btreats?\b.*\b(disease|diabetes|cancer|anxiety|depression)/i, /\bclinically proven\b/i, /\bFDA[- ]approved\b/i,
  /\b100% (safe|guaranteed|effective)\b/i, /\bmiracle\b/i, /\bguaranteed results?\b/i, /\bnumber one\b|\b#1\b/i,
];
export function findForbiddenClaims(output: string): string[] {
  return FORBIDDEN_CLAIMS.filter((r) => r.test(output)).map((r) => r.source);
}

/** Every number quoted in a business narrative must appear in the data it was given. */
export function findUngroundedNumbers(dataJson: string, narrative: string): string[] {
  const normalise = (s: string) => s.replace(/[,$₹]/g, '').replace(/\.0+$/, '');
  const dataNums = new Set((dataJson.match(NUM_RE) ?? []).map(normalise));
  const bad: string[] = [];
  for (const n of narrative.match(/\d[\d,]*(?:\.\d+)?/g) ?? []) {
    const k = normalise(n);
    if (!dataNums.has(k) && !dataNums.has(String(Math.round(Number(k)))) && Number(k) > 10) bad.push(n);
  }
  return [...new Set(bad)];
}

/** Marks untrusted supplier text so the model treats it as data, not instructions. */
export function fence(label: string, text: string): string {
  const safe = text.replace(/<\/?untrusted[^>]*>/gi, '');
  return `<untrusted source="${label}">\n${safe}\n</untrusted>`;
}

/**
 * Environmental / health-adjacent marketing claims. Each needs real, verified evidence (a certificate or test report)
 * before it may appear in customer-facing copy. The AI may never introduce them on its own.
 */
export type ClaimKind = 'organic' | 'non_toxic' | 'eco' | 'biodegradable' | 'plant_based';
export const CLAIM_PATTERNS: { kind: ClaimKind; label: string; re: RegExp }[] = [
  { kind: 'organic', label: 'organic', re: /\b(?:100%\s*|certified\s+|usda\s+|fully\s+|all[- ])?organic(?:ally(?:\s+(?:grown|sourced))?)?\b/gi },
  { kind: 'non_toxic', label: 'non-toxic / chemical-free', re: /\b(?:non[- ]?toxic|chemical[- ]free|toxin[- ]free|toxic[- ]free|free (?:of|from) (?:harmful )?chemicals|bpa[- ]free|phthalate[- ]free|pesticide[- ]free)\b/gi },
  { kind: 'eco', label: 'eco-certified / sustainable', re: /\b(?:eco[- ]?certified|certified (?:sustainable|eco[- ]friendly|green)|carbon[- ]neutral|climate[- ]neutral|fair[- ]?trade|ethically sourced|sustainably (?:sourced|made|harvested))\b/gi },
  { kind: 'biodegradable', label: 'biodegradable / compostable', re: /\b(?:biodegradable|compostable|home[- ]compostable|plastic[- ]free|zero[- ]waste)\b/gi },
  { kind: 'plant_based', label: 'plant-based / vegan', re: /\b(?:plant[- ]based|vegan|cruelty[- ]free)\b/gi },
];

export function findEnvironmentalClaims(text: string): { kind: ClaimKind; label: string; match: string }[] {
  const out: { kind: ClaimKind; label: string; match: string }[] = [];
  for (const p of CLAIM_PATTERNS) for (const m of text.matchAll(new RegExp(p.re.source, 'gi'))) out.push({ kind: p.kind, label: p.label, match: m[0] });
  return out;
}

/** Remove claim phrases that lack evidence (`allowed` kinds are left alone). Keeps the sentence readable. */
export function stripEnvironmentalClaims(text: string, allowed: ClaimKind[] = []): { text: string; removed: string[] } {
  const removed: string[] = [];
  let out = text;
  for (const p of CLAIM_PATTERNS) {
    if (allowed.includes(p.kind)) continue;
    out = out.replace(new RegExp(`${p.re.source}(?:\\s*[,;]\\s*)?`, 'gi'), (m) => { removed.push(m.replace(/[\s,;]+$/, '')); return ''; });
  }
  out = out.replace(/\s{2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1').replace(/\(\s*\)/g, '').replace(/,\s*([.;!?])/g, '$1').replace(/\s[-–—]\s*([,.;!?]|$)/g, '$1').replace(/^\s*[-–—,]\s*/, '').replace(/\s{2,}/g, ' ').trim();
  return { text: out, removed };
}
