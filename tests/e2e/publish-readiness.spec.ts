// Pre-publish readiness sheet, setup checklist and first-use tour. No OpenAI: the realtime
// "voice server" is a local stub that only answers /health.
// Needs a built web (npm run build -w web): the spawned server serves web/dist.
import { expect, test, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const PORT = 4860;
const BASE = `http://localhost:${PORT}`;
const VOICE_PORT = PORT + 2;
const DATA = path.resolve('data-readiness');
const SHOTS = process.env.SHOTS_DIR || 'tests/e2e/screenshots/readiness';
const CHROME = process.env.PW_CHROMIUM || `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux/chrome`;

test.use({ launchOptions: { executablePath: existsSync(CHROME) ? CHROME : undefined }, viewport: { width: 1360, height: 900 } });
test.describe.configure({ mode: 'serial' });

let server: ChildProcess | null = null;
let voice: http.Server | null = null;

test.beforeAll(async () => {
  for (const port of [PORT, PORT + 1, VOICE_PORT]) {
    if (await fetch(`http://localhost:${port}/`).then(() => true, () => false)) throw new Error(`port ${port} is already in use`);
  }
  rmSync(DATA, { recursive: true, force: true });
  mkdirSync(SHOTS, { recursive: true });
  voice = http.createServer((req, res) => {
    res.writeHead(req.url === '/health' ? 200 : 404, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => voice!.listen(VOICE_PORT, '127.0.0.1', r));
  server = spawn('npx', ['tsx', 'server/src/index.ts'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      OPENAI_API_KEY: '',
      REALTIME_BASE_URL: `http://127.0.0.1:${VOICE_PORT}/v1`,
      PORT: String(PORT),
      APP_HOST_PORT: String(PORT + 1),
      APP_HOST_URL: `http://localhost:${PORT + 1}`,
      PUBLIC_URL: BASE,
      DATA_DIR: DATA,
      BUILD_MODE: 'local',
      STRIPE_SECRET_KEY: '',
    },
  });
  server.stderr?.on('data', (d) => process.stderr.write(`[readiness-server] ${d}`));
  for (let i = 0; i < 120; i++) {
    if (await fetch(`${BASE}/api/health`).then((r) => r.ok, () => false)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('test server did not start');
});

test.afterAll(async () => {
  if (server?.pid) {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  voice?.close();
  rmSync(DATA, { recursive: true, force: true });
});

async function signIn(page: Page) {
  await page.goto(`${BASE}/`);
  const r = await page.request.post(`${BASE}/api/auth/signup`, {
    data: { name: 'Riley Researcher', email: `riley-${Date.now()}@example.com`, password: 'password123' },
    headers: { Origin: BASE },
  });
  expect(r.ok()).toBeTruthy();
}

async function createStudy(page: Page, name: string, template: 'starter' | 'blank'): Promise<string> {
  const r = await page.request.post(`${BASE}/api/studies`, { data: { name, template }, headers: { Origin: BASE } });
  expect(r.ok()).toBeTruthy();
  return (await r.json()).study.id;
}

test('first visit: tour, setup checklist, then Go live warns about the missing app', async ({ page }) => {
  await signIn(page);
  const id = await createStudy(page, 'Checkout study', 'starter');
  await page.goto(`${BASE}/studies/${id}`);

  // First-use tour points at the protocol tab first.
  const coach = page.getByTestId('coach-mark');
  await expect(coach).toBeVisible();
  await expect(coach).toContainText('Write the protocol');
  await page.screenshot({ path: `${SHOTS}/01-tour.png` });
  await page.getByTestId('coach-next').click();
  await expect(coach).toContainText('Add the app under test');
  await page.getByRole('button', { name: 'Skip tour' }).click();
  await expect(coach).toBeHidden();

  // Setup checklist: Protocol → App → Consent → Preview → Publish.
  await expect(page.getByTestId('setup-app')).toHaveAttribute('data-state', 'todo');
  await expect(page.getByTestId('setup-app')).toContainText('no app');
  await expect(page.getByTestId('setup-consent')).toHaveAttribute('data-state', 'done');
  await expect(page.getByTestId('setup-preview')).toHaveAttribute('data-state', 'todo');
  await page.screenshot({ path: `${SHOTS}/02-setup.png`, fullPage: true });

  // The tour doesn't come back on reload.
  await page.reload();
  await page.waitForTimeout(1200);
  await expect(coach).toBeHidden();

  // Go live: warnings (tasks but no app, never previewed) → "are you sure" sheet.
  await page.getByTestId('go-live').click();
  const items = page.getByTestId('readiness-items');
  await expect(items).toBeVisible();
  await expect(items).toContainText('but no app');
  await expect(items).toContainText('haven’t previewed');
  await expect(items.locator('[data-level="error"]')).toHaveCount(0);
  await expect(page.getByTestId('publish-anyway')).toBeVisible();
  await expect(page.getByTestId('readiness-preview')).toBeVisible();
  await page.waitForTimeout(600); // let the sheet finish fading in
  await page.screenshot({ path: `${SHOTS}/03-publish-warnings.png` });

  // Fix deep-links to the variants page, where the app is assigned.
  await items.getByRole('button', { name: /Assign app/ }).click();
  await expect(page).toHaveURL(new RegExp(`/studies/${id}/variants$`));

  // Publish anyway goes live.
  await page.getByTestId('go-live').click();
  await page.getByTestId('publish-anyway').click();
  await expect(page.getByText(/Study is live/)).toBeVisible();
});

test('errors block publishing: a protocol without steps', async ({ page }) => {
  await signIn(page);
  const id = await createStudy(page, 'Empty study', 'blank');
  await page.goto(`${BASE}/studies/${id}`);
  await page.getByRole('button', { name: 'Skip tour' }).click().catch(() => {});
  await page.getByTestId('go-live').click();
  const items = page.getByTestId('readiness-items');
  await expect(items.locator('[data-level="error"]').first()).toBeVisible();
  await expect(items).toContainText('no steps');
  await expect(page.getByTestId('publish-anyway')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/04-publish-blocked.png` });
});
