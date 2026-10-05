import type { CountryCode } from '@orvia/types';
import { Order } from '@orvia/database';
import type { OpsSettings } from '../infra/settings';

const DISPOSABLE = /@(mailinator|tempmail|guerrillamail|10minutemail|yopmail|trashmail|throwaway|sharklasers)\./i;

export interface AddressCheck {
  ok: boolean;
  problems: string[];
}

const US_STATES = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR'.split(' '));
const CA_PROVINCES = new Set('AB BC MB NB NL NS NT NU ON PE QC SK YT'.split(' '));

/** Format-level address validation (a real address-verification API can be layered on top). */
export function validateAddress(a: { country: CountryCode; region: string; postalCode: string; line1: string; city: string }): AddressCheck {
  const problems: string[] = [];
  const pc = a.postalCode.trim().toUpperCase();
  const region = a.region.trim().toUpperCase();
  if (a.country === 'US') {
    if (!/^\d{5}(-\d{4})?$/.test(pc)) problems.push('ZIP code must be 5 digits');
    if (!US_STATES.has(region)) problems.push('Use the 2-letter state code');
  } else if (a.country === 'CA') {
    if (!/^[ABCEGHJ-NPRSTVXY]\d[A-Z][ -]?\d[A-Z]\d$/.test(pc)) problems.push('Invalid Canadian postal code');
    if (!CA_PROVINCES.has(region)) problems.push('Use the 2-letter province code');
  } else if (a.country === 'IN') {
    if (!/^[1-9]\d{5}$/.test(pc)) problems.push('PIN code must be 6 digits');
    if (region.length < 2) problems.push('State is required');
  }
  if (a.line1.trim().length < 5) problems.push('Street address looks too short');
  if (/^\s*(p\.?o\.? box)/i.test(a.line1) && a.country === 'IN') problems.push('PO boxes are not supported');
  return { ok: problems.length === 0, problems };
}

export interface FraudInput {
  email: string;
  userId?: string;
  ip?: string;
  ipCountry?: string;
  shippingCountry: CountryCode;
  totalUsd: number;
  shippingMethod: string;
  address: { country: CountryCode; region: string; postalCode: string; line1: string; city: string };
  isFirstOrder: boolean;
  paymentCountry?: string;
  /** failed payment attempts for this email in the last 24h */
  failedAttempts?: number;
}

export interface FraudResult {
  score: number;
  level: 'low' | 'medium' | 'high';
  signals: string[];
}

export async function assessFraud(i: FraudInput, ops: Pick<OpsSettings, 'fraudHighScore' | 'fraudMediumScore' | 'highValueOrderUsd'>, now = new Date()): Promise<FraudResult> {
  let score = 0;
  const signals: string[] = [];
  const add = (n: number, s: string) => {
    score += n;
    signals.push(s);
  };
  const hourAgo = new Date(now.getTime() - 3600_000);
  const [byEmail, byIp] = await Promise.all([
    Order.countDocuments({ email: i.email, createdAt: { $gte: hourAgo } }),
    i.ip ? Order.countDocuments({ 'fraud.ip': i.ip, createdAt: { $gte: hourAgo } }) : Promise.resolve(0),
  ]);
  if (byEmail >= 3) add(25, `velocity: ${byEmail} orders from this email in 1h`);
  if (byIp >= 4) add(25, `velocity: ${byIp} orders from this IP in 1h`);
  if ((i.failedAttempts ?? 0) >= 3) add(20, `${i.failedAttempts} failed payment attempts in 24h`);
  if (i.ipCountry && i.ipCountry !== i.shippingCountry) add(15, `IP country ${i.ipCountry} differs from shipping country ${i.shippingCountry}`);
  if (i.paymentCountry && i.paymentCountry !== i.shippingCountry) add(15, `payment country ${i.paymentCountry} differs from shipping country`);
  if (DISPOSABLE.test(i.email)) add(20, 'disposable email domain');
  if (i.totalUsd >= ops.highValueOrderUsd) add(20, 'high order value');
  if (i.isFirstOrder && i.shippingMethod === 'express' && i.totalUsd >= ops.highValueOrderUsd / 2) add(10, 'first order, express shipping, high value');
  const addr = validateAddress(i.address);
  if (!addr.ok) add(15, `address problems: ${addr.problems.join('; ')}`);
  score = Math.min(100, score);
  const level = score >= ops.fraudHighScore ? 'high' : score >= ops.fraudMediumScore ? 'medium' : 'low';
  return { score, level, signals };
}
