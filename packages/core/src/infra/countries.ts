import { CountryConfigModel } from '@orvia/database';
import { DEFAULT_COUNTRIES, isCountryCode } from '@orvia/types';
import type { CountryCode, CountryConfig } from '@orvia/types';
import { DomainError } from './context';

let cache: { at: number; map: Record<CountryCode, CountryConfig> } | null = null;

/** Country configs: code defaults overlaid with admin edits stored in `country_configs`. */
export async function getCountryConfigs(force = false): Promise<Record<CountryCode, CountryConfig>> {
  if (!force && cache && Date.now() - cache.at < 15_000) return cache.map;
  const rows = await CountryConfigModel.find({}).lean();
  const map = { ...DEFAULT_COUNTRIES } as Record<CountryCode, CountryConfig>;
  for (const r of rows) {
    const code = r.code as CountryCode;
    if (isCountryCode(code)) map[code] = { ...DEFAULT_COUNTRIES[code], ...(r.config as Partial<CountryConfig>), code };
  }
  cache = { at: Date.now(), map };
  return map;
}

export async function getCountry(code: string): Promise<CountryConfig> {
  if (!isCountryCode(code)) throw new DomainError(`Unsupported country ${code}`, 'UNSUPPORTED_COUNTRY', 400);
  const c = (await getCountryConfigs())[code];
  if (!c.enabled) throw new DomainError(`We don't currently sell in ${c.name}`, 'COUNTRY_DISABLED', 400);
  return c;
}

export async function saveCountry(code: CountryCode, patch: Partial<CountryConfig>): Promise<CountryConfig> {
  const current = (await getCountryConfigs(true))[code];
  const next = { ...current, ...patch, code };
  await CountryConfigModel.updateOne({ code }, { $set: { config: next } }, { upsert: true });
  cache = null;
  return next;
}

export const enabledCountries = async (): Promise<CountryConfig[]> =>
  Object.values(await getCountryConfigs()).filter((c) => c.enabled);

export const resetCountryCache = (): void => {
  cache = null;
};
