/**
 * FX service: provider-based, stored, staleness-aware. Money paths should convert through here.
 * The static `DEFAULT_FX` table is only a dev/test fallback and production configuration refuses it.
 */
import { FinanceFxRate } from '@orvia/database';
import type { Currency, FxConversion, FxPolicy, FxSnapshot, FxTable } from '@orvia/types';
import { audit } from '../../infra/audit';
import { DomainError } from '../../infra/context';
import type { Actor, Ctx } from '../../infra/context';
import { assertFxUsable, convertWithSnapshot, fxStaleness, ageHours, snapshotToTable, staticSnapshot, suspiciousMove, validateRates } from './fx';
import { buildFxProvider } from './fxProviders';
import type { FxProvider } from './fxProviders';
import { getFinanceSettings } from './settings';

const CACHE_MS = 30_000;
const cache = new WeakMap<object, { at: number; snap: FxSnapshot }>();
const providers = new WeakMap<object, FxProvider>();

/** Tests inject a fake provider; production code never calls this. */
export function setFxProvider(ctx: Ctx, p: FxProvider): void {
  providers.set(ctx, p);
  cache.delete(ctx);
}
const providerFor = (ctx: Ctx): FxProvider => providers.get(ctx) ?? buildFxProvider(ctx.cfg);

export async function fxPolicy(ctx: Ctx): Promise<FxPolicy> {
  const s = await getFinanceSettings(ctx);
  return {
    warnHours: ctx.cfg.FX_WARN_HOURS,
    hardLimitHours: ctx.cfg.FX_HARD_LIMIT_HOURS,
    enforceHardLimit: ctx.cfg.isProduction,
    adminOverride: !!s.fxOverrideUntil && new Date(s.fxOverrideUntil).getTime() > ctx.now().getTime(),
  };
}

const toSnapshot = (d: { rates: unknown; source: string; fetchedAt: Date; providerDate?: string | null }): FxSnapshot => ({ base: 'USD', rates: d.rates as FxSnapshot['rates'], source: d.source as FxSnapshot['source'], fetchedAt: d.fetchedAt, providerDate: d.providerDate ?? undefined });

/** Fetch from the configured provider and store. Rejects implausible jumps unless `acceptLargeMove`. */
export async function refreshFx(ctx: Ctx, o: { actor?: Actor; acceptLargeMove?: boolean } = {}): Promise<FxSnapshot> {
  const next = await providerFor(ctx).fetchRates(ctx.now());
  if (!validateRates(next.rates)) throw new DomainError('FX provider returned invalid rates', 'FX_INVALID', 502);
  const prevDoc = await FinanceFxRate.findOne().sort({ fetchedAt: -1 }).lean();
  const prev = prevDoc ? toSnapshot(prevDoc) : null;
  const moved = next.source === 'static' ? null : suspiciousMove(prev, next);
  if (moved && !o.acceptLargeMove) throw new DomainError(`FX refresh rejected: ${moved} moved more than 15% since the last stored rate. Verify the provider, then refresh with confirmation.`, 'FX_SUSPICIOUS_MOVE', 409);
  await FinanceFxRate.create({ base: 'USD', rates: next.rates, source: next.source, providerDate: next.providerDate, fetchedAt: next.fetchedAt });
  cache.set(ctx, { at: Date.now(), snap: next });
  if (o.actor) await audit(ctx, o.actor, { action: 'finance.fx.refreshed', resource: 'fx_rates', newValue: { source: next.source, rates: next.rates, providerDate: next.providerDate }, previousValue: prev ? { rates: prev.rates, source: prev.source } : undefined, reason: 'manual FX refresh' });
  return next;
}

/** Newest stored snapshot. With the static provider (dev/test) the table is returned as always-fresh and nothing is stored. */
export async function currentFx(ctx: Ctx): Promise<FxSnapshot> {
  if (ctx.cfg.FX_PROVIDER === 'static' && !providers.has(ctx)) return staticSnapshot(ctx.now());
  const hit = cache.get(ctx);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.snap;
  const doc = await FinanceFxRate.findOne().sort({ fetchedAt: -1 }).lean();
  if (doc) {
    const snap = toSnapshot(doc);
    cache.set(ctx, { at: Date.now(), snap });
    return snap;
  }
  try {
    return await refreshFx(ctx);
  } catch (e) {
    ctx.log.warn({ channel: 'error', err: (e as Error).message }, 'FX: no stored rates and the provider is unreachable');
    if (ctx.cfg.isProduction) throw new DomainError('No FX rates are available yet; refresh them in /admin/finance', 'FX_NO_RATES', 503);
    return staticSnapshot(ctx.now());
  }
}

/** Convert and report the rate used. Never blocks (reporting use); the result says whether it was stale. */
export async function convertFx(ctx: Ctx, minor: number, from: Currency, to: Currency): Promise<FxConversion> {
  if (from === to) return { amount: Math.round(minor), rate: 1, source: 'static', asOf: ctx.now().toISOString(), stale: false, staleness: 'fresh', from, to };
  const snap = await currentFx(ctx);
  return convertWithSnapshot(minor, from, to, snap, ctx.now(), await fxPolicy(ctx));
}

/**
 * Rate table for callers that still use `convertMinor(minor, from, to, fx)`. Use `{ forPricing: true }` on paths that price NEW orders:
 * in production those refuse expired rates (unless an admin override is active). Drop-in replacement for `(await ctx.settings.get('ops')).fx`.
 */
export async function liveFxTable(ctx: Ctx, o: { forPricing?: boolean } = {}): Promise<FxTable> {
  const snap = await currentFx(ctx);
  if (o.forPricing) assertFxUsable(snap, ctx.now(), await fxPolicy(ctx));
  return snapshotToTable(snap);
}

/** Convenience: a table plus the snapshot metadata, to store with a priced object. */
export async function fxSnapshotForPricing(ctx: Ctx): Promise<{ table: FxTable; source: FxSnapshot['source']; asOf: string; staleness: string }> {
  const snap = await currentFx(ctx);
  const policy = await fxPolicy(ctx);
  const { staleness } = assertFxUsable(snap, ctx.now(), policy);
  return { table: snapshotToTable(snap), source: snap.source, asOf: snap.fetchedAt.toISOString(), staleness };
}

export async function fxStatus(ctx: Ctx) {
  const snap = await currentFx(ctx);
  const policy = await fxPolicy(ctx);
  const history = await FinanceFxRate.find().sort({ fetchedAt: -1 }).limit(30).select('rates source fetchedAt providerDate').lean();
  return {
    provider: ctx.cfg.FX_PROVIDER,
    snapshot: { rates: snap.rates, source: snap.source, fetchedAt: snap.fetchedAt.toISOString(), providerDate: snap.providerDate ?? null },
    ageHours: Math.round(ageHours(snap.fetchedAt, ctx.now()) * 10) / 10,
    staleness: fxStaleness(snap.fetchedAt, ctx.now(), policy),
    policy,
    productionSafe: snap.source !== 'static',
    history: history.map((h) => ({ rates: h.rates, source: h.source, fetchedAt: h.fetchedAt, providerDate: h.providerDate ?? null })),
  };
}
