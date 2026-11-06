import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Order, User } from '@orvia/database';
import type { Ctx } from '@orvia/core';
import { closeCtx, testCtx } from '../helpers/ctx';
import { startApi } from '../helpers/client';
import type { Client } from '../helpers/client';
import { placeOrder } from '../helpers/shop';
import { runSeed } from '../../scripts/lib/seed';

/**
 * NOT executed in the authoring sandbox (needs MongoDB).
 * Registration signs the user in before the email is verified, so an unverified account must not see, export or act on
 * guest records that merely share its email address (docs/ORVIA_SECURITY_AND_PRIVACY.md, finding SEC-01/02).
 */
let ctx: Ctx; let mk: (h?: Record<string, string>) => Client;
beforeAll(async () => {
  ctx = await testCtx('ownership-verified-email');
  await runSeed(ctx, { withHistory: false });
  mk = (await startApi(ctx)).client;
}, 240_000);
afterAll(closeCtx);

describe('guest records are reachable by email only after the email is verified', () => {
  it('hides a guest order from an unverified account with the same email, then shows it once verified', async () => {
    const email = `guest${Date.now()}@example.com`;
    const guest = mk();
    const { co } = await placeOrder(guest, { email });
    expect(co.status).toBe(201);
    const orderNumber = co.body.order.orderNumber as string;

    const attacker = mk();
    const reg = await attacker.post('/api/v1/auth/register', { email, password: 'Sup3rSecretPass', name: 'Not The Owner' });
    expect(reg.status).toBe(201);

    // unverified: no access through any email-keyed path
    expect((await attacker.get('/api/v1/account/orders')).body.items).toHaveLength(0);
    expect((await attacker.get(`/api/v1/aftersales/orders/${orderNumber}/eligibility`)).status).toBe(403);
    const exportBefore = await attacker.get('/api/v1/account/privacy/export');
    expect(exportBefore.status).toBe(200);
    expect(exportBefore.body.orders).toHaveLength(0);
    expect((await attacker.get('/api/v1/account/products')).body.items ?? []).toHaveLength(0);

    // once the address is verified the same account may see it
    await User.updateOne({ email }, { $set: { emailVerified: true } });
    expect((await attacker.get('/api/v1/account/orders')).body.items.map((o: { orderNumber: string }) => o.orderNumber)).toContain(orderNumber);
    const exportAfter = await attacker.get('/api/v1/account/privacy/export');
    expect(exportAfter.body.orders.map((o: { orderNumber: string }) => o.orderNumber)).toContain(orderNumber);
    expect(await Order.countDocuments({ orderNumber })).toBe(1);
  });

  it('rate limits guest order cancellation attempts', async () => {
    const c = mk({ 'x-forwarded-for': '203.0.113.77' });
    let limited = false;
    for (let i = 0; i < 14 && !limited; i++) {
      const r = await c.post('/api/v1/orders/ORV-0000-000000/cancel', { email: 'nobody@example.com' });
      if (r.status === 429) limited = true;
    }
    expect(limited).toBe(true);
  });
});
