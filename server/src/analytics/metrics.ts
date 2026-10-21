// Computes StudyAnalytics (per variant, per task, A/B comparisons) from the database.
// Statistical choices follow Sauro & Lewis (see docs/RESEARCH.md §3 and stats.ts).
import type {
  Answer,
  ComparisonResult,
  InstrumentId,
  Interval,
  SessionEvent,
  StudyAnalytics,
  TaskMetrics,
  TaskOutcome,
  TaskResult,
  TaskStep,
  Variant,
  VariantMetrics,
} from '@thinkaloud/shared';
import { INSTRUMENTS } from '@thinkaloud/shared';
import * as S from './stats.ts';
import { loadAnswers, loadMetricEvents, loadProtocols, loadSessions, loadTaskResults, loadVariants, type LoadedSession } from './data.ts';

// ── Extended shapes (superset of the shared contract; extra fields are additive) ─

export interface TaskMetricsX extends TaskMetrics {
  successes: number;
  /** Partial outcomes are reported but count as non-success in the binary success rate. */
  partials: number;
  /** Geometric mean of all attempt times (any outcome). */
  timeAllMs: Interval | null;
  /** Successful attempt durations (ms) — for distribution charts. */
  successTimesMs: number[];
  /** All attempts (ms + outcome). */
  attempts: { sessionId: string; ms: number; outcome: TaskOutcome }[];
  seqValues: number[];
  /** Median time from task start to first click (ms). */
  medianFirstClickMs: number | null;
  /** Mean number of revisits to already-seen pages per attempt. */
  avgBacktracks: number | null;
  /** Number of attempts lostness is based on. */
  lostnessN: number;
  /** Share of attempts with lostness > 0.5. */
  lostShare: number | null;
  optimalPathLength: number | null;
  /** Attempts that had any rage click. */
  rageSessions: number;
}

export interface VariantMetricsX extends VariantMetrics {
  tasks: TaskMetricsX[];
  inProgress: number;
  abandoned: number;
  /** Adjusted-Wald CI on completed / (completed + abandoned). */
  completionCI: Interval | null;
  sessionDurationsMs: number[];
  susScores: number[];
  /** UMUX-Lite → SUS equivalent (0.65 × score + 22.9; Lewis et al. 2013). */
  umuxSusEquivalent: Interval | null;
  seqOverall: Interval | null;
  instrumentN: Partial<Record<InstrumentId, number>>;
}

export interface ComparisonX extends ComparisonResult {
  label: string;
  kind: 'proportion' | 'time' | 'score';
  betterWhen: 'higher' | 'lower';
  /** proportion → difference B−A; time → ratio of geometric means B/A; score → difference of means B−A */
  effectKind: 'difference' | 'ratio' | 'hedges g';
  /** Standardized effect (Hedges g on the analysed scale) when applicable. */
  hedgesG?: number | null;
  effectLabel?: string | null;
  /** CI for the difference (proportion/score) or ratio (time), at the requested confidence level. */
  ci?: [number, number] | null;
  /** Secondary test (Fisher exact for proportions, Mann-Whitney for ordinal SEQ). */
  alt?: { test: ComparisonResult['test']; pValue: number | null } | null;
  /** Holm-Bonferroni adjusted p across all comparisons of this study. */
  pHolm?: number | null;
  underpowered: boolean;
  /** Approximate n per group for 80% power at the observed effect. */
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
  /** All task steps seen across variants (union, ordered). */
  tasks: { stepId: string; title: string }[];
  instruments: InstrumentId[];
  notes: string[];
}

export interface SessionScores {
  SUS?: number;
  UMUX_LITE?: number;
  NASA_TLX?: number;
  NPS?: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const OUTCOMES: TaskOutcome[] = ['success', 'partial', 'failure', 'abandoned', 'timeout'];
const ERROR_KINDS = new Set(['app.error', 'app.console_error', 'app.network_error', 'app.crash']);
const SESSION_INSTRUMENTS: InstrumentId[] = ['SUS', 'UMUX_LITE', 'NASA_TLX', 'NPS'];

const normPath = (p: unknown) => {
  const s = String(p ?? '').split('#')[0] || '/';
  return s.length > 1 ? s.replace(/\/+$/, '') : s;
};

/** Instrument scores for one session, from its answers (answers keyed by question ids like sus_1..). */
export function scoreSession(answers: Answer[]): SessionScores {
  const byStep = new Map<string, Record<string, number>>();
  for (const a of answers) {
    if (typeof a.value !== 'number') continue;
    let rec = byStep.get(a.stepId);
    if (!rec) byStep.set(a.stepId, (rec = {}));
    rec[a.questionId] = a.value;
  }
  const out: SessionScores = {};
  for (const rec of byStep.values()) {
    for (const id of SESSION_INSTRUMENTS) {
      if (out[id as keyof SessionScores] != null) continue;
      const v = INSTRUMENTS[id].score(rec);
      if (v != null) out[id as keyof SessionScores] = v;
    }
  }
  return out;
}

export function sessionDurationMs(s: LoadedSession): number | null {
  const { startedAt, endedAt } = s.session;
  if (startedAt == null) return null;
  const end = endedAt ?? (s.effectiveStatus === 'abandoned' ? s.lastActivityAt : null);
  return end != null && end >= startedAt ? end - startedAt : null;
}

interface TaskBehaviour {
  clicks: number;
  dead: number;
  rage: number;
  errors: number;
  firstClickMs: number | null;
  lostness: number | null;
  backtracks: number;
  hasApp: boolean;
}

/** Behaviour metrics for one task attempt, derived from the session's event stream. */
export function taskBehaviour(events: SessionEvent[], stepId: string, optimal: number | null): TaskBehaviour {
  const hasApp = events.some((e) => e.kind.startsWith('app.'));
  const inTask = events.filter((e) => e.stepId === stepId);
  const startEv = inTask.find((e) => e.kind === 'task.start') ?? inTask[0];
  const startT = startEv?.t ?? null;
  let clicks = 0;
  let dead = 0;
  let rage = 0;
  let errors = 0;
  let firstClickMs: number | null = null;
  for (const e of inTask) {
    if (e.kind === 'app.click') {
      clicks++;
      if (firstClickMs == null && startT != null) firstClickMs = Math.max(0, e.t - startT);
    } else if (e.kind === 'app.dead_click') dead++;
    else if (e.kind === 'app.rage_click') rage++;
    else if (ERROR_KINDS.has(e.kind)) errors++;
  }
  // Page sequence: the page the participant was on when the task began + navigations during the task.
  const navs = events.filter((e) => e.kind === 'app.navigate');
  const taskNavs = navs.filter((e) => e.stepId === stepId);
  const prior = startT == null ? undefined : [...navs].reverse().find((e) => e.t <= startT && e.stepId !== stepId);
  const seq: string[] = [];
  // A navigation right at task start is the task's startPath load: the previous page was not part of the task.
  const startLoad = taskNavs.length && startT != null && taskNavs[0].t - startT <= 3000;
  if (prior && !startLoad) seq.push(normPath(prior.data.path));
  for (const n of taskNavs) {
    const p = normPath(n.data.path);
    if (seq[seq.length - 1] !== p) seq.push(p); // reload of the same page is not a new visit
  }
  let backtracks = 0;
  const seen = new Set<string>();
  for (const p of seq) {
    if (seen.has(p)) backtracks++;
    seen.add(p);
  }
  const lost = optimal && seq.length ? S.lostness(seq.length, seen.size, optimal) : null;
  return { clicks, dead, rage, errors, firstClickMs, lostness: lost, backtracks, hasApp };
}

function round(v: number | null | undefined, d = 4) {
  if (v == null || !isFinite(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

// ── Per task ────────────────────────────────────────────────────────────────

function taskMetrics(
  step: { stepId: string; title: string; optimal: number | null },
  sessions: LoadedSession[],
  results: Map<string, TaskResult[]>,
  answers: Map<string, Answer[]>,
  events: Map<string, SessionEvent[]>,
  level: number,
): TaskMetricsX {
  const outcomes = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<TaskOutcome, number>;
  const attempts: TaskMetricsX['attempts'] = [];
  const succ: number[] = [];
  const seq: number[] = [];
  const clicks: number[] = [];
  const dead: number[] = [];
  const firstClicks: number[] = [];
  const lost: number[] = [];
  const backtracks: number[] = [];
  let rage = 0;
  let rageSessions = 0;
  let errors = 0;
  for (const s of sessions) {
    const r = results.get(s.session.id)?.find((x) => x.stepId === step.stepId);
    const seqA = answers.get(s.session.id)?.find((a) => a.stepId === step.stepId && a.questionId === 'seq' && typeof a.value === 'number');
    if (seqA) seq.push(seqA.value!);
    if (!r) continue;
    outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
    attempts.push({ sessionId: s.session.id, ms: r.durationMs, outcome: r.outcome });
    if (r.outcome === 'success' && r.durationMs > 0) succ.push(r.durationMs);
    const evs = events.get(s.session.id) ?? [];
    const b = taskBehaviour(evs, step.stepId, step.optimal);
    if (b.hasApp) {
      clicks.push(b.clicks);
      dead.push(b.dead);
      if (b.firstClickMs != null) firstClicks.push(b.firstClickMs);
      backtracks.push(b.backtracks);
      if (b.lostness != null) lost.push(b.lostness);
    }
    rage += b.rage;
    if (b.rage > 0) rageSessions++;
    errors += b.errors;
  }
  const n = attempts.length;
  return {
    stepId: step.stepId,
    title: step.title,
    n,
    successes: outcomes.success,
    partials: outcomes.partial,
    successRate: S.adjustedWald(outcomes.success, n, level),
    outcomes,
    timeOnTaskMs: S.geometricMeanCI(succ, level),
    medianTimeMs: succ.length ? S.median(succ) : null,
    timeAllMs: S.geometricMeanCI(attempts.map((a) => a.ms), level),
    successTimesMs: succ,
    attempts,
    seq: S.meanCI(seq, level, [1, 7]),
    seqValues: seq,
    avgClicks: clicks.length ? round(S.mean(clicks), 2) : null,
    avgMisclicks: dead.length ? round(S.mean(dead), 2) : null,
    rageClicks: rage,
    rageSessions,
    errors,
    lostness: lost.length ? round(S.mean(lost), 3) : null,
    lostnessN: lost.length,
    lostShare: lost.length ? lost.filter((l) => l > 0.5).length / lost.length : null,
    optimalPathLength: step.optimal,
    medianFirstClickMs: firstClicks.length ? S.median(firstClicks) : null,
    avgBacktracks: backtracks.length ? round(S.mean(backtracks), 2) : null,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

export interface AnalyticsOptions {
  includePreview?: boolean;
  level?: number;
}

export function computeAnalytics(studyId: string, opts: AnalyticsOptions = {}): StudyAnalyticsX {
  const level = opts.level && opts.level > 0.5 && opts.level < 1 ? opts.level : 0.9;
  const alpha = 1 - level;
  const includePreview = Boolean(opts.includePreview);
  const variants = loadVariants(studyId);
  const protocols = loadProtocols(studyId);
  const everything = loadSessions(studyId, { includePreview: true, includeWithdrawn: true });
  const sessions = everything.filter((s) => (includePreview || !s.preview) && s.session.status !== 'withdrawn');
  const results = loadTaskResults(studyId);
  const answers = loadAnswers(studyId);
  const events = loadMetricEvents(studyId);
  const scores = new Map(sessions.map((s) => [s.session.id, scoreSession(answers.get(s.session.id) ?? [])]));

  // Union of task steps (protocol order first, then any seen only in session snapshots).
  const taskIndex = new Map<string, { stepId: string; title: string; optimal: number | null }>();
  const addTask = (t: TaskStep) => {
    if (!taskIndex.has(t.id)) taskIndex.set(t.id, { stepId: t.id, title: t.title, optimal: t.optimalPathLength ?? null });
  };
  const variantTasks = new Map<string, string[]>();
  // Per-variant task definitions (optimal path length can differ between designs).
  const variantDefs = new Map<string, Map<string, { stepId: string; title: string; optimal: number | null }>>();
  for (const v of variants) {
    const p = protocols.get(v.protocolId);
    const ids: string[] = [];
    const defs = new Map<string, { stepId: string; title: string; optimal: number | null }>();
    for (const st of p?.steps ?? [])
      if (st.type === 'task') {
        addTask(st);
        ids.push(st.id);
        defs.set(st.id, { stepId: st.id, title: st.title, optimal: st.optimalPathLength ?? null });
      }
    variantTasks.set(v.id, ids);
    variantDefs.set(v.id, defs);
  }
  for (const s of sessions) {
    for (const st of s.steps) if (st.type === 'task') addTask(st);
    const ids = variantTasks.get(s.session.variantId);
    for (const r of results.get(s.session.id) ?? []) if (ids && !ids.includes(r.stepId) && taskIndex.has(r.stepId)) ids.push(r.stepId);
  }

  const instrumentsSeen = new Set<InstrumentId>();
  const vm: VariantMetricsX[] = variants.map((v) => variantMetrics(v));

  function variantMetrics(v: Variant): VariantMetricsX {
    const vs = sessions.filter((s) => s.session.variantId === v.id);
    const completed = vs.filter((s) => s.effectiveStatus === 'completed');
    const abandoned = vs.filter((s) => s.effectiveStatus === 'abandoned');
    const inProgress = vs.length - completed.length - abandoned.length;
    const finished = completed.length + abandoned.length;
    const durations = completed.map(sessionDurationMs).filter((d): d is number => d != null);
    const sc = vs.map((s) => scores.get(s.session.id)!);
    const pick = (id: keyof SessionScores) => sc.map((x) => x[id]).filter((x): x is number => typeof x === 'number');
    const sus = pick('SUS');
    const umux = pick('UMUX_LITE');
    const tlx = pick('NASA_TLX');
    const npsR = pick('NPS');
    if (sus.length) instrumentsSeen.add('SUS');
    if (umux.length) instrumentsSeen.add('UMUX_LITE');
    if (tlx.length) instrumentsSeen.add('NASA_TLX');
    if (npsR.length) instrumentsSeen.add('NPS');
    const umuxCI = S.meanCI(umux, level, [0, 100]);
    const tasks = (variantTasks.get(v.id) ?? []).map((id) => taskMetrics(variantDefs.get(v.id)?.get(id) ?? taskIndex.get(id)!, vs, results, answers, events, level));
    const seqAll = tasks.flatMap((t) => t.seqValues);
    if (seqAll.length) instrumentsSeen.add('SEQ');
    return {
      variantId: v.id,
      name: v.name,
      sessions: vs.length,
      completed: completed.length,
      inProgress,
      abandoned: abandoned.length,
      completionRate: finished ? completed.length / finished : 0,
      completionCI: S.adjustedWald(completed.length, finished, level),
      medianSessionMs: durations.length ? S.median(durations) : null,
      sessionDurationsMs: durations,
      sus: S.meanCI(sus, level, [0, 100]),
      susScores: sus,
      umuxLite: umuxCI,
      umuxSusEquivalent: umuxCI
        ? { estimate: 0.65 * umuxCI.estimate + 22.9, low: 0.65 * umuxCI.low + 22.9, high: 0.65 * umuxCI.high + 22.9, level }
        : null,
      nps: S.nps(npsR),
      tlx: S.meanCI(tlx, level, [0, 100]),
      seqOverall: S.meanCI(seqAll, level, [1, 7]),
      instrumentN: { SUS: sus.length, UMUX_LITE: umux.length, NASA_TLX: tlx.length, NPS: npsR.length, SEQ: seqAll.length },
      tasks,
    };
  }

  // Comparisons: two variants → A vs B; more → each vs the first (control).
  const withData = vm.filter((v) => v.sessions > 0);
  const pairs: [VariantMetricsX, VariantMetricsX][] = withData.length >= 2 ? withData.slice(1).map((b) => [withData[0], b]) : [];
  const comparisons: ComparisonX[] = [];
  for (const [a, b] of pairs) comparisons.push(...compareVariants(a, b, level, sessions, scores));
  holm(comparisons);

  const all = sessions;
  const completedAll = all.filter((s) => s.effectiveStatus === 'completed');
  const durAll = completedAll.map(sessionDurationMs).filter((d): d is number => d != null);
  const notes: string[] = [];
  const stale = all.filter((s) => s.stale).length;
  if (stale) notes.push(`${stale} in-progress session${stale > 1 ? 's' : ''} with no activity for 15+ minutes counted as abandoned.`);
  if (comparisons.length > 3)
    notes.push(`${comparisons.length} comparisons were run; with many tests some "significant" results are expected by chance. Holm-adjusted p-values are shown for reference.`);

  return {
    studyId,
    generatedAt: Date.now(),
    confidenceLevel: level,
    alpha,
    includePreview,
    totals: {
      sessions: all.length,
      completed: completedAll.length,
      inProgress: all.filter((s) => ['created', 'consented', 'in_progress'].includes(s.effectiveStatus)).length,
      abandoned: all.filter((s) => s.effectiveStatus === 'abandoned').length,
      avgDurationMs: durAll.length ? S.mean(durAll) : null,
      stale,
      withdrawn: everything.filter((s) => s.session.status === 'withdrawn' && (includePreview || !s.preview)).length,
      preview: everything.filter((s) => s.preview).length,
    },
    variants: vm,
    comparisons,
    tasks: [...taskIndex.values()].map(({ stepId, title }) => ({ stepId, title })),
    instruments: [...instrumentsSeen],
    notes,
  };
}

// ── Comparisons ─────────────────────────────────────────────────────────────

const pct = (v: number) => `${Math.round(v * 100)}%`;
const fmtP = (p: number | null) => (p == null ? 'n/a' : p < 0.001 ? 'p < .001' : `p = ${p.toFixed(3).replace(/^0/, '')}`);
const secs = (ms: number) => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 1000).toFixed(1)} s`);
const MIN_N = 3;

function verdict(sig: boolean, p: number | null, alpha: number, lvl: number) {
  if (p == null) return '';
  return sig
    ? `Statistically significant at the ${Math.round(lvl * 100)}% level (${fmtP(p)}).`
    : `Not statistically significant at the ${Math.round(lvl * 100)}% level (${fmtP(p)}, α = ${alpha.toFixed(2)}) — this does not show the variants are equivalent.`;
}

function compareProportion(
  label: string,
  metric: string,
  stepId: string | undefined,
  a: VariantMetricsX,
  b: VariantMetricsX,
  xA: number,
  nA: number,
  xB: number,
  nB: number,
  level: number,
): ComparisonX {
  const alpha = 1 - level;
  const base = {
    label,
    metric,
    stepId,
    kind: 'proportion' as const,
    betterWhen: 'higher' as const,
    effectKind: 'difference' as const,
    aName: a.name,
    bName: b.name,
    a: { variantId: a.variantId, value: nA ? xA / nA : null, n: nA },
    b: { variantId: b.variantId, value: nB ? xB / nB : null, n: nB },
  };
  if (nA < MIN_N || nB < MIN_N) {
    return {
      ...base,
      test: 'n-1 chi-square',
      pValue: null,
      significant: false,
      underpowered: true,
      winner: null,
      note: `Too few observations to test (n = ${nA} vs ${nB}; need ≥ ${MIN_N} per variant).`,
      interpretation: `Not enough data yet: ${a.name} ${xA}/${nA}, ${b.name} ${xB}/${nB}.`,
    };
  }
  const r = S.nMinus1ChiSquare(xA, nA, xB, nB, level)!;
  const fisher = S.fisherExact(xA, nA - xA, xB, nB - xB);
  const sig = r.p < alpha;
  const req = S.sampleSizeTwoProportions(r.pA, r.pB, alpha, 0.8);
  const underpowered = !sig && (req == null || Math.min(nA, nB) < req);
  const diffPts = Math.round(r.diff * 100);
  const dir = diffPts === 0 ? 'the same as' : diffPts > 0 ? `${Math.abs(diffPts)} points higher than` : `${Math.abs(diffPts)} points lower than`;
  let interpretation = `${b.name}: ${pct(r.pB)} (${xB}/${nB}) vs ${a.name}: ${pct(r.pA)} (${xA}/${nA}) — ${b.name} is ${dir} ${a.name} (${Math.round(level * 100)}% CI for the difference ${Math.round(r.ci[0] * 100)} to ${Math.round(r.ci[1] * 100)} points). ${verdict(sig, r.p, alpha, level)}`;
  let note: string | undefined;
  if (underpowered)
    note =
      req != null
        ? `Underpowered: detecting a ${Math.abs(diffPts)}-point difference with 80% power needs ≈ ${req} participants per variant (have ${nA} and ${nB}).`
        : 'Underpowered: no observed difference; a much larger sample is needed to rule out a meaningful one.';
  if (r.minExpected < 1) note = `${note ? note + ' ' : ''}Some expected cell counts are < 1; prefer the Fisher exact p (${fmtP(fisher)}).`;
  if (sig) interpretation += ` Fisher exact (more conservative): ${fmtP(fisher)}.`;
  return {
    ...base,
    test: 'n-1 chi-square',
    pValue: round(r.p, 6),
    effect: round(r.diff, 4),
    ci: [round(r.ci[0], 4)!, round(r.ci[1], 4)!],
    alt: { test: 'fisher exact', pValue: round(fisher, 6) },
    significant: sig,
    underpowered,
    requiredN: req,
    winner: sig ? (r.diff > 0 ? 'b' : 'a') : null,
    note,
    interpretation,
  };
}

function compareMeans(
  label: string,
  metric: string,
  stepId: string | undefined,
  a: VariantMetricsX,
  b: VariantMetricsX,
  xa: number[],
  xb: number[],
  level: number,
  opts: { kind: 'time' | 'score'; betterWhen: 'higher' | 'lower'; unit?: string; ordinal?: boolean },
): ComparisonX {
  const alpha = 1 - level;
  const isTime = opts.kind === 'time';
  const base = {
    label,
    metric,
    stepId,
    kind: opts.kind,
    betterWhen: opts.betterWhen,
    effectKind: (isTime ? 'ratio' : 'difference') as ComparisonX['effectKind'],
    aName: a.name,
    bName: b.name,
    a: { variantId: a.variantId, value: xa.length ? (isTime ? S.geometricMean(xa) : S.mean(xa)) : null, n: xa.length },
    b: { variantId: b.variantId, value: xb.length ? (isTime ? S.geometricMean(xb) : S.mean(xb)) : null, n: xb.length },
  };
  const test = (isTime ? 'welch t (log)' : 'welch t') as ComparisonResult['test'];
  if (xa.length < MIN_N || xb.length < MIN_N) {
    return {
      ...base,
      test,
      pValue: null,
      significant: false,
      underpowered: true,
      winner: null,
      note: `Too few observations to test (n = ${xa.length} vs ${xb.length}; need ≥ ${MIN_N} per variant).`,
      interpretation: `Not enough data yet (n = ${xa.length} vs ${xb.length}).`,
    };
  }
  const la = isTime ? xa.filter((v) => v > 0).map(Math.log) : xa;
  const lb = isTime ? xb.filter((v) => v > 0).map(Math.log) : xb;
  const w = S.welchT(la, lb, level)!;
  const g = S.hedgesG(la, lb);
  const sig = w.p < alpha;
  const req = g ? S.sampleSizeTwoMeans(g, alpha, 0.8) : null;
  const underpowered = !sig && (req == null || Math.min(xa.length, xb.length) < req);
  let interpretation: string;
  let effect: number;
  let ci: [number, number];
  let winner: 'a' | 'b' | null = null;
  if (isTime) {
    const ratio = Math.exp(w.diff);
    effect = ratio;
    ci = [Math.exp(w.ci[0]), Math.exp(w.ci[1])];
    const change = Math.round(Math.abs(1 - ratio) * 100);
    const faster = ratio < 1;
    interpretation = `Geometric mean ${secs(base.b.value!)} (${b.name}) vs ${secs(base.a.value!)} (${a.name}): ${b.name} is ${change}% ${faster ? 'faster' : 'slower'} (ratio ${ratio.toFixed(2)}, ${Math.round(level * 100)}% CI ${ci[0].toFixed(2)}–${ci[1].toFixed(2)}). ${verdict(sig, w.p, alpha, level)}`;
    if (sig) winner = faster ? 'b' : 'a';
  } else {
    effect = w.diff;
    ci = w.ci;
    const u = opts.unit ?? '';
    interpretation = `Mean ${w.meanB.toFixed(1)}${u} (${b.name}) vs ${w.meanA.toFixed(1)}${u} (${a.name}): difference ${w.diff >= 0 ? '+' : ''}${w.diff.toFixed(1)} (${Math.round(level * 100)}% CI ${w.ci[0].toFixed(1)} to ${w.ci[1].toFixed(1)}), ${S.effectLabel(g) ?? 'n/a'} effect (g = ${g?.toFixed(2) ?? 'n/a'}). ${verdict(sig, w.p, alpha, level)}`;
    if (sig) winner = (w.diff > 0) === (opts.betterWhen === 'higher') ? 'b' : 'a';
  }
  let alt: ComparisonX['alt'] = null;
  if (opts.ordinal) {
    const mw = S.mannWhitneyU(xa, xb);
    alt = { test: 'mann-whitney', pValue: mw ? round(mw.p, 6) : null };
  }
  return {
    ...base,
    test,
    pValue: round(w.p, 6),
    effect: round(effect, 4),
    hedgesG: round(g, 3),
    effectLabel: S.effectLabel(g),
    ci: [round(ci[0], 4)!, round(ci[1], 4)!],
    alt,
    significant: sig,
    underpowered,
    requiredN: req,
    winner,
    note: underpowered
      ? req != null
        ? `Underpowered: detecting an effect of this size (g = ${g?.toFixed(2)}) with 80% power needs ≈ ${req} per variant (have ${xa.length} and ${xb.length}).`
        : 'Underpowered: no observable effect; a much larger sample is needed to rule out a meaningful one.'
      : undefined,
    interpretation,
  };
}

function compareVariants(
  a: VariantMetricsX,
  b: VariantMetricsX,
  level: number,
  sessions: LoadedSession[],
  scores: Map<string, SessionScores>,
): ComparisonX[] {
  const out: ComparisonX[] = [];
  const finA = a.completed + a.abandoned;
  const finB = b.completed + b.abandoned;
  out.push(compareProportion('Session completion', 'completion', undefined, a, b, a.completed, finA, b.completed, finB, level));

  // Match tasks by step id, then by title.
  for (const ta of a.tasks) {
    const tb = b.tasks.find((t) => t.stepId === ta.stepId) ?? b.tasks.find((t) => t.title.trim().toLowerCase() === ta.title.trim().toLowerCase());
    if (!tb) continue;
    out.push(compareProportion(`Task success — ${ta.title}`, 'task_success', ta.stepId, a, b, ta.successes, ta.n, tb.successes, tb.n, level));
    out.push(
      compareMeans(`Time on task (successful) — ${ta.title}`, 'task_time', ta.stepId, a, b, ta.successTimesMs, tb.successTimesMs, level, {
        kind: 'time',
        betterWhen: 'lower',
      }),
    );
    if (ta.seqValues.length || tb.seqValues.length)
      out.push(
        compareMeans(`SEQ — ${ta.title}`, 'seq', ta.stepId, a, b, ta.seqValues, tb.seqValues, level, { kind: 'score', betterWhen: 'higher', ordinal: true }),
      );
  }
  const pick = (v: VariantMetricsX, id: keyof SessionScores) =>
    sessions
      .filter((s) => s.session.variantId === v.variantId)
      .map((s) => scores.get(s.session.id)?.[id])
      .filter((x): x is number => typeof x === 'number');
  const inst: [keyof SessionScores, string, 'higher' | 'lower'][] = [
    ['SUS', 'SUS', 'higher'],
    ['UMUX_LITE', 'UMUX-Lite', 'higher'],
    ['NASA_TLX', 'NASA-TLX (workload)', 'lower'],
  ];
  for (const [id, label, better] of inst) {
    const xa = pick(a, id);
    const xb = pick(b, id);
    if (!xa.length && !xb.length) continue;
    out.push(compareMeans(label, id.toLowerCase(), undefined, a, b, xa, xb, level, { kind: 'score', betterWhen: better }));
  }
  return out;
}

/** Holm-Bonferroni step-down adjustment (in place). */
function holm(cs: ComparisonX[]) {
  const tested = cs.filter((c) => c.pValue != null).sort((x, y) => x.pValue! - y.pValue!);
  const m = tested.length;
  let running = 0;
  tested.forEach((c, i) => {
    running = Math.max(running, Math.min(1, (m - i) * c.pValue!));
    c.pHolm = round(running, 6);
  });
}
