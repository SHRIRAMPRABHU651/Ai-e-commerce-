/**
 * Google Ads REST adapter. From public docs; mocked-HTTP tests only.
 * Scope: OAuth token refresh, campaign budget + Search campaign creation (PAUSED), status, budget
 * and GAQL metrics. Ad groups / responsive search ads / assets are NOT created here, so
 * `creativeIds` is empty and callers must not treat the campaign as having ads.
 */
import { CircuitBreaker, fetchJson, ProviderError } from '@orvia/config';
import { PartialCreationError } from './types';
import type { AdMetricRow, AdProvider, CampaignSpec, CreatedCampaign } from './types';

const VERSION = 'v18';

export class GoogleAdsProvider implements AdProvider {
  readonly key = 'google' as const;
  private token?: { v: string; exp: number };
  private readonly breaker = new CircuitBreaker('google-ads', { failureThreshold: 5, resetMs: 60_000 });
  constructor(
    private readonly o: {
      clientId: string;
      clientSecret: string;
      refreshToken: string;
      developerToken: string;
      customerId: string;
      loginCustomerId?: string;
      fetchImpl?: typeof fetch;
    },
  ) {}

  private cid(): string {
    return this.o.customerId.replace(/-/g, '');
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.exp > Date.now() + 60_000) return this.token.v;
    const r = await fetchJson<{ access_token: string; expires_in: number }>('https://oauth2.googleapis.com/token', {
      provider: 'google-ads',
      method: 'POST',
      form: true,
      body: { client_id: this.o.clientId, client_secret: this.o.clientSecret, refresh_token: this.o.refreshToken, grant_type: 'refresh_token' },
      idempotent: true,
      fetchImpl: this.o.fetchImpl,
    });
    this.token = { v: r.access_token, exp: Date.now() + r.expires_in * 1000 };
    return r.access_token;
  }

  private async call<T>(path: string, body: unknown, idempotent = false): Promise<T> {
    const token = await this.accessToken();
    return fetchJson<T>(`https://googleads.googleapis.com/${VERSION}/customers/${this.cid()}/${path}`, {
      provider: 'google-ads',
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'developer-token': this.o.developerToken,
        ...(this.o.loginCustomerId ? { 'login-customer-id': this.o.loginCustomerId.replace(/-/g, '') } : {}),
      },
      body,
      breaker: this.breaker,
      fetchImpl: this.o.fetchImpl,
      idempotent,
    });
  }

  async createCampaign(spec: CampaignSpec): Promise<CreatedCampaign> {
    const partial = { externalId: undefined as string | undefined, adSetIds: [] as string[] };
    try {
      const b = await this.call<{ results: { resourceName: string }[] }>('campaignBudgets:mutate', {
        operations: [{ create: { name: `${spec.name} budget ${Date.now()}`, amountMicros: String(spec.dailyBudget * 10_000), deliveryMethod: 'STANDARD', explicitlyShared: false } }],
      });
      const budget = b.results[0]!.resourceName;
      const c = await this.call<{ results: { resourceName: string }[] }>('campaigns:mutate', {
        operations: [{ create: { name: spec.name, status: 'PAUSED', advertisingChannelType: 'SEARCH', campaignBudget: budget, manualCpc: {}, networkSettings: { targetGoogleSearch: true } } }],
      });
      const id = c.results[0]!.resourceName.split('/').pop()!;
      partial.externalId = id;
      return { externalId: id, adSetIds: [], creativeIds: {}, status: 'paused' };
    } catch (e) {
      throw new PartialCreationError(`Google Ads campaign creation failed: ${(e as Error).message}`, partial, e);
    }
  }

  async setStatus(externalId: string, status: 'active' | 'paused'): Promise<void> {
    await this.call('campaigns:mutate', {
      operations: [{ update: { resourceName: `customers/${this.cid()}/campaigns/${externalId}`, status: status === 'active' ? 'ENABLED' : 'PAUSED' }, updateMask: 'status' }],
    }, true);
  }

  async updateDailyBudget(externalId: string, dailyBudget: number): Promise<void> {
    const rows = await this.search<{ campaign?: { campaignBudget?: string } }>(`SELECT campaign.campaign_budget FROM campaign WHERE campaign.id = ${Number(externalId)}`);
    const budget = rows[0]?.campaign?.campaignBudget;
    if (!budget) throw new ProviderError('Campaign budget not found', { provider: 'google-ads', retryable: false, status: 404 });
    await this.call('campaignBudgets:mutate', { operations: [{ update: { resourceName: budget, amountMicros: String(dailyBudget * 10_000) }, updateMask: 'amountMicros' }] }, true);
  }

  private async search<T>(query: string): Promise<T[]> {
    const r = await this.call<{ results?: T[] }>('googleAds:search', { query, pageSize: 1000 }, true);
    return r.results ?? [];
  }

  async getMetrics(externalIds: string[], range: { from: string; to: string }): Promise<AdMetricRow[]> {
    const ids = externalIds.map((i) => Number(i)).filter(Number.isFinite).join(',');
    if (!ids) return [];
    const rows = await this.search<{ campaign: { id: string }; segments: { date: string }; metrics: { impressions?: string; clicks?: string; costMicros?: string; conversions?: number; conversionsValue?: number } }>(
      `SELECT campaign.id, segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM campaign WHERE campaign.id IN (${ids}) AND segments.date BETWEEN '${range.from}' AND '${range.to}'`,
    );
    return rows.map((r) => ({
      externalCampaignId: String(r.campaign.id),
      date: r.segments.date,
      impressions: Number(r.metrics.impressions ?? 0),
      clicks: Number(r.metrics.clicks ?? 0),
      spend: Math.round(Number(r.metrics.costMicros ?? 0) / 10_000),
      addToCart: 0,
      checkouts: 0,
      purchases: Math.round(r.metrics.conversions ?? 0),
      revenue: Math.round((r.metrics.conversionsValue ?? 0) * 100),
    }));
  }

  async healthCheck() {
    try {
      await this.accessToken();
      await this.search('SELECT customer.id FROM customer LIMIT 1');
      return { ok: true, message: 'Google Ads reachable' };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }
}
