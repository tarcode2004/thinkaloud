// SaaS billing in the browser: pricing on the landing page, sign-up → checkout hand-off, the
// Billing page, go-live gating and the neutral participant message.
// Self-contained: starts its own server on 4840/4841 with DATA_DIR=./data-billing (built web/dist
// served by the API). Stripe is never called: Checkout is intercepted in the browser, webhooks
// are signed locally with generateTestHeaderString, and the usage reporter is off. No OpenAI.
//   npm run build -w web && npx playwright test tests/e2e/billing.spec.ts
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import http from 'node:http';
import Stripe from 'stripe';

const PORT = 4840;
const BASE = `http://localhost:${PORT}`;
const DATA = path.resolve('data-billing');
const SHOTS = process.env.SHOTS_DIR || 'tests/e2e/screenshots/billing';
const WHSEC = 'whsec_e2e_billing';
const CHROME = process.env.PW_CHROMIUM || `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux/chrome`;

test.use({ launchOptions: { executablePath: existsSync(CHROME) ? CHROME : undefined }, viewport: { width: 1360, height: 900 } });
test.describe.configure({ mode: 'serial' });

let server: ChildProcess | null = null;
// Go live checks the realtime voice service: a stub that only answers /health (no OpenAI).
const VOICE_PORT = 4842;
const voice = http.createServer((req, res) => res.writeHead(req.url === '/health' ? 200 : 404).end());

test.beforeAll(async () => {
  for (const port of [PORT, PORT + 1]) {
    if (await fetch(`http://localhost:${port}/`).then(() => true, () => false)) throw new Error(`port ${port} is already in use`);
  }
  rmSync(DATA, { recursive: true, force: true });
  mkdirSync(SHOTS, { recursive: true });
  await new Promise<void>((r) => voice.listen(VOICE_PORT, '127.0.0.1', r));
  server = spawn('npx', ['tsx', 'server/src/index.ts'], {
    detached: true, // own process group, so afterAll stops tsx too (not just npx)
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
      STRIPE_SECRET_KEY: 'sk_test_e2e_never_used',
      STRIPE_WEBHOOK_SECRET: WHSEC,
      STRIPE_PRICE_STARTER_BASE: 'price_e2e_base_s',
      STRIPE_PRICE_STARTER_METERED: 'price_e2e_meter_s',
      STRIPE_PRICE_TEAM_BASE: 'price_e2e_base_t',
      STRIPE_PRICE_TEAM_METERED: 'price_e2e_meter_t',
      BILLING_REPORTER: 'off',
    },
  });
  server.stderr?.on('data', (d) => process.stderr.write(`[billing-server] ${d}`));
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('billing test server did not start');
});

test.afterAll(async () => {
  voice.close();
  if (server?.pid) {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  rmSync(DATA, { recursive: true, force: true });
});

let seq = 0;
async function stripeEvent(request: APIRequestContext, type: string, object: unknown) {
  const payload = JSON.stringify({ id: `evt_e2e_${Date.now()}_${++seq}`, object: 'event', type, created: Math.floor(Date.now() / 1000) + seq, data: { object } });
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC });
  const r = await request.post(`${BASE}/api/billing/webhook`, { data: payload, headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature } });
  expect(r.status()).toBe(200);
}

function subscription(userId: string, status: string) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: 'sub_e2e', object: 'subscription', customer: 'cus_e2e', status, metadata: { user_id: userId, plan: 'starter' }, cancel_at_period_end: false,
    trial_end: status === 'trialing' ? now + 14 * 86400 : null,
    items: { data: [{ price: { id: 'price_e2e_base_s' }, current_period_start: now - 86400 * 9, current_period_end: now + 86400 * 21 }] },
  };
}

const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};

test('pricing, sign-up to checkout, gating, and the neutral participant message', async ({ page, browser, request }) => {
  // Landing: pricing comes from GET /api/billing/plans.
  await page.goto(`${BASE}/`);
  const pricing = page.getByTestId('pricing');
  await expect(pricing).toBeVisible();
  await expect(pricing.getByText('Starter', { exact: true })).toBeVisible();
  await expect(pricing.getByText('Team', { exact: true })).toBeVisible();
  await pricing.scrollIntoViewIfNeeded();
  await shot(page, '01-landing-pricing');

  // Sign up from a plan: the next stop is Checkout. Stripe itself is never contacted.
  let checkoutBody: unknown = null;
  await page.route('**/api/billing/checkout', async (route) => {
    checkoutBody = route.request().postDataJSON();
    await route.fulfill({ json: { url: `${BASE}/billing?checkout=canceled` } });
  });
  await pricing.getByRole('link', { name: 'Start free trial' }).first().click();
  await expect(page).toHaveURL(/\/signup\?plan=starter/);
  await expect(page.getByTestId('signup-plan')).toContainText('Starter');
  await shot(page, '02-signup-with-plan');
  await page.locator('input[name=name]').fill('Grace Billing');
  await page.locator('input[name=email]').fill(`b${Date.now()}@example.com`);
  await page.locator('input[name=password]').fill('password123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/billing\?checkout=canceled/);
  expect(checkoutBody).toEqual({ planId: 'starter' });
  await expect(page.getByText('Checkout canceled')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Choose a plan' })).toBeVisible();
  await expect(page.getByTestId('plan-starter')).toBeVisible();
  await shot(page, '03-billing-no-plan');

  const me = await (await page.request.get(`${BASE}/api/auth/me`)).json();
  const userId = me.user.id as string;

  // Building works without a plan; going live sends you to Billing.
  const created = await page.request.post(`${BASE}/api/studies`, { data: { name: 'Pricing page test', template: 'starter' } });
  const studyId = (await created.json()).study.id as string;
  await page.goto(`${BASE}/studies/${studyId}`);
  await expect(page.getByTestId('plan-banner')).toBeVisible();
  await shot(page, '04-study-with-plan-banner');
  await page.getByTestId('go-live').click();
  await page.getByTestId('publish-anyway').click(); // readiness warnings: no app, not previewed
  await expect(page).toHaveURL(/\/billing$/);

  // Subscription starts (signed webhook) → trial.
  await stripeEvent(request, 'customer.subscription.created', subscription(userId, 'trialing'));
  await page.reload();
  await expect(page.getByTestId('billing-status')).toHaveText('Free trial');
  await expect(page.getByTestId('usage-meter')).toContainText('0 of 30 trial minutes');
  await expect(page.getByTestId('plan-banner')).toHaveCount(0);
  await shot(page, '05-billing-trial');

  await page.goto(`${BASE}/studies/${studyId}`);
  await page.getByTestId('go-live').click();
  await page.getByTestId('publish-anyway').click();
  await expect(page.getByText('Study is live. Share your link from Recruit.')).toBeVisible();
  const detail = await (await page.request.get(`${BASE}/api/studies/${studyId}`)).json();
  const linkUrl = `${BASE}/s/${detail.links[0].token}`;

  // Active with usage over the included minutes: tabular meter, overage estimate.
  await stripeEvent(request, 'customer.subscription.updated', subscription(userId, 'active'));
  const db = new DatabaseSync(path.join(DATA, 'thinkaloud.db'));
  db.prepare("UPDATE billing_accounts SET stripe_customer_id = 'cus_e2e' WHERE user_id = ?").run(userId);
  db.prepare("INSERT INTO usage_events (id, user_id, session_id, kind, quantity, at, reported_at) VALUES ('use_e2e1', ?, 'ses_e2e1', 'voice_minutes', 342, ?, ?)").run(userId, Date.now() - 3600_000, Date.now());
  db.close();
  await page.goto(`${BASE}/billing`);
  await expect(page.getByTestId('billing-status')).toHaveText('Active');
  const meter = page.getByTestId('usage-meter');
  await expect(meter).toContainText('342 of 300 included minutes');
  await expect(page.getByText('Estimated total this period')).toBeVisible();
  await expect(page.getByText('$59.50')).toBeVisible(); // placeholder: $49 + 42 × $0.25
  await shot(page, '06-billing-active-overage');

  // Participants see the study normally…
  const participant = await browser.newContext();
  const p = await participant.newPage();
  await p.goto(linkUrl);
  await expect(p.getByTestId('unavailable')).toHaveCount(0);

  // …and after cancellation, a neutral message with no billing details.
  await stripeEvent(request, 'customer.subscription.deleted', subscription(userId, 'canceled'));
  await p.goto(linkUrl);
  await expect(p.getByTestId('unavailable')).toContainText('This study isn’t accepting participants right now.');
  await expect(p.locator('body')).not.toContainText(/billing|subscription|payment|plan\b|stripe/i);
  await p.screenshot({ path: `${SHOTS}/07-participant-unavailable.png`, fullPage: true });
  await participant.close();

  await page.goto(`${BASE}/billing`);
  await expect(page.getByRole('heading', { name: 'Choose a plan' })).toBeVisible();
  await expect(page.getByTestId('plan-starter').getByRole('button', { name: 'Subscribe' })).toBeVisible(); // trial is once per account
});
