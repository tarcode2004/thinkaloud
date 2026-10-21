// ─────────────────────────────────────────────────────────────────────────────
// SessionRunner — the single source of truth for the participant session.
// Owns the step state machine, validates every moderator tool call against the
// active step, evaluates deterministic success rules, watches app behaviour
// (probe), triggers neutral nudges/probes, and logs everything to EventQueue.
// The AI moderator only ever sees the CURRENT step via briefs (shared/moderator.ts).
// ─────────────────────────────────────────────────────────────────────────────
import {
  buildBrief,
  buildModeratorInstructions,
  describeScale,
  followUpBudget,
  languageName,
  MODERATOR_TOOLS,
  questionHasCard,
  questionnaireOnScreen,
  stepQuestions,
  type BriefContext,
  type ConsentRecord,
  type ElementDescriptor,
  type ModeratorBrief,
  type PointBatchData,
  type Question,
  type StartSessionResponse,
  type Step,
  type SuccessRule,
  type TaskOutcome,
  type TaskStep,
} from '@thinkaloud/shared';
import { pApi, type SessionAuth } from './api.ts';
import { EventQueue, RrwebUploader } from './eventQueue.ts';
import { LevelMeter, MixedRecorder } from './media.ts';
import { ProbeBridge, type ProbeEvent } from './probeBridge.ts';
import { RealtimeClient, type FunctionCall, type RealtimeStatus } from './realtime.ts';
import { addressedToModerator, clickRuleMatches, describeElement, isReadingOf, urlMatches } from './rules.ts';
import type { EyeTracker } from './eyetracking.ts';

export type RunnerMode = 'voice' | 'text' | 'manual';
export type OrbState = 'connecting' | 'listening' | 'user' | 'assistant' | 'thinking' | 'muted' | 'offline';
export type TaskPhase = 'briefing' | 'active' | 'post';
export type AppStatus = 'none' | 'loading' | 'ready' | 'crashed' | 'limited';

export interface Caption {
  id: string;
  role: 'moderator' | 'participant';
  text: string;
  final: boolean;
  /** Step index the caption belongs to. */
  step: number;
}

export interface AnswerValue {
  text?: string;
  value?: number;
  choices?: string[];
  source: 'voice' | 'screen' | 'text';
}

export interface CardState {
  kind: 'question' | 'questionnaire';
  stepId: string;
  title?: string;
  questions: Question[];
  /** For one-at-a-time cards. */
  activeQuestionId?: string;
  submitted?: boolean;
}

export interface RunnerState {
  mode: RunnerMode;
  conn: RealtimeStatus | 'none';
  orb: OrbState;
  muted: boolean;
  /** -1 intro, steps.length closing */
  index: number;
  total: number;
  step: Step | null;
  taskPhase: TaskPhase | null;
  taskStartedAt: number | null;
  taskDeadline: number | null;
  appVisible: boolean;
  appStatus: AppStatus;
  card: CardState | null;
  answers: Record<string, AnswerValue>;
  captions: Caption[];
  /** Waiting for the moderator to react to a button press. */
  pendingAction: string | null;
  /** Text shown in manual (no-AI) mode. */
  manualPrompt: string | null;
  manualError: string | null;
  notice: string | null;
  exploreEndsAt: number | null;
  ended: boolean;
  recording: boolean;
  /** The app iframe: `key` changes to remount it (fresh renderer process); `src` null = unmounted. */
  appFrame: { key: number; src: string | null };
}

export interface RunnerOptions {
  auth: SessionAuth;
  start: StartSessionResponse;
  consent: ConsentRecord;
  mic: MediaStream | null;
  audioEl: HTMLAudioElement;
  eye?: EyeTracker | null;
  /** Called when the session finished normally. */
  onFinished: (redirectUrl: string | null) => void;
  /** Force manual mode (no AI) — e.g. realtime unavailable. */
  forceManual?: boolean;
  /** Eye-tracking calibration result (logged as eyetracking.calibrated at start). */
  calibration?: { errorPx: number; points: number } | null;
}

const akey = (stepId: string, qid: string) => `${stepId}::${qid}`;

export class SessionRunner {
  readonly queue: EventQueue;
  readonly bridge: ProbeBridge;
  private rrweb: RrwebUploader;
  private rt: RealtimeClient | null = null;
  private recorder: MixedRecorder | null = null;
  micMeter: LevelMeter | null = null;
  remoteMeter: LevelMeter | null = null;
  private steps: Step[];
  private state: RunnerState;
  private listeners = new Set<() => void>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private iframe: HTMLIFrameElement | null = null;
  private disposed = false;

  // per-step bookkeeping
  private skipped = new Set<string>();
  private followUpsUsed = 0;
  private followUpQuestionId: string | null = null;
  private heardSinceStep = false;
  private questionnaireSubmitted = false;
  private stepEnteredAt = 0;
  private briefDelivered = false;
  /** The moderator actually read the current task instruction (gates the 'briefed' task start). */
  private instructionHeard = false;
  private exploreTimer: ReturnType<typeof setTimeout> | null = null;
  private exploreDone = false;

  // task bookkeeping
  private taskWallStart = 0;
  private taskOutcome: { outcome: TaskOutcome; source: 'rule' | 'ai' | 'participant' } | null = null;
  private doneRequested = false;
  private taskEndedAt = 0;
  private ignoreNavUntil = 0;
  private domPollBusy = false;
  private taskActivateTimer: ReturnType<typeof setTimeout> | null = null;

  // conversation / timing
  private quiet = false;
  private lastUserSpeech = 0; // performance.now of last speech start/stop
  private lastAssistantAudio = 0;
  private lastTrigger = 0;
  private nudgesThisTask = 0;
  private lastAppAction = 0;
  private userSpeechStartT: number | null = null;
  private appFeed: string[] = [];
  private recentNavs: { path: string; at: number }[] = [];
  private recentDead: number[] = [];
  private recentPops: number[] = [];
  private recentErrors: number[] = [];
  /** Notable behaviour seen during the current task (by kind), asked about after the task. */
  private observed = new Map<string, string>();
  private behaviourProbeAsked = false;
  private lastClickDesc = '';
  private crashReported = false;
  private crashAt = 0;
  private crashNoticePending = false;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private transcriptLog: { role: string; text: string }[] = [];
  private closingSpoken = false;
  private finishing = false;
  private gazeBuf: [number, number, number][] = [];
  private captionSeq = 0;
  /** Quiet-phase turn-taking decisions (debug / tests). */
  readonly turnChecks: { text: string; addressed: boolean; via: string; verdict: string | null; at: number }[] = [];

  constructor(private opts: RunnerOptions) {
    this.steps = opts.start.steps;
    this.queue = new EventQueue(opts.auth);
    this.rrweb = new RrwebUploader(opts.auth);
    const mode: RunnerMode = opts.forceManual ? 'manual' : opts.mic ? 'voice' : 'text';
    this.state = {
      mode,
      conn: mode === 'manual' ? 'none' : 'idle',
      orb: mode === 'manual' ? 'offline' : 'connecting',
      muted: false,
      index: -1,
      total: this.steps.length,
      step: null,
      taskPhase: null,
      taskStartedAt: null,
      taskDeadline: null,
      appVisible: false,
      appStatus: opts.start.appUrl ? (opts.start.appInstrumented ? 'loading' : 'limited') : 'none',
      card: null,
      answers: {},
      captions: [],
      pendingAction: null,
      manualPrompt: null,
      manualError: null,
      notice: null,
      exploreEndsAt: null,
      ended: false,
      recording: false,
      appFrame: { key: 0, src: opts.start.appUrl ?? null },
    };
    this.bridge = new ProbeBridge({
      onHello: (path) => this.onProbeHello(path),
      onHeartbeat: (path) => this.onProbePath(path, false),
      onEvents: (evs) => this.onProbeEvents(evs),
      onRrweb: (evs) => {
        if (this.opts.consent.screen) this.rrweb.add(evs);
      },
    });
  }

  // ── store ──────────────────────────────────────────────────────────────────
  get snapshot(): RunnerState {
    return this.state;
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = () => this.state;
  private set(patch: Partial<RunnerState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  get protocol() {
    return this.opts.start.protocol;
  }
  get mod() {
    return this.opts.start.protocol.moderation;
  }
  private get step(): Step | null {
    return this.state.step;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  async start() {
    const { startedAt } = await pApi.begin(this.opts.auth).catch(() => ({ startedAt: Date.now() }));
    this.queue.begin(startedAt);
    this.queue.push('session.start', {
      mode: this.state.mode,
      variantId: this.opts.start.variant.id,
      appUrl: this.opts.start.appUrl,
      appInstrumented: this.opts.start.appInstrumented,
      language: this.mod.language,
    });
    if (this.opts.calibration && this.opts.eye) this.queue.push('eyetracking.calibrated', { errorPx: this.opts.calibration.errorPx, points: this.opts.calibration.points });
    this.bridge.setConfig({
      sessionId: this.opts.auth.sessionId,
      recordScreen: Boolean(this.opts.consent.screen && this.protocol.consent.recordScreen),
      maskAllInputs: true,
      mouseSampleMs: 50,
    });
    if (this.opts.mic) {
      this.micMeter = new LevelMeter(this.opts.mic);
      this.opts.mic.getAudioTracks().forEach((t) => (t.enabled = true));
    }
    this.timers.push(setInterval(() => this.tick(), 1000));
    this.timers.push(setInterval(() => this.flushAppFeed(), 3000));
    this.timers.push(setInterval(() => void this.pollDomRules(), 1500));
    this.timers.push(setInterval(() => this.flushGaze(), 1000));
    if (this.opts.eye?.running) {
      this.opts.eye.frameMs = 100; // ~10 fps is plenty for heatmaps; keeps CPU low next to the app + audio
      this.opts.eye.onGaze((x, y) => this.onGaze(x, y));
    }

    if (this.opts.consent.audio && this.protocol.consent.storeAudio) {
      this.recorder = new MixedRecorder(this.opts.auth);
      if (this.opts.mic) this.recorder.addStream(this.opts.mic);
    }

    if (this.state.mode === 'manual') {
      this.startRecorder();
      this.enterStep(-1, 'announce');
      return;
    }
    try {
      await this.connectRealtime();
    } catch (e) {
      console.warn('[runner] realtime unavailable, switching to manual mode', e);
      this.queue.push('session.error', { message: `Realtime unavailable: ${(e as Error).message}`, fallback: 'manual' });
      this.toManual('We could not connect the voice moderator, so this session continues on screen.');
      this.startRecorder();
      this.enterStep(-1, 'announce');
    }
  }

  private startRecorder() {
    if (this.recorder && !this.recorder.started && this.recorder.start()) {
      this.queue.push('media.audio_start', { t: this.queue.now(), track: 'mixed' });
      this.set({ recording: true });
    }
  }

  private toManual(notice: string) {
    this.rt?.close();
    this.rt = null;
    this.set({ mode: 'manual', conn: 'none', orb: 'offline', notice, pendingAction: null });
    if (this.step || this.state.index >= 0) this.refreshManualPrompt();
  }

  private async connectRealtime() {
    const rt = new RealtimeClient({
      getToken: () => pApi.realtimeToken(this.opts.auth),
      mic: this.opts.mic,
      audioEl: this.opts.audioEl,
      handlers: {
        onStatus: (s, detail) => {
          this.set({ conn: s });
          this.updateOrb();
          if (s === 'failed') {
            this.queue.push('session.error', { message: `Realtime connection failed: ${detail ?? ''}`, fallback: 'manual' });
            this.toManual('The voice connection was lost, so we continue on screen. Your progress is saved.');
          }
        },
        onReady: (reconnected) => this.onRealtimeReady(reconnected),
        onRemoteStream: (stream) => {
          this.remoteMeter?.dispose();
          this.remoteMeter = new LevelMeter(stream);
          if (this.recorder) {
            this.recorder.addStream(stream);
            this.startRecorder();
          }
        },
        onFunctionCall: (call) => this.handleToolCall(call),
        onUserSpeechStart: () => {
          this.lastUserSpeech = performance.now();
          this.userSpeechStartT = this.queue.now();
          this.heardSinceStep = true;
          this.queue.push('speech.start', { who: 'participant' });
          this.updateOrb();
        },
        onUserSpeechStop: () => {
          this.lastUserSpeech = performance.now();
          this.queue.push('speech.stop', { who: 'participant' });
          this.updateOrb();
        },
        onUserTranscriptDelta: (itemId, delta) => this.caption('participant', itemId, delta, false, true),
        onUserTranscript: (itemId, text) => this.onUserTranscript(itemId, text),
        onAssistantTranscriptDelta: (rid, delta) => this.caption('moderator', rid, delta, false, true),
        onAssistantTranscript: (rid, text, phase) => this.onAssistantTranscript(rid, text, phase),
        onAssistantAudioStart: () => {
          this.lastAssistantAudio = performance.now();
          this.queue.push('speech.start', { who: 'moderator' });
          this.updateOrb();
        },
        onAssistantAudioStop: () => {
          this.lastAssistantAudio = performance.now();
          this.queue.push('speech.stop', { who: 'moderator' });
          this.updateOrb();
          this.onModeratorFinishedSpeaking();
        },
        onResponseStart: () => this.updateOrb(),
        onResponseDone: () => {
          this.updateOrb();
          // In text-only output there is no audio stop event.
          if (!rt.assistantAudioPlaying) this.onModeratorFinishedSpeaking();
        },
        onError: (message, code) => this.queue.push('session.error', { message, code, source: 'realtime' }),
      },
    });
    this.rt = rt;
    await rt.connectWithRetry();
  }

  private onRealtimeReady(reconnected: boolean) {
    const rt = this.rt!;
    rt.updateSession({
      instructions: buildModeratorInstructions(this.protocol, this.steps),
      tools: MODERATOR_TOOLS,
      tool_choice: 'auto',
    });
    this.applyTurnDetection(true);
    if (!reconnected) {
      this.enterStep(-1, 'announce');
      return;
    }
    const recent = this.transcriptLog
      .slice(-8)
      .map((l) => `${l.role}: ${l.text}`)
      .join('\n');
    rt.addSystemItem(
      `[EVENT] The connection dropped briefly and was restored. Recent conversation:\n${recent || '(none)'}\nSay one short sentence like "Sorry, we had a short connection problem." and then continue exactly where you left off according to this brief (do not restart earlier steps):\n[STEP] ${JSON.stringify(this.brief())}`,
    );
    rt.requestResponse();
  }

  private applyTurnDetection(force = false) {
    if (!this.rt || !this.opts.mic) return;
    const quiet = this.isQuietPhase();
    if (!force && quiet === this.quiet) return;
    this.quiet = quiet;
    this.rt.updateSession({
      audio: {
        input: {
          turn_detection: { type: 'semantic_vad', eagerness: 'low', create_response: !quiet, interrupt_response: true },
        },
      },
    });
  }

  /** Phases where the participant works and the moderator should not respond to every utterance. */
  private isQuietPhase() {
    const s = this.step;
    if (!s) return false;
    if (s.type === 'task') return this.state.taskPhase === 'active' && !this.doneRequested;
    if (s.type === 'instruction') return (s.exploreSeconds ?? 0) > 0 && this.state.exploreEndsAt != null && !this.exploreDone;
    if (s.type === 'questionnaire') return questionnaireOnScreen(s) && !this.questionnaireSubmitted;
    return false;
  }

  private updateOrb() {
    let orb: OrbState;
    const rt = this.rt;
    if (this.state.mode === 'manual') orb = 'offline';
    else if (!rt || rt.status === 'connecting' || rt.status === 'reconnecting' || rt.status === 'idle') orb = 'connecting';
    else if (rt.assistantAudioPlaying) orb = 'assistant';
    else if (this.state.muted) orb = 'muted';
    else if (rt.userSpeaking) orb = 'user';
    else if (rt.responding) orb = 'thinking';
    else orb = 'listening';
    if (orb !== this.state.orb) this.set({ orb });
  }

  // ── captions / transcripts ─────────────────────────────────────────────────
  private caption(role: Caption['role'], id: string, text: string, final: boolean, append: boolean) {
    const cid = `${role}:${id}`;
    const caps = [...this.state.captions];
    const i = caps.findIndex((c) => c.id === cid);
    if (i >= 0) caps[i] = { ...caps[i], text: append ? caps[i].text + text : text, final };
    else caps.push({ id: cid, role, text, final, step: this.state.index });
    this.set({ captions: caps.slice(-8) });
  }

  private onUserTranscript(itemId: string, text: string) {
    this.caption('participant', itemId, text, true, false);
    if (!text) return;
    this.heardSinceStep = true;
    this.transcriptLog.push({ role: 'participant', text });
    this.queue.push('transcript.participant', { text, itemId, startT: this.userSpeechStartT ?? undefined, endT: this.queue.now(), source: 'voice' });
    // In quiet phases the VAD doesn't auto-respond; respond only when addressed.
    if (this.quiet && this.rt) void this.respondIfAddressed(text);
  }

  /**
   * Quiet phases (active task, exploration, on-screen questionnaire): should the moderator answer
   * this utterance? Decided by the model itself in a silent out-of-band check (works in any
   * language, and it hears the audio); falls back to punctuation / English keywords on timeout.
   */
  private async respondIfAddressed(text: string) {
    const rt = this.rt;
    if (!rt) return;
    const stepId = this.step?.id;
    const onScreenForm = this.step?.type === 'questionnaire';
    const verdict = await rt.classify(
      `You are a silent turn-taking classifier for a usability-test moderator — you are NOT talking to anyone. The participant is ${
        onScreenForm ? 'filling in an on-screen questionnaire' : 'working on a task and thinking aloud'
      }. Their most recent utterance (it may be in any language) was transcribed as: "${text.replace(/"/g, "'")}".
Answer YES if they are addressing the moderator and expect a reply or an action: a question to the moderator, a request for help or to repeat something, saying they are done / finished / want to skip, stop or give up${
        onScreenForm ? ', or saying a rating or answer for one of the on-screen items' : ''
      }. Answer NO if they are thinking aloud, describing what they see or do, reading text aloud, or asking themselves a question.
Reply with exactly one word: YES or NO.`,
      4000,
    );
    let addressed: boolean;
    let via: 'model' | 'fallback';
    if (verdict && /^\W*(yes|no)\b/i.test(verdict)) {
      addressed = /^\W*yes/i.test(verdict);
      via = 'model';
    } else {
      addressed = /[?？؟¿]/.test(text) || ((this.mod.language ?? 'en').toLowerCase().startsWith('en') && addressedToModerator(text));
      via = 'fallback';
    }
    this.turnChecks.push({ text, addressed, via, verdict, at: this.queue.now() });
    if (this.turnChecks.length > 50) this.turnChecks.shift();
    if (addressed && this.quiet && this.rt === rt && this.step?.id === stepId) rt.requestResponse();
  }

  private onAssistantTranscript(rid: string, text: string, phase?: string) {
    this.caption('moderator', rid, text, true, false);
    if (!text) return;
    this.transcriptLog.push({ role: 'moderator', text });
    this.queue.push('transcript.moderator', { text, responseId: rid, ...(phase ? { phase } : {}) });
    if (this.step?.type === 'task' && this.state.taskPhase === 'briefing' && isReadingOf(text, (this.step as TaskStep).instruction)) this.instructionHeard = true;
    // Follow-up accounting: a question that isn't a reading of the current prompt counts as a follow-up.
    if (/[?？؟]/.test(text) && this.step && this.state.index >= 0) {
      const q = this.nextQuestion();
      const prompts = [q?.prompt, this.step.type === 'task' ? (this.step as TaskStep).instruction : undefined].filter(Boolean) as string[];
      const isPrompt = prompts.some((p) => isReadingOf(text, p));
      const countable = this.step.type !== 'task' || this.state.taskPhase === 'post';
      if (!isPrompt && countable && this.briefDelivered) {
        this.followUpsUsed++;
        if (this.step.type === 'task' && !q && this.observed.size && !this.behaviourProbeAsked) {
          this.behaviourProbeAsked = true;
          this.queue.push('moderator.probe', { reason: [...this.observed.keys()].join(','), observed: [...this.observed.values()], text, phase: 'post_task' });
        }
      }
    }
    if (this.state.index >= this.steps.length && isReadingOf(text, this.protocol.closing)) this.closingSpoken = true;
  }

  // ── step machine ───────────────────────────────────────────────────────────
  private questionQueue(): Question[] {
    const s = this.step;
    if (!s) return [];
    if (s.type === 'task') return this.state.taskPhase === 'post' ? stepQuestions(s) : [];
    return stepQuestions(s);
  }

  private isHandled(q: Question) {
    const s = this.step!;
    return Boolean(this.state.answers[akey(s.id, q.id)]) || this.skipped.has(q.id);
  }

  private queueAnswered() {
    return this.questionQueue().filter((q) => this.isHandled(q)).length;
  }

  private nextQuestion(): Question | null {
    return this.questionQueue().find((q) => !this.isHandled(q)) ?? null;
  }

  private remainingFollowUps(): number {
    const s = this.step;
    const budget = followUpBudget(this.mod, s ?? undefined);
    if (s?.type === 'interview') {
      const q = this.nextQuestion();
      if (q && q.id !== this.followUpQuestionId) {
        this.followUpQuestionId = q.id;
        this.followUpsUsed = 0;
      }
    }
    return Math.max(0, budget - this.followUpsUsed);
  }

  private briefCtx(): BriefContext {
    const queue = this.questionQueue();
    return {
      protocol: this.protocol,
      steps: this.steps,
      index: this.state.index,
      taskPhase: this.state.taskPhase ?? undefined,
      remainingFollowUps: this.remainingFollowUps(),
      nextQuestion: this.step && this.step.type !== 'instruction' ? this.nextQuestion() : undefined,
      answeredCount: queue.filter((q) => this.isHandled(q)).length,
      exploreLeftSec: this.state.exploreEndsAt ? Math.max(0, (this.state.exploreEndsAt - Date.now()) / 1000) : undefined,
      taskElapsedSec: this.state.taskStartedAt ? (Date.now() - this.state.taskStartedAt) / 1000 : undefined,
      taskTimeLeftSec: this.state.taskDeadline ? Math.max(0, (this.state.taskDeadline - Date.now()) / 1000) : null,
      taskOutcomeSet: Boolean(this.taskOutcome),
      questionnaireSubmitted: this.questionnaireSubmitted,
      appVisible: this.state.appVisible,
      observedBehaviour: this.step?.type === 'task' && this.state.taskPhase === 'post' && !this.behaviourProbeAsked ? [...this.observed.values()] : undefined,
    };
  }

  brief(): ModeratorBrief {
    return buildBrief(this.briefCtx());
  }

  /**
   * Enter step `index` (-1 intro, steps.length closing).
   * mode 'announce' → inject the brief as a system item + ask for a response (runner-initiated).
   * mode 'return' → the caller (a tool handler) returns the brief as tool output.
   */
  private enterStep(index: number, mode: 'announce' | 'return', prefix?: string, ack?: string): ModeratorBrief {
    const prev = this.step;
    if (prev) this.queue.push('step.exit', { index: this.state.index, type: prev.type }, { stepId: prev.id });
    this.clearStepTimers();
    const step = index >= 0 && index < this.steps.length ? this.steps[index] : null;
    this.skipped = new Set();
    this.followUpsUsed = 0;
    this.followUpQuestionId = null;
    this.heardSinceStep = false;
    this.questionnaireSubmitted = false;
    this.exploreDone = false;
    this.stepEnteredAt = performance.now();
    this.briefDelivered = false;
    this.instructionHeard = false;
    this.taskOutcome = null;
    this.doneRequested = false;
    this.nudgesThisTask = 0;
    this.observed = new Map();
    this.behaviourProbeAsked = false;
    this.queue.stepId = step?.id ?? (index < 0 ? 'intro' : 'closing');
    const showApp = Boolean(step && this.opts.start.appUrl && (step.type === 'task' || (step.type === 'instruction' && step.showApp)));
    this.set({
      index,
      step,
      taskPhase: step?.type === 'task' ? 'briefing' : null,
      taskStartedAt: null,
      taskDeadline: null,
      appVisible: showApp,
      card: null,
      pendingAction: null,
      exploreEndsAt: null,
      manualError: null,
    });
    this.queue.push('step.enter', { index, type: step?.type ?? (index < 0 ? 'intro' : 'closing'), title: step?.title ?? (index < 0 ? 'Introduction' : 'Closing') });

    if (step?.type === 'task') {
      if (this.opts.start.appUrl) this.navigateApp(step.startPath);
      // Task becomes active when the moderator finished reading it, on first interaction, or after 25s.
      this.taskActivateTimer = setTimeout(() => this.activateTask('timeout'), this.state.mode === 'manual' ? 0 : 25_000);
    }
    if (step?.type === 'instruction' && (step.exploreSeconds ?? 0) > 0 && this.state.mode === 'manual') this.startExplore();
    this.updateCard();
    this.applyTurnDetection();
    if (this.state.mode === 'manual') {
      this.refreshManualPrompt();
      return this.brief();
    }
    const brief = this.brief();
    if (mode === 'announce' && this.rt && index >= this.steps.length) {
      this.rt.cancelResponse();
      this.sayClosing(ack);
      this.briefDelivered = true;
      return brief;
    }
    if (mode === 'announce' && this.rt) {
      this.rt.addSystemItem(`${prefix ? `${prefix}\n` : ''}[STEP] ${JSON.stringify(brief)}`);
      // Verbatim text known: dictate this turn (no improvisation, no tool calls, no double reading).
      if (brief.say_verbatim) this.directed(`${ack ? `${this.ackPhrase(ack)}, then say` : 'Say'} the following text verbatim, completely and only once, and nothing else:\n"${brief.say_verbatim}"`);
      else this.rt.requestResponse();
      this.briefDelivered = true;
    } else this.briefDelivered = true;
    return brief;
  }

  /** "Say "<ack>"" — or its equivalent in the session language. */
  private ackPhrase(ack: string) {
    const lang = this.mod.language?.toLowerCase().split(/[-_]/)[0] ?? 'en';
    return lang === 'en' ? `Say "${ack}"` : `Say a short, natural ${languageName(this.mod.language)} equivalent of "${ack}"`;
  }

  private sayClosing(ack?: string) {
    this.directed(`The session is over. ${ack ? `${this.ackPhrase(ack)}, then say` : 'Say'} exactly the following text, verbatim, and nothing else:\n"${this.protocol.closing}"`);
  }

  private clearStepTimers() {
    if (this.exploreTimer) clearTimeout(this.exploreTimer);
    if (this.taskActivateTimer) clearTimeout(this.taskActivateTimer);
    this.exploreTimer = null;
    this.taskActivateTimer = null;
  }

  /** Called whenever the moderator stops talking. */
  private onModeratorFinishedSpeaking() {
    const s = this.step;
    // Only a finished reading of the instruction starts the task. A leftover line from the previous
    // step (or an interrupted reading) must not start the clock; the 25 s timeout is the fallback.
    if (s?.type === 'task' && this.state.taskPhase === 'briefing' && this.instructionHeard && performance.now() - this.stepEnteredAt > 1500) this.activateTask('briefed');
    if (s?.type === 'instruction' && (s.exploreSeconds ?? 0) > 0 && !this.state.exploreEndsAt && performance.now() - this.stepEnteredAt > 1500) this.startExplore();
    if (this.state.index >= this.steps.length && this.closingSpoken) {
      // Fallback if the model never calls end_session.
      setTimeout(() => {
        if (!this.finishing && this.state.index >= this.steps.length && !this.rt?.assistantAudioPlaying) void this.finish();
      }, 1500);
    }
  }

  private startExplore() {
    const s = this.step;
    if (s?.type !== 'instruction' || !s.exploreSeconds) return;
    const ends = Date.now() + s.exploreSeconds * 1000;
    this.set({ exploreEndsAt: ends });
    this.applyTurnDetection();
    this.exploreTimer = setTimeout(() => this.onExploreOver(), s.exploreSeconds * 1000);
  }

  private onExploreOver() {
    this.exploreDone = true;
    this.applyTurnDetection();
    if (this.state.mode === 'manual') {
      this.refreshManualPrompt();
      return;
    }
    // Wait until nobody is talking, then advance deterministically.
    const go = () => {
      if (this.disposed || this.step?.type !== 'instruction') return;
      if (this.rt?.userSpeaking || this.rt?.assistantAudioPlaying) return void setTimeout(go, 800);
      this.advance('[EVENT] The exploration time is over. Briefly thank the participant neutrally ("Thanks."), then continue with the next step below.', 'Thanks.');
    };
    go();
  }

  /** Runner-initiated advance to the next step (announces the brief). */
  private advance(prefix?: string, ack?: string) {
    this.enterStep(this.state.index + 1, 'announce', prefix, ack);
  }

  private activateTask(reason: 'briefed' | 'interaction' | 'timeout' | 'manual') {
    const s = this.step;
    if (s?.type !== 'task' || this.state.taskPhase !== 'briefing') return;
    if (this.taskActivateTimer) clearTimeout(this.taskActivateTimer);
    this.taskWallStart = Date.now();
    const deadline = s.timeLimitSec ? this.taskWallStart + s.timeLimitSec * 1000 : null;
    this.set({ taskPhase: 'active', taskStartedAt: this.taskWallStart, taskDeadline: deadline });
    this.lastUserSpeech = Math.max(this.lastUserSpeech, performance.now());
    this.queue.push('task.start', { startedAt: this.taskWallStart, timeLimitSec: s.timeLimitSec ?? null, startPath: s.startPath ?? null, trigger: reason });
    this.applyTurnDetection();
    this.refreshManualPrompt();
  }

  /** End the active task (rule / timeout / skip / AI judgement). */
  private endTask(outcome: TaskOutcome, source: 'rule' | 'ai' | 'participant', evidence?: string) {
    const s = this.step;
    if (s?.type !== 'task' || this.state.taskPhase === 'post') return;
    if (this.state.taskPhase === 'briefing') this.activateTask('interaction');
    const endedAt = Date.now();
    this.taskEndedAt = endedAt;
    this.taskOutcome = { outcome, source };
    this.queue.push('task.end', {
      outcome,
      source,
      startedAt: this.taskWallStart,
      endedAt,
      durationMs: endedAt - this.taskWallStart,
      ...(evidence ? { evidence } : {}),
    });
    this.followUpsUsed = 0;
    this.set({ taskPhase: 'post', appVisible: false, taskDeadline: null, pendingAction: null });
    this.doneRequested = false;
    this.applyTurnDetection();
    this.updateCard();
    this.refreshManualPrompt();
  }

  /**
   * The runner ended the task (rule, timeout, skip button). If the step still has something to
   * ask (post-task questions, or follow-ups when `allowProbes`), the moderator acknowledges and
   * asks it; otherwise the runner moves on to the next step itself (one acknowledgement + the next
   * step's text — no improvised filler, no redundant tool calls).
   */
  private announceTaskEnd(text: string, ack: string, allowProbes = true) {
    if (!this.rt) return;
    this.rt.cancelResponse();
    if (!this.nextQuestion() && !(allowProbes && this.postTaskProbesAvailable())) {
      this.queue.push('observation', { kind: 'step_summary', note: text.split('. ')[0] });
      this.advance(`[EVENT] ${text} This task is finished; move on to the next step below.`, ack);
      return;
    }
    const b = this.brief();
    this.rt.addSystemItem(`[EVENT] ${text}\n[STEP] ${JSON.stringify(b)}`);
    // The runner knows exactly what must be said next: direct it (no improvisation, no tools).
    if (b.say_verbatim) this.directed(`${this.ackPhrase(ack)} and then ask this question verbatim: "${b.say_verbatim}". Say nothing else.`);
    else this.rt.requestResponse();
  }

  /** Follow-up probes the post-task brief would offer (researcher probes or observed behaviour). */
  private postTaskProbesAvailable() {
    const s = this.step;
    if (s?.type !== 'task') return false;
    const mod = this.mod;
    if (mod.style === 'unmoderated' || mod.probingLevel === 'none' || this.remainingFollowUps() <= 0) return false;
    return (s.probes ?? []).some((p) => p.trim()) || this.observed.size > 0;
  }

  /** A response whose content the runner dictates (full rules + a NOW section, tools disabled). */
  private directed(now: string) {
    this.rt?.requestResponse(`${buildModeratorInstructions(this.protocol, this.steps)}\n\n# NOW\n${now}`, 'none');
  }

  private updateCard() {
    const s = this.step;
    let card: CardState | null = null;
    if (s) {
      if (s.type === 'questionnaire' && questionnaireOnScreen(s)) {
        card = { kind: 'questionnaire', stepId: s.id, title: s.title, questions: stepQuestions(s), submitted: this.questionnaireSubmitted };
      } else {
        const q = this.nextQuestion();
        const manual = this.state.mode === 'manual';
        const showOpen = manual || s.type === 'question';
        if (q && (questionHasCard(q) || showOpen) && s.type !== 'interview') card = { kind: 'question', stepId: s.id, questions: [q], activeQuestionId: q.id };
        else if (q && s.type === 'interview' && manual) card = { kind: 'question', stepId: s.id, questions: [q], activeQuestionId: q.id };
        else if (!q && this.state.card && this.state.card.stepId === s.id && this.state.card.kind === 'question') {
          // keep the last answered card visible until the step changes (shows the recorded answer)
          card = this.state.card;
        }
      }
    }
    this.set({ card });
  }

  private refreshManualPrompt() {
    if (this.state.mode !== 'manual') return;
    const b = this.brief();
    const s = this.step;
    let text = b.say_verbatim ?? '';
    if (!text && s?.type === 'questionnaire') text = 'Please answer the questions below and press Submit.';
    if (s?.type === 'task' && this.state.taskPhase === 'active') text = (s as TaskStep).instruction;
    if (s?.type === 'task' && this.state.taskPhase === 'post' && !this.nextQuestion()) text = 'Thanks. Press Continue when you are ready.';
    if (s?.type === 'instruction' && (s.exploreSeconds ?? 0) > 0 && !this.exploreDone) text = s.script;
    this.set({ manualPrompt: text || null });
  }

  // ── tool handling ──────────────────────────────────────────────────────────
  private async handleToolCall(call: FunctionCall): Promise<{ output: unknown; respond: boolean }> {
    let res: { output: Record<string, unknown>; respond: boolean };
    try {
      res = await this.runTool(call.name, call.args);
    } catch (e) {
      res = { output: { ok: false, error: (e as Error).message, hint: 'Call get_current_step.' }, respond: true };
    }
    const out = res.output as { ok?: boolean; error?: string };
    this.queue.push('moderator.tool', { name: call.name, args: call.args, ok: out.ok !== false, ...(out.error ? { error: out.error } : {}) });
    this.updateOrb();
    return res;
  }

  private err(error: string, hint?: string) {
    return { output: { ok: false, error, hint: hint ?? 'Follow the current brief.', current: this.brief() }, respond: true };
  }

  private async runTool(name: string, args: Record<string, unknown>): Promise<{ output: Record<string, unknown>; respond: boolean }> {
    if (this.state.ended || this.finishing) return { output: { ok: false, error: 'Session already ended.' }, respond: false };
    const s = this.step;
    switch (name) {
      case 'get_current_step':
        return { output: this.brief(), respond: true };

      case 'complete_step': {
        const idx = this.state.index;
        if (idx >= this.steps.length) return this.err('There is no next step.', 'Say the closing text verbatim if you have not yet, then call end_session.');
        if (idx < 0) {
          if (!this.heardSinceStep) return this.err('The participant has not replied yet.', 'Wait silently for the participant to reply to the intro.');
        } else if (s) {
          const block = this.completionBlocker(s);
          if (block) return this.err(block.error, block.hint);
        }
        if (s) this.queue.push('observation', { kind: 'step_summary', note: String(args.summary ?? '').slice(0, 1000) });
        const brief = this.enterStep(idx + 1, 'return');
        if (idx + 1 >= this.steps.length) {
          // Deterministic closing: the model must say exactly the closing text, nothing else, no tools.
          this.sayClosing();
          return { output: { ...brief, your_job: 'Say the closing text verbatim now. The session ends automatically afterwards; do not call any tool.' }, respond: false };
        }
        return { output: brief, respond: true };
      }

      case 'record_answer':
        return this.toolRecordAnswer(args);

      case 'set_task_outcome': {
        if (s?.type !== 'task') return this.err('The current step is not a task.');
        if (this.state.taskPhase === 'post') {
          // Redundant call (a rule, the time limit or a button already decided): ignored, outcome unchanged.
          return { output: { ...this.brief(), ignored: true, note: 'Ignored: the system already recorded the outcome of this task. Never call set_task_outcome after a task has ended. Continue with this brief.' }, respond: true };
        }
        const outcome = String(args.outcome);
        if (!['success', 'partial', 'failure'].includes(outcome)) return this.err('outcome must be success, partial or failure.');
        const evidence = String(args.evidence ?? '').slice(0, 1000);
        // Deterministic rules override the AI judgement.
        const ruleHit = await this.checkRulesNow(s);
        if (ruleHit) this.endTask('success', 'rule', `Rule matched: ${ruleHit}. AI judgement: ${outcome} — ${evidence}`);
        else this.endTask(outcome as TaskOutcome, 'ai', evidence);
        return { output: { ...this.brief(), note: 'Outcome recorded. Never tell the participant the outcome.' }, respond: true };
      }

      case 'log_observation': {
        const note = String(args.note ?? '').slice(0, 1000);
        if (!note) return this.err('note is required.');
        const severity = ['info', 'minor', 'major', 'critical'].includes(String(args.severity)) ? String(args.severity) : 'info';
        this.queue.push('observation', { note, severity, source: 'ai' });
        // Silent: no new response needed (avoid talking during tasks).
        return { output: { ok: true }, respond: !this.quiet };
      }

      case 'participant_requests_skip': {
        const reason = String(args.reason ?? '').slice(0, 500);
        if (s?.type === 'task' && this.state.taskPhase !== 'post') {
          this.endTask('abandoned', 'participant', reason ? `Participant asked to skip: ${reason}` : 'Participant asked to skip');
          return { output: { ...this.brief(), note: 'Task skipped. Continue with this brief.' }, respond: true };
        }
        if (s?.type === 'task' && this.taskOutcome?.source === 'participant' && Date.now() - this.taskEndedAt < 15_000 && !(this.queueAnswered() > 0)) {
          // Reaction to the "Skip task" button: the task is already skipped — never skip the post-task question too.
          return { output: { ...this.brief(), ignored: true, note: 'The task was already skipped by the participant. Continue with this brief.' }, respond: true };
        }
        const q = this.nextQuestion();
        if (q) {
          this.skipped.add(q.id);
          this.queue.push('observation', { kind: 'question_skipped', questionId: q.id, reason });
          this.updateCard();
          return { output: { ...this.brief(), note: 'Question skipped.' }, respond: true };
        }
        if (s?.type === 'task') return { output: { ...this.brief(), ignored: true, note: 'Nothing to skip: the task has already ended. Continue with this brief.' }, respond: true };
        return this.err('There is nothing to skip right now.');
      }

      case 'end_session': {
        if (this.state.index >= this.steps.length && !this.closingSpoken) {
          return { output: { ok: true, note: 'The session ends automatically once you have said the closing text verbatim.' }, respond: false };
        }
        if (this.state.index < this.steps.length) return this.err('The session is not finished yet.', 'Continue with the current brief.');
        if (!this.closingSpoken) return this.err('The closing text has not been said yet.', `Say this verbatim now: "${this.protocol.closing}" — then call end_session.`);
        const waitAudio = async () => {
          for (let i = 0; i < 40 && this.rt?.assistantAudioPlaying; i++) await new Promise((r) => setTimeout(r, 250));
          await this.finish();
        };
        void waitAudio();
        return { output: { ok: true }, respond: false };
      }
    }
    return this.err(`Unknown tool ${name}.`);
  }

  /** Why the current step cannot be completed yet (null = can complete). */
  private completionBlocker(s: Step): { error: string; hint: string } | null {
    switch (s.type) {
      case 'instruction': {
        if ((s.exploreSeconds ?? 0) > 0 && !this.exploreDone) {
          const left = this.state.exploreEndsAt ? Math.round((this.state.exploreEndsAt - Date.now()) / 1000) : s.exploreSeconds!;
          if (left > 3) return { error: `Exploration time is not over (${left}s left).`, hint: 'Stay quiet and let the participant explore. The system will tell you when the time is over.' };
        }
        if (s.script.includes('?') && !this.heardSinceStep) return { error: 'The participant has not replied yet.', hint: 'Wait silently for their reply.' };
        return null;
      }
      case 'task': {
        if (this.state.taskPhase !== 'post')
          return { error: 'The task is still in progress.', hint: 'Stay quiet. If the participant said they are done, ask how they feel it went and call set_task_outcome; if they want to give up, call participant_requests_skip.' };
        const q = this.nextQuestion();
        if (q && q.required) return { error: `Required post-task question "${q.id}" is not answered yet.`, hint: `Ask it verbatim: "${q.prompt}" and call record_answer.` };
        return null;
      }
      case 'questionnaire': {
        if (questionnaireOnScreen(s) && !this.questionnaireSubmitted) return { error: 'The participant has not submitted the questionnaire yet.', hint: 'Stay quiet and wait for the [EVENT] that it was submitted.' };
        const q = this.nextQuestion();
        if (!questionnaireOnScreen(s) && q) return { error: `Item "${q.id}" is not answered yet.`, hint: `Read it verbatim: "${q.prompt}"` };
        return null;
      }
      default: {
        const q = this.nextQuestion();
        if (q && (q.required || s.type === 'interview'))
          return { error: `Question "${q.id}" has not been ${s.type === 'interview' ? 'asked/recorded' : 'answered'} yet.`, hint: `Ask it verbatim: "${q.prompt}" and call record_answer (or participant_requests_skip if they decline).` };
        return null;
      }
    }
  }

  private toolRecordAnswer(args: Record<string, unknown>) {
    const s = this.step;
    if (!s) return this.err('There is no question right now.');
    const qid = String(args.question_id ?? '');
    const queue = this.questionQueue();
    const q = queue.find((x) => x.id === qid);
    if (!q) {
      const next = this.nextQuestion();
      return this.err(`Unknown question_id "${qid}" for the current step.`, next ? `The current question_id is "${next.id}".` : 'This step has no open question. Follow the brief.');
    }
    const onScreenForm = s.type === 'questionnaire' && questionnaireOnScreen(s);
    if (onScreenForm && this.questionnaireSubmitted) return this.err('The questionnaire was already submitted.', 'Follow the current brief.');
    const prevAns = this.state.answers[akey(s.id, q.id)];
    // Follow-up enrichment: keep the earlier value/choices when only text is added.
    const parsed = this.validateAnswer(q, { text: args.text, value: args.value ?? prevAns?.value, choices: args.choices ?? prevAns?.choices });
    if ('error' in parsed) return this.err(parsed.error, `Expected: ${describeScale(q) ?? 'free text'}`);
    const prev = this.state.answers[akey(s.id, q.id)];
    // A follow-up enrichment keeps the earlier numeric value unless a new one is given.
    const merged: AnswerValue = {
      ...(prev ?? {}),
      ...parsed,
      text: parsed.text && prev?.text && !parsed.text.includes(prev.text) && args.value == null ? `${prev.text} — ${parsed.text}` : parsed.text ?? prev?.text,
      source: prev?.source === 'screen' && parsed.value == null && !parsed.choices ? 'screen' : this.state.mode === 'text' ? 'text' : 'voice',
    };
    this.storeAnswer(s.id, q, merged);
    // On-screen questionnaire answered aloud: the card shows it; stay quiet while they fill in the rest.
    if (onScreenForm) return { output: { ok: true, recorded: q.id, note: 'Recorded and shown on screen. Say nothing; let them continue.' }, respond: false };
    return { output: { ...this.brief(), recorded: q.id, acknowledge: 'Begin your next turn with a brief neutral acknowledgement ("Thanks." / "Got it."), then continue. Never narrate what you are doing.' }, respond: true };
  }

  private validateAnswer(q: Question, a: { text?: unknown; value?: unknown; choices?: unknown }): Omit<AnswerValue, 'source'> | { error: string } {
    const text = typeof a.text === 'string' && a.text.trim() ? a.text.trim().slice(0, 4000) : undefined;
    let value = typeof a.value === 'number' && isFinite(a.value) ? a.value : typeof a.value === 'string' && a.value.trim() !== '' && isFinite(Number(a.value)) ? Number(a.value) : undefined;
    let choices = Array.isArray(a.choices) ? a.choices.map(String) : undefined;
    switch (q.kind) {
      case 'rating': {
        const sc = q.scale ?? { min: 1, max: 5 };
        if (value == null) return { error: 'A numeric value from the scale is required.' };
        if (value < sc.min || value > sc.max) return { error: `Value must be between ${sc.min} and ${sc.max}.` };
        const st = sc.step ?? 1;
        value = Math.round((value - sc.min) / st) * st + sc.min;
        return { value, text };
      }
      case 'number':
        if (value == null) return { error: 'A number is required.' };
        return { value, text };
      case 'yes_no': {
        if (value == null && choices?.length) value = /^y|^ja|^oui|^s[ií]|^evet/i.test(choices[0]) ? 1 : 0;
        if (value == null && text) value = /^(yes|yeah|yep|ja|oui|sí|si|evet)\b/i.test(text) ? 1 : /^(no|nope|nein|non|hayır)\b/i.test(text) ? 0 : undefined;
        if (value !== 0 && value !== 1) return { error: 'value must be 1 (yes) or 0 (no).' };
        return { value, choices: [value ? 'Yes' : 'No'], text };
      }
      case 'single_choice':
      case 'multi_choice': {
        const opts = q.options ?? [];
        if (!choices?.length && value != null && opts[value]) choices = [opts[value]];
        if (!choices?.length) return { error: `choices is required. Options: ${opts.join(' | ')}` };
        const mapped = choices.map((c) => opts.find((o) => o.toLowerCase().trim() === c.toLowerCase().trim()) ?? opts.find((o) => o.toLowerCase().includes(c.toLowerCase().trim())));
        if (mapped.some((m) => !m)) return { error: `Choices must be exact option labels: ${opts.join(' | ')}` };
        if (q.kind === 'single_choice' && mapped.length > 1) return { error: 'Only one choice allowed.' };
        return { choices: mapped as string[], value: opts.indexOf(mapped[0]!), text };
      }
      default:
        if (!text) return { error: 'text is required for open questions (the participant’s answer in their own words).' };
        return { text };
    }
  }

  private storeAnswer(stepId: string, q: Question, a: AnswerValue) {
    const answers = { ...this.state.answers, [akey(stepId, q.id)]: a };
    this.set({ answers });
    this.queue.push('answer', {
      stepId,
      questionId: q.id,
      ...(a.text != null ? { text: a.text } : {}),
      ...(a.value != null ? { value: a.value } : {}),
      ...(a.choices ? { choices: a.choices } : {}),
      source: a.source,
      at: Date.now(),
    });
    this.updateCard();
  }

  // ── participant actions (UI) ───────────────────────────────────────────────
  answerFromScreen(stepId: string, q: Question, a: Omit<AnswerValue, 'source'>) {
    const s = this.step;
    if (!s || s.id !== stepId) return;
    const prev = this.state.answers[akey(stepId, q.id)];
    const wasCurrent = this.nextQuestion()?.id === q.id;
    this.storeAnswer(stepId, q, { ...prev, ...a, source: 'screen' });
    if (s.type === 'questionnaire' && questionnaireOnScreen(s)) return; // reported on submit
    if (this.state.mode === 'manual') {
      this.refreshManualPrompt();
      return;
    }
    if (!this.rt) return;
    const label = a.choices?.join(', ') ?? (a.value != null ? String(a.value) : a.text ?? '');
    const scale = describeScale(q);
    if (wasCurrent && !prev) {
      this.rt.addSystemItem(
        `[EVENT] The participant answered on screen: question_id "${q.id}" ("${q.prompt}") → ${label}${scale ? ` (${scale})` : ''}. It is recorded — do not call record_answer for it and do not ask it again. Start with a brief neutral acknowledgement ("Thanks.") and go straight on with the brief below. Never comment on the rating and never narrate (no "I have what I need", "noted", "let me note that").\n[STEP] ${JSON.stringify(this.brief())}`,
      );
      this.rt.requestResponse();
    } else {
      this.rt.addSystemItem(`[EVENT] The participant changed their on-screen answer for "${q.id}" to ${label}. Already recorded; no need to respond.`);
    }
  }

  submitQuestionnaire() {
    const s = this.step;
    if (s?.type !== 'questionnaire' || this.questionnaireSubmitted) return;
    const missing = stepQuestions(s).filter((q) => q.required && !this.state.answers[akey(s.id, q.id)]);
    if (missing.length) return;
    this.questionnaireSubmitted = true;
    this.queue.push('observation', { kind: 'questionnaire_submitted', instrument: s.instrument });
    this.applyTurnDetection();
    if (this.state.mode === 'manual') return void this.enterStep(this.state.index + 1, 'announce');
    this.advance('[EVENT] The participant submitted the questionnaire (answers recorded). Say "Thanks." and continue with the next step below.', 'Thanks.');
  }

  /** "I'm done" button during a task. */
  imDone() {
    const s = this.step;
    if (s?.type !== 'task' || this.state.taskPhase === 'post') return;
    if (this.state.taskPhase === 'briefing') this.activateTask('interaction');
    this.queue.push('observation', { kind: 'participant_done_button' });
    if (this.state.mode === 'manual' || !this.rt) {
      void this.checkRulesNow(s).then((hit) => {
        if (hit) this.endTask('success', 'rule', `Rule matched: ${hit}`);
        else this.endTask(s.successRules?.length ? 'failure' : 'partial', 'participant', 'Participant pressed "I\'m done"; no automatic success rule matched.');
      });
      return;
    }
    this.doneRequested = true;
    this.applyTurnDetection();
    this.set({ pendingAction: 'done' });
    this.rt.addSystemItem(
      '[EVENT] The participant pressed the "I\'m done" button for this task. Ask once, neutrally, how they feel it went (e.g. "How do you feel that went?"). After their answer, call set_task_outcome with your honest judgement against the hidden success criteria. Do not reveal whether they succeeded.',
    );
    this.rt.cancelResponse();
    this.rt.requestResponse();
  }

  /** "Skip task" button. */
  skipTask() {
    const s = this.step;
    if (s?.type !== 'task' || this.state.taskPhase === 'post') return;
    this.endTask('abandoned', 'participant', 'Participant pressed "Skip task".');
    if (this.state.mode !== 'manual') this.announceTaskEnd('The participant pressed "Skip task". Say neutrally that this is completely fine (e.g. "No problem, let\'s move on."). Never imply they failed.', "No problem, let's move on.", false);
  }

  /** Typed message (text fallback). */
  sendText(text: string) {
    const t = text.trim();
    if (!t) return;
    this.heardSinceStep = true;
    const id = `txt${++this.captionSeq}`;
    this.caption('participant', id, t, true, false);
    this.transcriptLog.push({ role: 'participant', text: t });
    this.queue.push('transcript.participant', { text: t, itemId: id, source: 'text' });
    if (this.state.mode === 'manual') {
      const q = this.nextQuestion();
      if (q && q.kind === 'open' && this.step) this.storeAnswer(this.step.id, q, { text: t, source: 'text' });
      return;
    }
    if (!this.rt) return;
    this.rt.addUserText(t);
    this.rt.requestResponse();
  }

  toggleMute() {
    const muted = !this.state.muted;
    this.opts.mic?.getAudioTracks().forEach((tr) => (tr.enabled = !muted));
    this.set({ muted });
    this.queue.push('observation', { kind: muted ? 'mic_muted' : 'mic_unmuted' });
    this.updateOrb();
  }

  /** Manual (no-AI) mode: Continue button. */
  manualContinue() {
    if (this.state.mode !== 'manual') return;
    const idx = this.state.index;
    if (idx >= this.steps.length) return void this.finish();
    const s = this.step;
    if (s?.type === 'task' && this.state.taskPhase !== 'post') return;
    if (s) {
      const block = this.completionBlocker(s);
      if (block && !(s.type === 'instruction' && block.error.includes('replied'))) {
        this.set({ manualError: s.type === 'instruction' ? 'Please take a moment to look around first.' : 'Please answer the question first.' });
        return;
      }
    }
    this.enterStep(idx + 1, 'announce');
  }

  /** Manual mode: skip current (optional) question. */
  manualSkipQuestion() {
    const q = this.nextQuestion();
    if (!q || !this.step) return;
    this.skipped.add(q.id);
    this.updateCard();
    this.refreshManualPrompt();
  }

  // ── app / probe ────────────────────────────────────────────────────────────
  attachIframe(el: HTMLIFrameElement | null) {
    if (el === this.iframe) return;
    this.iframe = el;
    this.bridge.attach(el);
    if (el && this.opts.start.appInstrumented) this.armHelloTimer();
  }

  private armHelloTimer() {
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = setTimeout(() => {
      if (!this.bridge.connected && this.state.appStatus === 'loading') {
        this.set({ appStatus: 'limited' });
        this.queue.push('observation', { kind: 'probe_missing', note: 'No probe hello within 12s; behaviour features limited.' });
      }
    }, 12_000);
  }

  appUrlFor(path?: string) {
    const base = this.opts.start.appUrl;
    if (!base) return null;
    if (!path) return base;
    try {
      return new URL(this.withVariantParams(path), base).toString();
    } catch {
      return base;
    }
  }

  /** Keep the variant's launch params (e.g. ?flags=…) on every in-app navigation we initiate. */
  private withVariantParams(path: string) {
    const base = this.opts.start.appUrl;
    if (!base) return path;
    try {
      const params = new URL(base).searchParams;
      if (![...params.keys()].length) return path;
      const u = new URL(path, 'http://x');
      for (const [k, v] of params) if (!u.searchParams.has(k)) u.searchParams.set(k, v);
      return u.pathname + u.search + u.hash;
    } catch {
      return path;
    }
  }

  private navigateApp(path?: string) {
    const target = path || '/';
    this.ignoreNavUntil = Date.now() + 2000;
    if (this.bridge.connected) this.bridge.navigate(this.withVariantParams(target));
    else if (this.iframe && path) {
      this.iframe.src = this.appUrlFor(path) ?? this.iframe.src;
      if (this.opts.start.appInstrumented) this.armHelloTimer();
    }
  }

  reloadApp() {
    const s = this.step;
    const url = this.appUrlFor(this.bridge.lastPath || (s?.type === 'task' ? s.startPath : undefined));
    this.crashReported = false;
    this.recentErrors = [];
    this.bridge.connected = false;
    this.queue.push('observation', { kind: 'app_reload' });
    if (!url) return;
    // A frozen app keeps its renderer process busy forever, and a same-site document loaded into
    // the same frame would land in that hung process. Unmount the iframe, give the browser a
    // moment to drop the process, then mount a fresh one.
    const key = this.state.appFrame.key + 1;
    this.set({ appStatus: this.opts.start.appInstrumented ? 'loading' : 'limited', appFrame: { key, src: null } });
    setTimeout(() => {
      if (this.disposed || this.state.appFrame.key !== key) return;
      this.set({ appFrame: { key, src: url } });
      if (this.opts.start.appInstrumented) this.armHelloTimer();
    }, 700);
  }

  private onProbeHello(path: string) {
    if (this.helloTimer) clearTimeout(this.helloTimer);
    if (this.crashAt) {
      // Recovered from a crash: the downtime does not count against the task time limit.
      const down = Date.now() - this.crashAt;
      this.crashAt = 0;
      this.crashNoticePending = false;
      if (this.state.taskDeadline && this.state.taskPhase === 'active') this.set({ taskDeadline: this.state.taskDeadline + down });
      this.rt?.addSystemItem('[APP] The website was reloaded and is working again. Do not comment on it; let the participant continue.');
    }
    if (this.state.appStatus !== 'ready') this.set({ appStatus: 'ready' });
    if (this.crashReported) this.crashReported = false;
    this.queue.push('app.ready', { path });
    this.onProbePath(path, true);
  }

  private onProbePath(path: string, isNav: boolean) {
    if (!path || !isNav) return;
    this.evaluateUrlRules(path);
  }

  private onProbeEvents(evs: ProbeEvent[]) {
    for (const e of evs) {
      if (!e || typeof e.kind !== 'string') continue;
      const data = (e.data ?? {}) as Record<string, unknown>;
      if (e.kind === 'mouse' || e.kind === 'gaze') {
        if (e.kind === 'mouse') this.queue.push('mouse', this.normalizePoints(data as unknown as PointBatchData) as unknown as Record<string, unknown>, { at: e.at });
        continue;
      }
      if (e.kind !== 'app.crash') this.queue.push(e.kind, data, { at: e.at }); // reportCrash logs crashes (once)
      this.onBehaviour(e.kind, data);
    }
  }

  private normalizePoints(d: PointBatchData): PointBatchData {
    const pts = (d.points ?? []).map(([t, x, y]) => [t > 1e11 ? this.queue.fromWall(t) : t, x, y] as [number, number, number]);
    return { ...d, points: pts };
  }

  private onBehaviour(kind: string, data: Record<string, unknown>) {
    const now = Date.now();
    const appActive = this.state.appVisible;
    if (['app.click', 'app.input', 'app.change', 'app.scroll', 'app.navigate', 'app.dead_click', 'app.rage_click'].includes(kind)) this.lastAppAction = performance.now();
    const s = this.step;
    const inTask = s?.type === 'task' && this.state.taskPhase !== 'post';
    if (inTask && this.state.taskPhase === 'briefing' && (kind === 'app.click' || kind === 'app.input')) this.activateTask('interaction');

    switch (kind) {
      case 'app.navigate': {
        const path = String(data.path ?? '');
        if (appActive) this.feed(`navigated to ${path}${data.title ? ` ("${String(data.title).slice(0, 60)}")` : ''}`);
        this.recentNavs.push({ path, at: now });
        this.recentNavs = this.recentNavs.filter((n) => now - n.at < 30_000).slice(-8);
        this.evaluateUrlRules(path);
        // Back-and-forth: A → B → A → B within 30s, or 2+ "pop" navigations within 20s.
        const p = this.recentNavs.map((n) => n.path);
        const n = p.length;
        if (inTask && n >= 4 && p[n - 1] === p[n - 3] && p[n - 2] === p[n - 4] && p[n - 1] !== p[n - 2]) this.queueProbe('backtrack', `went back and forth between the pages ${p[n - 2]} and ${p[n - 1]}`);
        if (inTask && data.kind === 'pop') {
          this.recentPops = [...this.recentPops.filter((t) => now - t < 20_000), now];
          if (this.recentPops.length >= 2) this.queueProbe('back', 'went back to previous pages several times');
        }
        break;
      }
      case 'app.click': {
        const el = data.el as ElementDescriptor | undefined;
        this.lastClickDesc = describeElement(el);
        if (appActive) this.feed(`clicked ${describeElement(el)} on ${String(data.path ?? this.bridge.lastPath)}`);
        if (el && inTask) this.evaluateClickRules(el);
        break;
      }
      case 'app.dead_click': {
        const el = data.el as ElementDescriptor | undefined;
        if (appActive) this.feed(`clicked non-interactive ${describeElement(el)} (nothing happened)`);
        this.recentDead = [...this.recentDead.filter((t) => now - t < 10_000), now];
        if (inTask && this.recentDead.length >= 3) {
          this.recentDead = [];
          this.queueProbe('dead', `clicked ${describeElement(el)} several times and nothing happened on screen`);
        }
        break;
      }
      case 'app.rage_click': {
        const el = data.el as ElementDescriptor | undefined;
        if (appActive) this.feed(`rage-clicked ${describeElement(el)}`);
        if (inTask) this.queueProbe('rage', `clicked ${describeElement(el)} many times in quick succession`);
        break;
      }
      case 'app.error':
      case 'app.console_error':
      case 'app.network_error': {
        if (appActive) this.feed(`${kind.replace('app.', '').replace('_', ' ')}: ${String(data.message ?? '').slice(0, 100)}`);
        if (kind === 'app.error') {
          this.recentErrors = [...this.recentErrors.filter((t) => now - t < 5000), now];
          if (this.recentErrors.length >= 5) this.reportCrash('error storm');
          else if (inTask)
            this.queueProbe(
              'error',
              `clicked ${this.lastClickDesc || 'something'} and the app had a technical error at that moment (the participant may not have noticed it — ask what they expected to happen there, never mention the error)`,
            );
        }
        break;
      }
      case 'app.crash':
        this.reportCrash(String(data.reason ?? 'crash'));
        break;
      case 'app.custom': {
        const name = String(data.name ?? '');
        if (appActive) this.feed(`app event "${name}"`);
        if (inTask && s?.type === 'task') {
          const r = (s.successRules ?? []).find((x) => x.type === 'custom_event' && x.name === name);
          if (r) this.ruleSuccess(`custom event "${name}"`);
        }
        break;
      }
      case 'app.input':
      case 'app.change':
        if (appActive) this.feed(`typed in ${describeElement(data.el as ElementDescriptor | undefined)}`);
        break;
    }
  }

  // ── success rules ──────────────────────────────────────────────────────────
  private taskRules(): SuccessRule[] {
    const s = this.step;
    if (s?.type !== 'task' || this.state.taskPhase === 'post') return [];
    return s.successRules ?? [];
  }

  private evaluateUrlRules(path: string) {
    const rules = this.taskRules();
    if (!rules.length || Date.now() < this.ignoreNavUntil) return;
    const hit = rules.find((r) => r.type === 'url_matches' && urlMatches(r.pattern, path));
    if (hit) this.ruleSuccess(`URL ${path} matches /${(hit as { pattern: string }).pattern}/`);
  }

  private evaluateClickRules(el: ElementDescriptor) {
    const hit = this.taskRules().find((r) => r.type === 'click_matches' && clickRuleMatches(r, el));
    if (hit) this.ruleSuccess(`clicked ${describeElement(el)}`);
  }

  private async pollDomRules() {
    const s = this.step;
    if (this.domPollBusy || s?.type !== 'task' || this.state.taskPhase !== 'active' || !this.bridge.connected) return;
    const rules = this.taskRules().filter((r) => r.type === 'element_visible' || r.type === 'text_visible');
    if (!rules.length) return;
    this.domPollBusy = true;
    try {
      for (const r of rules) {
        const m = await this.bridge.query(r.type === 'element_visible' ? { selector: r.selector } : { text: (r as { text: string }).text });
        if (m && this.step === s && this.state.taskPhase === 'active') {
          this.ruleSuccess(r.type === 'element_visible' ? `element ${r.selector} visible` : `text "${(r as { text: string }).text}" visible`);
          break;
        }
      }
    } finally {
      this.domPollBusy = false;
    }
  }

  /** Final synchronous-ish rule check (used before accepting an AI/participant outcome). */
  private async checkRulesNow(s: TaskStep): Promise<string | null> {
    const rules = s.successRules ?? [];
    for (const r of rules) {
      if (r.type === 'url_matches' && this.bridge.lastPath && urlMatches(r.pattern, this.bridge.lastPath)) return `URL ${this.bridge.lastPath}`;
      if ((r.type === 'element_visible' || r.type === 'text_visible') && this.bridge.connected) {
        const m = await this.bridge.query(r.type === 'element_visible' ? { selector: r.selector } : { text: r.text }, 800);
        if (m) return r.type === 'element_visible' ? `element ${r.selector}` : `text "${r.text}"`;
      }
    }
    return null;
  }

  private ruleSuccess(evidence: string) {
    if (this.state.taskPhase === 'post') return;
    this.endTask('success', 'rule', evidence);
    this.announceTaskEnd(
      'The participant reached the end state of this task (detected automatically). Say only a brief neutral acknowledgement such as "Thanks, let\'s stop this task there." — no praise, and never say or imply that they succeeded or did it correctly. Then continue with this brief.',
      "Thanks, let's stop this task there.",
    );
  }

  // ── triggers: silence nudges, behaviour probes, crash, timeouts ────────────
  private tick() {
    if (this.disposed || this.state.ended) return;
    const s = this.step;
    const now = Date.now();
    // Gaze is only recorded over the app: don't run face tracking while it is hidden.
    this.opts.eye?.setSuspended(!this.state.appVisible);
    // Time limit
    // (Let the participant finish their sentence first — up to 8 s past the limit.)
    if (s?.type === 'task' && this.state.taskPhase === 'active' && this.state.taskDeadline && now >= this.state.taskDeadline && this.state.appStatus !== 'crashed' && (!this.rt?.userSpeaking || now - this.state.taskDeadline > 8000)) {
      this.endTask('timeout', 'rule', `Time limit of ${s.timeLimitSec}s reached.`);
      this.announceTaskEnd('The time limit for this task was reached. Say neutrally that we will stop this task there and move on (e.g. "Let\'s stop this one here."). No judgement, never imply failure.', "Let's stop this one here.");
      return;
    }
    // Crash detection: heartbeat gap while visible.
    if (this.state.appVisible && this.bridge.connected && this.state.appStatus === 'ready' && document.visibilityState === 'visible' && now - this.bridge.lastHeartbeat > 4000) {
      this.reportCrash('heartbeat lost');
    }
    this.maybeAnnounceCrash();
    this.maybeNudge();
  }

  private someoneTalking() {
    const rt = this.rt;
    if (!rt) return true;
    return rt.userSpeaking || rt.assistantAudioPlaying || rt.responding;
  }

  private maybeNudge() {
    const s = this.step;
    const rt = this.rt;
    if (!rt || this.state.mode === 'manual' || s?.type !== 'task' || this.state.taskPhase !== 'active' || this.doneRequested) return;
    const mod = this.mod;
    if (!mod.silencePromptSeconds || mod.style === 'think_aloud_retrospective' || mod.style === 'unmoderated') return;
    if (this.state.muted || this.someoneTalking() || this.state.appStatus === 'crashed') return;
    if (this.nudgesThisTask >= 6) return;
    const nowP = performance.now();
    const threshold = mod.silencePromptSeconds * 1000 * (1 + this.nudgesThisTask * 0.5);
    const lastSound = Math.max(this.lastUserSpeech, this.lastAssistantAudio, this.lastTrigger, this.stepEnteredAt);
    if (nowP - lastSound < threshold) return;
    if (nowP - this.lastAppAction < 2500) return; // never prompt mid-action
    this.nudgesThisTask++;
    this.lastTrigger = nowP;
    const silentSec = Math.round((nowP - lastSound) / 1000);
    this.queue.push('moderator.nudge', { silentSec, n: this.nudgesThisTask });
    rt.addSystemItem(
      `[TRIGGER] The participant has been silent for about ${silentSec} seconds while working on the task. Give ONE very short, neutral think-aloud nudge, e.g. "What are you thinking right now?" or "Remember to keep talking." Vary the wording. Do not mention the task content, do not hint, do not ask about progress.`,
    );
    rt.requestResponse();
  }

  /**
   * Remember notable behaviour (rage/dead clicks, backtracking, errors). Probes about it are asked
   * AFTER the task (never mid-task: that would distort time-on-task and interrupt the participant),
   * within the step's follow-up budget (probingLevel / maxProbesPerStep).
   */
  private queueProbe(kind: string, reason: string) {
    const mod = this.mod;
    if (!mod.probeOnBehavior || mod.style === 'unmoderated' || mod.probingLevel === 'none') return;
    if (this.observed.has(kind)) return;
    this.observed.set(kind, reason);
    this.queue.push('observation', { kind: 'behaviour', behaviour: kind, note: reason, source: 'system' });
  }

  private reportCrash(reason: string) {
    if (this.crashReported) return;
    this.crashReported = true;
    this.crashAt = Date.now();
    this.set({ appStatus: 'crashed' });
    this.queue.push('app.crash', { reason, path: this.bridge.lastPath });
    this.crashNoticePending = Boolean(this.rt && this.state.appVisible);
    this.maybeAnnounceCrash();
  }

  /** Tell the moderator about a crash — but never while the participant is mid-sentence. */
  private maybeAnnounceCrash() {
    const rt = this.rt;
    if (!this.crashNoticePending || !rt) return;
    if (this.state.appStatus !== 'crashed' || !this.state.appVisible) {
      this.crashNoticePending = false;
      return;
    }
    if (rt.userSpeaking) return;
    this.crashNoticePending = false;
    this.lastTrigger = performance.now();
    rt.addSystemItem(
      '[EVENT] The website being tested stopped responding (a technical problem, not caused by the participant). In ONE or two short sentences, gently tell the participant that this is not their fault and that they can press the "Reload website" button on the screen. Do not speculate about the cause and do not discuss it further. The task is still running.',
    );
    rt.requestResponse();
  }

  // ── app context feed (no response) ─────────────────────────────────────────
  private feed(line: string) {
    if (this.state.mode === 'manual') return;
    this.appFeed.push(line);
    if (this.appFeed.length > 12) this.appFeed.splice(0, this.appFeed.length - 12);
  }

  private flushAppFeed() {
    if (!this.rt || !this.appFeed.length) return;
    // Collapse repeats.
    const lines: string[] = [];
    for (const l of this.appFeed) {
      const last = lines[lines.length - 1];
      if (last && last.replace(/ \(×\d+\)$/, '') === l) {
        const m = / \(×(\d+)\)$/.exec(last);
        lines[lines.length - 1] = `${l} (×${m ? Number(m[1]) + 1 : 2})`;
      } else lines.push(l);
    }
    this.appFeed = [];
    this.rt.addSystemItem(`[APP] ${lines.join('; ').slice(0, 500)}`);
  }

  // ── gaze ───────────────────────────────────────────────────────────────────
  private onGaze(x: number, y: number) {
    if (!this.state.appVisible || !this.iframe) return;
    const r = this.iframe.getBoundingClientRect();
    const ix = x - r.left;
    const iy = y - r.top;
    if (ix < 0 || iy < 0 || ix > r.width || iy > r.height) return;
    this.gazeBuf.push([this.queue.now(), Math.round(ix), Math.round(iy)]);
  }

  private flushGaze() {
    if (!this.gazeBuf.length || !this.iframe) return;
    const r = this.iframe.getBoundingClientRect();
    const sc = this.bridge.scroll;
    const data: PointBatchData = {
      points: this.gazeBuf.splice(0),
      vw: Math.round(r.width),
      vh: Math.round(r.height),
      path: this.bridge.lastPath,
      ...(sc ? { scrollX: sc.scrollX, scrollY: sc.scrollY } : {}),
    };
    this.queue.push('gaze', data as unknown as Record<string, unknown>);
  }

  // ── finish / withdraw ──────────────────────────────────────────────────────
  async finish() {
    if (this.finishing) return;
    this.finishing = true;
    if (this.step) this.queue.push('step.exit', { index: this.state.index, type: this.step.type }, { stepId: this.step.id });
    this.queue.push('session.end', { status: 'completed' });
    this.set({ ended: true, pendingAction: null });
    this.teardownMedia();
    await this.recorder?.stop().catch(() => {});
    await this.rrweb.flush().catch(() => {});
    await this.queue.drain().catch(() => {});
    const res = await pApi.complete(this.opts.auth, 'completed').catch(() => ({ ok: false, redirectUrl: this.opts.start.redirectUrl }));
    this.dispose();
    this.opts.onFinished(res.redirectUrl ?? this.opts.start.redirectUrl);
  }

  async withdraw() {
    this.finishing = true;
    this.recorder?.abort();
    this.queue.discard();
    this.teardownMedia();
    this.set({ ended: true });
    this.dispose();
    await pApi.withdraw(this.opts.auth);
  }

  private teardownMedia() {
    this.rt?.close();
    this.rt = null;
    this.opts.eye?.stop();
    this.micMeter?.dispose();
    this.remoteMeter?.dispose();
    this.bridge.pause();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clearStepTimers();
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.timers.forEach(clearInterval);
    this.rt?.close();
    this.bridge.dispose();
    this.rrweb.dispose();
    void this.queue.flush().finally(() => this.queue.dispose());
    this.opts.mic?.getTracks().forEach((t) => t.stop());
  }

  /** Debug/test hook. */
  debug() {
    return { brief: this.brief(), quiet: this.quiet, rt: this.rt?.status, events: this.queue.log.length };
  }
}
