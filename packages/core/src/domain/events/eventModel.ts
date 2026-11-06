/**
 * Canonical event construction, stable ids and consent gating (pure).
 * The `eventId` is what lets Meta / TikTok deduplicate a browser pixel hit against the server event: both sides must
 * send the SAME string. Server-generated money events derive it from the business key (never from time or randomness);
 * browser events generate it once in the browser and hand the same value to the pixel and to the server.
 */
import type { CanonicalEvent, CanonicalEventItem, CanonicalEventUser, MarketingEventName, MarketingProviderKey } from '@orvia/types';
import { buildFbc, hashEmail, hashExternalId, hashPhoneDigits, hashPhoneE164 } from './hashing';

const ID_RE = /^[A-Za-z0-9:_.-]{6,128}$/;

/** `purchase:<orderId>`, `refund:<refundId>`… Deterministic: the same business key always yields the same id. */
export function buildEventId(name: MarketingEventName, businessKey: string): string {
  const id = `${name}:${businessKey}`;
  if (!ID_RE.test(id)) throw new Error(`Invalid event id "${id}"`);
  return id;
}
export const isValidEventId = (id: string): boolean => ID_RE.test(id);

export interface ConsentInputs {
  /** Explicit choice recorded from the consent banner for this browser session (null/undefined = never asked). */
  session?: { consent?: { analytics?: boolean | null; marketing?: boolean | null } | null } | null;
  /** Contact preference stored on the cart at checkout. */
  cart?: { marketingConsent?: boolean | null } | null;
  /** Contact preference stored on the customer record. Read defensively: the customer360 workstream owns richer consent. */
  customer?: { marketingConsent?: boolean | null } | null;
}

/**
 * Conservative default: NO consent unless explicitly recorded. An explicit "no" on the session wins over everything else.
 * A checkout marketing opt-in on the cart / customer counts as an explicit grant.
 */
export function hasTrackingConsent(src: ConsentInputs | null | undefined, kind: 'marketing' | 'analytics' = 'marketing'): boolean {
  if (!src) return false;
  const explicit = src.session?.consent?.[kind];
  if (explicit === false) return false;
  if (explicit === true) return true;
  return src.cart?.marketingConsent === true || src.customer?.marketingConsent === true;
}

/** GA4 needs analytics (or marketing) consent; Meta / TikTok / Google Ads need marketing consent. */
export function consentForProvider(provider: MarketingProviderKey, src: ConsentInputs | null | undefined): boolean {
  return provider === 'ga4' ? hasTrackingConsent(src, 'analytics') || hasTrackingConsent(src, 'marketing') : hasTrackingConsent(src, 'marketing');
}

export interface EventInput {
  name: MarketingEventName;
  /** Business key for deterministic ids (order id, refund id…) or a browser-generated unique string. */
  businessKey?: string;
  eventId?: string;
  occurredAt: Date;
  sourceUrl?: string;
  email?: string | null;
  phone?: string | null;
  phoneCountry?: string;
  externalId?: string | null;
  clickIds?: { fbclid?: string | null; gclid?: string | null; ttclid?: string | null; gbraid?: string | null; wbraid?: string | null };
  browserIds?: { fbp?: string | null; fbc?: string | null; ttp?: string | null; gaClientId?: string | null };
  value?: number;
  currency?: string;
  orderId?: string;
  items?: CanonicalEventItem[];
  searchString?: string;
  country?: string;
  refundValue?: number;
  consent: { marketing: boolean; analytics: boolean };
}

const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')) as T;
/** Minor units -> major units for the 2-decimal currencies Orvia sells in (USD / CAD / INR). */
export const toMajor = (minor: number): number => Math.round(minor) / 100;

export function buildCanonicalEvent(i: EventInput): CanonicalEvent {
  const eventId = i.eventId ?? buildEventId(i.name, i.businessKey ?? '');
  if (!isValidEventId(eventId)) throw new Error('Invalid event id');
  const fbclid = i.clickIds?.fbclid ?? undefined;
  const user: CanonicalEventUser = clean({
    emailSha256: hashEmail(i.email, 'standard'),
    emailGoogleSha256: hashEmail(i.email, 'google'),
    phoneE164Sha256: hashPhoneE164(i.phone, i.phoneCountry),
    phoneDigitsSha256: hashPhoneDigits(i.phone, i.phoneCountry),
    externalIdSha256: hashExternalId(i.externalId),
    fbp: i.browserIds?.fbp ?? undefined,
    fbc: i.browserIds?.fbc ?? (fbclid ? buildFbc(fbclid, i.occurredAt.getTime()) : undefined),
    ttp: i.browserIds?.ttp ?? undefined,
    ttclid: i.clickIds?.ttclid ?? undefined,
    gclid: i.clickIds?.gclid ?? undefined,
    gbraid: i.clickIds?.gbraid ?? undefined,
    wbraid: i.clickIds?.wbraid ?? undefined,
    gaClientId: i.browserIds?.gaClientId ?? undefined,
  });
  return {
    eventId, name: i.name, occurredAt: i.occurredAt.toISOString(), sourceUrl: i.sourceUrl, user,
    data: clean({ value: i.value, currency: i.currency, orderId: i.orderId, items: i.items, searchString: i.searchString, country: i.country, refundValue: i.refundValue }),
    consent: i.consent,
  };
}

/** Strip every identifier (used for rows that are only counted, never sent). */
export function redactEvent(e: CanonicalEvent): CanonicalEvent {
  return { eventId: e.eventId, name: e.name, occurredAt: e.occurredAt, user: {}, data: clean({ value: e.data.value, currency: e.data.currency, country: e.data.country }), consent: e.consent };
}

/** Admin-safe view: hashes truncated, no raw identifiers. */
export function redactForDisplay(e: CanonicalEvent): Record<string, unknown> {
  const short = (v?: string) => (v ? `${v.slice(0, 8)}…` : undefined);
  const ids = [e.user.fbc && 'fbc', e.user.fbp && 'fbp', e.user.gclid && 'gclid', e.user.ttclid && 'ttclid', e.user.gaClientId && 'ga_client_id'].filter(Boolean).join(',');
  return {
    eventId: e.eventId, name: e.name, occurredAt: e.occurredAt, data: { ...e.data, items: e.data.items?.length },
    user: clean({ email: short(e.user.emailSha256), phone: short(e.user.phoneE164Sha256), externalId: short(e.user.externalIdSha256), identifiers: ids || undefined }),
    consent: e.consent,
  };
}
