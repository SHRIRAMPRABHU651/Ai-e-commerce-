/**
 * Signed, stateless tokens for unsubscribe links and click tracking (pure; HMAC-SHA256, domain-separated per purpose).
 * Unsubscribe tokens do not expire: an old email must still be able to opt out.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type TokenKind = 'unsub' | 'click';

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

function mac(kind: TokenKind, payload: string, secret: string): string {
  return createHmac('sha256', secret).update(`orvia:events:${kind}:v1:${payload}`).digest('base64url');
}

export function signToken(kind: TokenKind, data: Record<string, string>, secret: string): string {
  const payload = b64(JSON.stringify(data));
  return `${payload}.${mac(kind, payload, secret)}`;
}

export function verifyToken(kind: TokenKind, token: string, secret: string): Record<string, string> | null {
  const [payload, sig, extra] = token.split('.');
  if (!payload || !sig || extra !== undefined) return null;
  const expected = Buffer.from(mac(kind, payload, secret));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, string>) : null;
  } catch {
    return null;
  }
}

export const unsubscribeUrl = (apiUrl: string, email: string, secret: string, campaignId?: string): string =>
  `${apiUrl.replace(/\/$/, '')}/api/v1/unsubscribe?token=${signToken('unsub', campaignId ? { e: email.toLowerCase(), c: campaignId } : { e: email.toLowerCase() }, secret)}`;

/** Redirect target must be on the store origin (the token is signed, but we still never redirect off-site). */
export function isAllowedRedirect(url: string, storeOrigin: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === new URL(storeOrigin).origin;
  } catch {
    return false;
  }
}

export const clickUrl = (apiUrl: string, campaignId: string, email: string, target: string, secret: string): string =>
  `${apiUrl.replace(/\/$/, '')}/api/v1/r?token=${signToken('click', { c: campaignId, e: email.toLowerCase(), u: target }, secret)}`;
