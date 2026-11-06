/**
 * Supplier portal (apps/web/src/app/supplier/**, components/supplier-portal.tsx): SUPPLIER-role sign-in, tenant gating, mark shipped.
 * Uses the fixture from scripts/e2e-seed.ts → scripts/lib/e2e-fixtures.ts (supplier@e2e.orvia.test, MANUAL supplier "E2E Manual Supplier",
 * one CREATED shipment on order ORV-E2ESUPPL-A1B2C3). Desktop project only.
 * NOTE: ui `Field` labels are not bound to their input, so the ship form is located via the label's parent element.
 * NOT executed in the authoring sandbox (no MongoDB binary); runs in CI via `npm run e2e`.
 */
import { expect, test } from '@playwright/test';
import { SEED_PASSWORD, WEB } from './support';

test.describe.configure({ mode: 'serial' });
test.skip(({ isMobile }) => isMobile, 'desktop only');

const SUPPLIER = { email: 'supplier@e2e.orvia.test', password: SEED_PASSWORD, name: 'E2E Manual Supplier', orderNumber: 'ORV-E2ESUPPL-A1B2C3' };

test('signed-out visitors are sent to the supplier sign-in', async ({ page }) => {
  await page.goto('/supplier/orders');
  await expect(page).toHaveURL(/\/supplier\/login$/);
  await expect(page.getByRole('heading', { name: 'Supplier sign-in' })).toBeVisible();
});

test('a customer account cannot use the supplier portal', async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: WEB });
  const page = await ctx.newPage();
  await page.goto('/supplier/login');
  await page.waitForLoadState('networkidle');
  await page.locator('input[type=email]').fill('customer1@demo.orvia.test');
  await page.locator('input[type=password]').fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('This sign-in is for supplier accounts only.')).toBeVisible();
  await page.goto('/supplier');
  await expect(page).toHaveURL(/\/supplier\/login$/);
  await ctx.close();
});

test('supplier signs in, sees its dashboard, rejects a bad tracking number and marks the shipment shipped', async ({ page }) => {
  await page.goto('/supplier/login');
  await page.waitForLoadState('networkidle');
  await page.locator('input[type=email]').fill(SUPPLIER.email);
  await page.locator('input[type=password]').fill(SUPPLIER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/supplier$/);
  await expect(page.getByRole('heading', { level: 1, name: SUPPLIER.name })).toBeVisible();
  await expect(page.getByText('Orvia Supplier Portal')).toBeVisible();

  await page.getByRole('navigation', { name: 'Portal' }).getByRole('link', { name: 'Orders', exact: true }).click();
  await expect(page).toHaveURL(/\/supplier\/orders$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Orders' })).toBeVisible();
  const item = page.getByRole('listitem').filter({ hasText: SUPPLIER.orderNumber });
  await expect(item).toBeVisible();

  const field = (label: string) => item.locator(`div:has(> label:text-is("${label}")) > input`);
  // works on the first run (status CREATED → "Mark shipped") and on a CI retry (already SHIPPED → "Update tracking")
  await item.getByRole('button', { name: /^(Mark shipped|Update tracking)$/ }).click();

  // validation is enforced server-side: spaces/punctuation are refused, nothing changes
  await field('Carrier').fill('E2E Express');
  await field('Tracking number').fill('bad number!!');
  await item.getByRole('button', { name: 'Mark shipped', exact: true }).click();
  await expect(page.getByText(/Tracking number must be 5-40 letters\/digits/)).toBeVisible();

  const tracking = `E2E${Date.now()}`;
  await field('Tracking number').fill(tracking);
  await item.getByRole('button', { name: 'Mark shipped', exact: true }).click();
  await expect(page.getByText('Marked as shipped')).toBeVisible();
  await expect(item).toContainText('SHIPPED');
  await expect(item).toContainText(tracking);
  // the ship-to address is only shared while the supplier still has to ship
  await expect(item.getByText(/Ship to:/)).toHaveCount(0);
  await expect(item.getByRole('button', { name: 'Update tracking' })).toBeVisible();
});

test('supplier sign-out returns to the sign-in page and the portal is closed again', async ({ page }) => {
  await page.goto('/supplier/login');
  await page.waitForLoadState('networkidle');
  await page.locator('input[type=email]').fill(SUPPLIER.email);
  await page.locator('input[type=password]').fill(SUPPLIER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/supplier$/);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/supplier\/login$/);
  await page.goto('/supplier/orders');
  await expect(page).toHaveURL(/\/supplier\/login$/);
});
