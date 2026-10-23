// ─────────────────────────────────────────────────────────────────────────────
// ThinkAloud shared contracts. Every package (server, web, probe) imports from
// here. Changing a shape here is an API change — keep it backwards compatible.
// ─────────────────────────────────────────────────────────────────────────────

export type ID = string;
/** Unix epoch milliseconds. */
export type Millis = number;

// ── Users ────────────────────────────────────────────────────────────────────
export interface User {
  id: ID;
  email: string;
  name: string;
  createdAt: Millis;
  /** Profile picture from Google sign-in (https), when the account is linked to Google. */
  avatarUrl?: string | null;
}

// ── Protocol ─────────────────────────────────────────────────────────────────

export type ModerationStyle =
  | 'think_aloud_concurrent' // participant narrates while doing tasks (default)
  | 'think_aloud_retrospective' // silent tasks, then discussion after each task
  | 'interview' // conversation-first, app is shown only when a task needs it
  | 'unmoderated'; // AI only reads instructions + collects answers, never probes

export type ProbingLevel = 'none' | 'light' | 'moderate' | 'deep';

export interface ModerationSettings {
  style: ModerationStyle;
  probingLevel: ProbingLevel;
  /** Closed (yes/no, either/or) questions only when an open question failed. */
  allowClosedQuestions: boolean;
  /** Seconds of participant silence during a task before a neutral think-aloud nudge. 0 = never. */
  silencePromptSeconds: number;
  /** Hard cap on AI follow-up probes per step (tasks + interview questions). */
  maxProbesPerStep: number;
  /** Probe on notable behaviour (errors, rage clicks, backtracking, long hesitation). */
  probeOnBehavior: boolean;
  /** BCP-47 language the moderator speaks, e.g. "en", "de", "tr". */
  language: string;
  /** OpenAI realtime voice (marin, cedar, alloy, ash, ballad, coral, echo, sage, shimmer, verse). */
  voice: string;
  /** Free text persona/tone guidance, e.g. "warm, calm, neutral". */
  tone: string;
  /** Extra researcher guardrails, appended verbatim to the moderator rules. */
  customRules: string[];
  /** Allow the participant to type instead of speak. */
  allowTextFallback: boolean;
}

export interface ConsentSettings {
  /** Markdown shown before anything is captured. */
  text: string;
  /** Record participant microphone audio (always required for voice moderation; audio file storage is optional). */
  storeAudio: boolean;
  /** Record a DOM session replay of the app (rrweb). */
  recordScreen: boolean;
  /** Offer optional webcam eye tracking (WebGazer, processed on device; only gaze points stored). */
  offerEyeTracking: boolean;
  /** Require an 18+ confirmation checkbox. */
  ageGate: boolean;
  /** Version string stored with each consent record. */
  version: string;
}

export type QuestionKind = 'open' | 'single_choice' | 'multi_choice' | 'rating' | 'yes_no' | 'number';

export interface RatingScale {
  min: number;
  max: number;
  step?: number;
  minLabel?: string;
  maxLabel?: string;
}

export interface Question {
  id: ID;
  /** Participant-facing wording. The moderator reads it verbatim. */
  prompt: string;
  kind: QuestionKind;
  options?: string[];
  scale?: RatingScale;
  required: boolean;
  /** After the answer, the AI may ask ONE open follow-up ("can you tell me more about why?"). */
  allowFollowUp?: boolean;
  /** Hidden note for the AI on what the researcher wants to learn from this question. */
  intent?: string;
  /**
   * Standard instruments only (runtime, never stored in protocols): which wording this text is,
   * e.g. "SUS/de: Rummel (2016) German SUS". Recorded with every answer.
   */
  wording?: string;
  /**
   * Standard instruments in a session language without a stored translation: the moderator
   * translates `prompt` into this language when reading it (ids and scale stay the same).
   */
  translateTo?: string;
}

/** Automatic, deterministic success detection for a task (evaluated in the participant client). */
export type SuccessRule =
  | { type: 'url_matches'; pattern: string } // regex tested against app pathname+search+hash
  | { type: 'element_visible'; selector: string } // CSS selector appears in the app DOM
  | { type: 'text_visible'; text: string } // text appears in the app DOM
  | { type: 'click_matches'; selector?: string; text?: string } // participant clicks a matching element
  | { type: 'custom_event'; name: string }; // app called window.ThinkAloud.track(name)

export type StepType = 'instruction' | 'question' | 'task' | 'questionnaire' | 'interview';

interface StepBase {
  id: ID;
  type: StepType;
  /** Researcher-facing title (also shown as a small header to the participant). */
  title: string;
}

/** The moderator says `script` (close to verbatim) then advances. */
export interface InstructionStep extends StepBase {
  type: 'instruction';
  script: string;
  /** Show the app while this step runs (e.g. "take a minute to look around"). */
  showApp?: boolean;
  /** Free exploration time in seconds (0 = move on once script is delivered). */
  exploreSeconds?: number;
  /** With showApp: app path to load when the step starts (default: wherever the app is). */
  startPath?: string;
}

export interface QuestionStep extends StepBase {
  type: 'question';
  question: Question;
}

export interface TaskStep extends StepBase {
  type: 'task';
  /** Participant-facing scenario + task. Read verbatim. Must not reveal the answer/path. */
  instruction: string;
  /** Optional app path to (re)load when the task starts, e.g. "/" or "/products". */
  startPath?: string;
  /** Hidden: what counts as success (for the AI + researcher). Never read out. */
  successCriteria: string;
  /** Optional deterministic success detection. Any rule matching = success. */
  successRules?: SuccessRule[];
  /** Hidden: expected minimal path, used for lostness (number of unique screens on the optimal path). */
  optimalPathLength?: number;
  timeLimitSec?: number;
  /** Researcher-suggested open probes the AI may use AFTER the task (never during). */
  probes?: string[];
  /** Asked right after the task ends (e.g. SEQ). */
  postTaskQuestions?: Question[];
  /** Add the Single Ease Question automatically after this task. */
  askSEQ?: boolean;
  /**
   * Soft time limit: once reached (task still running), the moderator asks once, neutrally, whether
   * they'd like to keep trying or move on. Keeping going runs on to `timeLimitSec` (the hard limit).
   */
  softLimitSec?: number;
  /** Graded assistance ladder for a participant who seems stuck (see TaskAssistance). */
  assistance?: TaskAssistance;
}

/**
 * Standard hints for a stuck participant, in escalating order. After `firstAfterSec` of task time
 * (default 60) with the participant stuck (silent, no recent app navigation, no success), the
 * moderator says generalPrompts[0] verbatim; each further `gapSec` (default 30) of being stuck,
 * the next prompt. Only after the prompts are exhausted (or an explicit plea for help) may it give
 * the direct cue. General prompts score the task 1, a direct cue 0 (see completionScore).
 */
export interface TaskAssistance {
  generalPrompts: string[];
  firstAfterSec?: number;
  gapSec?: number;
  /** Hidden: what a last-resort direct cue may say (kept minimal). Without it, no direct cue is given. */
  directCue?: string;
}

/** 2 = independent, 1 = completed after only general prompts, 0 = direct cue, abandoned or failed. */
export type CompletionScore = 0 | 1 | 2;

export interface AssistanceSummary {
  general: number;
  direct: number;
}

export type InstrumentId = 'SUS' | 'UMUX_LITE' | 'SEQ' | 'NASA_TLX' | 'NPS';

export interface QuestionnaireStep extends StepBase {
  type: 'questionnaire';
  instrument: InstrumentId | 'custom';
  /** For custom questionnaires. Standard instruments come from instruments.ts. */
  questions?: Question[];
  /** Product name substituted into instrument wording ("this system" by default). */
  productName?: string;
  /** Participant answers on screen (true) vs. the AI reads each item aloud (false). */
  onScreen?: boolean;
}

export interface InterviewStep extends StepBase {
  type: 'interview';
  /** Hidden goal of this interview block. */
  goal: string;
  /** Open questions, asked in order, verbatim. */
  questions: string[];
  /** Max AI follow-ups per question (overrides moderation.maxProbesPerStep). */
  maxFollowUps?: number;
  /** Keep the app visible while the questions are asked (e.g. "What do you think this page is for?"). */
  showApp?: boolean;
  /** With showApp: app path to load when the step starts (default: wherever the app is). */
  startPath?: string;
}

export type Step = InstructionStep | QuestionStep | TaskStep | QuestionnaireStep | InterviewStep;

export interface Protocol {
  schemaVersion: 1;
  title: string;
  /** Hidden from participants. Context for the moderator + synthesis. */
  researchGoals: string[];
  /** Hidden. What the product is, so the moderator understands context. Never used to help. */
  productContext: string;
  /** Spoken greeting/intro (AI disclosure, "we're testing the product, not you", think-aloud ask). */
  intro: string;
  /** Spoken at the very end. */
  closing: string;
  moderation: ModerationSettings;
  consent: ConsentSettings;
  steps: Step[];
  /** Randomize order of task steps (and the post-task questions that belong to them). */
  randomizeTasks: boolean;
  /** Estimated duration in minutes (shown on the landing page). */
  estimatedMinutes: number;
}

// ── Studies, apps, variants, links ───────────────────────────────────────────

export type StudyStatus = 'draft' | 'live' | 'paused' | 'closed';

export interface Study {
  id: ID;
  ownerId: ID;
  name: string;
  description: string;
  status: StudyStatus;
  createdAt: Millis;
  updatedAt: Millis;
}

export interface ProtocolRecord {
  id: ID;
  studyId: ID;
  name: string;
  protocol: Protocol;
  createdAt: Millis;
  updatedAt: Millis;
}

export type AppSourceKind = 'upload' | 'url' | 'git';
export type AppFramework = 'vite' | 'cra' | 'next-static' | 'next-server' | 'node-server' | 'expo-web' | 'static' | 'unknown';
export type BuildStatus = 'queued' | 'building' | 'ready' | 'failed';

export interface AppBuildSettings {
  /** Build-time (and, for server apps, runtime) environment variables, e.g. VITE_API_URL, EXPO_PUBLIC_*, NEXT_PUBLIC_*. */
  env?: Record<string, string>;
  /** Replaces the framework's build step; dependencies are still installed first. */
  buildCommand?: string;
  /** Folder (relative to the project root) holding index.html after the build. */
  outputDir?: string;
  /** Server apps: how to start the server (must listen on $PORT). */
  startCommand?: string;
  /** 'auto' (default) detects; 'static' forces static hosting; 'server' runs a Node server. */
  mode?: 'auto' | 'static' | 'server';
  /** Node.js major, e.g. "20". Default: .nvmrc / engines.node, else 22. */
  nodeVersion?: string;
}

export interface AppBuild {
  id: ID;
  studyId: ID;
  name: string;
  sourceKind: AppSourceKind;
  /** For 'url': the external URL. For 'git': repo URL. */
  sourceUrl?: string;
  framework: AppFramework;
  status: BuildStatus;
  /** Tail of the build log (full log at GET /api/apps/:id/log). */
  error?: string;
  /** Where participants load it. Set when ready. Hosted builds live on the app-host origin. */
  url?: string;
  /** Whether the probe is injected (hosted builds) — external URLs need the snippet. */
  instrumented: boolean;
  /** Researcher build settings (uploads/git): env vars, command/output overrides, hosting mode, Node version. */
  buildSettings?: AppBuildSettings;
  /** Server apps (next-server / node-server): state of the app's server container. */
  runtime?: { state: 'stopped' | 'starting' | 'running' | 'failed'; error?: string; container?: string };
  createdAt: Millis;
  updatedAt: Millis;
}

export interface Variant {
  id: ID;
  studyId: ID;
  /** e.g. "A — current checkout", "B — one-page checkout". */
  name: string;
  protocolId: ID;
  appId: ID | null;
  /** Relative allocation weight for automatic assignment. */
  weight: number;
  active: boolean;
  createdAt: Millis;
  /** Query string added to every app URL for this variant, e.g. "flags=summaryCard:1" (A/B conditions via URL flags). */
  appParams?: string;
}

export interface StudyLink {
  id: ID;
  studyId: ID;
  /** Public token used in /s/:token. */
  token: string;
  name: string;
  /** null = auto-assign across active variants (balanced by weight). */
  variantId: ID | null;
  maxParticipants: number | null;
  expiresAt: Millis | null;
  /** Where to send participants after completion (e.g. Prolific completion URL). */
  redirectUrl: string | null;
  active: boolean;
  createdAt: Millis;
}

// ── Sessions ─────────────────────────────────────────────────────────────────

export type SessionStatus = 'created' | 'consented' | 'in_progress' | 'completed' | 'abandoned' | 'withdrawn';

export interface ConsentRecord {
  version: string;
  acceptedAt: Millis;
  audio: boolean;
  screen: boolean;
  eyeTracking: boolean;
  ageConfirmed: boolean;
  /** Study consent form (see "Consent" below): the version and content hash the participant agreed to. */
  formVersion?: number;
  formHash?: string;
  /** How the participant signed (typed name or "I agree"). */
  signature?: ConsentSignature;
  /** Snapshot of the participant-info fields shown, so labels survive later edits. */
  fields?: ParticipantFieldSnapshot[];
}

export interface DeviceInfo {
  userAgent: string;
  viewportW: number;
  viewportH: number;
  screenW: number;
  screenH: number;
  dpr: number;
  timezone: string;
  language: string;
}

export interface Session {
  id: ID;
  studyId: ID;
  variantId: ID;
  linkId: ID;
  /** Short human readable code, e.g. "P-7K2Q". */
  participantCode: string;
  status: SessionStatus;
  consent: ConsentRecord | null;
  device: DeviceInfo | null;
  /** URL query params from the link (e.g. PROLIFIC_PID) — stored as-is. */
  urlParams: Record<string, string>;
  /** Resolved step order (after task randomization) — step ids. */
  stepOrder: ID[];
  startedAt: Millis | null;
  endedAt: Millis | null;
  createdAt: Millis;
  /** Session-level eye tracking calibration validation error in px (if used). */
  gazeErrorPx?: number | null;
  /** Researcher preview session (excluded from analytics by default). */
  preview?: boolean;
  /** Participant info collected at consent (field id → value). Deleted on withdrawal. */
  participantInfo?: ParticipantInfo | null;
}

export type TaskOutcome = 'success' | 'partial' | 'failure' | 'abandoned' | 'timeout';

export interface TaskResult {
  sessionId: ID;
  stepId: ID;
  outcome: TaskOutcome;
  /** How the outcome was determined. Researcher overrides win. */
  source: 'rule' | 'ai' | 'participant' | 'researcher';
  startedAt: Millis;
  endedAt: Millis;
  durationMs: number;
  evidence?: string;
  /** Derived from the outcome and the task.assist events (see completionScore). */
  completionScore?: CompletionScore;
  assistance?: AssistanceSummary;
}

export interface Answer {
  sessionId: ID;
  stepId: ID;
  questionId: ID;
  /** Free text (open answers, or the spoken justification). */
  text?: string;
  /** Numeric value for ratings / numbers / choice indexes. */
  value?: number;
  /** Selected option labels for choice questions. */
  choices?: string[];
  /** The participant did not know / was not sure / did not want to answer (their words are in `text`). */
  declined?: boolean;
  source: 'voice' | 'screen' | 'text';
  at: Millis;
  /** Standard instruments: the wording that was presented (language + source), see Question.wording. */
  wording?: string;
}

// ── Events ───────────────────────────────────────────────────────────────────
// Every observable thing in a session becomes an event in one timeline.
// `t` = ms since session start (session.startedAt). `at` = wall clock.

export type EventKind =
  // session lifecycle
  | 'session.start' | 'session.end' | 'session.withdraw' | 'session.error'
  // media: data { t } = session-clock time the recording started (audio files are aligned to this)
  | 'media.audio_start' | 'eyetracking.calibrated'
  // protocol
  | 'step.enter' | 'step.exit' | 'task.start' | 'task.end' | 'task.resume' | 'task.assist' | 'answer'
  // conversation
  | 'transcript.participant' | 'transcript.moderator' | 'moderator.tool' | 'moderator.probe' | 'moderator.nudge'
  | 'speech.start' | 'speech.stop'
  // app behaviour (from the probe inside the iframe)
  | 'app.ready' | 'app.navigate' | 'app.click' | 'app.dead_click' | 'app.rage_click' | 'app.input' | 'app.change'
  | 'app.scroll' | 'app.focus' | 'app.error' | 'app.console_error' | 'app.network_error' | 'app.custom' | 'app.visibility'
  | 'app.crash' // iframe stopped responding / white screen / fatal error
  // high-frequency streams (batched points)
  | 'mouse' | 'gaze'
  // researcher
  | 'note' | 'observation';

export interface SessionEvent<D = Record<string, unknown>> {
  sessionId?: ID;
  /** Monotonic per-session sequence number (client assigned). */
  seq?: number;
  kind: EventKind;
  /** ms since session start. */
  t: number;
  /** Wall clock ms. */
  at: Millis;
  stepId?: ID | null;
  data: D;
}

/** Common payloads ─ the probe/runner MUST use these field names. */
export interface ElementDescriptor {
  /** Short CSS-ish selector, e.g. "button#buy.primary" or "nav > a:nth-child(2)". */
  selector: string;
  tag: string;
  /** Visible text, trimmed to 120 chars (masked inside inputs). */
  text?: string;
  role?: string;
  ariaLabel?: string;
  href?: string;
  /** Whether the element is interactive (button, link, input, [role=button], onclick...). */
  interactive: boolean;
}

export interface ClickData {
  x: number; // viewport px inside the app
  y: number;
  /** Normalized to app document (scroll-adjusted) */
  pageX: number;
  pageY: number;
  vw: number; // app viewport width/height at the time
  vh: number;
  path: string; // app location pathname+search+hash
  el: ElementDescriptor;
}

/** Batched points: [t, x, y] tuples (t = ms since session start, x/y viewport px of the app). */
export interface PointBatchData {
  points: [number, number, number][];
  vw: number;
  vh: number;
  path: string;
  scrollX?: number;
  scrollY?: number;
}

export interface NavigateData {
  path: string;
  from?: string;
  title?: string;
  kind: 'load' | 'push' | 'replace' | 'pop' | 'hash';
}

export interface ErrorData {
  message: string;
  stack?: string;
  source?: string;
  line?: number;
  col?: number;
  path?: string;
}

export interface TranscriptData {
  text: string;
  /** For participant: audio item id from realtime. */
  itemId?: string;
  /** Start/end within session clock when known. */
  startT?: number;
  endT?: number;
}

// ── Probe <-> wrapper bridge (window.postMessage) ────────────────────────────
// The probe runs inside the tested app (iframe). Messages are tagged with
// source "thinkaloud-probe" (probe → parent) and "thinkaloud-host" (parent → probe).

export type ProbeToHost =
  | { source: 'thinkaloud-probe'; type: 'hello'; version: string; path: string; title: string }
  | { source: 'thinkaloud-probe'; type: 'events'; events: { kind: EventKind; at: Millis; data: Record<string, unknown> }[] }
  | { source: 'thinkaloud-probe'; type: 'rrweb'; events: unknown[] }
  | { source: 'thinkaloud-probe'; type: 'heartbeat'; at: Millis; path: string }
  | { source: 'thinkaloud-probe'; type: 'dom_query_result'; requestId: string; matched: boolean }
  | { source: 'thinkaloud-probe'; type: 'scroll_state'; scrollX: number; scrollY: number; vw: number; vh: number; docW: number; docH: number };

export type HostToProbe =
  | { source: 'thinkaloud-host'; type: 'config'; sessionId: ID; recordScreen: boolean; maskAllInputs: boolean; mouseSampleMs: number }
  | { source: 'thinkaloud-host'; type: 'navigate'; path: string }
  | { source: 'thinkaloud-host'; type: 'dom_query'; requestId: string; selector?: string; text?: string }
  | { source: 'thinkaloud-host'; type: 'pause' | 'resume' };

// ── Analytics ────────────────────────────────────────────────────────────────

export interface Interval {
  estimate: number;
  low: number;
  high: number;
  /** Confidence level, e.g. 0.9 or 0.95 */
  level: number;
}

export interface TaskMetrics {
  stepId: ID;
  title: string;
  n: number;
  successRate: Interval | null; // adjusted-Wald
  outcomes: Record<TaskOutcome, number>;
  /** Geometric mean of successful-task times (ms) with CI on log scale. */
  timeOnTaskMs: Interval | null;
  medianTimeMs: number | null;
  seq: Interval | null;
  avgClicks: number | null;
  avgMisclicks: number | null; // dead clicks
  rageClicks: number;
  errors: number;
  lostness: number | null;
}

export interface VariantMetrics {
  variantId: ID;
  name: string;
  sessions: number;
  completed: number;
  completionRate: number;
  medianSessionMs: number | null;
  sus: Interval | null;
  umuxLite: Interval | null;
  nps: { score: number; promoters: number; passives: number; detractors: number; n: number } | null;
  tlx: Interval | null;
  tasks: TaskMetrics[];
}

export interface ComparisonResult {
  metric: string;
  stepId?: ID;
  a: { variantId: ID; value: number | null; n: number };
  b: { variantId: ID; value: number | null; n: number };
  test: 'n-1 chi-square' | 'fisher exact' | 'welch t (log)' | 'welch t' | 'mann-whitney';
  pValue: number | null;
  effect?: number | null;
  significant: boolean;
  note?: string;
}

export interface StudyAnalytics {
  studyId: ID;
  generatedAt: Millis;
  totals: { sessions: number; completed: number; inProgress: number; abandoned: number; avgDurationMs: number | null };
  variants: VariantMetrics[];
  comparisons: ComparisonResult[];
  confidenceLevel: number;
}

export interface Insight {
  id: ID;
  title: string;
  /** Markdown. */
  body: string;
  severity: 'critical' | 'major' | 'minor' | 'positive' | 'info';
  /** Evidence — every insight must cite. */
  evidence: { sessionId: ID; participantCode: string; t: number; quote?: string; eventKind?: EventKind }[];
  stepId?: ID | null;
  variantId?: ID | null;
  tags: string[];
}

export interface Synthesis {
  id: ID;
  studyId: ID;
  createdAt: Millis;
  model: string;
  summary: string; // markdown executive summary
  insights: Insight[];
  sessionCount: number;
}

// ── Participant API payloads ─────────────────────────────────────────────────

export interface PublicLinkInfo {
  token: string;
  studyName: string;
  /** From the protocol of the variant (or first variant if auto-assigned). */
  title: string;
  estimatedMinutes: number;
  consent: ConsentSettings;
  language: string;
  /** The study's consent form, when the researcher has turned it on (replaces `consent.text`). */
  consentForm?: PublicConsentForm | null;
  available: boolean;
  /** 'unavailable' is deliberately vague (e.g. the owner's plan lapsed): participants never see billing details. */
  unavailableReason?: 'closed' | 'paused' | 'full' | 'expired' | 'draft' | 'inactive' | 'unavailable';
}

export interface StartSessionRequest {
  urlParams: Record<string, string>;
  device: DeviceInfo;
  consent: ConsentRecord;
  /** Values for the consent form's participant-info fields (validated server-side). */
  participantInfo?: ParticipantInfo;
  /** Preview mode for researchers — sessions flagged and excluded from analytics by default. */
  preview?: boolean;
  /** Force a variant (honoured only when the caller is the signed-in study owner, for previews). */
  variantId?: ID;
}

export interface StartSessionResponse {
  session: Session;
  /** Secret the participant client sends as `X-Session-Secret` on every call. */
  secret: string;
  variant: Pick<Variant, 'id' | 'name'>;
  protocol: Protocol;
  /** Steps in the resolved order (randomization applied). */
  steps: Step[];
  /** URL to load in the iframe (hosted build on the app-host origin, or the external URL). null = no app. */
  appUrl: string | null;
  appInstrumented: boolean;
  redirectUrl: string | null;
}

export interface RealtimeTokenResponse {
  /** Ephemeral client secret value (ek_...). */
  value: string;
  expiresAt: number;
  model: string;
  voice: string;
  /** Input transcription settings (re-sent with every client turn-detection update). */
  transcription?: { model: string; language: string; prompt?: string };
  /** Where the browser posts its SDP offer (OpenAI or a self-hosted OpenRealtime server). */
  callsUrl?: string;
  /** ICE servers for the RTCPeerConnection (self-hosted realtime servers behind NAT). */
  iceServers?: { urls: string | string[]; username?: string; credential?: string }[];
  /** WebSocket endpoint of a self-hosted realtime server (fallback when WebRTC media can't connect). */
  wsUrl?: string;
  /** Self-hosted only: 'websocket' = skip WebRTC; 'webrtc' = never fall back; 'auto' = WebRTC, WS fallback. */
  transport?: 'webrtc' | 'websocket' | 'auto';
}

// ═════════════════════════════════════════════════════════════════════════════
// Billing (SaaS mode only: enabled when the server has STRIPE_SECRET_KEY)
// ═════════════════════════════════════════════════════════════════════════════

/** Mirrors Stripe subscription statuses we act on ('none' = never subscribed). */
export type BillingStatus = 'none' | 'trialing' | 'active' | 'past_due' | 'canceled' | 'incomplete' | 'unpaid' | 'paused';

/** A plan as shown publicly (pricing page). Amounts are in the smallest currency unit (cents). */
export interface BillingPlan {
  id: string;
  name: string;
  description: string;
  currency: string;
  monthlyPriceCents: number;
  /** Voice minutes included every billing period. */
  includedMinutes: number;
  /** Price per extra voice minute, in cents (may be fractional, e.g. 12.5). */
  overageCentsPerMinute: number;
  /** Free trial length in days (0 = no trial). */
  trialDays: number;
  /** Voice minutes available during the trial (null = only limited by days). */
  trialMinutes: number | null;
  features: string[];
}

export interface BillingPlansResponse {
  enabled: boolean;
  plans: BillingPlan[];
}

/** Why a researcher can't run real participant sessions right now (null = they can). */
export type BillingBlockReason = 'no_subscription' | 'canceled' | 'incomplete' | 'payment_failed' | 'trial_minutes_used' | 'spend_cap' | null;

export interface BillingUsage {
  periodStart: number;
  periodEnd: number | null;
  minutesUsed: number;
  includedMinutes: number;
  overageMinutes: number;
  estimatedOverageCents: number;
  /** Plan price + overage for this period (0 during a trial). */
  estimatedTotalCents: number;
  /** During a trial: minutes used against the trial allowance. */
  trialMinutesUsed: number | null;
  trialMinutes: number | null;
  /** Ended sessions counted this period. */
  sessionCount: number;
}

export interface BillingOverview {
  enabled: boolean;
  plan: BillingPlan | null;
  status: BillingStatus;
  hasCustomer: boolean;
  currentPeriodEnd: number | null;
  trialEnd: number | null;
  cancelAtPeriodEnd: boolean;
  /** When status is past_due: sessions keep working until this time. */
  graceEndsAt: number | null;
  spendCapCents: number | null;
  /** Whether a new checkout would include the free trial. */
  trialAvailable: boolean;
  usage: BillingUsage | null;
  canRunSessions: boolean;
  blockReason: BillingBlockReason;
}

// ── Consent ──────────────────────────────────────────────────────────────────
// A study-level consent form (studies.consent_form): the participant-facing document,
// participant-info fields collected at consent, signature mode and the last check result.
// Capture opt-ins (audio, screen, eye tracking, 18+) stay in each protocol's ConsentSettings.

export type ParticipantFieldKind = 'short_text' | 'long_text' | 'number' | 'single_select' | 'multi_select' | 'date' | 'yes_no' | 'likert';
export type BuiltinFieldId = 'full_name' | 'age' | 'sex' | 'gender' | 'email' | 'country' | 'occupation';

export interface ParticipantField {
  /** Built-in id, or "cf_…" for custom fields. Used as the key in ParticipantInfo. */
  id: string;
  builtin?: BuiltinFieldId;
  kind: ParticipantFieldKind;
  label: string;
  help?: string;
  required: boolean;
  /** Personally identifying: dropped from "exclude PII" exports. */
  pii: boolean;
  /** Built-ins can be switched off; custom fields are always on. */
  enabled: boolean;
  /** single_select / multi_select options. */
  options?: string[];
  /** Offer a free-text "self-describe" choice (stored as the typed text). */
  allowOther?: boolean;
  otherLabel?: string;
  /** number: inclusive bounds. */
  min?: number;
  max?: number;
  /** likert: number of points and end labels. */
  likert?: { points: 5 | 7; minLabel: string; maxLabel: string };
  /** Built-in age only: ask for age in years or for the date of birth. */
  ageFormat?: 'years' | 'date_of_birth';
}

export type ParticipantFieldSnapshot = Pick<ParticipantField, 'id' | 'label' | 'kind' | 'pii'>;
export type ParticipantValue = string | number | boolean | string[];
export type ParticipantInfo = Record<string, ParticipantValue>;

export type SignatureMode = 'checkbox' | 'typed_name';
export interface ConsentSignature {
  mode: SignatureMode;
  /** Typed full name (typed_name mode). PII: removed on withdrawal and from "exclude PII" exports. */
  name?: string;
  /** YYYY-MM-DD as shown to the participant. */
  date?: string;
  agreed: true;
}

export interface ConsentDocument {
  id: ID;
  studyId: ID;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  createdAt: Millis;
}

/** Required elements of informed consent checked by the consent lint. */
export type ConsentElementId =
  | 'purpose' | 'procedures' | 'recording' | 'duration' | 'risks' | 'benefits' | 'compensation' | 'confidentiality'
  | 'storage' | 'access' | 'voluntary' | 'withdrawal' | 'ai_disclosure' | 'contact' | 'ethics_contact' | 'age';

export type ConsentSeverity = 'high' | 'medium' | 'low';
export interface ConsentIssue {
  /** Stable key, e.g. "missing:risks", "capture:eye_tracking", "long_sentence:3". */
  key: string;
  source: 'lint' | 'ai';
  category: 'missing' | 'consistency' | 'readability' | 'language' | 'other';
  element?: ConsentElementId;
  severity: ConsentSeverity;
  message: string;
  explanation?: string;
  /** Offending text, verbatim from the document. */
  quote?: string;
  /** Suggested rewrite (or text to add). */
  suggestion?: string;
}

export interface ConsentReadability {
  /** Flesch-Kincaid grade level (aim for 8 or lower). */
  grade: number;
  /** Flesch reading ease 0-100 (higher = easier). */
  ease: number;
  words: number;
  sentences: number;
  avgSentenceWords: number;
  /** Estimated reading time in minutes (~200 wpm). */
  minutes: number;
}

export interface ConsentElementStatus {
  id: ConsentElementId;
  label: string;
  status: 'ok' | 'missing' | 'inconsistent';
}

/** What the study actually collects (union across its protocols and the form's fields). */
export interface ConsentCapture {
  voice: boolean;
  storeAudio: boolean;
  screen: boolean;
  eyeTracking: boolean;
  ageGate: boolean;
  minAge: number;
  fields: ParticipantFieldSnapshot[];
}

export interface ConsentCheckResult {
  checkedAt: Millis;
  version: number;
  hash: string;
  readability: ConsentReadability;
  elements: ConsentElementStatus[];
  issues: ConsentIssue[];
  /** ok = AI review ran; skipped = no API key; failed = the AI call failed (lint is still complete). */
  ai: 'ok' | 'skipped' | 'failed';
  aiError?: string;
}

export interface ConsentVersion {
  version: number;
  hash: string;
  savedAt: Millis;
  text: string;
}

export interface ConsentForm {
  /** Use this form instead of the protocol consent text. */
  enabled: boolean;
  title: string;
  /** Participant-facing document, Markdown. */
  text: string;
  /** Uploaded original (downloadable by participants). */
  documentId: ID | null;
  /** Bumped every time the participant-facing content (hash) changes. */
  version: number;
  /** sha256 of the participant-facing content (title, text, fields, signature, age). */
  hash: string;
  updatedAt: Millis;
  fields: ParticipantField[];
  signature: { mode: SignatureMode; agreeLabel: string };
  /** Minimum age; enforced from the age field when collected, else by an "I am N or older" confirmation. */
  minAge: number;
  /** Participants must scroll to the end of the document before agreeing. */
  requireScroll: boolean;
  lastCheck?: ConsentCheckResult | null;
  /** Previous versions (newest first, capped), for audit. */
  history?: ConsentVersion[];
}

/** What participants receive (no check results or history). */
export interface PublicConsentForm {
  title: string;
  text: string;
  version: number;
  hash: string;
  fields: ParticipantField[];
  signature: ConsentForm['signature'];
  minAge: number;
  requireScroll: boolean;
  document: { filename: string; size: number; url: string } | null;
}

/** GET /api/studies/:id/consent */
export interface ConsentFormResponse {
  form: ConsentForm;
  document: ConsentDocument | null;
  capture: ConsentCapture;
}

export interface DemographicsBreakdown {
  fieldId: string;
  label: string;
  kind: ParticipantFieldKind;
  n: number;
  /** Category counts (selects, yes/no, Likert, age bins). */
  counts: { label: string; n: number }[];
  /** Numeric summary (number fields, age). */
  stats?: { mean: number; median: number; min: number; max: number; sd: number } | null;
}

export interface DemographicsResponse {
  sessions: number;
  withInfo: number;
  breakdowns: DemographicsBreakdown[];
}
