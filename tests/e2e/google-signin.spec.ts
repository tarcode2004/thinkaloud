// "Sign in with Google" in the browser. The GIS script is stubbed (page.route), so Google is never
// contacted: the stub renders a stand-in button and hands the page an ID token signed by a local test
// key, which the server verifies for real (tests/e2e/googleMockServer.ts mocks only the cert fetch).
// Self-contained: API 4860 / app host 4861 / Vite 5860, DATA_DIR=./data-google. No OpenAI.
//   npx playwright test tests/e2e/google-signin.spec.ts
import { expect, test, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const API = 4860;
const WEB = 5860;
const BASE = `http://localhost:${WEB}`;
const DATA = path.resolve('data-google');
const SHOTS = process.env.SHOTS_DIR || 'tests/e2e/screenshots/google';
const CLIENT_ID = 'e2e-client.apps.googleusercontent.com';
const KID = 'e2e-kid';
const CHROME = process.env.PW_CHROMIUM || `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux/chrome`;
const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

test.use({ launchOptions: { executablePath: existsSync(CHROME) ? CHROME : undefined }, viewport: { width: 1280, height: 860 } });
test.describe.configure({ mode: 'serial' });

const procs: ChildProcess[] = [];

async function waitFor(url: string, what: string) {
  for (let i = 0; i < 160; i++) {
    if (await fetch(url).then((r) => r.ok, () => false)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${what} did not start`);
}

test.beforeAll(async () => {
  for (const port of [API, API + 1, WEB]) {
    if (await fetch(`http://localhost:${port}/`).then(() => true, () => false)) throw new Error(`port ${port} is already in use`);
  }
  rmSync(DATA, { recursive: true, force: true });
  mkdirSync(DATA, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  const certFile = path.join(DATA, 'google-test-cert.pem');
  writeFileSync(certFile, key.publicKey.export({ type: 'spki', format: 'pem' }).toString());
  const env = { ...process.env, OPENAI_API_KEY: '', DATA_DIR: DATA, BUILD_MODE: 'local' as const };
  const server = spawn('npx', ['tsx', 'tests/e2e/googleMockServer.ts'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, PORT: String(API), APP_HOST_PORT: String(API + 1), APP_HOST_URL: `http://localhost:${API + 1}`, PUBLIC_URL: BASE, GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_TEST_CERT_FILE: certFile, GOOGLE_TEST_KID: KID },
  });
  server.stderr?.on('data', (d) => process.stderr.write(`[google-server] ${d}`));
  procs.push(server);
  const web = spawn('npx', ['vite', '--port', String(WEB), '--strictPort'], { cwd: 'web', detached: true, stdio: 'ignore', env: { ...env, PORT: String(API), VITE_NO_HMR: '1' } });
  procs.push(web);
  await waitFor(`http://localhost:${API}/api/health`, 'API');
  await waitFor(`${BASE}/login`, 'Vite');
});

test.afterAll(async () => {
  for (const p of procs) {
    try {
      if (p.pid) process.kill(-p.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  await new Promise((r) => setTimeout(r, 500));
  rmSync(DATA, { recursive: true, force: true });
});

function idToken(claims: Record<string, unknown>) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'RS256', kid: KID, typ: 'JWT' });
  const body = b64({ iss: 'https://accounts.google.com', aud: CLIENT_ID, email_verified: true, iat: now, exp: now + 3600, ...claims });
  return `${head}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key.privateKey).toString('base64url')}`;
}

/** Stand-in for https://accounts.google.com/gsi/client: records options, renders a plain button. */
const GIS_STUB = `
window.__gis = { prompted: 0 };
window.google = { accounts: { id: {
  initialize(o) { window.__gis.init = o; },
  renderButton(el, o) {
    window.__gis.button = o;
    const b = document.createElement('div');
    b.setAttribute('role', 'button');
    b.dataset.testid = 'gis-stub-button';
    b.textContent = o.text === 'signup_with' ? 'Sign up with Google' : 'Sign in with Google';
    b.style.cssText = 'box-sizing:border-box;height:40px;width:' + o.width + 'px;border:1px solid #dadce0;border-radius:20px;display:flex;align-items:center;justify-content:center;font:500 14px Roboto,Arial,sans-serif;color:#3c4043;background:#fff;cursor:pointer';
    b.onclick = () => window.__gis.init.callback({ credential: window.__nextCredential, select_by: 'btn' });
    el.appendChild(b);
  },
  prompt() { window.__gis.prompted++; },
  cancel() {},
} } };`;

async function stubGis(page: Page) {
  await page.route('https://accounts.google.com/**', (route) =>
    route.request().url().startsWith('https://accounts.google.com/gsi/client')
      ? route.fulfill({ status: 200, contentType: 'text/javascript', body: GIS_STUB })
      : route.abort(),
  );
}

async function googleClick(page: Page, claims: Record<string, unknown>) {
  await page.evaluate((c) => ((window as unknown as { __nextCredential: string }).__nextCredential = c), idToken(claims));
  await page.getByTestId('gis-stub-button').click();
}

test('login and signup show Google above the email form; One Tap stays off', async ({ page }) => {
  await stubGis(page);
  await page.goto(`${BASE}/login`);
  const g = page.getByTestId('google-signin');
  await expect(page.getByTestId('gis-stub-button')).toBeVisible();
  await expect(page.getByRole('separator', { name: 'or' })).toBeVisible();
  const gBox = (await g.boundingBox())!;
  const emailBox = (await page.locator('input[name=email]').boundingBox())!;
  expect(gBox.y).toBeLessThan(emailBox.y);
  expect(Math.abs(gBox.width - emailBox.width)).toBeLessThan(2); // same column width as the fields
  const gis = await page.evaluate(() => (window as unknown as { __gis: { init: Record<string, unknown>; button: Record<string, unknown>; prompted: number } }).__gis);
  expect(gis.init.client_id).toBe(CLIENT_ID);
  expect(gis.init.auto_select).toBe(false);
  expect(gis.button).toMatchObject({ type: 'standard', theme: 'outline', size: 'large', shape: 'pill', text: 'signin_with' });
  expect(gis.prompted).toBe(0);
  await page.screenshot({ path: `${SHOTS}/login.png` });

  await page.goto(`${BASE}/signup`);
  await expect(page.getByTestId('gis-stub-button')).toHaveText('Sign up with Google');
  await page.screenshot({ path: `${SHOTS}/signup.png` });
});

test('a Google sign-up creates the account and keeps the ?plan= hand-off', async ({ page }) => {
  await stubGis(page);
  await page.goto(`${BASE}/signup?plan=starter`);
  await googleClick(page, { sub: 'e2e-new-1', email: 'ada.google@example.com', name: 'Ada Google' });
  await page.waitForURL('**/billing?start=starter');
  await page.goto(`${BASE}/studies`);
  await expect(page.getByTestId('user-menu')).toContainText('Ada Google');
  await expect(page.getByTestId('user-menu')).toContainText('ada.google@example.com');
});

test('an unverified Google email shows a plain error and does not sign in', async ({ page }) => {
  await stubGis(page);
  await page.goto(`${BASE}/login`);
  await googleClick(page, { sub: 'e2e-unverified', email: 'unverified@example.com', email_verified: false });
  await expect(page.getByTestId('google-error')).toContainText('email isn’t verified yet');
  await expect(page).toHaveURL(/\/login/);
  await page.screenshot({ path: `${SHOTS}/error.png` });
  // An expired / foreign token gets the generic line.
  await googleClick(page, { sub: 'e2e-x', email: 'x@example.com', aud: 'someone-else.apps.googleusercontent.com' });
  await expect(page.getByTestId('google-error')).toContainText('Google sign-in didn’t work');
});

test('Google sign-in links an existing email account', async ({ page, request }) => {
  const r = await request.post(`${BASE}/api/auth/signup`, { data: { name: 'Pat Password', email: 'pat@example.com', password: 'pat-password-1' }, headers: { Origin: BASE } });
  expect(r.status()).toBe(201);
  await stubGis(page);
  await page.goto(`${BASE}/login`);
  await googleClick(page, { sub: 'e2e-pat', email: 'pat@example.com', name: 'Pat From Google' });
  await page.waitForURL('**/studies');
  await expect(page.getByTestId('user-menu')).toContainText('Pat Password'); // the existing account, not a new one
});

test('no Google button when the GIS script cannot load', async ({ page }) => {
  await page.route('https://accounts.google.com/**', (route) => route.abort());
  await page.goto(`${BASE}/login`);
  await expect(page.getByText('Google sign-in isn’t available right now. Use your email instead.')).toBeVisible();
  await expect(page.locator('input[name=email]')).toBeVisible();
  await expect(page.getByRole('separator', { name: 'or' })).toHaveCount(0);
});
