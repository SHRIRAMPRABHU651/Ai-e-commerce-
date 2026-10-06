/**
 * Product-image policy. Customers only buy products that have real photos:
 *  - production: only Orvia-hosted copies (object storage/CDN) count — supplier URLs are provenance, never served;
 *  - development/staging: supplier https URLs may be hot-linked until the ingestion job has copied them;
 *  - procedural demo art (/art/:id) is accepted only for the mock supplier outside production.
 */
interface Policy {
  allowDemoArt: boolean;
  allowHotlinks: boolean;
  /** URL prefixes of Orvia-owned storage (CDN base, or the local media route in development). */
  ownedPrefixes: string[];
}
let policy: Policy = { allowDemoArt: false, allowHotlinks: false, ownedPrefixes: [] };

export function setImagePolicy(p: Partial<Policy>): void {
  policy = { ...policy, ...p };
}

export const isRemoteImage = (u: unknown): u is string => typeof u === 'string' && /^https?:\/\/[^\s]+$/i.test(u.trim());
export const isDemoArt = (u: unknown): boolean => typeof u === 'string' && u.startsWith('/art/');
export const isOwned = (u: string): boolean => policy.ownedPrefixes.some((p) => u.startsWith(p));

const acceptable = (s: string): boolean => (policy.allowDemoArt && isDemoArt(s)) || isOwned(s) || (policy.allowHotlinks && isRemoteImage(s));

/** Keep only usable image URLs (deduped, order preserved). */
export function usableImages(urls: unknown[] | undefined | null): string[] {
  const out: string[] = [];
  for (const u of urls ?? []) {
    const s = typeof u === 'string' ? u.trim() : '';
    if (s && acceptable(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

export const hasUsableImage = (urls: unknown[] | undefined | null): boolean => usableImages(urls).length > 0;

/** Mongo filter fragment: the first image must be usable under the current policy. Spread into listing queries. */
export function listableImageFilter(): Record<string, unknown> {
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const alts = policy.ownedPrefixes.map((p) => `^${esc(p)}`);
  if (policy.allowDemoArt) alts.push('^/art/');
  if (policy.allowHotlinks) alts.push('^https?://');
  const rx = { $regex: alts.length ? alts.join('|') : '^$never' };
  return { $or: [{ 'images.0.url': rx }, { 'markets.images.0': rx }] };
}

/** Photos to show for a country: the serving supplier's own images when known, else the product's primary images. */
export function effectiveImages(
  p: { images?: { url?: string | null; alt?: string | null; card?: string | null; thumb?: string | null; zoom?: string | null }[] | null; markets?: { country: string; images?: string[] | null }[] | null; title?: string },
  country: string,
): { url: string; alt?: string; card?: string; thumb?: string; zoom?: string }[] {
  const own = usableImages((p.images ?? []).map((i) => i.url));
  const byUrl = new Map((p.images ?? []).map((i) => [i.url ?? '', i]));
  const m = usableImages((p.markets ?? []).find((x) => x.country === country)?.images ?? []);
  const pick = m.length ? m : own;
  return pick.map((url, i) => {
    const src = byUrl.get(url);
    return { url, alt: src?.alt ?? `${p.title ?? 'Product'} — image ${i + 1}`, card: src?.card ?? undefined, thumb: src?.thumb ?? undefined, zoom: src?.zoom ?? undefined };
  });
}
