/**
 * Product discovery + ORVIA Find (natural-language search) + comparison.
 * Selectors verified against: catalog-view.tsx, components/find.tsx, findShared.tsx, findCompare.tsx, (store)/compare + /find pages.
 * Needs the seeded catalog (pet / kids / style products). Read-only: creates no orders.
 * NOT executed in the authoring sandbox (no MongoDB binary); runs in CI via `npm run e2e`.
 */
import { expect, test } from '@playwright/test';
import { API, HEADERS } from './support';

test.describe('discovery: search, category, product page', () => {
  test('typo-tolerant search returns real products and a result opens its product page', async ({ page }) => {
    await page.goto('/search?q=snufle');
    const card = page.locator('a[href^="/p/"]').first();
    await expect(card).toBeVisible();
    await card.click();
    await expect(page).toHaveURL(/\/p\//);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^add to cart$/i }).first()).toBeVisible();
  });

  test('a query that matches nothing shows an honest empty state, not invented products', async ({ page }) => {
    await page.goto('/search?q=zzqxjvwk-no-such-product');
    await expect(page.getByRole('heading', { name: 'No products match' })).toBeVisible();
    await expect(page.locator('a[href^="/p/"]')).toHaveCount(0);
  });

  test('category page lists products', async ({ page }) => {
    await page.goto('/c/pet');
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await expect(page.locator('a[href^="/p/"]').first()).toBeVisible();
  });
});

test.describe('ORVIA Find: natural-language search', () => {
  test('describes how the sentence was understood and lists matches with a reason', async ({ page }) => {
    await page.goto('/find');
    await expect(page.getByRole('heading', { level: 1, name: 'Find what you need' })).toBeVisible();
    // wait for hydration so the submit handler (which calls the API) is attached
    await page.waitForLoadState('networkidle');
    await page.getByRole('textbox', { name: 'Describe what you are looking for' }).fill('best value gift for my dog under $40');
    await Promise.all([
      page.waitForResponse((r) => /\/api\/v1\/find$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Find', exact: true }).click(),
    ]);
    const understood = page.getByRole('region', { name: 'How we understood your search' });
    await expect(understood).toBeVisible();
    // the engine states what it parsed (budget) instead of silently guessing
    await expect(understood.getByText(/Budget: up to/)).toBeVisible();
    // either real matches (each with an expandable "Why this matched") or the explicit empty state; never fabricated results
    const results = page.getByRole('list').filter({ has: page.getByText('Why this matched') });
    const empty = page.getByText('Nothing matched that');
    await expect(results.or(empty).first()).toBeVisible();
    if (await results.count()) {
      await results.first().getByText('Why this matched').first().click();
      await expect(results.first().locator('details[open] li').first()).toBeVisible();
    }
  });

  test('example prompts run a search and the URL carries the query', async ({ page }) => {
    await page.goto('/find');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Cheapest desk organizer' }).click();
    await expect(page.getByRole('region', { name: 'How we understood your search' })).toBeVisible();
    await expect(page).toHaveURL(/\/find\?q=Cheapest/);
  });

  test('photo search without a configured vision service says so instead of pretending', async ({ page }) => {
    // The e2e stack has no AI vision key, so the expected outcome is the explicit "not available" note. If a key is ever configured the
    // upload may legitimately succeed, so every honest outcome (note, error box or a results panel) is accepted; silence is not.
    const probe = await page.request.get(`${API}/api/v1/find/presets`);
    expect(probe.ok()).toBeTruthy();
    await page.goto('/find');
    await page.waitForLoadState('networkidle');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    await page.locator('input[type=file]').setInputFiles({ name: 'x.png', mimeType: 'image/png', buffer: png });
    const note = page.getByRole('status').filter({ hasText: 'Photo search is not available' });
    const failure = page.getByText('We could not complete that search');
    const understood = page.getByRole('region', { name: 'How we understood your search' });
    await expect(note.or(failure).or(understood).first()).toBeVisible();
  });
});

test.describe('comparison', () => {
  test('tick two Find results, open the compare tray, see a side-by-side table', async ({ page }) => {
    await page.goto('/find?q=pet');
    const understood = page.getByRole('region', { name: 'How we understood your search' });
    await expect(understood).toBeVisible();
    const toggles = page.getByRole('button', { name: 'Compare', exact: true });
    await expect(toggles.nth(1), 'need at least two Find results for "pet"').toBeVisible();
    await toggles.first().click(); // the clicked button becomes "In compare", so first() is now the next card
    await expect(page.getByRole('button', { name: 'In compare' })).toHaveCount(1);
    await toggles.first().click();
    await expect(page.getByRole('button', { name: 'In compare' })).toHaveCount(2);

    const tray = page.getByRole('region', { name: 'Compare tray' });
    await expect(tray).toContainText('2 selected');
    await tray.getByRole('link', { name: 'Compare' }).click();
    await expect(page).toHaveURL(/\/compare\?ids=[a-f0-9]{24},[a-f0-9]{24}/);

    await expect(page.getByRole('heading', { level: 1, name: 'Compare products' })).toBeVisible();
    const table = page.getByRole('table');
    await expect(table).toBeVisible();
    await expect(table.locator('thead th')).toHaveCount(3); // blank corner + 2 products
    await expect(table.locator('tbody tr').first()).toBeVisible();
    await expect(page.getByText(/All prices are in USD/)).toBeVisible();
  });

  test('compare page built from ids in the URL (ids resolved through the public API)', async ({ page, request }) => {
    const list = await request.get(`${API}/api/v1/products?pageSize=24&country=US`, { headers: HEADERS });
    const ids = ((await list.json()) as { items: { id: string; available: boolean }[] }).items.filter((x) => x.available).slice(0, 3).map((x) => x.id);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    await page.goto(`/compare?ids=${ids.join(',')}`);
    await expect(page.getByRole('table')).toBeVisible();
    await expect(page.getByRole('table').locator('thead th')).toHaveCount(ids.length + 1);
  });

  test('fewer than two products shows guidance, not a half-empty table', async ({ page }) => {
    await page.goto('/compare');
    await expect(page.getByRole('heading', { name: 'Pick 2 to 4 products to compare' })).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
  });
});
