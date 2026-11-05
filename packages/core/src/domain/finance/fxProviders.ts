/**
 * FX providers. `frankfurter` is a free public API serving ECB reference rates (no key).
 * `exchangerate_api` is an optional keyed alternative. `static` is the dev/test table (refused by production config).
 * The HTTP adapters are written from the providers' public documentation and have NOT been run against the live services from this repo.
 */
import type { FxSnapshot } from '@orvia/types';
import { parseExchangerateApi, parseFrankfurter, staticSnapshot } from './fx';

export interface FxProvider {
  readonly name: FxSnapshot['source'];
  fetchRates(now: Date): Promise<FxSnapshot>;
}

type Fetch = typeof fetch;

async function getJson(fetchImpl: Fetch, url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`FX provider responded ${res.status}`);
  return res.json();
}

export class FrankfurterProvider implements FxProvider {
  readonly name = 'frankfurter' as const;
  constructor(private readonly baseUrl = 'https://api.frankfurter.dev', private readonly fetchImpl: Fetch = fetch, private readonly timeoutMs = 8000) {}
  async fetchRates(now: Date): Promise<FxSnapshot> {
    return parseFrankfurter(await getJson(this.fetchImpl, `${this.baseUrl.replace(/\/$/, '')}/v1/latest?base=USD&symbols=CAD,INR`, this.timeoutMs), now);
  }
}

export class ExchangerateApiProvider implements FxProvider {
  readonly name = 'exchangerate_api' as const;
  constructor(private readonly apiKey: string, private readonly baseUrl = 'https://v6.exchangerate-api.com', private readonly fetchImpl: Fetch = fetch, private readonly timeoutMs = 8000) {}
  async fetchRates(now: Date): Promise<FxSnapshot> {
    return parseExchangerateApi(await getJson(this.fetchImpl, `${this.baseUrl.replace(/\/$/, '')}/v6/${encodeURIComponent(this.apiKey)}/latest/USD`, this.timeoutMs), now);
  }
}

export class StaticProvider implements FxProvider {
  readonly name = 'static' as const;
  async fetchRates(now: Date): Promise<FxSnapshot> {
    return staticSnapshot(now);
  }
}

export function buildFxProvider(cfg: { FX_PROVIDER: 'frankfurter' | 'exchangerate_api' | 'static'; FX_API_URL?: string; FX_API_KEY?: string }, fetchImpl: Fetch = fetch): FxProvider {
  if (cfg.FX_PROVIDER === 'frankfurter') return new FrankfurterProvider(cfg.FX_API_URL, fetchImpl);
  if (cfg.FX_PROVIDER === 'exchangerate_api') {
    if (!cfg.FX_API_KEY) throw new Error('FX_API_KEY is required for FX_PROVIDER=exchangerate_api');
    return new ExchangerateApiProvider(cfg.FX_API_KEY, cfg.FX_API_URL, fetchImpl);
  }
  return new StaticProvider();
}
