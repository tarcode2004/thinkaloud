// Real voice-moderated session on the user's actual target app: Stacky Social
// (stacky-social/client, a Next.js server app hosted by ThinkAloud), using the
// study created by scripts/setup-stacky-study.ts (examples/stacky/protocol.json).
//
//   STACKY_LINK=http://localhost:4000/s/<token> npx playwright test tests/e2e/stacky.spec.ts
//
// Expects a running ThinkAloud server (npm start) with the study live.
import { test, expect, chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ensureFixtures, ensureClip, clipPath, FAKE_MIC, type ClipName } from './participant.fixtures.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SHOTS = path.join(ROOT, 'tests/e2e/screenshots/stacky');
// FULLLOOP_RESUME=1 keeps ./data-fullloop and skips the setup + first participant (debugging the later steps).
const CHROME = `${os.homedir()}/.cache/ms-playwright/chromium-1234/chrome-linux/chrome`;

for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}

test.describe.configure({ mode: 'serial' });
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

async function speak(page: Page, clip: ClipName | string) {
  const file = clip in STACKY_CLIPS ? STACKY_FILES[clip] : clipPath(clip as ClipName);
  const b64 = fs.readFileSync(file).toString('base64');
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
      const talk = speak(page, `talk_${s.stepId}` in STACKY_CLIPS ? `talk_${s.stepId}` : 'talk_default');
      await stackyFlow(page, s.stepId!);
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
        if (!done || done === 'open') await speak(page, n % 2 ? 'went_ok' : 'st_probe');
      }
    } else if (s2.type === 'instruction') await speak(page, n % 2 ? 'ready' : 'explore');
    else if (s2.type === 'question' || s2.type === 'questionnaire') {
      const done = s2.card && !s2.card.submitted ? await answerCardOnScreen(page) : null;
      if (!done || done === 'open') await speak(page, 'st_interview');
    } else await speak(page, n % 2 ? 'st_probe' : 'st_interview'); // interview
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

const STACKY_CLIPS: Record<string, string> = {
  talk_t_find: "Okay, I'm on the home feed. I'm looking for something about electric vehicles, maybe a hashtag. Let me look around the page.",
  talk_t_claim: "The post at the top says the US is on the wrong side of the energy future by sticking with fossil fuels, while China builds electric cars.",
  talk_t_related: "On the right there are other posts with highlighted bits. I'll pick this one. I think it's connected because it also talks about energy policy, the highlighted part matches the argument.",
  talk_t_ai: "This one has a little badge that says modified by AI. The green words look like they were added, so I think the AI wrote the green text and the rest is from the person.",
  talk_t_full: "I'll open the full post. Here I can see what it was replying to above, and replies below. Now I'll go back.",
  talk_t_social: "I'll like this post, and bookmark it. Now I'd write a reply. Let me check it saved.",
  talk_t_more: "I'm scrolling down. More posts are loading, it feels fairly quick.",
  talk_t_empty: "This post has nothing on the right. I guess there just aren't related posts for it, it doesn't look broken.",
  talk_default: "Okay, let me look at this and think out loud as I go.",
  st_interview: "Overall it was interesting. The posts on the right were helpful, but at first I wasn't sure what the highlights meant.",
  st_probe: "I looked at the highlighted words first, because they seemed to explain the connection.",
};
const STACKY_FILES: Record<string, string> = {};

/** Participant behaviour per task, inside the hosted Stacky iframe. Best-effort, like a real person. */
async function stackyFlow(page: Page, stepId: string) {
  const app = page.frameLocator('[data-testid=app-frame]');
  const frame = page.frames().find((f) => /app-[a-z0-9]+\.localhost|\/a\/app_/.test(f.url()));
  const tryClick = async (l: ReturnType<typeof app.locator>) => {
    try {
      await l.first().scrollIntoViewIfNeeded({ timeout: 4000 });
      await l.first().click({ timeout: 4000 });
      return true;
    } catch {
      return false;
    }
  };
  const wheel = async (dy: number, times = 3) => {
    for (let i = 0; i < times; i++) {
      await page.mouse.move(400, 450);
      await page.mouse.wheel(0, dy);
      await page.waitForTimeout(700);
    }
  };
  await page.waitForTimeout(1500);
  if (stepId === 't_find') {
    // Look around, then go to the discussion (a participant would use search / a hashtag link).
    await wheel(500, 2);
    const ok = (await tryClick(app.getByText('#ChineseEVs'))) || (await tryClick(app.getByRole('link', { name: /ChineseEVs/ })));
    if (!ok && frame) await frame.goto(new URL('/ChineseEVs', frame.url()).toString());
  } else if (stepId === 't_related') {
    await tryClick(app.locator('[data-testid=col-aside] [data-testid=post]').nth(1));
  } else if (stepId === 't_ai') {
    for (let i = 0; i < 6 && !(await tryClick(app.getByLabel('Modified by AI'))); i++) await wheel(600, 1);
  } else if (stepId === 't_full') {
    await tryClick(app.getByLabel('Read full post'));
    await page.waitForTimeout(2500);
    await wheel(500, 2);
    // Back inside the app (never the top page — that would leave the session).
    if (frame) await frame.evaluate(() => history.back()).catch(() => {});
  } else if (stepId === 't_social') {
    const post = app.locator('[data-testid=post]').first();
    const buttons = post.locator('button');
    await tryClick(buttons.nth(1));
    await tryClick(buttons.nth(2));
  } else if (stepId === 't_more') {
    await wheel(900, 6);
  } else if (stepId === 't_empty') {
    await wheel(700, 4);
    await tryClick(app.locator('[data-testid=feed] [data-testid=post]').nth(4));
  }
  await page.waitForTimeout(1200);
}

const LINK = process.env.STACKY_LINK || '';
let browser: Browser;

test.beforeAll(async () => {
  test.skip(!LINK, 'Set STACKY_LINK to a live Stacky study participant link');
  await ensureFixtures();
  for (const [k, v] of Object.entries(STACKY_CLIPS)) STACKY_FILES[k] = await ensureClip(`stacky_${k}`, v);
  browser = await chromium.launch({
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${FAKE_MIC}`, '--autoplay-policy=no-user-gesture-required'],
  });
});
test.afterAll(async () => browser?.close());

test('Stacky Social: full voice-moderated session on the hosted Next.js app', async () => {
  test.setTimeout(30 * 60_000);
  const { sid, errors } = await runParticipant(browser, LINK, 'stacky');
  expect(sid).toBeTruthy();
  console.log('session', sid, 'page errors:', errors.slice(0, 5));
});
