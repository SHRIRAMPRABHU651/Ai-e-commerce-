import { DUMMY_HASH, hashPassword, randomToken, sha256, signSession, verifySession, verifyPassword } from '@orvia/auth';
import { Customer, Session, User } from '@orvia/database';
import { metrics } from '@orvia/config';
import type { Role } from '@orvia/types';
import { audit } from '../infra/audit';
import { DomainError, forbidden, notFound } from '../infra/context';
import type { Actor, Ctx } from '../infra/context';
import { notify } from './notify';

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const FAST = process.env.NODE_ENV === 'test';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  emailVerified: boolean;
}

const pub = (u: { _id: unknown; email: string; name: string; role: string; emailVerified: boolean }): AuthUser => ({ id: String(u._id), email: u.email, name: u.name, role: u.role as Role, emailVerified: u.emailVerified });

export async function registerCustomer(ctx: Ctx, input: { email: string; password: string; name: string }, actor: Actor): Promise<AuthUser> {
  const exists = await User.exists({ email: input.email });
  if (exists) {
    // do not reveal whether an email is registered: respond identically in the API layer, but block here.
    throw new DomainError('An account with this email already exists. Try signing in.', 'EMAIL_TAKEN', 409);
  }
  const token = randomToken(32);
  const user = await User.create({
    email: input.email, name: input.name, passwordHash: await hashPassword(input.password, { fast: FAST }), role: 'CUSTOMER',
    verifyTokenHash: sha256(token), verifyTokenExpires: new Date(ctx.now().getTime() + 48 * 3_600_000), isDemo: false,
  });
  await Customer.updateOne({ email: input.email }, { $setOnInsert: { email: input.email, name: input.name }, $set: { userId: user._id } }, { upsert: true });
  await notify(ctx, { template: 'verify_email', to: user.email, userId: String(user._id), data: { name: user.name, url: `${ctx.cfg.WEB_URL}/verify-email?token=${token}` }, dedupeKey: `verify:${user._id}:${token.slice(0, 8)}` });
  await audit(ctx, actor, { action: 'user.registered', resource: 'user', resourceId: String(user._id) });
  return pub(user);
}

export async function createStaffUser(ctx: Ctx, input: { email: string; password: string; name: string; role: Role }, actor: Actor): Promise<AuthUser> {
  if (input.role === 'CUSTOMER') throw new DomainError('Use customer registration', 'BAD_ROLE', 422);
  const user = await User.create({ email: input.email, name: input.name, role: input.role, passwordHash: await hashPassword(input.password, { fast: FAST }), emailVerified: true });
  await audit(ctx, actor, { action: 'user.staff_created', resource: 'user', resourceId: String(user._id), newValue: { role: input.role } });
  return pub(user);
}

export interface LoginResult {
  token: string;
  user: AuthUser;
  expiresAt: Date;
}

/** Constant-ish timing, generic errors, lockout after repeated failures. */
export async function login(ctx: Ctx, input: { email: string; password: string; ip?: string; userAgent?: string; staffOnly?: boolean }): Promise<LoginResult> {
  const generic = new DomainError('Invalid email or password', 'INVALID_CREDENTIALS', 401);
  const user = await User.findOne({ email: input.email }).select('+passwordHash');
  if (!user || user.deletedAt) {
    await verifyPassword(input.password, DUMMY_HASH);
    metrics.inc('orvia_login_total', { outcome: 'unknown_user' });
    throw generic;
  }
  if (user.lockUntil && user.lockUntil > ctx.now()) {
    metrics.inc('orvia_login_total', { outcome: 'locked' });
    throw new DomainError('Too many failed attempts. Try again later.', 'ACCOUNT_LOCKED', 429);
  }
  const ok = await verifyPassword(input.password, user.passwordHash);
  if (!ok) {
    user.failedLogins = (user.failedLogins ?? 0) + 1;
    if (user.failedLogins >= MAX_FAILS) {
      user.lockUntil = new Date(ctx.now().getTime() + LOCK_MINUTES * 60_000);
      user.failedLogins = 0;
      ctx.log.warn({ channel: 'security', user: String(user._id), ip: input.ip }, 'account locked after repeated failures');
    }
    await user.save();
    metrics.inc('orvia_login_total', { outcome: 'bad_password' });
    throw generic;
  }
  if (user.disabled) throw forbidden('This account is disabled');
  if (input.staffOnly && user.role === 'CUSTOMER') {
    metrics.inc('orvia_login_total', { outcome: 'not_staff' });
    throw generic;
  }
  user.failedLogins = 0;
  user.lockUntil = undefined;
  user.lastLoginAt = ctx.now();
  await user.save();
  const expiresAt = new Date(ctx.now().getTime() + ctx.cfg.SESSION_TTL_HOURS * 3_600_000);
  const session = await Session.create({ userId: user._id, ip: input.ip, userAgent: input.userAgent?.slice(0, 200), expiresAt });
  const token = await signSession({ sub: String(user._id), role: user.role as Role, sid: String(session._id) }, ctx.cfg.JWT_SECRET, ctx.cfg.SESSION_TTL_HOURS);
  metrics.inc('orvia_login_total', { outcome: 'ok' });
  await audit(ctx, { id: String(user._id), type: 'user', role: user.role as Role }, { action: 'user.login', resource: 'user', resourceId: String(user._id) });
  return { token, user: pub(user), expiresAt };
}

/** Validates the JWT and that the server-side session is still live (so logout / revoke is immediate). */
export async function authenticate(ctx: Ctx, token: string): Promise<AuthUser | null> {
  const claims = await verifySession(token, ctx.cfg.JWT_SECRET);
  if (!claims) return null;
  const s = await Session.findOne({ _id: claims.sid, userId: claims.sub, revokedAt: null, expiresAt: { $gt: ctx.now() } }).select('_id').lean();
  if (!s) return null;
  const u = await User.findById(claims.sub).lean();
  if (!u || u.disabled || u.deletedAt) return null;
  return pub(u);
}

export async function logout(ctx: Ctx, token: string): Promise<void> {
  const claims = await verifySession(token, ctx.cfg.JWT_SECRET);
  if (claims) await Session.updateOne({ _id: claims.sid }, { $set: { revokedAt: ctx.now() } });
}

export async function listSessions(userId: string) {
  return Session.find({ userId, revokedAt: null, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).limit(20).select('ip userAgent createdAt expiresAt').lean();
}
export async function revokeSession(userId: string, sessionId: string) {
  await Session.updateOne({ _id: sessionId, userId }, { $set: { revokedAt: new Date() } });
}
export async function revokeAllSessions(userId: string) {
  await Session.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
}

export async function verifyEmail(token: string): Promise<boolean> {
  const u = await User.findOneAndUpdate({ verifyTokenHash: sha256(token), verifyTokenExpires: { $gt: new Date() } }, { $set: { emailVerified: true }, $unset: { verifyTokenHash: '', verifyTokenExpires: '' } });
  return !!u;
}

export async function requestPasswordReset(ctx: Ctx, email: string): Promise<void> {
  const u = await User.findOne({ email });
  if (!u) return; // same response either way
  const token = randomToken(32);
  u.resetTokenHash = sha256(token);
  u.resetTokenExpires = new Date(ctx.now().getTime() + 3_600_000);
  await u.save();
  await notify(ctx, { template: 'reset_password', to: u.email, userId: String(u._id), data: { name: u.name, url: `${ctx.cfg.WEB_URL}/reset-password?token=${token}` }, dedupeKey: `reset:${u._id}:${token.slice(0, 8)}` });
}

export async function resetPassword(ctx: Ctx, token: string, password: string): Promise<void> {
  const u = await User.findOne({ resetTokenHash: sha256(token), resetTokenExpires: { $gt: ctx.now() } }).select('+resetTokenHash +resetTokenExpires +passwordHash');
  if (!u) throw new DomainError('This reset link is invalid or has expired', 'BAD_TOKEN', 400);
  u.passwordHash = await hashPassword(password, { fast: FAST });
  u.resetTokenHash = undefined;
  u.resetTokenExpires = undefined;
  u.failedLogins = 0;
  u.lockUntil = undefined;
  await u.save();
  await revokeAllSessions(String(u._id));
  await audit(ctx, { id: String(u._id), type: 'user' }, { action: 'user.password_reset', resource: 'user', resourceId: String(u._id) });
}

export async function getUser(id: string) {
  const u = await User.findById(id).lean();
  if (!u) throw notFound('User');
  return pub(u);
}
