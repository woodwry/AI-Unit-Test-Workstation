import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: {
    timeout: 20_000
  },
  retries: 0,
  reporter: [['line']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  }
});
