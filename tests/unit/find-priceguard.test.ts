import { describe, expect, it } from 'vitest';
import { alertDedupeKey, decideAlertEvents, shouldSnapshot, summarizeHistory } from '../../packages/core/src/domain/find/priceGuard';
import type { AlertState, Snap } from '../../packages/core/src/domain/find/priceGuard';

const D = (s: string) => new Date(`${s}T12:00:00Z`);
const fmt = (m: number) => `$${(m / 100).toFixed(2)}`;

describe('snapshot decisions', () => {
  it('first observation is written; identical is not; change once per day unless forced', () => {
    const last: Snap = { at: D('2026-11-01'), price: 2000, inStock: true };
    expect(shouldSnapshot(null, { price: 2000, inStock: true }, D('2026-11-01'))).toBe(true);
    expect(shouldSnapshot(last, { price: 2000, inStock: true }, D('2026-11-03'))).toBe(false);
    expect(shouldSnapshot(last, { price: 1800, inStock: true }, D('2026-11-03'))).toBe(true);
    expect(shouldSnapshot(last, { price: 1800, inStock: true }, D('2026-11-01'))).toBe(false); // same day
    expect(shouldSnapshot(last, { price: 1800, inStock: true }, D('2026-11-01'), true)).toBe(true); // on-demand
    expect(shouldSnapshot(last, { price: 2000, inStock: true }, D('2026-11-01'), true)).toBe(false); // never identical
    expect(shouldSnapshot(last, { price: 2000, inStock: false }, D('2026-11-02'))).toBe(true); // availability change
    expect(shouldSnapshot(null, { price: 0, inStock: true }, D('2026-11-01'))).toBe(false);
  });
});

describe('history summary is honest about coverage', () => {
  it('no data -> nothing', () => {
    expect(summarizeHistory([], D('2026-11-05'), 30, fmt)).toMatchObject({ observations: 0, lowest: null, statement: null, sufficient: false });
  });
  it('a single observation is not enough', () => {
    const s = summarizeHistory([{ at: D('2026-11-04'), price: 2000, inStock: true }], D('2026-11-05'), 30, fmt);
    expect(s.sufficient).toBe(false);
    expect(s.statement).toBeNull();
  });
  it('reports the covered span, not the requested window', () => {
    const snaps: Snap[] = [{ at: D('2026-10-25'), price: 2500, inStock: true }, { at: D('2026-10-30'), price: 2000, inStock: true }, { at: D('2026-11-03'), price: 2200, inStock: true }];
    const s = summarizeHistory(snaps, D('2026-11-05'), 30, fmt);
    expect(s.lowest).toMatchObject({ price: 2000, windowDays: 11 });
    expect(s.statement).toContain('11 days we have been tracking');
    expect(s.statement).toContain('3 observations');
    expect(s.statement).not.toMatch(/30 days/);
  });
  it('uses the full window label when data covers it, and counts the price in force at window start', () => {
    const snaps: Snap[] = [{ at: D('2026-08-01'), price: 1500, inStock: true }, { at: D('2026-09-01'), price: 2500, inStock: true }, { at: D('2026-10-20'), price: 2400, inStock: true }];
    const s = summarizeHistory(snaps, D('2026-11-05'), 30, fmt);
    expect(s.lowest?.price).toBe(2400); // the 1500 price ended before the window; the 2500 price was in force when it began
    expect(s.statement).toContain('last 30 days');
  });
  it('ignores out-of-stock rows as a purchasable low and says when current is the low', () => {
    const snaps: Snap[] = [{ at: D('2026-10-20'), price: 900, inStock: false }, { at: D('2026-10-25'), price: 2000, inStock: true }, { at: D('2026-11-01'), price: 1800, inStock: true }];
    const s = summarizeHistory(snaps, D('2026-11-05'), 30, fmt);
    expect(s.lowest?.price).toBe(1800);
    expect(s.statement).toMatch(/current price is the lowest/);
  });
});

const base: AlertState = { baselinePrice: 2000, targetPrice: null, dropPercent: 10, notifyOnDrop: true, notifyOnStock: true, notifyOnBetterOffer: true, lastSeenInStock: true, lastNotifiedDropPrice: null, targetNotifiedPrice: null, betterOfferNotifiedId: null, betterOfferNotifiedPrice: null };
const apply = (a: AlertState, o: Parameters<typeof decideAlertEvents>[1]) => { const r = decideAlertEvents(a, o); return { ...r, state: { ...a, ...r.next } }; };

describe('alert decisions', () => {
  it('no event below the drop threshold, event at/above it, then deduped', () => {
    expect(decideAlertEvents(base, { price: 1850, inStock: true }).events).toEqual([]);
    const first = apply(base, { price: 1800, inStock: true });
    expect(first.events).toEqual([{ type: 'price_drop', price: 1800, from: 2000 }]);
    const again = apply(first.state, { price: 1800, inStock: true });
    expect(again.events).toEqual([]);
    expect(apply(again.state, { price: 1795, inStock: true }).events).toEqual([]); // < 1% further
    expect(apply(again.state, { price: 1700, inStock: true }).events).toEqual([{ type: 'price_drop', price: 1700, from: 1800 }]);
  });
  it('target met fires once per new low and supersedes the drop message', () => {
    const a = { ...base, targetPrice: 1500 };
    const r = apply(a, { price: 1400, inStock: true });
    expect(r.events).toEqual([{ type: 'target_met', price: 1400, target: 1500 }]);
    expect(apply(r.state, { price: 1400, inStock: true }).events).toEqual([]);
    expect(apply(r.state, { price: 1300, inStock: true }).events).toHaveLength(1);
  });
  it('a recovery above baseline re-arms alerts', () => {
    const r1 = apply(base, { price: 1700, inStock: true });
    const up = apply(r1.state, { price: 2200, inStock: true });
    expect(up.events).toEqual([]);
    expect(apply(up.state, { price: 1700, inStock: true }).events).toHaveLength(1);
  });
  it('stock alerts: only after an observed out-of-stock, once', () => {
    const oos = apply(base, { price: 2000, inStock: false });
    expect(oos.events).toEqual([]);
    expect(oos.state.lastSeenInStock).toBe(false);
    const back = apply(oos.state, { price: 2000, inStock: true });
    expect(back.events).toEqual([{ type: 'back_in_stock', price: 2000 }]);
    expect(apply(back.state, { price: 2000, inStock: true }).events).toEqual([]);
    expect(decideAlertEvents({ ...oos.state, notifyOnStock: false }, { price: 2000, inStock: true }).events).toEqual([]);
    expect(decideAlertEvents({ ...base, lastSeenInStock: null }, { price: 2000, inStock: true }).events).toEqual([]);
  });
  it('never alerts on price while out of stock, respects switches', () => {
    expect(decideAlertEvents(base, { price: 100, inStock: false }).events).toEqual([]);
    expect(decideAlertEvents({ ...base, notifyOnDrop: false }, { price: 1000, inStock: true }).events).toEqual([]);
  });
  it('better offer is announced once per offer and again only for a materially lower price', () => {
    const r = apply(base, { price: 2000, inStock: true, betterOffer: { productId: 'x', delivered: 1500 } });
    expect(r.events).toEqual([{ type: 'better_offer', productId: 'x', price: 1500 }]);
    expect(apply(r.state, { price: 2000, inStock: true, betterOffer: { productId: 'x', delivered: 1500 } }).events).toEqual([]);
    expect(apply(r.state, { price: 2000, inStock: true, betterOffer: { productId: 'x', delivered: 1490 } }).events).toEqual([]);
    expect(apply(r.state, { price: 2000, inStock: true, betterOffer: { productId: 'x', delivered: 1400 } }).events).toHaveLength(1);
    expect(apply(r.state, { price: 2000, inStock: true, betterOffer: { productId: 'y', delivered: 1600 } }).events).toHaveLength(1);
    expect(decideAlertEvents({ ...base, notifyOnBetterOffer: false }, { price: 2000, inStock: true, betterOffer: { productId: 'x', delivered: 1 } }).events).toEqual([]);
  });
  it('dedupe keys are stable per condition', () => {
    expect(alertDedupeKey('a1', { type: 'price_drop', price: 1800, from: 2000 }, '2026-11-05')).toBe(alertDedupeKey('a1', { type: 'price_drop', price: 1800, from: 1900 }, '2026-11-06'));
    expect(alertDedupeKey('a1', { type: 'back_in_stock', price: 1 }, '2026-11-05')).not.toBe(alertDedupeKey('a1', { type: 'back_in_stock', price: 1 }, '2026-11-06'));
  });
});
