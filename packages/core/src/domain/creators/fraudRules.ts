/** Pure fraud / abuse helpers (creator program + referral program). No IO. */
import { createHmac } from 'node:crypto';

const GMAIL = new Set(['gmail.com', 'googlemail.com']);
/**
 * Canonical form of an email for DUPLICATE DETECTION only (never used for sending):
 *  - lowercase, trim
 *  - strip "+tag" sub-addressing on every domain
 *  - Gmail/Googlemail: also drop dots in the local part and unify the domain to gmail.com
 */
export function normalizeEmail(raw: string): string {
  const e = raw.trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1) return e;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (GMAIL.has(domain)) { local = local.replace(/\./g, ''); domain = 'gmail.com'; }
  return `${local}@${domain}`;
}

/** Salted, truncated HMAC so raw IP / phone / address never sit in fraud tables. Not reversible without the secret. */
export const hashSignal = (secret: string, kind: string, value: string): string =>
  createHmac('sha256', secret).update(`${kind}:${value.trim().toLowerCase()}`).digest('hex').slice(0, 32);

export const normalizePhone = (p: string | undefined | null): string => (p ?? '').replace(/\D+/g, '').replace(/^0+/, '').slice(-10);
export const addressKey = (a: { line1?: string | null; postalCode?: string | null; country?: string | null } | undefined | null): string =>
  a?.line1 && a.postalCode ? `${a.line1}|${a.postalCode}|${a.country ?? ''}`.toLowerCase().replace(/[^a-z0-9|]+/g, '') : '';

export interface PartyFacts { normalizedEmail: string; addressHashes: string[]; phoneHashes: string[]; ipHashes: string[] }
export interface ReferralCheckInput {
  referrer: PartyFacts;
  referee: PartyFacts;
  /** already-seen normalized referee emails (from earlier referral signals, excluding this order) */
  priorRefereeEmails: string[];
  referrerRewards30d: number;
  maxRewards30d: number;
}
export type ReferralAbuse = 'self_referral_alias' | 'duplicate_referee' | 'shared_address' | 'shared_phone' | 'shared_network' | 'velocity_cap';

/** Returns the first (strongest-evidence) abuse reason or null. */
export function referralAbuse(i: ReferralCheckInput): ReferralAbuse | null {
  if (i.referee.normalizedEmail === i.referrer.normalizedEmail) return 'self_referral_alias';
  if (i.priorRefereeEmails.includes(i.referee.normalizedEmail)) return 'duplicate_referee';
  const inter = (a: string[], b: string[]) => a.some((x) => x && b.includes(x));
  if (inter(i.referee.addressHashes, i.referrer.addressHashes)) return 'shared_address';
  if (inter(i.referee.phoneHashes, i.referrer.phoneHashes)) return 'shared_phone';
  if (inter(i.referee.ipHashes, i.referrer.ipHashes)) return 'shared_network';
  if (i.referrerRewards30d >= i.maxRewards30d) return 'velocity_cap';
  return null;
}

export interface OrderFraudFacts {
  /** this creator's attributed orders in the last hour / day (excluding this one) */
  ordersLastHour: number;
  ordersLastDay: number;
  buyerIpHash?: string;
  creatorIpHashes: string[];
  /** distinct normalized buyer emails seen from the same ip hash for this creator in the last 7 days (including this buyer) */
  buyersSameIp: number;
  creatorRefundRate: number;
  creatorOrderSample: number;
  buyerFraudLevel?: 'low' | 'medium' | 'high';
}
export interface FlagCandidate { kind: 'ip_cluster' | 'buyer_cluster' | 'velocity' | 'refund_rate' | 'suspicious_order'; severity: 'low' | 'medium' | 'high'; detail: string }
export function evaluateCreatorOrder(f: OrderFraudFacts, limits: { maxOrdersPerHour: number; maxOrdersPerDay: number; clusterBuyers: number; refundRateHold: number }): FlagCandidate[] {
  const out: FlagCandidate[] = [];
  if (f.buyerIpHash && f.creatorIpHashes.includes(f.buyerIpHash)) out.push({ kind: 'ip_cluster', severity: 'high', detail: 'Buyer network matches a network the creator signed in from' });
  if (f.buyersSameIp >= limits.clusterBuyers) out.push({ kind: 'buyer_cluster', severity: 'medium', detail: `${f.buyersSameIp} distinct buyers from one network in 7 days` });
  if (f.ordersLastHour + 1 > limits.maxOrdersPerHour) out.push({ kind: 'velocity', severity: 'medium', detail: `More than ${limits.maxOrdersPerHour} attributed orders in one hour` });
  else if (f.ordersLastDay + 1 > limits.maxOrdersPerDay) out.push({ kind: 'velocity', severity: 'medium', detail: `More than ${limits.maxOrdersPerDay} attributed orders in one day` });
  if (f.creatorOrderSample >= 8 && f.creatorRefundRate > limits.refundRateHold) out.push({ kind: 'refund_rate', severity: 'medium', detail: `Refund rate ${(f.creatorRefundRate * 100).toFixed(0)}% over ${f.creatorOrderSample} orders` });
  if (f.buyerFraudLevel === 'high') out.push({ kind: 'suspicious_order', severity: 'high', detail: 'Order carries a high checkout fraud score' });
  return out;
}
