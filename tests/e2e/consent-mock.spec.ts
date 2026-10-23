// Consent forms end to end, with NO OpenAI: the researcher uploads a PDF, configures participant
// fields and a typed signature, runs the consent check (the AI part is a local mock layered on the
// server's real lint), then participants read, fill, decline, are age-gated, or agree. Their info is
// stored, shown in results, exported with and without personal information.
//
//   npx playwright test tests/e2e/consent-mock.spec.ts
//
// Ports: API 4830, app host 4831, Vite 5830 (CONSENT_*_PORT to move them), DATA_DIR ./data-consent.
import { test, expect, chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const API_PORT = process.env.CONSENT_API_PORT || '4830';
const APP_PORT = process.env.CONSENT_APP_PORT || '4831';
const WEB_PORT = process.env.CONSENT_WEB_PORT || '5830';
const DATA_DIR = process.env.CONSENT_DATA_DIR || './data-consent';
const API = `http://localhost:${API_PORT}`;
const WEB = `http://localhost:${WEB_PORT}`;
const OUT = path.join(ROOT, 'tests/e2e/participant-screens');
const CHROME = path.join(os.homedir(), '.cache/ms-playwright/chromium-1234/chrome-linux/chrome');

const procs: ChildProcess[] = [];
const noOpenAI = { ...process.env, OPENAI_API_KEY: '' };
async function up(url: string) {
  try {
    return (await fetch(url)).status < 500;
  } catch {
    return false;
  }
}
async function waitUp(url: string, ms = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await up(url)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} did not come up`);
}
async function ensureServers() {
  if (!(await up(`${API}/api/health`))) {
    procs.push(
      spawn('npx', ['tsx', 'src/index.ts'], {
        cwd: path.join(ROOT, 'server'),
        env: { ...noOpenAI, PORT: API_PORT, APP_HOST_PORT: APP_PORT, APP_HOST_URL: `http://localhost:${APP_PORT}`, PUBLIC_URL: WEB, DATA_DIR, BUILD_MODE: 'local', SESSION_SECRET: 'consent-tests' },
        stdio: 'inherit',
        detached: true,
      }),
    );
    await waitUp(`${API}/api/health`);
  }
  if (!(await up(`${WEB}/`))) {
    procs.push(spawn('npx', ['vite', '--port', WEB_PORT, '--strictPort'], { cwd: path.join(ROOT, 'web'), env: { ...noOpenAI, PORT: API_PORT, VITE_NO_HMR: '1' }, stdio: 'inherit', detached: true }));
    await waitUp(`${WEB}/`);
  }
}

let cookie = '';
async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(API + url, { method, headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${text}`);
  return (text && /^[[{]/.test(text.trim()) ? JSON.parse(text) : text) as T;
}

/** A small single-page PDF (a weak consent form: no risks, no withdrawal, no AI disclosure). */
function makePdf(lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, (m) => '\\' + m);
  const content = 'BT /F1 12 Tf 72 720 Td 16 TL ' + lines.map((l) => `(${esc(l)}) Tj T*`).join(' ') + ' ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

let browser: Browser;
let studyId = '';
let token = '';
test.use({ screenshot: 'off' });
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  await ensureServers();
  await call('POST', '/api/auth/signup', { email: `consent-${Date.now()}@example.com`, password: 'password123', name: 'Dr. Rivera' });
  const { study } = await call<{ study: { id: string } }>('POST', '/api/studies', { name: 'Checkout study', template: 'starter' });
  studyId = study.id;
  token = (await call<{ links: { token: string }[] }>('GET', `/api/studies/${studyId}`)).links[0].token;
  browser = await chromium.launch({
    headless: true,
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  fs.mkdirSync(OUT, { recursive: true });
});
test.afterAll(async () => {
  await browser?.close();
  for (const p of procs) {
    try {
      process.kill(-p.pid!, 'SIGTERM');
    } catch {
      p.kill('SIGTERM');
    }
  }
});

async function newContext(opts: { researcher?: boolean; width?: number; height?: number } = {}): Promise<{ context: BrowserContext; page: Page; openaiHits: string[] }> {
  const context = await browser.newContext({ viewport: { width: opts.width ?? 1440, height: opts.height ?? 900 }, deviceScaleFactor: 2, permissions: ['microphone'] });
  if (opts.researcher) {
    const [name, value] = cookie.split('=');
    await context.addCookies([{ name, value, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
  }
  const openaiHits: string[] = [];
  await context.route('https://api.openai.com/**', (r) => (openaiHits.push(r.request().url()), r.abort('blockedbyclient')));
  const page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && console.log(`[browser:error] ${m.text()}`));
  return { context, page, openaiHits };
}

test('researcher: upload a PDF, configure fields and signature, save, run the consent check', async () => {
  const { context, page, openaiHits } = await newContext({ researcher: true });
  await page.goto(`${WEB}/studies/${studyId}/consent`);
  await expect(page.getByTestId('consent-page')).toBeVisible();
  await expect(page.getByTestId('consent-version')).toHaveText(/Not saved yet/);

  // Upload a weak PDF: its text is extracted into the editor and the live lint reacts.
  const pdf = path.join(OUT, 'weak-consent.pdf');
  fs.writeFileSync(pdf, makePdf(['ABOUT THIS STUDY', '', 'We are testing a website to find out how easy it is to use.', 'The session takes 15 minutes. All data is completely anonymous.']));
  await page.getByTestId('consent-file').setInputFiles(pdf);
  await expect(page.getByTestId('consent-text')).toHaveValue(/## About this study[\s\S]*completely anonymous/);
  await expect(page.getByTestId('consent-original')).toContainText('weak-consent.pdf');
  await expect(page.locator('[data-element=withdrawal]')).toHaveAttribute('data-status', 'missing');
  await expect(page.locator('[data-testid=consent-issue][data-key="capture:eye_tracking"]')).toBeVisible();

  // Back to the template; collect name, age, gender and a custom question; typed signature.
  await page.getByTitle('Replace the text with the ThinkAloud template').click();
  await expect(page.locator('[data-element=withdrawal]')).toHaveAttribute('data-status', 'ok');
  for (const id of ['full_name', 'age', 'gender']) await page.locator(`[data-testid=builtin-${id}] [role=switch]`).click();
  await expect(page.locator('[data-testid=consent-issue][data-key="field:full_name"]')).toBeVisible();
  const text = page.getByTestId('consent-text');
  await text.fill((await text.inputValue()).replace('## Questions', 'We will also ask for your name, your age and your gender, and how often you shop online.\n\n## Questions'));
  await expect(page.locator('[data-testid=consent-issue][data-key="field:full_name"]')).toHaveCount(0);
  await page.getByTestId('add-field').click();
  await page.getByRole('button', { name: 'Single choice' }).click();
  await page.getByTestId('custom-label').fill('How often do you shop online?');
  const opts = page.locator('[data-testid^=custom-cf_] input[placeholder=Option]');
  await opts.nth(0).fill('Every week');
  await opts.nth(1).fill('Every month');
  await page.getByRole('button', { name: 'Add option' }).click();
  await opts.nth(2).fill('Rarely or never');
  await page.getByRole('button', { name: 'Typed name' }).click();
  await page.getByRole('switch', { name: 'Show this form to participants' }).click();
  await page.getByTestId('save-consent').click();
  await expect(page.getByTestId('consent-version')).toHaveText(/Version 2/);
  await expect(page.getByTestId('save-consent')).toHaveText('Saved');
  await page.locator('[data-testid^=custom-cf_] button[aria-expanded]').click(); // collapse for the screenshot
  await page.waitForTimeout(4500); // let toasts fade
  await page.getByTestId('consent-text').evaluate((el) => (el.scrollTop = 0));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(OUT, 'consent-editor.png') });
  await page.getByRole('heading', { name: 'About the participant' }).scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -24));
  await page.screenshot({ path: path.join(OUT, 'consent-editor-fields.png') });

  // The consent check: the server's real lint + a MOCKED AI layer (no OpenAI key, no network).
  await page.route('**/api/studies/*/consent/check', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.ai = 'ok';
    body.issues.push(
      { key: 'ai:0', source: 'ai', category: 'other', element: 'compensation', severity: 'medium', message: 'The payment amount isn’t stated', explanation: 'Participants should know what they will receive before they agree, not look it up elsewhere.', quote: 'You will receive the payment described in the study listing.', suggestion: 'You will receive £10 for taking part. You will be paid even if you stop early.' },
      { key: 'ai:1', source: 'ai', category: 'other', element: 'storage', severity: 'low', message: 'Say where the data is stored', explanation: '“Our servers” is vague. Name the country or region, which matters for data-protection rules.', quote: 'We keep your data private and store it securely on our servers.', suggestion: 'We keep your data private and store it securely on servers in the EU.' },
    );
    await route.fulfill({ response: res, json: body });
  });
  await page.getByTestId('run-ai-check').click();
  await expect(page.locator('[data-testid=ai-result] [data-source=ai]')).toHaveCount(2);
  await page.locator('[data-testid=ai-result] [data-key="ai:0"]').getByRole('button', { name: 'Replace in document' }).click();
  await expect(page.getByTestId('consent-text')).toHaveValue(/You will receive £10 for taking part/);
  await page.getByTestId('save-consent').click();
  await expect(page.getByTestId('consent-version')).toHaveText(/Version 3/);
  await page.waitForTimeout(4500); // let toasts fade
  const panel = page.getByTestId('consent-page').locator('aside > div');
  await panel.evaluate((el) => ((el as HTMLElement).style.maxHeight = 'none')); // capture the whole panel
  await panel.screenshot({ path: path.join(OUT, 'consent-check.png') });
  expect(openaiHits).toEqual([]);
  await context.close();
  await call('PATCH', `/api/studies/${studyId}`, { status: 'live' });
});

const sessionCount = async () => (await call<{ sessions: unknown[] }>('GET', `/api/studies/${studyId}/sessions`)).sessions.length;

async function openConsent(page: Page) {
  await page.goto(`${WEB}/s/${token}`);
  await page.getByTestId('get-started').click();
  await expect(page.getByTestId('consent')).toHaveAttribute('data-consent-form', '3');
}
async function readToEnd(page: Page) {
  await page.getByTestId('consent-doc').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect(page.getByTestId('read-status')).toHaveText('Read to the end');
}

test('participant: reads, fixes validation errors, signs; info and signature are stored', async () => {
  const { context, page, openaiHits } = await newContext({ width: 1280, height: 900 });
  await openConsent(page);
  await page.screenshot({ path: path.join(OUT, 'consent-participant.png') });

  // Agreeing before reading to the end is refused.
  await page.getByTestId('accept-consent').click();
  await expect(page.getByTestId('consent-error')).toHaveText(/read the information to the end/);
  await readToEnd(page);

  // Empty required answers: accessible errors, focus moves to the first one.
  await page.getByTestId('accept-consent').click();
  await expect(page.getByTestId('consent-error')).toHaveText(/answers need your attention/);
  await expect(page.locator('#pf-full_name')).toBeFocused();
  await expect(page.locator('#pf-full_name')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#err-full_name')).toHaveText(/Please enter your full name/);
  await expect(page.locator('#pf-signature')).toHaveAttribute('aria-invalid', 'true');
  await page.locator('[data-testid=field-full_name]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, 'consent-participant-errors.png'), fullPage: true });

  await page.locator('#pf-full_name').fill('Ada Lovelace');
  await page.locator('#pf-age').fill('36');
  await page.locator('[data-testid=field-gender] label', { hasText: 'Prefer to self-describe' }).click();
  await page.getByTestId('other-gender').fill('Genderfluid');
  await page.locator('[data-testid^=field-cf_] label', { hasText: 'Every month' }).click();
  await page.getByTestId('opt-age').count().then((n) => expect(n).toBe(0)); // age is collected, so no separate 18+ switch
  await page.getByTestId('sig-name').fill('Ada Lovelace');
  // The uploaded original stays downloadable (through the API wrapper, as a blob).
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download-original').click()]);
  expect(dl.suggestedFilename()).toBe('weak-consent.pdf');
  await page.getByTestId('accept-consent').click();
  await expect(page.getByTestId('device-check')).toBeVisible({ timeout: 20_000 });

  const { sessions, participantFields } = await call<{ sessions: { id: string; participantInfo: Record<string, unknown>; consent: Record<string, any> }[]; participantFields: { id: string; column: string }[] }>('GET', `/api/studies/${studyId}/sessions`);
  expect(sessions).toHaveLength(1);
  const cf = participantFields.find((f) => f.id.startsWith('cf_'))!;
  expect(sessions[0].participantInfo).toEqual({ full_name: 'Ada Lovelace', age: 36, gender: 'Genderfluid', [cf.id]: 'Every month' });
  expect(sessions[0].consent.formVersion).toBe(3);
  expect(sessions[0].consent.formHash).toMatch(/^[0-9a-f]{64}$/);
  expect(sessions[0].consent.signature).toMatchObject({ mode: 'typed_name', name: 'Ada Lovelace', agreed: true });
  expect(openaiHits).toEqual([]);
  await context.close();
});

test('participant: under the minimum age is stopped politely; declining stores nothing', async () => {
  const before = await sessionCount();
  const { context, page } = await newContext({ width: 1280, height: 900 });
  await openConsent(page);
  await readToEnd(page);
  await page.locator('#pf-full_name').fill('Young Person');
  await page.locator('#pf-age').fill('15');
  await page.locator('[data-testid^=field-cf_] label', { hasText: 'Rarely or never' }).click();
  await page.getByTestId('sig-name').fill('Young Person');
  await page.getByTestId('accept-consent').click();
  await expect(page.getByTestId('under-age')).toContainText('aged 18 and over');
  await page.screenshot({ path: path.join(OUT, 'consent-under-age.png') });

  await openConsent(page);
  await page.getByTestId('decline-consent').click();
  await expect(page.getByTestId('declined')).toContainText('nothing was recorded');
  await page.screenshot({ path: path.join(OUT, 'consent-declined.png') });
  expect(await sessionCount()).toBe(before);
  await context.close();
});

test('researcher: participant info in sessions, detail and demographics; export with and without personal information', async () => {
  const { context, page } = await newContext({ researcher: true });
  await page.goto(`${WEB}/studies/${studyId}/results/sessions`);
  await expect(page.getByText('Ada Lovelace').first()).toBeVisible();
  await page.screenshot({ path: path.join(OUT, 'consent-sessions-list.png') });
  await page.getByText('Ada Lovelace').first().click();
  await page.waitForURL(/\/results\/sessions\/ses/);
  const panel = page.getByRole('heading', { name: 'Participant', exact: true });
  await expect(panel).toBeVisible();
  await expect(page.getByText('Genderfluid').first()).toBeVisible();
  await panel.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -40));
  await page.screenshot({ path: path.join(OUT, 'consent-session-detail.png') });
  await page.goto(`${WEB}/studies/${studyId}/results/participants`);
  await expect(page.getByText('How often do you shop online?').first()).toBeVisible();
  await page.screenshot({ path: path.join(OUT, 'consent-demographics.png') });
  await context.close();

  const csv = await call<string>('GET', `/api/studies/${studyId}/export?table=sessions&format=csv`);
  expect(csv).toContain('info.full_name');
  expect(csv).toContain('Ada Lovelace');
  const safe = await call<Record<string, unknown>[]>('GET', `/api/studies/${studyId}/export?table=sessions&format=json&excludePii=1`);
  expect(JSON.stringify(safe)).not.toContain('Ada Lovelace');
  expect(safe[0]['info.age']).toBe(36);
  expect(safe[0]['info.gender']).toBe('Genderfluid');
});
