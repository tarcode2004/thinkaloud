// Full real-world loop through the actual UI, against the PRODUCTION build:
//   researcher signs up → creates a study → uploads examples/demo-shop.zip (Docker build) →
//   generates the protocol with AI (real OpenAI) → adds a url_matches rule → assigns the app →
//   copies the link → goes live → a participant runs a full voice session (real gpt-realtime,
//   fake mic speech) against the HOSTED demo shop → researcher reviews results, replay, audio,
//   transcript, heatmaps, synthesis → A/B with a second variant/protocol and two more
//   participants → CSV export → cross-account access checks and app-host path traversal.
//
//   npm run build && npx playwright test tests/e2e/fullloop.spec.ts
//
// Ports: API + SPA 4700, app host 4701. Data: ./data-fullloop (wiped at start).
import { test, expect, chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ensureFixtures, clipPath, FAKE_MIC, type ClipName } from './participant.fixtures.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const PORT = 4700;
const APP_PORT = 4701;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(ROOT, 'data-fullloop');
const SHOTS = path.join(ROOT, 'tests/e2e/screenshots/fullloop');
// FULLLOOP_RESUME=1 keeps ./data-fullloop and skips the setup + first participant (debugging the later steps).
const RESUME = process.env.FULLLOOP_RESUME === '1';
const STATE = path.join(DATA, 'fullloop-state.json');
const CHROME = `${os.homedir()}/.cache/ms-playwright/chromium-1234/chrome-linux/chrome`;

for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}

test.describe.configure({ mode: 'serial' });

// ── server ───────────────────────────────────────────────────────────────────
let server: ChildProcess | null = null;
async function waitUp(url: string, ms = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`${url} did not come up`);
}
async function startServer() {
  if (!fs.existsSync(path.join(ROOT, 'web/dist/index.html')) || !fs.existsSync(path.join(ROOT, 'probe/dist/probe.js'))) {
    const r = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) throw new Error('npm run build failed');
  }
  for (const port of [PORT, APP_PORT]) {
    const busy = await fetch(`http://localhost:${port}/`).then(() => true, () => false);
    if (busy) throw new Error(`Port ${port} is already in use (stale server?). Stop it first.`);
  }
  if (!RESUME) fs.rmSync(DATA, { recursive: true, force: true });
  const logFile = fs.createWriteStream(path.join(ROOT, 'test-results/fullloop-server.log'));
  server = spawn('npx', ['tsx', '--env-file-if-exists=../.env', 'src/index.ts'], {
    cwd: path.join(ROOT, 'server'),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(PORT),
      APP_HOST_PORT: String(APP_PORT),
      PUBLIC_URL: BASE,
      APP_HOST_URL: `http://localhost:${APP_PORT}`,
      DATA_DIR: './data-fullloop',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // own process group: npx → tsx → node are all stopped in afterAll
  });
  server.stdout?.pipe(logFile);
  server.stderr?.pipe(logFile);
  await waitUp(`${BASE}/api/health`);
  await waitUp(`http://localhost:${APP_PORT}/__thinkaloud/health`);
}

// ── helpers ──────────────────────────────────────────────────────────────────
async function shot(page: Page, name: string, fullPage = false) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage });
}

/** Mixes on-demand speech clips into the (fake) microphone stream. Top frame only. */
const MIC_HOOK = () => {
  if (window.top !== window) return;
  const md = navigator.mediaDevices;
  const orig = md.getUserMedia.bind(md);
  let ctx: AudioContext | null = null;
  let dest: MediaStreamAudioDestinationNode | null = null;
  md.getUserMedia = async (c?: MediaStreamConstraints) => {
    const s = await orig(c);
    if (!c?.audio) return s;
    ctx = ctx ?? new AudioContext();
    dest = dest ?? ctx.createMediaStreamDestination();
    ctx.createMediaStreamSource(s).connect(dest);
    return new MediaStream([...dest.stream.getAudioTracks(), ...s.getVideoTracks()]);
  };
  (window as unknown as { __taSpeak: (b64: string) => Promise<number> }).__taSpeak = async (b64: string) => {
    if (!ctx || !dest) throw new Error('mic not started');
    await ctx.resume();
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const buf = await ctx.decodeAudioData(bytes.buffer);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(dest);
    src.start();
    await new Promise((r) => (src.onended = r));
    return buf.duration;
  };
};

async function speak(page: Page, clip: ClipName) {
  const b64 = fs.readFileSync(clipPath(clip)).toString('base64');
  return page.evaluate((b) => (window as unknown as { __taSpeak: (b: string) => Promise<number> }).__taSpeak(b), b64);
}

type LogEvent = { kind: string; t: number; stepId?: string; data: Record<string, unknown> };
const runnerLog = (page: Page) => page.evaluate(() => ((window as unknown as { __taRunner?: { queue: { log: unknown[] } } }).__taRunner?.queue.log ?? []) as LogEvent[]);

interface Snap {
  index: number;
  total: number;
  stepId: string | null;
  type: string | null;
  phase: string | null;
  orb: string;
  pending: string | null;
  ended: boolean;
  card: null | { kind: string; stepId: string; activeQuestionId?: string; submitted?: boolean; questions: { id: string; kind: string; required?: boolean }[] };
  answers: string[];
}
const snap = (page: Page) =>
  page.evaluate(() => {
    const r = (window as unknown as { __taRunner?: { snapshot: Record<string, any> } }).__taRunner;
    if (!r) return null;
    const s = r.snapshot;
    return {
      index: s.index,
      total: s.total,
      stepId: s.step?.id ?? null,
      type: s.step?.type ?? null,
      phase: s.taskPhase,
      orb: s.orb,
      pending: s.pendingAction,
      ended: s.ended,
      card: s.card ? { kind: s.card.kind, stepId: s.card.stepId, activeQuestionId: s.card.activeQuestionId, submitted: s.card.submitted, questions: s.card.questions.map((q: any) => ({ id: q.id, kind: q.kind, required: q.required })) } : null,
      answers: Object.keys(s.answers),
    } as Snap;
  });

/** True once the moderator has been quiet (listening) for `quietMs`, or after `ms`. */
async function waitModeratorIdle(page: Page, quietMs = 1500, ms = 45_000) {
  const t0 = Date.now();
  let since = 0;
  while (Date.now() - t0 < ms) {
    if (await page.getByTestId('done').isVisible().catch(() => false)) return true;
    const orb = await page.getAttribute('[data-testid=session]', 'data-orb').catch(() => null);
    if (orb === 'listening' || orb === 'muted') {
      if (!since) since = Date.now();
      if (Date.now() - since >= quietMs) return true;
    } else since = 0;
    await page.waitForTimeout(150);
  }
  return false;
}

/** Answer whatever card is on screen by clicking (rating: a middle-high value, choice: first option). */
async function answerCardOnScreen(page: Page) {
  const qc = page.getByTestId('questionnaire-card');
  if (await qc.isVisible().catch(() => false)) {
    for (const li of await qc.locator('li[data-qid]').all()) {
      const radios = li.locator('[role=radio]');
      const n = await radios.count();
      if (n) {
        if ((await li.locator('[role=radio][aria-checked=true]').count()) === 0) await radios.nth(Math.min(n - 1, Math.floor(n * 0.7))).click();
        continue;
      }
      const ta = li.locator('textarea');
      if (await ta.count()) {
        await ta.fill('It was mostly clear.');
        await li.getByRole('button', { name: /Save answer|Update answer/ }).click();
        continue;
      }
      const range = li.locator('input[type=range]');
      if (await range.count()) {
        await range.fill('70');
        continue;
      }
      const btn = li.locator('button').first();
      if (await btn.count()) await btn.click();
    }
    await qc.getByRole('button', { name: 'Submit' }).click();
    return 'questionnaire';
  }
  const card = page.getByTestId('question-card');
  if (!(await card.isVisible().catch(() => false))) return null;
  const radios = card.locator('[role=radio]');
  const n = await radios.count();
  if (n) {
    await radios.nth(Math.min(n - 1, Math.floor(n * 0.7))).click();
    return 'rating';
  }
  const range = card.locator('input[type=range]');
  if (await range.count()) {
    await range.fill('70');
    return 'range';
  }
  const opt = card.locator('button').first();
  if (await opt.count()) {
    await opt.click();
    return 'choice';
  }
  return 'open';
}

/** Drive the demo shop like a participant: Pet-friendly → a plant → add to basket → basket. */
async function shopFlow(page: Page) {
  const app = page.frameLocator('[data-testid=app-frame]');
  await app.locator('nav.nav').getByRole('link', { name: 'Pet-friendly' }).click();
  await page.waitForTimeout(1500);
  await app.getByTestId('product-calathea').click();
  await page.waitForTimeout(1500);
  await app.getByTestId('add-to-cart').click();
  await page.waitForTimeout(1200);
  await app.getByTestId('cart-link').click();
  await page.waitForTimeout(800);
}

/**
 * Generic voice-session driver: reacts to whatever step the (AI-generated) protocol is on.
 * Returns the participant's server session id.
 */
async function driveSession(page: Page, label: string, opts: { maxMs?: number } = {}) {
  const t0 = Date.now();
  const maxMs = opts.maxMs ?? 14 * 60_000;
  const shopped = new Set<string>();
  const acted = new Map<string, number>(); // state key → times we acted
  const shots = new Set<string>();
  let lastKey = '';
  let lastActAt = 0;
  while (!(await page.getByTestId('done').isVisible().catch(() => false))) {
    if (Date.now() - t0 > maxMs) {
      const kinds = (await runnerLog(page)).map((e) => `${e.kind}${e.kind.startsWith('transcript') ? `: ${String(e.data.text).slice(0, 90)}` : e.kind === 'moderator.tool' ? `:${String(e.data.name)}${e.data.error ? `(${e.data.error})` : ''}` : ''}`);
      throw new Error(`[${label}] session did not finish. Log:\n${kinds.slice(-60).join('\n')}`);
    }
    const s = await snap(page);
    if (!s || s.ended) {
      await page.waitForTimeout(500);
      continue;
    }
    const key = `${s.index}|${s.phase ?? ''}|${s.card?.activeQuestionId ?? ''}|${s.answers.length}|${s.card?.submitted ? 1 : 0}`;
    if (key !== lastKey) {
      lastKey = key;
      const shotKey = `${s.type ?? (s.index < 0 ? 'intro' : 'closing')}-${s.phase ?? ''}`;
      if (!shots.has(shotKey)) {
        shots.add(shotKey);
        await shot(page, `${label}-s${String(s.index + 1).padStart(2, '0')}-${shotKey}`, false);
      }
    }
    // Task active: interact with the hosted app (once per task).
    if (s.type === 'task' && s.phase === 'active' && !shopped.has(s.stepId!)) {
      shopped.add(s.stepId!);
      await waitModeratorIdle(page, 800, 20_000);
      const talk = speak(page, 'think_shop');
      await shopFlow(page);
      await talk;
      await shot(page, `${label}-task-${s.stepId}-app`, false);
      lastActAt = Date.now();
      continue;
    }
    const idle = await waitModeratorIdle(page, 1500, 30_000);
    const s2 = await snap(page);
    if (!s2 || s2.ended) continue;
    const key2 = `${s2.index}|${s2.phase ?? ''}|${s2.card?.activeQuestionId ?? ''}|${s2.answers.length}|${s2.card?.submitted ? 1 : 0}`;
    if (key2 !== key) continue; // something changed while waiting: re-evaluate
    const n = acted.get(key) ?? 0;
    // After acting, give the moderator time to react before acting again on the same state.
    if (n > 0 && Date.now() - lastActAt < (idle ? 12_000 : 25_000)) {
      await page.waitForTimeout(500);
      continue;
    }
    acted.set(key, n + 1);
    lastActAt = Date.now();
    if (s2.index < 0) await speak(page, 'ready');
    else if (s2.index >= s2.total) await page.waitForTimeout(1000);
    else if (s2.type === 'task') {
      // Let the moderator read the task first (a real participant listens); only nudge if it stalls.
      if (s2.phase === 'briefing') {
        if (n > 0) await speak(page, 'ready');
      }
      else if (s2.phase === 'active') {
        if (n === 0) await speak(page, 'went_ok');
        else if (n === 1) await page.getByTestId('im-done').click();
        else if (s2.pending === 'done') await speak(page, 'went_ok');
        else await page.getByTestId('skip-task').click();
      } else {
        // post-task: SEQ card / researcher probes
        const done = s2.card && !s2.answers.includes(`${s2.card.stepId}::${s2.card.activeQuestionId ?? s2.card.questions[0]?.id}`) ? await answerCardOnScreen(page) : null;
        if (!done || done === 'open') await speak(page, n % 2 ? 'went_ok' : 'probe_answer');
      }
    } else if (s2.type === 'instruction') await speak(page, n % 2 ? 'ready' : 'explore');
    else if (s2.type === 'question' || s2.type === 'questionnaire') {
      const done = s2.card && !s2.card.submitted ? await answerCardOnScreen(page) : null;
      if (!done || done === 'open') await speak(page, 'interview');
    } else await speak(page, n % 2 ? 'probe_answer' : 'interview'); // interview
  }
  await shot(page, `${label}-done`);
  return page.evaluate(() => (window as unknown as { __taRunner?: { opts: { start: { session: { id: string } } } } }).__taRunner?.opts.start.session.id ?? null);
}

/** Landing → consent → device check → session; then drive it to the end. */
async function runParticipant(browser: Browser, link: string, label: string) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['microphone', 'camera'] });
  await context.addInitScript(MIC_HOOK);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(link);
  await expect(page.getByTestId('landing')).toBeVisible();
  await shot(page, `${label}-01-landing`);
  await page.getByTestId('get-started').click();
  await expect(page.getByTestId('consent')).toBeVisible();
  if (await page.getByTestId('opt-age').isVisible().catch(() => false)) await page.getByTestId('opt-age').click();
  await shot(page, `${label}-02-consent`);
  await page.getByTestId('accept-consent').click();
  await expect(page.getByTestId('device-check')).toBeVisible();
  await expect(page.getByTestId('mic-meter')).toBeVisible();
  await page.waitForFunction(() => (window as unknown as { __taSpeak?: unknown }).__taSpeak && navigator.mediaDevices).catch(() => {});
  await page.waitForTimeout(800); // getUserMedia resolves after the meter renders
  await speak(page, 'mic_check');
  await expect(page.getByText('We can hear you.')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('play-chime').click();
  await page.getByTestId('heard-chime').click();
  await shot(page, `${label}-03-device-check`);
  await page.getByTestId('device-continue').click();
  await expect(page.getByTestId('session')).toBeVisible();
  const sid = await driveSession(page, label);
  const log = await runnerLog(page).catch(() => []);
  fs.writeFileSync(
    path.join(SHOTS, `${label}-conversation.txt`),
    log
      .filter((e) => ['transcript.moderator', 'transcript.participant', 'moderator.tool', 'step.enter', 'task.start', 'task.end', 'answer', 'moderator.nudge', 'moderator.probe'].includes(e.kind))
      .map((e) => `${(e.t / 1000).toFixed(1).padStart(6)}s ${e.kind.padEnd(22)} ${e.kind.startsWith('transcript') ? e.data.text : JSON.stringify(e.data)}`)
      .join('\n'),
  );
  await context.close();
  return { sid, errors };
}

// ── shared state ─────────────────────────────────────────────────────────────
let browser: Browser;
let rctx: BrowserContext;
let rp: Page;
let email = `fullloop-${Date.now()}@example.com`;
let studyId = '';
let appId = '';
let appUrl = '';
let link = '';
let sessionIds: string[] = [];
const saveState = () => fs.writeFileSync(STATE, JSON.stringify({ email, studyId, appId, appUrl, link, sessionIds }));

test.beforeAll(async () => {
  test.setTimeout(10 * 60_000);
  fs.mkdirSync(path.join(ROOT, 'test-results'), { recursive: true });
  if (!RESUME) fs.rmSync(SHOTS, { recursive: true, force: true });
  await ensureFixtures();
  await startServer();
  browser = await chromium.launch({
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${FAKE_MIC}`, '--autoplay-policy=no-user-gesture-required'],
  });
  rctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await rctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  rp = await rctx.newPage();
  rp.on('pageerror', (e) => console.log('[researcher pageerror]', e.message));
  if (RESUME) {
    ({ email, studyId, appId, appUrl, link, sessionIds } = JSON.parse(fs.readFileSync(STATE, 'utf8')));
    expect((await rp.request.post(`${BASE}/api/auth/login`, { data: { email, password: 'password123' } })).ok()).toBe(true);
    await rp.goto(`${BASE}/studies/${studyId}`);
  }
});

test.afterAll(async () => {
  await browser?.close();
  if (server?.pid) {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
});

test('researcher: sign up, create study, upload the demo shop and wait for Ready', async () => {
  test.skip(RESUME, 'resumed from saved state');
  test.setTimeout(8 * 60_000);
  await rp.goto(`${BASE}/signup`);
  await rp.locator('input[name=name]').fill('Ada Researcher');
  await rp.locator('input[name=email]').fill(email);
  await rp.locator('input[name=password]').fill('password123');
  await rp.getByRole('button', { name: 'Create account' }).click();
  await expect(rp).toHaveURL(/\/studies$/);
  await shot(rp, 'r01-studies-empty');

  await rp.getByTestId('new-study').click();
  await rp.locator('input[name=study-name]').fill('Fern & Co checkout');
  await rp.locator('textarea[name=study-description]').fill('Can first-time visitors find a pet-safe plant and buy it?');
  await rp.getByRole('button', { name: /^Blank/ }).click();
  await shot(rp, 'r02-create-study');
  await rp.getByTestId('create-study-submit').click();
  await expect(rp).toHaveURL(/\/studies\/[^/]+$/);
  studyId = rp.url().split('/studies/')[1];
  await shot(rp, 'r03-overview');

  await rp.getByRole('link', { name: /^App builds/ }).first().click();
  await expect(rp.getByTestId('dropzone')).toBeVisible();
  await rp.locator('input[type=file]').setInputFiles(path.join(ROOT, 'examples/demo-shop.zip'));
  const row = rp.getByTestId('app-row').first();
  await expect(row).toBeVisible();
  await shot(rp, 'r04-app-building');
  await expect(row).toContainText('Ready', { timeout: 6 * 60_000 });
  await expect(row).toContainText('Vite');
  await shot(rp, 'r05-app-ready');
  const detail = await (await rp.request.get(`${BASE}/api/studies/${studyId}`)).json();
  appId = detail.apps[0].id;
  appUrl = detail.apps[0].url;
  saveState();
  expect(appUrl).toMatch(/^http:\/\/app-[a-z0-9-]+\.localhost:4701\/$/);

  // Open the hosted app from the UI: it must render with the probe injected.
  await row.getByRole('button', { name: 'Open' }).click();
  const frame = rp.frameLocator('iframe[title]');
  await expect(frame.getByRole('heading', { name: 'Plants for every room' })).toBeVisible({ timeout: 20_000 });
  await shot(rp, 'r06-app-open');
  await rp.keyboard.press('Escape');
});

test('researcher: generate the protocol with AI, add a url_matches rule, assign the app, go live', async () => {
  test.skip(RESUME, 'resumed from saved state');
  test.setTimeout(6 * 60_000);
  await rp.getByRole('link', { name: /^Protocol/ }).first().click();
  await expect(rp).toHaveURL(/\/protocols\/[^/]+$/);
  await rp.getByTestId('ai-generate').click();
  const modal = rp.getByRole('dialog');
  await expect(modal).toBeVisible();
  await modal.getByPlaceholder(/Can first-time visitors/).fill('Can first-time visitors to an online plant shop find a pet-safe plant and add it to their basket? Where do they hesitate?');
  await modal.getByLabel('Product name').fill('Fern & Co');
  await modal.getByLabel('Product context').fill('Fern & Co is an online plant shop with categories (Indoor plants, Succulents & cacti, Pet-friendly, Pots & care), product pages, a basket and a checkout.');
  await modal.getByLabel('Duration').fill('8');
  await modal.getByLabel('Tasks').fill('1');
  // Keep the session short: no SUS for the voice run.
  await modal.getByText('Include SUS at the end').click();
  await shot(rp, 'r07-generate-modal');
  await modal.getByRole('button', { name: 'Generate' }).click();
  await expect(modal.getByRole('button', { name: /Use this protocol|Replace protocol/ })).toBeVisible({ timeout: 180_000 });
  await shot(rp, 'r08-generate-result');
  await modal.getByRole('button', { name: /Use this protocol|Replace protocol/ }).click();
  await expect(rp.getByTestId('step-item').first()).toBeVisible();

  // Select the first task and add a URL rule for the real basket route.
  const taskItem = rp.getByTestId('step-item').filter({ hasText: /T1 ·/ }).first();
  await taskItem.click();
  await expect(rp.getByTestId('task-instruction')).toBeVisible();
  await rp.getByRole('button', { name: /URL matches/ }).last().click();
  await rp.getByPlaceholder('^/checkout/(done|success)').last().fill('^/cart');
  await expect(rp.getByTestId('save-state')).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });
  await shot(rp, 'r09-protocol-task-rule');
  // Persisted.
  const detail = await (await rp.request.get(`${BASE}/api/studies/${studyId}`)).json();
  const task = detail.protocols[0].protocol.steps.find((s: { type: string }) => s.type === 'task');
  expect(task.successRules).toEqual(expect.arrayContaining([{ type: 'url_matches', pattern: '^/cart' }]));
  expect(task.startPath ?? '/').toMatch(/^\//);

  // Variants: assign the app.
  await rp.getByRole('link', { name: /^Variants/ }).first().click();
  await rp.getByTestId('variant-row').first().getByLabel('App').selectOption({ value: appId });
  await expect.poll(async () => (await (await rp.request.get(`${BASE}/api/studies/${studyId}`)).json()).variants[0].appId).toBe(appId);
  await shot(rp, 'r10-variants');

  // Recruit: copy the link.
  await rp.getByRole('link', { name: /^Recruit/ }).first().click();
  await rp.getByTestId('link-url').first().click();
  link = await rp.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(new RegExp(`^${BASE}/s/[A-Za-z0-9_-]+$`));
  await shot(rp, 'r11-recruit');

  await rp.getByTestId('go-live').click();
  await expect(rp.getByText(/Study is live/)).toBeVisible();
  saveState();
  await shot(rp, 'r12-live');
});

test('participant 1: full voice session against the hosted demo shop', async () => {
  test.skip(RESUME, 'resumed from saved state');
  test.setTimeout(16 * 60_000);
  const { sid, errors } = await runParticipant(browser, link, 'p1');
  expect(sid).toBeTruthy();
  sessionIds.push(sid!);
  saveState();
  console.log('[p1] console errors:', errors);
  const d = await (await rp.request.get(`${BASE}/api/sessions/${sid}`)).json();
  expect(d.session.status).toBe('completed');
  const t = d.taskResults.find((r: { stepId: string }) => r.stepId === d.steps.find((s: { type: string }) => s.type === 'task').id);
  expect(t).toMatchObject({ outcome: 'success', source: 'rule' });
  // The participant heard the task: the instruction was read (near-)verbatim before the task started.
  const instruction: string = d.steps.find((s: { type: string }) => s.type === 'task').instruction;
  const words = (x: string) => x.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3);
  const read = d.events.some((e: LogEvent) => e.kind === 'transcript.moderator' && words(instruction).filter((w) => words(String(e.data.text)).includes(w)).length >= 0.6 * words(instruction).length);
  expect(read, 'task instruction read to the participant').toBe(true);
  expect(d.hasReplay).toBe(true);
  expect(d.audioTracks).toContain('mixed');
});

test('researcher: results overview, session detail (replay, audio, transcript, outcomes), heatmaps, insights', async () => {
  test.setTimeout(6 * 60_000);
  await rp.getByRole('link', { name: /^Results/ }).first().click();
  await expect(rp.getByRole('heading', { name: /Overview|Results/ }).first()).toBeVisible();
  await expect(rp.getByText(/1 session|1 participant|1 completed/i).first()).toBeVisible({ timeout: 20_000 });
  await shot(rp, 'r20-results-overview');

  await rp.getByRole('link', { name: 'Sessions', exact: true }).click();
  const sessionRow = rp.getByRole('link', { name: /^P-/ }).first();
  await expect(sessionRow).toBeVisible();
  await shot(rp, 'r21-sessions');
  await sessionRow.click();
  await expect(rp).toHaveURL(new RegExp(`/results/sessions/${sessionIds[0]}`));
  // Replay (rrweb player renders an iframe), audio, transcript, task outcomes.
  await expect(rp.locator('.replayer-wrapper iframe, [data-testid=replay] iframe, iframe').first()).toBeVisible({ timeout: 30_000 });
  await expect(rp.locator('audio')).toHaveCount(1, { timeout: 15_000 });
  const audioSrc = await rp.locator('audio').getAttribute('src');
  expect(audioSrc).toContain(`/api/sessions/${sessionIds[0]}/audio`);
  const audioRes = await rp.request.get(new URL(audioSrc!, BASE).toString());
  expect(audioRes.status()).toBe(200);
  expect((await audioRes.body()).length).toBeGreaterThan(1000);
  await expect(rp.getByText(/AI moderator|moderator/i).first()).toBeVisible();
  await expect(rp.getByLabel(/^Outcome for/).first()).toHaveValue('success');
  // Interview answers are labelled with the question, not its internal id.
  await expect(rp.getByText(/wrapup_q\d|_q\d\b/)).toHaveCount(0);
  await shot(rp, 'r22-session-detail');

  await rp.getByRole('link', { name: 'Heatmaps', exact: true }).click();
  await expect(rp.getByRole('heading', { name: /Heatmaps/ })).toBeVisible();
  await rp.waitForTimeout(3000);
  await shot(rp, 'r23-heatmaps');

  await rp.getByRole('link', { name: 'Insights', exact: true }).click();
  await rp.getByRole('button', { name: /Run synthesis/ }).click();
  await expect(rp.getByRole('button', { name: /Run again/ })).toBeVisible({ timeout: 240_000 });
  await shot(rp, 'r24-insights');
});

test('A/B: second protocol + variant, two participants land in different variants', async () => {
  test.setTimeout(30 * 60_000);
  // Protocol B: duplicate A from the editor.
  await rp.getByRole('link', { name: /^Protocol/ }).first().click();
  await expect(rp.getByTestId('step-item').first()).toBeVisible();
  await rp.getByTitle('Switch protocol').click();
  await rp.getByRole('button', { name: /Duplicate this protocol/ }).click();
  await expect(rp.getByText('Protocol duplicated')).toBeVisible();
  const detail = await (await rp.request.get(`${BASE}/api/studies/${studyId}`)).json();
  expect(detail.protocols.length).toBe(2);
  const protoB = detail.protocols[1];

  await rp.getByRole('link', { name: /^Variants/ }).first().click();
  await rp.getByRole('button', { name: 'Add variant' }).click();
  await expect(rp.getByTestId('variant-row')).toHaveCount(2);
  const rowB = rp.getByTestId('variant-row').nth(1);
  await rowB.getByLabel('Protocol').selectOption({ value: protoB.id });
  await rowB.getByLabel('App').selectOption({ value: appId });
  await expect.poll(async () => (await (await rp.request.get(`${BASE}/api/studies/${studyId}`)).json()).variants[1]?.protocolId).toBe(protoB.id);
  await shot(rp, 'r30-variants-ab');

  // Participant 2 should be balanced into B (A already has one session); participant 3 into A or B.
  const p2 = await runParticipant(browser, link, 'p2');
  sessionIds.push(p2.sid!);
  const s2 = (await (await rp.request.get(`${BASE}/api/sessions/${p2.sid}`)).json()).session;
  const variants = (await (await rp.request.get(`${BASE}/api/studies/${studyId}`)).json()).variants as { id: string; name: string }[];
  const s1 = (await (await rp.request.get(`${BASE}/api/sessions/${sessionIds[0]}`)).json()).session;
  expect(s1.variantId).toBe(variants[0].id);
  expect(s2.variantId).toBe(variants[1].id);

  // Results: A/B comparison visible.
  await rp.getByRole('link', { name: /^Results/ }).first().click();
  await expect(rp.getByText(/Variant B|B\b/).first()).toBeVisible();
  await shot(rp, 'r31-results-ab');
});

test('export CSV from the UI', async () => {
  await rp.getByRole('link', { name: /^Results/ }).first().click();
  await rp.getByRole('button', { name: /Export/ }).first().click();
  const [download] = await Promise.all([rp.waitForEvent('download'), rp.getByRole('link', { name: /Sessions.*CSV|CSV/ }).first().click()]);
  const file = await download.path();
  const csv = fs.readFileSync(file!, 'utf8');
  expect(csv.split('\n')[0]).toMatch(/session/i);
  expect(csv.split('\n').filter(Boolean).length).toBeGreaterThanOrEqual(1 + sessionIds.length);
  for (const sid of sessionIds) expect(csv).toContain(sid);
});

// ── security ─────────────────────────────────────────────────────────────────
function rawGet(port: number, host: string, rawPath: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET', headers: { host, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('security: a second account cannot read or change the first account’s data', async () => {
  const other = await browser.newContext();
  const req = other.request;
  const su = await req.post(`${BASE}/api/auth/signup`, { data: { email: `intruder-${Date.now()}@example.com`, password: 'password123', name: 'Intruder' } });
  expect(su.ok()).toBe(true);
  const detail = await (await rp.request.get(`${BASE}/api/studies/${studyId}`)).json();
  const sid = sessionIds[0];
  const pid = detail.protocols[0].id;
  const vid = detail.variants[0].id;
  const lid = detail.links[0].id;
  const denied = (s: number) => s === 403 || s === 404;
  const checks: [string, string, unknown?][] = [
    ['GET', `/api/studies/${studyId}`],
    ['PATCH', `/api/studies/${studyId}`, { name: 'pwned' }],
    ['DELETE', `/api/studies/${studyId}`],
    ['POST', `/api/studies/${studyId}/protocols`, { name: 'x' }],
    ['PUT', `/api/protocols/${pid}`, { protocol: detail.protocols[0].protocol }],
    ['POST', `/api/protocols/${pid}/duplicate`],
    ['DELETE', `/api/protocols/${pid}`],
    ['POST', `/api/studies/${studyId}/variants`, { name: 'X', protocolId: pid }],
    ['PATCH', `/api/variants/${vid}`, { weight: 9 }],
    ['DELETE', `/api/variants/${vid}`],
    ['POST', `/api/studies/${studyId}/links`, { name: 'x' }],
    ['PATCH', `/api/links/${lid}`, { name: 'x' }],
    ['DELETE', `/api/links/${lid}`],
    ['GET', `/api/studies/${studyId}/preview-url`],
    ['GET', `/api/studies/${studyId}/apps`],
    ['GET', `/api/apps/${appId}`],
    ['GET', `/api/apps/${appId}/log`],
    ['POST', `/api/apps/${appId}/rebuild`],
    ['PATCH', `/api/apps/${appId}`, { name: 'x' }],
    ['GET', `/api/apps/${appId}/snippet`],
    ['DELETE', `/api/apps/${appId}`],
    ['GET', `/api/studies/${studyId}/analytics`],
    ['GET', `/api/studies/${studyId}/sessions`],
    ['GET', `/api/studies/${studyId}/heatmap?kind=click`],
    ['GET', `/api/studies/${studyId}/synthesis`],
    ['POST', `/api/studies/${studyId}/synthesis`],
    ['GET', `/api/studies/${studyId}/export?format=csv&table=sessions`],
    ['GET', `/api/studies/${studyId}/export?format=json&table=events`],
    ['GET', `/api/sessions/${sid}`],
    ['GET', `/api/sessions/${sid}/replay`],
    ['GET', `/api/sessions/${sid}/audio?track=mixed`],
    ['GET', `/api/sessions/${sid}/points?kind=mouse`],
    ['PUT', `/api/sessions/${sid}/tasks/x`, { outcome: 'failure' }],
    ['POST', `/api/sessions/${sid}/notes`, { t: 0, text: 'x', tags: [] }],
    ['DELETE', `/api/sessions/${sid}`],
  ];
  const leaks: string[] = [];
  for (const [method, url, body] of checks) {
    const r = await req.fetch(BASE + url, { method, data: body });
    if (!denied(r.status())) leaks.push(`${method} ${url} → ${r.status()}`);
  }
  // Anonymous requests are rejected too.
  const anon = await browser.newContext();
  for (const [method, url, body] of checks) {
    const r = await anon.request.fetch(BASE + url, { method, data: body });
    if (![401, 403, 404].includes(r.status())) leaks.push(`anon ${method} ${url} → ${r.status()}`);
  }
  // The intruder's own study list is empty.
  const mine = await (await req.get(`${BASE}/api/studies`)).json();
  expect(mine.studies).toEqual([]);
  expect(leaks).toEqual([]);
  // The owner's data is untouched.
  const after = await (await rp.request.get(`${BASE}/api/studies/${studyId}`)).json();
  expect(after.study.name).toBe(detail.study.name);
  expect(after.variants.length).toBe(detail.variants.length);
  await other.close();
  await anon.close();
});

test('security: participant endpoints require the session secret', async () => {
  const anon = await browser.newContext();
  const sid = sessionIds[0];
  const calls: [string, unknown?][] = [
    [`/api/p/sessions/${sid}/begin`],
    [`/api/p/sessions/${sid}/events`, { events: [] }],
    [`/api/p/sessions/${sid}/rrweb?seq=99`, { events: [] }],
    [`/api/p/sessions/${sid}/audio?seq=99&track=mixed`, 'x'],
    [`/api/p/sessions/${sid}/realtime-token`],
    [`/api/p/sessions/${sid}/complete`, { status: 'abandoned' }],
    [`/api/p/sessions/${sid}/withdraw`],
  ];
  for (const [url, body] of calls) {
    for (const headers of [{}, { 'X-Session-Secret': 'wrong' }]) {
      const r = await anon.request.post(BASE + url, { data: body, headers });
      expect(r.status(), `${url} ${JSON.stringify(headers)}`).toBe(403);
    }
    const r = await anon.request.post(`${BASE}${url}${url.includes('?') ? '&' : '?'}secret=wrong`, { data: body });
    expect(r.status(), `${url} ?secret=wrong`).toBe(403);
  }
  // Session still intact for the owner.
  const d = await (await rp.request.get(`${BASE}/api/sessions/${sid}`)).json();
  expect(d.session.status).toBe('completed');
  await anon.close();
});

test('security: the app host never serves files outside the build output', async () => {
  const host = new URL(appUrl).host;
  const label = host.split('.')[0];
  // Sanity: a real file is served.
  const ok = await rawGet(APP_PORT, host, '/favicon.svg');
  expect(ok.status).toBe(200);
  const secrets = [/scrypt\$/, /SQLite format/, /build\.log|Installing dependencies/i, /OPENAI_API_KEY/, /root:x:0:0/];
  const attempts = [
    '/../build.log',
    '/..%2fbuild.log',
    '/%2e%2e/build.log',
    '/%2e%2e%2fbuild.log',
    '/..%2f..%2f..%2fthinkaloud.db',
    '/%2e%2e%2f%2e%2e%2f%2e%2e%2fthinkaloud.db',
    '/..%5c..%5c..%5cthinkaloud.db',
    '/....//....//thinkaloud.db',
    '/%252e%252e/%252e%252e/thinkaloud.db',
    '/source/package.json',
    '/../source/package.json',
    '/..%2fsource%2fpackage.json',
    '/..%2f..%2f..%2f..%2f..%2f..%2f..%2fetc%2fpasswd',
    '/..%2f..%2f..%2f..%2f.env',
    '/%00../build.log',
  ];
  const leaks: string[] = [];
  for (const p of attempts) {
    for (const [h, prefix] of [
      [host, ''],
      [`localhost:${APP_PORT}`, `/a/${label.replace('-', '_')}`],
    ] as const) {
      const r = await rawGet(APP_PORT, h, prefix + p);
      if (r.status === 200 && secrets.some((re) => re.test(r.body))) leaks.push(`${h}${prefix}${p}`);
      if (r.status === 200 && !/<!doctype html|<html/i.test(r.body)) leaks.push(`${h}${prefix}${p} served non-HTML (${r.body.slice(0, 40)})`);
    }
  }
  // Another app id cannot be reached through the path-prefix of this one.
  expect(leaks).toEqual([]);
  // The API origin does not serve DATA_DIR or the repo either.
  for (const p of ['/../data-fullloop/thinkaloud.db', '/..%2f.env', '/%2e%2e/.env', '/..%2fserver%2fsrc%2findex.ts']) {
    const r = await rawGet(PORT, `localhost:${PORT}`, p);
    expect(/OPENAI_API_KEY|SQLite format|import express/.test(r.body), p).toBe(false);
  }
});
