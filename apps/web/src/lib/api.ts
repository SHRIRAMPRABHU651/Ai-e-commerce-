import type { CountryCode } from '@orvia/types';

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly details?: unknown) {
    super(message);
  }
}

/** Browser client: same-origin (/api/v1 is proxied by Next), cookie auth, CSRF header on every request. */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    credentials: 'same-origin',
    headers: { 'x-requested-with': 'orvia', ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: init.signal,
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : {};
  if (!res.ok) {
    const e = (json as { error?: { message?: string; code?: string; details?: unknown } }).error;
    throw new ApiError(e?.message ?? `Request failed (${res.status})`, res.status, e?.code ?? 'ERROR', e?.details);
  }
  return json as T;
}

export const money = (minor: number, currency: string): string => {
  const loc = currency === 'INR' ? 'en-IN' : currency === 'CAD' ? 'en-CA' : 'en-US';
  const hasFraction = Math.round(minor) % 100 !== 0;
  return new Intl.NumberFormat(loc, { style: 'currency', currency, minimumFractionDigits: currency === 'INR' && !hasFraction ? 0 : 2, maximumFractionDigits: 2 }).format(minor / 100);
};

export type { CountryCode };
