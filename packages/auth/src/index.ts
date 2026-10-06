import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { Role } from '@orvia/types';

/* ------------------------------ passwords ------------------------------ */
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 64, maxmem: 128 * 1024 * 1024 };

function scryptAsync(password: string, salt: Buffer, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, SCRYPT.keylen, { N: n, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** Format: scrypt$N$saltB64$hashB64. Never stores plaintext. `fast` lowers cost for unit tests only. */
export async function hashPassword(password: string, opts: { fast?: boolean } = {}): Promise<string> {
  const salt = randomBytes(16);
  const n = opts.fast ? 2 ** 10 : SCRYPT.N;
  const key = await scryptAsync(password, salt, n);
  return `scrypt$${n}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, nStr, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !nStr || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), Number(nStr));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** A dummy hash used to equalise timing when the user does not exist. */
export const DUMMY_HASH = 'scrypt$1024$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');

/* -------------------------------- tokens -------------------------------- */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');
export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export interface SessionClaims {
  sub: string;
  role: Role;
  sid: string;
}

const enc = (secret: string) => new TextEncoder().encode(secret);

export async function signSession(claims: SessionClaims, secret: string, ttlHours: number): Promise<string> {
  return new SignJWT({ role: claims.role, sid: claims.sid })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setIssuer('orvia')
    .setExpirationTime(`${ttlHours}h`)
    .sign(enc(secret));
}

export async function verifySession(token: string, secret: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, enc(secret), { issuer: 'orvia', algorithms: ['HS256'] });
    if (!payload.sub || typeof payload['sid'] !== 'string' || typeof payload['role'] !== 'string') return null;
    return { sub: payload.sub, sid: payload['sid'], role: payload['role'] as Role };
  } catch {
    return null;
  }
}

/* --------------------------------- RBAC --------------------------------- */
export const PERMISSIONS = [
  'overview:read',
  'orders:read',
  'orders:write',
  'refunds:write',
  'refunds:approve',
  'products:read',
  'products:write',
  'categories:write',
  'suppliers:read',
  'suppliers:write',
  'inventory:read',
  'inventory:write',
  'customers:read',
  'marketing:read',
  'marketing:write',
  'ads:read',
  'ads:write',
  'promotions:read',
  'promotions:write',
  'analytics:read',
  'copilot:use',
  'automation:read',
  'automation:write',
  'countries:read',
  'countries:write',
  'payments:read',
  'shipping:read',
  'returns:read',
  'returns:write',
  'reviews:read',
  'reviews:write',
  'support:read',
  'support:write',
  'exceptions:read',
  'exceptions:write',
  'settings:read',
  'settings:write',
  'audit:read',
  'users:manage',
  'ai:write',
  'market:read',
  'market:write',
  'launch:read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const allPerms = [...PERMISSIONS];
const readOnly = PERMISSIONS.filter((p) => p.endsWith(':read'));

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  SUPER_ADMIN: allPerms,
  ADMIN: allPerms.filter((p) => p !== 'users:manage'),
  MARKETING: [
    'overview:read', 'products:read', 'marketing:read', 'marketing:write', 'ads:read', 'ads:write',
    'promotions:read', 'promotions:write', 'analytics:read', 'copilot:use', 'reviews:read', 'countries:read',
    'automation:read', 'ai:write', 'market:read', 'market:write',
  ],
  OPERATIONS: [
    'overview:read', 'orders:read', 'orders:write', 'products:read', 'suppliers:read', 'suppliers:write',
    'inventory:read', 'inventory:write', 'shipping:read', 'returns:read', 'returns:write', 'exceptions:read',
    'exceptions:write', 'payments:read', 'customers:read', 'analytics:read', 'automation:read', 'countries:read',
    'refunds:write', 'market:read', 'launch:read',
  ],
  SUPPORT: [
    'overview:read', 'orders:read', 'customers:read', 'support:read', 'support:write', 'returns:read',
    'returns:write', 'reviews:read', 'reviews:write', 'exceptions:read', 'refunds:write', 'shipping:read',
  ],
  ANALYST: [...readOnly.filter((p) => !['settings:read', 'audit:read', 'payments:read', 'launch:read'].includes(p)), 'copilot:use'],
  CUSTOMER: [],
};

export function can(role: Role | undefined, perm: Permission): boolean {
  return !!role && ROLE_PERMISSIONS[role].includes(perm);
}

/* ----------------------- credential encryption (AES-GCM) ----------------------- */
function keyFrom(hexOrSecret: string): Buffer {
  return /^[0-9a-f]{64}$/i.test(hexOrSecret) ? Buffer.from(hexOrSecret, 'hex') : createHash('sha256').update(hexOrSecret).digest();
}

export function encryptSecret(plain: string, key: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyFrom(key), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), body.toString('base64')].join('.');
}

export function decryptSecret(payload: string, key: string): string {
  const [iv, tag, body] = payload.split('.');
  if (!iv || !tag || !body) throw new Error('Malformed ciphertext');
  const d = createDecipheriv('aes-256-gcm', keyFrom(key), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8');
}
