# Orvia creators, loyalty and referral hardening

Status legend: **Implemented** (code + unit tests; Mongo integration tests written but run only in CI), **Partial**, **Needs external step**, **Planned**.

## 1. Creator programme (implemented)

- **Apply**: a signed-in customer applies at `/creator` (handle, display name, bio, https social links, terms). One application per account. Staff approve/reject in `/admin/creators` (`creators:write`). Statuses: `pending → approved | rejected`, `approved ⇄ suspended`.
- **Handle rules**: 3-30 chars, `a-z 0-9 - _`, no leading/trailing/double separators, reserved words (`admin`, `api`, `cart`, ...) and a small blocked-fragment list rejected. Unique. Source of truth: `validateHandle` in `packages/types/src/creators.ts`.
- **Social links**: https only, no credentials/ports/IPs/localhost; named platforms must match their host.
- **Avatar**: multipart upload using the product-image rules (format sniffing, size cap `MEDIA_MAX_BYTES`, decode check, min dimension `MEDIA_MIN_DIMENSION`), re-encoded to a 512px WebP, metadata stripped.
- **Collections**: ordered list of real sellable products (state must be sellable at write time; at render time only products available in the visitor's country are shown), title, description, per-product note, publish/unpublish. Ownership is enforced in the query (foreign ids 404).
- **Public pages** (SSR, `robots` indexable): `/creators/[handle]`, `/creators/[handle]/[collection]` with metadata, canonical, Open Graph and JSON-LD (`ProfilePage`, `CollectionPage`, `ItemList`). A paid-partnership banner is rendered above the fold (`AFFILIATE_DISCLOSURE`, FTC 16 CFR 255 / ASCI-style wording) and repeated in statements. Creator-supplied links carry `rel="nofollow sponsored"`. No customer data is exposed.
- **Share links**: `/creator` → Links creates a code; URLs are `<page>?cl=<code>` (product page, collection or profile). Clicks are counted per link.
- **Portal** `/creator`: dashboard (clicks, orders, refund rate, balances), collections editor, links, commissions ledger, payouts + statements, profile.

## 2. Attribution (implemented)

- `CreatorCapture` (client component, `apps/web/src/components/creators.tsx`) reads `?cr=<handle>` or `?cl=<code>`, strips it from the URL and POSTs `/api/v1/creators/attribution`. The API records one click (de-duplicated per browser for 30 min, capped at 60/h per IP hash) and sets `Cart.creatorAttribution` (first-party; uses the existing cart cookie, no new cookie). The response never reveals whether a handle exists.
- `createOrderFromCart` copies the attribution to `Order.creatorAttribution` if the window had not lapsed. (Stored as `creatorAttribution`, not `attribution`, because `Order.attribution` already holds ad-campaign data.)
- **Window**: `attributionDays` (default 30, 1-90, admin-editable).
- **Precedence** (`decideAttribution`, pure):
  1. last touch wins between creators;
  2. the touch must be valid at order creation;
  3. a friend-referral coupon (`FRIEND-…`) on the order beats creator attribution (no commission and referral reward on one order);
  4. self-attribution is excluded (same user id, or same normalised email incl. Gmail dot/plus aliases); capture is also refused for a logged-in creator;
  5. a creator who is not `approved` when the order is delivered earns nothing.
- Only salted HMAC hashes of IP and device (UA + language) are stored (`hashCreatorIp`, key derived from `JWT_SECRET`); click rows expire after 180 days.

## 3. Commissions (implemented)

Formula (`computeCommission`, pure, integer minor units, order currency):

```
goodsNet   = subtotal - discount                     (tax-inclusive markets: minus the goods share of embedded tax)
netBase    = round(goodsNet * (1 - min(1, refunded/total)))     # never GMV: excludes tax, shipping, discounts, refunds
line rate  = creator category override > creator flat override > programme category rate > default rate (+ tier bonus; tier bonus not added to creator overrides)
commission = Σ round(line netBase × rate)
caps       : maxPerOrder; ≤ maxShareOfContribution × (revenue ex tax − known costs) when costs are known; hard cap 50% of netBase
zero when  : netBase below minOrderNet, fully refunded, or no lines
```

Defaults (admin-editable, zod-validated, audited): 5% default, minimum order net $15 / C$20 / ₹1000, cap $50 / C$65 / ₹4000, 40% of contribution, tiers Starter 0 / Established (25 orders per 90d) +0.5pt / Partner (100) +1pt. These defaults are launch placeholders, not benchmarks.

**Ledger** (`creator_ledger`, unique `idempotencyKey`): `commission`, `clawback`, `adjustment` rows; statuses `accrued → payable → paid | reversed`.
- Accrual job `creator_commission_accrue` runs when an attributed order becomes DELIVERED (enqueued from `syncTracking` next to `referral_settle`), key `commission:<orderId>`.
- **Hold** = delivered + country return window (30 d) + `holdBufferDays` (7) + `escalatedHoldDays` (21) when the creator's trailing-90d refund rate exceeds `refundRateHold` (25%, min 8 orders).
- **Settlement** (`creator_ledger_settle`, hourly): first claws back, then releases accrued rows past hold, unless the creator is suspended/held or the order has an **open** fraud flag.
- **Clawback**: re-derives the target from current refunds/cancellations. While accrued the amount is reduced in place (or reversed); once payable/paid a negative `clawback` row is booked (key includes the refund snapshot, so idempotent) and nets against the next payout. A commission is never raised after it became payable. Chargebacks are recorded by staff (`POST /admin/creators/orders/:id/chargeback`); there is no PSP dispute webhook integration yet.

## 4. Payouts (implemented; execution is manual)

- Creator requests a payout per currency: needs `kycStatus = verified`, `taxInfoCollected`, no payout hold, and payable balance ≥ `payoutThreshold`. One open request per creator+currency (unique partial index). Ledger rows are locked to the payout.
- Staff approve (checklist re-checked incl. open medium/high flags), reject (rows released) or **record paid** with method and external reference.
- **No payout provider exists in this code. Nothing moves money.** Staff transfer funds in their bank/PSP console and record the reference. Only flags and opaque references are stored for KYC/tax; the portal never collects ID or bank numbers (support does, out of band).
- **Statements**: `GET /creator/payouts/:id/statement?format=json|csv|html`; line items per order (short reference only), net base, rate, holds, clawbacks; `reconciles` proves the total equals the payout amount. CSV is formula-injection safe; HTML is script-free with a restrictive CSP. Owner-only (foreign payouts 404).

## 5. Fraud controls (implemented)

| Control | Where |
|---|---|
| Self-attribution excluded + recorded | `decideAttribution`, flag `self_attribution` |
| Buyer network matches creator's login network (hashed) | flag `ip_cluster` (high) |
| ≥3 distinct buyers from one network in 7d | flag `buyer_cluster` |
| Orders per hour/day above limits | flag `velocity` |
| Refund rate over threshold | flag `refund_rate` + longer hold |
| High checkout fraud score | flag `suspicious_order` |
| Manual review | `/admin/creators` → Fraud review: clear, or confirm (reverses the commission) |

**Referral programme hardening** (`settleReferral` additive checks; rejected reasons shown in admin): `self_referral_alias` (Gmail dots / `+tag` / googlemail normalisation), `duplicate_referee` (same normalised friend already rewarded), `shared_address`, `shared_phone`, `shared_network` (hashed IP), `velocity_cap` (10 rewards per referrer per 30 days). `shared_network` can reject genuine housemates; it is visible in the referrals overview. Signals live in `referral_signals` (hashes only). A rewarded referral also grants bonus loyalty points.

## 6. Loyalty (implemented)

- Ledger `loyalty_ledger` (unique idempotency keys) is authoritative; `loyalty_accounts` is a cache: `{ userId, balance, lifetimePoints, tier, createdAt, updatedAt }` kept in step after each write. Customer 360 reads `userId`, `tier`, `balance`.
- **Earn**: 1 point per USD of delivered net value (after refunds, ex tax/shipping, FX via ops settings) × tier multiplier, job `loyalty_earn` after return window + buffer. Refunds later take points back (`reversal`).
- **Tiers** from trailing-12-month delivered net spend: Member 1× / Silver ($300) 1.1× / Gold ($1000) 1.25×.
- **Redeem**: 100 points = $1; 500-5000 points per code, multiples of 10, ≤10 000 per rolling 30 d; creates a single-use `LOYAL-XXXXXXXX` fixed-amount promotion valid 30 days, usable only on baskets ≥ 3× its value. The promotion engine's margin clamp (≤50% of subtotal, never below landed cost +5%) still applies at checkout, so a code can never create a negative-margin order; `maxSafeDiscount` mirrors it. Concurrent redemptions are guarded by write-then-verify.
- **Expiry**: points expire 365 days after earning (FIFO; never below zero). Unused expired codes restore their points (30-day grace).
- **Admin adjustments** (`loyalty:write`, reason required, balance cannot go negative, audited).
- Customer page `/account/loyalty` (component `LoyaltyPanel`); `getLoyaltyStatus(ctx, userId)` and `makeLoyaltyReader(ctx)` exported from `@orvia/core` returning `LoyaltyStatus` (`@orvia/types`).

## 7. Community (implemented, deliberately small)

Logged-in customers can comment on **published** collections: display name = first name + last initial, 2-500 chars, links/emails/phone numbers rejected, 5/hour and 20/day per user, duplicates refused. Comments start `pending` and appear after staff moderation; any logged-in user can report (3 reports send it back to the queue).

## 8. Admin `/admin/creators` (implemented)

Tabs: applications, creators (clicks, orders, net sales, commission accrued/paid, refund rate), commission rules (JSON editor with server validation), payouts, fraud review, referrals (codes, rewards, rejections by reason), loyalty (balances, adjustments), comments. Reads need `creators:read` / `loyalty:read`; writes `creators:write` / `loyalty:write`; every mutation is audited.

## Jobs

`creator_commission_accrue`, `creator_ledger_settle` (hourly + daily 14-day sweep), `loyalty_earn`, `loyalty_expire` (daily), `creator_order_reconcile` (on demand).

## Limits and gaps

- Integration tests (`tests/integration/creators.test.ts`) were written but not executed in the authoring sandbox (no MongoDB); unit tests cover the pure logic.
- Refund-triggered clawbacks are detected by the hourly scan (orders updated in the last 6 h; daily 14-day sweep), not instantly.
- No payment-provider dispute/chargeback feed, no automated payouts, no tax-form generation, no automated KYC provider.
- Email notifications to creators (approval, payout) are not sent; the creator sees status in the portal.
- Commission and loyalty defaults are placeholders to be set by finance; the contribution cap uses costs only once the supplier order has been placed.
- Creator avatars are not moderated beyond technical checks.
- Click counts are first-party and de-duplicated heuristically; they are not an audited traffic measure.
