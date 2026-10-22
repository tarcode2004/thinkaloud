// Realistic-participant harness runner — fully OFFLINE and zero-cost.
//
//   npm run harness -- --scenario <name|all|a,b> [--base <url>] [--parallel N] [--seed N] [--label before]
//   npm run harness -- --scenario replay --ref HEAD --label before   (test the committed code, e.g. before uncommitted fixes)
//   npm run harness -- --scenario replay --repeat 3                 (same scenario, different seeds)
//   npm run harness -- --compare before,after                       (before/after table from the newest reports per label)
//   npm run harness -- --rejudge tests/harness/reports/<run>.json[,<run2>.json]
//   npm run harness -- --judge-session tests/fixtures/real-sessions/stacky-P-XKC5.session.json
//   npm run harness -- --scenario all --mock e2e                    (use the shared tests/e2e/mockRealtime.ts instead)
//   npm run harness -- --list
//
// Nothing here talks to OpenAI: the realtime layer is mocked in the browser (fake RTCPeerConnection +
// Node-side event server, lib/mockRealtime.ts), the moderator is a deterministic script that follows
// the tool protocol (moderatorScript.ts), the participant is a rule-based persona engine (agent.ts),
// and the judge is deterministic (judge.ts). It refuses to start if an OpenAI key is in its
// environment, never reads .env, starts its servers with OPENAI_API_KEY='' and aborts any browser
// request to api.openai.com.
//
// Without --base it starts its own stack: API :4820, app host :4821, Vite :5820, DATA_DIR=./data-harness.
// It never runs against the live server on :4000/:4001.
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import { SyntheticParticipant, type QInfo } from './agent.ts';
import { Researcher } from './lib/api.ts';
import { CACHE_DIR, CHROME, REPORTS_DIR, ROOT, assertNoKey, rng, stamp } from './lib/env.ts';
import { MockRealtime } from './lib/mockRealtime.ts';
import { E2eMockAdapter } from './lib/e2eMockAdapter.ts';
import { ensureStack, exportRef } from './lib/server.ts';
import { judge } from './judge.ts';
import { PERSONAS } from './personas.ts';
import { verbatimTexts } from './protocols.ts';
import { writeComparison, writeRunReport, writeSummary, type RunResult } from './report.ts';
import { pickScenarios, SCENARIOS, type Scenario } from './scenarios.ts';
import { writeWav } from '../e2e/participant.fixtures.ts';

assertNoKey();

function args() {
  const a = process.argv.slice(2);
  const o: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue;
    const k = a[i].slice(2);
    const v = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : 'true';
    o[k] = v;
  }
  return o;
}

/** Chromium's fake capture file: 5 minutes of a very low noise floor (generated locally, no TTS). */
function fakeMic(): string {
  const file = path.join(CACHE_DIR, 'fake-mic.wav');
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const sampleRate = 24000;
  const data = Buffer.alloc(sampleRate * 2 * 300);
  for (let i = 0; i < data.length; i += 2) data.writeInt16LE(Math.round((Math.random() - 0.5) * 6), i);
  writeWav(file, { sampleRate, channels: 1, bits: 16, data });
  return file;
}

async function launchBrowser(): Promise<Browser> {
  return chromium.launch({
    headless: true,
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${fakeMic()}`, '--autoplay-policy=no-user-gesture-required'],
  });
}

function questionsOf(steps: Record<string, unknown>[]): { qs: QInfo[]; tasks: Record<string, string> } {
  const qs: QInfo[] = [];
  const tasks: Record<string, string> = {};
  for (const st of steps) {
    const id = String(st.id);
    if (st.type === 'task') {
      tasks[id] = String(st.instruction);
      if (st.askSEQ) qs.push({ stepId: id, id: 'seq', prompt: 'Overall, how difficult or easy was the task to complete?', kind: 'rating' });
      for (const q of (st.postTaskQuestions as Record<string, unknown>[]) ?? []) qs.push({ stepId: id, id: String(q.id), prompt: String(q.prompt), kind: String(q.kind) });
    } else if (st.type === 'question') {
      const q = st.question as Record<string, unknown>;
      qs.push({ stepId: id, id: String(q.id), prompt: String(q.prompt), kind: String(q.kind) });
    } else if (st.type === 'interview') (st.questions as string[]).forEach((p, i) => qs.push({ stepId: id, id: `${id}_q${i + 1}`, prompt: p, kind: 'open' }));
  }
  return { qs, tasks };
}

async function runScenario(sc: Scenario, stack: { base: string; api: string }, o: { seed: number; label?: string; stampStr: string; code: string; mockKind: 'harness' | 'e2e' }): Promise<RunResult> {
  const persona = PERSONAS[sc.persona];
  const t0 = Date.now();
  const tag = `${sc.name}${o.label ? `/${o.label}` : ''}`;
  const log = (l: string) => console.log(`[${tag}] ${l}`);
  const res: RunResult = {
    scenario: sc.name,
    description: sc.description,
    persona: `${persona.name} (${persona.id})`,
    label: o.label,
    code: o.code,
    startedAt: new Date().toISOString(),
    durationSec: 0,
    completed: false,
    judgement: { checks: [], rubric: null, failed: 0, warned: 0 },
    reproduces: sc.reproduces,
    beatsFired: [],
    timeline: null,
    events: [],
  };
  let browser: Browser | null = null;
  const protocol = sc.protocol();
  const steps = (protocol.steps as Record<string, unknown>[]) ?? [];
  const language = String((protocol.moderation as Record<string, unknown>)?.language ?? 'en');
  const mock = o.mockKind === 'e2e' ? new E2eMockAdapter(language) : new MockRealtime({ language, rand: rng(o.seed * 7919 + 13), vadHoldMs: sc.vad?.holdMs, vadHoldUnfinishedMs: sc.vad?.holdUnfinishedMs, log: process.env.HARNESS_QUIET ? undefined : log } as ConstructorParameters<typeof MockRealtime>[0]);
  let sessionStartWall = 0;
  try {
    const r = new Researcher(stack.api);
    await r.login(sc.name);
    const { studyId, token } = await r.createStudy(`Harness ${sc.name} ${o.stampStr}`, protocol, sc.app ?? undefined);
    log(`study ${studyId} live → ${stack.base}/s/${token}`);
    browser = await launchBrowser();
    const { context, page } = await SyntheticParticipant.open(browser);
    await mock.attach(context, page);
    page.on('pageerror', (e) => log(`pageerror: ${e.message}`));
    const { qs, tasks } = questionsOf(steps);
    const agent = new SyntheticParticipant(page, {
      persona,
      mock,
      beats: sc.beats,
      plans: sc.plans,
      questions: qs,
      tasks,
      rulesWhen: sc.rulesWhen,
      seed: o.seed,
      maxMinutes: sc.maxMinutes,
      log: process.env.HARNESS_QUIET ? undefined : log,
    });
    await agent.enter(stack.base, token);
    sessionStartWall = Date.now();
    log('session started');
    const tl = await agent.run().catch((e) => {
      agent.timeline.notes.push(`agent crashed: ${(e as Error).message}`);
      agent.timeline.endReason = `error: ${(e as Error).message}`;
      return agent.timeline;
    });
    res.timeline = tl;
    res.completed = tl.ended;
    const clientLog = await page
      .evaluate(() => ((window as unknown as { __taRunner?: { queue: { log: unknown[] } } }).__taRunner?.queue.log ?? []) as never[])
      .catch(() => [] as never[]);
    res.events = (clientLog as RunResult['events']).filter((e) => !['mouse', 'gaze', 'app.scroll'].includes(e.kind));
    if (!res.events.length) res.events = agent.events;
    await page.waitForTimeout(2000);
    const detail = await r.lastSession(studyId).catch(() => null);
    if (detail) {
      res.sessionId = detail.session.id;
      res.answers = detail.answers;
      res.taskResults = detail.taskResults;
      if (!res.events.length) res.events = detail.events;
    }
    res.beatsFired = tl.decisions.filter((d) => d.source === 'beat').map((d) => ({ id: d.beat!, t: d.t, reproduces: sc.beats?.find((b) => b.id === d.beat)?.reproduces }));
  } catch (e) {
    res.error = (e as Error).message.slice(0, 500);
    log(`ERROR ${res.error}`);
  } finally {
    await browser?.close().catch(() => {});
  }
  res.durationSec = (Date.now() - t0) / 1000;
  res.mock = mock.stats;
  res.moderatorDecisions = mock.moderator.decisions.map((d) => ({ s: sessionStartWall ? (d.t - sessionStartWall) / 1000 : 0, why: d.why, out: d.out }));
  if (mock.stats.blockedRequests.length) res.error = `${res.error ? `${res.error}; ` : ''}blocked ${mock.stats.blockedRequests.length} request(s) to api.openai.com`;
  res.judgement = await judge({ events: res.events, steps, protocol, verbatim: verbatimTexts(protocol), timeline: res.timeline, expect: sc.expect, completed: res.completed });
  res.files = writeRunReport(res, o.stampStr);
  log(`done in ${res.durationSec.toFixed(0)}s: ${res.judgement.failed} failing → ${path.relative(ROOT, res.files.md)}`);
  return res;
}

async function judgeSessionFile(file: string, stampStr: string) {
  const d = JSON.parse(fs.readFileSync(file, 'utf8')) as { session: { id: string; participantCode?: string; status: string }; steps: Record<string, unknown>[]; protocol: Record<string, unknown>; events: RunResult['events'] };
  const res: RunResult = {
    scenario: `real-${d.session.participantCode ?? d.session.id}`,
    description: `Judge-only run over a recorded real session (${path.relative(ROOT, file)}). No harness timeline: VAD-based speech, no UI snapshots.`,
    persona: 'real human',
    startedAt: new Date().toISOString(),
    durationSec: 0,
    sessionId: d.session.id,
    completed: d.session.status === 'completed',
    judgement: { checks: [], rubric: null, failed: 0, warned: 0 },
    beatsFired: [],
    timeline: null,
    events: d.events.filter((e) => !['mouse', 'gaze', 'app.scroll'].includes(e.kind)),
  };
  res.judgement = await judge({ events: res.events, steps: d.steps, protocol: d.protocol, verbatim: verbatimTexts({ ...d.protocol, steps: d.steps }), timeline: null, completed: res.completed });
  res.files = writeRunReport(res, stampStr);
  console.log(`judged ${file}: ${res.judgement.failed} failing → ${path.relative(ROOT, res.files.md)}`);
  return res;
}

async function main() {
  const a = args();
  const stampStr = stamp();
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  if (a.list) {
    for (const s of SCENARIOS) console.log(`${s.name.padEnd(12)} ${s.optIn ? '(opt-in) ' : ''}${s.description}`);
    return;
  }
  if (a.compare) {
    const [x, y] = a.compare.split(',');
    const out = writeComparison(x, y, stampStr);
    console.log(fs.readFileSync(out, 'utf8'));
    console.log(`\n→ ${path.relative(ROOT, out)}`);
    return;
  }
  if (a.rejudge) {
    // Re-run the judge over saved run JSONs (comma-separated) — e.g. after improving a check.
    const out: RunResult[] = [];
    for (const f of a.rejudge.split(',')) {
      const r = JSON.parse(fs.readFileSync(path.resolve(f), 'utf8')) as RunResult;
      const sc = SCENARIOS.find((x) => x.name === r.scenario);
      const protocol = sc ? sc.protocol() : ({ steps: [] } as Record<string, unknown>);
      r.judgement = await judge({ events: r.events, steps: (protocol.steps as Record<string, unknown>[]) ?? [], protocol, verbatim: verbatimTexts(protocol), timeline: r.timeline, expect: sc?.expect, completed: r.completed });
      r.files = undefined;
      r.files = writeRunReport(r, `${stampStr}-rejudged`);
      console.log(`rejudged ${f}: ${r.judgement.failed} failing → ${path.relative(ROOT, r.files.md)}`);
      out.push(r);
    }
    writeSummary(out, `${stampStr}-rejudged`, 'Re-judged summary');
    return;
  }
  if (a['judge-session']) {
    const r = await judgeSessionFile(path.resolve(a['judge-session']), stampStr);
    writeSummary([r], stampStr, 'Judge-only summary');
    return;
  }
  const repeat = Math.max(1, Number(a.repeat || 1));
  const scenarios = Array.from({ length: repeat }, () => pickScenarios(a.scenario || 'all')).flat();
  const parallel = Math.max(1, Number(a.parallel || 1));
  const seed = Number(a.seed || 7);
  if (a.ref && a.base) throw new Error('--ref starts its own stack from the exported tree; do not combine it with --base.');
  const root = a.ref ? exportRef(a.ref) : ROOT;
  if (a.ref) console.log(`[harness] code under test: git ${a.ref} exported to ${path.relative(ROOT, root)}`);
  const stack = await ensureStack(a.base, root);
  const code = a.ref ? `git ${a.ref}` : a.base ? `external server ${a.base} (must be started with OPENAI_API_KEY empty)` : 'working tree';
  console.log(`[harness] stack ${stack.base} (api ${stack.api})${stack.started ? ' — started by harness' : ''}; ${scenarios.length} scenario(s), parallel ${parallel}`);
  const results: RunResult[] = [];
  const queue = scenarios.map((sc, i) => ({ sc, i }));
  const stop = async () => {
    if (stack.started && !a['keep-server']) await stack.stop();
  };
  process.on('SIGINT', () => void stop().then(() => process.exit(130)));
  try {
    await Promise.all(
      Array.from({ length: Math.min(parallel, queue.length) }, async (_, w) => {
        for (let job = queue.shift(); job; job = queue.shift()) {
          const { sc, i } = job;
          // Stagger parallel starts a little (Vite cold transforms).
          if (w > 0 && results.length === 0) await new Promise((r) => setTimeout(r, w * 4000));
          results.push(await runScenario(sc, stack, { seed: seed + Math.floor(i / Math.max(1, scenarios.length / repeat)), label: a.label, stampStr, code: `${code}; mock: ${a.mock === 'e2e' ? 'tests/e2e/mockRealtime.ts' : 'harness'}`, mockKind: a.mock === 'e2e' ? 'e2e' : 'harness' }));
        }
      }),
    );
  } finally {
    await stop();
  }
  const order = [...new Set(scenarios.map((s) => s.name))];
  results.sort((x, y) => order.indexOf(x.scenario) - order.indexOf(y.scenario));
  const sum = writeSummary(results, `${stampStr}${a.label ? `-${a.label}` : ''}`);
  console.log(`\n[harness] summary → ${path.relative(ROOT, sum)}`);
  console.log(fs.readFileSync(sum, 'utf8'));
  process.exitCode = results.some((r) => r.judgement.failed) ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
