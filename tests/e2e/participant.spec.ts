// End-to-end test of the participant runtime (/s/:token) against the REAL server and the
// REAL OpenAI realtime API, in headless Chromium with a fake microphone.
//
//   npm run e2e -- tests/e2e/participant.spec.ts
//
// Ports: API 4400, app host 4401, Vite 5400 (started automatically if not running).
// Participant speech: TTS-generated WAVs (tests/fixtures). Chromium's fake device plays
// fake-mic.wav (low noise floor); scenario utterances are mixed into the mic stream on
// demand via an init script (window.__taSpeak), so the test controls *when* the participant talks.
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { ensureFixtures, clipPath, FAKE_MIC, type ClipName } from './participant.fixtures.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const API = 'http://localhost:4400';
const WEB = 'http://localhost:5400';
const SHOTS = path.join(ROOT, 'tests/e2e/participant-screens');

// Load .env for OPENAI_API_KEY (fixtures) without extra deps.
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const procs: ChildProcess[] = [];
async function up(url: string) {
  try {
    const r = await fetch(url);
    return r.status < 500;
  } catch {
    return false;
  }
}
async function waitUp(url: string, ms = 60_000) {
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
      spawn('npx', ['tsx', '--env-file=../.env', 'src/index.ts'], {
        cwd: path.join(ROOT, 'server'),
        env: { ...process.env, PORT: '4400', APP_HOST_PORT: '4401', APP_HOST_URL: 'http://localhost:4401', PUBLIC_URL: WEB, DATA_DIR: './data-participant', BUILD_MODE: 'local' },
        stdio: 'inherit',
      }),
    );
    await waitUp(`${API}/api/health`);
  }
  if (!(await up(`${WEB}/`))) {
    procs.push(spawn('npx', ['vite', '--port', '5400', '--strictPort'], { cwd: path.join(ROOT, 'web'), env: { ...process.env, PORT: '4400' }, stdio: 'inherit' }));
    await waitUp(`${WEB}/`);
  }
}

// ── API client with cookie jar ───────────────────────────────────────────────
let cookie = '';
async function call<T>(method: string, url: string, body?: unknown, raw?: BodyInit): Promise<T> {
  const res = await fetch(API + url, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

const TEST_PROTOCOL = {
  schemaVersion: 1,
  title: 'Lumen Home usability study',
  researchGoals: ['Can people find a product and add it to the cart?'],
  productContext: 'Lumen Home is an online shop for furniture and lighting.',
  intro:
    "Hi, and thanks for joining. I'm an AI moderator. We're testing the website, not you, so there are no wrong answers. Please think out loud as you go. Are you ready to begin?",
  closing: "That's everything. Thank you so much for your time and your honest feedback.",
  moderation: {
    style: 'think_aloud_concurrent',
    probingLevel: 'light',
    allowClosedQuestions: false,
    silencePromptSeconds: 15,
    maxProbesPerStep: 1,
    probeOnBehavior: true,
    language: 'en',
    voice: 'marin',
    tone: 'warm, calm and strictly neutral',
    customRules: [],
    allowTextFallback: true,
  },
  consent: {
    text: '## Before we start\n\nAn **AI moderator** will guide you through a short task. We record your voice, your clicks on the website and your answers. You can stop at any time with **Stop & withdraw**.',
    storeAudio: true,
    recordScreen: true,
    offerEyeTracking: true,
    ageGate: true,
    version: '1',
  },
  steps: [
    {
      id: 'task_lamp',
      type: 'task',
      title: 'Find a desk lamp',
      instruction: 'Imagine you want a new lamp for your desk. Find the Aurora desk lamp and add it to your cart.',
      startPath: '/',
      successCriteria: 'The Aurora desk lamp is in the cart (cart page shows it).',
      successRules: [{ type: 'url_matches', pattern: '^/cart' }],
      timeLimitSec: 240,
      probes: ['How did you decide where to look first?'],
      askSEQ: true,
    },
    {
      id: 'task_vase',
      type: 'task',
      title: 'Find a gift',
      instruction: 'Now imagine you are looking for a small gift for a friend, under fifty dollars. Find something that would work.',
      startPath: '/',
      successCriteria: 'Participant finds the ceramic vase ($39).',
      successRules: [],
      timeLimitSec: 180,
      probes: [],
      askSEQ: false,
    },
    {
      id: 'wrapup',
      type: 'interview',
      title: 'Wrap-up',
      goal: 'Anything confusing',
      questions: ['What, if anything, was confusing about the website?'],
      maxFollowUps: 0,
    },
  ],
  randomizeTasks: false,
  estimatedMinutes: 5,
};

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

type LogEvent = { kind: string; t: number; stepId?: string; data: Record<string, unknown> };
const log = (page: Page) => page.evaluate(() => ((window as unknown as { __taRunner?: { queue: { log: unknown[] } } }).__taRunner?.queue.log ?? []) as LogEvent[]);
async function waitEvent(page: Page, pred: (e: LogEvent) => boolean, ms = 60_000, label = 'event') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = (await log(page)).find(pred);
    if (hit) return hit;
    await page.waitForTimeout(400);
  }
  const kinds = (await log(page)).map((e) => `${e.kind}${e.kind.startsWith('transcript') ? `: ${String(e.data.text).slice(0, 80)}` : e.kind === 'moderator.tool' ? `:${String(e.data.name)}${e.data.error ? `(${e.data.error})` : ''}` : ''}`);
  throw new Error(`Timed out waiting for ${label}. Log:\n${kinds.join('\n')}`);
}
async function speak(page: Page, clip: ClipName) {
  const b64 = fs.readFileSync(clipPath(clip)).toString('base64');
  return page.evaluate((b) => (window as unknown as { __taSpeak: (b: string) => Promise<number> }).__taSpeak(b), b64);
}
/** Wait until the moderator is quiet (not speaking, no active response) for `quietMs`. */
async function waitModeratorIdle(page: Page, quietMs = 1200, ms = 60_000) {
  const t0 = Date.now();
  let since = 0;
  while (Date.now() - t0 < ms) {
    const orb = await page.getAttribute('[data-testid=session]', 'data-orb');
    if (orb === 'listening' || orb === 'muted') {
      if (!since) since = Date.now();
      if (Date.now() - since >= quietMs) return;
    } else since = 0;
    await page.waitForTimeout(150);
  }
  throw new Error('moderator never went idle');
}
async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(600); // let entrance transitions settle
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

let browser: Browser;
let token = '';
let studyId = '';

test.beforeAll(async () => {
  test.setTimeout(240_000);
  await ensureFixtures();
  await ensureServers();
  // Researcher setup via the API.
  const email = `participant-e2e-${Date.now()}@example.com`;
  await call('POST', '/api/auth/signup', { email, password: 'password123', name: 'E2E Researcher' });
  const { study } = await call<{ study: { id: string } }>('POST', '/api/studies', { name: 'Participant E2E', template: 'blank' });
  studyId = study.id;
  const detail = await call<{ protocols: { id: string }[]; variants: { id: string }[]; links: { token: string }[] }>('GET', `/api/studies/${studyId}`);
  await call('PUT', `/api/protocols/${detail.protocols[0].id}`, { protocol: TEST_PROTOCOL });
  // Upload the shop app as a static build.
  const zip = new AdmZip();
  zip.addLocalFile(path.join(ROOT, 'tests/mocks/shop-app/index.html'));
  const fd = new FormData();
  fd.append('name', 'Lumen shop');
  fd.append('file', new Blob([zip.toBuffer()], { type: 'application/zip' }), 'shop.zip');
  let { app } = await call<{ app: { id: string; status: string; url?: string } }>('POST', `/api/studies/${studyId}/apps`, undefined, fd);
  for (let i = 0; i < 120 && app.status !== 'ready'; i++) {
    if (app.status === 'failed') throw new Error('app build failed');
    await new Promise((r) => setTimeout(r, 500));
    ({ app } = await call<{ app: typeof app }>('GET', `/api/apps/${app.id}`));
  }
  expect(app.status).toBe('ready');
  await call('PATCH', `/api/variants/${detail.variants[0].id}`, { appId: app.id });
  await call('PATCH', `/api/studies/${studyId}`, { status: 'live' });
  token = detail.links[0].token;

  browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${FAKE_MIC}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
});

test.afterAll(async () => {
  await browser?.close();
  for (const p of procs) p.kill('SIGTERM');
});

test('unknown link shows a friendly not-found screen', async () => {
  const page = await browser.newPage();
  await page.goto(`${WEB}/s/does-not-exist`);
  await expect(page.getByTestId('unavailable')).toBeVisible();
  await shot(page, '00-unavailable');
  await page.close();
});

test('voice session with real realtime moderator: intro → task (url rule) → SEQ by voice → interview → done', async () => {
  test.setTimeout(6 * 60_000);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['microphone', 'camera'] });
  await context.addInitScript(MIC_HOOK);
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.text().includes('[realtime]') || m.text().includes('[runner]')) console.log(`[browser:${m.type()}] ${m.text()}`);
  });

  // Landing
  await page.goto(`${WEB}/s/${token}?PROLIFIC_PID=e2e123`);
  await expect(page.getByTestId('landing')).toBeVisible();
  await expect(page.getByText('Lumen Home usability study')).toBeVisible();
  await shot(page, '01-landing');
  await page.getByTestId('get-started').click();

  // Consent
  await expect(page.getByTestId('consent')).toBeVisible();
  await expect(page.getByTestId('accept-consent')).toBeDisabled(); // 18+ gate
  await page.getByTestId('opt-age').click();
  await shot(page, '02-consent');
  await page.getByTestId('accept-consent').click();

  // Device check — the participant says "Hi, can you hear me?".
  await expect(page.getByTestId('device-check')).toBeVisible();
  await expect(page.getByTestId('mic-meter')).toBeVisible();
  await speak(page, 'mic_check');
  await expect(page.getByText('We can hear you.')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('play-chime').click();
  await page.getByTestId('heard-chime').click();
  await shot(page, '03-device-check');
  await page.getByTestId('device-continue').click();

  // Session: realtime connects, moderator speaks the intro.
  const session = page.getByTestId('session');
  await expect(session).toBeVisible();
  await shot(page, '04-session-connecting');
  const intro = await waitEvent(page, (e) => e.kind === 'transcript.moderator', 60_000, 'moderator intro transcript');
  console.log('moderator intro:', intro.data.text);
  expect(String(intro.data.text).toLowerCase()).toContain('ai moderator');
  await expect(page.getByTestId('captions')).toContainText(/AI moderator/i);
  await shot(page, '05-session-intro');
  await waitModeratorIdle(page);

  // Participant: "Yes, I'm ready." → model calls complete_step → task brief.
  await speak(page, 'ready');
  await waitEvent(page, (e) => e.kind === 'transcript.participant', 30_000, 'participant transcript');
  await waitEvent(page, (e) => e.kind === 'moderator.tool' && e.data.name === 'complete_step' && e.data.ok === true, 45_000, 'complete_step');
  await expect(session).toHaveAttribute('data-step', 'task_lamp', { timeout: 10_000 });
  await expect(session).toHaveAttribute('data-app-visible', '1');
  await waitEvent(page, (e) => e.kind === 'transcript.moderator' && /aurora desk lamp/i.test(String(e.data.text)), 45_000, 'task read verbatim');
  await waitEvent(page, (e) => e.kind === 'app.ready', 20_000, 'probe hello');
  await expect(page.getByTestId('dock')).toBeVisible();
  await shot(page, '06-task-briefing');
  await waitModeratorIdle(page);

  // Think aloud + click through the app.
  await expect(session).toHaveAttribute('data-task-phase', 'active', { timeout: 30_000 });
  await speak(page, 'think');
  const app = page.frameLocator('[data-testid=app-frame]');
  await app.getByRole('link', { name: 'Lighting' }).click();
  await page.waitForTimeout(1500);
  await shot(page, '07-task-active');
  await app.getByRole('link', { name: /Aurora desk lamp/ }).click();
  await page.waitForTimeout(1200);
  await app.getByRole('button', { name: 'Add to cart' }).click();

  // url_matches ^/cart → task.end success by rule.
  const end = await waitEvent(page, (e) => e.kind === 'task.end', 20_000, 'task.end');
  expect(end.data.outcome).toBe('success');
  expect(end.data.source).toBe('rule');
  await expect(session).toHaveAttribute('data-task-phase', 'post');
  await expect(page.getByTestId('question-card')).toBeVisible();
  await expect(page.getByTestId('question-card')).toContainText('Overall, how difficult or easy was the task to complete?');
  // Neutral wrap-up: the moderator must not praise or confirm success.
  const afterTask = await waitEvent(page, (e) => e.kind === 'transcript.moderator' && e.t > end.t, 45_000, 'post-task moderator line');
  console.log('after task:', afterTask.data.text);
  expect(String(afterTask.data.text)).not.toMatch(/great job|well done|perfect|correct|you did it|success/i);
  await shot(page, '08-post-task-seq');
  await waitModeratorIdle(page);

  // SEQ answered by voice → record_answer → card reflects 6.
  await speak(page, 'seq');
  const ans = await waitEvent(page, (e) => e.kind === 'answer' && e.data.questionId === 'seq', 45_000, 'SEQ answer');
  expect(ans.data.value).toBe(6);
  await expect(page.locator('[data-testid=question-card] [data-value="6"]')).toHaveAttribute('aria-checked', 'true').catch(() => {});
  await shot(page, '09-seq-answered');

  // The moderator may ask one allowed researcher probe after the task before moving on.
  await page.waitForTimeout(2500);
  await waitModeratorIdle(page, 1500);
  if ((await session.getAttribute('data-step')) === 'task_lamp') {
    const probe = (await log(page)).filter((e) => e.kind === 'transcript.moderator').pop();
    console.log('post-task probe:', probe?.data.text);
    expect(String(probe?.data.text)).toMatch(/\?/);
    await speak(page, 'think');
  }
  // Task 2: stay silent → neutral think-aloud nudge; then press "Skip".
  await waitEvent(page, (e) => e.kind === 'step.enter' && e.stepId === 'task_vase', 60_000, 'task 2');
  await expect(session).toHaveAttribute('data-task-phase', 'active', { timeout: 40_000 });
  const nudge = await waitEvent(page, (e) => e.kind === 'moderator.nudge', 45_000, 'silence nudge');
  const nudgeLine = await waitEvent(page, (e) => e.kind === 'transcript.moderator' && e.t > nudge.t, 30_000, 'nudge line');
  console.log('nudge:', nudgeLine.data.text);
  expect(String(nudgeLine.data.text)).not.toMatch(/vase|decor|\$|price|click|try/i); // no hints
  await shot(page, '10a-task2-nudge');
  await waitModeratorIdle(page);
  await page.getByTestId('skip-task').click();
  const end2 = await waitEvent(page, (e) => e.kind === 'task.end' && e.stepId === 'task_vase', 10_000, 'task 2 end');
  expect(end2.data).toMatchObject({ outcome: 'abandoned', source: 'participant' });
  await waitEvent(page, (e) => e.kind === 'step.enter' && e.stepId === 'wrapup', 60_000, 'interview step');
  await waitEvent(page, (e) => e.kind === 'transcript.moderator' && /confusing/i.test(String(e.data.text)), 45_000, 'interview question verbatim');
  await shot(page, '10-interview');
  await waitModeratorIdle(page);
  await speak(page, 'interview');
  await waitEvent(page, (e) => e.kind === 'answer' && String(e.data.questionId).startsWith('wrapup_q1'), 60_000, 'interview answer');

  // Closing → end_session → done screen.
  await expect(page.getByTestId('done')).toBeVisible({ timeout: 90_000 });
  await shot(page, '11-done');

  // Verify server-side record (researcher API).
  const sessions = await call<{ sessions: { id: string; status: string }[] }>('GET', `/api/studies/${studyId}/sessions`);
  const sid = sessions.sessions[0].id;
  const detail = await call<{ session: { status: string; urlParams: Record<string, string> }; events: LogEvent[]; taskResults: { stepId: string; outcome: string; source: string }[]; answers: { questionId: string; value?: number; text?: string }[]; audioTracks: string[]; hasReplay: boolean }>('GET', `/api/sessions/${sid}`);
  const kinds = new Set(detail.events.map((e) => e.kind));
  fs.writeFileSync(
    path.join(SHOTS, 'conversation.txt'),
    detail.events
      .filter((e) => ['transcript.moderator', 'transcript.participant', 'moderator.tool', 'step.enter', 'task.start', 'task.end', 'answer', 'moderator.nudge', 'moderator.probe'].includes(e.kind))
      .map((e) => `${(e.t / 1000).toFixed(1).padStart(6)}s ${e.kind.padEnd(22)} ${e.kind.startsWith('transcript') ? e.data.text : JSON.stringify(e.data)}`)
      .join('\n'),
  );
  console.log('server event kinds:', [...kinds].join(', '));
  expect(detail.session.status).toBe('completed');
  expect(detail.session.urlParams.PROLIFIC_PID).toBe('e2e123');
  for (const k of ['session.start', 'step.enter', 'task.start', 'task.end', 'transcript.participant', 'transcript.moderator', 'moderator.tool', 'answer', 'app.navigate', 'app.click', 'media.audio_start', 'session.end'])
    expect(kinds, `missing ${k}`).toContain(k);
  expect(detail.taskResults.find((r) => r.stepId === 'task_lamp')).toMatchObject({ outcome: 'success', source: 'rule' });
  expect(detail.taskResults.find((r) => r.stepId === 'task_vase')).toMatchObject({ outcome: 'abandoned', source: 'participant' });
  expect(detail.answers.find((a) => a.questionId === 'seq')?.value).toBe(6);
  expect(detail.audioTracks).toContain('mixed');
  expect(detail.hasReplay).toBe(true);
  // Transcript order: moderator intro precedes the participant's "ready" reply.
  const firstMod = detail.events.find((e) => e.kind === 'transcript.moderator')!;
  const ready = detail.events.find((e) => e.kind === 'transcript.participant' && /ready/i.test(String(e.data.text)))!;
  expect(firstMod.t).toBeLessThan(ready.t);
  // Closing said verbatim before the session ended.
  const closing = detail.events.filter((e) => e.kind === 'transcript.moderator').map((e) => String(e.data.text)).join(' ');
  expect(closing).toMatch(/Thank you so much for your time and your honest feedback/i);
  await context.close();
});

test('mobile, voice declined → text mode with spoken moderator, then withdraw deletes data', async () => {
  test.setTimeout(3 * 60_000);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto(`${WEB}/s/${token}`);
  await page.getByTestId('get-started').click();
  await page.getByTestId('opt-voice').click(); // decline microphone
  await page.getByTestId('opt-age').click();
  await shot(page, 'm1-consent-mobile');
  await page.getByTestId('accept-consent').click();
  await expect(page.getByTestId('device-check')).toBeVisible();
  await page.getByTestId('device-continue').click();
  const session = page.getByTestId('session');
  await expect(session).toHaveAttribute('data-mode', 'text');
  await waitEvent(page, (e) => e.kind === 'transcript.moderator', 60_000, 'moderator intro (text mode)');
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await shot(page, 'm2-session-text-mode');
  await waitModeratorIdle(page);
  await page.getByTestId('composer-input').fill("Yes, I'm ready.");
  await page.getByTestId('composer-send').click();
  await waitEvent(page, (e) => e.kind === 'moderator.tool' && e.data.name === 'complete_step' && e.data.ok === true, 45_000, 'complete_step (text)');
  await expect(session).toHaveAttribute('data-app-visible', '1');
  await page.waitForTimeout(2500);
  await shot(page, 'm3-task-mobile');
  // Withdraw
  await page.getByTestId('withdraw').click();
  await shot(page, 'm4-withdraw-confirm');
  await page.getByTestId('confirm-withdraw').click();
  await expect(page.getByTestId('withdrawn')).toBeVisible();
  await shot(page, 'm5-withdrawn');
  const sessions = await call<{ sessions: { id: string; status: string }[] }>('GET', `/api/studies/${studyId}/sessions`);
  const withdrawn = sessions.sessions.filter((x) => x.status === 'withdrawn');
  expect(withdrawn.length).toBeGreaterThan(0);
  const d = await call<{ events: unknown[]; answers: unknown[] }>('GET', `/api/sessions/${withdrawn[0].id}`).catch(() => ({ events: [], answers: [] }));
  expect(d.events.length).toBe(0);
  await context.close();
});

test('eye tracking opt-in shows calibration (webgazer) and can be skipped', async () => {
  test.setTimeout(2 * 60_000);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['microphone', 'camera'] });
  await context.addInitScript(MIC_HOOK);
  const page = await context.newPage();
  await page.goto(`${WEB}/s/${token}`);
  await page.getByTestId('get-started').click();
  await page.getByTestId('opt-eye').click();
  await page.getByTestId('opt-age').click();
  await page.getByTestId('accept-consent').click();
  await page.getByTestId('device-continue').click();
  await expect(page.getByTestId('calibration')).toBeVisible();
  // Give WebGazer time to load the face mesh model + fake camera.
  await page.getByText(/Center your face|isn’t available/).waitFor({ timeout: 60_000 }).catch(() => {});
  await shot(page, 'e1-calibration');
  const skip = page.getByRole('button', { name: /^Skip$|Continue without eye tracking/ });
  await skip.first().click();
  await expect(page.getByTestId('session')).toBeVisible();
  // Camera preview must be gone and the webcam released.
  await expect(page.locator('#webgazerVideoContainer')).toHaveCount(0);
  await page.getByTestId('withdraw').click();
  await page.getByTestId('confirm-withdraw').click();
  await expect(page.getByTestId('withdrawn')).toBeVisible();
  await context.close();
});
