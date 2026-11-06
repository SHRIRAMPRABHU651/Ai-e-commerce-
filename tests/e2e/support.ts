/**
 * Shared helpers for the browser specs. NOT a spec file (does not match *.spec.ts).
 * Everything here talks to the DEV stack started by scripts/e2e.mjs (mock payment provider + mock suppliers, /dev/* endpoints).
 * None of it can run against production: the /dev routes are not registered there.
 */
import { expect, request as pwRequest, type APIRequestContext, type Page } from '@playwright/test';

export const API = process.env.E2E_API_URL ?? 'http://localhost:4300';
export const WEB = process.env.E2E_WEB_URL ?? 'http://localhost:3100';
export const SEED_PASSWORD = 'Orvia-Demo-2026!';
export const HEADERS = { 'x-requested-with': 'orvia', origin: WEB };
export const STRONG_PASSWORD = 'E2e-Passw0rd-2026';

/** Staff API session (separate cookie jar from any shopper). Cached per worker: /auth/* is rate limited to 10 requests/minute/IP. */
let staffCtx: Promise<APIRequestContext> | undefined;
export function staffApi(): Promise<APIRequestContext> {
  staffCtx ??= (async () => {
    const ctx = await pwRequest.newContext();
    const login = await ctx.post(`${API}/api/v1/auth/admin/login`, { headers: HEADERS, data: { email: 'owner@orvia.test', password: SEED_PASSWORD } });
    expect(login.ok(), `staff login failed: ${login.status()}`).toBeTruthy();
    return ctx;
  })();
  return staffCtx;
}

/** Fills the checkout form (ids verified in apps/web/src/app/(store)/checkout/page.tsx). US only: the default seeded market. */
export async function fillCheckout(page: Page, email: string) {
  await page.fill('#email', email);
  await page.fill('#fullName', 'Taylor Tester');
  await page.fill('#line1', '1 Market Street');
  await page.fill('#city', 'San Francisco');
  await page.selectOption('#region', 'CA');
  await page.fill('#postalCode', '94105');
  await page.fill('#phone', '4155550100');
}

export interface PlacedOrder { orderNumber: string; orderId: string; email: string; intentId: string }

/**
 * Creates an order through the public API with its own cookie jar (guest cart): add to cart → checkout. Optionally pays via the
 * dev payment simulator, which delivers a signed webhook exactly like a real provider would.
 */
export async function placeOrderViaApi(opts: { pay?: boolean; email?: string } = {}): Promise<PlacedOrder> {
  const ctx = await pwRequest.newContext();
  try {
    const list = await ctx.get(`${API}/api/v1/products?pageSize=48&country=US`);
    const items = ((await list.json()) as { items: { slug: string; id: string; available: boolean }[] }).items;
    const p = items.find((x) => x.available);
    expect(p, 'seeded catalog has an available product').toBeTruthy();
    const detail = (await (await ctx.get(`${API}/api/v1/products/${p!.slug}?country=US`)).json()) as { variants: { sku: string }[] };
    const add = await ctx.post(`${API}/api/v1/cart/items?country=US`, { headers: HEADERS, data: { productId: p!.id, variantSku: detail.variants[0]!.sku, quantity: 1 } });
    expect(add.ok(), `add to cart: ${add.status()}`).toBeTruthy();
    const email = opts.email ?? `e2e-api+${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.com`;
    const co = await ctx.post(`${API}/api/v1/checkout`, {
      headers: HEADERS,
      data: {
        email, shippingMethod: 'standard', idempotencyKey: `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        address: { fullName: 'API Buyer', line1: '1 Market Street', city: 'San Francisco', region: 'CA', postalCode: '94105', country: 'US', phone: '4155550100' },
      },
    });
    expect(co.status(), `checkout: ${await co.text()}`).toBe(201);
    const body = (await co.json()) as { order: { id: string; orderNumber: string }; payment: { intentId: string } };
    if (opts.pay) {
      const sim = await ctx.post(`${API}/api/v1/dev/payments/${body.payment.intentId}/simulate`, { headers: HEADERS, data: { outcome: 'succeeded' } });
      expect(sim.ok(), `simulate payment: ${sim.status()}`).toBeTruthy();
    }
    return { orderNumber: body.order.orderNumber, orderId: body.order.id, email, intentId: body.payment.intentId };
  } finally {
    await ctx.dispose();
  }
}

/** Public order lookup (order number + the email on the order), as the /track page does. */
export async function lookupStatus(orderNumber: string, email: string): Promise<string | undefined> {
  const ctx = await pwRequest.newContext();
  try {
    const r = await ctx.get(`${API}/api/v1/orders/lookup?orderNumber=${encodeURIComponent(orderNumber)}&email=${encodeURIComponent(email)}`);
    return ((await r.json()) as { status?: string }).status;
  } finally {
    await ctx.dispose();
  }
}

/** Mock suppliers advance in accelerated time (MOCK_TIME_SCALE); a staff tracking sync moves the order forward. Polls until it reaches `target`. */
export async function waitForStatus(orderNumber: string, email: string, target: string, timeout = 70_000) {
  const staff = await staffApi();
  await expect
    .poll(async () => {
      await staff.post(`${API}/api/v1/admin/shipping/sync`, { headers: HEADERS, data: {} });
      return lookupStatus(orderNumber, email);
    }, { timeout, intervals: [2000], message: `order ${orderNumber} should reach ${target}` })
    .toBe(target);
}
