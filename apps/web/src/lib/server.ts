import 'server-only';
import { cookies, headers } from 'next/headers';
import { isCountryCode } from '@orvia/types';
import type { CountryCode } from '@orvia/types';

const API_URL = process.env.API_URL ?? 'http://localhost:4000';

/** Country resolution: explicit cookie (customer choice) -> CDN geo header (coarse, no precise geolocation) -> US. */
export async function resolveCountry(): Promise<CountryCode> {
  const c = (await cookies()).get('orvia_country')?.value;
  if (c && isCountryCode(c)) return c;
  const h = await headers();
  const geo = h.get('cloudfront-viewer-country') ?? h.get('x-vercel-ip-country') ?? h.get('cf-ipcountry');
  return geo && isCountryCode(geo) ? geo : 'US';
}

export async function sget<T>(path: string, opts: { country?: CountryCode; revalidate?: number } = {}): Promise<T | null> {
  const country = opts.country ?? (await resolveCountry());
  const jar = await cookies();
  const cookie = jar.getAll().map((c) => `${c.name}=${c.value}`).join('; ');
  const sep = path.includes('?') ? '&' : '?';
  try {
    const res = await fetch(`${API_URL}/api/v1${path}${sep}country=${country}`, { headers: { cookie, 'x-requested-with': 'orvia' }, cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`API ${path} -> ${res.status}`);
    return (await res.json()) as T;
  } catch (e) {
    if ((e as Error).message.startsWith('API ')) throw e;
    throw new Error(`The store is temporarily unavailable (${(e as Error).message})`);
  }
}

export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
