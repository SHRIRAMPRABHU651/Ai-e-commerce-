/**
 * Admin order management (apps/web/src/app/admin/(shell)/orders/page.tsx): search, status filter, order drawer, contact customer, cancel.
 * Desktop project only (the drawer/modals are exercised once; mobile admin layout is covered by responsive.spec.ts).
 * Selectors verified against: admin/login/page.tsx (#e, #p), admin/kit.tsx (SearchBox aria-label, FilterSelect aria-label), orders/page.tsx,
 * packages/ui core.tsx (Modal/Drawer are role=dialog with aria-label=title; toasts are role=status).
 * NOTE: ui `Field` labels are not bound to their input, so modal inputs are located by position inside the named dialog.
 * Orders are created through the public API (guest cart) + the dev payment simulator, so the spec needs the DEV stack.
 * NOT executed in the authoring sandbox (no MongoDB binary); runs in CI via `npm run e2e`.
 */
import { expect, test, type BrowserContext } from '@playwright/test';
import { WEB, SEED_PASSWORD, lookupStatus, placeOrderViaApi, type PlacedOrder } from './support';

test.describe.configure({ mode: 'serial' });
test.skip(({ isMobile }) => isMobile, 'desktop only');

let session: Awaited<ReturnType<BrowserContext['cookies']>> | undefined;
let paid: PlacedOrder;
let unpaid: PlacedOrder;

test.beforeAll(async () => {
  paid = await placeOrderViaApi({ pay: true });
  unpaid = await placeOrderViaApi({ pay: false });
});

test.beforeEach(async ({ page, context }) => {
  // staff login is rate limited (10/min/IP): sign in once through the UI, then reuse the cookie
  if (!session) {
    await page.goto('/admin/login');
    await page.waitForLoadState('networkidle');
    await page.fill('#e', 'owner@orvia.test');
    await page.fill('#p', SEED_PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForURL(`${WEB}/admin`);
    session = await context.cookies();
  } else {
    await context.addCookies(session);
  }
});

test('wrong staff password is rejected and shows an error without signing in', async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: WEB });
  const page = await ctx.newPage();
  await page.goto('/admin/login');
  await page.waitForLoadState('networkidle');
  await page.fill('#e', 'owner@orvia.test');
  await page.fill('#p', 'definitely-not-the-password');
  await page.click('button[type=submit]');
  await expect(page.locator('#p')).toHaveAttribute('aria-invalid', 'true');
  await expect(page).toHaveURL(/\/admin\/login/);
  await ctx.close();
});

test('search and status filter find the order; a non-matching filter shows the empty state', async ({ page }) => {
  await page.goto('/admin/orders');
  await expect(page.getByRole('heading', { level: 1, name: 'Orders' })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Order # or email' }).fill(unpaid.orderNumber);
  const row = page.getByRole('row').filter({ hasText: unpaid.orderNumber });
  await expect(row).toBeVisible();
  await expect(row).toContainText(/pending/i);

  await page.getByRole('combobox', { name: 'Status' }).selectOption({ label: 'pending payment' });
  await expect(row).toBeVisible();
  await page.getByRole('combobox', { name: 'Status' }).selectOption({ label: 'delivered' });
  await expect(page.getByRole('heading', { name: 'No orders match' })).toBeVisible();
});

test('order drawer shows items, economics, supplier orders and the audit trail; contact customer queues a message', async ({ page }) => {
  await page.goto('/admin/orders');
  await page.getByRole('searchbox', { name: 'Order # or email' }).fill(paid.orderNumber);
  await page.getByRole('row').filter({ hasText: paid.orderNumber }).click();
  const drawer = page.getByRole('dialog', { name: `Order ${paid.orderNumber}` });
  await expect(drawer).toBeVisible();
  for (const h of ['Items & economics', 'Supplier orders & tracking', 'Ship to', 'Audit trail']) await expect(drawer.getByRole('heading', { name: h })).toBeVisible();
  await expect(drawer.getByText(paid.email).first()).toBeVisible();
  // profit is not invented: either a real figure once the supplier order is placed, or the explicit placeholder
  await expect(drawer.getByText(/Known once the supplier order is placed|Contribution profit/).first()).toBeVisible();
  for (const b of ['Retry supplier order', 'Contact customer', 'Refund', 'Cancel order']) await expect(drawer.getByRole('button', { name: b, exact: true })).toBeVisible();

  await drawer.getByRole('button', { name: 'Contact customer', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Contact customer' });
  await expect(modal).toBeVisible();
  const send = modal.getByRole('button', { name: 'Send', exact: true });
  await expect(send).toBeDisabled(); // subject + message are required
  await modal.locator('input').first().fill('Your order update');
  await modal.locator('textarea').fill('Hello from the e2e suite: nothing to do on your side.');
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.getByText('Message queued')).toBeVisible();
  await expect(modal).toHaveCount(0);
});

test('cancelling an unpaid order requires a reason, records the cancellation and the customer sees it', async ({ page }) => {
  await page.goto('/admin/orders');
  await page.getByRole('searchbox', { name: 'Order # or email' }).fill(unpaid.orderNumber);
  await page.getByRole('row').filter({ hasText: unpaid.orderNumber }).click();
  const drawer = page.getByRole('dialog', { name: `Order ${unpaid.orderNumber}` });
  await drawer.getByRole('button', { name: 'Cancel order', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Cancel order' });
  await expect(modal).toBeVisible();
  const confirm = modal.getByRole('button', { name: 'Cancel & refund' });
  await expect(confirm).toBeDisabled(); // a reason of 3+ characters is mandatory
  await modal.locator('input').fill('e2e: customer asked to cancel');
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.getByText('Order cancelled')).toBeVisible();
  await expect.poll(() => lookupStatus(unpaid.orderNumber, unpaid.email), { timeout: 20_000 }).toBe('CANCELLED');
  // once cancelled, the action is no longer offered
  await expect(drawer.getByRole('button', { name: 'Cancel order', exact: true })).toHaveCount(0);
});
