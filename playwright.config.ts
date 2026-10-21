import { defineConfig } from '@playwright/test';

// Shared Playwright config. Each spec starts (or reuses) the servers it needs on its own ports;
// see tests/e2e/participant.spec.ts for the participant runtime (real OpenAI realtime).
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: /.*\.spec\.ts$/,
  timeout: 6 * 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    headless: true,
    viewport: { width: 1280, height: 800 },
    trace: 'off',
    screenshot: 'only-on-failure',
  },
});
