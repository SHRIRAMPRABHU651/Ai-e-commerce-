/**
 * Consent tokens. Pure apart from node:crypto.
 * A token is a signed, expiring bearer capability bound to ONE case + round + recipient. It authenticates the
 * viewer; every option's consent record can be decided exactly once (enforced atomically in the DB layer).
 * Only the SHA-256 of a token is ever stored.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface ConsentClaims {
  caseId: string;
  /** Bumped whenever options are re-planned; older links stop working. */
  round: number;
  /** Expiry, epoch ms. */
  exp: number;
  /** Hash of the recipient email (binds the link to the customer it was sent to). */
  sub: string;
  nonce: string;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const sign = (payload: string, secret: string) => createHmac('sha256', `orvia.rescue.consent.v1:${secret}`).update(payload).digest();

export const emailSubject = (email: string): string => createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16);

export function signConsentToken(c: Omit<ConsentClaims, 'nonce'> & { nonce?: string }, secret: string): string {
  const claims: ConsentClaims = { ...c, nonce: c.nonce ?? randomBytes(9).toString('base64url') };
  const body = b64(JSON.stringify(claims));
  return `${body}.${b64(sign(body, secret))}`;
}

export type TokenCheck =
  | { ok: true; claims: ConsentClaims }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'wrong_case' | 'stale_round' | 'wrong_recipient' };

export function verifyConsentToken(token: string, secret: string, now: Date, expect: { caseId: string; round: number; email?: string }): TokenCheck {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };
  const given = Buffer.from(parts[1], 'base64url');
  const want = sign(parts[0], secret);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return { ok: false, reason: 'bad_signature' };
  let claims: ConsentClaims;
  try {
    claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as ConsentClaims;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof claims.caseId !== 'string' || typeof claims.exp !== 'number' || typeof claims.round !== 'number') return { ok: false, reason: 'malformed' };
  if (claims.exp <= now.getTime()) return { ok: false, reason: 'expired' };
  if (claims.caseId !== expect.caseId) return { ok: false, reason: 'wrong_case' };
  if (claims.round !== expect.round) return { ok: false, reason: 'stale_round' };
  if (expect.email && claims.sub !== emailSubject(expect.email)) return { ok: false, reason: 'wrong_recipient' };
  return { ok: true, claims };
}

export const hashToken = (t: string): string => createHash('sha256').update(t).digest('hex');
export const consentExpiry = (now: Date, ttlHours: number): Date => new Date(now.getTime() + ttlHours * 3_600_000);

/** Hash of the exact terms the customer saw. Stored with the consent; a re-plan that changes terms changes the hash. */
export function termsHash(t: { optionId: string; kind: string; refund: number; extraCost: number; etaMaxDays: number | null; replacementProductId?: string | null; currency: string }): string {
  return createHash('sha256').update(JSON.stringify([t.optionId, t.kind, t.refund, t.extraCost, t.etaMaxDays, t.replacementProductId ?? null, t.currency])).digest('hex').slice(0, 24);
}

/** Pure state machine for one consent record. */
export type ConsentStatus = 'pending' | 'accepted' | 'declined' | 'expired' | 'revoked';
export function consentTransition(cur: ConsentStatus, event: 'accept' | 'decline' | 'expire' | 'revoke', expired: boolean): { ok: true; next: ConsentStatus } | { ok: false; reason: 'already_decided' | 'expired' } {
  if (cur !== 'pending') return { ok: false, reason: 'already_decided' };
  if (event === 'expire') return { ok: true, next: 'expired' };
  if (event === 'revoke') return { ok: true, next: 'revoked' };
  if (expired) return { ok: false, reason: 'expired' };
  return { ok: true, next: event === 'accept' ? 'accepted' : 'declined' };
}
