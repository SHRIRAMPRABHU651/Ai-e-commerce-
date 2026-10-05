import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const web = process.env.E2E_WEB_URL ?? 'http://localhost:3100';
// Use the pre-installed Chromium when present (CI installs its own via `playwright install chromium`).
const executablePath = process.env.PLAYWRIGHT_CHROMIUM ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: { baseURL: web, trace: 'retain-on-failure', screenshot: 'only-on-failure', launchOptions: { executablePath } },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1366, height: 800 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
  ],
});
