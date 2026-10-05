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
