/**
 * Pure attribution rules.
 *
 * PRECEDENCE (documented in docs/ORVIA_CREATORS_AND_LOYALTY.md):
 *  1. Attribution is last-touch: a newer creator touch replaces an older one on the same cart.
 *  2. A touch is valid only inside the attribution window (default 30 days) at the time of ORDER CREATION.
 *  3. A friend-referral coupon applied to the order always beats creator attribution on that order
 *     (the customer explicitly used a friend's code; we never pay a commission AND a referral reward on one order).
 *  4. Self-attribution (creator buying through their own link, same user or same normalised email) earns nothing.
 *  5. A creator who is not `approved` at settlement time earns nothing.
 */
export interface CreatorTouch { creatorId: string; handle: string; capturedAt: Date; expiresAt: Date }

export type AttributionDecision =
  | { payable: true; creatorId: string; reason: 'creator_last_touch' }
  | { payable: false; reason: 'none' | 'expired' | 'referral_precedence' | 'self_attribution' | 'creator_not_approved' };

export const attributionExpiry = (capturedAt: Date, windowDays: number): Date => new Date(capturedAt.getTime() + windowDays * 86_400_000);

/** Should a new touch replace the existing one on the cart? (last touch wins; equal timestamps keep the existing) */
export function newerTouch(existing: CreatorTouch | undefined | null, incoming: CreatorTouch): CreatorTouch {
  if (!existing) return incoming;
  return incoming.capturedAt.getTime() > existing.capturedAt.getTime() ? incoming : existing;
}

export function decideAttribution(i: {
  touch?: CreatorTouch | null;
  orderCreatedAt: Date;
  referralCouponApplied: boolean;
  buyer: { userId?: string; normalizedEmail: string };
  creator?: { userId: string; normalizedEmail: string; status: string } | null;
}): AttributionDecision {
  if (!i.touch) return { payable: false, reason: 'none' };
  // The touch must be valid when the order was created (the window may lapse later without hurting the order)
  if (i.touch.expiresAt.getTime() < i.orderCreatedAt.getTime()) return { payable: false, reason: 'expired' };
  if (i.referralCouponApplied) return { payable: false, reason: 'referral_precedence' };
  if (i.creator) {
    if ((i.buyer.userId && i.buyer.userId === i.creator.userId) || i.buyer.normalizedEmail === i.creator.normalizedEmail) return { payable: false, reason: 'self_attribution' };
    if (i.creator.status !== 'approved') return { payable: false, reason: 'creator_not_approved' };
  }
  return { payable: true, creatorId: i.touch.creatorId, reason: 'creator_last_touch' };
}
