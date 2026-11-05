/**
 * PII normalisation + SHA-256 hashing exactly as the ad platforms require (pure, no I/O).
 *  - Meta CAPI:   em = sha256(trim+lowercase email); ph = sha256(digits only, incl. country code, no '+')
 *  - TikTok:      email = sha256(trim+lowercase); phone = sha256(E.164 incl. '+')
 *  - GA4 MP / Google Ads enhanced conversions: sha256(lowercase email; gmail/googlemail dots removed); phone = sha256(E.164)
 * Raw values are never stored or logged; only these hex digests enter the outbox.
 */
import { createHash } from 'node:crypto';

export const sha256Hex = (v: string): string => createHash('sha256').update(v, 'utf8').digest('hex');

/** Trim + lowercase. Returns null for anything that is not shaped like an email. */
export function normalizeEmail(raw: string | null | undefined): string | null {
  const e = (raw ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

/** Google's rule: for gmail.com / googlemail.com the dots before the @ are ignored. */
export function normalizeEmailForGoogle(raw: string | null | undefined): string | null {
  const e = normalizeEmail(raw);
  if (!e) return null;
  const [local, domain] = e.split('@') as [string, string];
  return domain === 'gmail.com' || domain === 'googlemail.com' ? `${local.replace(/\./g, '')}@${domain}` : e;
}

const CALLING_CODE: Record<string, string> = { US: '1', CA: '1', IN: '91' };

/**
 * E.164 ("+14155550100"). Accepts "+" numbers as-is (digits only after stripping punctuation); otherwise prepends the
 * calling code of `defaultCountry` (dropping a national trunk "0"). Returns null if it cannot be made plausible (8-15 digits).
 */
export function normalizePhoneE164(raw: string | null | undefined, defaultCountry?: string): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  let out: string;
  if (s.startsWith('+')) out = digits;
  else if (s.startsWith('00')) out = digits.slice(2);
  else {
    const cc = CALLING_CODE[(defaultCountry ?? '').toUpperCase()];
    if (!cc) return null;
    out = digits.startsWith(cc) && digits.length >= cc.length + 10 ? digits : cc + digits.replace(/^0+/, '');
  }
  return out.length >= 8 && out.length <= 15 ? `+${out}` : null;
}

export const hashEmail = (raw: string | null | undefined, flavour: 'standard' | 'google' = 'standard'): string | undefined => {
  const n = flavour === 'google' ? normalizeEmailForGoogle(raw) : normalizeEmail(raw);
  return n ? sha256Hex(n) : undefined;
};
/** Meta wants digits only (country code included, no '+'). */
export const hashPhoneDigits = (raw: string | null | undefined, country?: string): string | undefined => {
  const n = normalizePhoneE164(raw, country);
  return n ? sha256Hex(n.slice(1)) : undefined;
};
export const hashPhoneE164 = (raw: string | null | undefined, country?: string): string | undefined => {
  const n = normalizePhoneE164(raw, country);
  return n ? sha256Hex(n) : undefined;
};
export const hashExternalId = (id: string | null | undefined): string | undefined => (id ? sha256Hex(String(id).trim()) : undefined);

/** Meta `fbc` from a raw fbclid: `fb.1.<creationTimeMs>.<fbclid>`. */
export const buildFbc = (fbclid: string, tsMs: number): string => `fb.1.${tsMs}.${fbclid}`;
