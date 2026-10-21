// Client-side mirrors of the analytics API (superset of the shared contract; see server/src/analytics/*).
import type {
  Answer,
  ComparisonResult,
  EventKind,
  Insight,
  InstrumentId,
  Interval,
  Protocol,
  Session,
  SessionEvent,
  StudyAnalytics,
  Step,
  Synthesis,
  TaskMetrics,
  TaskOutcome,
  TaskResult,
  VariantMetrics,
} from '@thinkaloud/shared';

export interface TaskMetricsX extends TaskMetrics {
  successes: number;
  partials: number;
  timeAllMs: Interval | null;
  successTimesMs: number[];
  attempts: { sessionId: string; ms: number; outcome: TaskOutcome }[];
  seqValues: number[];
  medianFirstClickMs: number | null;
  avgBacktracks: number | null;
  lostnessN: number;
  lostShare: number | null;
  optimalPathLength: number | null;
  rageSessions: number;
}

export interface VariantMetricsX extends VariantMetrics {
  tasks: TaskMetricsX[];
  inProgress: number;
  abandoned: number;
  completionCI: Interval | null;
  sessionDurationsMs: number[];
  susScores: number[];
  umuxSusEquivalent: Interval | null;
  seqOverall: Interval | null;
  instrumentN: Partial<Record<InstrumentId, number>>;
}

export interface ComparisonX extends ComparisonResult {
  label: string;
  kind: 'proportion' | 'time' | 'score';
  betterWhen: 'higher' | 'lower';
  effectKind: 'difference' | 'ratio' | 'hedges g';
  hedgesG?: number | null;
  effectLabel?: string | null;
  ci?: [number, number] | null;
  alt?: { test: ComparisonResult['test']; pValue: number | null } | null;
  pHolm?: number | null;
  underpowered: boolean;
  requiredN?: number | null;
  winner: 'a' | 'b' | null;
  interpretation: string;
  aName: string;
  bName: string;
}

export interface StudyAnalyticsX extends StudyAnalytics {
  variants: VariantMetricsX[];
  comparisons: ComparisonX[];
  alpha: number;
  includePreview: boolean;
  totals: StudyAnalytics['totals'] & { stale: number; withdrawn: number; preview: number };
  tasks: { stepId: string; title: string }[];
  instruments: InstrumentId[];
  notes: string[];
}

export interface SessionRow extends Session {
  preview: boolean;
  effectiveStatus: Session['status'];
  stale: boolean;
  lastActivityAt: number;
  variantName: string;
  durationMs: number | null;
  tasksSucceeded: number;
  tasksTotal: number;
  tasksAttempted: number;
  outcomes: TaskOutcome[];
  sus: number | null;
  umuxLite: number | null;
  nps: number | null;
  tlx: number | null;
  rageClicks: number;
  deadClicks: number;
  errors: number;
  utterances: number;
  hasReplay: boolean;
  hasAudio: boolean;
}

export interface Note {
  id: string;
  sessionId: string;
  authorId: string | null;
  authorName?: string | null;
  t: number;
  text: string;
  tags: string[];
  createdAt: number;
}

export interface SessionDetail {
  session: Session & { preview?: boolean };
  effectiveStatus: Session['status'];
  variantName: string | null;
  steps: Step[];
  protocol: Protocol | null;
  events: SessionEvent[];
  taskResults: TaskResult[];
  answers: Answer[];
  scores: { SUS?: number; UMUX_LITE?: number; NASA_TLX?: number; NPS?: number };
  durationMs: number | null;
  notes: Note[];
  hasReplay: boolean;
  audioTracks: string[];
  pointBatches: { mouse: number; gaze: number };
  prevSessionId: string | null;
  nextSessionId: string | null;
}

export interface FlatPoint {
  t: number;
  x: number;
  y: number;
  vw: number;
  vh: number;
  path: string;
  stepId: string | null;
}

export interface HeatPoint {
  nx: number;
  ny: number;
  px: number;
  py: number;
  sessionId: string;
  t: number;
  dead?: boolean;
  rage?: boolean;
}

export interface HeatmapData {
  kind: 'click' | 'gaze' | 'mouse';
  stepId: string | null;
  path: string | null;
  paths: { path: string; count: number }[];
  viewport: { w: number; h: number };
  points: HeatPoint[];
  sessions: number;
  snapshot: { sessionId: string; t: number; path: string; timestamp: number } | null;
  firstClicks: {
    sessionId: string;
    participantCode: string;
    variantId: string;
    nx: number;
    ny: number;
    ms: number | null;
    target: string;
    selector: string;
    path: string;
    outcome: string | null;
    onTarget: boolean | null;
  }[];
  firstClickTargets: { target: string; selector: string; count: number; successes: number; withOutcome: number; onTarget: boolean | null }[];
  tasks: { stepId: string; title: string }[];
  variants: { id: string; name: string }[];
}

export interface EvidenceX {
  sessionId: string;
  participantCode: string;
  t: number;
  quote?: string;
  eventKind?: EventKind;
  verifiedBy?: 'quote' | 'event';
  matchScore?: number;
  timeCorrected?: boolean;
  speaker?: 'participant' | 'moderator';
}

export interface InsightX extends Insight {
  evidence: EvidenceX[];
  droppedEvidence?: number;
  recommendation?: string;
}

export interface SynthesisX extends Synthesis {
  insights: InsightX[];
  verification: {
    insightsProposed: number;
    insightsKept: number;
    evidenceProposed: number;
    evidenceVerified: number;
    evidenceDropped: number;
    timestampsCorrected: number;
  };
  generatedBy?: 'ai' | 'seed';
}
