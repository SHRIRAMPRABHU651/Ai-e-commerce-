/**
 * Meta Marketing API adapter (Graph API). Implemented from the public docs and covered by
 * mocked-HTTP tests only — validate with a Meta sandbox ad account before spending real money.
 * Everything is created PAUSED. A pixel (META_PIXEL_ID) is required for purchase optimisation.
 */
import { CircuitBreaker, fetchJson, ProviderError } from '@orvia/config';
import { PartialCreationError } from './types';
import type { AdMetricRow, AdProvider, CampaignSpec, CreatedCampaign } from './types';

const VERSION = 'v21.0';

export class MetaAdsProvider implements AdProvider {
  readonly key = 'meta' as const;
  private readonly breaker = new CircuitBreaker('meta-ads', { failureThreshold: 5, resetMs: 60_000 });
  constructor(
    private readonly o: { accessToken: string; adAccountId: string; pageId?: string; pixelId?: string; fetchImpl?: typeof fetch },
  ) {}

  private act(): string {
    return this.o.adAccountId.startsWith('act_') ? this.o.adAccountId : `act_${this.o.adAccountId}`;
  }

  private call<T>(path: string, body?: Record<string, unknown>, method?: string, idempotent = false): Promise<T> {
    const url = `https://graph.facebook.com/${VERSION}/${path}`;
    return fetchJson<T>(url, {
      provider: 'meta-ads',
      method: method ?? (body ? 'POST' : 'GET'),
      headers: { authorization: `Bearer ${this.o.accessToken}` },
      body,
      breaker: this.breaker,
      fetchImpl: this.o.fetchImpl,
      idempotent,
    });
  }

  async createCampaign(spec: CampaignSpec): Promise<CreatedCampaign> {
    if (!this.o.pageId) throw new ProviderError('META_PAGE_ID is required to create ads', { provider: 'meta-ads', retryable: false });
    const partial = { externalId: undefined as string | undefined, adSetIds: [] as string[] };
    try {
      const c = await this.call<{ id: string }>(`${this.act()}/campaigns`, {
        name: spec.name,
        objective: 'OUTCOME_SALES',
        status: 'PAUSED',
        special_ad_categories: [],
      });
      partial.externalId = c.id;
      const adset = await this.call<{ id: string }>(`${this.act()}/adsets`, {
        name: `${spec.name} — ${spec.country}`,
        campaign_id: c.id,
        daily_budget: spec.dailyBudget,
        billing_event: 'IMPRESSIONS',
        optimization_goal: 'OFFSITE_CONVERSIONS',
        bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
        targeting: {
          geo_locations: { countries: [spec.country] },
          age_min: spec.audience.ageMin ?? 18,
          age_max: spec.audience.ageMax ?? 65,
        },
        ...(this.o.pixelId ? { promoted_object: { pixel_id: this.o.pixelId, custom_event_type: 'PURCHASE' } } : {}),
        status: 'PAUSED',
        ...(spec.startDate ? { start_time: spec.startDate } : {}),
        ...(spec.endDate ? { end_time: spec.endDate } : {}),
      });
      partial.adSetIds.push(adset.id);
      const creativeIds: Record<string, string> = {};
      for (const cr of spec.creatives) {
        const creative = await this.call<{ id: string }>(`${this.act()}/adcreatives`, {
          name: `${spec.name} / ${cr.concept}`,
          object_story_spec: {
            page_id: this.o.pageId,
            link_data: {
              link: spec.landingUrl,
              message: cr.primaryText,
              name: cr.headline,
              description: cr.description,
              ...(cr.imageUrl ? { picture: cr.imageUrl } : {}),
              call_to_action: { type: 'SHOP_NOW', value: { link: spec.landingUrl } },
            },
          },
        });
        const ad = await this.call<{ id: string }>(`${this.act()}/ads`, {
          name: `${spec.name} / ${cr.concept}`,
          adset_id: adset.id,
          creative: { creative_id: creative.id },
          status: 'PAUSED',
        });
        creativeIds[cr.id] = ad.id;
      }
      return { externalId: c.id, adSetIds: partial.adSetIds, creativeIds, status: 'paused' };
    } catch (e) {
      if (partial.externalId) {
        // best effort: leave nothing running
        await this.call(partial.externalId, { status: 'PAUSED' }).catch(() => undefined);
      }
      throw new PartialCreationError(`Meta campaign creation failed: ${(e as Error).message}`, partial, e);
    }
  }

  async setStatus(externalId: string, status: 'active' | 'paused'): Promise<void> {
    await this.call(externalId, { status: status === 'active' ? 'ACTIVE' : 'PAUSED' }, 'POST', true);
  }

  async updateDailyBudget(externalId: string, dailyBudget: number): Promise<void> {
    // Budgets live on the ad set(s) for ABO campaigns.
    const sets = await this.call<{ data: { id: string }[] }>(`${externalId}/adsets?fields=id&limit=50`);
    for (const s of sets.data) await this.call(s.id, { daily_budget: Math.round(dailyBudget / Math.max(1, sets.data.length)) }, 'POST', true);
  }

  async getMetrics(externalIds: string[], range: { from: string; to: string }): Promise<AdMetricRow[]> {
    const rows: AdMetricRow[] = [];
    for (const id of externalIds) {
      const q = new URLSearchParams({
        fields: 'impressions,clicks,spend,actions,action_values',
        time_increment: '1',
        level: 'campaign',
        time_range: JSON.stringify({ since: range.from, until: range.to }),
        limit: '100',
      });
      const res = await this.call<{
        data: { date_start: string; impressions: string; clicks: string; spend: string; actions?: { action_type: string; value: string }[]; action_values?: { action_type: string; value: string }[] }[];
      }>(`${id}/insights?${q.toString()}`);
      for (const r of res.data) {
        const act = (t: string) => Number(r.actions?.find((a) => a.action_type === t)?.value ?? 0);
        const val = (t: string) => Number(r.action_values?.find((a) => a.action_type === t)?.value ?? 0);
        rows.push({
          externalCampaignId: id,
          date: r.date_start,
          impressions: Number(r.impressions),
          clicks: Number(r.clicks),
          spend: Math.round(Number(r.spend) * 100),
          addToCart: act('add_to_cart'),
          checkouts: act('initiate_checkout'),
          purchases: act('purchase') || act('omni_purchase'),
          revenue: Math.round((val('purchase') || val('omni_purchase')) * 100),
        });
      }
    }
    return rows;
  }

  async healthCheck() {
    try {
      await this.call<{ id: string }>(`${this.act()}?fields=id,account_status`);
      return { ok: true, message: 'Meta ad account reachable' };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }
}
