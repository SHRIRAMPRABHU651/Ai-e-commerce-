import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'packages/**/src/**/*.test.ts', 'apps/**/src/**/*.test.ts'],
    globalSetup: ['tests/helpers/globalSetup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: false } },
    env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
  },
});
