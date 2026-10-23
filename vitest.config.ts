import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'packages/**/src/**/*.test.ts', 'apps/**/src/**/*.test.ts'],
    globalSetup: ['tests/helpers/globalSetup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
    env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
    coverage: {
      provider: 'v8',
      include: ['packages/core/src/**/*.ts'],
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: 'coverage',
      // Floors for the domain core; enforced by `npm run test:coverage` (and therefore by CI / production-check).
      thresholds: { lines: 80, branches: 70 },
    },
  },
});
