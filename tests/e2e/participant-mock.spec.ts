// Participant runtime against a LOCAL MOCK of the OpenAI realtime layer (tests/e2e/mockRealtime.ts).
// No OpenAI calls at all: the servers start with OPENAI_API_KEY empty, the realtime token endpoint is
// answered by the test, and every request to api.openai.com is fulfilled or aborted locally.
//
//   npx playwright test tests/e2e/participant-mock.spec.ts
//
// Ports: API 4810, app host 4811, Vite 5810 (MOCK_*_PORT to move them), DATA_DIR ./data-fix2.
// Regressions from the real CrossWeave session P-XKC5 (tests/fixtures/real-sessions).
import { test, expect, chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { MOCK_REALTIME } from './mockRealtime.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const API_PORT = process.env.MOCK_API_PORT || '4810';
const APP_PORT = process.env.MOCK_APP_PORT || '4811';
const WEB_PORT = process.env.MOCK_WEB_PORT || '5810';
const DATA_DIR = process.env.MOCK_DATA_DIR || './data-fix2';
const API = `http://localhost:${API_PORT}`;
const WEB = `http://localhost:${WEB_PORT}`;
const OUT = path.join(ROOT, 'tests/e2e/participant-screens');
const CHROME = path.join(os.homedir(), '.cache/ms-playwright/chromium-1234/chrome-linux/chrome');
const FIX = path.join(ROOT, 'tests/fixtures');

// ── servers (no OpenAI key, ever) ────────────────────────────────────────────
const procs: ChildProcess[] = [];
const noOpenAI = { ...process.env, OPENAI_API_KEY: '' };
async function up(url: string) {
  try {
    return (await fetch(url)).status < 500;
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
      spawn('npx', ['tsx', 'src/index.ts'], {
        cwd: path.join(ROOT, 'server'),
        env: { ...noOpenAI, PORT: API_PORT, APP_HOST_PORT: APP_PORT, APP_HOST_URL: `http://localhost:${APP_PORT}`, PUBLIC_URL: WEB, DATA_DIR, BUILD_MODE: 'local', SESSION_SECRET: 'mock-tests' },
        stdio: 'inherit',
        detached: true, // own process group: afterAll stops npx and the server it started
      }),
    );
    await waitUp(`${API}/api/health`);
  }
  if (!(await up(`${WEB}/`))) {
    procs.push(spawn('npx', ['vite', '--port', WEB_PORT, '--strictPort'], { cwd: path.join(ROOT, 'web'), env: { ...noOpenAI, PORT: API_PORT, VITE_NO_HMR: '1' }, stdio: 'inherit', detached: true }));
    await waitUp(`${WEB}/`);
  }
}

// ── researcher API ───────────────────────────────────────────────────────────
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
type Json = Record<string, unknown>;
function protocol(steps: Json[], moderation: Json = {}) {
  return {
    schemaVersion: 1,
    title: 'Lumen Home usability study',
    researchGoals: ['Can people find a product?'],
    productContext: 'Lumen Home is an online shop for furniture and lighting.',
    intro: "Hi, and thanks for joining. I'm an AI moderator, and I'll guide you through this session. We're testing the website, not you, so there are no wrong answers. Please think out loud as you go. Are you ready to begin?",
    closing: "That's everything. Thank you so much for your time.",
    moderation: {
      style: 'think_aloud_concurrent',
      probingLevel: 'none',
      allowClosedQuestions: false,
      silencePromptSeconds: 0,
      maxProbesPerStep: 0,
      probeOnBehavior: false,
      language: 'en',
      voice: 'marin',
      tone: 'warm, calm and strictly neutral',
      customRules: [],
      allowTextFallback: true,
      ...moderation,
    },
    consent: { text: '## Before we start\n\nWe record your voice and clicks.', storeAudio: false, recordScreen: false, offerEyeTracking: false, ageGate: true, version: '1' },
    steps,
    randomizeTasks: false,
    estimatedMinutes: 5,
  };
}
async function createStudy(name: string, proto: Json): Promise<{ token: string; studyId: string }> {
  const { study } = await call<{ study: { id: string } }>('POST', '/api/studies', { name, template: 'blank' });
  const detail = await call<{ protocols: { id: string }[]; variants: { id: string }[]; links: { token: string }[] }>('GET', `/api/studies/${study.id}`);
  await call('PUT', `/api/protocols/${detail.protocols[0].id}`, { protocol: proto });
  const zip = new AdmZip();
  zip.addLocalFile(path.join(ROOT, 'tests/mocks/shop-app/index.html'));
  const fd = new FormData();
  fd.append('name', 'Lumen shop');
  fd.append('file', new Blob([new Uint8Array(zip.toBuffer())], { type: 'application/zip' }), 'shop.zip');
  let { app } = await call<{ app: { id: string; status: string } }>('POST', `/api/studies/${study.id}/apps`, undefined, fd);
  for (let i = 0; i < 120 && app.status !== 'ready'; i++) {
    if (app.status === 'failed') throw new Error('app build failed');
    await new Promise((r) => setTimeout(r, 500));
    ({ app } = await call<{ app: typeof app }>('GET', `/api/apps/${app.id}`));
  }
  await call('PATCH', `/api/variants/${detail.variants[0].id}`, { appId: app.id });
  await call('PATCH', `/api/studies/${study.id}`, { status: 'live' });
  return { token: detail.links[0].token, studyId: study.id };
}
type LogEvent = { kind: string; t: number; stepId?: string; data: Record<string, unknown> };
async function lastSession(studyId: string) {
  const { sessions } = await call<{ sessions: { id: string }[] }>('GET', `/api/studies/${studyId}/sessions`);
  return call<{ answers: { questionId: string; declined?: boolean; text?: string }[]; taskResults: { stepId: string; outcome: string; source: string }[] }>('GET', `/api/sessions/${sessions[0].id}`);
}

// ── browser ──────────────────────────────────────────────────────────────────
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

let browser: Browser;
test.use({ screenshot: 'off' });
test.beforeAll(async () => {
  test.setTimeout(180_000);
  await ensureServers();
  await call('POST', '/api/auth/signup', { email: `mock-${Date.now()}@example.com`, password: 'password123', name: 'Mock Researcher' });
  browser = await chromium.launch({
    headless: true,
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${path.join(FIX, 'fake-mic.wav')}`, '--autoplay-policy=no-user-gesture-required'],
  });
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

async function newPage(): Promise<{ context: BrowserContext; page: Page; openaiHits: string[] }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['microphone', 'camera'] });
  await context.addInitScript(MOCK_REALTIME);
  await context.addInitScript(MIC_HOOK);
  const openaiHits: string[] = [];
  // Nothing may reach OpenAI: the SDP exchange is answered locally, anything else is aborted.
  await context.route('https://api.openai.com/**', (r) => {
    openaiHits.push(r.request().url());
    if (r.request().url().endsWith('/v1/realtime/calls')) return r.fulfill({ status: 200, contentType: 'application/sdp', body: 'v=0 mock-answer' });
    return r.abort('blockedbyclient');
  });
  await context.route('**/api/p/sessions/*/realtime-token', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ value: 'ek_mock', expiresAt: 0, model: 'mock-realtime', voice: 'marin', transcription: { model: 'mock-transcribe', language: 'en' } }) }),
  );
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.text().includes('[realtime]')) console.log(`[browser:${m.type()}] ${m.text()}`);
  });
  return { context, page, openaiHits };
}

const log = (page: Page) => page.evaluate(() => ((window as unknown as { __taRunner?: { queue: { log: unknown[] } } }).__taRunner?.queue.log ?? []) as LogEvent[]);
async function waitEvent(page: Page, pred: (e: LogEvent) => boolean, ms = 30_000, label = 'event') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = (await log(page)).find(pred);
    if (hit) return hit;
    await page.waitForTimeout(150);
  }
  throw new Error(`Timed out waiting for ${label}. Log:\n${fmt(await log(page))}`);
}
function fmt(evs: LogEvent[]) {
  return evs
    .filter((e) => !['mouse', 'gaze', 'app.scroll', 'app.focus'].includes(e.kind))
    .map((e) => `${(e.t / 1000).toFixed(1).padStart(6)}s ${(e.stepId ?? '').padEnd(12)} ${e.kind.padEnd(22)} ${e.kind.startsWith('transcript') ? String(e.data.text) + (e.data.noise ? ' [noise]' : '') + (e.data.truncated ? ' [cut]' : '') : JSON.stringify(e.data).slice(0, 200)}`)
    .join('\n');
}
function save(name: string, evs: LogEvent[]) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `mock-${name}.txt`), fmt(evs));
}
const says = (page: Page, text: string, ms?: number) => page.evaluate(([t, d]) => (window as unknown as { __mockRt: { userSays: (t: string, d?: number) => Promise<void> } }).__mockRt.userSays(t as string, d as number | undefined), [text, ms] as const);
const setRules = (page: Page, rules: [string, string][], extra: Json = {}) =>
  page.evaluate(([r, x]) => Object.assign((window as unknown as { __mockRt: { config: Json } }).__mockRt.config, { rules: r }, x), [rules, extra] as const);
const modLines = (evs: LogEvent[], after = -1) => evs.filter((e) => e.kind === 'transcript.moderator' && e.t > after).map((e) => String(e.data.text));
async function waitIdle(page: Page, quietMs = 600) {
  const t0 = Date.now();
  let since = 0;
  while (Date.now() - t0 < 30_000) {
    const orb = await page.getAttribute('[data-testid=session]', 'data-orb');
    if (orb === 'listening') {
      if (!since) since = Date.now();
      if (Date.now() - since >= quietMs) return;
    } else since = 0;
    await page.waitForTimeout(100);
  }
  throw new Error('moderator never went idle');
}

/** Landing → consent → mic check (local wav) → session; intro; "ready". */
async function start(page: Page, token: string, query = '') {
  await page.goto(`${WEB}/s/${token}${query}`);
  await page.getByTestId('get-started').click();
  await page.getByTestId('opt-age').click();
  await page.getByTestId('accept-consent').click();
  await expect(page.getByTestId('mic-meter')).toBeVisible({ timeout: 20_000 });
  const b64 = fs.readFileSync(path.join(FIX, 'mic_check.wav')).toString('base64');
  await page.evaluate((b) => (window as unknown as { __taSpeak: (b: string) => Promise<number> }).__taSpeak(b), b64);
  await expect(page.getByText('We can hear you.')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('device-continue').click();
}

const task = (over: Json) => ({ type: 'task', successCriteria: 'Done.', successRules: [], timeLimitSec: 600, probes: [], askSEQ: false, startPath: '/', ...over });

// ─────────────────────────────────────────────────────────────────────────────
test('M1 · captions follow the voice; "I\'m done" asks at once even while a classification blocks responses; a paused answer is not cut off; silence → asked once more, then "Okay, let\'s continue."', async () => {
  const steps = [
    task({ id: 'task_find', title: 'Find', instruction: 'Imagine you want a new lamp for your desk. Find the Aurora desk lamp.', askSEQ: true }),
    task({ id: 'task_decor', title: 'Decor', instruction: 'Have a look at the decor section.' }),
    { id: 'wrapup', type: 'interview', title: 'Wrap-up', goal: 'Impression', questions: ['How would you describe the website to a friend?'], maxFollowUps: 0 },
  ];
  const { token } = await createStudy('Mock done', protocol(steps));
  const { context, page, openaiHits } = await newPage();
  await start(page, token);

  // (a) Captions: the whole intro transcript arrives at once, but the caption grows with the audio.
  const samples: { sec: number; words: number }[] = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 9000) {
    const x = await page.evaluate(() => {
      const r = (window as unknown as { __taRunner?: { queue: { now(): number; log: LogEvent[] }; snapshot: { captions: { role: string; text: string; final: boolean }[] } } }).__taRunner;
      if (!r) return null;
      const start = r.queue.log.find((e) => e.kind === 'speech.start' && e.data.who === 'moderator');
      const cap = r.snapshot.captions.filter((c) => c.role === 'moderator').at(-1);
      return start && cap && !cap.final ? { sec: (r.queue.now() - start.t) / 1000, words: cap.text.split(/\s+/).filter(Boolean).length } : null;
    });
    if (x) samples.push(x);
    await page.waitForTimeout(120);
  }
  console.log('captions:', samples.map((s) => `${s.sec.toFixed(1)}s:${s.words}w`).join(' '));
  expect(samples.length).toBeGreaterThan(10);
  for (const s of samples) expect(s.words).toBeLessThanOrEqual(Math.ceil(s.sec * 3.3) + 2); // never ahead of a 2.8 w/s voice
  expect(samples.at(-1)!.words).toBeLessThan(42); // the 42-word intro was not shown at once

  await waitIdle(page);
  await says(page, "Yes, I'm ready. Let's start.");
  const session = page.getByTestId('session');
  await expect(session).toHaveAttribute('data-step', 'task_find', { timeout: 15_000 });
  await expect(session).toHaveAttribute('data-task-phase', 'active', { timeout: 20_000 });
  await waitIdle(page);

  // (b) The 17 s stall: a think-aloud line starts a slow classification that blocks in-band responses
  // (conversation_already_has_active_response); then the participant presses "I'm done".
  await setRules(page, [['.*', 'NO']], { oobDelayMs: 16_000, oobBlocksResponses: true });
  await says(page, "So this post that I'm looking at is basically saying we are falling behind.");
  await page.waitForTimeout(500);
  await page.getByTestId('im-done').click();
  const pressed = await waitEvent(page, (e) => e.kind === 'observation' && e.data.kind === 'participant_done_button', 5000, 'done');
  const askStart = await waitEvent(page, (e) => e.kind === 'speech.start' && e.data.who === 'moderator' && e.t > pressed.t, 20_000, 'question audio');
  console.log(`question audible ${((askStart.t - pressed.t) / 1000).toFixed(1)}s after the button`);
  expect(askStart.t - pressed.t).toBeLessThan(2500);
  const ask = await waitEvent(page, (e) => e.kind === 'transcript.moderator' && e.t > pressed.t, 15_000, 'how did it go');
  expect(String(ask.data.text)).toBe('How do you feel that went?');
  await setRules(page, [['.*', 'NO']], { oobDelayMs: 300 });
  await waitIdle(page, 300);

  // (c) "The interfaces" … 3 s pause … rest of the answer: no "Thanks" in between.
  await says(page, 'The interfaces', 1500);
  await page.waitForTimeout(3000);
  await says(page, 'were a bit confusing at first, but I found it with the search in the end.');
  const end1 = await waitEvent(page, (e) => e.kind === 'task.end' && e.stepId === 'task_find', 20_000, 'task.end 1');
  let evs = await log(page);
  const part2 = evs.find((e) => e.kind === 'transcript.participant' && /confusing/.test(String(e.data.text)))!;
  expect(end1.t).toBeGreaterThan(part2.t + 1500); // ~2 s of quiet after the complete answer
  expect(modLines(evs.filter((e) => e.t <= end1.t), ask.t)).toEqual([]);
  expect(String(end1.data.evidence)).toContain('The interfaces were a bit confusing');
  const after1 = await waitEvent(page, (e) => e.kind === 'transcript.moderator' && e.t > end1.t, 15_000, 'after answer');
  expect(String(after1.data.text)).toMatch(/^Thanks\. Overall, how difficult or easy/);
  await expect(page.getByTestId('question-card')).toBeVisible();
  await page.locator('[data-testid=question-card] [data-value="6"]').click();

  // (d) Done, then silence → ~10 s → asked once more ("Take your time."), never "Thanks" for silence;
  // still silent → ~20 s, then "Okay, let's continue." (silence is never taken as the answer).
  await expect(session).toHaveAttribute('data-step', 'task_decor', { timeout: 15_000 });
  await expect(session).toHaveAttribute('data-task-phase', 'active', { timeout: 20_000 });
  await waitIdle(page);
  await page.getByTestId('im-done').click();
  const ask2 = await waitEvent(page, (e) => e.kind === 'transcript.moderator' && e.stepId === 'task_decor' && /how do you feel/i.test(String(e.data.text)), 10_000, 'ask 2');
  const reask = await waitEvent(page, (e) => e.kind === 'transcript.moderator' && e.stepId === 'task_decor' && /take your time/i.test(String(e.data.text)), 20_000, 're-ask');
  expect(reask.t - ask2.t).toBeGreaterThan(9500);
  const end2 = await waitEvent(page, (e) => e.kind === 'task.end' && e.stepId === 'task_decor', 35_000, 'task.end 2');
  expect(end2.t - reask.t).toBeGreaterThan(19_000);
  const after2 = await waitEvent(page, (e) => e.kind === 'transcript.moderator' && e.t > end2.t, 15_000, 'after silence');
  expect(String(after2.data.text)).toBe("Okay, let's continue. How would you describe the website to a friend?");
  evs = await log(page);
  save('done', evs);
  expect(openaiHits.filter((u) => !u.endsWith('/v1/realtime/calls'))).toEqual([]);
  await context.close();
});

test('M2 · a tell-me answer never ends the task by itself ("Is that all for this task?", then a yes ends it); stuck twice → one skip reminder; after a skip every question has a card and "I don\'t know" / "I\'m not sure" are accepted; noise is ignored', async () => {
  const steps = [
    task({ id: 'task_price', title: 'Price', instruction: 'Open the Aurora desk lamp and tell me what it costs.' }),
    task({
      id: 'task_poster',
      title: 'Posters',
      instruction: 'Find the poster section of this shop and tell me which poster you like best.',
      postTaskQuestions: [
        { id: 'who', prompt: 'Who do you think designed the posters?', kind: 'open', required: true },
        { id: 'liked', prompt: 'Did you like the posters?', kind: 'yes_no', required: true },
        { id: 'rate', prompt: 'How appealing were the posters?', kind: 'rating', scale: { min: 1, max: 5 }, required: true },
      ],
    }),
    { id: 'wrapup', type: 'interview', title: 'Wrap-up', goal: 'Impression', questions: ['How would you describe the website to a friend?'], maxFollowUps: 0 },
  ];
  const { token, studyId } = await createStudy('Mock verbal', protocol(steps));
  const { context, page } = await newPage();
  await start(page, token);
  await waitEvent(page, (e) => e.kind === 'transcript.moderator', 30_000, 'intro');
  await waitIdle(page);
  await says(page, "Yes, I'm ready.");
  const session = page.getByTestId('session');
  await expect(session).toHaveAttribute('data-task-phase', 'active', { timeout: 20_000 });
  await waitIdle(page);

  // (a) What sounds like the requested answer never ends the task by itself (it may be ongoing
  // narration): after a quiet moment the moderator asks once whether that is all; a "no" lets them
  // carry on, and a later yes ends it.
  await setRules(page, [['costs', 'DELIVERED'], ['^done', 'DONE'], ["don't see|can't find", 'STUCK']]);
  const said = (await log(page)).at(-1)!.t;
  await says(page, 'Okay, here it is. The Aurora desk lamp costs eighty-nine dollars.');
  const remind = await waitEvent(page, (e) => e.kind === 'transcript.moderator' && e.t > said && /is that all for this task/i.test(String(e.data.text)), 20_000, 'is that all');
  let evs = await log(page);
  expect(evs.some((e) => e.kind === 'task.end' && e.stepId === 'task_price')).toBe(false);
  expect(remind.t - said).toBeGreaterThan(3000);
  const checks = await page.evaluate(() => (window as unknown as { __taRunner: { turnChecks: { label: string }[] } }).__taRunner.turnChecks);
  expect(checks.map((c) => c.label)).toContain('DELIVERED');
  await waitIdle(page);
  await says(page, 'Yes, that is all.');
  await waitEvent(page, (e) => e.kind === 'transcript.moderator' && e.stepId === 'task_price' && /how do you feel/i.test(String(e.data.text)), 15_000, 'how did it go');
  await waitIdle(page);
  await says(page, 'It was easy, the price was right on the page.');
  const end1 = await waitEvent(page, (e) => e.kind === 'task.end' && e.stepId === 'task_price', 15_000, 'task.end after done');
  expect(end1.data.source).toBe('ai');
  evs = await log(page);

  // (b) Stuck: first time quiet, second time one reminder that skipping is fine.
  await expect(session).toHaveAttribute('data-step', 'task_poster', { timeout: 15_000 });
  await expect(session).toHaveAttribute('data-task-phase', 'active', { timeout: 20_000 });
  await waitIdle(page);
  const from = (await log(page)).at(-1)!.t;
  await says(page, "Hmm. I don't see any poster.");
  await page.waitForTimeout(2500);
  expect(modLines(await log(page), from)).toEqual([]);
  await says(page, "Ugh. I really can't find any poster anywhere.");
  const reminder = await waitEvent(page, (e) => e.kind === 'transcript.moderator' && e.t > from, 10_000, 'skip reminder');
  expect(String(reminder.data.text)).toMatch(/you can skip this one/i);
  await waitIdle(page);

  // (c) Skip → the open post-task question has a card (text, typed answer, "I'm not sure").
  await page.getByTestId('skip-task').click();
  await expect(page.getByTestId('question-prompt')).toHaveText('Who do you think designed the posters?', { timeout: 10_000 });
  await expect(page.getByTestId('decline-question')).toBeVisible();
  await expect(page.getByTestId('type-answer')).toBeVisible();
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, 'mock-post-skip-card.png') });
  await waitIdle(page);
  // Background noise in the wrong language is not an answer.
  await says(page, 'Wortfrieden-Text.', 900);
  await page.waitForTimeout(1500);
  evs = await log(page);
  expect(evs.find((e) => e.kind === 'transcript.participant' && /Wortfrieden/.test(String(e.data.text)))?.data.noise).toBe(true);
  expect(evs.some((e) => e.kind === 'answer' && e.data.questionId === 'who')).toBe(false);
  const deleted = await page.evaluate(() => (window as unknown as { __mockRt: { sent: { type: string }[] } }).__mockRt.sent.filter((e) => e.type === 'conversation.item.delete').length);
  expect(deleted).toBeGreaterThan(0);
  // "I'm not sure" on screen.
  await page.getByTestId('decline-question').click();
  const a1 = await waitEvent(page, (e) => e.kind === 'answer' && e.data.questionId === 'who', 5000, 'who declined');
  expect(a1.data).toMatchObject({ declined: true, source: 'screen' });
  // Yes/no by voice: "I don't know" (the real session's error: "value must be 1 (yes) or 0 (no)").
  await expect(page.getByTestId('question-prompt')).toHaveText('Did you like the posters?', { timeout: 10_000 });
  await waitEvent(page, (e) => e.kind === 'transcript.moderator' && /like the posters/.test(String(e.data.text)), 15_000, 'yes/no asked');
  await waitIdle(page);
  await says(page, "I don't know.");
  const a2 = await waitEvent(page, (e) => e.kind === 'answer' && e.data.questionId === 'liked', 10_000, 'liked');
  expect(a2.data.declined).toBe(true);
  // Rating: "not sure" without the declined flag is still accepted.
  await expect(page.getByTestId('question-prompt')).toHaveText('How appealing were the posters?', { timeout: 10_000 });
  await waitEvent(page, (e) => e.kind === 'transcript.moderator' && /How appealing/.test(String(e.data.text)), 15_000, 'rating asked');
  await waitIdle(page);
  await says(page, "Not sure, honestly. I didn't see any.");
  const a3 = await waitEvent(page, (e) => e.kind === 'answer' && e.data.questionId === 'rate', 10_000, 'rate');
  expect(a3.data.declined).toBe(true);
  await waitEvent(page, (e) => e.kind === 'step.enter' && e.stepId === 'wrapup', 15_000, 'next step');
  evs = await log(page);
  save('verbal', evs);
  expect(evs.filter((e) => e.kind === 'moderator.tool' && e.data.ok === false).map((e) => e.data.error)).toEqual([]);
  // Interview questions get a card too.
  await expect(page.getByTestId('question-prompt')).toHaveText('How would you describe the website to a friend?', { timeout: 10_000 });
  await page.waitForTimeout(1500); // let the event queue flush
  const d = await lastSession(studyId);
  expect(d.answers.filter((a) => a.declined).map((a) => a.questionId).sort()).toEqual(['liked', 'rate', 'who']);
  expect(d.taskResults.find((r) => r.stepId === 'task_poster')).toMatchObject({ outcome: 'abandoned' });
  await context.close();
});

test('M3 · "Back to task" after an accidental "I\'m done": during "How do you feel that went?" the wrap-up is dropped; after the outcome (before any post-task answer) it is withdrawn; finishing again records one result', async () => {
  const steps = [
    task({ id: 'task_find', title: 'Find', instruction: 'Imagine you want a new lamp for your desk. Find the Aurora desk lamp.', askSEQ: true }),
    { id: 'wrapup', type: 'interview', title: 'Wrap-up', goal: 'Impression', questions: ['How would you describe the website to a friend?'], maxFollowUps: 0 },
  ];
  const { token, studyId } = await createStudy('Mock resume', protocol(steps));
  const { context, page, openaiHits } = await newPage();
  await start(page, token);
  await waitIdle(page);
  await says(page, "Yes, I'm ready. Let's start.");
  const session = page.getByTestId('session');
  await expect(session).toHaveAttribute('data-task-phase', 'active', { timeout: 20_000 });
  await waitIdle(page);

  // (a) Pressed by accident: the question is asked, the participant goes back before answering.
  await page.getByTestId('im-done').click();
  await waitEvent(page, (e) => e.kind === 'transcript.moderator' && /how do you feel/i.test(String(e.data.text)), 15_000, 'ask');
  await page.getByTestId('back-to-task').click();
  await waitEvent(page, (e) => e.kind === 'observation' && e.data.kind === 'wrap_up_cancelled', 5000, 'cancelled');
  const back1 = await waitEvent(page, (e) => e.kind === 'transcript.moderator' && /take your time/i.test(String(e.data.text)), 15_000, 'no problem');
  expect(String(back1.data.text)).toMatch(/^No problem\./);
  await expect(session).toHaveAttribute('data-task-phase', 'active');
  await expect(page.getByTestId('im-done')).toBeVisible();
  let evs = await log(page);
  expect(evs.filter((e) => e.kind === 'task.end')).toEqual([]);
  await waitIdle(page);

  // (b) Done again and answered, outcome recorded; the SEQ card shows — then "Back to task" before rating.
  await page.getByTestId('im-done').click();
  await waitEvent(page, (e) => e.kind === 'transcript.moderator' && e.t > back1.t && /how do you feel/i.test(String(e.data.text)), 15_000, 'ask 2');
  await waitIdle(page, 300);
  await says(page, 'I think I found it with the search.');
  await waitEvent(page, (e) => e.kind === 'task.end' && e.stepId === 'task_find', 20_000, 'task.end 1');
  await expect(page.getByTestId('back-to-task')).toBeVisible();
  await page.getByTestId('back-to-task').click();
  await waitEvent(page, (e) => e.kind === 'task.resume' && e.stepId === 'task_find', 5000, 'task.resume');
  await expect(session).toHaveAttribute('data-task-phase', 'active', { timeout: 5000 });
  await waitIdle(page);

  // (c) Finish for real: one task result, with the original start time.
  await page.getByTestId('im-done').click();
  const pressed = await waitEvent(page, (e) => e.kind === 'observation' && e.data.kind === 'participant_done_button' && e.t > back1.t + 1, 5000, 'done 3');
  await waitEvent(page, (e) => e.kind === 'transcript.moderator' && e.t > pressed.t && /how do you feel/i.test(String(e.data.text)), 15_000, 'ask 3');
  await waitIdle(page, 300);
  await says(page, 'Now I really found the Aurora lamp.');
  await waitEvent(page, (e) => e.kind === 'task.end' && e.stepId === 'task_find' && e.t > pressed.t, 20_000, 'task.end 2');
  await expect(page.getByTestId('question-card')).toBeVisible({ timeout: 15_000 });
  await page.locator('[data-testid=question-card] [data-value="6"]').click();
  await expect(page.getByTestId('back-to-task')).toHaveCount(0);
  evs = await log(page);
  save('resume', evs);
  const ends = evs.filter((e) => e.kind === 'task.end');
  expect(ends).toHaveLength(2);
  expect(ends[1].data.startedAt).toBe(ends[0].data.startedAt);
  await page.waitForTimeout(2500); // event upload
  const d = await lastSession(studyId);
  expect(d.taskResults.filter((r) => r.stepId === 'task_find')).toHaveLength(1);
  expect(String((d.taskResults.find((r) => r.stepId === 'task_find') as { evidence?: string }).evidence ?? '')).toContain('really found');
  expect(openaiHits.filter((u) => !u.endsWith('/v1/realtime/calls'))).toEqual([]);
  await context.close();
});

test('M4 · status: "Listening" while they talk, "Got it" right after they stop, "Still thinking" when the reply is slow, "Your turn" when the moderator waits; tasks are announced ("Task one of two." + how to finish, then "Task two of two.") with a banner', async () => {
  const steps = [
    task({ id: 'task_a', title: 'Lamp', instruction: 'Find the Aurora desk lamp.' }),
    task({ id: 'task_b', title: 'Posters', instruction: 'Have a look at the poster section.' }),
  ];
  const { token } = await createStudy('Mock status', protocol(steps));
  const { context, page, openaiHits } = await newPage();
  await start(page, token);
  const session = page.getByTestId('session');
  await waitEvent(page, (e) => e.kind === 'transcript.moderator', 30_000, 'intro');
  await waitIdle(page);
  await expect(session).toHaveAttribute('data-status', 'your_turn', { timeout: 5000 });
  await expect(page.getByTestId('orb-label')).toContainText('Your turn');

  // A slow reply: acknowledged at once, then "no need to repeat".
  await setRules(page, [], { responseDelayMs: 7500 });
  const talking = says(page, "Yes, I'm ready.", 1500);
  await expect(session).toHaveAttribute('data-status', 'listening', { timeout: 1500 });
  await talking;
  const stoppedAt = Date.now();
  await expect(session).toHaveAttribute('data-status', 'heard', { timeout: 500 });
  await expect(page.getByTestId('orb-label')).toContainText('Got it');
  await expect(session).toHaveAttribute('data-status', 'slow', { timeout: 9000 });
  expect(Date.now() - stoppedAt).toBeGreaterThan(5000);
  await expect(page.getByTestId('orb-label').first()).toContainText('no need to repeat');
  await page.screenshot({ path: path.join(OUT, 'mock-status-slow.png') });
  await setRules(page, [], { responseDelayMs: 250 });

  // Task one of two: banner + spoken number + how to finish (first task only).
  await expect(session).toHaveAttribute('data-step', 'task_a', { timeout: 20_000 });
  await expect(page.getByTestId('task-text')).toContainText('Task 1 of 2');
  await page.screenshot({ path: path.join(OUT, 'mock-task-banner.png') });
  const a = await waitEvent(page, (e) => e.kind === 'transcript.moderator' && e.stepId === 'task_a' && /task one of two/i.test(String(e.data.text)), 15_000, 'task one of two');
  expect(String(a.data.text)).toMatch(/just tell me, or press I'm done/);
  await expect(page.getByTestId('step-label')).toContainText('Task 1 of 2');
  await expect(session).toHaveAttribute('data-task-phase', 'active', { timeout: 20_000 });
  // Once it has been said, the task stays in the panel in writing (no transcript needed).
  await expect(page.getByTestId('task-text')).toHaveAttribute('data-revealed', '1');
  await expect(page.getByTestId('task-instruction-text')).toHaveText('Find the Aurora desk lamp.');
  await expect(page.getByTestId('panel-steps').getByTestId('panel-step').nth(0)).toHaveAttribute('data-state', 'current');
  await expect(page.getByTestId('captions')).toHaveCount(0); // conversation collapsed by default
  await waitIdle(page);
  // During the task the dock shows the status too (quiet phase: just "Listening").
  await expect(page.getByTestId('panel-status')).toContainText('Listening');
  await page.screenshot({ path: path.join(OUT, 'mock-task-dock.png') });

  await page.getByTestId('skip-task').click();
  await expect(session).toHaveAttribute('data-step', 'task_b', { timeout: 20_000 });
  await expect(page.getByTestId('task-text')).toContainText('Task 2 of 2');
  await expect(page.getByTestId('panel-steps').getByTestId('panel-step').nth(0)).toHaveAttribute('data-state', 'done');
  const b = await waitEvent(page, (e) => e.kind === 'transcript.moderator' && e.stepId === 'task_b' && /task two of two/i.test(String(e.data.text)), 15_000, 'task two of two');
  expect(String(b.data.text)).not.toMatch(/just tell me/);
  save('status', await log(page));
  expect(openaiHits.filter((u) => !u.endsWith('/v1/realtime/calls'))).toEqual([]);
  await context.close();
});

test('M5 · assistance ladder: a stuck participant gets the general prompts verbatim, one per gap, then the direct cue; a click resets "stuck"; the soft limit asks once; the result scores 0 with the assistance recorded', async () => {
  test.setTimeout(150_000);
  const steps = [
    task({
      id: 'task_stuck',
      title: 'Find',
      instruction: 'Find the Aurora desk lamp.',
      softLimitSec: 45,
      assistance: { generalPrompts: ['What are you looking for right now?', 'What on the page might help?'], firstAfterSec: 3, gapSec: 5, directCue: 'Try the search box at the top.' },
    }),
    { id: 'wrapup', type: 'interview', title: 'Wrap-up', goal: 'Impression', questions: ['How would you describe the website to a friend?'], maxFollowUps: 0 },
  ];
  const { token, studyId } = await createStudy('Mock assistance', protocol(steps));
  const { context, page, openaiHits } = await newPage();
  await start(page, token);
  await waitIdle(page);
  await says(page, "Yes, I'm ready.");
  const session = page.getByTestId('session');
  await expect(session).toHaveAttribute('data-task-phase', 'active', { timeout: 20_000 });
  const active = await waitEvent(page, (e) => e.kind === 'task.start', 5000, 'task start');

  // Working (a click every few seconds) is not stuck: no prompt for 20 s although firstAfterSec is 3.
  const app = page.frameLocator('iframe').locator('body');
  for (let i = 0; i < 5; i++) {
    await app.click({ position: { x: 40, y: 40 } });
    await page.waitForTimeout(4000);
  }
  expect((await log(page)).some((e) => e.kind === 'task.assist')).toBe(false);

  // Then stuck: 15 s without clicks → first general prompt, said verbatim.
  const g1 = await waitEvent(page, (e) => e.kind === 'task.assist', 25_000, 'first prompt');
  expect(g1.data).toMatchObject({ level: 'general', text: 'What are you looking for right now?', via: 'stuck' });
  await waitEvent(page, (e) => e.kind === 'transcript.moderator' && e.t > g1.t && /What are you looking for right now\?/.test(String(e.data.text)), 10_000, 'prompt 1 spoken');
  await says(page, "I'm looking for a lamp but I can't see one.");
  const g2 = await waitEvent(page, (e) => e.kind === 'task.assist' && e.data.level === 'general' && e.t > g1.t, 20_000, 'second prompt');
  expect(g2.data.text).toBe('What on the page might help?');
  expect(g2.t - g1.t).toBeGreaterThanOrEqual(5000);
  const d = await waitEvent(page, (e) => e.kind === 'task.assist' && e.data.level === 'direct', 20_000, 'direct cue');
  expect(d.data.text).toBe('Try the search box at the top.');
  expect(d.t - g2.t).toBeGreaterThanOrEqual(5000);
  await waitEvent(page, (e) => e.kind === 'transcript.moderator' && e.t > d.t && /search box/.test(String(e.data.text)), 10_000, 'cue spoken');

  // Soft limit: asked once.
  await waitEvent(page, (e) => e.kind === 'moderator.nudge' && e.data.kind === 'soft_limit', 30_000, 'soft limit');
  await page.waitForTimeout(8000);
  expect((await log(page)).filter((e) => e.kind === 'moderator.nudge' && e.data.kind === 'soft_limit')).toHaveLength(1);
  expect((await log(page)).filter((e) => e.kind === 'task.assist')).toHaveLength(3);
  expect(active.t).toBeLessThan(g1.t);

  // Finish: success, but assisted with a direct cue → score 0.
  await page.getByTestId('im-done').click();
  await waitEvent(page, (e) => e.kind === 'transcript.moderator' && e.stepId === 'task_stuck' && /how do you feel/i.test(String(e.data.text)), 15_000, 'how did it go');
  await says(page, 'It was okay, I found it in the end.');
  await expect(session).toHaveAttribute('data-step', 'wrapup', { timeout: 30_000 });
  save('assistance', await log(page));
  let r: { completionScore?: number; assistance?: { general: number; direct: number }; outcome: string } | undefined;
  for (let i = 0; i < 20 && r?.completionScore == null; i++) {
    await page.waitForTimeout(500);
    r = (await lastSession(studyId)).taskResults.find((x) => x.stepId === 'task_stuck') as typeof r;
  }
  expect(r?.outcome).toBe('success');
  expect(r?.assistance).toEqual({ general: 2, direct: 1 });
  expect(r?.completionScore).toBe(0);
  expect(openaiHits.filter((u) => !u.endsWith('/v1/realtime/calls'))).toEqual([]);
  await context.close();
});

test('M6 · layout: the app gets the full height beside the panel (wide); under 900 px the panel is a bottom sheet in the flow that never covers the app, and its collapsed row keeps the status, the task and Done', async () => {
  const steps = [
    task({ id: 'task_a', title: 'Find a lamp', instruction: 'Imagine you want a new lamp for your desk. Find the Aurora desk lamp.' }),
    task({ id: 'task_b', title: 'Posters', instruction: 'Have a look at the poster section.' }),
    { id: 'wrapup', type: 'interview', title: 'Wrap-up', goal: 'Impression', questions: ['How would you describe the website to a friend?'], maxFollowUps: 0 },
  ];
  const { token } = await createStudy('Mock layout', protocol(steps));
  const { context, page, openaiHits } = await newPage();
  await start(page, token);
  await waitIdle(page);
  await page.screenshot({ path: path.join(OUT, 'layout-wide-intro.png') });
  await says(page, "Yes, I'm ready.");
  const session = page.getByTestId('session');
  await expect(session).toHaveAttribute('data-task-phase', 'active', { timeout: 20_000 });
  await waitIdle(page);

  // Wide: no bars; the iframe spans the full height and ends where the panel starts.
  await expect(session).toHaveAttribute('data-layout', 'panel');
  const frame = (await page.getByTestId('app-frame').boundingBox())!;
  const panel = (await page.getByTestId('panel').boundingBox())!;
  expect(frame.y).toBe(0);
  expect(frame.height).toBe(800);
  expect(Math.round(frame.x + frame.width)).toBeLessThanOrEqual(Math.round(panel.x));
  expect(panel.width).toBeGreaterThanOrEqual(340);
  await expect(page.getByTestId('task-instruction-text')).toContainText('Aurora desk lamp');
  await page.screenshot({ path: path.join(OUT, 'layout-wide-task.png') });
  await page.getByTestId('toggle-conversation').click();
  await expect(page.getByTestId('captions')).toContainText(/task one of two/i);
  await page.screenshot({ path: path.join(OUT, 'layout-wide-conversation.png') });
  await page.getByTestId('toggle-conversation').click();

  // Narrow: bottom sheet below the app.
  await page.setViewportSize({ width: 820, height: 900 });
  await expect(session).toHaveAttribute('data-layout', 'sheet');
  const sheet = page.getByTestId('panel');
  await expect(sheet).toHaveAttribute('data-sheet', 'closed');
  await expect(sheet).toContainText('Find a lamp');
  await expect(sheet.getByTestId('im-done')).toBeVisible();
  await expect(sheet.getByTestId('panel-status')).toBeVisible();
  const f2 = (await page.getByTestId('app-frame').boundingBox())!;
  const s2 = (await sheet.boundingBox())!;
  expect(f2.width).toBe(820);
  expect(Math.round(f2.y + f2.height)).toBeLessThanOrEqual(Math.round(s2.y));
  await page.screenshot({ path: path.join(OUT, 'layout-narrow-collapsed.png') });
  await page.getByTestId('sheet-toggle').click();
  await expect(sheet).toHaveAttribute('data-sheet', 'open');
  await expect(page.getByTestId('task-instruction-text')).toBeVisible();
  const f3 = (await page.getByTestId('app-frame').boundingBox())!;
  const s3 = (await sheet.boundingBox())!;
  expect(Math.round(f3.y + f3.height)).toBeLessThanOrEqual(Math.round(s3.y));
  expect(f3.height).toBeGreaterThan(250);
  await page.waitForTimeout(2800); // let the open animation and the task highlight settle
  await page.screenshot({ path: path.join(OUT, 'layout-narrow-open.png') });
  expect(openaiHits.filter((u) => !u.endsWith('/v1/realtime/calls'))).toEqual([]);
  await context.close();
});

// ─────────────────────────────────────────────────────────────────────────────
test('M7 · preview voice-engine switch: OpenRealtime ↔ OpenAI at any point (idle, and mid-sentence); the new engine gets the instructions and the conversation, says nothing about a dropped connection, re-says a cut-off turn; reply times per engine', async () => {
  const steps = [
    task({ id: 'task_a', title: 'Lamp', instruction: 'Find the Aurora desk lamp.' }),
    task({ id: 'task_b', title: 'Posters', instruction: 'Have a look at the poster section and tell me which one you like best.' }),
  ];
  const { token } = await createStudy('Mock engine switch', protocol(steps));
  const { context, page, openaiHits } = await newPage();
  // Both engines are local mocks (WebRTC): OpenAI's SDP endpoint is answered by newPage's route.
  const asked: (string | null)[] = [];
  await context.route('https://ort.mock/**', (r) => r.fulfill({ status: 200, contentType: 'application/sdp', body: 'v=0 mock-answer' }));
  await context.route('**/api/p/sessions/*/realtime-token', (r) => {
    const provider = (r.request().postDataJSON() as { provider?: string } | null)?.provider ?? null;
    asked.push(provider);
    const p = provider ?? 'openrealtime';
    const callsUrl = p === 'openai' ? 'https://api.openai.com/v1/realtime/calls' : 'https://ort.mock/v1/realtime/calls';
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ value: `ek_${p}`, expiresAt: 0, model: 'mock-realtime', voice: 'marin', transcription: { model: 'mock-transcribe', language: 'en' }, callsUrl, provider: p, providers: ['openrealtime', 'openai'] }),
    });
  });
  await start(page, token); // the token route offers both engines, as the server does for owner previews
  const session = page.getByTestId('session');
  const sw = page.getByTestId('engine-switch');
  await waitEvent(page, (e) => e.kind === 'transcript.moderator', 30_000, 'intro');
  await expect(sw).toHaveAttribute('data-engine', 'openrealtime');
  await waitIdle(page);

  // 1 · idle → OpenAI: the new engine gets the instructions and the conversation so far.
  const sentBefore = await page.evaluate(() => (window as unknown as { __mockRt: { sent: unknown[] } }).__mockRt.sent.length);
  await page.getByTestId('engine-openai').click();
  await expect(sw).toHaveAttribute('data-engine', 'openai', { timeout: 10_000 });
  await expect(page.getByTestId('engine-openai')).toBeEnabled();
  const after = await page.evaluate((n) => (window as unknown as { __mockRt: { sent: { type: string; session?: { instructions?: string }; item?: { content?: { text?: string }[] } }[] } }).__mockRt.sent.slice(n), sentBefore);
  expect(after.some((e) => e.type === 'session.update' && (e.session?.instructions ?? '').length > 200)).toBe(true);
  const ctx = after.find((e) => e.type === 'conversation.item.create' && /different voice system/.test(e.item?.content?.[0]?.text ?? ''));
  expect(ctx, 'conversation handed over').toBeTruthy();
  expect(ctx!.item!.content![0].text).toMatch(/moderator: /);
  let evs = await log(page);
  expect(evs.some((e) => e.kind === 'observation' && e.data.kind === 'voice_engine_switch' && e.data.to === 'openai')).toBe(true);
  expect(evs.some((e) => e.kind === 'observation' && e.data.kind === 'voice_engine' && e.data.provider === 'openai')).toBe(true);
  expect(evs.some((e) => e.kind === 'observation' && e.data.kind === 'realtime_reconnected')).toBe(false);
  expect(modLines(evs).some((t) => /connection problem/i.test(t))).toBe(false);
  // Nothing was owed (the moderator waits for "ready"): the new engine stays quiet.
  await page.waitForTimeout(1500);
  expect(modLines(await log(page)).length).toBe(modLines(evs).length);
  await waitIdle(page);

  // The session carries on with the new engine: "ready" → task one.
  await says(page, "Yes, I'm ready.", 900);
  await expect(session).toHaveAttribute('data-step', 'task_a', { timeout: 20_000 });
  await expect(page.getByTestId('engine-latency')).toContainText(/OpenAI \d+\.\d s \(\d+\)/, { timeout: 15_000 });

  // 2 · mid-sentence → back to OpenRealtime: the cut-off turn is said again by the new engine.
  await expect(session).toHaveAttribute('data-orb', 'assistant', { timeout: 15_000 });
  await page.waitForTimeout(1500); // a few words in
  const switchAt = (await log(page)).at(-1)!.t;
  await page.getByTestId('engine-openrealtime').click();
  await expect(sw).toHaveAttribute('data-engine', 'openrealtime', { timeout: 10_000 });
  // The new engine says the interrupted turn in full (whatever was heard of the old one is kept as cut).
  const again = await waitEvent(page, (e) => e.kind === 'transcript.moderator' && e.t > switchAt && e.stepId === 'task_a' && !e.data.truncated, 15_000, 'turn re-said after switch');
  expect(String(again.data.text)).toMatch(/^Task one of two\. Find the Aurora desk lamp/);
  const heard = (await log(page)).find((e) => e.kind === 'transcript.moderator' && e.t > switchAt - 3000 && e.stepId === 'task_a' && e.data.truncated);
  expect(String(heard?.data.text ?? ''), 'the words heard before the switch are kept, marked cut').toMatch(/^Task one/);
  await expect(session).toHaveAttribute('data-task-phase', 'active', { timeout: 10_000 });
  evs = await log(page);
  expect(evs.filter((e) => e.kind === 'observation' && e.data.kind === 'voice_engine_switch').map((e) => e.data.to)).toEqual(['openai', 'openrealtime']);
  expect(asked).toEqual([null, 'openai', 'openrealtime']);
  await expect(page.getByTestId('engine-switch')).toBeVisible();
  await page.screenshot({ path: path.join(OUT, 'mock-engine-switch.png') });
  save('engine-switch', evs);
  expect(openaiHits.every((u) => u.endsWith('/v1/realtime/calls'))).toBe(true);
  await context.close();
});
