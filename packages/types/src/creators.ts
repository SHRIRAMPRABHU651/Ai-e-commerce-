/** creators: shared types and zod schemas (owned by the creators workstream). Pure: safe to import from web and core. */
import { z } from 'zod';
import { objectId } from './schemas';

/* ------------------------------ handles ------------------------------ */
export const HANDLE_MIN = 3;
export const HANDLE_MAX = 30;
/** lowercase letters, digits, single hyphens or underscores between; must start and end alphanumeric. */
export const HANDLE_RE = /^[a-z0-9](?:[a-z0-9]|[-_](?=[a-z0-9])){1,28}[a-z0-9]$/;
export const RESERVED_HANDLES: readonly string[] = [
  'admin', 'api', 'account', 'creator', 'creators', 'cart', 'checkout', 'login', 'register', 'help', 'legal', 'orvia', 'support', 'staff', 'root', 'system',
  'official', 'store', 'shop', 'search', 'track', 'orders', 'needs', 'catalog', 'c', 'p', 'null', 'undefined', 'www', 'mail', 'static', 'assets', 'media', 'art',
  'settings', 'privacy', 'terms', 'press', 'team', 'about', 'careers', 'loyalty', 'referral', 'referrals', 'verify', 'reset', 'forgot', 'wishlist', 'returns', 'new', 'edit',
];

export type HandleCheck = { ok: true; handle: string } | { ok: false; reason: 'length' | 'format' | 'reserved' | 'profanity' };
const BLOCKED_FRAGMENTS = ['fuck', 'shit', 'nazi', 'porn', 'rape', 'cunt'];

/** Normalise (trim, lowercase, strip a leading @) and validate a creator handle. */
export function validateHandle(raw: string): HandleCheck {
  const handle = raw.trim().replace(/^@/, '').toLowerCase();
  if (handle.length < HANDLE_MIN || handle.length > HANDLE_MAX) return { ok: false, reason: 'length' };
  if (!HANDLE_RE.test(handle)) return { ok: false, reason: 'format' };
  if (RESERVED_HANDLES.includes(handle)) return { ok: false, reason: 'reserved' };
  if (BLOCKED_FRAGMENTS.some((f) => handle.includes(f))) return { ok: false, reason: 'profanity' };
  return { ok: true, handle };
}
export const HANDLE_MESSAGES: Record<string, string> = {
  length: `Handles are ${HANDLE_MIN}-${HANDLE_MAX} characters`,
  format: 'Use lowercase letters, numbers, hyphens or underscores; start and end with a letter or number',
  reserved: 'This handle is reserved. Please choose another',
  profanity: 'Please choose a different handle',
};
export const handleSchema = z.string().trim().max(HANDLE_MAX + 1).transform((v, ctx) => {
  const r = validateHandle(v);
  if (!r.ok) { ctx.addIssue({ code: 'custom', message: HANDLE_MESSAGES[r.reason] }); return z.NEVER; }
  return r.handle;
});

/* ------------------------------ social links ------------------------------ */
export const SOCIAL_PLATFORMS = ['instagram', 'youtube', 'tiktok', 'x', 'facebook', 'pinterest', 'website', 'blog'] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];
const PLATFORM_HOSTS: Partial<Record<SocialPlatform, RegExp>> = {
  instagram: /(^|\.)instagram\.com$/, youtube: /(^|\.)(youtube\.com|youtu\.be)$/, tiktok: /(^|\.)tiktok\.com$/, x: /(^|\.)(x\.com|twitter\.com)$/,
  facebook: /(^|\.)(facebook\.com|fb\.com)$/, pinterest: /(^|\.)pinterest\.[a-z.]+$/,
};
/** https only, no credentials, no private/loopback hosts, and the host must match the platform for named platforms. */
export function validateSocialUrl(platform: SocialPlatform, raw: string): string | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  const h = u.hostname.toLowerCase();
  if (!h.includes('.') || /^(\d{1,3}\.){3}\d{1,3}$/.test(h) || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return null;
  const rx = PLATFORM_HOSTS[platform];
  if (rx && !rx.test(h)) return null;
  u.hash = '';
  return u.toString().slice(0, 300);
}
export const socialLinkSchema = z.object({ platform: z.enum(SOCIAL_PLATFORMS), url: z.string().trim().max(300) }).superRefine((v, ctx) => {
  if (!validateSocialUrl(v.platform, v.url)) ctx.addIssue({ code: 'custom', path: ['url'], message: `Enter a valid https link for ${v.platform}` });
});

/* ------------------------------ statuses ------------------------------ */
export const CREATOR_STATUSES = ['pending', 'approved', 'rejected', 'suspended'] as const;
export type CreatorStatus = (typeof CREATOR_STATUSES)[number];
export const LEDGER_STATUSES = ['accrued', 'payable', 'paid', 'reversed'] as const;
export type LedgerStatus = (typeof LEDGER_STATUSES)[number];
export const LEDGER_KINDS = ['commission', 'clawback', 'adjustment'] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];
export const PAYOUT_STATUSES = ['requested', 'approved', 'paid', 'rejected', 'cancelled'] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];
export const CREATOR_FLAG_KINDS = ['self_attribution', 'ip_cluster', 'buyer_cluster', 'velocity', 'refund_rate', 'suspicious_order', 'chargeback'] as const;
export type CreatorFlagKind = (typeof CREATOR_FLAG_KINDS)[number];

/** Mandatory disclosure shown on every creator page and used verbatim in statements (FTC 16 CFR 255 / ASCI-style). */
export const AFFILIATE_DISCLOSURE =
  'Affiliate disclosure: this creator earns a commission when you buy through links on this page. You pay the same price. Recommendations are the creator’s own opinion, not Orvia’s.';
export const AFFILIATE_DISCLOSURE_SHORT = 'Paid partnership: the creator earns a commission on purchases made through this page.';

/* ------------------------------ program rules ------------------------------ */
const rate = z.number().min(0).max(0.5);
const minor = z.number().int().min(0).max(1_000_000_00);
const currencyMap = z.record(z.enum(['USD', 'CAD', 'INR']), minor);

export const commissionRulesSchema = z.object({
  /** default commission rate on the net base (fraction, max 0.5) */
  defaultRate: rate.default(0.05),
  /** per product category slug overrides (category string on Product) */
  categoryRates: z.record(z.string().min(1).max(80), rate).default({}),
  /** orders whose net base is below this earn nothing (per currency, minor units) */
  minOrderNet: currencyMap.default({ USD: 1500, CAD: 2000, INR: 100000 }),
  /** hard cap per order (minor units); 0/absent = no cap */
  maxPerOrder: currencyMap.default({ USD: 5000, CAD: 6500, INR: 400000 }),
  /** commission may never exceed this share of the order's known contribution (revenue ex-tax less supplier, shipping, duty, payment costs) */
  maxShareOfContribution: z.number().min(0).max(1).default(0.4),
  /** loyalty: tiers add a bonus rate by trailing-90-day delivered attributed orders */
  tiers: z.array(z.object({ name: z.string().min(1).max(40), minOrders90d: z.number().int().min(0), bonusRate: z.number().min(0).max(0.1) })).max(8).default([
    { name: 'Starter', minOrders90d: 0, bonusRate: 0 }, { name: 'Established', minOrders90d: 25, bonusRate: 0.005 }, { name: 'Partner', minOrders90d: 100, bonusRate: 0.01 },
  ]),
  /** days added after the return window before commission becomes payable */
  holdBufferDays: z.number().int().min(0).max(60).default(7),
  /** extra hold days for creators whose trailing refund rate exceeds `refundRateHold` */
  escalatedHoldDays: z.number().int().min(0).max(90).default(21),
  refundRateHold: z.number().min(0).max(1).default(0.25),
  /** attribution window (days) for last-touch creator attribution */
  attributionDays: z.number().int().min(1).max(90).default(30),
  /** minimum payable balance to request a payout, per currency (minor units) */
  payoutThreshold: currencyMap.default({ USD: 5000, CAD: 6500, INR: 400000 }),
  /** velocity limits (orders attributed to one creator) */
  maxOrdersPerHour: z.number().int().min(1).max(1000).default(10),
  maxOrdersPerDay: z.number().int().min(1).max(10_000).default(40),
  /** min distinct buyers sharing one network hash before a cluster flag */
  clusterBuyers: z.number().int().min(2).max(50).default(3),
});
export type CommissionRules = z.infer<typeof commissionRulesSchema>;
export const DEFAULT_COMMISSION_RULES: CommissionRules = commissionRulesSchema.parse({});

export const loyaltyRulesSchema = z.object({
  /** points per 1 USD of delivered net value (after refunds), before tier multiplier */
  pointsPerUsd: z.number().min(0).max(100).default(1),
  /** how many points equal 1 USD of discount */
  pointsPerUsdValue: z.number().min(10).max(10_000).default(100),
  minRedeemPoints: z.number().int().min(100).default(500),
  maxRedeemPoints: z.number().int().min(100).default(5000),
  /** max points redeemed within a rolling 30 days */
  maxRedeemPer30d: z.number().int().min(100).default(10_000),
  redemptionValidDays: z.number().int().min(1).max(90).default(30),
  pointsExpireDays: z.number().int().min(30).max(1825).default(365),
  /** tiers by trailing-12-month delivered net spend, USD minor units */
  tiers: z.array(z.object({ name: z.string().min(1).max(40), minSpendUsd: z.number().int().min(0), multiplier: z.number().min(1).max(3) })).min(1).max(6).default([
    { name: 'Member', minSpendUsd: 0, multiplier: 1 }, { name: 'Silver', minSpendUsd: 30000, multiplier: 1.1 }, { name: 'Gold', minSpendUsd: 100000, multiplier: 1.25 },
  ]),
  referralBonusPoints: z.number().int().min(0).max(5000).default(250),
});
export type LoyaltyRules = z.infer<typeof loyaltyRulesSchema>;
export const DEFAULT_LOYALTY_RULES: LoyaltyRules = loyaltyRulesSchema.parse({});

/* ------------------------------ request schemas ------------------------------ */
export const creatorApplySchema = z.object({
  handle: handleSchema,
  displayName: z.string().trim().min(2).max(60),
  bio: z.string().trim().max(500).default(''),
  socialLinks: z.array(socialLinkSchema).max(6).default([]),
  audience: z.string().trim().max(300).default(''),
  acceptTerms: z.literal(true),
});
export const creatorProfileSchema = z.object({
  displayName: z.string().trim().min(2).max(60).optional(),
  bio: z.string().trim().max(500).optional(),
  socialLinks: z.array(socialLinkSchema).max(6).optional(),
});
export const collectionInputSchema = z.object({
  title: z.string().trim().min(3).max(80),
  description: z.string().trim().max(600).default(''),
  productIds: z.array(objectId).max(40).default([]),
  /** each product may carry the creator's own short note (plain text) */
  notes: z.record(objectId, z.string().trim().max(240)).default({}),
  published: z.boolean().default(false),
});
export const collectionPatchSchema = collectionInputSchema.partial();
export const linkInputSchema = z.object({
  label: z.string().trim().min(1).max(60),
  productId: objectId.optional(),
  collectionId: objectId.optional(),
});
export const attributionCaptureSchema = z.object({
  handle: z.string().trim().max(HANDLE_MAX + 1).optional(),
  link: z.string().trim().regex(/^[A-Za-z0-9]{6,20}$/).optional(),
  landing: z.string().trim().max(200).optional(),
}).refine((v) => !!v.handle || !!v.link, 'handle or link required');
export const payoutRequestSchema = z.object({ currency: z.enum(['USD', 'CAD', 'INR']), note: z.string().trim().max(300).optional() });
export const commentInputSchema = z.object({ body: z.string().trim().min(2).max(500) });
export const reportInputSchema = z.object({ reason: z.enum(['spam', 'abuse', 'personal_info', 'other']) });
export const redeemInputSchema = z.object({ points: z.number().int().min(1).max(100_000) });

/* ------------------------------ loyalty reader (Customer 360 contract) ------------------------------ */
export interface LoyaltyStatus {
  userId: string;
  enrolled: boolean;
  points: number;
  tier: string | null;
  lifetimePoints: number;
  trailingSpendUsd: number;
  nextTier: { name: string; spendRemainingUsd: number } | null;
  expiringSoon: { points: number; at: string } | null;
  asOf: string;
}
export interface LoyaltyReader {
  getLoyaltyStatus(userId: string): Promise<LoyaltyStatus>;
}
