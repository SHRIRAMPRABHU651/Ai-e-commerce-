/**
 * TikTok Marketing API adapter (business-api.tiktok.com/open_api/v1.3). From public docs; mocked-HTTP
 * tests only. Creating TikTok ads requires uploaded video/identity assets: this adapter creates the
 * campaign and ad group (PAUSED) and reports creatives as NOT created unless a videoUrl-backed
 * asset flow is added — it never claims ads exist that were not created.
 */
import { CircuitBreaker, fetchJson, ProviderError } from '@orvia/config';
import { PartialCreationError } from './types';
import type { AdMetricRow, AdProvider, CampaignSpec, CreatedCampaign } from './types';

const BASE = 'https://business-api.tiktok.com/open_api/v1.3';

interface TtEnvelope<T> { code: number; message: string; data: T }

export class TikTokAdsProvider implements AdProvider {
  readonly key = 'tiktok' as const;
  private readonly breaker = new CircuitBreaker('tiktok-ads', { failureThreshold: 5, resetMs: 60_000 });
  constructor(private readonly o: { accessToken: string; advertiserId: string; fetchImpl?: typeof fetch }) {}

  private async call<T>(path: string, body?: unknown, method?: string, idempotent = false): Promise<T> {
    const res = await fetchJson<TtEnvelope<T>>(`${BASE}${path}`, {
      provider: 'tiktok-ads',
      method: method ?? (body ? 'POST' : 'GET'),
      headers: { 'Access-Token': this.o.accessToken },
      body,
      breaker: this.breaker,
      fetchImpl: this.o.fetchImpl,
      idempotent,
    });
    if (res.code !== 0) throw new ProviderError(`TikTok API ${path} error ${res.code}: ${res.message}`, { provider: 'tiktok-ads', retryable: res.code === 40100 || res.code >= 50000, status: res.code });
    return res.data;
  }

  async createCampaign(spec: CampaignSpec): Promise<CreatedCampaign> {
    const partial = { externalId: undefined as string | undefined, adSetIds: [] as string[] };
    try {
      const c = await this.call<{ campaign_id: string }>('/campaign/create/', {
        advertiser_id: this.o.advertiserId,
        campaign_name: spec.name,
        objective_type: 'WEB_CONVERSIONS',
        budget_mode: 'BUDGET_MODE_INFINITE',
        operation_status: 'DISABLE',
      });
      partial.externalId = c.campaign_id;
      const g = await this.call<{ adgroup_id: string }>('/adgroup/create/', {
        advertiser_id: this.o.advertiserId,
        campaign_id: c.campaign_id,
        adgroup_name: `${spec.name} — ${spec.country}`,
        placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
        budget_mode: 'BUDGET_MODE_DAY',
        budget: spec.dailyBudget / 100,
        schedule_type: 'SCHEDULE_FROM_NOW',
        schedule_start_time: (spec.startDate ?? new Date().toISOString()).replace('T', ' ').slice(0, 19),
        optimization_goal: 'CONVERT',
        billing_event: 'OCPM',
        location_ids: [],
        operation_status: 'DISABLE',
      });
      partial.adSetIds.push(g.adgroup_id);
      // Ads (creatives) need pre-uploaded video + identity: not created here.
      return { externalId: c.campaign_id, adSetIds: [g.adgroup_id], creativeIds: {}, status: 'paused' };
    } catch (e) {
      if (partial.externalId) await this.setStatus(partial.externalId, 'paused').catch(() => undefined);
      throw new PartialCreationError(`TikTok campaign creation failed: ${(e as Error).message}`, partial, e);
    }
  }

  async setStatus(externalId: string, status: 'active' | 'paused'): Promise<void> {
    await this.call('/campaign/status/update/', { advertiser_id: this.o.advertiserId, campaign_ids: [externalId], operation_status: status === 'active' ? 'ENABLE' : 'DISABLE' }, 'POST', true);
  }

  async updateDailyBudget(externalId: string, dailyBudget: number): Promise<void> {
    const g = await this.call<{ list: { adgroup_id: string }[] }>(`/adgroup/get/?advertiser_id=${this.o.advertiserId}&filtering=${encodeURIComponent(JSON.stringify({ campaign_ids: [externalId] }))}`);
    for (const a of g.list) await this.call('/adgroup/update/', { advertiser_id: this.o.advertiserId, adgroup_id: a.adgroup_id, budget: dailyBudget / 100 / Math.max(1, g.list.length) }, 'POST', true);
  }

  async getMetrics(externalIds: string[], range: { from: string; to: string }): Promise<AdMetricRow[]> {
    const q = new URLSearchParams({
      advertiser_id: this.o.advertiserId,
      report_type: 'BASIC',
      data_level: 'AUCTION_CAMPAIGN',
      dimensions: JSON.stringify(['campaign_id', 'stat_time_day']),
      metrics: JSON.stringify(['spend', 'impressions', 'clicks', 'complete_payment', 'total_complete_payment_rate', 'value_per_complete_payment']),
      start_date: range.from,
      end_date: range.to,
      filtering: JSON.stringify([{ field_name: 'campaign_ids', filter_type: 'IN', filter_value: JSON.stringify(externalIds) }]),
      page_size: '1000',
    });
    const res = await this.call<{ list: { dimensions: { campaign_id: string; stat_time_day: string }; metrics: Record<string, string> }[] }>(`/report/integrated/get/?${q.toString()}`);
    return res.list.map((r) => {
      const purchases = Number(r.metrics['complete_payment'] ?? 0);
      return {
        externalCampaignId: r.dimensions.campaign_id,
        date: r.dimensions.stat_time_day.slice(0, 10),
        impressions: Number(r.metrics['impressions'] ?? 0),
        clicks: Number(r.metrics['clicks'] ?? 0),
        spend: Math.round(Number(r.metrics['spend'] ?? 0) * 100),
        addToCart: 0,
        checkouts: 0,
        purchases,
        revenue: Math.round(purchases * Number(r.metrics['value_per_complete_payment'] ?? 0) * 100),
      };
    });
  }

  async healthCheck() {
    try {
      await this.call(`/advertiser/info/?advertiser_ids=${encodeURIComponent(JSON.stringify([this.o.advertiserId]))}`);
      return { ok: true, message: 'TikTok advertiser reachable' };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }
}
