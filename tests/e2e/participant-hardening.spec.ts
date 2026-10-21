// Hardening tests for the participant runtime: paths beyond the happy path, against the REAL
// server and the REAL OpenAI realtime API (gpt-realtime-2) in headless Chromium.
//
//   npx playwright test tests/e2e/participant-hardening.spec.ts
//
// Ports: API 4800, app host 4801, Vite 5800 (started automatically if not running), DATA_DIR ./data-hardening.
// Participant speech: TTS clips (tests/fixtures) mixed into the fake mic on demand (window.__taSpeak).
// Conversations are written to tests/e2e/participant-screens/hardening-*.txt for review.
import { test, expect, chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { ensureClip, ensureFixtures, clipPath, FAKE_MIC, FIXTURES_DIR } from './participant.fixtures.ts';
import { ensureFaceVideo } from './face.fixtures.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const API = 'http://localhost:4800';
const WEB = 'http://localhost:5800';
const OUT = path.join(ROOT, 'tests/e2e/participant-screens');
const CHROME = path.join(os.homedir(), '.cache/ms-playwright/chromium-1234/chrome-linux/chrome');

for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

// ── servers ──────────────────────────────────────────────────────────────────
const procs: ChildProcess[] = [];
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
      spawn('npx', ['tsx', '--env-file=../.env', 'src/index.ts'], {
        cwd: path.join(ROOT, 'server'),
        env: { ...process.env, PORT: '4800', APP_HOST_PORT: '4801', APP_HOST_URL: 'http://localhost:4801', PUBLIC_URL: WEB, DATA_DIR: './data-hardening', BUILD_MODE: 'local' },
        stdio: 'inherit',
      }),
    );
    await waitUp(`${API}/api/health`);
  }
  if (!(await up(`${WEB}/`))) {
    procs.push(spawn('npx', ['vite', '--port', '5800', '--strictPort'], { cwd: path.join(ROOT, 'web'), env: { ...process.env, PORT: '4800', VITE_NO_HMR: '1' }, stdio: 'inherit' }));
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
const BASE_MODERATION = {
  style: 'think_aloud_concurrent',
  probingLevel: 'light',
  allowClosedQuestions: false,
  silencePromptSeconds: 0,
  maxProbesPerStep: 1,
  probeOnBehavior: true,
  language: 'en',
  voice: 'marin',
  tone: 'warm, calm and strictly neutral',
  customRules: [],
  allowTextFallback: true,
};
function protocol(over: { steps: Json[]; moderation?: Json; intro?: string; closing?: string; title?: string; consent?: Json }) {
  return {
    schemaVersion: 1,
    title: over.title ?? 'Lumen Home usability study',
    researchGoals: ['Can people find a product and check out?'],
    productContext: 'Lumen Home is an online shop for furniture and lighting.',
    intro: over.intro ?? "Hi, and thanks for joining. I'm an AI moderator. We're testing the website, not you, so there are no wrong answers. Please think out loud as you go. Are you ready to begin?",
    closing: over.closing ?? "That's everything. Thank you so much for your time and your honest feedback.",
    moderation: { ...BASE_MODERATION, ...(over.moderation ?? {}) },
    consent: {
      text: '## Before we start\n\nAn **AI moderator** will guide you through a short session. We record your voice, your clicks on the website and your answers.',
      storeAudio: true,
      recordScreen: true,
      offerEyeTracking: true,
      ageGate: true,
      version: '1',
      ...(over.consent ?? {}),
    },
    steps: over.steps,
    randomizeTasks: false,
    estimatedMinutes: 5,
  };
}

/** Creates a live study with the shop app and the given protocol. Returns its link token + id. */
async function createStudy(name: string, proto: Json, withApp = true): Promise<{ token: string; studyId: string }> {
  const { study } = await call<{ study: { id: string } }>('POST', '/api/studies', { name, template: 'blank' });
  const detail = await call<{ protocols: { id: string }[]; variants: { id: string }[]; links: { token: string }[] }>('GET', `/api/studies/${study.id}`);
  await call('PUT', `/api/protocols/${detail.protocols[0].id}`, { protocol: proto });
  if (withApp) {
    const zip = new AdmZip();
    zip.addLocalFile(path.join(ROOT, 'tests/mocks/shop-app/index.html'));
    const fd = new FormData();
    fd.append('name', 'Lumen shop');
    fd.append('file', new Blob([zip.toBuffer()], { type: 'application/zip' }), 'shop.zip');
    let { app } = await call<{ app: { id: string; status: string } }>('POST', `/api/studies/${study.id}/apps`, undefined, fd);
    for (let i = 0; i < 120 && app.status !== 'ready'; i++) {
      if (app.status === 'failed') throw new Error('app build failed');
      await new Promise((r) => setTimeout(r, 500));
      ({ app } = await call<{ app: typeof app }>('GET', `/api/apps/${app.id}`));
    }
    expect(app.status).toBe('ready');
    await call('PATCH', `/api/variants/${detail.variants[0].id}`, { appId: app.id });
  }
  await call('PATCH', `/api/studies/${study.id}`, { status: 'live' });
  return { token: detail.links[0].token, studyId: study.id };
}

type SessionDetail = {
  session: { id: string; status: string; gazeErrorPx?: number | null };
  events: LogEvent[];
  taskResults: { stepId: string; outcome: string; source: string; evidence?: string }[];
  answers: { stepId: string; questionId: string; value?: number; text?: string; source: string }[];
};
async function lastSession(studyId: string): Promise<SessionDetail> {
  const { sessions } = await call<{ sessions: { id: string; startedAt?: number; createdAt?: number }[] }>('GET', `/api/studies/${studyId}/sessions`);
  return call<SessionDetail>('GET', `/api/sessions/${sessions[0].id}`);
}

// ── browser helpers ──────────────────────────────────────────────────────────
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
function fmtLog(evs: LogEvent[]) {
  return evs
    .filter((e) => !['mouse', 'gaze', 'speech.start', 'speech.stop', 'app.scroll', 'app.focus'].includes(e.kind))
    .map((e) => `${(e.t / 1000).toFixed(1).padStart(6)}s ${e.kind.padEnd(22)} ${e.kind.startsWith('transcript') ? `${e.data.phase ? `[${String(e.data.phase)}] ` : ''}${String(e.data.text)}` : JSON.stringify(e.data).slice(0, 300)}`)
    .join('\n');
}
async function waitEvent(page: Page, pred: (e: LogEvent) => boolean, ms = 60_000, label = 'event') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = (await log(page)).find(pred);
    if (hit) return hit;
    await page.waitForTimeout(400);
  }
  throw new Error(`Timed out waiting for ${label}. Log:\n${fmtLog(await log(page))}`);
}
const clipB64 = new Map<string, string>();
async function speak(page: Page, clip: string) {
  let b64 = clipB64.get(clip);
  if (!b64) {
    const file = fs.existsSync(clipPath(clip as never)) ? clipPath(clip as never) : path.join(FIXTURES_DIR, `${clip}.wav`);
    b64 = fs.readFileSync(file).toString('base64');
    clipB64.set(clip, b64);
  }
  return page.evaluate((b) => (window as unknown as { __taSpeak: (b: string) => Promise<number> }).__taSpeak(b), b64);
}
/** Wait until the moderator is quiet (not speaking, no active response) for `quietMs`. */
async function waitModeratorIdle(page: Page, quietMs = 1200, ms = 60_000) {
  const t0 = Date.now();
  let since = 0;
  while (Date.now() - t0 < ms) {
    const orb = await page.getAttribute('[data-testid=session]', 'data-orb');
    if (orb === 'listening' || orb === 'muted' || orb === 'offline') {
      if (!since) since = Date.now();
      if (Date.now() - since >= quietMs) return;
    } else since = 0;
    await page.waitForTimeout(150);
  }
  throw new Error('moderator never went idle');
}
async function waitDone(page: Page, ms = 90_000) {
  try {
    await expect(page.getByTestId('done')).toBeVisible({ timeout: ms });
  } catch {
    const trace = await page.evaluate(() => (window as unknown as { __taRunner?: { rt?: { trace: string[] } } }).__taRunner?.rt?.trace ?? []).catch(() => []);
    throw new Error(`Session never finished. Log:\n${fmtLog(await log(page).catch(() => []))}\nRealtime trace:\n${trace.join('\n')}`);
  }
}
const modLines = (evs: LogEvent[], after = -1) => evs.filter((e) => e.kind === 'transcript.moderator' && e.t > after).map((e) => String(e.data.text));
function save(name: string, evs: LogEvent[]) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `hardening-${name}.txt`), fmtLog(evs));
}
async function shot(page: Page, name: string) {
  fs.mkdirSync(OUT, { recursive: true });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, `h-${name}.png`), timeout: 10_000 }).catch((e) => console.warn('screenshot failed', name, (e as Error).message));
}

/** Moderator lines that narrate tool use or are filler that breaks the flow. */
const FILLER =
  /\b(let me (note|record|write|save|log|check|get|look|capture)|i('ll| will) (note|record|write|save|log|capture)|(noting|recording|saving|capturing) (that|this|your)|one moment|just a (moment|second|sec)|bear with me|give me a (moment|second)|i have what i need|(that'?s|it'?s|all) noted|got (that|it) down|i('ve| have) (noted|recorded|captured|got) (that|it|your)|making a note|wrap (up )?(this|that)( part)?( up)?|(one|a) quick follow-?up|so we can (continue|move on))\b/i;
/** Praise / outcome disclosure. */
const JUDGEMENT = /\b(great job|well done|perfect|correct(ly)?|you did it|success(fully)?|nice work|good job|you (failed|got it)|ran out of time|too (long|slow)|unfortunately)\b/i;

/** Moderator speech overlapping participant speech (moderator started talking while the participant was mid-utterance). */
function talkOvers(evs: LogEvent[]) {
  let userSpeaking = false;
  const hits: number[] = [];
  for (const e of evs) {
    if (e.kind === 'speech.start' && e.data.who === 'participant') userSpeaking = true;
    if (e.kind === 'speech.stop' && e.data.who === 'participant') userSpeaking = false;
    if (e.kind === 'speech.start' && e.data.who === 'moderator' && userSpeaking) hits.push(e.t);
  }
  return hits;
}

// Failure screenshots can block forever while an iframe renderer is hung (crash test).
test.use({ screenshot: 'off' });

let browser: Browser;
async function launch(extraArgs: string[] = []) {
  return chromium.launch({
    headless: true,
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${FAKE_MIC}`, '--autoplay-policy=no-user-gesture-required', ...extraArgs],
  });
}

async function newSessionPage(b: Browser, opts: { viewport?: { width: number; height: number } } = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await b.newContext({ viewport: opts.viewport ?? { width: 1280, height: 800 }, permissions: ['microphone', 'camera'] });
  await context.addInitScript(MIC_HOOK);
  const page = await context.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (t.includes('[realtime]') || t.includes('[runner]') || t.includes('[eyetracking]')) console.log(`[browser:${m.type()}] ${t}`);
  });
  return { context, page };
}

/** Landing → consent → device check → session (voice). */
async function enterSession(page: Page, token: string, o: { eye?: boolean; voice?: boolean } = {}) {
  await page.goto(`${WEB}/s/${token}`);
  await page.getByTestId('get-started').click();
  if (o.voice === false) await page.getByTestId('opt-voice').click();
  if (o.eye) await page.getByTestId('opt-eye').click();
  await page.getByTestId('opt-age').click();
  await page.getByTestId('accept-consent').click();
  await expect(page.getByTestId('device-check')).toBeVisible();
  if (o.voice !== false) {
    await expect(page.getByTestId('mic-meter')).toBeVisible({ timeout: 20_000 });
    await speak(page, 'mic_check');
    await expect(page.getByText('We can hear you.')).toBeVisible({ timeout: 20_000 });
  }
  await page.getByTestId('device-continue').click();
}

/** Intro → "ready" → first step entered. */
async function passIntro(page: Page, readyClip = 'ready') {
  await waitEvent(page, (e) => e.kind === 'transcript.moderator', 60_000, 'moderator intro');
  await waitModeratorIdle(page);
  await speak(page, readyClip);
  await waitEvent(page, (e) => e.kind === 'moderator.tool' && e.data.name === 'complete_step' && e.data.ok === true, 45_000, 'complete_step after intro');
}

const CLIPS: Record<string, string> = {
  crash_huh: 'Oh. Hmm, the page just stopped. I clicked place order and now nothing reacts.',
  blank: 'Whoa, the whole page went blank. There is nothing there anymore.',
  wander: 'Okay, I am looking around the shop. Let me look at lighting, and then decor, and back again.',
  rage_think: 'Hmm, I want to add gift wrap. This box here, I click it, and nothing happens.',
  probe_answer: 'I thought clicking it would add gift wrapping to my order, but nothing changed, so I kept clicking.',
  done_en: 'Okay, I think I have seen everything I wanted to see there.',
  how_went: 'It went okay, I think. A couple of things did not react the way I expected.',
  sus_voice: 'For the first statement I would say four. And for the second one, two.',
  seq_five: 'Hmm, I would give it a five.',
  probe_short: 'I was just looking around.',
  ready_de: 'Ja, ich bin bereit. Wir können anfangen.',
  think_de: 'Okay, ich suche jetzt die Lampe. Ich schaue mal unter Beleuchtung.',
  done_de: 'Ich bin jetzt fertig mit der Aufgabe.',
  went_de: 'Das lief eigentlich ganz gut, ich habe die Lampe schnell gefunden.',
};

test.beforeAll(async () => {
  test.setTimeout(300_000);
  await ensureFixtures();
  await Promise.all(Object.entries(CLIPS).map(([n, t]) => ensureClip(n, t)));
  await ensureServers();
  await call('POST', '/api/auth/signup', { email: `hardening-${Date.now()}@example.com`, password: 'password123', name: 'Hardening Researcher' });
  browser = await launch();
});

test.afterAll(async () => {
  await browser?.close();
  for (const p of procs) p.kill('SIGTERM');
});

const shopTask = (over: Json = {}) => ({
  id: 'task_checkout',
  type: 'task',
  title: 'Check out',
  instruction: 'Imagine you already have a lamp in your cart. Go ahead and place your order.',
  startPath: '/checkout',
  successCriteria: 'The order is placed.',
  successRules: [],
  timeLimitSec: 600,
  probes: [],
  askSEQ: false,
  ...over,
});
const wrapup = { id: 'wrapup', type: 'interview', title: 'Wrap-up', goal: 'Overall impression', questions: ['How would you describe the website to a friend?'], maxFollowUps: 0 };

// ─────────────────────────────────────────────────────────────────────────────
test('1 · app crash detection: error, freeze and white screen → app.crash, gentle moderator, reload, session continues', async () => {
  test.setTimeout(6 * 60_000);
  const { token, studyId } = await createStudy('Crash', protocol({ steps: [shopTask()], moderation: { probeOnBehavior: false } }));
  const { context, page } = await newSessionPage(browser);
  await enterSession(page, token);
  await passIntro(page);
  const session = page.getByTestId('session');
  await expect(session).toHaveAttribute('data-step', 'task_checkout');
  await waitEvent(page, (e) => e.kind === 'app.ready', 20_000, 'probe hello');
  await expect(session).toHaveAttribute('data-task-phase', 'active', { timeout: 40_000 });
  await waitModeratorIdle(page);
  const app = page.frameLocator('[data-testid=app-frame]');

  // (a) A plain runtime error is logged but is not a crash.
  await app.getByRole('button', { name: 'Apply coupon' }).click();
  await waitEvent(page, (e) => e.kind === 'app.error', 10_000, 'app.error');
  await page.waitForTimeout(2500);
  expect((await log(page)).some((e) => e.kind === 'app.crash')).toBe(false);
  await expect(page.getByTestId('reload-app')).toHaveCount(0);

  // (b) Freeze: the app's main thread never yields → heartbeat lost → app.crash.
  const frame = page.frames().find((f) => f.url().includes(':4801'))!;
  await frame.evaluate(() => setTimeout(() => (document.querySelector('#place-order') as HTMLElement).click(), 50));
  const crash1 = await waitEvent(page, (e) => e.kind === 'app.crash', 15_000, 'app.crash (freeze)');
  console.log('crash 1:', crash1.data);
  await expect(page.getByTestId('reload-app')).toBeVisible();
  // The wrapper itself stays responsive while the app is frozen.
  expect(await page.evaluate(() => 1 + 1)).toBe(2);
  const line1 = await waitEvent(page, (e) => e.kind === 'transcript.moderator' && e.t > crash1.t, 30_000, 'moderator reaction to crash');
  console.log('after crash:', line1.data.text);
  expect(String(line1.data.text)).toMatch(/reload|refresh/i);
  expect(String(line1.data.text)).not.toMatch(/you (broke|did something wrong|caused)|(it was|is) your fault|your mistake/i);
  // (no screenshot here: capturing a page whose iframe renderer is hung blocks)
  await waitModeratorIdle(page);
  // The participant reacts; the moderator stays brief and does not discuss the bug.
  await speak(page, 'crash_huh');
  await page.waitForTimeout(4000);
  await waitModeratorIdle(page, 1500);
  await page.getByTestId('reload-app').click();
  const ready2 = await waitEvent(page, (e) => e.kind === 'app.ready' && e.t > crash1.t, 20_000, 'app.ready after reload');
  await expect(page.getByTestId('reload-app')).toHaveCount(0);
  await expect(app.getByRole('heading', { name: 'Checkout' })).toBeVisible();

  // (c) White screen: the app tears down its UI and throws → app.crash (blank screen).
  await page.waitForTimeout(1500);
  await app.getByRole('button', { name: 'Track order' }).click();
  const crash2 = await waitEvent(page, (e) => e.kind === 'app.crash' && e.t > ready2.t, 15_000, 'app.crash (white screen)');
  console.log('crash 2:', crash2.data);
  await expect(page.getByTestId('reload-app')).toBeVisible();
  await shot(page, 'crash-white');
  await waitModeratorIdle(page, 1500);
  await page.getByTestId('reload-app').click();
  await waitEvent(page, (e) => e.kind === 'app.ready' && e.t > crash2.t, 20_000, 'app.ready after 2nd reload');
  await expect(app.getByRole('heading', { name: 'Checkout' })).toBeVisible();

  // The session continues normally: the task is still active, then the participant skips it.
  await expect(session).toHaveAttribute('data-task-phase', 'active');
  await waitModeratorIdle(page);
  await page.getByTestId('skip-task').click();
  await waitDone(page);
  const d = await lastSession(studyId);
  save('crash', d.events);
  expect(d.session.status).toBe('completed');
  const crashes = d.events.filter((e) => e.kind === 'app.crash');
  expect(crashes.map((c) => c.data.reason)).toEqual(['heartbeat lost', 'blank screen']);
  expect(d.events.filter((e) => e.kind === 'observation' && e.data.kind === 'app_reload').length).toBe(2);
  expect(d.taskResults[0]).toMatchObject({ outcome: 'abandoned', source: 'participant' });
  for (const l of modLines(d.events)) expect(l).not.toMatch(JUDGEMENT);
  await context.close();
});

// ─────────────────────────────────────────────────────────────────────────────
test('2b · silence nudges: none while the participant is clicking, at most 3 with backoff, then one check-in after ~90 s', async () => {
  test.setTimeout(7 * 60_000);
  const task = shopTask({ id: 'task_quiet', title: 'Look around', instruction: 'Imagine you are furnishing a new flat. Look around the shop for anything that catches your eye.', startPath: '/' });
  const { token } = await createStudy('Nudges', protocol({ steps: [task, wrapup], moderation: { silencePromptSeconds: 8 } }));
  const { context, page } = await newSessionPage(browser);
  await enterSession(page, token);
  await passIntro(page);
  const session = page.getByTestId('session');
  await expect(session).toHaveAttribute('data-task-phase', 'active', { timeout: 40_000 });
  await waitModeratorIdle(page);
  // 30 s of silent but busy clicking: working, not stuck → no nudge.
  const app = page.frameLocator('[data-testid=app-frame]');
  const busyFrom = (await log(page)).at(-1)!.t;
  for (let i = 0; i < 8; i++) {
    await app.getByRole('link', { name: ['Lighting', 'Decor', 'Furniture'][i % 3], exact: true }).click();
    await page.waitForTimeout(3800);
  }
  expect((await log(page)).filter((e) => e.kind === 'moderator.nudge' && e.t > busyFrom), 'no nudge while clicking').toEqual([]);
  // Idle: three nudges with growing gaps, then quiet.
  await waitEvent(page, (e) => e.kind === 'moderator.nudge' && e.data.n === 3, 90_000, 'third nudge');
  await page.waitForTimeout(40_000);
  let nudges = (await log(page)).filter((e) => e.kind === 'moderator.nudge');
  expect(nudges.length, 'capped at 3').toBe(3);
  const gaps = nudges.slice(1).map((n, i) => n.t - nudges[i].t);
  console.log('nudge times (s):', nudges.map((n) => (n.t / 1000).toFixed(0)), 'silence (s):', nudges.map((n) => n.data.silentSec));
  expect(Number(nudges[0].data.silentSec)).toBeGreaterThanOrEqual(8);
  expect(Number(nudges[1].data.silentSec)).toBeGreaterThanOrEqual(12);
  expect(Number(nudges[2].data.silentSec)).toBeGreaterThanOrEqual(16);
  expect(gaps[1]).toBeGreaterThan(gaps[0]); // backoff
  // One neutral check-in after ~90 s of silence and inactivity.
  const checkIn = await waitEvent(page, (e) => e.kind === 'moderator.nudge' && e.data.kind === 'check_in', 90_000, 'check-in');
  expect(Number(checkIn.data.silentSec)).toBeGreaterThanOrEqual(90);
  const line = await waitEvent(page, (e) => e.kind === 'transcript.moderator' && e.t > checkIn.t, 30_000, 'check-in line');
  console.log('check-in:', line.data.text);
  expect(String(line.data.text)).toMatch(/keep going|move on|continue/i);
  expect(String(line.data.text)).not.toMatch(JUDGEMENT);
  await waitModeratorIdle(page);
  await page.waitForTimeout(15_000);
  nudges = (await log(page)).filter((e) => e.kind === 'moderator.nudge');
  expect(nudges.length, 'nothing after the check-in').toBe(4);
  const lines = modLines(await log(page), busyFrom);
  expect(new Set(lines).size, 'nudges are not repeated verbatim').toBe(lines.length);
  save('nudges', await log(page));
  await page.getByTestId('skip-task').click();
  await context.close();
});

// ─────────────────────────────────────────────────────────────────────────────
/** Back-and-forth navigation, rage + dead clicks on a fake button, and a JS error — while thinking aloud. */
async function misbehave(page: Page) {
  const app = page.frameLocator('[data-testid=app-frame]');
  const speech = speak(page, 'wander');
  for (const name of ['Lighting', 'Decor', 'Lighting', 'Decor']) {
    await app.getByRole('link', { name, exact: true }).click();
    await page.waitForTimeout(900);
  }
  await speech;
  await app.getByRole('link', { name: /Cart/ }).click();
  await app.getByRole('link', { name: 'Checkout' }).click();
  await page.waitForTimeout(800);
  const speech2 = speak(page, 'rage_think');
  const gift = app.locator('#gift-wrap');
  for (let i = 0; i < 4; i++) await gift.click({ delay: 0 });
  await page.waitForTimeout(1500);
  await gift.click();
  await page.waitForTimeout(1200);
  await app.getByRole('button', { name: 'Apply coupon' }).click();
  await speech2;
  await page.waitForTimeout(2500);
}

const OPEN_Q = /^(?:[^?]*?[.!]\s+)?(what|how|tell me|can you tell me|could you tell me|walk me|which|where|why)\b/i;
const LEADING = /\b(frustrat|annoy|confus|error|bug|broken|wrong|problem|struggl|difficult|hard|easy|fail)/i;

const probeTask = shopTask({
  id: 'task_gift',
  title: 'Buy a present',
  instruction: 'Imagine you are buying a present for a friend. Look around the shop, then add gift wrap at checkout.',
  startPath: '/',
  successCriteria: 'Gift wrap is added at checkout.',
  probes: ['How did you decide where to look?'],
});

test('2 · behaviour probes: asked after the task, open + neutral, within maxProbesPerStep; none when probing is off', async () => {
  test.setTimeout(9 * 60_000);
  for (const probingLevel of ['moderate', 'none'] as const) {
    const { token, studyId } = await createStudy(`Probes ${probingLevel}`, protocol({ steps: [probeTask, wrapup], moderation: { probingLevel, maxProbesPerStep: 1, probeOnBehavior: true, silencePromptSeconds: 0 } }));
    const { context, page } = await newSessionPage(browser);
    await enterSession(page, token);
    await passIntro(page);
    const session = page.getByTestId('session');
    await expect(session).toHaveAttribute('data-task-phase', 'active', { timeout: 40_000 });
    await waitModeratorIdle(page);
    const taskStart = (await log(page)).find((e) => e.kind === 'task.start')!;
    await misbehave(page);
    const during = await log(page);
    for (const k of ['app.rage_click', 'app.dead_click', 'app.error']) expect(during.some((e) => e.kind === k), `${k} captured`).toBe(true);
    // Nothing is asked while the participant works (no mid-task probes, nudges are off).
    expect(modLines(during, taskStart.t), 'moderator silent during the task').toEqual([]);
    const checks = await page.evaluate(() => (window as unknown as { __taRunner: { turnChecks: unknown[] } }).__taRunner.turnChecks);
    console.log(`[${probingLevel}] turn checks during task:`, JSON.stringify(checks));
    expect((checks as { addressed: boolean }[]).every((c) => !c.addressed)).toBe(true);

    await page.getByTestId('im-done').click();
    const doneAt = (await log(page)).filter((e) => e.kind === 'observation' && e.data.kind === 'participant_done_button').pop()!.t;
    await waitEvent(page, (e) => e.kind === 'transcript.moderator' && e.t > doneAt, 30_000, 'how did it go');
    await waitModeratorIdle(page);
    await speak(page, 'how_went');
    const end = await waitEvent(page, (e) => e.kind === 'task.end', 45_000, 'task.end via set_task_outcome');
    expect(end.data.source).toBe('ai');
    if (probingLevel === 'moderate') {
      const probe = await waitEvent(page, (e) => e.kind === 'moderator.probe', 45_000, 'post-task behaviour probe');
      const text = String(probe.data.text);
      console.log('probe:', text, '| observed:', probe.data.observed);
      expect(probe.t).toBeGreaterThan(end.t);
      expect(text).toMatch(OPEN_Q);
      expect(text).not.toMatch(LEADING);
      await waitModeratorIdle(page);
      await speak(page, 'probe_answer');
    }
    await waitEvent(page, (e) => e.kind === 'step.enter' && e.stepId === 'wrapup', 60_000, 'next step');
    const evs = await log(page);
    save(`probes-${probingLevel}`, evs);
    const post = evs.filter((e) => e.kind === 'transcript.moderator' && e.t > end.t && e.stepId === 'task_gift').map((e) => String(e.data.text));
    const questions = post.filter((l) => /\?/.test(l));
    console.log(`[${probingLevel}] post-task lines:`, post);
    // Budget: maxProbesPerStep = 1 → at most one follow-up question after the task; none when off.
    expect(questions.length).toBeLessThanOrEqual(probingLevel === 'none' ? 0 : 1);
    expect(evs.filter((e) => e.kind === 'moderator.probe').length).toBe(probingLevel === 'none' ? 0 : 1);
    expect(talkOvers(evs), 'moderator never starts talking over the participant').toEqual([]);
    for (const l of modLines(evs)) {
      expect(l).not.toMatch(JUDGEMENT);
      expect(l).not.toMatch(FILLER);
    }
    void studyId;
    await context.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
test('3 · task time limit → outcome timeout, neutral wrap-up, session continues', async () => {
  test.setTimeout(5 * 60_000);
  const timed = shopTask({ id: 'task_timed', title: 'Find a vase', instruction: 'Imagine you want a vase for your living room. Find one you like.', startPath: '/', timeLimitSec: 20, askSEQ: true, probes: [] });
  const { token, studyId } = await createStudy('Timeout', protocol({ steps: [timed, wrapup] }));
  const { context, page } = await newSessionPage(browser);
  await enterSession(page, token);
  await passIntro(page);
  const session = page.getByTestId('session');
  await expect(session).toHaveAttribute('data-task-phase', 'active', { timeout: 40_000 });
  const start = (await log(page)).find((e) => e.kind === 'task.start')!;
  // The dock shows the countdown.
  await expect(page.getByTestId('task-text')).toContainText(/left/);
  const end = await waitEvent(page, (e) => e.kind === 'task.end', 45_000, 'task.end (timeout)');
  expect(end.data).toMatchObject({ outcome: 'timeout', source: 'rule' });
  expect(Number(end.data.durationMs)).toBeGreaterThanOrEqual(19_000);
  expect(end.t - start.t).toBeLessThan(32_000);
  await expect(session).toHaveAttribute('data-task-phase', 'post');
  const wrap = await waitEvent(page, (e) => e.kind === 'transcript.moderator' && e.t > end.t, 30_000, 'neutral wrap-up');
  console.log('after timeout:', wrap.data.text);
  expect(String(wrap.data.text)).not.toMatch(JUDGEMENT);
  expect(String(wrap.data.text)).not.toMatch(/\b(time('s| is)? up|out of time|didn'?t (make|finish|manage)|not able|fail)/i);
  expect(String(wrap.data.text)).toMatch(/difficult or easy/i); // goes straight on to the SEQ
  await shot(page, 'timeout-seq');
  await waitModeratorIdle(page);
  await page.locator('[data-testid=question-card] [data-value="3"]').click();
  const clicked = await waitEvent(page, (e) => e.kind === 'answer' && e.data.questionId === 'seq', 10_000, 'seq answer');
  await waitEvent(page, (e) => e.kind === 'transcript.moderator' && e.t > clicked.t, 30_000, 'reaction to on-screen answer');
  await page.waitForTimeout(1500);
  await waitModeratorIdle(page, 1500);
  // Light probing allows one open follow-up on a low SEQ rating.
  if ((await session.getAttribute('data-step')) === 'task_timed') await speak(page, 'probe_short');
  await waitEvent(page, (e) => e.kind === 'step.enter' && e.stepId === 'wrapup', 60_000, 'next step after timeout');
  for (const l of modLines(await log(page))) expect(l).not.toMatch(FILLER);
  const d = await lastSession(studyId);
  save('timeout', d.events);
  expect(d.taskResults.find((r) => r.stepId === 'task_timed')).toMatchObject({ outcome: 'timeout', source: 'rule' });
  expect(d.answers.find((a) => a.questionId === 'seq')).toMatchObject({ value: 3, source: 'screen' });
  // No redundant AI outcome after the rule decided.
  const after = d.events.filter((e) => e.kind === 'moderator.tool' && e.data.name === 'set_task_outcome');
  for (const a of after) expect(a.data).toMatchObject({ ok: true });
  await context.close();
});

// ─────────────────────────────────────────────────────────────────────────────
const SUS_VALUES = [4, 2, 5, 1, 4, 2, 5, 1, 4, 2]; // → SUS 85
const TLX_VALUES: Record<string, number> = { tlx_mental: 40, tlx_physical: 10, tlx_temporal: 25, tlx_performance: 20, tlx_effort: 35, tlx_frustration: 15 };

test('4 · on-screen SUS + NASA-TLX by clicking, SUS partly by voice → ids stored, SUS score in analytics', async () => {
  test.setTimeout(8 * 60_000);
  const steps = [
    { id: 'sus', type: 'questionnaire', title: 'About the website', instrument: 'SUS', productName: 'the website', onScreen: true },
    { id: 'tlx', type: 'questionnaire', title: 'Workload', instrument: 'NASA_TLX', onScreen: true },
  ];
  const { token, studyId } = await createStudy('Questionnaires', protocol({ steps, moderation: { probingLevel: 'none' } }), false);

  for (const mode of ['click', 'voice'] as const) {
    const { context, page } = await newSessionPage(browser);
    await enterSession(page, token);
    await passIntro(page);
    const card = page.getByTestId('questionnaire-card');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.locator('li[data-qid]')).toHaveCount(10);
    await waitModeratorIdle(page);
    const enteredSus = (await log(page)).find((e) => e.kind === 'step.enter' && e.stepId === 'sus')!;
    let from = 0;
    if (mode === 'voice') {
      await speak(page, 'sus_voice');
      await waitEvent(page, (e) => e.kind === 'answer' && e.data.questionId === 'sus_2', 30_000, 'sus_2 by voice');
      await expect(card.locator('li[data-qid=sus_1] [data-value="4"]')).toHaveAttribute('aria-checked', 'true');
      await expect(card.locator('li[data-qid=sus_2] [data-value="2"]')).toHaveAttribute('aria-checked', 'true');
      await expect(card.getByTestId('voice-answer')).toHaveCount(2);
      await shot(page, 'sus-voice');
      from = 2;
      await page.waitForTimeout(2000);
      // Recording by voice is silent: no spoken comment on the ratings.
      const said = modLines(await log(page), enteredSus.t).slice(1);
      console.log('moderator after voice ratings:', said);
      for (const l of said) expect(l.split(/\s+/).length).toBeLessThanOrEqual(4);
    }
    for (let i = from; i < 10; i++) await card.locator(`li[data-qid=sus_${i + 1}] [data-value="${SUS_VALUES[i]}"]`).click();
    await expect(card).toContainText('All answered');
    if (mode === 'click') await shot(page, 'sus-click');
    await card.getByRole('button', { name: 'Submit' }).click();
    // NASA-TLX: 0–100 sliders.
    await waitEvent(page, (e) => e.kind === 'step.enter' && e.stepId === 'tlx', 20_000, 'TLX step');
    const tlx = page.getByTestId('questionnaire-card');
    await expect(tlx.locator('li[data-qid]')).toHaveCount(6);
    for (const [id, v] of Object.entries(TLX_VALUES)) await tlx.locator(`li[data-qid=${id}] input[type=range]`).fill(String(v));
    await expect(tlx).toContainText('All answered');
    if (mode === 'click') await shot(page, 'tlx');
    await tlx.getByRole('button', { name: 'Submit' }).click();
    await waitDone(page);
    const d = await lastSession(studyId);
    save(`questionnaire-${mode}`, d.events);
    const byId = Object.fromEntries(d.answers.map((a) => [a.questionId, a]));
    for (let i = 0; i < 10; i++) {
      expect(byId[`sus_${i + 1}`], `sus_${i + 1}`).toMatchObject({ stepId: 'sus', value: SUS_VALUES[i] });
      expect(byId[`sus_${i + 1}`].source).toBe(mode === 'voice' && i < 2 ? 'voice' : 'screen');
    }
    for (const [id, v] of Object.entries(TLX_VALUES)) expect(byId[id], id).toMatchObject({ stepId: 'tlx', value: v, source: 'screen' });
    for (const l of modLines(d.events)) expect(l).not.toMatch(FILLER);
    await context.close();
  }
  const { sessions } = await call<{ sessions: { status: string; sus?: number | null }[] }>('GET', `/api/studies/${studyId}/sessions`);
  expect(sessions.filter((s) => s.status === 'completed').map((s) => s.sus)).toEqual([85, 85]);
  const analytics = await call<{ variants: { susScores: number[]; instrumentN: Record<string, number> }[] }>('GET', `/api/studies/${studyId}/analytics`);
  expect(analytics.variants[0].susScores).toEqual([85, 85]);
  expect(analytics.variants[0].instrumentN).toMatchObject({ SUS: 2, NASA_TLX: 2 });
});

// ─────────────────────────────────────────────────────────────────────────────
const CALLS = 'https://api.openai.com/v1/realtime/calls';
const lampTask = shopTask({
  id: 'task_lamp',
  title: 'Find a desk lamp',
  instruction: 'Imagine you want a new lamp for your desk. Find the Aurora desk lamp and add it to your cart.',
  startPath: '/',
  successCriteria: 'The Aurora desk lamp is in the cart.',
  successRules: [{ type: 'url_matches', pattern: '^/cart' }],
  askSEQ: false,
});
const rtTrace = (page: Page) => page.evaluate(() => (window as unknown as { __taRunner?: { rt?: { trace: string[] } } }).__taRunner?.rt?.trace ?? []);

test('5a · realtime unavailable: one retry, then on-screen mode with the step content, session completes', async () => {
  test.setTimeout(4 * 60_000);
  // Second task has no startPath: it must continue where the participant is (the cart), not reset to "/".
  const continueTask = shopTask({ id: 'task_continue', title: 'Continue', instruction: 'Now continue to checkout from where you are.', startPath: undefined, askSEQ: false });
  const { token, studyId } = await createStudy('Realtime down', protocol({ steps: [lampTask, continueTask, wrapup] }));
  const { context, page } = await newSessionPage(browser);
  let attempts = 0;
  await context.route(CALLS, (r) => {
    attempts++;
    return r.abort('connectionfailed');
  });
  await enterSession(page, token);
  const session = page.getByTestId('session');
  await expect(session).toHaveAttribute('data-mode', 'manual', { timeout: 40_000 });
  expect(attempts).toBe(2); // first attempt + exactly one retry
  const panel = page.getByTestId('manual-panel');
  await expect(panel).toContainText(/on screen/);
  await expect(panel).toContainText("I'm an AI moderator");
  await shot(page, 'rt-down-intro');
  await page.getByTestId('manual-continue').click();
  // Task: the instruction is on screen in the dock, the app is usable.
  await expect(session).toHaveAttribute('data-step', 'task_lamp');
  await expect(page.getByTestId('task-text')).toContainText('Aurora desk lamp');
  await expect(page.getByTestId('dock-notice')).toContainText(/on screen/);
  const app = page.frameLocator('[data-testid=app-frame]');
  await app.getByRole('link', { name: 'Lighting' }).click();
  await app.getByRole('link', { name: /Aurora desk lamp/ }).click();
  await app.getByRole('button', { name: 'Add to cart' }).click();
  await expect(session).toHaveAttribute('data-task-phase', 'post', { timeout: 10_000 });
  await page.getByTestId('manual-continue').first().click();
  // Task without startPath: the app stays on the cart page.
  await expect(session).toHaveAttribute('data-step', 'task_continue');
  const entered = (await log(page)).filter((e) => e.kind === 'step.enter' && e.stepId === 'task_continue').pop()!;
  await page.waitForTimeout(2500);
  await expect(app.getByRole('heading', { name: 'Your cart' })).toBeVisible();
  expect((await log(page)).filter((e) => e.kind === 'app.navigate' && e.t >= entered.t), 'no navigation on entering a task without startPath').toEqual([]);
  await page.getByTestId('skip-task').click();
  await expect(session).toHaveAttribute('data-task-phase', 'post', { timeout: 10_000 });
  await page.getByTestId('manual-continue').first().click();
  // Interview question on screen, answered by typing.
  await expect(session).toHaveAttribute('data-step', 'wrapup');
  await expect(page.getByTestId('question-card')).toContainText('describe the website to a friend');
  await page.getByTestId('question-card').locator('textarea').fill('A calm little shop with clear categories.');
  await page.getByRole('button', { name: 'Save answer' }).click();
  await page.getByTestId('manual-continue').click();
  await page.getByTestId('manual-continue').click(); // Finish
  await waitDone(page);
  const d = await lastSession(studyId);
  save('realtime-down', d.events);
  expect(d.session.status).toBe('completed');
  expect(d.events.some((e) => e.kind === 'session.error' && e.data.fallback === 'manual')).toBe(true);
  expect(d.taskResults.find((r) => r.stepId === 'task_lamp')).toMatchObject({ outcome: 'success', source: 'rule' });
  expect(d.taskResults.find((r) => r.stepId === 'task_continue')).toMatchObject({ outcome: 'abandoned' });
  expect(d.answers.find((a) => a.questionId === 'wrapup_q1')?.text).toContain('calm little shop');
  await context.close();
});

test('5b · data channel drops mid-session: reconnects once and continues; a second drop → on-screen mode', async () => {
  test.setTimeout(5 * 60_000);
  const { token, studyId } = await createStudy('Realtime drop', protocol({ steps: [lampTask, wrapup] }));
  const { context, page } = await newSessionPage(browser);
  let attempts = 0;
  let block = false;
  await context.route(CALLS, (r) => {
    attempts++;
    return block ? r.abort('connectionfailed') : r.continue();
  });
  await enterSession(page, token);
  await passIntro(page);
  const session = page.getByTestId('session');
  await expect(session).toHaveAttribute('data-task-phase', 'active', { timeout: 40_000 });
  await waitModeratorIdle(page);
  expect(attempts).toBe(1);
  void rtTrace;

  // Drop 1: the data channel closes → one reconnect → the moderator resumes the same task.
  await page.evaluate(() => (window as unknown as { __taRunner: { rt: { dc: RTCDataChannel } } }).__taRunner.rt.dc.close());
  const rec = await waitEvent(page, (e) => e.kind === 'observation' && e.data.kind === 'realtime_reconnected', 30_000, 'reconnected');
  expect(attempts).toBe(2);
  const line = await waitEvent(page, (e) => e.kind === 'transcript.moderator' && e.t > rec.t, 30_000, 'moderator after reconnect');
  console.log('after reconnect:', line.data.text);
  expect(await session.getAttribute('data-mode')).toBe('voice');
  await expect(session).toHaveAttribute('data-step', 'task_lamp');
  expect(String(line.data.text)).not.toMatch(/Hi, and thanks for joining/); // does not restart
  await waitModeratorIdle(page);
  await expect(session).toHaveAttribute('data-task-phase', 'active');

  // Drop 2 (network gone): → on-screen mode with the task still visible.
  block = true;
  await page.evaluate(() => (window as unknown as { __taRunner: { rt: { dc: RTCDataChannel } } }).__taRunner.rt.dc.close());
  await expect(session).toHaveAttribute('data-mode', 'manual', { timeout: 30_000 });
  await expect(page.getByTestId('dock-notice')).toContainText(/on screen/);
  await expect(page.getByTestId('task-text')).toContainText('Aurora desk lamp');
  await shot(page, 'rt-drop-manual');
  const app = page.frameLocator('[data-testid=app-frame]');
  await app.getByRole('link', { name: 'Lighting' }).click();
  await app.getByRole('link', { name: /Aurora desk lamp/ }).click();
  await app.getByRole('button', { name: 'Add to cart' }).click();
  await expect(session).toHaveAttribute('data-task-phase', 'post', { timeout: 10_000 });
  await page.getByTestId('manual-continue').first().click();
  await expect(session).toHaveAttribute('data-step', 'wrapup');
  await page.getByTestId('question-card').locator('textarea').fill('Simple and clear.');
  await page.getByRole('button', { name: 'Save answer' }).click();
  await page.getByTestId('manual-continue').click();
  await page.getByTestId('manual-continue').click();
  await waitDone(page);
  const d = await lastSession(studyId);
  save('realtime-drop', d.events);
  expect(d.session.status).toBe('completed');
  expect(d.events.filter((e) => e.kind === 'observation' && e.data.kind === 'realtime_dropped').length).toBeGreaterThanOrEqual(1);
  expect(d.events.some((e) => e.kind === 'session.error' && e.data.fallback === 'manual')).toBe(true);
  expect(d.taskResults[0]).toMatchObject({ outcome: 'success', source: 'rule' });
  await context.close();
});

// ─────────────────────────────────────────────────────────────────────────────
type EyeDbg = { frames: number; isSuspended: boolean; frameMs: number; latest: { x: number; y: number } | null };
const eyeState = (page: Page) =>
  page.evaluate(() => {
    const e = (window as unknown as { __taRunner: { opts: { eye: EyeDbg | null } } }).__taRunner.opts.eye;
    return e ? { frames: e.frames, isSuspended: e.isSuspended, frameMs: e.frameMs, latest: e.latest } : null;
  });

test('6 · eye tracking: 9-point calibration + validation on a fake face, gaze streamed in iframe coordinates, preview hidden, throttled', async () => {
  test.setTimeout(8 * 60_000);
  const face = await ensureFaceVideo();
  const eyeBrowser = await launch([`--use-file-for-fake-video-capture=${face}`]);
  try {
    const { token, studyId } = await createStudy('Eye tracking', protocol({ steps: [lampTask, wrapup] }));
    const { context, page } = await newSessionPage(eyeBrowser);
    await enterSession(page, token, { eye: true });
    await expect(page.getByTestId('calibration')).toBeVisible();
    await expect(page.getByText(/Center your face|isn’t available/)).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText('Eye tracking isn’t available')).toHaveCount(0);
    await shot(page, 'eye-position');
    await page.getByRole('button', { name: 'Start calibration' }).click();
    const dot = page.getByRole('button', { name: 'Calibration point' });
    for (let p = 0; p < 9; p++) {
      await expect(page.getByTestId('calibration-stage')).toContainText(`${p + 1} of 9`);
      await page.waitForTimeout(450); // dot transition + look at it
      for (let c = 0; c < 3; c++) {
        await dot.click({ timeout: 10_000 });
        await page.waitForTimeout(120);
      }
    }
    await expect(page.getByTestId('calibration-stage')).toContainText('just look at each dot');
    await expect(page.getByText(/Accuracy:/)).toBeVisible({ timeout: 40_000 });
    const acc = await page.getByText(/Accuracy:/).innerText();
    console.log('calibration result:', acc);
    await shot(page, 'eye-result');
    await page.getByTestId('calibration-continue').click();

    const session = page.getByTestId('session');
    await expect(session).toBeVisible();
    const cal = await waitEvent(page, (e) => e.kind === 'eyetracking.calibrated', 10_000, 'eyetracking.calibrated');
    expect(typeof cal.data.errorPx).toBe('number');
    expect(Number(cal.data.errorPx)).toBeGreaterThan(0);
    expect(Number(cal.data.errorPx)).toBeLessThan(9999); // validation produced real predictions
    expect(cal.data.points).toBe(9);
    // The webcam preview and overlays are hidden and never block clicks.
    const preview = await page.evaluate(() => {
      const c = document.getElementById('webgazerVideoContainer');
      const st = c ? getComputedStyle(c) : null;
      const overlay = document.getElementById('webgazerFaceOverlay');
      const box = document.getElementById('webgazerFaceFeedbackBox');
      return { exists: Boolean(c), opacity: st?.opacity, pointer: st?.pointerEvents, overlay: overlay ? getComputedStyle(overlay).display : 'none', box: box ? getComputedStyle(box).display : 'none' };
    });
    console.log('preview:', preview);
    expect(preview.opacity).toBe('0');
    expect(preview.pointer).toBe('none');
    expect(preview.overlay).toBe('none');
    expect(preview.box).toBe('none');

    // Intro: the app is hidden → face tracking is suspended (no CPU spent).
    await waitEvent(page, (e) => e.kind === 'transcript.moderator', 60_000, 'intro');
    await page.waitForTimeout(1500);
    const s1 = (await eyeState(page))!;
    await page.waitForTimeout(2000);
    const s2 = (await eyeState(page))!;
    expect(s1.isSuspended).toBe(true);
    expect(s2.frames - s1.frames).toBeLessThanOrEqual(1);
    await waitModeratorIdle(page);
    await speak(page, 'ready');
    await expect(session).toHaveAttribute('data-app-visible', '1', { timeout: 45_000 });
    await page.waitForTimeout(2500);
    // Task: tracking runs, throttled to ~10 fps (WebGazer alone would run at the display rate).
    const a = (await eyeState(page))!;
    const t0 = Date.now();
    await page.waitForTimeout(4000);
    const b = (await eyeState(page))!;
    const fps = ((b.frames - a.frames) * 1000) / (Date.now() - t0);
    console.log('gaze fps during task:', fps.toFixed(1));
    expect(b.isSuspended).toBe(false);
    expect(fps).toBeGreaterThan(3);
    expect(fps).toBeLessThan(13);

    // Gaze points arrive as `gaze` events in iframe coordinates (viewport of the tested app).
    const mapped = await page.evaluate(async () => {
      const r = (window as unknown as { __taRunner: { queue: { subscribe: (fn: (e: { kind: string; data: unknown }) => void) => () => void }; onGaze: (x: number, y: number) => void; flushGaze: () => void } }).__taRunner;
      const got: { points: [number, number, number][]; vw: number; vh: number; path: string }[] = [];
      const off = r.queue.subscribe((e) => {
        if (e.kind === 'gaze') got.push(e.data as (typeof got)[number]);
      });
      await new Promise((res) => setTimeout(res, 3500));
      // Deterministic mapping check: a screen point 100/50 px inside the iframe → (100, 50).
      const rect = document.querySelector('[data-testid=app-frame]')!.getBoundingClientRect();
      r.flushGaze();
      got.length = 0;
      r.onGaze(rect.left + 100, rect.top + 50);
      r.onGaze(rect.left - 5, rect.top + 10); // outside the app → dropped
      r.flushGaze();
      const probe = got.slice();
      off();
      return { rect: { w: Math.round(rect.width), h: Math.round(rect.height), top: Math.round(rect.top) }, probe };
    });
    console.log('iframe rect:', mapped.rect, 'probe batch:', JSON.stringify(mapped.probe));
    expect(mapped.probe).toHaveLength(1);
    expect(mapped.probe[0].points.map((p) => [p[1], p[2]])).toEqual([[100, 50]]);
    expect(mapped.probe[0]).toMatchObject({ vw: mapped.rect.w, vh: mapped.rect.h, path: '/' });

    // Real gaze points reached the server, inside the iframe viewport.
    await page.waitForTimeout(3000);
    const { sessions } = await call<{ sessions: { id: string }[] }>('GET', `/api/studies/${studyId}/sessions`);
    const pts = await call<unknown>('GET', `/api/sessions/${sessions[0].id}/points?kind=gaze`);
    const flat = JSON.stringify(pts);
    const real = (Array.isArray(pts) ? pts : ((pts as { points?: unknown[] }).points ?? [])) as unknown[];
    console.log('server gaze payload sample:', flat.slice(0, 300));
    expect(real.length).toBeGreaterThan(5);
    const detail = await call<{ session: { gazeErrorPx?: number | null } }>('GET', `/api/sessions/${sessions[0].id}`);
    expect(detail.session.gazeErrorPx).toBe(Number(cal.data.errorPx));
    await page.getByTestId('withdraw').click();
    await page.getByTestId('confirm-withdraw').click();
    await expect(page.getByTestId('withdrawn')).toBeVisible();
    // Camera released, preview removed.
    await expect(page.locator('#webgazerVideoContainer')).toHaveCount(0);
    await context.close();
  } finally {
    await eyeBrowser.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
test('7a · moderator flow after a rule ends the task: no filler / narration, no redundant outcome', async () => {
  test.setTimeout(5 * 60_000);
  const task = { ...lampTask, askSEQ: true, probes: [] };
  const { token, studyId } = await createStudy('Moderator quality', protocol({ steps: [task, wrapup], moderation: { probingLevel: 'light', maxProbesPerStep: 1 } }));
  const { context, page } = await newSessionPage(browser);
  await enterSession(page, token);
  await passIntro(page);
  const session = page.getByTestId('session');
  await expect(session).toHaveAttribute('data-task-phase', 'active', { timeout: 40_000 });
  await waitModeratorIdle(page);
  const app = page.frameLocator('[data-testid=app-frame]');
  await app.getByRole('link', { name: 'Lighting' }).click();
  await app.getByRole('link', { name: /Aurora desk lamp/ }).click();
  await app.getByRole('button', { name: 'Add to cart' }).click();
  const end = await waitEvent(page, (e) => e.kind === 'task.end', 20_000, 'task.end by rule');
  expect(end.data).toMatchObject({ outcome: 'success', source: 'rule' });
  await waitEvent(page, (e) => e.kind === 'transcript.moderator' && e.t > end.t, 30_000, 'SEQ asked');
  await waitModeratorIdle(page);
  await speak(page, 'seq');
  const ans = await waitEvent(page, (e) => e.kind === 'answer' && e.data.questionId === 'seq', 45_000, 'SEQ by voice');
  expect(ans.data.value).toBe(6);
  await page.waitForTimeout(2000);
  await waitModeratorIdle(page, 1500);
  if ((await session.getAttribute('data-step')) === 'task_lamp') await speak(page, 'probe_short'); // optional single follow-up
  await waitEvent(page, (e) => e.kind === 'step.enter' && e.stepId === 'wrapup', 60_000, 'next step');
  await waitEvent(page, (e) => e.kind === 'transcript.moderator' && /describe the website/i.test(String(e.data.text)), 30_000, 'interview question');
  const evs = await log(page);
  save('quality-en', evs);
  const lines = modLines(evs, end.t);
  console.log('moderator after task end:', lines);
  for (const l of lines) {
    expect(l).not.toMatch(FILLER);
    expect(l).not.toMatch(JUDGEMENT);
  }
  // Spoken preambles ("commentary") must not narrate anything.
  for (const e of evs.filter((x) => x.kind === 'transcript.moderator' && x.data.phase === 'commentary')) expect(String(e.data.text).split(/\s+/).length).toBeLessThanOrEqual(3);
  // A redundant set_task_outcome (if any) is ignored: the rule's outcome stands.
  for (const c of evs.filter((e) => e.kind === 'moderator.tool' && e.data.name === 'set_task_outcome')) expect(c.data.ok).toBe(true);
  const d = await lastSession(studyId);
  expect(d.taskResults.find((r) => r.stepId === 'task_lamp')).toMatchObject({ outcome: 'success', source: 'rule' });
  expect(d.events.filter((e) => e.kind === 'task.end').length).toBe(1);
  await context.close();
});

const DE_TASK = 'Stellen Sie sich vor, Sie möchten eine neue Lampe für Ihren Schreibtisch. Finden Sie die Aurora-Schreibtischlampe.';
test('7b · German session: intro in German, think-aloud is not answered, "Ich bin fertig" (no question mark) is', async () => {
  test.setTimeout(6 * 60_000);
  const proto = protocol({
    title: 'Lumen Home Studie',
    intro: 'Hallo und danke, dass Sie mitmachen. Ich bin ein KI-Moderator. Wir testen die Website, nicht Sie, es gibt also keine falschen Antworten. Bitte denken Sie laut, während Sie sich umsehen. Sind Sie bereit?',
    closing: 'Das war alles. Vielen Dank für Ihre Zeit und Ihr ehrliches Feedback.',
    moderation: { language: 'de', probingLevel: 'none' },
    steps: [
      shopTask({ id: 'task_lamp_de', title: 'Lampe finden', instruction: DE_TASK, startPath: '/', successCriteria: 'Die Aurora-Schreibtischlampe wird gefunden.', successRules: [], askSEQ: false }),
      { id: 'wrapup_de', type: 'interview', title: 'Abschluss', goal: 'Unklarheiten', questions: ['Was war auf der Website für Sie unklar, wenn überhaupt?'], maxFollowUps: 0 },
    ],
  });
  const { token, studyId } = await createStudy('German', proto);
  const { context, page } = await newSessionPage(browser);
  await enterSession(page, token);
  const intro = await waitEvent(page, (e) => e.kind === 'transcript.moderator', 60_000, 'German intro');
  console.log('intro:', intro.data.text);
  expect(String(intro.data.text)).toMatch(/KI-Moderator|Sind Sie bereit/);
  await waitModeratorIdle(page);
  await speak(page, 'ready_de');
  await waitEvent(page, (e) => e.kind === 'moderator.tool' && e.data.name === 'complete_step' && e.data.ok === true, 45_000, 'complete_step');
  const session = page.getByTestId('session');
  await waitEvent(page, (e) => e.kind === 'transcript.moderator' && /Schreibtisch/i.test(String(e.data.text)), 45_000, 'task read in German');
  await expect(session).toHaveAttribute('data-task-phase', 'active', { timeout: 40_000 });
  await waitModeratorIdle(page);
  const runnerChecks = () => page.evaluate(() => (window as unknown as { __taRunner: { turnChecks: { text: string; addressed: boolean; via: string }[] } }).__taRunner.turnChecks);

  // Thinking aloud in German → the moderator stays quiet.
  const before = (await log(page)).length;
  await speak(page, 'think_de');
  const app = page.frameLocator('[data-testid=app-frame]');
  await app.getByRole('link', { name: 'Lighting' }).click();
  await page.waitForTimeout(7000);
  const thinkCheck = (await runnerChecks()).find((c) => /Lampe|Beleuchtung/i.test(c.text));
  console.log('think check:', thinkCheck);
  expect(thinkCheck).toMatchObject({ addressed: false, via: 'model' });
  expect(modLines((await log(page)).slice(before))).toEqual([]);

  // "Ich bin jetzt fertig mit der Aufgabe." — no question mark, not English → still recognised.
  const doneFrom = (await log(page)).at(-1)!.t;
  await speak(page, 'done_de');
  const ask = await waitEvent(page, (e) => e.kind === 'transcript.moderator' && e.t > doneFrom && /\?/.test(String(e.data.text)), 30_000, 'how did it go (German)');
  console.log('after done:', ask.data.text);
  expect(String(ask.data.text)).toMatch(/\b(wie|Wie)\b/);
  const doneCheck = (await runnerChecks()).find((c) => /fertig/i.test(c.text));
  expect(doneCheck).toMatchObject({ addressed: true, via: 'model' });
  await waitModeratorIdle(page);
  await speak(page, 'went_de');
  const end = await waitEvent(page, (e) => e.kind === 'task.end', 45_000, 'task.end via set_task_outcome');
  expect(end.data.source).toBe('ai');
  await waitEvent(page, (e) => e.kind === 'transcript.moderator' && /unklar/i.test(String(e.data.text)), 60_000, 'German interview question');
  const evs = await log(page);
  save('quality-de', evs);
  for (const l of modLines(evs)) expect(l).not.toMatch(/\b(the|and|you|let's|thanks)\b/i); // never switches to English
  void studyId;
  await context.close();
});
