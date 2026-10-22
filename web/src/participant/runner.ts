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
  isLikelyNoise,
  languageName,
  meanLogprob,
  parseRecordAnswer,
  quietNeededMs,
  turnDecision,
  wrapUpDecision,
  ANSWER_SILENCE_AFTER_REPROMPT_MS,
  ANSWER_SILENCE_MS,
  WRAP_SILENCE_MS,
  MODERATOR_TOOLS,
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
import { CaptionPacer } from './captionPacer.ts';
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
/** Quiet-phase classification of a participant utterance. */
export type TurnLabel = 'DONE' | 'DELIVERED' | 'SKIP' | 'STUCK' | 'ADDRESSED' | 'NO';

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
  /** "I don't know" / "not sure" / skipped on screen. */
  declined?: boolean;
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

/** Silence nudges per task step (with backoff), then quiet. */
const MAX_NUDGES = 3;
/** App interaction this recent means the participant is working: no nudge, silence clock restarts. */
const INTERACTION_GRACE_MS = 10_000;
/** After the nudge cap: one "keep going or move on?" check-in after this much silence + inactivity. */
const CHECK_IN_SILENCE_MS = 90_000;
const akey = (stepId: string, qid: string) => `${stepId}::${qid}`;

/**
 * The "I'm done" wrap-up window. Opened by the Done button, by a verbal "I'm done", when the
 * participant has delivered what a tell/explain task asked for, or when the model calls
 * set_task_outcome on its own. The outcome is only recorded once the participant has finished
 * talking (held tool output), so their answer is never cut off by "Thanks".
 */
interface WrapUp {
  source: 'button' | 'verbal' | 'delivered' | 'model';
  phase: 'asking' | 'listening' | 'judging';
  openedAt: number;
  /** When the listening window started (the question finished). */
  listenFrom: number;
  questionHeard: boolean;
  /** The "how did it go" question was requested (deferred while the participant is still talking). */
  askSent: boolean;
  /** Meaningful (non-noise) participant utterances in this window. */
  heard: string[];
  lastHeardAt: number;
  typed: boolean;
  /** A speech segment ended but its transcript has not arrived yet. */
  transcriptPending: boolean;
  judgeAt: number;
  judgeRequests: number;
  /** Held set_task_outcome calls, released when the participant has finished. */
  waiters: (() => void)[];
  ack: string;
  /** "How do you feel that went?" was asked a second time after a long silence. */
  reasked: boolean;
  /** When the question's audio started (performance.now): only speech from then on can answer it. */
  askAudibleAt: number;
  /** They replied with a question once and got a plain answer. */
  clarified?: boolean;
}

/**
 * The answer window outside quiet phases: every reply to the moderator (an interview answer, an
 * open or closed question, a post-task question, a question back). The realtime VAD never ends the
 * turn (create_response is off); the runner responds once the participant has finished, so a
 * thinking pause in the middle of an answer is never taken as its end.
 */
interface Turn {
  /** Only speech that started after this (performance.now) belongs to the turn. */
  listenFrom: number;
  heard: string[];
  lastHeardAt: number;
  typed: boolean;
  /** A speech segment of this turn ended but its transcript has not arrived yet. */
  transcriptPending: boolean;
  /** Nothing new to respond to (responded already, or nothing said yet). */
  responded: boolean;
  /** Open question re-read once after a long silence. */
  reprompted: boolean;
}

/** A participant utterance (performance.now times). */
interface Utterance {
  text: string;
  start: number;
  stepId: string | null;
  typed: boolean;
}

export class SessionRunner {
  readonly queue: EventQueue;
  readonly bridge: ProbeBridge;
  private rrweb: RrwebUploader;
  private rt: RealtimeClient | null = null;
  /** Moderator captions revealed in step with the audible voice. */
  private pacer: CaptionPacer | null = null;
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
  /** Only the runner's own start-path navigation is ignored by URL rules (not the participant's clicks). */
  private ignoreNavPath = '';
  private domPollBusy = false;
  private taskActivateTimer: ReturnType<typeof setTimeout> | null = null;

  // conversation / timing
  private quiet = false;
  private lastUserSpeech = 0; // performance.now of last speech start/stop
  private lastAssistantAudio = 0;
  private lastTrigger = 0;
  private nudgesThisTask = 0;
  private checkInDone = false;
  /** Last click / navigation / typing in the app (performance.now). */
  private lastInteraction = 0;
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
  private closingAttempts = 0;
  private closingRequestedAt = 0;
  private closingCheck: ReturnType<typeof setTimeout> | null = null;
  private finishing = false;
  private gazeBuf: [number, number, number][] = [];
  private captionSeq = 0;
  private awaitingReplyUntil = 0;
  /** `${stepId}::${questionId}` of spoken questions the moderator has fully read out. */
  private askedQuestions = new Set<string>();
  /** Quiet-phase turn-taking decisions (debug / tests). */
  readonly turnChecks: { text: string; addressed: boolean; label: TurnLabel; via: string; verdict: string | null; at: number }[] = [];
  private wrap: WrapUp | null = null;
  private wrapTimer: ReturnType<typeof setInterval> | null = null;
  /** "You can skip" reminder given in this task / STUCK utterances heard. */
  private skipReminded = false;
  private stuckCount = 0;
  /** How often each question of the current step was read out (`stepId::qid`). */
  private askCounts = new Map<string, number>();
  /** Questions re-read once after a long silence (`stepId::qid`). */
  private silencePrompted = new Set<string>();
  /** Voice mode: a question's card appears when the moderator starts reading it (`stepId::qid`), not before. */
  private cardRevealed = new Set<string>();
  private cardRevealTimer: ReturnType<typeof setTimeout> | null = null;
  private lastDirectedAt = 0;
  private lastResponseStartAt = 0;
  private lastSpeechStopAt = 0;
  private lastAssistantAudioStart = 0;
  private nudgePending = false;
  /** When each realtime input item's speech started (performance.now). */
  private speechStarts = new Map<string, number>();
  private utterances: Utterance[] = [];
  private turn: Turn = { listenFrom: 0, heard: [], lastHeardAt: 0, typed: false, transcriptPending: false, responded: true, reprompted: false };
  /** When each spoken question (`stepId::qid`) had been read out completely (performance.now). */
  private questionHeardAt = new Map<string, number>();
  /** Quiet phases: a reply the moderator owes, sent once the participant has finished talking. */
  private replyDue: { since: number; last: string; send: () => void } | null = null;
  /** Local mic level: last time it heard voice (performance.now), and whether it ever did. */
  private localVoiceAt = 0;
  private meterAlive = false;
  /** After an explicit signal (the Done button) the local mic meter may overrule the server VAD's end-of-turn lag. */
  private relaxGateUntil = 0;
  /** A tell/explain task: the classifier thinks they gave the answer (never ends the task by itself). */
  private delivered: { text: string; at: number } | null = null;
  private finishReminded = false;
  /** Instruction step without a question: complete_step requested after the script was read. */
  private instructionAdvanceAsked = false;

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
    this.timers.push(setInterval(() => this.checkTurn(), 200));
    this.timers.push(setInterval(() => this.sampleMic(), 100));
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
      // Never start speaking while the participant is talking.
      canSpeak: () => !this.participantTalking(performance.now() < this.relaxGateUntil),
      handlers: {
        onStatus: (s, detail) => {
          const prev = this.state.conn;
          this.set({ conn: s });
          this.updateOrb();
          if (s === 'reconnecting' && prev === 'connected') this.queue.push('observation', { kind: 'realtime_dropped', note: 'Voice connection dropped; reconnecting once.' });
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
        onUserSpeechStart: (itemId) => {
          this.lastUserSpeech = performance.now();
          this.userSpeechStartT = this.queue.now();
          if (itemId) {
            this.speechStarts.set(itemId, this.lastUserSpeech);
            if (this.speechStarts.size > 200) this.speechStarts.delete(this.speechStarts.keys().next().value!);
          }
          this.heardSinceStep = true;
          if (this.wrap) this.wrap.transcriptPending = true;
          if (!this.quiet) this.turn.transcriptPending = true;
          this.queue.push('speech.start', { who: 'participant' });
          this.updateOrb();
        },
        onUserSpeechStop: () => {
          this.lastUserSpeech = performance.now();
          this.lastSpeechStopAt = this.lastUserSpeech;
          this.queue.push('speech.stop', { who: 'participant' });
          this.updateOrb();
        },
        onUserTranscriptDelta: (itemId, delta) => this.caption('participant', itemId, delta, false, true),
        onUserTranscript: (itemId, text, logprobs) => this.onUserTranscript(itemId, text, logprobs),
        onAssistantTranscriptDelta: (rid, delta) => this.pacer?.delta(rid, delta),
        onAssistantTranscript: (rid, text, phase) => this.pacer?.done(rid, text, phase),
        onAssistantAudioStart: (rid) => {
          this.pacer?.audioStart(rid);
          this.lastAssistantAudio = performance.now();
          this.lastAssistantAudioStart = this.lastAssistantAudio;
          // The moderator reacts to the Done button: it is no longer "pending".
          if (this.state.pendingAction === 'done' && this.wrap) this.set({ pendingAction: null });
          if (this.wrap?.phase === 'asking' && this.wrap.askSent && this.wrap.askAudibleAt === Infinity) this.wrap.askAudibleAt = this.lastAssistantAudio;
          this.revealCard();
          this.queue.push('speech.start', { who: 'moderator' });
          this.updateOrb();
        },
        onAssistantAudioStop: (rid, cleared, byClient) => {
          // Commit what was audible first (the step logic below reads the committed transcript).
          const cut = this.pacer?.audioStop(rid, cleared);
          // We cut it off ourselves: tell the server what was heard (its own VAD interruptions it truncates itself).
          if (cut && byClient) rt.truncate(cut.seg.itemId, cut.playedMs);
          this.lastAssistantAudio = performance.now();
          this.queue.push('speech.stop', { who: 'moderator' });
          this.updateOrb();
          // A new answer window starts when the moderator's turn has been heard completely; if the
          // participant cut in, their words from the start of that turn belong to it.
          this.openTurn(cleared ? this.lastAssistantAudioStart : performance.now());
          this.onModeratorFinishedSpeaking();
        },
        onResponseStart: () => {
          this.lastResponseStartAt = performance.now();
          this.updateOrb();
        },
        onResponseDone: (status, rid) => {
          if (status === 'cancelled' && rid) this.pacer?.cancelled(rid);
          this.updateOrb();
          // In text-only output there is no audio stop event.
          if (!rt.assistantAudioPlaying) this.onModeratorFinishedSpeaking();
        },
        onError: (message, code) => this.queue.push('session.error', { message, code, source: 'realtime' }),
      },
    });
    this.rt = rt;
    this.pacer?.dispose();
    this.pacer = new CaptionPacer({
      show: (id, text, final) => {
        if (text) this.caption('moderator', id, text, final, false);
      },
      commit: (seg, text, truncated, late) => {
        this.onAssistantTranscript(seg.id, text, seg.phase, truncated);
        if (late && !this.rt?.assistantAudioPlaying) this.onModeratorFinishedSpeaking();
      },
      level: () => (this.remoteMeter ? this.remoteMeter.raw() : null),
    });
    await rt.connectWithRetry();
  }

  private onRealtimeReady(reconnected: boolean) {
    const rt = this.rt!;
    rt.updateSession({
      instructions: buildModeratorInstructions(this.protocol, this.steps),
      tools: MODERATOR_TOOLS,
      tool_choice: 'auto',
    });
    // Transcription confidence (used to drop noise). Separate update: an unsupported field must not
    // reject the instructions above.
    rt.updateSession({ include: ['item.input_audio_transcription.logprobs'] });
    this.applyTurnDetection(true);
    if (!reconnected) {
      this.enterStep(-1, 'announce');
      return;
    }
    this.queue.push('observation', { kind: 'realtime_reconnected' });
    if (this.state.index >= this.steps.length) {
      // Reconnected during the closing: just say it (again, if it was cut off).
      if (!this.closingSpoken) this.sayClosing();
      return;
    }
    const recent = this.transcriptLog
      .slice(-8)
      .map((l) => `${l.role}: ${l.text}`)
      .join('\n');
    rt.addSystemItem(
      `[EVENT] The connection dropped briefly and was restored. Recent conversation:\n${recent || '(none)'}\nSay one short sentence in ${languageName(this.mod.language)} like "Sorry, we had a short connection problem." and then continue exactly where you left off according to this brief (do not restart earlier steps):\n[STEP] ${JSON.stringify(this.brief())}`,
    );
    rt.requestResponse();
  }

  private applyTurnDetection(force = false) {
    if (!this.rt || !this.opts.mic) return;
    const quiet = this.isQuietPhase();
    if (!force && quiet === this.quiet) return;
    this.quiet = quiet;
    const tr = this.rt.transcription;
    this.rt.updateSession({
      audio: {
        input: {
          // Always re-send the language-pinned transcription settings with the turn detection, so a
          // partial update can never fall back to auto language detection.
          ...(tr ? { transcription: tr } : {}),
          noise_reduction: { type: 'near_field' },
          // The VAD never auto-responds: the runner decides when the participant has finished (quiet
          // phases: when they address the moderator; everywhere else: the answer window — a thinking
          // pause mid-answer is not the end of the turn). Speech still interrupts the moderator.
          turn_detection: { type: 'semantic_vad', eagerness: 'low', create_response: false, interrupt_response: true },
        },
      },
    });
  }

  /** Phases where the participant works and the moderator should not respond to every utterance. */
  private isQuietPhase() {
    const s = this.step;
    if (!s) return false;
    // Includes the "I'm done" answer window: the runner (not VAD) decides when they have finished.
    if (s.type === 'task') return this.state.taskPhase === 'active';
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

  private onUserTranscript(itemId: string, text: string, logprobs?: unknown) {
    this.caption('participant', itemId, text, true, false);
    if (this.wrap) this.wrap.transcriptPending = false;
    this.turn.transcriptPending = false;
    const startP = this.speechStarts.get(itemId) ?? this.lastUserSpeech;
    const startT = this.speechStarts.has(itemId) ? Math.round(this.queue.now() - (performance.now() - startP)) : (this.userSpeechStartT ?? undefined);
    if (!text) return;
    const avgLogprob = meanLogprob(logprobs);
    if (isLikelyNoise({ text, language: this.mod.language, avgLogprob })) {
      // Background noise / a mis-transcribed fragment in another language: logged for the researcher,
      // but never an answer, never a turn, and removed from the model's conversation.
      this.queue.push('transcript.participant', { text, itemId, startT, endT: this.queue.now(), source: 'voice', noise: true, ...(avgLogprob != null ? { avgLogprob: Math.round(avgLogprob * 100) / 100 } : {}) });
      this.dropCaption(itemId);
      // (The VAD never auto-responds, so nothing was started for it.)
      this.rt?.deleteItem(itemId);
      return;
    }
    this.heardSinceStep = true;
    this.transcriptLog.push({ role: 'participant', text });
    this.queue.push('transcript.participant', { text, itemId, startT, endT: this.queue.now(), source: 'voice', ...(avgLogprob != null ? { avgLogprob: Math.round(avgLogprob * 100) / 100 } : {}) });
    this.noteUtterance(text, startP, false);
    if (this.wrap) return this.onWrapUtterance(text, false, startP);
    // In quiet phases the moderator responds only when addressed.
    if (this.quiet && this.rt) return void this.respondIfAddressed(text);
    this.onTurnUtterance(text, startP, false);
  }

  private noteUtterance(text: string, start: number, typed: boolean) {
    this.utterances.push({ text, start, stepId: this.step?.id ?? (this.state.index < 0 ? 'intro' : 'closing'), typed });
    if (this.utterances.length > 60) this.utterances.shift();
  }

  private dropCaption(itemId: string) {
    const cid = `participant:${itemId}`;
    if (this.state.captions.some((c) => c.id === cid)) this.set({ captions: this.state.captions.filter((c) => c.id !== cid) });
  }

  /**
   * Quiet phases (active task, exploration, on-screen questionnaire): what is this utterance?
   * Decided by the model itself in a silent out-of-band check (works in any language, and it hears
   * the audio); falls back to punctuation / English keywords on timeout. During a task it also
   * recognises "I'm done" (→ wrap-up), a delivered tell/explain answer (→ wrap-up without asking),
   * skip requests, and a participant who is stuck or frustrated.
   */
  private async respondIfAddressed(text: string) {
    const rt = this.rt;
    if (!rt) return;
    const step = this.step;
    const stepId = step?.id;
    const awaiting = performance.now() < this.awaitingReplyUntil;
    this.awaitingReplyUntil = 0;
    const onScreenForm = step?.type === 'questionnaire';
    const task = step?.type === 'task' ? step : null;
    if (onScreenForm && awaiting) {
      this.turnChecks.push({ text, addressed: true, label: 'ADDRESSED', via: 'reply', verdict: null, at: this.queue.now() });
      this.replyWhenFinished(text, () => rt.requestResponse());
      return;
    }
    const quoted = text.replace(/"/g, "'");
    const prompt = task
      ? `You are a silent turn-taking classifier for a usability-test moderator — you are NOT talking to anyone. The participant is working on this task (they were told: "${task.instruction.replace(/"/g, "'")}") and thinking aloud. Their most recent utterance (it may be in any language) was transcribed as: "${quoted}".${awaiting ? ' The moderator had just asked them something.' : ''}
Classify it with exactly one label:
DONE — they say they have finished the task or found what they were looking for ("I'm done", "I think that's it", "found it", "fertig"), in any language.
DELIVERED — ONLY if the task asks them to tell, explain or describe something to the moderator AND in this utterance they state their final answer to it as an answer to the moderator (e.g. "The main claim is that…", "It costs 89 dollars."). Thinking aloud is NOT DELIVERED: describing what they see, reading text aloud, a plan, a guess about where to look, a half sentence, a question (e.g. "Do I click done?" is ADDRESSED) — when in doubt, answer NO.
SKIP — they want to skip, stop or give up on the task.
STUCK — they say they cannot find or do not see something, are lost, or sound frustrated or irritated.
ADDRESSED — any other question or request to the moderator (including asking what the task was or what the moderator meant), or a reply to something the moderator just asked.
NO — thinking aloud, describing what they see or do, reading text aloud, talking to themselves, or noise.
Reply with exactly one word: DONE, DELIVERED, SKIP, STUCK, ADDRESSED or NO.`
      : `You are a silent turn-taking classifier for a usability-test moderator — you are NOT talking to anyone. The participant is ${
          onScreenForm ? 'filling in an on-screen questionnaire' : 'exploring the app and thinking aloud'
        }. Their most recent utterance (it may be in any language) was transcribed as: "${quoted}".
Answer YES if they are addressing the moderator and expect a reply or an action: answering a question the moderator just asked, a question to the moderator, a request for help or to repeat something, saying they are done / finished / want to skip, stop or give up${
          onScreenForm ? ', or saying a rating or answer for one of the on-screen items' : ''
        }. Answer NO if they are thinking aloud, describing what they see or do, reading text aloud, or asking themselves a question.
Reply with exactly one word: YES or NO.`;
    const verdict = await rt.classify(prompt, 4000);
    let label: TurnLabel | null = null;
    let via: string = 'model';
    const m = verdict ? /^\W*(DONE|DELIVERED|SKIP|STUCK|ADDRESSED|NO|YES)\b/i.exec(verdict) : null;
    if (m) {
      const v = m[1].toUpperCase();
      label = v === 'YES' ? 'ADDRESSED' : (v as TurnLabel);
      if (!task && (label === 'DONE' || label === 'DELIVERED' || label === 'SKIP' || label === 'STUCK')) label = 'ADDRESSED';
    } else {
      via = 'fallback';
      const en = (this.mod.language ?? 'en').toLowerCase().startsWith('en');
      if (task && en && /\b(i('| a)?m (done|finished)|i think i('| a)?m done|i found it|found it|that'?s it|done now)\b/i.test(text)) label = 'DONE';
      else label = /[?？؟¿]/.test(text) || (en && addressedToModerator(text)) ? 'ADDRESSED' : 'NO';
    }
    if (label === 'NO' && awaiting) {
      label = 'ADDRESSED';
      via = `${via}+reply`;
    }
    // Being stuck is usually said while thinking aloud: the moderator stays quiet the first time (unless
    // it is a reply to the moderator) and reminds them once that they can skip if it happens again.
    const stuckReply = label === 'STUCK' && (awaiting || (this.stuckCount + 1 >= 2 && !this.skipReminded));
    const addressed = label === 'STUCK' ? stuckReply : label !== 'NO';
    this.turnChecks.push({ text, addressed, label, via, verdict, at: this.queue.now() });
    if (this.turnChecks.length > 50) this.turnChecks.shift();
    // Stale (step changed, wrap-up already open, connection replaced)?
    if (this.rt !== rt || this.step?.id !== stepId || !this.quiet || this.wrap || this.state.taskPhase === 'post') return;
    switch (label) {
      case 'DONE':
        return this.startWrapUp('verbal');
      case 'DELIVERED':
        // Never ends the task by itself (it may be ongoing narration): the participant ends it with
        // "done" or the button. If they go quiet after it, they are reminded once how to finish.
        this.delivered = { text, at: performance.now() };
        return;
      case 'STUCK':
        this.stuckCount++;
        if (this.stuckCount >= 2 && !this.skipReminded) return this.replyWhenFinished(text, () => this.remindSkip());
        if (awaiting) this.replyWhenFinished(text, () => rt.requestResponse());
        return;
      case 'SKIP':
      case 'ADDRESSED':
        this.replyWhenFinished(text, () => rt.requestResponse());
        return;
      default:
        // Still talking after a reply was due: the reply waits for the end of this utterance too.
        if (this.replyDue) this.replyDue.last = text;
        return;
    }
  }

  /** Quiet phases: reply once the participant has finished this utterance (never into a thinking pause). */
  private replyWhenFinished(last: string, send: () => void) {
    this.replyDue = { since: performance.now(), last, send };
  }

  /** Is the participant talking right now? `relaxed`: the local mic meter may overrule the server VAD's end-of-turn lag. */
  private participantTalking(relaxed = false): boolean {
    const rt = this.rt;
    if (!rt) return false;
    const now = performance.now();
    if (relaxed && this.meterAlive && now - this.localVoiceAt > 400) return false;
    return rt.userSpeaking || now - this.lastSpeechStopAt < 300;
  }

  private sampleMic() {
    const lvl = this.micMeter && !this.state.muted ? this.micMeter.raw() : 0;
    if (lvl > 0.04) {
      this.localVoiceAt = performance.now();
      this.meterAlive = true;
    }
  }

  /** Stuck or frustrated: tell them once per task that skipping is fine. */
  private remindSkip() {
    this.skipReminded = true;
    this.lastTrigger = performance.now();
    this.queue.push('observation', { kind: 'skip_reminder' });
    const en = (this.mod.language ?? 'en').toLowerCase().startsWith('en');
    this.directed(
      en
        ? `The participant seems stuck or frustrated. Briefly acknowledge it and say once, kindly and neutrally: "If you'd like, you can skip this one — just say so or press Skip." Nothing else. No hints, no apology for the design.`
        : `The participant seems stuck or frustrated. In ${languageName(this.mod.language)}, briefly and kindly say once that they can skip this task if they like, by saying so or pressing "Skip". Nothing else. No hints, no apology for the design.`,
    );
  }

  /** A moderator utterance as it was actually heard (cut at the interruption point when `truncated`). */
  private onAssistantTranscript(rid: string, text: string, phase?: string, truncated = false) {
    if (!text) return;
    this.caption('moderator', rid, text, true, false);
    this.transcriptLog.push({ role: 'moderator', text });
    this.queue.push('transcript.moderator', { text, responseId: rid, ...(phase ? { phase } : {}), ...(truncated ? { truncated: true } : {}) });
    // Which question was actually read out, completely and audibly (an interrupted reading does not
    // count). Only speech that starts after this moment can answer it.
    const cur = this.step && this.state.index >= 0 ? this.nextQuestion() : null;
    if (cur && this.isReadingOfQuestion(text, cur, truncated)) {
      const k = akey(this.step!.id, cur.id);
      this.askedQuestions.add(k);
      this.askCounts.set(k, (this.askCounts.get(k) ?? 0) + 1);
      this.questionHeardAt.set(k, performance.now());
    }
    if (this.wrap?.phase === 'asking' && /[?？؟]/.test(text)) this.wrap.questionHeard = true;
    // The moderator asked something during a quiet phase: the next utterance is the answer.
    this.awaitingReplyUntil = /[?？؟]/.test(text) && this.quiet ? performance.now() + 60_000 : 0;
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

  /** Was `text` (a moderator line as heard) a complete reading of `q`? */
  private isReadingOfQuestion(text: string, q: Question, truncated: boolean) {
    // Translated live (standard instrument without a stored translation): any question the moderator asks while it is current.
    if (q.translateTo) return /[?？؟]/.test(text) && !truncated;
    return isReadingOf(text, q.prompt, truncated ? 0.9 : 0.6);
  }

  // ── step machine ───────────────────────────────────────────────────────────
  private questionQueue(): Question[] {
    const s = this.step;
    if (!s) return [];
    if (s.type === 'task') return this.state.taskPhase === 'post' ? stepQuestions(s, this.mod.language) : [];
    return stepQuestions(s, this.mod.language);
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
      timesAsked: (() => {
        const q = this.step && this.step.type !== 'instruction' ? this.nextQuestion() : null;
        return q ? this.askCounts.get(akey(this.step!.id, q.id)) ?? 0 : 0;
      })(),
      taskEndedAs: this.step?.type === 'task' && this.state.taskPhase === 'post' ? this.taskOutcome?.outcome : undefined,
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
    this.checkInDone = false;
    this.observed = new Map();
    this.behaviourProbeAsked = false;
    this.endWrap();
    this.skipReminded = false;
    this.stuckCount = 0;
    this.askCounts = new Map();
    this.questionHeardAt = new Map();
    this.silencePrompted = new Set();
    this.cardRevealed = new Set();
    this.replyDue = null;
    this.delivered = null;
    this.finishReminded = false;
    this.instructionAdvanceAsked = false;
    // Anything said before this step's first moderator line is not a reply to it.
    this.resetTurn();
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
      // No start page = continue wherever the participant currently is in the app.
      if (this.opts.start.appUrl && step.startPath?.trim()) this.navigateApp(step.startPath.trim());
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
      this.rt.addSystemItem(`${prefix ? `${prefix}\n` : ''}[STEP] ${JSON.stringify(brief)}`);
      this.sayClosing(ack);
      this.briefDelivered = true;
      return brief;
    }
    if (mode === 'announce' && this.rt) {
      this.rt.addSystemItem(`${prefix ? `${prefix}\n` : ''}[STEP] ${JSON.stringify(this.withAck(brief, ack))}`);
      // Verbatim text known: dictate this turn (no improvisation, no tool calls, no double reading).
      if (brief.say_verbatim) this.directed(this.sayWithAck(ack, brief.say_verbatim, 'Say the following text verbatim, completely and only once, and nothing else'));
      else this.rt.requestResponse();
      this.briefDelivered = true;
    } else this.briefDelivered = true;
    return brief;
  }

  /** "Say "<ack>"" — or its equivalent in the session language. */
  /**
   * Dictate "<ack> <text>". In English the acknowledgement is part of the verbatim text (the model
   * reliably says it then); other languages get the ack as an instruction to translate.
   */
  private sayWithAck(ack: string | undefined, text: string, how: string) {
    if (!ack) return `${how}:\n"${text}"`;
    if (this.isEnglish()) return `${how}:\n"${ack} ${text}"`;
    return `${this.ackPhrase(ack)}, then — ${how.charAt(0).toLowerCase()}${how.slice(1)}:\n"${text}"`;
  }

  /** The brief as announced: in English the dictated acknowledgement is part of the verbatim text. */
  private withAck(b: ModeratorBrief, ack?: string): ModeratorBrief {
    return ack && b.say_verbatim && this.isEnglish() ? { ...b, say_verbatim: `${ack} ${b.say_verbatim}` } : b;
  }

  private isEnglish() {
    return (this.mod.language ?? 'en').toLowerCase().startsWith('en');
  }

  private ackPhrase(ack: string) {
    const lang = this.mod.language?.toLowerCase().split(/[-_]/)[0] ?? 'en';
    return lang === 'en' ? `Say "${ack}"` : `Say a short, natural ${languageName(this.mod.language)} equivalent of "${ack}"`;
  }

  private sayClosing(ack?: string) {
    this.closingAttempts++;
    this.closingRequestedAt = performance.now();
    this.directed(`The session is over. ${this.sayWithAck(ack, this.protocol.closing, 'Say exactly the following text, verbatim, and nothing else')}`);
  }

  private clearStepTimers() {
    if (this.cardRevealTimer) clearTimeout(this.cardRevealTimer);
    this.cardRevealTimer = null;
    if (this.exploreTimer) clearTimeout(this.exploreTimer);
    if (this.taskActivateTimer) clearTimeout(this.taskActivateTimer);
    this.exploreTimer = null;
    this.taskActivateTimer = null;
  }

  /** Called whenever the moderator stops talking. */
  private onModeratorFinishedSpeaking() {
    const s = this.step;
    const w = this.wrap;
    if (w?.phase === 'asking' && w.questionHeard) {
      w.phase = 'listening';
      w.listenFrom = performance.now();
    }
    // Only a finished reading of the instruction starts the task. A leftover line from the previous
    // step (or an interrupted reading) must not start the clock; the 25 s timeout is the fallback.
    if (s?.type === 'task' && this.state.taskPhase === 'briefing' && this.instructionHeard && performance.now() - this.stepEnteredAt > 1500) this.activateTask('briefed');
    if (s?.type === 'instruction' && (s.exploreSeconds ?? 0) > 0 && !this.state.exploreEndsAt && performance.now() - this.stepEnteredAt > 1500) this.startExplore();
    // An instruction without a question: after it has been read, the model moves on (complete_step).
    if (s?.type === 'instruction' && !(s.exploreSeconds ?? 0) && !s.script.includes('?') && this.briefDelivered && !this.instructionAdvanceAsked && this.rt && performance.now() - this.stepEnteredAt > 1500) {
      this.instructionAdvanceAsked = true;
      this.rt.requestResponse();
    }
    if (this.state.index >= this.steps.length && !this.closingSpoken && this.closingAttempts > 0 && !this.closingCheck) {
      // The closing turn said something else (e.g. finished an interrupted sentence): ask once more,
      // then end the session regardless — it must never hang at the very end.
      this.closingCheck = setTimeout(() => {
        this.closingCheck = null;
        const rt = this.rt;
        if (this.finishing || this.closingSpoken || this.state.index < this.steps.length) return;
        if (rt?.responding || rt?.assistantAudioPlaying || performance.now() - this.closingRequestedAt < 4000) return; // still on its way
        if (this.closingAttempts < 2) this.sayClosing();
        else void this.finish();
      }, 2500);
    }
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
    this.endWrap();
    this.replyDue = null;
    // Thinking aloud during the task is never an answer to the post-task questions.
    this.resetTurn();
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
  private announceTaskEnd(text: string, ack: string, allowProbes = true, summary?: string) {
    if (!this.rt) return;
    this.rt.cancelResponse();
    if (!this.nextQuestion() && !(allowProbes && this.postTaskProbesAvailable())) {
      this.queue.push('observation', { kind: 'step_summary', note: summary ?? text.split('. ')[0] });
      this.advance(`[EVENT] ${text} This task is finished; move on to the next step below.`, ack);
      return;
    }
    const b = this.brief();
    this.rt.addSystemItem(`[EVENT] ${text}\n[STEP] ${JSON.stringify(this.withAck(b, ack))}`);
    // The runner knows exactly what must be said next: direct it (no improvisation, no tools).
    if (b.say_verbatim) this.directed(this.sayWithAck(ack, b.say_verbatim, 'Say this verbatim and nothing else (the question exactly as written)'));
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
    this.lastDirectedAt = performance.now();
    this.rt?.requestResponse(`${buildModeratorInstructions(this.protocol, this.steps)}\n\n# NOW\n${now}\nDo not continue, finish or repeat any earlier (interrupted) sentence of yours.`, 'none');
  }

  /** The moderator started speaking while a question is current: that is its reading — show its card. */
  private revealCard() {
    const s = this.step;
    if (!s || this.state.index < 0 || (s.type === 'questionnaire' && questionnaireOnScreen(s))) return;
    const q = this.nextQuestion();
    if (!q) return;
    const k = akey(s.id, q.id);
    if (this.cardRevealed.has(k)) return;
    this.cardRevealed.add(k);
    this.updateCard();
  }

  private updateCard() {
    const s = this.step;
    let card: CardState | null = null;
    if (s) {
      if (s.type === 'questionnaire' && questionnaireOnScreen(s)) {
        card = { kind: 'questionnaire', stepId: s.id, title: s.title, questions: stepQuestions(s, this.mod.language), submitted: this.questionnaireSubmitted };
      } else {
        // Every question gets an on-screen card (open ones too): the question text, an optional typed
        // answer and an "I'm not sure" control — so the participant always sees what is being asked.
        // With a voice moderator it appears when the moderator starts reading the question (nobody
        // answers a question that has not been asked yet).
        const q = this.nextQuestion();
        const k = q ? akey(s.id, q.id) : '';
        const shown = q && (this.state.mode !== 'voice' || this.cardRevealed.has(k) || this.askedQuestions.has(k) || Boolean(this.state.answers[k]));
        if (q && shown) card = { kind: 'question', stepId: s.id, questions: [q], activeQuestionId: q.id };
        else if (this.state.card && this.state.card.stepId === s.id && this.state.card.kind === 'question') {
          // keep the last answered card visible until the next one appears or the step changes (shows the recorded answer)
          card = this.state.card;
        }
        if (q && !shown && !this.cardRevealTimer) {
          // Fallback: the reading never started (e.g. a dropped response) — show it anyway.
          this.cardRevealTimer = setTimeout(() => {
            this.cardRevealTimer = null;
            const cur = this.nextQuestion();
            if (cur && this.step === s) {
              this.cardRevealed.add(akey(s.id, cur.id));
              this.updateCard();
            }
          }, 8000);
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

  // ── answer windows (runner-owned turn-taking) ──────────────────────────────
  private resetTurn() {
    this.turn = { listenFrom: performance.now(), heard: [], lastHeardAt: 0, typed: false, transcriptPending: false, responded: true, reprompted: false };
  }

  /** The moderator finished a turn: what the participant says from `from` on is the reply to it. */
  private openTurn(from: number) {
    this.turn = { listenFrom: from, heard: [], lastHeardAt: 0, typed: false, transcriptPending: Boolean(this.rt?.userSpeaking), responded: true, reprompted: false };
  }

  /** A (non-noise) utterance outside quiet phases. */
  private onTurnUtterance(text: string, start: number, typed: boolean) {
    const t = this.turn;
    // Started before the moderator's last turn was over (e.g. thinking aloud while a task ended): not a reply to it.
    if (!typed && start < t.listenFrom - 50) {
      this.queue.push('observation', { kind: 'turn_ignored', note: 'speech started before the moderator finished; not treated as a reply', text: text.slice(0, 200) });
      return;
    }
    t.heard.push(text);
    t.lastHeardAt = performance.now();
    t.typed = typed;
    t.transcriptPending = false;
    t.responded = false;
  }

  /** The question the participant may be answering aloud right now (none during tasks or on-screen forms). */
  private openSpokenQuestion(): Question | null {
    const s = this.step;
    if (!s || this.state.index < 0 || s.type === 'instruction') return null;
    if (s.type === 'questionnaire' && questionnaireOnScreen(s)) return null;
    if (s.type === 'task' && this.state.taskPhase !== 'post') return null;
    return this.nextQuestion();
  }

  private turnInput(closed: boolean) {
    const t = this.turn;
    return {
      heard: t.heard,
      typed: t.typed,
      now: performance.now(),
      listenFrom: t.listenFrom,
      lastHeardAt: t.lastHeardAt,
      lastUserSpeech: this.lastUserSpeech,
      userSpeaking: Boolean(this.rt?.userSpeaking),
      transcriptPending: t.transcriptPending,
      closed,
    };
  }

  /** Runs every 200 ms: replies that are due, the finish reminder, and the answer window. */
  private checkTurn() {
    const rt = this.rt;
    if (!rt || this.state.mode !== 'voice' || this.disposed || this.finishing || this.state.ended) return;
    const now = performance.now();
    const s = this.step;
    // Quiet phases: a reply that is due waits until the participant has finished their utterance.
    const due = this.replyDue;
    if (due) {
      if (rt.assistantAudioPlaying || rt.responding || this.participantTalking()) return;
      const need = quietNeededMs(due.last, { closed: /[?？؟]["'”’)]*\s*$/.test(due.last.trim()) });
      if (now - this.lastUserSpeech < need && now - due.since < 10_000) return;
      this.replyDue = null;
      due.send();
      return;
    }
    // A tell/explain task: they seem to have given their answer and gone quiet → remind them once how to finish.
    if (this.quiet && this.delivered && !this.finishReminded && !this.wrap && s?.type === 'task' && this.state.taskPhase === 'active') {
      const lastActivity = Math.max(this.lastUserSpeech, this.lastInteraction, this.lastAssistantAudio, this.delivered.at);
      if (!this.participantTalking() && !rt.assistantAudioPlaying && !rt.responding && now - lastActivity >= 6000) this.remindFinish();
      return;
    }
    if (this.quiet || this.wrap || this.state.index >= this.steps.length) return;
    if (rt.assistantAudioPlaying || rt.responding) return;
    const q = this.openSpokenQuestion();
    const d = turnDecision(this.turnInput(Boolean(q && q.kind !== 'open')));
    if (d.state === 'finished') {
      if (!this.turn.responded) this.respondToTurn(q);
      return;
    }
    // Silence is never an answer: re-read the question once, then move on without an answer.
    if (d.state === 'silent' && q && s) {
      const k = akey(s.id, q.id);
      const heardAt = this.questionHeardAt.get(k);
      if (heardAt == null || this.turn.listenFrom < heardAt - 50 || this.state.answers[k]) return;
      if (!this.silencePrompted.has(k)) {
        if (d.quietMs >= ANSWER_SILENCE_MS) this.repromptQuestion(q);
      } else if (d.quietMs >= ANSWER_SILENCE_AFTER_REPROMPT_MS) this.giveUpQuestion(q);
    }
  }

  /** The participant finished their turn: let the moderator respond (record the answer, or reply). */
  private respondToTurn(q: Question | null, typed = false) {
    const rt = this.rt;
    const s = this.step;
    const t = this.turn;
    if (!rt) return;
    t.responded = true;
    const said = t.heard.join(' ').replace(/\s+/g, ' ').replace(/"/g, "'").trim();
    const k = s && q ? akey(s.id, q.id) : '';
    this.queue.push('observation', { kind: 'turn_end', ...(q ? { questionId: q.id } : {}), waitedMs: Math.round(performance.now() - Math.max(this.lastUserSpeech, t.lastHeardAt)), ...(typed ? { typed: true } : {}) });
    if (s && q && this.questionHeardAt.has(k)) {
      const instr = buildModeratorInstructions(this.protocol, this.steps);
      this.lastDirectedAt = performance.now();
      if ((this.askCounts.get(k) ?? 0) >= 2) {
        // "Never ask the same question more than twice": record what they said.
        rt.requestResponse(
          `${instr}\n\n# NOW\nYou have already asked question "${q.id}" twice. Do not ask it again. Their complete answer turn: "${said}". Call record_answer for question_id "${q.id}" now with what the participant said in their own words (declined: true if they did not know, did not see it or did not really answer).`,
          { type: 'function', name: 'record_answer' },
        );
        return;
      }
      rt.requestResponse(
        `${instr}\n\n# NOW\nThe participant has finished their turn. Their complete answer turn (everything they said after you asked question_id "${q.id}"): "${said}". If it answers the question, call record_answer for question_id "${q.id}" now with their complete answer in their own words (declined: true if they do not know or did not see it), without saying anything first. If instead they asked you something (what the question means, to repeat it, how the session works), reply plainly and briefly — re-read the question if they asked for that — and do not record anything. Never use anything they said before you asked the question.`,
      );
      return;
    }
    rt.requestResponse();
  }

  /** Is the participant still in the middle of their answer (talking, in a thinking pause, transcript on its way)? */
  private answerStillOpen(q: Question) {
    if (!this.rt) return false;
    const d = turnDecision(this.turnInput(q.kind !== 'open'));
    return d.state === 'wait' && (this.turn.heard.length > 0 || Boolean(this.rt.userSpeaking));
  }

  /** Long silence after a question: read it once more, gently. */
  private repromptQuestion(q: Question) {
    const s = this.step!;
    this.silencePrompted.add(akey(s.id, q.id));
    this.queue.push('observation', { kind: 'answer_silence_reprompt', questionId: q.id });
    this.turn.responded = true;
    this.directed(
      this.sayWithAck(
        'Take your time.',
        q.prompt,
        q.translateTo ? `Ask this question again, translated faithfully into ${q.translateTo}, and nothing else` : 'Say the question again, verbatim and only once, and nothing else',
      ),
    );
  }

  /** Still no answer after the re-prompt: leave the question unanswered and move on (never record silence as an answer). */
  private giveUpQuestion(q: Question) {
    const rt = this.rt;
    const s = this.step;
    if (!rt || !s) return;
    this.skipped.add(q.id);
    this.queue.push('observation', { kind: 'question_skipped', questionId: q.id, reason: 'no answer (silence after the question was asked twice)' });
    this.updateCard();
    this.resetTurn();
    const ack = "Okay, let's continue.";
    if (!this.nextQuestion() && !(s.type === 'task' && this.postTaskProbesAvailable())) {
      this.queue.push('observation', { kind: 'step_summary', note: `No answer to "${q.id}".` });
      this.advance(`[EVENT] The participant did not answer question "${q.id}" (silence). It stays unanswered. Move on to the next step below.`, ack);
      return;
    }
    const b = this.brief();
    rt.cancelResponse();
    rt.addSystemItem(`[EVENT] The participant did not answer question "${q.id}" (silence after it was asked twice). It stays unanswered — do not ask it again and do not record an answer for it.\n[STEP] ${JSON.stringify(this.withAck(b, ack))}`);
    if (b.say_verbatim) this.directed(this.sayWithAck(ack, b.say_verbatim, 'Say this verbatim and nothing else'));
    else rt.requestResponse();
  }

  /** Tell/explain task: they seem to have given their answer and gone quiet. Remind them how to finish (once). */
  private remindFinish() {
    this.finishReminded = true;
    this.lastTrigger = performance.now();
    this.queue.push('observation', { kind: 'finish_reminder', note: this.delivered?.text.slice(0, 200) });
    this.directed(
      this.isEnglish()
        ? `Say exactly this, kindly and neutrally: "If you're finished, just say 'done' or press 'I'm done'." Nothing else — never comment on what they said.`
        : `In ${languageName(this.mod.language)}, say once, briefly and kindly, that when they are finished they can just say so or press the I'm-done button. Nothing else — never comment on what they said.`,
    );
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
        // Never cut the participant off: hold the outcome (and the "Thanks") until they have finished.
        if (this.state.mode !== 'manual' && this.rt) {
          // Only an explicit completion signal ("done", the button) ends a task — never the model on its
          // own (a tell/explain answer may still be ongoing narration).
          if (!this.wrap)
            return {
              output: { ok: false, error: 'The participant has not said they are done.', hint: 'Do not end the task yourself. Stay quiet and let them continue; the system tells you when to call set_task_outcome.' },
              respond: false,
            };
          const w = this.wrap;
          if (w.phase !== 'judging') await new Promise<void>((r) => w.waiters.push(r));
          if (this.step !== s || this.snapshot.taskPhase === 'post' || this.state.ended)
            return { output: { ...this.brief(), ignored: true, note: 'The task already ended meanwhile. Continue with this brief.' }, respond: false };
        }
        const w = this.wrap;
        const said = w?.heard.join(' ').trim();
        const ack = w?.ack || 'Thanks.';
        let evidence = String(args.evidence ?? '').slice(0, 1000);
        if (said && !evidence.includes(said.slice(0, 40))) evidence = `${evidence} Participant's own words at the end: "${said.slice(0, 400)}"`;
        // Deterministic rules override the AI judgement.
        const ruleHit = await this.checkRulesNow(s);
        if (ruleHit) this.endTask('success', 'rule', `Rule matched: ${ruleHit}. AI judgement: ${outcome} — ${evidence}`);
        else this.endTask(outcome as TaskOutcome, 'ai', evidence);
        if (this.state.mode === 'manual' || !this.rt) return { output: { ...this.brief(), note: 'Outcome recorded. Never tell the participant the outcome.' }, respond: true };
        // The runner says the acknowledgement and the next text itself (no improvised "Thanks" too early).
        this.announceTaskEnd('The task outcome is recorded. Never tell the participant the outcome or imply success or failure.', ack, true, evidence.slice(0, 500));
        return { output: { ok: true, note: 'Outcome recorded. Never tell the participant the outcome. The next instruction tells you what to say.' }, respond: false };
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
    // An answer by voice is only accepted once the question has been read out completely, from speech
    // that started after that, and once the participant has finished (never mid-answer, never silence).
    const k = akey(s.id, q.id);
    if (this.state.mode === 'voice' && !onScreenForm && !this.state.answers[k]) {
      const heardAt = this.questionHeardAt.get(k);
      if (heardAt == null)
        return this.err(
          `Question "${q.id}" has not been asked yet — or your reading of it was cut off.`,
          `Ask it now${q.translateTo ? `, translated faithfully into ${q.translateTo}` : ', verbatim'}: "${q.prompt}", then wait for the answer. Do not record anything the participant said before it.`,
        );
      if (!this.utterances.some((u) => u.stepId === s.id && u.start >= heardAt - 300))
        return {
          output: { ok: false, error: `The participant has not answered question "${q.id}" yet: what they said before you asked it is not an answer, and silence is not an answer.`, hint: 'Wait silently. The system tells you when they have finished answering.' },
          respond: false,
        };
      if (this.answerStillOpen(q)) {
        this.turn.responded = false; // respond again once they have finished
        return { output: { ok: false, error: 'The participant is still answering (they paused to think).', hint: 'Wait silently. The system tells you when they have finished; then record their complete answer.' }, respond: false };
      }
    }
    if (onScreenForm && this.questionnaireSubmitted) return this.err('The questionnaire was already submitted.', 'Follow the current brief.');
    const prevAns = this.state.answers[akey(s.id, q.id)];
    // "I don't know" is valid for every kind of question; asked twice already → keep what they said.
    const parsed = parseRecordAnswer(q, args, { timesAsked: this.askCounts.get(akey(s.id, q.id)) ?? 0, prev: prevAns });
    if ('error' in parsed)
      return this.err(parsed.error, `Expected: ${describeScale(q) ?? 'free text'}. If the participant does not know, is not sure or did not see it, call record_answer with declined: true and their words in text.`);
    const prev = this.state.answers[akey(s.id, q.id)];
    // A follow-up enrichment keeps the earlier numeric value unless a new one is given.
    const merged: AnswerValue = {
      ...(prev ?? {}),
      ...parsed,
      declined: parsed.declined ? true : undefined,
      text: parsed.text && prev?.text && !parsed.text.includes(prev.text) && args.value == null ? `${prev.text} — ${parsed.text}` : parsed.text ?? prev?.text,
      source: prev?.source === 'screen' && parsed.value == null && !parsed.choices ? 'screen' : this.state.mode === 'text' ? 'text' : 'voice',
    };
    this.storeAnswer(s.id, q, merged);
    // On-screen questionnaire answered aloud: the card shows it; stay quiet while they fill in the rest.
    if (onScreenForm) return { output: { ok: true, recorded: q.id, note: 'Recorded and shown on screen. Say nothing; let them continue.' }, respond: false };
    return { output: { ...this.brief(), recorded: q.id, acknowledge: 'Begin your next turn with a brief neutral acknowledgement in the session language (like "Thanks." / "Got it."), then continue. Never narrate what you are doing.' }, respond: true };
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
      ...(a.declined ? { declined: true } : {}),
      // Standard instruments: which wording (language + source) the participant was given.
      ...(q.wording ? { wording: q.wording } : {}),
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
    // Answered on screen: nothing said in this turn is still waiting for a reply.
    this.turn.responded = true;
    this.turn.heard = [];
    const label = a.choices?.join(', ') ?? (a.value != null ? String(a.value) : a.text ?? '');
    const scale = describeScale(q);
    if (wasCurrent && !prev) {
      this.rt.addSystemItem(
        `[EVENT] The participant answered on screen: question_id "${q.id}" ("${q.prompt}") → ${label}${scale ? ` (${scale})` : ''}. It is recorded — do not call record_answer for it and do not ask it again. Start with a brief neutral acknowledgement in the session language (like "Thanks.") and go straight on with the brief below. Never comment on the rating and never narrate (no "I have what I need", "noted", "let me note that").\n[STEP] ${JSON.stringify(this.brief())}`,
      );
      this.rt.requestResponse();
    } else {
      this.rt.addSystemItem(`[EVENT] The participant changed their on-screen answer for "${q.id}" to ${label}. Already recorded; no need to respond.`);
    }
  }

  submitQuestionnaire() {
    const s = this.step;
    if (s?.type !== 'questionnaire' || this.questionnaireSubmitted) return;
    const missing = stepQuestions(s, this.mod.language).filter((q) => q.required && !this.state.answers[akey(s.id, q.id)]);
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
    this.startWrapUp('button');
  }

  // ── "I'm done" wrap-up window ─────────────────────────────────────────────
  /**
   * Open the wrap-up: ask how it went (unless they just delivered what a tell/explain task asked
   * for), then wait until the participant has finished answering before the outcome is judged.
   */
  private startWrapUp(source: 'button' | 'verbal' | 'delivered', delivered?: string) {
    const s = this.step;
    const rt = this.rt;
    if (s?.type !== 'task' || this.state.taskPhase === 'post' || this.wrap || !rt) return;
    if (this.state.taskPhase === 'briefing') this.activateTask('interaction');
    const now = performance.now();
    const ask = source !== 'delivered';
    this.doneRequested = true;
    this.wrap = {
      source,
      phase: ask ? 'asking' : 'listening',
      openedAt: now,
      listenFrom: now,
      questionHeard: false,
      askSent: !ask,
      heard: delivered ? [delivered] : [],
      lastHeardAt: delivered ? now : 0,
      typed: false,
      transcriptPending: false,
      judgeAt: 0,
      judgeRequests: 0,
      waiters: [],
      ack: 'Thanks.',
      reasked: false,
      askAudibleAt: Infinity,
    };
    // The button shows "One moment…" until the moderator reacts (only for the button).
    if (source === 'button') {
      this.set({ pendingAction: 'done' });
      this.relaxGateUntil = now + 3000;
    }
    this.replyDue = null;
    this.queue.push('observation', { kind: 'wrap_up', source });
    rt.cancelClassifications();
    this.applyTurnDetection();
    if (ask) {
      rt.cancelResponse();
      rt.addSystemItem(
        `[EVENT] The participant ${source === 'button' ? 'pressed the "I\'m done" button' : 'said they are done'} with this task. The system now asks how it went and waits until they have finished answering. Do NOT call set_task_outcome and do not say "Thanks" until the system tells you to.`,
      );
      // A button press is a deliberate "I have finished": ask at once unless they are audibly still talking.
      if (!this.participantTalking(source === 'button')) this.askHowItWent();
    }
    if (!this.wrapTimer) this.wrapTimer = setInterval(() => this.checkWrapUp(), 250);
  }

  private askHowItWent() {
    if (!this.wrap || this.wrap.askSent) return;
    this.wrap.askSent = true;
    this.wrap.openedAt = performance.now();
    const again = this.wrap.reasked;
    const en = (this.mod.language ?? 'en').toLowerCase().startsWith('en');
    this.directed(
      en
        ? again
          ? 'Ask exactly this, gently and neutrally: "Take your time. How do you feel that went?" Say nothing else.'
          : 'Ask exactly this, neutrally: "How do you feel that went?" Say nothing else.'
        : again
          ? `They have not answered yet. Ask once more, gently and briefly in ${languageName(this.mod.language)}, how they feel the task went (you may say they can take their time). Say nothing else.`
          : `Ask once, neutrally and briefly in ${languageName(this.mod.language)}, how they feel the task went. Say nothing else.`,
    );
  }

  private onWrapUtterance(text: string, typed: boolean, start = performance.now()) {
    const w = this.wrap;
    if (!w) return;
    // The end of what they were saying when they pressed "I'm done" (its transcript can arrive after
    // the question started) — not the answer to a question that had not been asked yet.
    if (w.phase === 'asking' && !w.askSent) return;
    if (!typed && w.source !== 'model' && start < w.askAudibleAt - 50 && start < w.listenFrom - 50) return;
    w.heard.push(text);
    w.lastHeardAt = performance.now();
    w.typed = typed;
    w.transcriptPending = false;
    // They spoke before the question finished (or instead of waiting for it): count it as the answer.
    if (w.phase === 'asking') {
      w.phase = 'listening';
      w.listenFrom = performance.now();
    }
  }

  /** Close the wrap-up window and release any held tool call. */
  private endWrap() {
    const w = this.wrap;
    this.wrap = null;
    if (this.wrapTimer) clearInterval(this.wrapTimer);
    this.wrapTimer = null;
    w?.waiters.splice(0).forEach((r) => r());
  }

  /** Has the participant finished answering? Then judge the outcome (or release the held call). */
  private checkWrapUp() {
    const w = this.wrap;
    const rt = this.rt;
    const s = this.step;
    if (!w || !rt || s?.type !== 'task' || this.state.taskPhase === 'post' || this.disposed) return this.endWrap();
    const now = performance.now();
    if (w.phase === 'asking') {
      // Don't talk over them: the question waits until they have stopped speaking.
      if (!w.askSent) {
        const button = w.source === 'button';
        if (!this.participantTalking(button) && (button || now - this.lastUserSpeech > 700)) this.askHowItWent();
        return;
      }
      // The question never got spoken (e.g. a dropped response): listen anyway.
      if (now - w.openedAt > 15_000) {
        w.phase = 'listening';
        w.listenFrom = now;
      }
      return;
    }
    if (w.phase === 'judging') {
      if (now - w.judgeAt < 12_000) return;
      if (w.judgeRequests < 2) return this.requestJudgement();
      // The model never judged: record a neutral fallback and move on.
      this.queue.push('observation', { kind: 'wrap_up_no_judgement' });
      const ack = w.ack;
      this.endTask('partial', 'ai', `No AI judgement was received after the participant finished. Participant's words: "${w.heard.join(' ').slice(0, 300)}"`);
      this.announceTaskEnd('The task is over. Never tell the participant the outcome.', ack);
      return;
    }
    // listening
    const d = wrapUpDecision({
      source: w.source,
      heard: w.heard,
      typed: w.typed,
      now,
      listenFrom: w.listenFrom,
      lastHeardAt: w.lastHeardAt,
      lastUserSpeech: this.lastUserSpeech,
      userSpeaking: rt.userSpeaking,
      transcriptPending: w.transcriptPending,
      silenceMs: w.reasked ? ANSWER_SILENCE_AFTER_REPROMPT_MS : WRAP_SILENCE_MS,
    });
    if (!d.ready) return;
    // Silence is not an answer: ask once more (gently) before moving on without one.
    if (!w.heard.length && !w.reasked && (w.source === 'button' || w.source === 'verbal')) {
      w.reasked = true;
      w.phase = 'asking';
      w.askSent = false;
      w.questionHeard = false;
      w.askAudibleAt = Infinity;
      this.queue.push('observation', { kind: 'wrap_up_reask', silentMs: Math.round(now - w.listenFrom) });
      if (!this.participantTalking()) this.askHowItWent();
      return;
    }
    // They answered "How do you feel that went?" with a question ("What am I supposed to do?"): reply, then keep listening.
    const lastHeard = w.heard[w.heard.length - 1] ?? '';
    if (/[?？؟]["'”’)]*\s*$/.test(lastHeard.trim()) && !w.clarified && (w.source === 'button' || w.source === 'verbal')) {
      w.clarified = true;
      w.phase = 'asking';
      w.askSent = true;
      w.questionHeard = false;
      w.heard = [];
      w.openedAt = now;
      w.askAudibleAt = Infinity;
      this.queue.push('observation', { kind: 'wrap_up_question', text: lastHeard.slice(0, 200) });
      this.directed(
        this.isEnglish()
          ? `The participant asked "${lastHeard.replace(/"/g, "'")}" in reply to how the task went. Say exactly this, kindly: "I just mean: how did it go for you, in your own words?" Nothing else.`
          : `The participant asked "${lastHeard.replace(/"/g, "'")}" in reply. In ${languageName(this.mod.language)}, say plainly that you would just like to hear in their own words how they feel the task went, as one short question. Nothing else.`,
      );
      return;
    }
    const answered = d.answered;
    w.ack = d.ack;
    this.queue.push('observation', { kind: 'wrap_up_answered', answered, waitedMs: Math.round(now - w.listenFrom) });
    if (w.waiters.length) {
      // A set_task_outcome call is already waiting: release it.
      w.phase = 'judging';
      w.judgeAt = now;
      w.waiters.splice(0).forEach((r) => r());
      return;
    }
    this.requestJudgement();
  }

  /** Ask the model (tool forced, nothing spoken) for its judgement now that the participant has finished. */
  private requestJudgement() {
    const w = this.wrap;
    const rt = this.rt;
    if (!w || !rt) return;
    w.phase = 'judging';
    w.judgeAt = performance.now();
    w.judgeRequests++;
    const said = w.heard.join(' ').trim();
    const what =
      w.source === 'delivered'
        ? `The participant has told you what the task asked for${said ? `: "${said}"` : ''}, and has finished talking.`
        : said
          ? `The participant has finished answering how it went: "${said}".`
          : 'The participant did not answer how it went.';
    this.lastDirectedAt = performance.now();
    rt.requestResponse(
      `${buildModeratorInstructions(this.protocol, this.steps)}\n\n# NOW\n${what} Call set_task_outcome now with your honest judgement against the hidden success criteria (evidence: the observed app activity first, then what they said). Do not say anything.`,
      w.judgeRequests > 1 ? undefined : { type: 'function', name: 'set_task_outcome' },
      true, // text only: the judgement turn must never be audible
    );
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
    this.noteUtterance(t, performance.now(), true);
    // Typed answer to "How do you feel that went?": the wrap-up decides when to move on.
    if (this.wrap) return this.onWrapUtterance(t, true);
    if (this.quiet || this.state.mode !== 'voice') return void this.rt.requestResponse();
    // Typed = deliberate and complete: respond right away (with everything said in this turn).
    this.onTurnUtterance(t, performance.now(), true);
    this.respondToTurn(this.openSpokenQuestion(), true);
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

  /** "I'm not sure" on a question card: a valid answer for every kind of question (stored as declined). */
  declineFromScreen(stepId: string, q: Question) {
    const s = this.step;
    if (!s || s.id !== stepId || this.state.answers[akey(stepId, q.id)]) return;
    const wasCurrent = this.nextQuestion()?.id === q.id;
    this.storeAnswer(stepId, q, { text: "I'm not sure", declined: true, source: 'screen' });
    if (this.state.mode === 'manual') return this.refreshManualPrompt();
    if (!this.rt || !wasCurrent) return;
    this.turn.responded = true;
    this.turn.heard = [];
    this.rt.cancelResponse();
    this.rt.addSystemItem(
      `[EVENT] The participant pressed "I'm not sure" on screen for question_id "${q.id}" ("${q.prompt}"). It is recorded as their answer (declined) — do not call record_answer for it and do not ask it again. Say a brief neutral acknowledgement ("Okay.") and go straight on with the brief below.\n[STEP] ${JSON.stringify(this.brief())}`,
    );
    this.rt.requestResponse();
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
    this.ignoreNavPath = target.split(/[?#]/)[0];
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
    if (['app.click', 'app.input', 'app.change', 'app.navigate', 'app.dead_click', 'app.rage_click'].includes(kind)) this.lastInteraction = performance.now();
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
    if (!rules.length || (Date.now() < this.ignoreNavUntil && path.split(/[?#]/)[0] === this.ignoreNavPath)) return;
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
    // (An open "I'm done" answer window is finished first — it has its own cap.)
    if (s?.type === 'task' && this.state.taskPhase === 'active' && !this.wrap && this.state.taskDeadline && now >= this.state.taskDeadline && this.state.appStatus !== 'crashed' && (!this.rt?.userSpeaking || now - this.state.taskDeadline > 8000)) {
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
    // The local mic meter hears the participant before the server VAD reports it.
    const localVoice = this.meterAlive && performance.now() - this.localVoiceAt < 600;
    return rt.userSpeaking || rt.assistantAudioPlaying || rt.responding || localVoice;
  }

  /** Fire a nudge / check-in only after another half second of silence (never into someone starting to speak). */
  private nudgeWhenSilent(send: () => void) {
    if (this.nudgePending) return;
    this.nudgePending = true;
    setTimeout(() => {
      this.nudgePending = false;
      const s = this.step;
      if (this.disposed || !this.rt || s?.type !== 'task' || this.state.taskPhase !== 'active' || this.doneRequested || this.someoneTalking() || performance.now() - this.lastUserSpeech < 1000) return;
      send();
    }, 500);
  }

  /**
   * Silence nudges during a task: at most MAX_NUDGES per task, each after a longer silence
   * (silencePromptSeconds × 1, 1.5, 2). Someone who is clicking or navigating is working, not stuck:
   * app interaction in the last ~10 s resets the silence clock. After the cap the moderator stays
   * quiet — except one neutral check-in ("keep going or move on?") after ~90 s of silence with no
   * app activity at all.
   */
  private maybeNudge() {
    const s = this.step;
    const rt = this.rt;
    if (!rt || this.state.mode === 'manual' || s?.type !== 'task' || this.state.taskPhase !== 'active' || this.doneRequested) return;
    const mod = this.mod;
    if (!mod.silencePromptSeconds || mod.style === 'think_aloud_retrospective' || mod.style === 'unmoderated') return;
    if (this.state.muted || this.someoneTalking() || this.state.appStatus === 'crashed') return;
    const nowP = performance.now();
    if (nowP - this.lastInteraction < INTERACTION_GRACE_MS) return; // working, not stuck
    const lastSound = Math.max(this.lastUserSpeech, this.lastAssistantAudio, this.lastTrigger, this.stepEnteredAt);
    const silentFrom = Math.max(lastSound, this.lastInteraction);
    const silentMs = nowP - silentFrom;
    const silentSec = Math.round(silentMs / 1000);
    if (this.nudgesThisTask < MAX_NUDGES) {
      const threshold = mod.silencePromptSeconds * 1000 * (1 + this.nudgesThisTask * 0.5);
      if (silentMs < threshold) return;
      return this.nudgeWhenSilent(() => {
        this.nudgesThisTask++;
        this.lastTrigger = performance.now();
        this.queue.push('moderator.nudge', { silentSec, n: this.nudgesThisTask });
        rt.addSystemItem(
          `[TRIGGER] The participant has been silent for about ${silentSec} seconds while working on the task. Give ONE very short, neutral think-aloud nudge in ${languageName(this.mod.language)}, e.g. "What are you thinking right now?" or "Remember to keep talking." Use different wording from any earlier nudge. Do not mention the task content, do not hint, do not ask about progress.`,
        );
        rt.requestResponse(undefined, undefined, undefined, true);
      });
    }
    // Cap reached: one check-in after a long, completely idle stretch.
    if (this.checkInDone || silentMs < CHECK_IN_SILENCE_MS || nowP - this.lastAppAction < CHECK_IN_SILENCE_MS) return;
    this.nudgeWhenSilent(() => {
      this.checkInDone = true;
      this.lastTrigger = performance.now();
      this.queue.push('moderator.nudge', { silentSec, n: this.nudgesThisTask + 1, kind: 'check_in' });
      rt.addSystemItem(
        `[TRIGGER] The participant has been silent and inactive for about ${silentSec} seconds. Ask ONCE, neutrally and briefly, whether they would like to keep going with this task or move on (e.g. "Would you like to keep going, or move on to the next part?"). No hints, no judgement. If they want to move on, call participant_requests_skip.`,
      );
      rt.requestResponse(undefined, undefined, undefined, true);
    });
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
    this.pacer?.dispose();
    this.clearStepTimers();
    this.endWrap();
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
    return { brief: this.brief(), quiet: this.quiet, rt: this.rt?.status, events: this.queue.log.length, captionRate: this.pacer?.rate };
  }
}
