/**
 * Privacy transforms. PURE: data export shape, anonymization plan, retention and cooling-off maths, and PII-minimizing
 * views for staff. The DB-backed executor lives in `service.ts`.
 */
import { createHash } from 'node:crypto';
import { DELETION_COOLING_OFF_DAYS } from '@orvia/types';

const DAY = 86_400_000;

/* ------------------------------ retention ------------------------------ */
/** Memory retention: `retentionDays` 0 means keep until deleted. */
export const memoryExpiry = (createdAt: Date, retentionDays: number): Date | null => (retentionDays > 0 ? new Date(createdAt.getTime() + retentionDays * DAY) : null);
export const isExpired = (expiresAt: Date | null | undefined, now: Date): boolean => !!expiresAt && expiresAt.getTime() <= now.getTime();

export const coolingOffEnds = (requestedAt: Date, days = DELETION_COOLING_OFF_DAYS): Date => new Date(requestedAt.getTime() + days * DAY);
export const coolingOffElapsed = (requestedAt: Date, now: Date, days = DELETION_COOLING_OFF_DAYS): boolean => now.getTime() >= coolingOffEnds(requestedAt, days).getTime();

/* ------------------------------ ownership ------------------------------ */
/**
 * Which guest-created records (orders, returns, tickets, customer row, notifications) belong to an account.
 * The account id always counts; the email address counts ONLY when it is verified: registration signs the user in before
 * verification, so otherwise anyone could register with a victim's address and export or anonymize the victim's guest orders.
 */
export const ownerMatch = (userId: string, email: string, emailVerified: boolean): { $or: Record<string, string>[] } => ({ $or: emailVerified ? [{ userId }, { email }] : [{ userId }] });
export const notificationOwnerMatch = (userId: string, email: string, emailVerified: boolean): { $or: Record<string, string>[] } => ({ $or: emailVerified ? [{ userId }, { to: email }] : [{ userId }] });

/* ------------------------------ masking ------------------------------ */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return '—';
  const [local = '', domain = ''] = email.split('@');
  const [host = '', ...tld] = domain.split('.');
  return `${local.slice(0, 1)}***@${host.slice(0, 1)}***${tld.length ? `.${tld.join('.')}` : ''}`;
}
/** First name + initial of the last name. */
export function maskName(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '—';
  return parts.length === 1 ? parts[0]! : `${parts[0]} ${parts[parts.length - 1]!.slice(0, 1)}.`;
}

/** Keys that must never appear in an export or a staff view, at any depth. */
const SECRET_KEY_RE = /^(passwordHash|verifyTokenHash|resetTokenHash|verifyTokenExpires|resetTokenExpires|clientSecret|credentialsEnc|cardNumber|pan|cvc|cvv|number|__v|version|ip|userAgent)$/i;
/** Deep copy dropping secret keys and Mongo internals; ObjectIds / Dates become strings. */
export function stripSecrets<T>(v: T): T {
  const walk = (x: unknown): unknown => {
    if (x === null || x === undefined) return x;
    if (x instanceof Date) return x.toISOString();
    if (Array.isArray(x)) return x.map(walk);
    if (typeof x === 'object') {
      const o = x as Record<string, unknown>;
      if (typeof (o as { toHexString?: unknown }).toHexString === 'function') return String(x);
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(o)) if (!SECRET_KEY_RE.test(k)) out[k] = walk(val);
      return out;
    }
    return x;
  };
  return walk(v) as T;
}

/* ------------------------------ export ------------------------------ */
export const EXPORT_SCHEMA = 'orvia.data-export.v1';
export const EXPORT_SECTIONS = [
  'account', 'customerRecord', 'addresses', 'orders', 'returns', 'refunds', 'supportTickets', 'wishlist', 'reviews', 'referrals',
  'consents', 'communicationPreferences', 'lifeGraph', 'commerceMemory', 'productInteractions', 'loyalty', 'staffNotes', 'deletionRequests', 'notificationsSent',
] as const;
export type ExportSection = (typeof EXPORT_SECTIONS)[number];

/** Assemble the machine-readable export. Every section is always present (empty array/null when nothing is held). */
export function buildExport(subject: { userId: string }, parts: Partial<Record<ExportSection, unknown>>, now: Date) {
  const sections = Object.fromEntries(EXPORT_SECTIONS.map((s) => [s, stripSecrets(parts[s] ?? (s === 'account' || s === 'customerRecord' || s === 'loyalty' || s === 'communicationPreferences' ? null : []))])) as Record<ExportSection, unknown>;
  return {
    schema: EXPORT_SCHEMA,
    generatedAt: now.toISOString(),
    subject: { userId: subject.userId },
    notes: [
      'Contains all personal data Orvia holds about this account that is linked to your user id or to your verified email address.',
      'Card numbers are never stored by Orvia; payments are handled by the payment provider.',
      'Internal fraud/risk scores are excluded from this export; notes staff recorded about you are included under staffNotes.',
    ],
    ...sections,
  };
}

/* ------------------------------ anonymization ------------------------------ */
export const ANON_DOMAIN = 'anonymized.invalid';
/** Stable, non-reversible token for an identity (so referential uniqueness is kept without keeping the address). */
export const anonToken = (userId: string, salt: string): string => createHash('sha256').update(`${salt}:${userId}`).digest('hex').slice(0, 20);
export const anonEmail = (userId: string, salt: string, suffix = ''): string => `deleted-${anonToken(userId, salt)}${suffix}@${ANON_DOMAIN}`;
export const isAnonymizedEmail = (email: string | null | undefined): boolean => !!email && email.endsWith(`@${ANON_DOMAIN}`);

export interface AnonymizationPlan {
  token: string;
  /** Mongo `$set` per collection key; the executor applies them with the filter named in `filters`. */
  user: Record<string, unknown>;
  customer: Record<string, unknown>;
  /** Order PII removed; money, items, country, currency, payment status and timeline are retained (tax / accounting law). */
  order: Record<string, unknown>;
  returns: Record<string, unknown>;
  ticket: Record<string, unknown>;
  review: Record<string, unknown>;
  referral: (suffix: string) => Record<string, unknown>;
  notification: Record<string, unknown>;
  /** Collections whose rows for this user are deleted outright. */
  deleteFrom: string[];
  retained: string[];
}

export function buildAnonymizationPlan(userId: string, email: string, salt: string, now: Date): AnonymizationPlan {
  const token = anonToken(userId, salt);
  const anon = anonEmail(userId, salt);
  return {
    token,
    user: { email: anon, name: 'Deleted customer', disabled: true, emailVerified: false, deletedAt: now, lastLoginAt: null, country: null },
    customer: { email: anon, name: null, marketingConsent: false, riskFlags: [], userId: null },
    order: { email: anon, address: null },
    returns: { email: null, details: null },
    ticket: { email: null, subject: '[removed at customer request]' },
    review: { authorName: 'Deleted customer', body: null, title: null, images: [] },
    referral: (suffix: string) => ({ referrerEmail: anonEmail(userId, salt, `-r${suffix}`), refereeEmail: anonEmail(userId, salt, `-f${suffix}`) }),
    notification: { to: null, subject: null, body: null },
    deleteFrom: ['addresses', 'wishlists', 'carts', 'sessions', 'analytics', 'lifegraph', 'memory', 'commPrefs', 'profile', 'staffNotes'],
    retained: [
      `orders: financial record kept (amounts, items, currency, country, payment/refund status) with name, address, phone and email removed; original email: ${email ? 'removed' : 'n/a'}`,
      'consent records: kept as an evidential log keyed to the anonymized account (no contact details)',
      'audit log: kept (legal/security record, no raw PII beyond ids)',
    ],
  };
}

/** Mask the shipping address to the minimum a tax record needs. Used when a retained order must keep jurisdiction. */
export const minimalAddress = (a: { country?: string; region?: string } | null | undefined) => (a ? { country: a.country, region: a.region } : null);

/* ------------------------------ staff view minimization ------------------------------ */
export interface StaffViewOpts { revealEmail: boolean }
/** Reduce a full profile to what support needs. No address, phone, IP, message bodies or analytics meta. */
export function minimizeProfileForStaff<T extends { identity: { email: string; name?: string | null }; [k: string]: unknown }>(p: T, o: StaffViewOpts): T {
  return {
    ...p,
    identity: { ...p.identity, email: o.revealEmail ? p.identity.email : maskEmail(p.identity.email), name: o.revealEmail ? p.identity.name : maskName(p.identity.name) },
  };
}
