// The REAL participant runtime (browser, WebRTC) against the self-hosted OpenRealtime server
// (openrealtime/, python) instead of OpenAI. Nothing reaches OpenAI: the servers run with
// OPENAI_API_KEY blanked, ThinkAloud mints its realtime token at OpenRealtime
// (REALTIME_BASE_URL=http://localhost:8790/v1), every browser request to api.openai.com is aborted
// (and asserted to be zero), and the participant's speech is synthesised locally with Kokoro.
//
//   npx playwright test tests/e2e/openrealtime.spec.ts                 # mock LLM (free, deterministic)
//   ORT_LIVE_LLM=1 npx playwright test tests/e2e/openrealtime.spec.ts  # DeepSeek via OpenRouter (costs money)
//
// Ports: API 4820, app host 4821, Vite 5820, OpenRealtime 8790 (ORT_E2E_*_PORT), DATA_DIR ./data-ort.
// Needs the openrealtime venv (openrealtime/.venv) and its GPU models.
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

const ROOT = path.resolve(import.meta.dirname, '../..');
const ORT_DIR = path.join(ROOT, 'openrealtime');
const PY = path.join(ORT_DIR, '.venv/bin/python');
const API_PORT = process.env.ORT_E2E_API_PORT || '4820';
const APP_PORT = process.env.ORT_E2E_APP_PORT || '4821';
const WEB_PORT = process.env.ORT_E2E_WEB_PORT || '5820';
const ORT_PORT = process.env.ORT_E2E_ORT_PORT || '8790';
const DATA_DIR = process.env.ORT_E2E_DATA_DIR || './data-ort';
const LIVE = process.env.ORT_LIVE_LLM === '1';
const API = `http://localhost:${API_PORT}`;
const WEB = `http://localhost:${WEB_PORT}`;
const ORT = `http://localhost:${ORT_PORT}`;
const CHROME = path.join(os.homedir(), '.cache/ms-playwright/chromium-1234/chrome-linux/chrome');
const FIX = path.join(ROOT, 'tests/fixtures/ort');
const OUT = path.join(ROOT, 'tests/e2e/participant-screens');

// Participant speech, synthesised with OpenRealtime's local Kokoro (never OpenAI TTS).
const CLIPS: Record<string, string> = {
  mic_check: 'Testing, one, two, three. Can you hear me?',
  ready: 'Yes, I am ready. Let us move on to the next step.',
  went: 'It went fine. I found the lamp quickly with the search.',
  friend: 'I would say it is a clean and simple shop for lamps and furniture.',
};
function ensureClips() {
  fs.mkdirSync(FIX, { recursive: true });
  // Fake capture device: a quiet room (looped by Chromium). Speech is mixed in on demand (MIC_HOOK).
  const base = path.join(FIX, 'room.wav');
  if (!fs.existsSync(base)) {
    const sr = 24000;
    const n = sr * 10;
    const buf = Buffer.alloc(44 + n * 2);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + n * 2, 4);
    buf.write('WAVEfmt ', 8);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(sr, 24);
    buf.writeUInt32LE(sr * 2, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round((Math.random() - 0.5) * 20), 44 + i * 2); // ~-70 dBFS hiss
    fs.writeFileSync(base, buf);
  }
  const missing = Object.fromEntries(Object.entries(CLIPS).filter(([k]) => !fs.existsSync(path.join(FIX, `${k}.wav`))));
  if (!Object.keys(missing).length) return;
  const script = `
import asyncio, json, sys, wave
import numpy as np
from ort.tts import TTS
async def main():
    out, clips = sys.argv[1], json.loads(sys.argv[2])
    tts = TTS()
    for name, text in clips.items():
        a = await tts.synthesize(text, voice="echo")
        pcm = (np.clip(a, -1, 1) * 32767).astype("<i2")
        pad = np.zeros(int(0.3 * 24000), "<i2")
        with wave.open(f"{out}/{name}.wav", "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000)
            w.writeframes(np.concatenate([pad, pcm, pad]).tobytes())
asyncio.run(main())
`;
  const r = spawnSync(PY, ['-c', script, FIX, JSON.stringify(missing)], { cwd: ORT_DIR, env: { ...process.env, PYTHONPATH: ORT_DIR }, stdio: 'inherit' });
  if (r.status !== 0) throw new Error('Kokoro clip synthesis failed');
}

// ── servers ──────────────────────────────────────────────────────────────────
const procs: ChildProcess[] = [];
const noOpenAI = { ...process.env, OPENAI_API_KEY: '', ALLOW_OPENAI_IN_TESTS: '' };
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
  if (await up(`${ORT}/health`)) {
    const h = (await (await fetch(`${ORT}/health`)).json()) as { llm?: string };
    if (h.llm !== (LIVE ? 'openrouter' : 'mock')) throw new Error(`An OpenRealtime server with llm=${h.llm} already runs on ${ORT_PORT}`);
  } else {
    procs.push(
      spawn(PY, ['-m', 'ort', '--port', ORT_PORT], {
        cwd: ORT_DIR,
        env: { ...noOpenAI, OPENREALTIME_LLM: LIVE ? 'openrouter' : 'mock', ORT_HOST: '127.0.0.1', ORT_LOG_LEVEL: 'INFO' },
        stdio: 'inherit',
        detached: true,
      }),
    );
  }
  if (!(await up(`${API}/api/health`))) {
    procs.push(
      spawn('npx', ['tsx', 'src/index.ts'], {
        cwd: path.join(ROOT, 'server'),
        env: {
          ...noOpenAI,
          PORT: API_PORT,
          APP_HOST_PORT: APP_PORT,
          APP_HOST_URL: `http://localhost:${APP_PORT}`,
          PUBLIC_URL: WEB,
          DATA_DIR,
          BUILD_MODE: 'local',
          SESSION_SECRET: 'ort-tests',
          REALTIME_BASE_URL: `${ORT}/v1`,
          REALTIME_PUBLIC_URL: `${ORT}/v1`,
          REALTIME_API_KEY: '',
        },
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
  await waitUp(`${ORT}/health`, 240_000); // model warm-up (Silero, smart-turn, Whisper, Kokoro)
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
const INTRO = "Hi, and thanks for joining. I'm an AI moderator, and I'll guide you through this session. We're testing the website, not you, so there are no wrong answers. Please think out loud as you go. Are you ready to begin?";
const TASK = 'Imagine you want a new lamp for your desk. Find the Aurora desk lamp.';
function protocol(): Json {
  return {
    schemaVersion: 1,
    title: 'Lumen Home usability study',
    researchGoals: ['Can people find a product?'],
    productContext: 'Lumen Home is an online shop for furniture and lighting.',
    intro: INTRO,
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
    },
    consent: { text: '## Before we start\n\nWe record your voice and clicks.', storeAudio: false, recordScreen: false, offerEyeTracking: false, ageGate: true, version: '1' },
    steps: [
      { id: 'task_find', type: 'task', title: 'Find', instruction: TASK, successCriteria: 'Done.', successRules: [], timeLimitSec: 600, probes: [], askSEQ: false, startPath: '/' },
      { id: 'wrapup', type: 'interview', title: 'Wrap-up', goal: 'Impression', questions: ['How would you describe the website to a friend?'], maxFollowUps: 0 },
    ],
    randomizeTasks: false,
    estimatedMinutes: 5,
  };
}
async function createStudy(name: string): Promise<{ token: string; studyId: string }> {
  const { study } = await call<{ study: { id: string } }>('POST', '/api/studies', { name, template: 'blank' });
  const detail = await call<{ protocols: { id: string }[]; variants: { id: string }[]; links: { token: string }[] }>('GET', `/api/studies/${study.id}`);
  await call('PUT', `/api/protocols/${detail.protocols[0].id}`, { protocol: protocol() });
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

// ── browser ──────────────────────────────────────────────────────────────────
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
/** Records every realtime event on the 'oai-events' data channel (both directions) for diagnostics. */
const DC_TAP = () => {
  if (window.top !== window) return;
  const evs: { t: number; dir: string; type: string; info: string }[] = [];
  (window as unknown as { __dcTap: typeof evs }).__dcTap = evs;
  const brief = (e: Record<string, unknown>) => {
    const r = e.response as { status?: string; status_details?: unknown; usage?: unknown; tool_choice?: unknown; instructions?: string; conversation?: string } | undefined;
    const x = e.error ?? (e.type === 'response.done' ? { status: r?.status, details: r?.status_details } : undefined) ?? (e.type === 'response.create' ? { tc: r?.tool_choice, oob: r?.conversation, now: r?.instructions?.split('# NOW').pop()?.slice(0, 80) } : undefined) ?? e.transcript ?? e.delta ?? e.name ?? '';
    return typeof x === 'string' ? x.slice(0, 100) : JSON.stringify(x).slice(0, 200);
  };
  const orig = RTCPeerConnection.prototype.createDataChannel;
  RTCPeerConnection.prototype.createDataChannel = function (this: RTCPeerConnection, ...a: Parameters<RTCPeerConnection['createDataChannel']>) {
    const dc = orig.apply(this, a);
    dc.addEventListener('message', (m) => {
      try {
        const e = JSON.parse(m.data as string);
        if (!String(e.type).endsWith('.delta')) evs.push({ t: performance.now(), dir: '<', type: e.type, info: brief(e) });
      } catch {
        /* ignore */
      }
    });
    const send = dc.send.bind(dc);
    dc.send = (d: string) => {
      try {
        const e = JSON.parse(d);
        evs.push({ t: performance.now(), dir: '>', type: e.type, info: brief(e) });
      } catch {
        /* ignore */
      }
      return send(d);
    };
    return dc;
  } as typeof orig;
};
const tap = async (page: Page, last = 80) =>
  (await page.evaluate(() => (window as unknown as { __dcTap?: { t: number; dir: string; type: string; info: string }[] }).__dcTap ?? []))
    .slice(-last)
    .map((e) => `${(e.t / 1000).toFixed(2).padStart(8)} ${e.dir} ${e.type.padEnd(48)} ${e.info}`)
    .join('\n');
const speak = (page: Page, clip: string) =>
  page.evaluate((b) => (window as unknown as { __taSpeak: (b: string) => Promise<number> }).__taSpeak(b), fs.readFileSync(path.join(FIX, `${clip}.wav`)).toString('base64'));

let browser: Browser;
test.use({ screenshot: 'off' });
test.beforeAll(async () => {
  test.setTimeout(360_000);
  ensureClips();
  await ensureServers();
  await call('POST', '/api/auth/signup', { email: `ort-${Date.now()}@example.com`, password: 'password123', name: 'ORT Researcher' });
  browser = await chromium.launch({
    headless: true,
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${path.join(FIX, 'room.wav')}`, '--autoplay-policy=no-user-gesture-required'],
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

const log = (page: Page) => page.evaluate(() => ((window as unknown as { __taRunner?: { queue: { log: unknown[] } } }).__taRunner?.queue.log ?? []) as LogEvent[]);
function fmt(evs: LogEvent[]) {
  return evs
    .filter((e) => !['mouse', 'gaze', 'app.scroll', 'app.focus'].includes(e.kind))
    .map((e) => `${(e.t / 1000).toFixed(1).padStart(6)}s ${(e.stepId ?? '').padEnd(12)} ${e.kind.padEnd(22)} ${e.kind.startsWith('transcript') ? String(e.data.text) : JSON.stringify(e.data).slice(0, 200)}`)
    .join('\n');
}
async function waitEvent(page: Page, pred: (e: LogEvent) => boolean, ms = 30_000, label = 'event') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = (await log(page)).find(pred);
    if (hit) return hit;
    await page.waitForTimeout(150);
  }
  throw new Error(`Timed out waiting for ${label}. Log:\n${fmt(await log(page))}\nRealtime events:\n${await tap(page)}`);
}
async function waitIdle(page: Page, quietMs = 800, ms = 60_000) {
  const t0 = Date.now();
  let since = 0;
  while (Date.now() - t0 < ms) {
    const orb = await page.getAttribute('[data-testid=session]', 'data-orb');
    if (orb === 'listening') {
      if (!since) since = Date.now();
      if (Date.now() - since >= quietMs) return;
    } else since = 0;
    await page.waitForTimeout(100);
  }
  throw new Error(`moderator never went idle. Log:\n${fmt(await log(page))}`);
}

// ─────────────────────────────────────────────────────────────────────────────
test(`OpenRealtime (${LIVE ? 'DeepSeek via OpenRouter' : 'mock LLM'}): consent → mic check → voice session over WebRTC; intro spoken, participant transcribed, complete_step advances; zero OpenAI requests`, async () => {
  test.setTimeout(300_000);
  const { token, studyId } = await createStudy(`ORT ${LIVE ? 'live' : 'mock'}`);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['microphone', 'camera'] });
  await context.addInitScript(MIC_HOOK);
  await context.addInitScript(DC_TAP);
  const openaiHits: string[] = [];
  await context.route('https://api.openai.com/**', (r) => {
    openaiHits.push(r.request().url());
    return r.abort('blockedbyclient');
  });
  const ortRequests: string[] = [];
  context.on('request', (r) => {
    if (r.url().startsWith(ORT)) ortRequests.push(`${r.method()} ${r.url()}`);
    if (r.url().includes('openai.com')) openaiHits.push(r.url());
  });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.text().includes('[realtime]')) console.log(`[browser:${m.type()}] ${m.text()}`);
  });

  // Landing → consent → mic check (Kokoro speech mixed into the fake mic).
  await page.goto(`${WEB}/s/${token}`);
  await page.getByTestId('get-started').click();
  await page.getByTestId('opt-age').click();
  await page.getByTestId('accept-consent').click();
  await expect(page.getByTestId('mic-meter')).toBeVisible({ timeout: 20_000 });
  await speak(page, 'mic_check');
  await expect(page.getByText('We can hear you.')).toBeVisible({ timeout: 20_000 });
  const tokenRes = page.waitForResponse((r) => r.url().includes('/realtime-token'), { timeout: 30_000 });
  const callRes = page.waitForResponse((r) => r.url() === `${ORT}/v1/realtime/calls` && r.request().method() === 'POST', { timeout: 30_000 });
  await page.getByTestId('device-continue').click();

  // (1) The token is minted at OpenRealtime and the browser's SDP offer is answered by it.
  const tok = (await (await tokenRes).json()) as { value: string; callsUrl?: string };
  expect(tok.value).toMatch(/^ek_/);
  expect(tok.callsUrl).toBe(`${ORT}/v1/realtime/calls`);
  const sdp = await callRes;
  expect(sdp.status()).toBe(201);
  expect(await sdp.text()).toContain('a=fingerprint');
  const session = page.getByTestId('session');
  await expect(session).toHaveAttribute('data-mode', 'voice', { timeout: 20_000 });

  // (2) The moderator reads the intro: audio over the WebRTC track + captions.
  const introStart = await waitEvent(page, (e) => e.kind === 'speech.start' && e.data.who === 'moderator', 60_000, 'intro audio');
  const intro = await waitEvent(page, (e) => e.kind === 'transcript.moderator', 60_000, 'intro transcript');
  console.log(`intro: "${intro.data.text}"`);
  if (!LIVE) expect(String(intro.data.text)).toBe(INTRO);
  else expect(String(intro.data.text)).toMatch(/thanks for joining/i);
  const caption = await page.evaluate(() => (window as unknown as { __taRunner: { snapshot: { captions: { role: string; text: string }[] } } }).__taRunner.snapshot.captions.filter((c) => c.role === 'moderator').map((c) => c.text));
  expect(caption.join(' ')).toMatch(/thanks for joining/i);
  const remote = await page.evaluate(() => {
    const a = [...document.querySelectorAll('audio')].find((el) => el.srcObject instanceof MediaStream);
    return a ? (a.srcObject as MediaStream).getAudioTracks().map((t) => t.readyState) : [];
  });
  expect(remote).toContain('live');
  await waitIdle(page);

  // (3) The participant answers by voice: OpenRealtime's VAD + Whisper transcribe it.
  const spokeAt = (await page.evaluate(() => (window as unknown as { __taRunner: { queue: { now(): number } } }).__taRunner.queue.now())) as number;
  const dur = await speak(page, 'ready');
  const saidEnd = spokeAt + dur * 1000;
  const heard = await waitEvent(page, (e) => e.kind === 'transcript.participant' && e.t > spokeAt, 30_000, 'participant transcript');
  console.log(`participant (transcribed): "${heard.data.text}"`);
  expect(String(heard.data.text)).toMatch(/ready/i);

  // (4) Tool call round trip: complete_step → the runner moves to the first task, whose text is read.
  const tool = await waitEvent(page, (e) => e.kind === 'moderator.tool' && e.data.name === 'complete_step', 60_000, 'complete_step');
  expect(tool.data.ok).toBe(true);
  await expect(session).toHaveAttribute('data-step', 'task_find', { timeout: 20_000 });
  const taskStart = await waitEvent(page, (e) => e.kind === 'speech.start' && e.data.who === 'moderator' && e.t > tool.t, 60_000, 'task audio');
  const taskRead = await waitEvent(page, (e) => e.kind === 'transcript.moderator' && e.stepId === 'task_find', 60_000, 'task reading');
  console.log(`task: "${taskRead.data.text}"`);
  expect(String(taskRead.data.text)).toMatch(/Aurora desk lamp/i);
  await expect(session).toHaveAttribute('data-task-phase', 'active', { timeout: 30_000 });
  await waitIdle(page);

  // (5) "I'm done" → the moderator asks how it went → spoken answer → set_task_outcome ends the task.
  await page.getByTestId('im-done').click();
  const ask = await waitEvent(page, (e) => e.kind === 'transcript.moderator' && e.t > taskRead.t, 60_000, 'how did it go');
  console.log(`after done: "${ask.data.text}"`);
  await waitIdle(page);
  await speak(page, 'went');
  const end = await waitEvent(page, (e) => e.kind === 'task.end' && e.stepId === 'task_find', 60_000, 'task.end');
  console.log(`task.end: ${JSON.stringify(end.data)}`);
  await expect(session).toHaveAttribute('data-step', 'wrapup', { timeout: 30_000 });
  const question = await waitEvent(page, (e) => e.kind === 'transcript.moderator' && e.stepId === 'wrapup', 60_000, 'interview question');
  console.log(`wrapup: "${question.data.text}"`);
  if (!LIVE) expect(String(ask.data.text)).toBe('How do you feel that went?');
  if (!LIVE) expect(String(question.data.text)).toMatch(/describe the website to a friend/);
  await waitIdle(page);

  // (6) Interview answer by voice → record_answer → closing text → session ends.
  await speak(page, 'friend');
  const rec = await waitEvent(page, (e) => e.kind === 'moderator.tool' && e.data.name === 'record_answer', 60_000, 'record_answer');
  console.log(`record_answer: ${JSON.stringify(rec.data)}`);
  expect(rec.data.ok).toBe(true);
  // A short preamble ("Got it.") can share the complete_step turn and be logged under the closing
  // step; the runner then dictates the closing itself. Wait for the verbatim reading.
  const closing = await waitEvent(
    page,
    (e) => e.kind === 'transcript.moderator' && e.stepId === 'closing' && /thank you so much/i.test(String(e.data.text)),
    60_000,
    'closing',
  );
  const preambles = (await log(page)).filter((e) => e.kind === 'transcript.moderator' && e.stepId === 'closing' && e.data.text !== closing.data.text);
  for (const p of preambles) console.log(`closing preamble: "${p.data.text}"`);
  console.log(`closing: "${closing.data.text}"`);

  const evs = await log(page);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `ort-${LIVE ? 'live' : 'mock'}.txt`), `${fmt(evs)}\n\n# realtime events\n${await tap(page, 1000)}`);
  const lat = {
    introAudioAfterSessionStartMs: Math.round(introStart.t - (evs.find((e) => e.kind === 'session.start')?.t ?? introStart.t)),
    transcriptAfterSpeechEndMs: Math.round(heard.t - saidEnd),
    toolCallAfterSpeechEndMs: Math.round(tool.t - saidEnd),
    taskAudioAfterToolMs: Math.round(taskStart.t - tool.t),
    taskAudioAfterSpeechEndMs: Math.round(taskStart.t - saidEnd),
  };
  console.log('latencies:', JSON.stringify(lat));
  console.log('moderator said:\n' + evs.filter((e) => e.kind === 'transcript.moderator').map((e) => `  - ${e.data.text}`).join('\n'));

  // (7) Stored in ThinkAloud: the participant transcript and the tool call reach the server.
  await expect
    .poll(
      async () => {
        const { sessions } = await call<{ sessions: { id: string }[] }>('GET', `/api/studies/${studyId}/sessions`);
        const d = await call<{ events: LogEvent[] }>('GET', `/api/sessions/${sessions[0].id}`);
        return d.events.filter((e) => e.kind === 'transcript.participant').map((e) => String(e.data.text)).join(' | ');
      },
      { timeout: 30_000 },
    )
    .toMatch(/ready.*lamp.*clean and simple/is);
  {
    const { sessions } = await call<{ sessions: { id: string }[] }>('GET', `/api/studies/${studyId}/sessions`);
    const d = await call<{ answers: { questionId: string; text?: string }[]; taskResults: { stepId: string; outcome: string }[] }>('GET', `/api/sessions/${sessions[0].id}`);
    console.log('stored:', JSON.stringify({ answers: d.answers.map((a) => [a.questionId, a.text]), tasks: d.taskResults.map((t) => [t.stepId, t.outcome]) }));
    expect(d.taskResults.map((t) => t.stepId)).toContain('task_find');
    expect(d.answers.some((a) => a.questionId === 'wrapup_q1' && (LIVE ? Boolean(a.text) : /clean and simple/i.test(a.text ?? '')))).toBe(true);
  }

  // (8) Not a single request to OpenAI; the WebRTC call went to OpenRealtime.
  expect(ortRequests.some((r) => r.startsWith(`POST ${ORT}/v1/realtime/calls`))).toBe(true);
  expect(openaiHits).toEqual([]);
  const health = (await (await fetch(`${ORT}/health`)).json()) as { calls_total: number; llm: string };
  expect(health.calls_total).toBeGreaterThan(0);
  expect(health.llm).toBe(LIVE ? 'openrouter' : 'mock');
  await context.close();
});
