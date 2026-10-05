import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Order, Product, Shipment, Supplier, SupplierOffer, ExceptionModel } from '@orvia/database';
import { financials, parseRange, compareSuppliers } from '@orvia/core';
import { closeCtx, testCtx } from '../helpers/ctx';
import { runSeed } from '../../scripts/lib/seed';
import type { Ctx } from '@orvia/core';

let ctx: Ctx;
beforeAll(async () => {
  ctx = await testCtx('seed');
}, 120_000);
afterAll(closeCtx);

describe('seed through real domain flows', () => {
  it('imports, prices, publishes, takes orders and fulfils them', async () => {
    const logs: string[] = [];
    const res = await runSeed(ctx, { orders: 12, log: (m) => logs.push(m) });
    console.log(logs.join('\n'));
    expect(res.published).toBeGreaterThan(25);
    const banned = await Product.find({ state: 'BANNED' }).select('title compliance').lean();
    expect(banned.map((b) => b.title).join('|')).toMatch(/Knife/);
    expect(banned.length).toBe(3);
    const held = await Product.find({ state: 'DRAFT' }).select('title').lean();
    expect(held.map((h) => h.title).join('|')).toMatch(/Teething/); // kids product w/o safety info is NOT auto published
    const orders = await Order.find({}).lean();
    expect(orders.length).toBeGreaterThan(5);
    const ships = await Shipment.find({}).lean();
    expect(ships.length).toBeGreaterThanOrEqual(orders.length);
    // no duplicate supplier orders per (order,line)
    const keys = ships.map((s) => `${s.orderId}:${s.lineKey}`);
    expect(new Set(keys).size).toBe(keys.length);
    const f = await financials(ctx, parseRange('90d'));
    expect(f.netRevenue).toBeGreaterThan(0);
    expect(f.contributionProfit).toBeLessThan(f.netRevenue);
    const open = await ExceptionModel.find({ status: 'open' }).select('kind issue').lean();
    console.log('open exceptions:', open.map((e) => `${e.kind}: ${e.issue}`));
    expect(await Supplier.countDocuments()).toBe(4);
    expect(await SupplierOffer.countDocuments()).toBeGreaterThan(100);
    const p = await Product.findOne({ state: 'PUBLISHED' }).lean();
    const cmp = await compareSuppliers(ctx, String(p!._id), 'US');
    expect(cmp.rows.length).toBeGreaterThanOrEqual(3);
    console.log(cmp.rows.map((r) => `${r.supplierCode} landed=${r.landedCost} profit=${r.expectedProfit} cx=${r.cxScore} score=${r.finalScore} ${r.eligible ? '' : r.ineligibleReason}`), cmp.recommendation);
  }, 240_000);
});
