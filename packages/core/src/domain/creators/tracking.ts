import { Cart, CreatorClick, CreatorLink, CreatorProfile } from '@orvia/database';
import type { z } from 'zod';
import type { attributionCaptureSchema } from '@orvia/types';
import type { Ctx } from '../../infra/context';
import { attributionExpiry, newerTouch } from './attribution';
import { getRules, hashCreatorDevice, hashCreatorIp } from './config';

export interface CaptureInput extends z.infer<typeof attributionCaptureSchema> {
  cartToken: string;
  userId?: string;
  ip?: string;
  userAgent?: string;
  acceptLanguage?: string;
}
export type CaptureResult = { recorded: boolean; attributed: boolean; reason?: 'unknown_creator' | 'self' | 'rate_limited' | 'cart_missing' };

const CLICK_DEDUPE_MS = 30 * 60_000;
const CLICKS_PER_IP_PER_HOUR = 60;

/**
 * Landing capture + click tracking. Sets a FIRST-PARTY attribution on the cart (last touch wins) with the configured window.
 * No cookies of its own: the cart cookie already identifies the session. IP and device are stored only as salted hashes.
 */
export async function captureAttribution(ctx: Ctx, i: CaptureInput): Promise<CaptureResult> {
  let creator: { _id: unknown; userId: unknown; handle: string; status: string } | null = null;
  let link: { _id: unknown; creatorId: unknown } | null = null;
  if (i.link) {
    link = await CreatorLink.findOne({ code: i.link, active: true }).select('creatorId').lean();
    if (link) creator = await CreatorProfile.findById(link.creatorId).select('userId handle status').lean();
  }
  if (!creator && i.handle) creator = await CreatorProfile.findOne({ handle: i.handle.trim().replace(/^@/, '').toLowerCase() }).select('userId handle status').lean();
  if (!creator || creator.status !== 'approved') return { recorded: false, attributed: false, reason: 'unknown_creator' };
  if (i.userId && String(creator.userId) === i.userId) return { recorded: false, attributed: false, reason: 'self' }; // creators never earn from their own sessions

  const ipHash = hashCreatorIp(ctx, i.ip);
  const deviceHash = hashCreatorDevice(ctx, i.userAgent, i.acceptLanguage);
  const now = ctx.now();
  if (ipHash && (await CreatorClick.countDocuments({ ipHash, at: { $gte: new Date(now.getTime() - 3_600_000) } })) >= CLICKS_PER_IP_PER_HOUR) return { recorded: false, attributed: false, reason: 'rate_limited' };

  const cart = await Cart.findOne({ token: i.cartToken }).select('creatorAttribution convertedOrderId').lean();
  if (!cart || cart.convertedOrderId) return { recorded: false, attributed: false, reason: 'cart_missing' };

  const rules = await getRules();
  const incoming = { creatorId: String(creator._id), handle: creator.handle, capturedAt: now, expiresAt: attributionExpiry(now, rules.attributionDays) };
  const ex = cart.creatorAttribution;
  const existing = ex?.creatorId && ex.capturedAt && ex.expiresAt ? { creatorId: String(ex.creatorId), handle: ex.handle ?? '', capturedAt: ex.capturedAt, expiresAt: ex.expiresAt } : null;
  const winner = newerTouch(existing, incoming);

  // de-duplicate rapid repeat clicks (reloads) from the same browser so click counts are not inflated
  const dup = ipHash && deviceHash ? await CreatorClick.exists({ creatorId: creator._id, ipHash, deviceHash, at: { $gte: new Date(now.getTime() - CLICK_DEDUPE_MS) } }) : null;
  if (!dup) {
    await CreatorClick.create({ creatorId: creator._id, linkId: link?._id, cartToken: i.cartToken, ipHash, deviceHash, landing: i.landing?.slice(0, 200), userId: i.userId, at: now });
    await CreatorProfile.updateOne({ _id: creator._id }, { $inc: { 'stats.clicks': 1 } });
    if (link) await CreatorLink.updateOne({ _id: link._id }, { $inc: { clicks: 1 } });
  }
  if (winner === incoming) {
    await Cart.updateOne({ token: i.cartToken, convertedOrderId: { $exists: false } }, { $set: { creatorAttribution: { creatorId: creator._id, handle: creator.handle, linkCode: i.link, capturedAt: now, expiresAt: incoming.expiresAt, ipHash, deviceHash } } });
  }
  return { recorded: !dup, attributed: winner === incoming };
}
