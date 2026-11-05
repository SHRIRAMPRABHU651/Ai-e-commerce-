/**
 * ORVIA Price Guard: pure decision logic for price history and alerts.
 *
 * Honesty rules encoded here:
 *  - History is ONLY what our own snapshots observed. No "was" prices or reference prices are ever manufactured.
 *  - "Lowest in last N days" is reported only for the window our data actually covers.
 *  - Alerts fire once per genuinely new condition (dedupe state is carried in `AlertState`).
 */

export interface Snap {
  at: Date;
  price: number;
  inStock: boolean;
}

const DAY = 86_400_000;
const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Should we write a new price snapshot? Only when something changed, at most once per UTC day for the scheduled job.
 * `force` (on-demand, e.g. when someone starts tracking) bypasses the daily limit but never writes an identical row.
 */
export function shouldSnapshot(last: Snap | null, cur: { price: number; inStock: boolean }, now: Date, force = false): boolean {
  if (cur.price <= 0) return false;
  if (!last) return true;
  if (last.price === cur.price && last.inStock === cur.inStock) return false;
  if (!force && utcDay(last.at) === utcDay(now)) return false;
  return true;
}

export interface HistorySummary {
  observations: number;
  firstObservedAt: Date | null;
  current: number | null;
  lowest: { price: number; at: Date; windowDays: number } | null;
  sufficient: boolean;
  statement: string | null;
}

/**
 * `snaps` ascending by time. A snapshot is a change event, so the price in force at the start of the window is the last
 * snapshot before it; that snapshot counts toward the window. Only in-stock observations count as a purchasable low.
 */
export function summarizeHistory(snaps: Snap[], now: Date, windowDays: number, fmt: (minor: number) => string): HistorySummary {
  const n = snaps.length;
  if (!n) return { observations: 0, firstObservedAt: null, current: null, lowest: null, sufficient: false, statement: null };
  const first = snaps[0]!;
  const current = snaps.at(-1)!.price;
  const coverageDays = Math.max(0, Math.floor((now.getTime() - first.at.getTime()) / DAY));
  const effWindow = Math.min(windowDays, coverageDays);
  const start = now.getTime() - windowDays * DAY;
  let startIdx = snaps.findIndex((s) => s.at.getTime() >= start);
  if (startIdx === -1) startIdx = n - 1;
  if (startIdx > 0) startIdx -= 1; // the snapshot in force when the window began
  const inWindow = snaps.slice(startIdx).filter((s) => s.inStock);
  let lowest: HistorySummary['lowest'] = null;
  for (const s of inWindow) if (!lowest || s.price < lowest.price) lowest = { price: s.price, at: s.at, windowDays: effWindow };
  const sufficient = n >= 2 && coverageDays >= 1 && !!lowest;
  let statement: string | null = null;
  if (sufficient && lowest) {
    const span = effWindow >= windowDays ? `the last ${windowDays} days` : `the ${effWindow} day${effWindow === 1 ? '' : 's'} we have been tracking this price`;
    statement =
      current === lowest.price
        ? `The current price is the lowest we have recorded in ${span} (${n} observations).`
        : `Lowest price we recorded in ${span}: ${fmt(lowest.price)} (${utcDay(lowest.at)}; ${n} observations).`;
  }
  return { observations: n, firstObservedAt: first.at, current, lowest, sufficient, statement };
}

/* ------------------------------ alerts ------------------------------ */
export interface AlertState {
  baselinePrice: number;
  targetPrice: number | null;
  dropPercent: number;
  notifyOnDrop: boolean;
  notifyOnStock: boolean;
  notifyOnBetterOffer: boolean;
  /** null = never observed yet */
  lastSeenInStock: boolean | null;
  lastNotifiedDropPrice: number | null;
  targetNotifiedPrice: number | null;
  betterOfferNotifiedId: string | null;
  betterOfferNotifiedPrice: number | null;
}
export type AlertEvent =
  | { type: 'price_drop'; price: number; from: number }
  | { type: 'target_met'; price: number; target: number }
  | { type: 'back_in_stock'; price: number }
  | { type: 'better_offer'; productId: string; price: number };

export interface Observed {
  price: number;
  inStock: boolean;
  betterOffer?: { productId: string; delivered: number } | null;
}

/** A further drop of at least this fraction of the last notified price is needed before notifying about price again. */
export const RENOTIFY_MIN_DROP = 0.01;
export const BETTER_OFFER_RENOTIFY_DROP = 0.03;

export function decideAlertEvents(a: AlertState, o: Observed): { events: AlertEvent[]; next: Partial<AlertState> } {
  const events: AlertEvent[] = [];
  const next: Partial<AlertState> = {};
  if (!o.inStock || o.price <= 0) {
    next.lastSeenInStock = false;
    return { events, next };
  }
  if (a.notifyOnStock && a.lastSeenInStock === false) events.push({ type: 'back_in_stock', price: o.price });
  next.lastSeenInStock = true;

  let lastDrop = a.lastNotifiedDropPrice;
  let lastTarget = a.targetNotifiedPrice;
  if (o.price > a.baselinePrice) {
    // price recovered above where tracking began: future drops are new news
    lastDrop = null; lastTarget = null;
    next.lastNotifiedDropPrice = null; next.targetNotifiedPrice = null;
  }
  const ref = lastDrop ?? a.baselinePrice;
  const dropPct = ((a.baselinePrice - o.price) / a.baselinePrice) * 100;
  const dropDue = a.notifyOnDrop && o.price < ref && dropPct >= a.dropPercent && (ref - o.price) / ref >= (lastDrop === null ? 0 : RENOTIFY_MIN_DROP);
  const targetDue = a.targetPrice !== null && o.price <= a.targetPrice && (lastTarget === null || o.price < lastTarget);
  if (targetDue) {
    events.push({ type: 'target_met', price: o.price, target: a.targetPrice! });
    next.targetNotifiedPrice = o.price;
    if (dropDue) next.lastNotifiedDropPrice = o.price; // one message covers both
  } else if (dropDue) {
    events.push({ type: 'price_drop', price: o.price, from: ref });
    next.lastNotifiedDropPrice = o.price;
  }

  const b = o.betterOffer;
  if (a.notifyOnBetterOffer && b) {
    const same = a.betterOfferNotifiedId === b.productId;
    const lowerEnough = a.betterOfferNotifiedPrice !== null && b.delivered < a.betterOfferNotifiedPrice * (1 - BETTER_OFFER_RENOTIFY_DROP);
    if (!same || lowerEnough) {
      events.push({ type: 'better_offer', productId: b.productId, price: b.delivered });
      next.betterOfferNotifiedId = b.productId;
      next.betterOfferNotifiedPrice = b.delivered;
    }
  }
  return { events, next };
}

/** Deterministic dedupe key so repeated job runs never double-send. `day` (YYYY-MM-DD) scopes stock alerts, which can legitimately recur. */
export const alertDedupeKey = (alertId: string, e: AlertEvent, day: string): string =>
  e.type === 'better_offer' ? `find:${alertId}:better:${e.productId}:${e.price}` : e.type === 'back_in_stock' ? `find:${alertId}:stock:${day}` : `find:${alertId}:${e.type}:${e.price}`;
