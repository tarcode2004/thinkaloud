// Synthetic participant (rule-based, offline): drives the participant runtime in Chromium like a
// person would. Loop: observe (moderator transcript, runner state, card, app) → decide (scripted
// beat, else the persona's rules with a seeded RNG) → act (speech in chunks with natural pauses —
// fed to the mock realtime layer's VAD/ASR and as speech-shaped noise into the fake mic —, app
// clicks/typing, wrapper buttons, card answers, or silence). No TTS, no LLM, no network.
// Everything the participant did is recorded on the session clock (runner queue.now()) for the judge.
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { isReadingOf, rng, sleep } from './lib/env.ts';
import type { LogEvent } from './lib/api.ts';
/** What the participant engine needs from a realtime mock (lib/mockRealtime.ts or lib/e2eMockAdapter.ts). */
export interface RealtimeMock {
  moderatorAudio: boolean;
  userSpeechStart(): void;
  userSpeechEnd(asrText: string, continuing?: boolean): void;
  /** Mocks that take a whole chunk at once (text + duration) at its start. */
  userSpeechChunk?(asrText: string, durMs: number, continuing: boolean): void;
}
import { phrases, type Persona, type Phrase } from './personas.ts';

// ── types ────────────────────────────────────────────────────────────────────

export type Intent =
  | 'ready'
  | 'answer'
  | 'think_aloud'
  | 'observation'
  | 'clarify'
  | 'meta_question'
  | 'declare_done'
  | 'request_skip'
  | 'complaint'
  | 'silence'
  | 'other';

export interface Chunk {
  text: string;
  pauseAfterMs: number;
}

export type Action =
  | { kind: 'speak'; intent: Intent; chunks: Chunk[] }
  | { kind: 'click'; role: string; name: string }
  | { kind: 'type'; name: string; text: string; enter: boolean }
  | { kind: 'press_done' }
  | { kind: 'press_skip' }
  | { kind: 'answer_card'; value?: number | null; choice?: string | null; text?: string | null }
  | { kind: 'submit_questionnaire'; value?: number | null }
  | { kind: 'wait'; seconds: number; untilModerator?: boolean; intent?: Intent };

export interface UtteranceRec {
  id: number;
  intent: Intent;
  stepId: string | null;
  text: string;
  planned: Chunk[];
  chunks: { text: string; start: number; end: number; pauseAfterMs: number }[];
  start: number;
  end: number;
  finished: boolean;
  /** Session time the moderator started talking while this utterance was unfinished. */
  interruptedAt?: number;
  source: Source;
}

export type Source = 'beat' | 'rules' | 'knob';

export interface ActionRec {
  t: number;
  kind: Action['kind'];
  stepId: string | null;
  detail: string;
  ok: boolean;
  error?: string;
  source: Source;
}

export interface UiSnap {
  t: number;
  stepId: string | null;
  type: string | null;
  phase: string | null;
  orb: string;
  pending: string | null;
  card: { kind: string; activeQuestionId?: string; prompt?: string; visible: boolean } | null;
}

export interface DecisionRec {
  t: number;
  trigger: string;
  source: 'beat' | 'rules';
  beat?: string;
  thought?: string;
  actions: Action[];
  ms: number;
  directive?: string;
}

export interface Timeline {
  utterances: UtteranceRec[];
  actions: ActionRec[];
  ui: UiSnap[];
  decisions: DecisionRec[];
  notes: string[];
  ended: boolean;
  endReason: string;
  /** Session-clock time when the harness started the session view (≈0). */
  startedWall: number;
}

interface CardObs {
  kind: string;
  stepId: string;
  activeQuestionId?: string;
  submitted?: boolean;
  questions: { id: string; prompt: string; kind: string; options?: string[]; scale?: { min: number; max: number; minLabel?: string; maxLabel?: string } }[];
}

export interface Obs {
  now: number;
  stepId: string | null;
  type: string | null;
  title: string | null;
  index: number;
  total: number;
  phase: string | null;
  orb: string;
  pending: string | null;
  ended: boolean;
  mode: string;
  appVisible: boolean;
  taskText: string | null;
  card: CardObs | null;
  cardVisible: boolean;
  cardText: string;
  answers: string[];
  doneBtn: boolean;
  doneDisabled: boolean;
  skipBtn: boolean;
  doneScreen: boolean;
  logLen: number;
  events: LogEvent[];
}

export interface BeatCtx {
  obs: Obs;
  trigger: 'moderator' | 'card' | 'tick' | 'idle' | 'poll';
  /** Text of the moderator's latest unanswered turn (joined), '' if none. */
  mod: string;
  /** All moderator lines in this step so far. */
  modStep: string[];
  /** Seconds since the task became active (null if not in an active task). */
  taskSec: number | null;
  /** Seconds since the moderator last finished talking. */
  quietSec: number;
  fired: Set<string>;
  /** Count of moderator readings of `text` in the current step. */
  readings: (text: string) => number;
  /** Seconds since the beat `id` fired (-1 if it never fired). */
  since: (id: string) => number;
  appPath: string;
}

export interface Beat {
  id: string;
  when: (c: BeatCtx) => boolean;
  do: Action[] | ((c: BeatCtx) => Action[]);
  /** Fire at most once (default true). */
  once?: boolean;
  /** Note for the report: which real-session moment this reproduces. */
  reproduces?: string;
}

/** Chromium init script: mixes speech into the fake mic; times playback on the session clock. */
export const MIC_HOOK = () => {
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
  const w = window as unknown as Record<string, unknown>;
  const now = () => {
    const r = w.__taRunner as { queue?: { now(): number } } | undefined;
    return r?.queue ? r.queue.now() : -1;
  };
  const play = async (b64: string) => {
    if (!ctx || !dest) throw new Error('mic not started');
    await ctx.resume();
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const buf = await ctx.decodeAudioData(bytes.buffer);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(dest);
    const start = now();
    src.start();
    await new Promise((r) => (src.onended = r));
    return { start, end: now(), dur: buf.duration };
  };
  w.__taSpeak = async (b64: string) => (await play(b64)).dur;
  w.__harnessSpeak = play;
  // Speech-shaped noise (syllable-rate amplitude modulation) so the mic level meter and the
  // recording see "speech" while the synthetic participant talks. Generated locally.
  w.__harnessNoise = async (ms: number) => {
    if (!ctx || !dest) return;
    await ctx.resume();
    const n = Math.max(1, Math.round((ctx.sampleRate * ms) / 1000));
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      const t = i / ctx.sampleRate;
      const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4.2 * t);
      d[i] = (Math.random() * 2 - 1) * 0.12 * env * Math.min(1, t * 20, (n - i) / ctx.sampleRate * 20);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(dest);
    src.start();
  };
};

const SKIP_KINDS = new Set(['mouse', 'gaze', 'app.scroll', 'app.focus', 'app.visibility']);

function observeInPage(from: number) {
  const w = window as unknown as Record<string, any>;
  const r = w.__taRunner;
  const doneScreen = Boolean(document.querySelector('[data-testid=done]'));
  if (!r) return { missing: true, doneScreen } as const;
  const s = r.snapshot;
  const log: any[] = r.queue.log;
  const vis = (el: Element | null) => {
    if (!el) return false;
    const b = (el as HTMLElement).getBoundingClientRect();
    const cs = getComputedStyle(el as HTMLElement);
    return b.width > 0 && b.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity || '1') > 0.05;
  };
  const cardEl = document.querySelector('[data-testid=question-card], [data-testid=questionnaire-card]');
  const done = document.querySelector('[data-testid=im-done]') as HTMLButtonElement | null;
  const skip = document.querySelector('[data-testid=skip-task]');
  const taskEl = document.querySelector('[data-testid=task-text]');
  const skipKinds = ['mouse', 'gaze', 'app.scroll', 'app.focus', 'app.visibility'];
  return {
    missing: false,
    now: r.queue.now(),
    stepId: s.step?.id ?? (s.index < 0 ? 'intro' : s.index >= s.total ? 'closing' : null),
    type: s.step?.type ?? (s.index < 0 ? 'intro' : 'closing'),
    title: s.step?.title ?? null,
    index: s.index,
    total: s.total,
    phase: s.taskPhase ?? null,
    orb: s.orb,
    pending: s.pendingAction ?? null,
    ended: Boolean(s.ended),
    mode: s.mode,
    appVisible: Boolean(s.appVisible),
    taskText: s.step?.type === 'task' ? s.step.instruction : taskEl ? (taskEl as HTMLElement).innerText : null,
    card: s.card
      ? {
          kind: s.card.kind,
          stepId: s.card.stepId,
          activeQuestionId: s.card.activeQuestionId,
          submitted: s.card.submitted,
          questions: s.card.questions.map((q: any) => ({ id: q.id, prompt: q.prompt, kind: q.kind, options: q.options, scale: q.scale })),
        }
      : null,
    cardVisible: vis(cardEl),
    cardText: cardEl ? (cardEl as HTMLElement).innerText.slice(0, 400) : '',
    answers: Object.keys(s.answers ?? {}),
    doneBtn: vis(done),
    doneDisabled: Boolean(done?.disabled),
    skipBtn: vis(skip),
    doneScreen,
    logLen: log.length,
    events: log
      .slice(from)
      .filter((e) => !skipKinds.includes(e.kind))
      .map((e) => ({ kind: e.kind, t: e.t, stepId: e.stepId, data: e.data })),
  };
}

export interface QInfo {
  stepId: string;
  id: string;
  prompt: string;
  kind: string;
}

export interface AgentOptions {
  persona: Persona;
  mock: RealtimeMock;
  beats?: Beat[];
  /** Click/type plan per task step id (executed at the persona's tempo, then the done signal). */
  plans?: Record<string, Action[]>;
  /** Protocol questions (to recognise when the moderator reads one). */
  questions: QInfo[];
  /** Task instructions by step id. */
  tasks: Record<string, string>;
  /** Gate for the persona rules (scripted scenarios keep them out of active tasks). */
  rulesWhen?: (c: BeatCtx) => boolean;
  seed?: number;
  maxMinutes: number;
  log?: (line: string) => void;
}

const HOW_WENT = /how do you feel (that|it) went|how did (that|it) go|how (was|did) (that|it) (go|feel)|wie ist es .*gelaufen|wie lief es/i;
const NUDGE = /keep talking|what are you thinking|on your mind|what are you noticing|talk through|think(ing)? (out )?loud|woran denken|laut denken|was geht ihnen/i;
const DEFLECT = /what would you do if i (were|was)n'?t here|do whatever feels natural|what do you think it means|what would you expect|what would you try next|where would you look|take your best guess|was würden sie (tun|erwarten)|was denken sie, was/i;
const CLOSING = /that'?s everything|thank you so much for your time|close this window|vielen dank für ihre zeit|das war alles/i;

export class SyntheticParticipant {
  readonly timeline: Timeline = { utterances: [], actions: [], ui: [], decisions: [], notes: [], ended: false, endReason: '', startedWall: Date.now() };
  readonly events: LogEvent[] = [];
  private logIdx = 0;
  private obs: Obs | null = null;
  private rand: () => number;
  private fired = new Map<string, number>();
  private handledModT = -1;
  private handledCardQ = '';
  private lastActT = 0;
  private nextTickSec = 3;
  private silenceUntil = 0;
  private uttSeq = 0;
  private taskRolls = new Map<string, { skip: boolean; skipped: boolean; plan: number; doneSignaled: boolean; started: boolean }>();
  private qTimes = new Map<string, number>();
  private lastUiKey = '';
  private lastUiT = -1e9;
  private lastIdleDecision = 0;
  private appPath = '';
  private convo: { t: number; who: 'moderator' | 'you' | 'screen'; text: string }[] = [];
  private interruptedText = '';
  private inflight: Promise<Obs | null> | null = null;
  private polling = false;

  constructor(
    readonly page: Page,
    private o: AgentOptions,
  ) {
    this.rand = rng(o.seed ?? 1);
  }

  get persona() {
    return this.o.persona;
  }
  private log(s: string) {
    this.o.log?.(s);
  }
  private between([a, b]: [number, number]) {
    return a + (b - a) * this.rand();
  }
  private pick<T>(xs: T[]): T {
    return xs[Math.floor(this.rand() * xs.length)];
  }
  private line(k: Phrase, x = '', n?: number) {
    return this.pick(phrases(this.persona, k)).replace('{x}', x).replace('{n}', n != null ? String(n) : '');
  }

  static async open(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['microphone', 'camera'] });
    // tsx/esbuild wraps named functions in __name(); functions we send to the page need it defined.
    await context.addInitScript({ content: 'globalThis.__name = globalThis.__name || ((f) => f);' });
    await context.addInitScript(MIC_HOOK);
    const page = await context.newPage();
    return { context, page };
  }

  // ── session entry ──────────────────────────────────────────────────────────
  async enter(base: string, token: string) {
    const p = this.page;
    await p.goto(`${base}/s/${token}?harness=${this.persona.id}`);
    await p.getByTestId('get-started').click({ timeout: 30_000 });
    await p.getByTestId('opt-age').click();
    await p.getByTestId('accept-consent').click();
    await p.getByTestId('device-check').waitFor({ timeout: 20_000 });
    await p.getByTestId('mic-meter').waitFor({ timeout: 20_000 });
    for (let i = 0; i < 4; i++) {
      await p.evaluate(() => (window as unknown as { __harnessNoise?: (ms: number) => Promise<void> }).__harnessNoise?.(1600)).catch(() => {});
      await sleep(1800);
      if (await p.getByText(/We can hear you/i).isVisible().catch(() => false)) break;
    }
    await p.getByTestId('device-continue').click({ timeout: 20_000 });
    await p.getByTestId('session').waitFor({ timeout: 30_000 });
    this.timeline.startedWall = Date.now();
  }

  // ── observe ────────────────────────────────────────────────────────────────
  /** Single-flight observe: concurrent callers share one page round-trip (keeps event ingestion ordered). */
  private observe(): Promise<Obs | null> {
    if (!this.inflight) this.inflight = this.observeOnce().finally(() => (this.inflight = null));
    return this.inflight;
  }

  /** Keeps UI snapshots + events flowing while the agent is busy (speaking, typing). */
  private startPoller() {
    if (this.polling) return;
    this.polling = true;
    void (async () => {
      while (this.polling && !this.page.isClosed()) {
        await this.observe().catch(() => null);
        await sleep(400);
      }
    })();
  }

  private async observeOnce(): Promise<Obs | null> {
    const raw = await this.page.evaluate(observeInPage, this.logIdx).catch(() => null);
    if (!raw) return null;
    if (raw.missing) {
      if (raw.doneScreen && this.obs) return { ...this.obs, doneScreen: true, events: [] };
      return null;
    }
    const o = raw as unknown as Obs;
    this.logIdx = o.logLen;
    for (const e of o.events) {
      if (SKIP_KINDS.has(e.kind)) continue;
      this.events.push(e);
      if (e.kind === 'transcript.moderator') this.convo.push({ t: e.t, who: 'moderator', text: String(e.data.text) });
      if (e.kind === 'app.navigate' || e.kind === 'app.ready') this.appPath = String(e.data.path ?? this.appPath);
    }
    this.obs = o;
    this.recordUi(o);
    return o;
  }

  private recordUi(o: Obs) {
    const active = o.card?.questions.find((q) => q.id === o.card?.activeQuestionId) ?? o.card?.questions[0];
    const snap: UiSnap = {
      t: o.now,
      stepId: o.stepId,
      type: o.type,
      phase: o.phase,
      orb: o.orb,
      pending: o.pending,
      card: o.card ? { kind: o.card.kind, activeQuestionId: o.card.activeQuestionId, prompt: active?.prompt, visible: o.cardVisible } : null,
    };
    const key = JSON.stringify({ ...snap, t: 0, orb: '' });
    if (key !== this.lastUiKey || o.now - this.lastUiT > 2000) {
      this.timeline.ui.push(snap);
      this.lastUiKey = key;
      this.lastUiT = o.now;
    }
  }

  private moderatorIdle(o: Obs) {
    return (o.orb === 'listening' || o.orb === 'muted' || o.orb === 'offline') && !this.o.mock.moderatorAudio;
  }

  // ── main loop ──────────────────────────────────────────────────────────────
  async run(): Promise<Timeline> {
    const deadline = Date.now() + this.o.maxMinutes * 60_000;
    this.startPoller();
    let idleSince = Date.now();
    while (Date.now() < deadline) {
      const o = await this.observe();
      if (!o) {
        if (await this.page.getByTestId('done').isVisible().catch(() => false)) return this.finish('done screen');
        if (this.page.isClosed()) return this.finish('page closed');
        await sleep(300);
        continue;
      }
      if (o.doneScreen || o.ended) {
        await sleep(1500);
        await this.observe();
        return this.finish('done screen');
      }
      if (this.moderatorIdle(o)) {
        if (!idleSince) idleSince = Date.now();
      } else idleSince = 0;
      const quietMs = idleSince ? Date.now() - idleSince : 0;
      if (o.type === 'task' && o.stepId && !this.taskRolls.has(o.stepId)) this.taskRolls.set(o.stepId, { skip: this.rand() < this.persona.knobs.skip, skipped: false, plan: 0, doneSignaled: false, started: false });

      const trig = this.trigger(o, quietMs);
      const ctx = this.ctx(o, trig, quietMs);
      const beat = this.matchBeat(ctx);
      if (beat) {
        const acts = typeof beat.do === 'function' ? beat.do(ctx) : beat.do;
        this.fired.set(beat.id, Date.now());
        this.consume(o);
        this.timeline.decisions.push({ t: o.now, trigger: trig, source: 'beat', beat: beat.id, actions: acts, ms: 0 });
        this.log(`[${this.persona.id}] beat ${beat.id} @${(o.now / 1000).toFixed(1)}s`);
        await this.execute(acts, 'beat');
        this.lastActT = Date.now();
        continue;
      }
      if (trig !== 'poll' && Date.now() >= this.silenceUntil && (!this.o.rulesWhen || this.o.rulesWhen(ctx))) {
        const acts = this.rules(o, trig, ctx);
        this.consume(o);
        if (acts.length) {
          this.timeline.decisions.push({ t: o.now, trigger: trig, source: 'rules', actions: acts, ms: 0, thought: ctx.mod ? `heard: ${ctx.mod.slice(0, 80)}` : undefined });
          await this.execute(acts, 'rules');
          this.lastActT = Date.now();
        }
        continue;
      }
      await sleep(250);
    }
    return this.finish('timeout');
  }

  private finish(reason: string) {
    this.polling = false;
    this.timeline.ended = reason === 'done screen';
    this.timeline.endReason = reason;
    return this.timeline;
  }

  private consume(o: Obs) {
    const last = [...this.events].reverse().find((e) => e.kind === 'transcript.moderator');
    if (last) this.handledModT = last.t;
    if (o.card?.activeQuestionId) this.handledCardQ = `${o.card.stepId}::${o.card.activeQuestionId}`;
  }

  private pendingModeratorText(): string {
    return this.events
      .filter((e) => e.kind === 'transcript.moderator' && e.t > this.handledModT)
      .map((e) => String(e.data.text))
      .join(' ');
  }

  private trigger(o: Obs, quietMs: number): BeatCtx['trigger'] {
    if (!this.moderatorIdle(o)) return 'poll';
    const react = this.between(this.persona.knobs.reactMs);
    if (this.pendingModeratorText() && quietMs >= react) return 'moderator';
    const cq = o.card?.activeQuestionId ? `${o.card.stepId}::${o.card.activeQuestionId}` : '';
    if (cq && cq !== this.handledCardQ && !o.answers.includes(cq) && quietMs >= 2500) return 'card';
    if (o.card?.kind === 'questionnaire' && !o.card.submitted && quietMs >= 2500 && Date.now() - this.lastActT > 5000) return 'card';
    const sinceAct = (Date.now() - this.lastActT) / 1000;
    if (o.type === 'task' && o.phase === 'active' && sinceAct >= this.nextTickSec && quietMs >= 1000) {
      this.nextTickSec = this.between(this.persona.knobs.tempoSec);
      return 'tick';
    }
    if (sinceAct > 25 && quietMs > 15_000 && Date.now() - this.lastIdleDecision > 20_000) {
      this.lastIdleDecision = Date.now();
      return 'idle';
    }
    return 'poll';
  }

  private ctx(o: Obs, trigger: BeatCtx['trigger'], quietMs: number): BeatCtx {
    const stepId = o.stepId;
    const stepEvents = this.events.filter((e) => e.stepId === stepId || (stepId === 'intro' && !e.stepId));
    const modStep = stepEvents.filter((e) => e.kind === 'transcript.moderator').map((e) => String(e.data.text));
    const ts = [...this.events].reverse().find((e) => e.kind === 'task.start' && e.stepId === stepId);
    return {
      obs: o,
      trigger,
      mod: trigger === 'moderator' ? this.pendingModeratorText() : '',
      modStep,
      taskSec: o.type === 'task' && o.phase === 'active' && ts ? (o.now - ts.t) / 1000 : null,
      quietSec: quietMs / 1000,
      fired: new Set(this.fired.keys()),
      readings: (text: string) => modStep.filter((m) => isReadingOf(m, text, 0.7)).length,
      since: (id: string) => (this.fired.has(id) ? (Date.now() - this.fired.get(id)!) / 1000 : -1),
      appPath: this.appPath,
    };
  }

  private matchBeat(c: BeatCtx): Beat | null {
    for (const b of this.o.beats ?? []) {
      if ((b.once ?? true) && this.fired.has(b.id)) continue;
      if (Date.now() < this.silenceUntil && c.trigger === 'poll') continue;
      try {
        if (b.when(c)) return b;
      } catch {
        /* predicate error: ignore */
      }
    }
    return null;
  }

  // ── persona rules ──────────────────────────────────────────────────────────
  private speakLine(intent: Intent, text: string): Action {
    return { kind: 'speak', intent, chunks: this.chunk(text, intent) };
  }

  /** Fillers, restarts and mid-answer thinking pauses (knobs). */
  private chunk(text: string, intent: Intent): Chunk[] {
    const k = this.persona.knobs;
    let t = text;
    if (this.persona.fillers.length && this.rand() < k.filler && !/^(yes|no|ja|nein|okay)\b/i.test(t)) t = `${this.pick(this.persona.fillers)}${t.charAt(0).toLowerCase()}${t.slice(1)}`;
    if (this.rand() < k.restart && t.split(' ').length > 6) t = `${this.persona.language === 'de' ? 'Ich würde — nein, warte, ' : 'I would — no, wait, '}${t.charAt(0).toLowerCase()}${t.slice(1)}`;
    if (['answer', 'think_aloud', 'observation'].includes(intent) && this.rand() < k.pause) {
      const s = splitNatural(t);
      if (s) return [{ text: s[0], pauseAfterMs: Math.round(1200 + this.rand() * 1800) }, { text: s[1], pauseAfterMs: 0 }];
    }
    return [{ text: t, pauseAfterMs: 0 }];
  }

  private scaleValue(q: { scale?: { min: number; max: number } } | undefined) {
    const sc = q?.scale ?? { min: 1, max: 7 };
    const r = this.persona.knobs.rating;
    return Math.max(sc.min, Math.min(sc.max, Math.round(sc.min + ((r - 1) / 6) * (sc.max - sc.min))));
  }

  /** Answer a protocol question (heard or seen on a card). */
  private answer(q: QInfo, o: Obs, seen: boolean, afterSilence = false): Action[] {
    const k = this.persona.knobs;
    const key = `${q.stepId}::${q.id}`;
    const n = (this.qTimes.get(key) ?? 0) + 1;
    this.qTimes.set(key, n);
    if (n === 1 && !afterSilence && this.rand() < k.silence) {
      const secs = 14 + this.rand() * 12;
      this.silenceUntil = Date.now() + secs * 1000;
      return [{ kind: 'wait', seconds: secs, intent: 'silence' }];
    }
    if (n === 1 && this.rand() < k.clarify) return [this.speakLine('clarify', this.line('clarify'))];
    if (n <= 2 && this.rand() < k.dontKnow * (n === 1 ? 1 : 0.6)) return [this.speakLine('answer', this.line('dontKnow'))];
    const cardQ = o.card?.questions.find((x) => x.id === q.id);
    const onCard = o.cardVisible && cardQ && q.kind !== 'open';
    const screen = onCard && (k.answer === 'screen' || (k.answer === 'mixed' && this.rand() < 0.5) || n >= 3);
    if (q.kind === 'rating') {
      const v = this.scaleValue(cardQ);
      return screen ? [{ kind: 'answer_card', value: v }] : [this.speakLine('answer', this.line('rating', '', v))];
    }
    if (q.kind === 'yes_no') return screen ? [{ kind: 'answer_card', value: 1 }] : [this.speakLine('answer', this.line('yes'))];
    if (q.kind === 'single_choice' || q.kind === 'multi_choice') return onCard ? [{ kind: 'answer_card', value: 0 }] : [this.speakLine('answer', this.line('ok'))];
    if (seen && !onCard) return [];
    return [this.speakLine('answer', this.line(/confus|verwirr/i.test(q.prompt) ? 'confusing' : 'open'))];
  }

  private rules(o: Obs, trig: BeatCtx['trigger'], c: BeatCtx): Action[] {
    const stepQs = this.o.questions.filter((q) => q.stepId === o.stepId);
    if (trig === 'moderator') {
      const M = c.mod;
      if (this.interruptedText) {
        const rest = this.interruptedText;
        this.interruptedText = '';
        return [this.speakLine('answer', this.line('interrupted', rest))];
      }
      if (o.stepId === 'intro') return [this.speakLine('ready', this.line('ready'))];
      if (CLOSING.test(M)) return [];
      if (HOW_WENT.test(M)) {
        const n = (this.qTimes.get(`${o.stepId}::howwent`) ?? 0) + 1;
        this.qTimes.set(`${o.stepId}::howwent`, n);
        if (n === 1 && this.rand() < this.persona.knobs.silence) {
          const secs = 12 + this.rand() * 10;
          this.silenceUntil = Date.now() + secs * 1000;
          return [{ kind: 'wait', seconds: secs, intent: 'silence' }];
        }
        if (n === 1 && this.rand() < this.persona.knobs.clarify * 0.6) return [this.speakLine('clarify', this.line('clarify'))];
        return [this.speakLine('answer', this.line('howWent'))];
      }
      const q = [...stepQs].reverse().find((x) => isReadingOf(M, x.prompt, 0.7));
      if (q) return this.answer(q, o, false);
      const task = o.stepId ? this.o.tasks[o.stepId] : undefined;
      if (task && isReadingOf(M, task, 0.7)) {
        this.nextTickSec = 2;
        return [];
      }
      if (/\bskip\b|überspringen/i.test(M) && /you can|können/i.test(M)) {
        const r = o.stepId ? this.taskRolls.get(o.stepId) : undefined;
        if (r?.skip || this.rand() < 0.3) {
          if (r) r.skipped = true;
          return [{ kind: 'press_skip' }];
        }
        return [this.speakLine('other', this.line('remindSkip'))];
      }
      if (NUDGE.test(M)) return this.rand() < 1 - this.persona.knobs.silence ? [this.speakLine('think_aloud', this.line('thinkNudge'))] : [];
      if (DEFLECT.test(M)) return [this.speakLine('complaint', this.line('deflected'))];
      if (/[?？]\s*$/.test(M.trim())) return [this.speakLine('answer', this.rand() < this.persona.knobs.dontKnow ? this.line('dontKnow') : this.line('ok'))];
      return [];
    }
    if (trig === 'card' && o.card) {
      if (o.card.kind === 'questionnaire') return o.card.submitted ? [] : [{ kind: 'submit_questionnaire', value: this.persona.knobs.rating >= 5 ? 4 : 3 }];
      const cq = o.card.questions.find((x) => x.id === o.card!.activeQuestionId) ?? o.card.questions[0];
      if (!cq) return [];
      return this.answer({ stepId: o.card.stepId, id: cq.id, prompt: cq.prompt, kind: cq.kind }, o, true);
    }
    if (trig === 'tick' && o.type === 'task' && o.phase === 'active' && o.stepId) return this.taskTick(o);
    if (trig === 'idle') {
      // Long silence (e.g. the persona's silence knob) and the moderator never re-prompted:
      // a real person eventually answers the last open question.
      const lastMod = [...this.events].reverse().find((e) => e.kind === 'transcript.moderator');
      const spoke = lastMod && this.timeline.utterances.some((u) => u.start > lastMod.t);
      if (lastMod && !spoke && lastMod.stepId === o.stepId) {
        const M = String(lastMod.data.text);
        if (HOW_WENT.test(M)) return [this.speakLine('answer', this.line('howWent'))];
        const q = [...stepQs].reverse().find((x) => isReadingOf(M, x.prompt, 0.7));
        if (q) return this.answer(q, o, false, true);
      }
    }
    if (trig === 'idle' && o.card && !o.answers.includes(`${o.card.stepId}::${o.card.activeQuestionId}`)) {
      const cq = o.card.questions[0];
      if (cq) return this.answer({ stepId: o.card.stepId, id: cq.id, prompt: cq.prompt, kind: cq.kind }, o, true);
    }
    return [];
  }

  /** One step of the task plan, then the done signal; may give up (skip knob). */
  private taskTick(o: Obs): Action[] {
    const r = this.taskRolls.get(o.stepId!)!;
    const k = this.persona.knobs;
    const plan = this.o.plans?.[o.stepId!] ?? [];
    const talk = this.rand() < (this.persona.id === 'silent' ? 0.15 : 0.75);
    if (!r.started) {
      r.started = true;
      if (talk) return [this.speakLine('think_aloud', this.line('thinkStart'))];
    }
    if (r.skip && !r.skipped && r.plan >= 1) {
      r.skipped = true;
      return k.done === 'button' || (k.done === 'mixed' && this.rand() < 0.5) ? [{ kind: 'press_skip' }] : [this.speakLine('request_skip', this.line('skip'))];
    }
    if (r.plan < plan.length) {
      const a = plan[r.plan++];
      if ((a.kind === 'click' || a.kind === 'type') && talk) return [this.speakLine('think_aloud', this.line('thinkClick', a.kind === 'click' ? a.name : a.text)), a];
      return [a];
    }
    if (!r.doneSignaled) {
      r.doneSignaled = true;
      return k.done === 'button' || (k.done === 'mixed' && this.rand() < 0.5) ? [{ kind: 'press_done' }] : [this.speakLine('declare_done', this.line('done'))];
    }
    return talk && this.rand() < 0.3 ? [this.speakLine('think_aloud', this.line('thinkNudge'))] : [];
  }

  // ── act ────────────────────────────────────────────────────────────────────
  async execute(actions: Action[], source: Source) {
    for (const a of actions) {
      if (this.page.isClosed()) return;
      try {
        await this.act(a, source);
      } catch (e) {
        this.timeline.actions.push({ t: this.obs?.now ?? -1, kind: a.kind, stepId: this.obs?.stepId ?? null, detail: describe(a), ok: false, error: (e as Error).message.slice(0, 200), source });
      }
    }
  }

  private async now() {
    return this.page.evaluate(() => (window as unknown as { __taRunner?: { queue: { now(): number } } }).__taRunner?.queue.now() ?? -1).catch(() => -1);
  }

  private async act(a: Action, source: Source) {
    const p = this.page;
    const stepId = this.obs?.stepId ?? null;
    const rec = (ok = true, detail = describe(a), t?: number) => this.timeline.actions.push({ t: t ?? this.obs?.now ?? -1, kind: a.kind, stepId, detail, ok, source });
    switch (a.kind) {
      case 'speak':
        await this.speak(a.intent, a.chunks, source);
        return;
      case 'wait': {
        const t = await this.now();
        rec(true, `${a.intent ?? 'wait'} ${a.seconds.toFixed(0)}s${a.untilModerator ? ' (until moderator speaks)' : ''}`, t);
        const until = Date.now() + a.seconds * 1000;
        const modBefore = this.events.filter((e) => e.kind === 'transcript.moderator').length;
        while (Date.now() < until) {
          await sleep(300);
          const o = await this.observe();
          if (!o || o.doneScreen) return;
          if (a.untilModerator && this.events.filter((e) => e.kind === 'transcript.moderator').length > modBefore && this.moderatorIdle(o)) return;
        }
        return;
      }
      case 'press_done': {
        const t = await this.now();
        await p.getByTestId('im-done').click({ timeout: 4000 });
        rec(true, "pressed I'm done", t);
        return;
      }
      case 'press_skip': {
        const t = await this.now();
        await p.getByTestId('skip-task').click({ timeout: 4000 });
        rec(true, 'pressed Skip task', t);
        return;
      }
      case 'click': {
        const f = p.frameLocator('[data-testid=app-frame]');
        const t = await this.now();
        try {
          await f.getByRole(a.role as Parameters<typeof f.getByRole>[0], { name: a.name, exact: false }).first().click({ timeout: 3000 });
        } catch {
          await f.getByText(a.name, { exact: false }).first().click({ timeout: 3000 });
        }
        rec(true, `${a.role} "${a.name}"`, t);
        await sleep(500);
        return;
      }
      case 'type': {
        const f = p.frameLocator('[data-testid=app-frame]');
        const t = await this.now();
        let box = a.name ? f.getByRole('searchbox', { name: a.name, exact: false }).or(f.getByRole('textbox', { name: a.name, exact: false })).first() : f.locator('input, textarea').first();
        if (!(await box.count().catch(() => 0))) box = f.locator('input, textarea').first();
        await box.click({ timeout: 3000 });
        await box.pressSequentially(a.text, { delay: 60 + this.rand() * 80 });
        if (a.enter) await box.press('Enter');
        rec(true, `"${a.text}" into ${a.name || 'input'}`, t);
        return;
      }
      case 'answer_card': {
        const t = await this.now();
        const o = this.obs;
        const card = p.getByTestId('question-card');
        const q = o?.card?.questions.find((x) => x.id === o.card?.activeQuestionId) ?? o?.card?.questions[0];
        if (!q) throw new Error('no card on screen');
        if (q.kind === 'rating') {
          const sc = q.scale ?? { min: 1, max: 7 };
          const v = Math.max(sc.min, Math.min(sc.max, Math.round(a.value ?? Math.round((sc.min + sc.max) / 2))));
          const radio = card.locator(`[role=radio][data-value="${v}"]`);
          if (await radio.count()) await radio.click({ timeout: 3000 });
          else await card.locator('input[type=range]').fill(String(v));
          rec(true, `${q.id} = ${v}`, t);
        } else if (q.kind === 'yes_no') {
          const yes = a.value === 1 || /^(y|ja)/i.test(a.choice ?? '');
          await card.getByRole('button').nth(yes ? 0 : 1).click({ timeout: 3000 });
          rec(true, `${q.id} = ${yes ? 'Yes' : 'No'}`, t);
        } else if (q.kind === 'single_choice' || q.kind === 'multi_choice') {
          const label = a.choice ?? q.options?.[a.value ?? 0] ?? q.options?.[0] ?? '';
          await card.getByRole('button', { name: label, exact: false }).first().click({ timeout: 3000 });
          rec(true, `${q.id} = ${label}`, t);
        } else if (q.kind === 'number') {
          await card.locator('input[type=number]').fill(String(a.value ?? 0));
          await card.getByRole('button', { name: /save/i }).click({ timeout: 3000 });
          rec(true, `${q.id} = ${a.value}`, t);
        } else {
          const ta = card.locator('textarea');
          if (!(await ta.count())) {
            await this.speak('answer', [{ text: a.text || "I don't know.", pauseAfterMs: 0 }], source);
            return;
          }
          await ta.fill(a.text || "I don't know.");
          await card.getByRole('button', { name: /save answer|update answer/i }).click({ timeout: 3000 });
          rec(true, `${q.id} = "${a.text}"`, t);
        }
        return;
      }
      case 'submit_questionnaire': {
        const t = await this.now();
        const qc = p.getByTestId('questionnaire-card');
        for (const li of await qc.locator('li[data-qid]').all()) {
          const radios = li.locator('[role=radio]');
          const n = await radios.count();
          if (n && !(await li.locator('[role=radio][aria-checked=true]').count())) {
            const first = Number((await radios.first().getAttribute('data-value')) ?? 1);
            const idx = a.value != null ? Math.max(0, Math.min(n - 1, Math.round(a.value) - first)) : Math.floor(n * 0.6);
            await radios.nth(idx).click();
            await sleep(300 + this.rand() * 600);
          }
          const range = li.locator('input[type=range]');
          if (await range.count()) await range.fill('70');
        }
        await qc.getByRole('button', { name: /^submit/i }).click({ timeout: 4000 });
        rec(true, 'filled in and submitted the questionnaire', t);
        return;
      }
    }
  }

  /**
   * Speak chunks: each chunk is speech-shaped noise in the fake mic plus a VAD speech segment in the
   * mock realtime layer (ASR text = the chunk without the written "…"); pauses in between are real
   * silence, so the mock's semantic-VAD hold decides whether the turn is committed mid-answer.
   */
  async speak(intent: Intent, chunks: Chunk[], source: Source) {
    const mock = this.o.mock;
    const u: UtteranceRec = { id: ++this.uttSeq, intent, stepId: this.obs?.stepId ?? null, text: chunks.map((c) => c.text).join(' '), planned: chunks, chunks: [], start: -1, end: -1, finished: false, source };
    this.timeline.utterances.push(u);
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const words = c.text.split(/\s+/).filter(Boolean).length;
      const dur = Math.round((words / this.persona.knobs.wps) * 1000 + 250);
      const start = await this.now();
      void this.page.evaluate((ms) => (window as unknown as { __harnessNoise?: (ms: number) => Promise<void> }).__harnessNoise?.(ms), dur).catch(() => {});
      const last = i === chunks.length - 1;
      if (mock.userSpeechChunk) mock.userSpeechChunk(asr(c.text, last), dur, !last);
      else mock.userSpeechStart();
      await sleep(dur);
      if (!mock.userSpeechChunk) mock.userSpeechEnd(asr(c.text, last), !last);
      const end = await this.now();
      if (u.start < 0) u.start = start;
      u.end = end;
      u.chunks.push({ text: c.text, start, end, pauseAfterMs: c.pauseAfterMs });
      this.convo.push({ t: start, who: 'you', text: c.text });
      if (!last) {
        const pauseEnd = Date.now() + c.pauseAfterMs;
        let hit: number | null = this.modSpeechSince(start);
        while (hit == null && Date.now() < pauseEnd) {
          await sleep(100);
          if (mock.moderatorAudio) {
            await this.observe();
            hit = this.modSpeechSince(start) ?? (await this.now());
          }
        }
        if (hit != null) {
          u.interruptedAt = hit;
          if (!this.persona.knobs.talksOver) {
            this.interruptedText = chunks.slice(i + 1).map((x) => x.text.replace(/^…/, '')).join(' ');
            this.timeline.notes.push(`Utterance ${u.id} ("${u.text.slice(0, 60)}") interrupted by the moderator at ${(hit / 1000).toFixed(1)}s; participant stopped to listen.`);
            break;
          }
        }
      }
    }
    u.finished = u.chunks.length === chunks.length;
    this.log(`[${this.persona.id}] said (${intent}) "${u.text}"${u.finished ? '' : ' [cut short]'}`);
  }

  private modSpeechSince(t: number): number | null {
    const e = this.events.find((x) => x.kind === 'speech.start' && x.data.who === 'moderator' && x.t >= t);
    return e ? e.t : null;
  }
}

/** What the speech recogniser would output for a chunk (no written ellipses; final chunk punctuated). */
function asr(text: string, final: boolean) {
  let t = text.replace(/^…\s*/, '').replace(/\s*(…|\.\.\.)\s*$/, '').replace(/…/g, ' ').replace(/\s+/g, ' ').trim();
  if (final && !/[.!?]$/.test(t)) t += '.';
  if (!final) t = t.replace(/[.,;:]$/, '');
  return t;
}

function describe(a: Action): string {
  switch (a.kind) {
    case 'speak':
      return `"${a.chunks.map((c) => c.text).join(' … ')}"`;
    case 'click':
      return `${a.role} "${a.name}"`;
    case 'type':
      return `"${a.text}"`;
    case 'answer_card':
      return a.text ? `"${a.text}"` : a.choice ?? String(a.value);
    case 'wait':
      return `${a.seconds}s`;
    default:
      return '';
  }
}

/** Split a sentence at a natural boundary near the middle (for mid-answer pauses). */
export function splitNatural(text: string): [string, string] | null {
  const words = text.split(/\s+/);
  if (words.length < 7) return null;
  const mid = text.length / 2;
  const cands: number[] = [];
  const re = /(, | and | but | because | so | aber | und | weil )/gi;
  for (let m = re.exec(text); m; m = re.exec(text)) cands.push(m.index + (m[0].startsWith(',') ? 1 : 0));
  if (!cands.length) cands.push(text.indexOf(' ', Math.floor(mid)));
  const at = cands.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid))[0];
  if (at <= 0 || at >= text.length - 3) return null;
  const a = text.slice(0, at).trim();
  const b = text.slice(at).replace(/^,/, '').trim();
  return [`${a}…`, `…${b}`];
}
