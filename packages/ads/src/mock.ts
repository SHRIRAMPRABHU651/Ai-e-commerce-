/** DEV / TEST ONLY mock ad network with deterministic synthetic metrics. */
import { MemoryKVStore, ProviderError } from '@orvia/config';
import type { KVStore } from '@orvia/config';
import type { AdMetricRow, AdProvider, CampaignSpec, CreatedCampaign } from './types';

const fnv = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};
const rnd = (seed: string) => (fnv(seed) % 10_000) / 10_000;

interface MockCampaign {
  id: string;
  spec: CampaignSpec;
  status: 'paused' | 'active';
  dailyBudget: number;
  activeFrom?: string;
  history: { at: string; status: 'active' | 'paused' }[];
}

export class MockAdProvider implements AdProvider {
  readonly key = 'mock' as const;
  constructor(
    private readonly store: KVStore = new MemoryKVStore(),
    private readonly now: () => number = Date.now,
  ) {}

  async setFault(f: { remaining: number } | null): Promise<void> {
    await this.store.set('ad_fault', 'all', f);
  }
  private async fault(op: string): Promise<void> {
    const f = await this.store.get<{ remaining: number }>('ad_fault', 'all');
    if (f && f.remaining > 0) {
      await this.store.set('ad_fault', 'all', { remaining: f.remaining - 1 });
      throw new ProviderError(`Mock ad API injected failure during ${op}`, { provider: 'mock-ads', retryable: true, status: 500 });
    }
  }

  async createCampaign(spec: CampaignSpec): Promise<CreatedCampaign> {
    await this.fault('createCampaign');
    const id = `mock_cmp_${fnv(spec.name + spec.country + this.now()).toString(16)}`;
    const c: MockCampaign = { id, spec, status: 'paused', dailyBudget: spec.dailyBudget, history: [] };
    await this.store.set('ad_campaign', id, c);
    return {
      externalId: id,
      adSetIds: [`${id}_as1`],
      creativeIds: Object.fromEntries(spec.creatives.map((cr) => [cr.id, `${id}_ad_${cr.id}`])),
      status: 'paused',
    };
  }

  private async load(id: string): Promise<MockCampaign> {
    const c = await this.store.get<MockCampaign>('ad_campaign', id);
    if (!c) throw new ProviderError(`Unknown mock campaign ${id}`, { provider: 'mock-ads', retryable: false, status: 404 });
    return c;
  }

  async setStatus(externalId: string, status: 'active' | 'paused'): Promise<void> {
    await this.fault('setStatus');
    const c = await this.load(externalId);
    c.status = status;
    c.history.push({ at: new Date(this.now()).toISOString(), status });
    if (status === 'active' && !c.activeFrom) c.activeFrom = new Date(this.now()).toISOString().slice(0, 10);
    await this.store.set('ad_campaign', externalId, c);
  }

  async updateDailyBudget(externalId: string, dailyBudget: number): Promise<void> {
    await this.fault('updateDailyBudget');
    const c = await this.load(externalId);
    c.dailyBudget = dailyBudget;
    await this.store.set('ad_campaign', externalId, c);
  }

  async getMetrics(externalIds: string[], range: { from: string; to: string }): Promise<AdMetricRow[]> {
    await this.fault('getMetrics');
    const rows: AdMetricRow[] = [];
    for (const id of externalIds) {
      const c = await this.load(id);
      if (!c.activeFrom) continue;
      const aov = c.spec.mockHints?.aov ?? 3000;
      const quality = c.spec.mockHints?.quality ?? rnd(id + 'q');
      const creatives = c.spec.creatives.length ? c.spec.creatives : [{ id: 'none' } as never];
      for (let d = Date.parse(range.from); d <= Date.parse(range.to); d += 86_400_000) {
        const date = new Date(d).toISOString().slice(0, 10);
        if (date < c.activeFrom || d > this.now()) continue;
        for (const cr of creatives as { id: string }[]) {
          const seed = `${id}|${cr.id}|${date}`;
          const crQuality = Math.min(1, Math.max(0, quality * 0.6 + rnd(`${id}|${cr.id}|cq`) * 0.4));
          const spend = Math.round((c.dailyBudget / creatives.length) * (0.85 + rnd(seed + 's') * 0.15));
          const cpm = 800 + rnd(seed + 'm') * 1000; // 8-18 in minor units
          const impressions = Math.round((spend / cpm) * 1000);
          const ctr = 0.006 + crQuality * 0.02 + rnd(seed + 'c') * 0.004;
          const clicks = Math.round(impressions * ctr);
          const atc = Math.round(clicks * (0.04 + crQuality * 0.1));
          const checkouts = Math.round(atc * (0.45 + crQuality * 0.2));
          const purchases = Math.round(checkouts * (0.25 + crQuality * 0.45));
          rows.push({ externalCampaignId: id, creativeId: cr.id === 'none' ? undefined : cr.id, date, impressions, clicks, spend, addToCart: atc, checkouts, purchases, revenue: purchases * aov });
        }
      }
    }
    return rows;
  }

  async healthCheck() {
    return { ok: true, message: 'Mock ad network (development only)' };
  }
}
