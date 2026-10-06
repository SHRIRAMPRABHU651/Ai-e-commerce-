/** Deterministic product-identity helpers: no LLM is involved in deciding whether two names are the same product. */
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'for', 'with', 'of', 'to', 'in', 'on', 'by', 'from', 'new', 'best', 'top', 'sale', 'free', 'shipping', 'buy', 'online', 'set', 'pack', 'pcs', 'piece', 'pieces', 'pc', 'size', 'color', 'colour', 'style', 'premium', 'quality', 'official', 'original', 'hot', 'popular', 'trending', 'cheap', 'deal', 'deals', 'review', 'reviews', 'asin', 'sku', 'model', 'item', 'amazon', 'walmart', 'ebay', 'etsy', 'aliexpress', 'temu']);
const COLORS = new Set(['black', 'white', 'red', 'blue', 'green', 'yellow', 'pink', 'purple', 'orange', 'grey', 'gray', 'brown', 'beige', 'navy', 'silver', 'gold']);
const SIZE = /^(xs|s|m|l|xl|xxl|xxxl|\d+(\.\d+)?(ml|l|oz|g|kg|lb|lbs|cm|mm|m|in|inch|ft|pcs|pc|pack|x\d+)?)$/;

export function tokens(name: string): string[] {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t) && !COLORS.has(t) && !SIZE.test(t) && !/^\d+$/.test(t) && !(t.length >= 4 && /\d/.test(t) && /[a-z]/.test(t))) // drop stop words, colours, sizes, numbers and SKU/ASIN-like tokens
    .map((t) => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t)); // crude singularisation
}

export function normalizeProductName(name: string): string {
  const t = tokens(name);
  return [...new Set(t)].sort().join(' ');
}

export function keywordsOf(name: string, max = 8): string[] {
  const t = tokens(name);
  const freq = new Map<string, number>();
  for (const k of t) freq.set(k, (freq.get(k) ?? 0) + 1);
  return [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, max).map(([k]) => k).sort();
}

const trigrams = (s: string): Set<string> => {
  const p = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i < p.length - 2; i++) out.add(p.slice(i, i + 3));
  return out;
};

/** 0..1 — mean of token Jaccard and character-trigram Dice, so typos and word-order changes still match. */
export function similarity(a: string, b: string): number {
  const na = normalizeProductName(a);
  const nb = normalizeProductName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = new Set(na.split(' '));
  const tb = new Set(nb.split(' '));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  const jaccard = inter / (ta.size + tb.size - inter);
  const ga = trigrams(na);
  const gb = trigrams(nb);
  const gi = [...ga].filter((g) => gb.has(g)).length;
  const dice = (2 * gi) / (ga.size + gb.size);
  return (jaccard + dice) / 2;
}

export const SAME_ENTITY_THRESHOLD = 0.62;
