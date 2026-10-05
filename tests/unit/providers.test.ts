import { createHmac } from 'node:crypto';
import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { CjDropshippingProvider, MemoryMockStore, MockSupplierProvider, MOCK_PROFILES, SupplierRegistry, fetchLiveOffer } from '@orvia/suppliers';
import { MockPaymentProvider, PaymentRegistry, RazorpayPaymentProvider, StripePaymentProvider, WebhookSignatureError } from '@orvia/payments';
import { DEFAULT_AD_RULES, MetaAdsProvider, PartialCreationError, enforceSpendCaps, evaluateCampaign, evaluateTest, rankCreatives, AdsRegistry, MockAdProvider } from '@orvia/ads';
import { NotificationRouter, renderTemplate } from '@orvia/notifications';
import { MemoryKVStore } from '@orvia/config';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const dest = { fullName: 'A', line1: '1 Main St', line2: '', city: 'SF', region: 'CA', postalCode: '94102', country: 'US' as const, phone: '' };

describe('mock supplier', () => {
  const p = (code = 'mock-nova-us', opts = {}) => new MockSupplierProvider(MOCK_PROFILES.find((m) => m.code === code)!, new MemoryMockStore(), { timeScale: 86_400, ...opts });
  it('is idempotent: the same key can never create two supplier orders', async () => {
    const s = p();
    const a = await s.createOrder({ idempotencyKey: 'k1', orderRef: 'O1', externalId: 'pet-snuffle-mat', sku: 'x', quantity: 1, destination: dest });
    const b = await s.createOrder({ idempotencyKey: 'k1', orderRef: 'O1', externalId: 'pet-snuffle-mat', sku: 'x', quantity: 1, destination: dest });
    expect(b.supplierOrderId).toBe(a.supplierOrderId);
    const c = await s.createOrder({ idempotencyKey: 'k2', orderRef: 'O2', externalId: 'pet-snuffle-mat', sku: 'x', quantity: 1, destination: dest });
    expect(c.supplierOrderId).not.toBe(a.supplierOrderId);
  });
  it('quotes per destination in local currency and refuses unsupported routes', async () => {
    expect((await p().getPrice('pet-snuffle-mat', 'CA')).currency).toBe('CAD');
    expect((await p().getShippingQuote('pet-snuffle-mat', 'IN', 1)).available).toBe(false);
    await expect(p().createOrder({ idempotencyKey: 'z', orderRef: 'O', externalId: 'pet-snuffle-mat', sku: 'x', quantity: 1, destination: { ...dest, country: 'IN' } })).rejects.toThrow(/does not ship/);
    const live = await fetchLiveOffer(p(), 'pet-snuffle-mat', 'US');
    expect(live.productCost).toBeGreaterThan(0);
    expect(live.warehouseCountry).toBe('US');
  });
  it('tracking is empty (available:false) until shipped — never fabricated', async () => {
    const s = p('mock-nova-us', { timeScale: 1 });
    const o = await s.createOrder({ idempotencyKey: 'k9', orderRef: 'O', externalId: 'pet-snuffle-mat', sku: 'x', quantity: 1, destination: dest });
    const t = await s.getTracking(o.supplierOrderId);
    expect(t.available).toBe(false);
    expect(t.trackingNumber).toBeUndefined();
    expect((await s.cancelOrder(o.supplierOrderId)).cancelled).toBe(true);
  });
  it('injects faults and refuses out-of-stock orders', async () => {
    const s = p();
    await s.setFault({ remaining: 1, kind: 'http500' });
    await expect(s.getInventory('pet-snuffle-mat')).rejects.toThrow(/injected fault/);
    expect((await s.getInventory('pet-snuffle-mat')).total).toBeGreaterThan(0);
    await s.setOverride('pet-snuffle-mat', { stock: 0 });
    await expect(s.createOrder({ idempotencyKey: 'oos', orderRef: 'O', externalId: 'pet-snuffle-mat', sku: 'x', quantity: 1, destination: dest })).rejects.toThrow(/Out of stock/);
  });
  it('registry refuses mock adapters in production or live mode and unknown providers', () => {
    const store = new MemoryMockStore();
    expect(() => new SupplierRegistry({ mode: 'live', isProduction: false }, store).resolve({ provider: 'mock', code: 'mock-nova-us' })).toThrow(/disabled/);
    expect(() => new SupplierRegistry({ mode: 'mock', isProduction: true }, store).resolve({ provider: 'mock', code: 'mock-nova-us' })).toThrow(/disabled/);
    expect(() => new SupplierRegistry({ mode: 'live', isProduction: true }, store).resolve({ provider: 'cj', code: 'cj' })).toThrow(/CJ_API_KEY/);
    expect(() => new SupplierRegistry({ mode: 'live', isProduction: true }, store).resolve({ provider: 'nope', code: 'n' })).toThrow(/No adapter/);
  });
});

describe('CJ Dropshipping adapter (mocked HTTP)', () => {
  it('authenticates once, maps products, and sends the idempotency key as the order number', async () => {
    const calls: { url: string; body?: any; headers?: any }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body as string) : undefined, headers: init.headers });
      if (url.endsWith('/authentication/getAccessToken')) return json({ code: 200, result: true, data: { accessToken: 'tok', accessTokenExpiryDate: new Date(Date.now() + 1e8).toISOString() } });
      if (url.includes('/product/list')) return json({ code: 200, data: { list: [{ pid: 'P1', productNameEn: 'Mat', sellPrice: '4.50', productImage: 'http://i/1.jpg', categoryName: 'Pet' }], total: 1 } });
      if (url.includes('/shopping/order/createOrderV2')) return json({ code: 200, data: { orderId: 'CJ123' } });
      if (url.includes('/shopping/order/getOrderDetail')) return json({ code: 200, data: { orderStatus: 'CREATED', productAmount: 4.5, postageAmount: 2 } });
      return json({ code: 404, message: 'nf', data: null });
    }) as unknown as typeof fetch;
    const cj = new CjDropshippingProvider('key', { fetchImpl: f });
    const r = await cj.searchProducts({ query: 'mat' });
    expect(r.items[0]).toMatchObject({ externalId: 'P1', title: 'Mat', baseCostUsd: 450 });
    const o = await cj.createOrder({ idempotencyKey: 'ship:abc', orderRef: 'ORV-1', externalId: 'P1', sku: 'V1', quantity: 1, destination: dest });
    expect(o.supplierOrderId).toBe('CJ123');
    expect(calls.find((c) => c.url.includes('createOrderV2'))!.body.orderNumber).toBe('ship:abc');
    expect(calls.filter((c) => c.url.endsWith('getAccessToken'))).toHaveLength(1);
    expect((calls.find((c) => c.url.includes('/product/list'))!.headers as Record<string, string>)['CJ-Access-Token']).toBe('tok');
  });
  it('does not retry order creation on 5xx (the queue retries with the same idempotency key)', async () => {
    let creates = 0;
    const f = (async (url: string) => {
      if (url.endsWith('/getAccessToken')) return json({ code: 200, data: { accessToken: 't' } });
      creates++;
      return json({ message: 'boom' }, 503);
    }) as unknown as typeof fetch;
    await expect(new CjDropshippingProvider('k', { fetchImpl: f }).createOrder({ idempotencyKey: 'k', orderRef: 'o', externalId: 'P', sku: 'V', quantity: 1, destination: dest })).rejects.toMatchObject({ retryable: true });
    expect(creates).toBe(1);
  });
});

describe('payment providers', () => {
  it('mock: signed webhooks verify; tampered or stale ones are rejected', async () => {
    const m = new MockPaymentProvider('s3cret', new MemoryKVStore());
    const pay = await m.createPayment({ orderId: 'o', orderNumber: 'N', amount: 1000, currency: 'USD', email: 'a@b.c', idempotencyKey: 'idem' });
    const again = await m.createPayment({ orderId: 'o', orderNumber: 'N', amount: 1000, currency: 'USD', email: 'a@b.c', idempotencyKey: 'idem' });
    expect(again.intentId).toBe(pay.intentId);
    const sim = await m.simulate(pay.intentId, 'succeeded');
    expect(m.verifyWebhook(sim.body, sim.headers).type).toBe('payment.succeeded');
    expect(() => m.verifyWebhook(sim.body.replace('1000', '1'), sim.headers)).toThrow(WebhookSignatureError);
    expect(() => m.verifyWebhook(sim.body, { 'x-mock-signature': 't=1,v1=00' })).toThrow(WebhookSignatureError);
    expect((await m.refund({ intentId: pay.intentId, amount: 5, currency: 'USD', idempotencyKey: 'r1' })).refundId).toBe((await m.refund({ intentId: pay.intentId, amount: 5, currency: 'USD', idempotencyKey: 'r1' })).refundId);
  });
  it('stripe: verifies real Stripe signatures via the official SDK and ignores unrelated events', () => {
    const secret = 'whsec_test_secret';
    const sp = new StripePaymentProvider('sk_test_x', secret);
    const payload = JSON.stringify({ id: 'evt_1', object: 'event', type: 'payment_intent.succeeded', data: { object: { id: 'pi_1', amount: 2000, amount_received: 2000, currency: 'usd', latest_charge: 'ch_1' } } });
    const header = new Stripe('sk_test_x').webhooks.generateTestHeaderString({ payload, secret });
    const e = sp.verifyWebhook(payload, { 'stripe-signature': header });
    expect(e).toMatchObject({ id: 'evt_1', type: 'payment.succeeded', intentId: 'pi_1', amount: 2000, currency: 'USD' });
    expect(() => sp.verifyWebhook(payload, { 'stripe-signature': header.replace(/v1=\w+/, 'v1=bad') })).toThrow(WebhookSignatureError);
    expect(() => sp.verifyWebhook(payload, {})).toThrow(WebhookSignatureError);
    const other = JSON.stringify({ id: 'evt_2', object: 'event', type: 'customer.created', data: { object: { id: 'cus_1' } } });
    expect(sp.verifyWebhook(other, { 'stripe-signature': new Stripe('sk_test_x').webhooks.generateTestHeaderString({ payload: other, secret }) }).type).toBe('ignored');
  });
  it('razorpay: HMAC-SHA256 verification, INR only, server-side status lookup', async () => {
    const secret = 'rzp_whsec';
    const f = (async (url: string) => (url.includes('/payments') ? json({ items: [{ id: 'pay_1', status: 'captured', amount: 99900, currency: 'INR' }] }) : json({ id: 'order_1' }))) as unknown as typeof fetch;
    const rp = new RazorpayPaymentProvider('rzp_id', 'rzp_secret', secret, f);
    const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1', amount: 99900, currency: 'INR', status: 'captured' } } } });
    const sig = createHmac('sha256', secret).update(body).digest('hex');
    expect(rp.verifyWebhook(body, { 'x-razorpay-signature': sig, 'x-razorpay-event-id': 'e1' })).toMatchObject({ type: 'payment.succeeded', intentId: 'order_1', id: 'e1' });
    expect(() => rp.verifyWebhook(body, { 'x-razorpay-signature': '00'.repeat(32) })).toThrow(WebhookSignatureError);
    expect((await rp.getPayment('order_1')).status).toBe('succeeded');
    await expect(rp.createPayment({ orderId: 'o', orderNumber: 'N', amount: 1, currency: 'USD', email: 'a@b.c', idempotencyKey: 'k' })).rejects.toThrow(/INR/);
    expect((await rp.createPayment({ orderId: 'o', orderNumber: 'N', amount: 99900, currency: 'INR', email: 'a@b.c', idempotencyKey: 'k' })).intentId).toBe('order_1');
  });
  it('registry: live mode without credentials is an error, never a silent mock', () => {
    const r = new PaymentRegistry({ mode: 'live', isProduction: true, mockSecret: 'x' }, new MemoryKVStore());
    expect(() => r.forCountry(['stripe'])).toThrow(/No configured payment provider/);
    expect(() => new PaymentRegistry({ mode: 'mock', isProduction: true, mockSecret: 'x' }, new MemoryKVStore()).forCountry(['stripe'])).toThrow(/forbidden in production/);
  });
});

describe('ad budget rules (safe mode)', () => {
  const w = { impressions: 5000, clicks: 100, spend: 4000, purchases: 4, revenue: 16000, profit: 3000, refundRate: 0.03 };
  const head = { dailyRemaining: 10_000, monthlyRemaining: 200_000 };
  it('pauses spend with zero purchases, negative profit and when limits are hit', () => {
    expect(evaluateCampaign({ ...w, purchases: 0, revenue: 0, profit: -4000 }, 1000, DEFAULT_AD_RULES, head).action).toBe('PAUSE');
    expect(evaluateCampaign({ ...w, profit: -500 }, 1000, DEFAULT_AD_RULES, head).action).toBe('PAUSE');
    expect(evaluateCampaign(w, 1000, DEFAULT_AD_RULES, { dailyRemaining: 0, monthlyRemaining: 1 }).action).toBe('PAUSE');
  });
  it('does not judge insufficient samples', () => {
    const d = evaluateCampaign({ impressions: 200, clicks: 3, spend: 300, purchases: 0, revenue: 0, profit: -300, refundRate: 0 }, 1000, DEFAULT_AD_RULES, head);
    expect(d.action).toBe('MAINTAIN');
    expect(d.sufficientData).toBe(false);
  });
  it('reduces on high CPA / refund rate; scales profitable campaigns by at most 20% inside caps', () => {
    expect(evaluateCampaign({ ...w, purchases: 1, revenue: 4000, spend: 4000, profit: 500 }, 1000, DEFAULT_AD_RULES, head).action).toBe('REDUCE');
    expect(evaluateCampaign({ ...w, refundRate: 0.2 }, 1000, DEFAULT_AD_RULES, head).action).toBe('REDUCE');
    expect(evaluateCampaign({ ...w, refundRate: 0.5 }, 1000, DEFAULT_AD_RULES, head).action).toBe('PAUSE');
    const s = evaluateCampaign({ ...w, purchases: 8, spend: 3000, revenue: 12_000, profit: 4000 }, 1000, { ...DEFAULT_AD_RULES, scaleStep: 0.9 }, head);
    expect(s.action).toBe('SCALE');
    expect(s.newDailyBudget).toBe(1200); // safe mode caps the step at +20%
    const capped = evaluateCampaign({ ...w, purchases: 8, spend: 3000, revenue: 12_000, profit: 4000 }, 4900, DEFAULT_AD_RULES, head);
    expect(capped.newDailyBudget).toBeLessThanOrEqual(DEFAULT_AD_RULES.maxDailyBudget);
  });
  it('enforces global daily and monthly limits proportionally', () => {
    const out = enforceSpendCaps([{ id: 'a', dailyBudget: 3000 }, { id: 'b', dailyBudget: 1000 }], { dailyLimit: 2000, monthlyLimit: 100_000, monthSpentSoFar: 0, daysLeftInMonth: 20 });
    expect(out.reduce((a, b) => a + b.dailyBudget, 0)).toBeLessThanOrEqual(2000);
    const month = enforceSpendCaps([{ id: 'a', dailyBudget: 3000 }], { dailyLimit: 20_000, monthlyLimit: 10_000, monthSpentSoFar: 9_000, daysLeftInMonth: 10 });
    expect(month[0]!.dailyBudget).toBeLessThanOrEqual(100);
  });
  it('product tests: never kill on insufficient data; WIN/KILL once sample is met', () => {
    const c = { minImpressions: 1500, minClicks: 30, minSpend: 3000, targetCpa: 1500, targetRoas: 2.5 };
    expect(evaluateTest({ impressions: 400, clicks: 5, spend: 500, purchases: 0, revenue: 0, profit: -500 }, c).verdict).toBe('CONTINUE');
    expect(evaluateTest({ impressions: 4000, clicks: 80, spend: 3500, purchases: 0, revenue: 0, profit: -3500 }, c).verdict).toBe('KILL');
    expect(evaluateTest({ impressions: 4000, clicks: 80, spend: 3500, purchases: 4, revenue: 12_000, profit: 2000 }, c).verdict).toBe('WIN');
  });
  it('ranks creatives and only crowns winners with a sufficient sample', () => {
    const r = rankCreatives([
      { creativeId: 'a', impressions: 2000, clicks: 60, spend: 800, purchases: 5, revenue: 4000 },
      { creativeId: 'b', impressions: 2000, clicks: 20, spend: 800, purchases: 0, revenue: 0 },
      { creativeId: 'c', impressions: 100, clicks: 10, spend: 50, purchases: 1, revenue: 900 },
    ], { minImpressions: 800, minSpend: 500, targetRoas: 2.5 });
    expect(r.find((x) => x.creativeId === 'a')!.status).toBe('winner');
    expect(r.find((x) => x.creativeId === 'b')!.status).toBe('loser');
    expect(r.find((x) => x.creativeId === 'c')!.status).toBe('testing');
  });
});

describe('ad platform adapters', () => {
  it('Meta: creates everything PAUSED and reports partial failure honestly (cleans up, never claims success)', async () => {
    const seen: { url: string; body: any }[] = [];
    let n = 0;
    const f = (async (url: string, init: RequestInit) => {
      const body = init.body ? JSON.parse(init.body as string) : undefined;
      seen.push({ url, body });
      if (url.endsWith('/adcreatives')) return json({ error: { message: 'bad creative' } }, 400);
      return json({ id: `id${++n}` });
    }) as unknown as typeof fetch;
    const meta = new MetaAdsProvider({ accessToken: 't', adAccountId: '123', pageId: 'pg', fetchImpl: f });
    await expect(meta.createCampaign({ name: 'c', country: 'US', currency: 'USD', objective: 'sales', dailyBudget: 1000, landingUrl: 'http://x', audience: {}, creatives: [{ id: 'cr1', concept: 'ugc', headline: 'h', primaryText: 'p', description: 'd', cta: 'Shop now' }] })).rejects.toBeInstanceOf(PartialCreationError);
    expect(seen[0]!.body.status).toBe('PAUSED');
    expect(seen[1]!.body.status).toBe('PAUSED');
    expect(seen[seen.length - 1]!.body).toEqual({ status: 'PAUSED' }); // best-effort cleanup of the half-built campaign
  });
  it('Meta: parses insights into metric rows', async () => {
    const f = (async () => json({ data: [{ date_start: '2026-10-01', impressions: '1000', clicks: '20', spend: '12.50', actions: [{ action_type: 'purchase', value: '2' }], action_values: [{ action_type: 'purchase', value: '60' }] }] })) as unknown as typeof fetch;
    const rows = await new MetaAdsProvider({ accessToken: 't', adAccountId: 'act_1', fetchImpl: f }).getMetrics(['c1'], { from: '2026-10-01', to: '2026-10-02' });
    expect(rows[0]).toMatchObject({ impressions: 1000, clicks: 20, spend: 1250, purchases: 2, revenue: 6000 });
  });
  it('registry: live mode without credentials errors (no fake ad launch)', () => {
    const r = new AdsRegistry({ mode: 'live', isProduction: true }, new MemoryKVStore());
    expect(() => r.get('meta')).toThrow(/not configured/);
    expect(() => r.get('google')).toThrow(/not configured/);
    expect(() => new AdsRegistry({ mode: 'mock', isProduction: true }, new MemoryKVStore()).get('meta')).toThrow(/forbidden/);
  });
  it('mock ad network produces no metrics before activation', async () => {
    const m = new MockAdProvider(new MemoryKVStore());
    const c = await m.createCampaign({ name: 'c', country: 'US', currency: 'USD', objective: 'sales', dailyBudget: 1000, landingUrl: 'x', audience: {}, creatives: [] });
    expect(await m.getMetrics([c.externalId], { from: '2020-01-01', to: '2099-01-01' })).toEqual([]);
  });
});

describe('notifications', () => {
  it('log provider is dev-only, live mode without credentials is unavailable (never faked)', () => {
    expect(new NotificationRouter({ mode: 'log', isProduction: false, emailFrom: 'x' }).providerFor('email')?.key).toBe('log');
    expect(new NotificationRouter({ mode: 'log', isProduction: true, emailFrom: 'x' }).providerFor('email')).toBeNull();
    expect(new NotificationRouter({ mode: 'live', isProduction: true, emailFrom: 'x' }).providerFor('email')).toBeNull();
    expect(new NotificationRouter({ mode: 'live', isProduction: true, emailFrom: 'x', emailKey: 'k' }).providerFor('email')?.key).toBe('resend');
    expect(new NotificationRouter({ mode: 'live', isProduction: true, emailFrom: 'x', twilio: { sid: 'a', token: 'b', from: 'c' } }).providerFor('whatsapp')?.key).toBe('twilio');
  });
  it('renders templates', () => {
    const t = renderTemplate('shipped', { name: 'Ava Lee', orderNumber: 'ORV-1', trackingNumber: 'TRK1', carrier: 'USPS', url: 'http://x' });
    expect(t.subject).toContain('ORV-1');
    expect(t.body).toContain('TRK1');
    expect(t.html).toContain('Track order');
  });
});
