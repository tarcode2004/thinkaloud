import { defineConfig } from '@playwright/test';

// Shared Playwright config. Each spec starts (or reuses) the servers it needs on its own ports;
// see tests/e2e/participant.spec.ts for the participant runtime (real OpenAI realtime).
// Real OpenAI usage (realtime voice, TTS, text) is reserved for real participants.
// Tests run with the key blanked — servers they spawn inherit the empty value, which
// takes precedence over .env. Opt in explicitly with ALLOW_OPENAI_IN_TESTS=1.
if (process.env.ALLOW_OPENAI_IN_TESTS !== '1') process.env.OPENAI_API_KEY = '';

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
