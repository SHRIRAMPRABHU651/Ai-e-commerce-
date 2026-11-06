/** events: shared types and zod schemas (owned by the events workstream). */
import { z } from 'zod';

/** Canonical marketing/conversion events. `eventId` is shared between the browser pixel and the server so platforms deduplicate. */
export const MARKETING_EVENT_NAMES = [
  'page_view', 'view_item', 'search', 'add_to_cart', 'begin_checkout', 'purchase', 'refund', 'return',
  'repeat_purchase', 'referral', 'signup', 'loyalty_earn', 'loyalty_redeem', 'loyalty_tier_up',
] as const;
export type MarketingEventName = (typeof MARKETING_EVENT_NAMES)[number];

/** Events a browser may report through the public endpoint. Money events (purchase/refund/…) are server-generated from orders only. */
export const BROWSER_EVENT_NAMES = ['page_view', 'view_item', 'search', 'add_to_cart', 'begin_checkout'] as const;

export const MARKETING_PROVIDER_KEYS = ['meta', 'tiktok', 'ga4', 'google_ads'] as const;
export type MarketingProviderKey = (typeof MARKETING_PROVIDER_KEYS)[number];

export const OUTBOX_STATUSES = ['pending', 'sending', 'sent', 'dead', 'skipped', 'suppressed'] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

/** Every hashed identifier is SHA-256 hex of the platform-normalised value. Raw email/phone never enter the outbox. */
export interface CanonicalEventUser {
  emailSha256?: string;
  /** Google flavour (gmail/googlemail dots removed) for GA4 / Google Ads. */
  emailGoogleSha256?: string;
  /** SHA-256 of E.164 including '+' (TikTok / GA4 / Google Ads). */
  phoneE164Sha256?: string;
  /** SHA-256 of digits only incl. country code, no '+' (Meta). */
  phoneDigitsSha256?: string;
  externalIdSha256?: string;
  fbp?: string;
  fbc?: string;
  ttp?: string;
  ttclid?: string;
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
  gaClientId?: string;
  userAgent?: string;
  ip?: string;
}

export interface CanonicalEventItem {
  id: string;
  name?: string;
  category?: string;
  /** Major units (e.g. 19.99). */
  price?: number;
  quantity: number;
}

export interface CanonicalEvent {
  eventId: string;
  name: MarketingEventName;
  /** ISO timestamp of when the thing happened (not when it was sent). */
  occurredAt: string;
  sourceUrl?: string;
  user: CanonicalEventUser;
  data: {
    /** Major units. */
    value?: number;
    currency?: string;
    orderId?: string;
    items?: CanonicalEventItem[];
    searchString?: string;
    country?: string;
    /** Refunded amount in major units (refund events). */
    refundValue?: number;
  };
  consent: { marketing: boolean; analytics: boolean };
}

export const trackEventBodySchema = z.object({
  eventId: z.string().regex(/^[A-Za-z0-9:_.-]{6,128}$/),
  name: z.enum(BROWSER_EVENT_NAMES),
  sessionId: z.string().min(8).max(64),
  productId: z.string().regex(/^[a-f0-9]{24}$/).optional(),
  searchString: z.string().max(120).optional(),
  sourceUrl: z.string().url().max(500).optional(),
});

export const consentBodySchema = z.object({
  sessionId: z.string().min(8).max(64),
  analytics: z.boolean(),
  marketing: z.boolean(),
});

const clickParam = z.string().max(400).optional();
export const attributionBodySchema = z.object({
  sessionId: z.string().min(8).max(64),
  utm: z.object({ source: z.string().max(80).optional(), medium: z.string().max(80).optional(), campaign: z.string().max(120).optional(), term: z.string().max(120).optional(), content: z.string().max(120).optional() }).default({}),
  clickIds: z.object({ fbclid: clickParam, gclid: clickParam, ttclid: clickParam, gbraid: clickParam, wbraid: clickParam }).default({}),
  browserIds: z.object({ fbp: clickParam, fbc: clickParam, ttp: clickParam, gaClientId: clickParam }).default({}),
  referrerHost: z.string().max(200).optional(),
  landingPath: z.string().max(300).optional(),
});

/* ---------------------------- segments ---------------------------- */
export const SEGMENT_FIELDS = ['ordersCount', 'lifetimeValueUsd', 'daysSinceLastOrder', 'country', 'marketingConsent', 'categoryAffinity'] as const;
export type SegmentField = (typeof SEGMENT_FIELDS)[number];

export const segmentRuleSchema = z.discriminatedUnion('field', [
  z.object({ field: z.literal('ordersCount'), op: z.enum(['eq', 'gte', 'lte']), value: z.number().int().min(0).max(100000) }),
  z.object({ field: z.literal('lifetimeValueUsd'), op: z.enum(['gte', 'lte']), value: z.number().min(0).max(100_000_000) }),
  z.object({ field: z.literal('daysSinceLastOrder'), op: z.enum(['gte', 'lte']), value: z.number().int().min(0).max(3650) }),
  z.object({ field: z.literal('country'), op: z.literal('in'), value: z.array(z.enum(['US', 'CA', 'IN'])).min(1).max(3) }),
  z.object({ field: z.literal('marketingConsent'), op: z.literal('eq'), value: z.boolean() }),
  z.object({ field: z.literal('categoryAffinity'), op: z.literal('in'), value: z.array(z.string().min(1).max(60)).min(1).max(10) }),
]);
export type SegmentRule = z.infer<typeof segmentRuleSchema>;

export const segmentBodySchema = z.object({
  name: z.string().min(2).max(80),
  description: z.string().max(300).optional(),
  /** All rules must match (AND). */
  rules: z.array(segmentRuleSchema).min(1).max(8),
});

/* ---------------------------- campaigns ---------------------------- */
export const campaignBodySchema = z.object({
  name: z.string().min(2).max(100),
  segmentId: z.string().regex(/^[a-f0-9]{24}$/),
  subject: z.string().min(2).max(140),
  message: z.string().min(2).max(4000),
  ctaLabel: z.string().max(40).optional(),
  /** Must be on the store origin; links are rewritten through the signed click-tracking redirect. */
  ctaUrl: z.string().url().max(500).optional(),
  maxRecipients: z.number().int().min(1).max(50_000).default(1000),
});

/* ---------------------------- experiments ---------------------------- */
export const experimentBodySchema = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,48}$/),
  name: z.string().min(2).max(100),
  hypothesis: z.string().max(400).optional(),
  variants: z.array(z.object({ key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,30}$/), weight: z.number().int().min(1).max(100) })).min(2).max(5),
  conversionEvent: z.enum(['add_to_cart', 'begin_checkout', 'purchase', 'signup', 'custom']),
});
