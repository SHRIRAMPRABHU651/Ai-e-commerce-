/**
 * Deterministic, explainable trend engine. No LLM is involved: every number comes from observed documents
 * (public sources) and Orvia's own behaviour, and every score ships with its evidence and a confidence.
 */
export interface TrendWeights { recency: number; velocity: number; crossSource: number; mentionGrowth: number; searchGrowth: number; availability: number; priceMomentum: number; internalConversion: number }
export interface Obs { sourceId: string; source: string; observedAt: Date; day: string; price?: number | null; availability?: string | null; url?: string | null }
export interface InternalSignals {
  searchRecent: number; searchPrior: number;
  viewsRecent: number; viewsPrior: number; cartsRecent: number; cartsPrior: number; purchasesRecent: number; purchasesPrior: number;
}
export type TrendStatus = 'TRENDING' | 'RISING' | 'STABLE' | 'DECLINING' | 'INSUFFICIENT_DATA';
export interface Component { score: number; available: boolean; sample: number; note?: string }
export interface SourceEvidence { source: string; recent: number; prior: number; growthPct: number; weight: number; firstSeen: string; lastSeen: string; samples: string[] }

export interface TrendResult {
  trendScore: number;
  confidence: number;
  status: TrendStatus;
  growthPct: number;
  components: Record<keyof TrendWeights, Component>;
  windows: Record<string, { observations: number; sources: number; sufficient: boolean }>;
  evidence: { sources: SourceEvidence[]; internal?: InternalSignals & { searchGrowthPct?: number; conversionGrowthPct?: number }; firstSeen?: string; lastSeen?: string; spanDays: number };
  reasons: string[];
  warnings: string[];
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
export const WINDOWS: [string, number][] = [['1h', HOUR], ['6h', 6 * HOUR], ['24h', DAY], ['3d', 3 * DAY], ['7d', 7 * DAY], ['14d', 14 * DAY], ['30d', 30 * DAY]];
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const logistic = (x: number) => 1 / (1 + Math.exp(-x));
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : 0; };

export function normaliseTrendWeights(w: TrendWeights): TrendWeights {
  const sum = Object.values(w).reduce((a, b) => a + Math.max(0, b), 0) || 1;
  return Object.fromEntries(Object.entries(w).map(([k, v]) => [k, Math.max(0, v) / sum])) as unknown as TrendWeights;
}

/** Shrunk growth: (recent + k) / (prior + k) - 1. A handful of mentions cannot produce a huge number. */
export const shrunkGrowth = (recent: number, prior: number, k = 1): number => (recent + k) / (prior + k) - 1;

export function scoreTopic(input: { observations: Obs[]; internal?: InternalSignals; weights: TrendWeights; now: Date; minConfidence?: number; minInternalSample?: number }): TrendResult {
  const now = input.now.getTime();
  const w = normaliseTrendWeights(input.weights);
  const minConf = input.minConfidence ?? 0.35;
  const obs = input.observations.filter((o) => o.observedAt.getTime() <= now + HOUR);
  const warnings: string[] = [];
  const reasons: string[] = [];

  // windows (documents observed inside each window)
  const times = obs.map((o) => o.observedAt.getTime());
  const first = times.length ? Math.min(...times) : now;
  const last = times.length ? Math.max(...times) : now;
  const spanDays = (last - first) / DAY;
  const windows: TrendResult['windows'] = {};
  for (const [name, ms] of WINDOWS) {
    const inW = obs.filter((o) => now - o.observedAt.getTime() <= ms);
    windows[name] = { observations: inW.length, sources: new Set(inW.map((o) => o.sourceId)).size, sufficient: now - first >= ms * 0.9 };
  }

  // per-source growth: last 7 days vs the 7 days before, shrunk and capped so one noisy source cannot dominate
  const bySource = new Map<string, Obs[]>();
  for (const o of obs) bySource.set(o.sourceId, [...(bySource.get(o.sourceId) ?? []), o]);
  const sources: SourceEvidence[] = [];
  for (const list of bySource.values()) {
    const recent = list.filter((o) => now - o.observedAt.getTime() <= 7 * DAY).length;
    const prior = list.filter((o) => { const age = now - o.observedAt.getTime(); return age > 7 * DAY && age <= 14 * DAY; }).length;
    const weight = Math.min(1, (recent + prior) / 6);
    const g = clamp(shrunkGrowth(recent, prior), -1, 1.5);
    const ts = list.map((o) => o.observedAt.getTime());
    sources.push({ source: list[0]!.source, recent, prior, growthPct: Math.round(g * 100), weight, firstSeen: new Date(Math.min(...ts)).toISOString(), lastSeen: new Date(Math.max(...ts)).toISOString(), samples: [...new Set(list.map((o) => o.url).filter((u): u is string => !!u))].slice(0, 3) });
  }
  const wsum = sources.reduce((a, s) => a + s.weight, 0);
  const aggGrowth = wsum > 0 ? sources.reduce((a, s) => a + (s.growthPct / 100) * s.weight, 0) / wsum : 0;

  // EWMA of daily distinct-source mention counts over 14 days → velocity
  const daily: number[] = [];
  for (let d = 13; d >= 0; d--) {
    const from = now - (d + 1) * DAY, to = now - d * DAY;
    daily.push(new Set(obs.filter((o) => o.observedAt.getTime() > from && o.observedAt.getTime() <= to).map((o) => o.sourceId + o.day)).size);
  }
  let ewma = daily[0] ?? 0;
  const series = daily.map((x) => (ewma = 0.35 * x + 0.65 * ewma));
  const mean = daily.reduce((a, b) => a + b, 0) / (daily.length || 1);
  const slope = (series[series.length - 1]! - (series[series.length - 4] ?? series[0]!)) / (mean + 1);

  const comp = {} as Record<keyof TrendWeights, Component>;
  comp.recency = { score: Math.exp(-((now - last) / HOUR) / 72), available: obs.length > 0, sample: obs.length };
  comp.velocity = { score: logistic(slope * 3), available: obs.length >= 4 && spanDays >= 2, sample: obs.length };
  const positive = sources.filter((s) => s.growthPct > 10 && s.weight > 0.3).length;
  comp.crossSource = { score: Math.min(1, positive / 3), available: sources.length >= 2, sample: sources.length, note: `${positive} of ${sources.length} source(s) rising` };
  comp.mentionGrowth = { score: logistic(aggGrowth * 2), available: wsum > 0.3, sample: sources.reduce((a, s) => a + s.recent + s.prior, 0) };

  const it = input.internal;
  const minInt = input.minInternalSample ?? 10;
  const sSample = (it?.searchRecent ?? 0) + (it?.searchPrior ?? 0);
  const searchG = it && sSample >= 5 ? shrunkGrowth(it.searchRecent, it.searchPrior, 2) : 0;
  comp.searchGrowth = { score: it && sSample >= 5 ? logistic(clamp(searchG, -1, 2) * 2) : 0.5, available: !!it && sSample >= 5, sample: sSample };
  const wr = it ? it.viewsRecent + 3 * it.cartsRecent + 8 * it.purchasesRecent : 0;
  const wp = it ? it.viewsPrior + 3 * it.cartsPrior + 8 * it.purchasesPrior : 0;
  // the sample size is the RAW event count (a couple of purchases weigh a lot but prove nothing)
  const rawN = it ? it.viewsRecent + it.viewsPrior + it.cartsRecent + it.cartsPrior + it.purchasesRecent + it.purchasesPrior : 0;
  const convOk = !!it && rawN >= minInt;
  const convG = convOk ? shrunkGrowth(wr, wp, 2) : 0;
  comp.internalConversion = { score: convOk ? logistic(clamp(convG, -1, 2) * 2) : 0.5, available: convOk, sample: rawN };

  const known = obs.filter((o) => o.availability && o.availability !== 'unknown' && now - o.observedAt.getTime() <= 7 * DAY);
  comp.availability = { score: known.length >= 3 ? known.filter((o) => o.availability === 'in_stock').length / known.length : 0.5, available: known.length >= 3, sample: known.length };
  const priced = (lo: number, hi: number) => obs.filter((o) => o.price && now - o.observedAt.getTime() > lo && now - o.observedAt.getTime() <= hi).map((o) => o.price!);
  const pr = priced(-1, 7 * DAY), pp = priced(7 * DAY, 14 * DAY);
  const pDelta = pr.length >= 3 && pp.length >= 3 ? (median(pr) - median(pp)) / median(pp) : 0;
  comp.priceMomentum = { score: pr.length >= 3 && pp.length >= 3 ? 0.5 + clamp(pDelta, -0.25, 0.25) : 0.5, available: pr.length >= 3 && pp.length >= 3, sample: pr.length + pp.length };

  const keys = Object.keys(w) as (keyof TrendWeights)[];
  const raw = keys.reduce((a, k) => a + w[k] * comp[k].score, 0);
  const trendScore = Math.round(raw * 100);

  // confidence: independent sources, sample size, history span, freshness, signal availability. Single-source evidence is capped.
  const availShare = keys.filter((k) => comp[k].available).length / keys.length;
  let confidence = Math.min(1, sources.length / 3) * 0.35 + Math.min(1, obs.length / 20) * 0.25 + Math.min(1, spanDays / 7) * 0.2 + comp.recency.score * 0.1 + availShare * 0.1;
  if (sources.length <= 1) { confidence = Math.min(confidence, 0.45); warnings.push('Single-source evidence: confidence is capped'); }
  confidence = Math.round(confidence * 100) / 100;

  let status: TrendStatus;
  if (confidence < minConf || spanDays < 2 || obs.length < 4) status = 'INSUFFICIENT_DATA';
  else if (aggGrowth >= 0.35 && trendScore >= 65 && confidence >= 0.6 && sources.length >= 2) status = 'TRENDING';
  else if (aggGrowth >= 0.15 && trendScore >= 55) status = 'RISING';
  else if (aggGrowth <= -0.25) status = 'DECLINING';
  else status = 'STABLE';
  if (sources.length < 2 && status === 'TRENDING') status = 'RISING'; // belt and braces: never TRENDING on one source

  if (status === 'INSUFFICIENT_DATA') warnings.push(`Not enough evidence yet (confidence ${confidence}, ${obs.length} observation(s) over ${spanDays.toFixed(1)} day(s))`);
  for (const s of sources) if (s.growthPct > 10) reasons.push(`${s.source}: ${s.recent} mention(s) in the last 7 days vs ${s.prior} before (${s.growthPct > 0 ? '+' : ''}${s.growthPct}%)`);
  if (comp.searchGrowth.available) reasons.push(`Orvia searches ${(searchG * 100).toFixed(0)}% vs the previous week (${sSample} searches)`);
  if (comp.internalConversion.available) reasons.push(`Orvia customer activity ${(convG * 100).toFixed(0)}% vs the previous week (${rawN} events)`);
  for (const k of keys) if (!comp[k].available && k !== 'recency') warnings.push(`${k}: no data (neutral value used)`);

  return {
    trendScore, confidence, status, growthPct: Math.round(aggGrowth * 100), components: comp, windows, reasons, warnings,
    evidence: { sources, internal: it ? { ...it, searchGrowthPct: comp.searchGrowth.available ? Math.round(searchG * 100) : undefined, conversionGrowthPct: comp.internalConversion.available ? Math.round(convG * 100) : undefined } : undefined, firstSeen: obs.length ? new Date(first).toISOString() : undefined, lastSeen: obs.length ? new Date(last).toISOString() : undefined, spanDays: Math.round(spanDays * 10) / 10 },
  };
}

export interface PriceStats {
  n: number; hosts: number; currency: string; low: number; median: number; high: number; avg: number; velocityPct?: number; newestAt?: string; confidence: 'LOW' | 'MEDIUM' | 'HIGH';
}

/** Competitor price distribution from the newest observation per URL (already normalised to one currency by the caller). */
export function priceStats(rows: { url: string; host: string; price: number; observedAt: Date }[], o: { now: Date; staleDays: number; currency: string; prior?: number[] }): PriceStats | null {
  const cutoff = o.now.getTime() - o.staleDays * DAY;
  const newest = new Map<string, { price: number; host: string; at: Date }>();
  for (const r of rows) if (r.price > 0 && r.observedAt.getTime() >= cutoff) { const c = newest.get(r.url); if (!c || r.observedAt > c.at) newest.set(r.url, { price: r.price, host: r.host, at: r.observedAt }); }
  const list = [...newest.values()];
  if (!list.length) return null;
  const prices = list.map((l) => l.price);
  const hosts = new Set(list.map((l) => l.host)).size;
  const newestAt = new Date(Math.max(...list.map((l) => l.at.getTime())));
  const ageDays = (o.now.getTime() - newestAt.getTime()) / DAY;
  const confidence: PriceStats['confidence'] = list.length >= 6 && hosts >= 3 && ageDays <= 7 ? 'HIGH' : list.length >= 3 && ageDays <= o.staleDays ? 'MEDIUM' : 'LOW';
  const med = median(prices);
  const priorMed = o.prior && o.prior.length >= 3 ? median(o.prior) : undefined;
  return { n: list.length, hosts, currency: o.currency, low: Math.min(...prices), median: med, high: Math.max(...prices), avg: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length), velocityPct: priorMed ? Math.round(((med - priorMed) / priorMed) * 100) : undefined, newestAt: newestAt.toISOString(), confidence };
}
