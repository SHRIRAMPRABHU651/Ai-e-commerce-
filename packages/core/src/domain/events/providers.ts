/**
 * Server-side conversion adapters behind one `MarketingEventProvider` interface.
 *
 * STATUS: every adapter below is IMPLEMENTED AGAINST THE VENDORS' PUBLIC DOCUMENTATION AND IS UNVERIFIED AGAINST LIVE ACCOUNTS.
 * Request builders are pure (unit-tested for shape); `send` adds secrets and performs the HTTP call. Nothing here is ever
 * reported as "sent" in log mode.
 */
import { ProviderError, enabledEventProviders, fetchJson, missingEventCredentials } from '@orvia/config';
import type { AppConfig } from '@orvia/config';
import { sha256Hex } from './hashing';
import type { CanonicalEvent, MarketingEventName, MarketingProviderKey } from '@orvia/types';

export const ADAPTER_STATUS = 'implemented_against_public_docs_unverified' as const;

export interface ProviderRequest {
  url: string;
  /** JSON body WITHOUT secrets. */
  body: Record<string, unknown>;
  /** What kind of call this is (Google Ads has two endpoints). */
  kind: string;
}

export interface SendResult {
  status: 'sent' | 'logged';
  detail?: string;
}

export interface MarketingEventProvider {
  readonly key: MarketingProviderKey;
  readonly label: string;
  readonly mode: 'live' | 'log';
  readonly adapterStatus: typeof ADAPTER_STATUS;
  /** All required credentials present. */
  isConfigured(): boolean;
  missingCredentials(): string[];
  supports(name: MarketingEventName): boolean;
  /** Pure: the request this event would produce (null = this provider cannot represent the event). */
  buildRequest(e: CanonicalEvent): ProviderRequest | null;
  send(e: CanonicalEvent): Promise<SendResult>;
}

const compact = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0))) as T;
const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/* --------------------------------- Meta Conversions API --------------------------------- */
// https://developers.facebook.com/docs/marketing-api/conversions-api/parameters
const META_NAMES: Partial<Record<MarketingEventName, string>> = {
  page_view: 'PageView', view_item: 'ViewContent', search: 'Search', add_to_cart: 'AddToCart', begin_checkout: 'InitiateCheckout',
  purchase: 'Purchase', signup: 'CompleteRegistration', repeat_purchase: 'RepeatPurchase', referral: 'Referral',
  loyalty_earn: 'LoyaltyEarn', loyalty_redeem: 'LoyaltyRedeem', loyalty_tier_up: 'LoyaltyTierUp',
  // refund / return have no Meta equivalent: intentionally not sent
};

export function buildMetaEvent(e: CanonicalEvent): Record<string, unknown> | null {
  const name = META_NAMES[e.name];
  if (!name) return null;
  const u = e.user;
  const hasBrowserContext = !!(u.userAgent && u.ip);
  return compact({
    event_name: name,
    event_time: unix(e.occurredAt),
    event_id: e.eventId,
    // Meta requires IP + user agent for `website`; without them the honest value is system_generated.
    action_source: hasBrowserContext ? 'website' : 'system_generated',
    event_source_url: e.sourceUrl,
    user_data: compact({
      em: u.emailSha256 ? [u.emailSha256] : undefined,
      ph: u.phoneDigitsSha256 ? [u.phoneDigitsSha256] : undefined,
      external_id: u.externalIdSha256 ? [u.externalIdSha256] : undefined,
      fbp: u.fbp, fbc: u.fbc, client_ip_address: u.ip, client_user_agent: u.userAgent,
    }),
    custom_data: compact({
      currency: e.data.currency, value: e.data.value, order_id: e.data.orderId, search_string: e.data.searchString,
      content_type: e.data.items?.length ? 'product' : undefined,
      content_ids: e.data.items?.map((i) => i.id),
      contents: e.data.items?.map((i) => compact({ id: i.id, quantity: i.quantity, item_price: i.price })),
      num_items: e.data.items?.reduce((a, i) => a + i.quantity, 0),
    }),
  });
}

export class MetaCapiProvider implements MarketingEventProvider {
  readonly key = 'meta' as const;
  readonly label = 'Meta Conversions API';
  readonly adapterStatus = ADAPTER_STATUS;
  constructor(private readonly cfg: AppConfig, readonly mode: 'live' | 'log', private readonly fetchImpl?: typeof fetch) {}
  missingCredentials = () => missingEventCredentials(this.cfg, 'meta');
  isConfigured = () => this.missingCredentials().length === 0;
  supports = (n: MarketingEventName) => !!META_NAMES[n];
  buildRequest(e: CanonicalEvent): ProviderRequest | null {
    const ev = buildMetaEvent(e);
    if (!ev) return null;
    return { kind: 'events', url: `https://graph.facebook.com/${this.cfg.META_GRAPH_VERSION}/${this.cfg.META_PIXEL_ID ?? '{pixel_id}'}/events`, body: compact({ data: [ev], test_event_code: this.cfg.META_CAPI_TEST_EVENT_CODE }) };
  }
  async send(e: CanonicalEvent): Promise<SendResult> {
    const req = this.buildRequest(e);
    if (!req) throw new ProviderError('Event type not supported by Meta', { provider: 'meta', retryable: false });
    if (this.mode === 'log') return { status: 'logged' };
    if (!this.isConfigured()) throw new ProviderError('Meta CAPI credentials missing', { provider: 'meta', retryable: false });
    const r = await fetchJson<{ events_received?: number }>(req.url, { provider: 'meta-capi', method: 'POST', body: { ...req.body, access_token: this.cfg.META_CAPI_ACCESS_TOKEN }, fetchImpl: this.fetchImpl, idempotent: false, retries: 0 });
    return { status: 'sent', detail: `events_received=${r.events_received ?? '?'}` };
  }
}

/* --------------------------------- TikTok Events API --------------------------------- */
// https://business-api.tiktok.com/portal/docs?id=1771100865818625 (Events API 2.0, /open_api/v1.3/event/track/)
const TIKTOK_NAMES: Partial<Record<MarketingEventName, string>> = {
  view_item: 'ViewContent', search: 'Search', add_to_cart: 'AddToCart', begin_checkout: 'InitiateCheckout', purchase: 'CompletePayment', signup: 'CompleteRegistration',
};

export function buildTikTokEvent(e: CanonicalEvent): Record<string, unknown> | null {
  const name = TIKTOK_NAMES[e.name];
  if (!name) return null;
  const u = e.user;
  return compact({
    event: name, event_time: unix(e.occurredAt), event_id: e.eventId,
    user: compact({ email: u.emailSha256, phone: u.phoneE164Sha256, external_id: u.externalIdSha256, ttclid: u.ttclid, ttp: u.ttp, ip: u.ip, user_agent: u.userAgent }),
    properties: compact({
      currency: e.data.currency, value: e.data.value, query: e.data.searchString, content_type: e.data.items?.length ? 'product' : undefined,
      contents: e.data.items?.map((i) => compact({ content_id: i.id, content_name: i.name, quantity: i.quantity, price: i.price })),
    }),
    page: e.sourceUrl ? { url: e.sourceUrl } : undefined,
  });
}

export class TikTokEventsProvider implements MarketingEventProvider {
  readonly key = 'tiktok' as const;
  readonly label = 'TikTok Events API';
  readonly adapterStatus = ADAPTER_STATUS;
  constructor(private readonly cfg: AppConfig, readonly mode: 'live' | 'log', private readonly fetchImpl?: typeof fetch) {}
  missingCredentials = () => missingEventCredentials(this.cfg, 'tiktok');
  isConfigured = () => this.missingCredentials().length === 0;
  supports = (n: MarketingEventName) => !!TIKTOK_NAMES[n];
  buildRequest(e: CanonicalEvent): ProviderRequest | null {
    const ev = buildTikTokEvent(e);
    if (!ev) return null;
    return { kind: 'track', url: 'https://business-api.tiktok.com/open_api/v1.3/event/track/', body: compact({ event_source: 'web', event_source_id: this.cfg.TIKTOK_PIXEL_CODE ?? '{pixel_code}', data: [ev], test_event_code: this.cfg.TIKTOK_EVENTS_TEST_CODE }) };
  }
  async send(e: CanonicalEvent): Promise<SendResult> {
    const req = this.buildRequest(e);
    if (!req) throw new ProviderError('Event type not supported by TikTok', { provider: 'tiktok', retryable: false });
    if (this.mode === 'log') return { status: 'logged' };
    if (!this.isConfigured()) throw new ProviderError('TikTok Events credentials missing', { provider: 'tiktok', retryable: false });
    const r = await fetchJson<{ code?: number; message?: string }>(req.url, { provider: 'tiktok-events', method: 'POST', headers: { 'Access-Token': this.cfg.TIKTOK_EVENTS_ACCESS_TOKEN ?? '' }, body: req.body, fetchImpl: this.fetchImpl, idempotent: false, retries: 0 });
    // TikTok answers HTTP 200 with a non-zero `code` for application errors.
    if (r.code !== undefined && r.code !== 0) throw new ProviderError(`tiktok-events code ${r.code}: ${String(r.message ?? '').slice(0, 200)}`, { provider: 'tiktok-events', retryable: r.code >= 50000 });
    return { status: 'sent' };
  }
}

/* --------------------------------- GA4 Measurement Protocol --------------------------------- */
// https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference
const GA4_NAMES: Partial<Record<MarketingEventName, string>> = {
  page_view: 'page_view', view_item: 'view_item', search: 'search', add_to_cart: 'add_to_cart', begin_checkout: 'begin_checkout', purchase: 'purchase',
  refund: 'refund', signup: 'sign_up', return: 'return_requested', repeat_purchase: 'repeat_purchase', referral: 'referral',
  loyalty_earn: 'loyalty_earn', loyalty_redeem: 'loyalty_redeem', loyalty_tier_up: 'loyalty_tier_up',
};

export function buildGa4Body(e: CanonicalEvent): Record<string, unknown> | null {
  const name = GA4_NAMES[e.name];
  if (!name) return null;
  const u = e.user;
  // Without the browser's client id GA4 cannot join this hit to a web session; fall back to a stable synthetic id (documented limitation).
  const clientId = u.gaClientId ?? `server.${sha256Hex(e.eventId).slice(0, 20)}`;
  const params = compact({
    currency: e.data.currency, value: e.name === 'refund' ? (e.data.refundValue ?? e.data.value) : e.data.value, transaction_id: e.data.orderId, search_term: e.data.searchString,
    items: e.data.items?.map((i) => compact({ item_id: i.id, item_name: i.name, item_category: i.category, price: i.price, quantity: i.quantity })),
    engagement_time_msec: 1,
  });
  return compact({
    client_id: clientId,
    timestamp_micros: Date.parse(e.occurredAt) * 1000,
    user_data: u.emailGoogleSha256 || u.phoneE164Sha256 ? compact({ sha256_email_address: u.emailGoogleSha256 ? [u.emailGoogleSha256] : undefined, sha256_phone_number: u.phoneE164Sha256 ? [u.phoneE164Sha256] : undefined }) : undefined,
    consent: { ad_user_data: e.consent.marketing ? 'GRANTED' : 'DENIED', ad_personalization: e.consent.marketing ? 'GRANTED' : 'DENIED' },
    events: [{ name, params }],
  });
}

export class Ga4Provider implements MarketingEventProvider {
  readonly key = 'ga4' as const;
  readonly label = 'GA4 Measurement Protocol';
  readonly adapterStatus = ADAPTER_STATUS;
  constructor(private readonly cfg: AppConfig, readonly mode: 'live' | 'log', private readonly fetchImpl?: typeof fetch) {}
  missingCredentials = () => missingEventCredentials(this.cfg, 'ga4');
  isConfigured = () => this.missingCredentials().length === 0;
  supports = (n: MarketingEventName) => !!GA4_NAMES[n];
  buildRequest(e: CanonicalEvent): ProviderRequest | null {
    const body = buildGa4Body(e);
    return body ? { kind: 'collect', url: 'https://www.google-analytics.com/mp/collect', body } : null;
  }
  async send(e: CanonicalEvent): Promise<SendResult> {
    const req = this.buildRequest(e);
    if (!req) throw new ProviderError('Event type not supported by GA4', { provider: 'ga4', retryable: false });
    if (this.mode === 'log') return { status: 'logged' };
    if (!this.isConfigured()) throw new ProviderError('GA4 credentials missing', { provider: 'ga4', retryable: false });
    const url = `${req.url}?measurement_id=${encodeURIComponent(this.cfg.GA4_MEASUREMENT_ID ?? '')}&api_secret=${encodeURIComponent(this.cfg.GA4_API_SECRET ?? '')}`;
    // The collect endpoint answers 204 with an empty body and does not validate payloads; use the debug endpoint during setup (see docs).
    await fetchJson(url, { provider: 'ga4-mp', method: 'POST', body: req.body, fetchImpl: this.fetchImpl, idempotent: false, retries: 0 });
    return { status: 'sent', detail: 'accepted (MP does not validate payloads)' };
  }
}

/* --------------------------------- Google Ads conversion upload --------------------------------- */
// https://developers.google.com/google-ads/api/reference/rpc/latest/ConversionUploadService
export const gadsDateTime = (iso: string): string => `${new Date(iso).toISOString().slice(0, 19).replace('T', ' ')}+00:00`;

export function buildGoogleAdsRequest(e: CanonicalEvent, o: { customerId: string; conversionActionId: string; apiVersion: string }): ProviderRequest | null {
  const cid = o.customerId.replace(/-/g, '');
  const base = `https://googleads.googleapis.com/${o.apiVersion}/customers/${cid}`;
  const action = `customers/${cid}/conversionActions/${o.conversionActionId}`;
  const u = e.user;
  if (e.name === 'purchase') {
    const identifiers = [u.emailGoogleSha256 ? { hashedEmail: u.emailGoogleSha256 } : null, u.phoneE164Sha256 ? { hashedPhoneNumber: u.phoneE164Sha256 } : null].filter(Boolean);
    if (!u.gclid && !u.gbraid && !u.wbraid && !identifiers.length) return null; // nothing to match the conversion to
    return {
      kind: 'uploadClickConversions', url: `${base}:uploadClickConversions`,
      body: {
        conversions: [compact({
          gclid: u.gclid, gbraid: u.gbraid, wbraid: u.wbraid, conversionAction: action, conversionDateTime: gadsDateTime(e.occurredAt),
          conversionValue: e.data.value, currencyCode: e.data.currency, orderId: e.data.orderId, // orderId is Google's own dedupe key
          userIdentifiers: identifiers, consent: { adUserData: 'GRANTED', adPersonalization: 'GRANTED' },
        })],
        partialFailure: true,
      },
    };
  }
  if (e.name === 'refund' && e.data.orderId) {
    const full = e.data.value === undefined || e.data.refundValue === undefined || e.data.refundValue >= e.data.value - 0.005;
    return {
      kind: 'uploadConversionAdjustments', url: `${base}:uploadConversionAdjustments`,
      body: {
        conversionAdjustments: [compact({
          conversionAction: action, adjustmentType: full ? 'RETRACTION' : 'RESTATEMENT', adjustmentDateTime: gadsDateTime(e.occurredAt), orderId: e.data.orderId,
          restatementValue: full ? undefined : { adjustedValue: Math.round(((e.data.value ?? 0) - (e.data.refundValue ?? 0)) * 100) / 100, currencyCode: e.data.currency },
        })],
        partialFailure: true,
      },
    };
  }
  return null;
}

export class GoogleAdsConversionProvider implements MarketingEventProvider {
  readonly key = 'google_ads' as const;
  readonly label = 'Google Ads conversion upload';
  readonly adapterStatus = ADAPTER_STATUS;
  private token?: { value: string; exp: number };
  constructor(private readonly cfg: AppConfig, readonly mode: 'live' | 'log', private readonly fetchImpl?: typeof fetch) {}
  missingCredentials = () => missingEventCredentials(this.cfg, 'google_ads');
  isConfigured = () => this.missingCredentials().length === 0;
  supports = (n: MarketingEventName) => n === 'purchase' || n === 'refund';
  buildRequest(e: CanonicalEvent): ProviderRequest | null {
    return buildGoogleAdsRequest(e, { customerId: this.cfg.GOOGLE_ADS_CUSTOMER_ID ?? '{customer_id}', conversionActionId: this.cfg.GOOGLE_ADS_PURCHASE_CONVERSION_ACTION_ID ?? '{conversion_action_id}', apiVersion: this.cfg.GOOGLE_ADS_API_VERSION });
  }
  private async accessToken(): Promise<string> {
    if (this.token && this.token.exp > Date.now() + 60_000) return this.token.value;
    const r = await fetchJson<{ access_token: string; expires_in: number }>('https://oauth2.googleapis.com/token', {
      provider: 'google-oauth', method: 'POST', form: true, fetchImpl: this.fetchImpl, idempotent: false, retries: 0,
      body: { client_id: this.cfg.GOOGLE_ADS_CLIENT_ID ?? '', client_secret: this.cfg.GOOGLE_ADS_CLIENT_SECRET ?? '', refresh_token: this.cfg.GOOGLE_ADS_REFRESH_TOKEN ?? '', grant_type: 'refresh_token' },
    });
    this.token = { value: r.access_token, exp: Date.now() + r.expires_in * 1000 };
    return r.access_token;
  }
  async send(e: CanonicalEvent): Promise<SendResult> {
    const req = this.buildRequest(e);
    if (!req) throw new ProviderError('Nothing to upload for Google Ads (unsupported event or no click id / hashed identifier)', { provider: 'google_ads', retryable: false });
    if (this.mode === 'log') return { status: 'logged' };
    if (!this.isConfigured()) throw new ProviderError('Google Ads credentials missing', { provider: 'google_ads', retryable: false });
    const token = await this.accessToken();
    const r = await fetchJson<{ partialFailureError?: { message?: string } }>(req.url, {
      provider: 'google-ads', method: 'POST', fetchImpl: this.fetchImpl, idempotent: false, retries: 0, body: req.body,
      headers: { authorization: `Bearer ${token}`, 'developer-token': this.cfg.GOOGLE_ADS_DEVELOPER_TOKEN ?? '', ...(this.cfg.GOOGLE_ADS_LOGIN_CUSTOMER_ID ? { 'login-customer-id': this.cfg.GOOGLE_ADS_LOGIN_CUSTOMER_ID.replace(/-/g, '') } : {}) },
    });
    if (r.partialFailureError) throw new ProviderError(`google-ads partial failure: ${String(r.partialFailureError.message ?? '').slice(0, 250)}`, { provider: 'google-ads', retryable: false });
    return { status: 'sent' };
  }
}

/* --------------------------------- registry --------------------------------- */
/** Providers enabled via EVENTS_PROVIDERS. Mode `log` for all of them unless EVENTS_MODE=live. */
export function buildEventProviders(cfg: AppConfig, fetchImpl?: typeof fetch): MarketingEventProvider[] {
  const mode = cfg.EVENTS_MODE;
  return enabledEventProviders(cfg).map((k): MarketingEventProvider => {
    switch (k) {
      case 'meta': return new MetaCapiProvider(cfg, mode, fetchImpl);
      case 'tiktok': return new TikTokEventsProvider(cfg, mode, fetchImpl);
      case 'ga4': return new Ga4Provider(cfg, mode, fetchImpl);
      case 'google_ads': return new GoogleAdsConversionProvider(cfg, mode, fetchImpl);
    }
  });
}

/** Which providers can represent an event (used to fan out one outbox row per provider). */
export const providersFor = (providers: MarketingEventProvider[], name: MarketingEventName): MarketingEventProvider[] => providers.filter((p) => p.supports(name));
