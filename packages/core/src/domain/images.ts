/**
 * Product-image policy. Customers only buy products whose photos came from the supplier API
 * (absolute http(s) URLs on the supplier CDN). The procedural demo art served at /art/:id is allowed only for the
 * mock supplier in non-production environments, so the demo catalogue stays browsable without credentials.
 */
let allowDemoArt = false;

export function setImagePolicy(p: { allowDemoArt: boolean }): void {
  allowDemoArt = p.allowDemoArt;
}

export const isRemoteImage = (u: unknown): u is string => typeof u === 'string' && /^https?:\/\/[^\s]+$/i.test(u.trim());
export const isDemoArt = (u: unknown): boolean => typeof u === 'string' && u.startsWith('/art/');

/** Keep only usable image URLs (deduped, order preserved). */
export function usableImages(urls: unknown[] | undefined | null): string[] {
  const out: string[] = [];
  for (const u of urls ?? []) {
    const s = typeof u === 'string' ? u.trim() : '';
    if ((isRemoteImage(s) || (allowDemoArt && isDemoArt(s))) && !out.includes(s)) out.push(s);
  }
  return out;
}

export const hasUsableImage = (urls: unknown[] | undefined | null): boolean => usableImages(urls).length > 0;

/** Mongo filter fragment: the first image must be usable. Spread into listing queries. */
export function listableImageFilter(): Record<string, unknown> {
  const rx = { $regex: allowDemoArt ? '^(https?://|/art/)' : '^https?://' };
  return { $or: [{ 'images.0.url': rx }, { 'markets.images.0': rx }] };
}

/** Photos to show for a country: the serving supplier's own images when known, else the product's primary images. */
export function effectiveImages(p: { images?: { url?: string | null; alt?: string | null }[] | null; markets?: { country: string; images?: string[] | null }[] | null; title?: string }, country: string): { url: string; alt?: string }[] {
  const m = usableImages((p.markets ?? []).find((x) => x.country === country)?.images ?? []);
  if (m.length) return m.map((url, i) => ({ url, alt: `${p.title ?? 'Product'} — image ${i + 1}` }));
  const own = usableImages((p.images ?? []).map((i) => i.url));
  return (p.images ?? []).filter((i) => own.includes(i.url ?? '')).map((i) => ({ url: i.url ?? '', alt: i.alt ?? undefined }));
}
