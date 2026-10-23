import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ChevronRight } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, ErrorBar, LabelList, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from 'recharts';
import { api } from '../lib/api.ts';
import { plural, useAsync, timeAgo } from '../lib/hooks.ts';
import { FullPageSpinner, cn } from '../ui/index.tsx';
import { ResultsPage, useResults } from './ResultsRoutes.tsx';
import { CIBar, Dot, Empty, ExportMenu, OutcomeBar, Panel, SectionTitle, Segmented, Switch } from './components.tsx';
import { fmtP, lostnessLabel, num, OUTCOME_META, pct, secs, susGrade, variantColor } from './format.ts';
import type { ComparisonX, StudyAnalyticsX, VariantMetricsX } from './types.ts';

export default function Overview() {
  const { studyId, level, setLevel, includePreview, setIncludePreview } = useResults();
  const { data, error, loading } = useAsync(
    () => api.get<StudyAnalyticsX>(`/api/studies/${studyId}/analytics?level=${level}&includePreview=${includePreview ? 1 : 0}`),
    [studyId, level, includePreview],
  );
  const actions = (
    <>
      <Switch checked={includePreview} onChange={setIncludePreview} label="Include previews" />
      <Segmented
        options={[
          { value: 0.9, label: '90%' },
          { value: 0.95, label: '95%' },
        ]}
        value={level}
        onChange={(v) => setLevel(v as 0.9 | 0.95)}
      />
      <ExportMenu studyId={studyId} includePreview={includePreview} />
    </>
  );
  if (!data && loading) return <FullPageSpinner />;
  if (error || !data)
    return (
      <ResultsPage title="Results" actions={actions}>
        <Empty title="Results couldn't load">{error?.message}</Empty>
      </ResultsPage>
    );
  const a = data;
  return (
    <ResultsPage
      title="Results"
      subtitle={
        <span className="tabular-nums">
          {plural(a.totals.sessions, 'session')} · {Math.round(a.confidenceLevel * 100)}% confidence intervals · updated {timeAgo(a.generatedAt)}
        </span>
      }
      actions={actions}
    >
      {a.totals.sessions === 0 ? (
        <Empty title="No sessions yet">Share your study link. Results, charts and comparisons appear here as soon as participants finish.</Empty>
      ) : (
        <div className={cn('space-y-12 transition-opacity', loading && 'opacity-60')}>
          <Kpis a={a} />
          {a.notes.length > 0 && (
            <div className="-mt-6 space-y-0.5 text-[12px] text-tertiary">
              {a.notes.map((n) => (
                <p key={n}>{n}</p>
              ))}
            </div>
          )}
          {a.comparisons.length > 0 && <Comparisons a={a} />}
          <TaskTable a={a} />
          <Charts a={a} />
          <Methods a={a} />
        </div>
      )}
    </ResultsPage>
  );
}

// ── KPI tiles ───────────────────────────────────────────────────────────────

function Tile({ label, color, value, unit, sub, children }: { label: string; color: string; value: ReactNode; unit?: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <Panel className="flex min-h-[148px] flex-col p-5">
      <div className="flex items-center gap-1.5 text-[13px] font-semibold" style={{ color }}>
        {label}
      </div>
      <div className="mt-auto pt-4">
        <div className="flex items-baseline gap-1">
          <span className="text-[34px] font-semibold leading-none tracking-[-0.025em] text-label tabular-nums">{value}</span>
          {unit && <span className="text-[15px] font-medium text-secondary">{unit}</span>}
        </div>
        {sub && <div className="mt-1.5 text-[12px] leading-snug text-secondary tabular-nums">{sub}</div>}
        {children && <div className="mt-3">{children}</div>}
      </div>
    </Panel>
  );
}

function PerVariant({ vs, render }: { vs: VariantMetricsX[]; render: (v: VariantMetricsX) => ReactNode }) {
  if (vs.length < 2) return null;
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-secondary tabular-nums">
      {vs.map((v, i) => (
        <span key={v.variantId} className="inline-flex items-center gap-1.5" title={v.name}>
          <Dot color={variantColor(i)} />
          {v.name.split(/\s[—-]\s/)[0]} <span className="font-medium text-label">{render(v)}</span>
        </span>
      ))}
    </div>
  );
}

/** Horizontal 0–100 scale with CI band and a benchmark tick. */
function Gauge({ est, low, high, benchmark, max = 100, color }: { est: number; low: number; high: number; benchmark?: number; max?: number; color: string }) {
  const x = (v: number) => `${(v / max) * 100}%`;
  return (
    <div className="relative h-4">
      <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-fill" />
      <div className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full opacity-35" style={{ left: x(low), width: `calc(${x(high)} - ${x(low)})`, background: color }} />
      <div className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-white" style={{ left: x(est), background: color }} />
      {benchmark != null && <div className="absolute top-0 h-4 w-px bg-label/40" style={{ left: x(benchmark) }} title={`Benchmark ${benchmark}`} />}
    </div>
  );
}

function Kpis({ a }: { a: StudyAnalyticsX }) {
  const vs = a.variants.filter((v) => v.sessions > 0);
  // Pool across variants for headline numbers.
  const pooled = useMemo(() => {
    const sus = vs.flatMap((v) => v.susScores);
    const finished = vs.reduce((s, v) => s + v.completed + v.abandoned, 0);
    const completed = vs.reduce((s, v) => s + v.completed, 0);
    const durs = vs.flatMap((v) => v.sessionDurationsMs).sort((x, y) => x - y);
    const npsN = vs.reduce((s, v) => s + (v.nps?.n ?? 0), 0);
    const prom = vs.reduce((s, v) => s + (v.nps?.promoters ?? 0), 0);
    const det = vs.reduce((s, v) => s + (v.nps?.detractors ?? 0), 0);
    const umux = vs.filter((v) => v.umuxLite);
    return {
      sus,
      susMean: sus.length ? sus.reduce((s, v) => s + v, 0) / sus.length : null,
      finished,
      completed,
      median: durs.length ? (durs.length % 2 ? durs[(durs.length - 1) / 2] : (durs[durs.length / 2 - 1] + durs[durs.length / 2]) / 2) : null,
      nps: npsN ? { score: Math.round(((prom - det) / npsN) * 100), prom, det, pas: npsN - prom - det, n: npsN } : null,
      umux: umux.length ? umux.reduce((s, v) => s + v.umuxLite!.estimate * (v.instrumentN.UMUX_LITE ?? 0), 0) / umux.reduce((s, v) => s + (v.instrumentN.UMUX_LITE ?? 0), 0) : null,
    };
  }, [vs]);
  const single = vs.length === 1 ? vs[0] : null;
  const susCI = single?.sus ?? null;
  const grade = pooled.susMean != null ? susGrade(pooled.susMean) : null;
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
      <Tile label="Sessions" color="#0071e3" value={a.totals.sessions} sub={`${a.totals.completed} completed · ${a.totals.abandoned} abandoned${a.totals.inProgress ? ` · ${a.totals.inProgress} live` : ''}`}>
        <PerVariant vs={vs} render={(v) => v.sessions} />
      </Tile>
      <Tile
        label="Completion"
        color="#34c759"
        value={pooled.finished ? Math.round((pooled.completed / pooled.finished) * 100) : '—'}
        unit="%"
        sub={`${pooled.completed} of ${pooled.finished} finished sessions`}
      >
        <PerVariant vs={vs} render={(v) => pct(v.completionRate)} />
      </Tile>
      <Tile label="Median duration" color="#30b0c7" value={secs(pooled.median)} sub="Completed sessions">
        <PerVariant vs={vs} render={(v) => secs(v.medianSessionMs)} />
      </Tile>
      <Tile
        label="SUS"
        color="#5856d6"
        value={pooled.susMean != null ? pooled.susMean.toFixed(1) : '—'}
        sub={grade ? `${grade.adjective} · grade ${grade.grade} · ${grade.percentile} percentile` : 'Not collected'}
      >
        {susCI && <Gauge est={susCI.estimate} low={susCI.low} high={susCI.high} benchmark={68} color="#5856d6" />}
        <PerVariant vs={vs} render={(v) => (v.sus ? `${v.sus.estimate.toFixed(1)}` : '—')} />
      </Tile>
      <Tile
        label="UMUX-Lite"
        color="#ff2d55"
        value={pooled.umux != null ? pooled.umux.toFixed(1) : '—'}
        sub={pooled.umux != null ? `≈ SUS ${(0.65 * pooled.umux + 22.9).toFixed(1)}` : 'Not collected in this study'}
      >
        <PerVariant vs={vs.filter((v) => v.umuxLite)} render={(v) => v.umuxLite!.estimate.toFixed(1)} />
      </Tile>
      <Tile
        label="NPS"
        color="#ff9f0a"
        value={pooled.nps ? `${pooled.nps.score > 0 ? '+' : pooled.nps.score < 0 ? '−' : ''}${Math.abs(pooled.nps.score)}` : '—'}
        sub={pooled.nps ? `${pooled.nps.prom} promoters · ${pooled.nps.det} detractors` : 'Not collected in this study'}
      >
        {pooled.nps && (
          <div className="flex h-1.5 gap-[2px] overflow-hidden rounded-full">
            <div style={{ flex: pooled.nps.det, background: '#ff3b30' }} />
            <div style={{ flex: pooled.nps.pas, background: '#c7c7cc' }} />
            <div style={{ flex: pooled.nps.prom, background: '#34c759' }} />
          </div>
        )}
        <PerVariant vs={vs.filter((v) => v.nps)} render={(v) => `${v.nps!.score > 0 ? '+' : v.nps!.score < 0 ? '−' : ''}${Math.abs(Math.round(v.nps!.score))}`} />
      </Tile>
    </div>
  );
}

// ── Comparisons (forest plot table) ─────────────────────────────────────────

function fmtValue(c: ComparisonX, v: number | null) {
  if (v == null) return '—';
  if (c.kind === 'proportion') return pct(v);
  if (c.kind === 'time') return secs(v);
  return v.toFixed(1);
}

function fmtEffect(c: ComparisonX) {
  if (c.effect == null) return '—';
  if (c.kind === 'proportion') return `${c.effect > 0 ? '+' : ''}${Math.round(c.effect * 100)} pts`;
  if (c.kind === 'time') {
    const ch = Math.round((c.effect - 1) * 100);
    return `${ch > 0 ? '+' : ''}${ch}%`;
  }
  return `${c.effect > 0 ? '+' : ''}${c.effect.toFixed(1)}`;
}

/** CI for the B−A difference on a symmetric axis around the null (0 or ratio 1, log scale). */
function Forest({ c, color }: { c: ComparisonX; color: string }) {
  const W = 180;
  if (!c.ci || c.effect == null) return <div className="h-5 text-[12px] text-tertiary">—</div>;
  let lo: number, hi: number, est: number, span: number;
  if (c.kind === 'time') {
    lo = Math.log(c.ci[0]);
    hi = Math.log(c.ci[1]);
    est = Math.log(c.effect);
    span = Math.max(Math.log(2), Math.abs(lo), Math.abs(hi)) * 1.1;
  } else {
    lo = c.ci[0];
    hi = c.ci[1];
    est = c.effect;
    span = c.kind === 'proportion' ? Math.max(0.5, Math.abs(lo), Math.abs(hi)) : Math.max(Math.abs(lo), Math.abs(hi), 0.5) * 1.15;
  }
  const x = (v: number) => ((Math.max(-span, Math.min(span, v)) + span) / (2 * span)) * W;
  // Direction of "better" on the axis: for lower-is-better metrics, negative = better for B.
  const betterRight = c.betterWhen === 'higher';
  return (
    <svg width={W} height={22} className="overflow-visible" role="img" aria-label={`Difference ${fmtEffect(c)}, CI ${c.ci[0]} to ${c.ci[1]}`}>
      <rect x={betterRight ? W / 2 : 0} y={2} width={W / 2} height={18} fill="#34c759" opacity={0.06} rx={4} />
      <line x1={W / 2} x2={W / 2} y1={0} y2={22} stroke="rgba(0,0,0,.25)" strokeDasharray="2 2" />
      <line x1={x(lo)} x2={x(hi)} y1={11} y2={11} stroke="#1d1d1f" strokeOpacity={0.55} strokeWidth={1.5} strokeLinecap="round" />
      <line x1={x(lo)} x2={x(lo)} y1={7} y2={15} stroke="#1d1d1f" strokeOpacity={0.55} strokeWidth={1.5} />
      <line x1={x(hi)} x2={x(hi)} y1={7} y2={15} stroke="#1d1d1f" strokeOpacity={0.55} strokeWidth={1.5} />
      <circle cx={x(est)} cy={11} r={4.5} fill={c.significant ? color : '#fff'} stroke={c.significant ? '#fff' : '#86868b'} strokeWidth={c.significant ? 2 : 1.5} />
    </svg>
  );
}

function Verdict({ c }: { c: ComparisonX }) {
  if (c.pValue == null) return <span className="inline-flex items-center gap-1.5 text-[12px] text-tertiary"><Dot color="#c7c7cc" />Not enough data</span>;
  if (c.significant) {
    const name = (c.winner === 'b' ? c.bName : c.aName).split(/\s[—-]\s/)[0];
    return (
      <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-label">
        <Dot color="#34c759" />
        {name} better
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] text-secondary">
      <Dot color={c.underpowered ? '#ff9f0a' : '#c7c7cc'} />
      {c.underpowered ? 'Inconclusive' : 'No clear difference'}
    </span>
  );
}

function Comparisons({ a }: { a: StudyAnalyticsX }) {
  const [open, setOpen] = useState<string | null>(null);
  const pairs = useMemo(() => {
    const m = new Map<string, ComparisonX[]>();
    for (const c of a.comparisons) {
      const k = `${c.a.variantId}|${c.b.variantId}`;
      m.set(k, [...(m.get(k) ?? []), c]);
    }
    // Study-level metrics (no " — task" suffix) first, then per task in protocol order.
    return [...m.values()].map((rows) => [...rows.filter((c) => !c.label.includes(' — ')), ...rows.filter((c) => c.label.includes(' — '))]);
  }, [a.comparisons]);
  const vIndex = (id: string) => a.variants.findIndex((v) => v.variantId === id);
  return (
    <section>
      <SectionTitle
        title="A/B comparison"
        caption={`Between-subjects. Rates: N−1 two-proportion test (Fisher exact shown on expand). Times: Welch t on log times. Ratings: Welch t. α = ${a.alpha.toFixed(2)}.`}
      />
      {pairs.map((rows) => {
        const first = rows[0];
        const ai = vIndex(first.a.variantId);
        const bi = vIndex(first.b.variantId);
        let lastGroup = '';
        return (
          <Panel key={first.a.variantId + first.b.variantId} className="mb-6 overflow-hidden">
            <div className="grid grid-cols-[minmax(220px,1.6fr)_90px_90px_196px_70px_88px_minmax(150px,1fr)] items-center gap-x-4 border-b border-separator px-6 py-3 text-[12px] font-medium text-tertiary">
              <span>Metric</span>
              <span className="flex items-center gap-1.5 text-right"><Dot color={variantColor(ai)} />{first.aName.split(/\s[—-]\s/)[0]}</span>
              <span className="flex items-center gap-1.5"><Dot color={variantColor(bi)} />{first.bName.split(/\s[—-]\s/)[0]}</span>
              <span>Difference ({first.bName.split(/\s[—-]\s/)[0]} vs {first.aName.split(/\s[—-]\s/)[0]})</span>
              <span className="text-right">p</span>
              <span className="text-right">Effect</span>
              <span>Verdict</span>
            </div>
            {rows.map((c, idx) => {
              const [metricLabel, group] = c.label.includes(' — ') ? (c.label.split(' — ') as [string, string]) : [c.label, 'Overall'];
              const showGroup = group !== lastGroup;
              lastGroup = group;
              const key = `${c.metric}:${c.stepId ?? ''}:${idx}`;
              const isOpen = open === key;
              return (
                <Fragment key={key}>
                  {showGroup && <div className="bg-canvas/60 px-6 pb-1.5 pt-3 text-[12px] font-semibold text-secondary">{group}</div>}
                  <button
                    onClick={() => setOpen(isOpen ? null : key)}
                    className="grid w-full grid-cols-[minmax(220px,1.6fr)_90px_90px_196px_70px_88px_minmax(150px,1fr)] items-center gap-x-4 border-b border-separator px-6 py-2.5 text-left text-[13px] transition-colors last:border-0 hover:bg-black/[0.02]"
                    aria-expanded={isOpen}
                  >
                    <span className="flex items-center gap-1.5 text-label">
                      <ChevronRight className={cn('size-3.5 text-tertiary transition-transform duration-200', isOpen && 'rotate-90')} strokeWidth={2} />
                      {metricLabel}
                      <span className="text-tertiary tabular-nums">
                        {' '}
                        n {c.a.n}/{c.b.n}
                      </span>
                    </span>
                    <span className="tabular-nums text-secondary">{fmtValue(c, c.a.value)}</span>
                    <span className="tabular-nums font-medium text-label">{fmtValue(c, c.b.value)}</span>
                    <Forest c={c} color={variantColor(c.winner === 'a' ? ai : bi)} />
                    <span className={cn('text-right tabular-nums', c.significant ? 'font-semibold text-label' : 'text-secondary')}>{fmtP(c.pValue)}</span>
                    <span className="text-right tabular-nums text-secondary">
                      {fmtEffect(c)}
                      {c.effectLabel && c.kind !== 'proportion' && <span className="block text-[11px] text-tertiary">{c.effectLabel}</span>}
                    </span>
                    <Verdict c={c} />
                  </button>
                  {isOpen && (
                    <div className="border-b border-separator bg-canvas/50 px-6 py-4 pl-11 text-[13px] leading-relaxed text-secondary">
                      <p className="max-w-3xl text-label">{c.interpretation}</p>
                      {c.note && <p className="mt-2 max-w-3xl"><span className="font-medium text-[#c93400]">Power · </span>{c.note}</p>}
                      <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-1 text-[12px] tabular-nums">
                        <div><dt className="inline text-tertiary">Test </dt><dd className="inline">{c.test}</dd></div>
                        {c.alt && <div><dt className="inline text-tertiary">{c.alt.test} </dt><dd className="inline">p {fmtP(c.alt.pValue)}</dd></div>}
                        {c.pHolm != null && <div><dt className="inline text-tertiary">Holm-adjusted </dt><dd className="inline">p {fmtP(c.pHolm)}</dd></div>}
                        {c.hedgesG != null && <div><dt className="inline text-tertiary">Hedges g </dt><dd className="inline">{c.hedgesG.toFixed(2)}</dd></div>}
                        {c.ci && (
                          <div>
                            <dt className="inline text-tertiary">{Math.round(a.confidenceLevel * 100)}% CI </dt>
                            <dd className="inline">
                              {c.kind === 'proportion' ? `${Math.round(c.ci[0] * 100)} to ${Math.round(c.ci[1] * 100)} pts` : c.kind === 'time' ? `ratio ${c.ci[0].toFixed(2)}–${c.ci[1].toFixed(2)}` : `${c.ci[0].toFixed(1)} to ${c.ci[1].toFixed(1)}`}
                            </dd>
                          </div>
                        )}
                        {c.requiredN != null && !c.significant && <div><dt className="inline text-tertiary">n for 80% power </dt><dd className="inline">≈ {c.requiredN} per variant</dd></div>}
                      </dl>
                    </div>
                  )}
                </Fragment>
              );
            })}
          </Panel>
        );
      })}
    </section>
  );
}

// ── Task table ──────────────────────────────────────────────────────────────

function TaskTable({ a }: { a: StudyAnalyticsX }) {
  const vs = a.variants.filter((v) => v.sessions > 0);
  if (!a.tasks.length) return null;
  const head = 'px-2 py-3 text-[12px] font-medium text-tertiary';
  return (
    <section>
      <SectionTitle
        title="Tasks"
        caption="Success uses adjusted-Wald intervals; partial counts as not successful. Completion counts attempts scored 2 (independent), 1 (after general prompts) and 0 (direct cue, gave up or failed). Time is the geometric mean of successful attempts. Lostness (Smith 1996): below 0.4 not lost, above 0.5 lost."
      />
      <Panel className="overflow-x-auto">
        <table className="w-full min-w-[1240px] border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-separator text-left">
              <th className={cn(head, 'pl-6')}>Task</th>
              <th className={head}>Success</th>
              <th className={head}>Outcomes</th>
              <th className={head} title="Attempts scored 2 · 1 · 0, and the median score">Completion</th>
              <th className={cn(head, 'text-right')} title="Attempts that got general prompts / a direct cue">Assisted</th>
              <th className={cn(head, 'text-right')}>Time</th>
              <th className={cn(head, 'text-right')}>Median</th>
              <th className={cn(head, 'text-right')}>SEQ</th>
              <th className={cn(head, 'text-right')}>Clicks</th>
              <th className={cn(head, 'text-right')} title="Clicks that changed nothing (dead clicks)">Misclicks</th>
              <th className={cn(head, 'text-right')}>Rage</th>
              <th className={cn(head, 'text-right')}>Errors</th>
              <th className={cn(head, 'text-right')} title="Mean revisits to an already-seen page per attempt">Backtracks</th>
              <th className={cn(head, 'pr-6 text-right')}>Lostness</th>
            </tr>
          </thead>
          <tbody>
            {a.tasks.map((t) => (
              <Fragment key={t.stepId}>
                <tr>
                  <td colSpan={14} className="px-6 pb-1 pt-4 text-[13px] font-semibold text-label">
                    {t.title}
                  </td>
                </tr>
                {vs.map((v) => {
                  const vi = a.variants.indexOf(v);
                  const m = v.tasks.find((x) => x.stepId === t.stepId);
                  if (!m) return null;
                  return (
                    <tr key={v.variantId} className="border-b border-separator/70 last:border-0">
                      <td className="whitespace-nowrap py-2 pl-6 pr-2 text-secondary" title={v.name}>
                        <span className="inline-flex max-w-[180px] items-center gap-1.5">
                          <Dot color={variantColor(vi)} />
                          <span className="truncate">{v.name}</span>
                          <span className="shrink-0 text-tertiary tabular-nums">n {m.n}</span>
                        </span>
                      </td>
                      <td className="px-2 py-2">
                        <div className="flex items-center gap-2.5">
                          <CIBar ci={m.successRate} color={variantColor(vi)} width={84} />
                          <span className="w-10 font-medium tabular-nums text-label">{pct(m.successRate?.estimate)}</span>
                          <span className="whitespace-nowrap text-[11px] text-tertiary tabular-nums">
                            {m.successRate ? `${Math.round(m.successRate.low * 100)}–${Math.round(m.successRate.high * 100)}` : ''}
                          </span>
                        </div>
                      </td>
                      <td className="px-2 py-2">
                        <OutcomeBar outcomes={m.outcomes} width={72} />
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 tabular-nums" title="2 independent · 1 after general prompts · 0 direct cue, gave up or failed">
                        {m.n ? (
                          <>
                            <span className="text-label">
                              {m.scoreCounts['2']}
                              <span className="text-tertiary"> · </span>
                              {m.scoreCounts['1']}
                              <span className="text-tertiary"> · </span>
                              {m.scoreCounts['0']}
                            </span>
                            <span className="block text-[11px] text-tertiary">median {num(m.medianScore)}</span>
                          </>
                        ) : (
                          <span className="text-tertiary">—</span>
                        )}
                      </td>
                      <td className={cn('whitespace-nowrap px-2 py-2 text-right tabular-nums', m.assistedGeneral + m.assistedDirect ? 'text-label' : 'text-tertiary')}>
                        {m.assistedGeneral + m.assistedDirect}
                        {m.assistedDirect > 0 && <span className="block text-[11px] text-tertiary">{m.assistedDirect} direct</span>}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-label" title={m.timeOnTaskMs ? `${secs(m.timeOnTaskMs.low)}–${secs(m.timeOnTaskMs.high)}` : ''}>
                        {secs(m.timeOnTaskMs?.estimate)}
                        {m.timeOnTaskMs && <span className="block text-[11px] text-tertiary">{secs(m.timeOnTaskMs.low)}–{secs(m.timeOnTaskMs.high)}</span>}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-secondary">{secs(m.medianTimeMs)}</td>
                      <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-label">
                        {num(m.seq?.estimate)}
                        {m.seq && <span className="block text-[11px] text-tertiary">{num(m.seq.low)}–{num(m.seq.high)}</span>}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums text-secondary">{num(m.avgClicks)}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-secondary">{num(m.avgMisclicks)}</td>
                      <td className={cn('px-2 py-2 text-right tabular-nums', m.rageClicks ? 'text-label' : 'text-tertiary')}>{m.rageClicks}</td>
                      <td className={cn('px-2 py-2 text-right tabular-nums', m.errors ? 'text-label' : 'text-tertiary')}>{m.errors}</td>
                      <td className="px-2 py-2 text-right tabular-nums text-secondary">{num(m.avgBacktracks)}</td>
                      <td className="py-2 pl-2 pr-6 text-right tabular-nums text-secondary" title={m.optimalPathLength ? `Optimal path: ${m.optimalPathLength} pages` : 'Set an optimal path length on the task to compute lostness'}>
                        {m.lostness != null ? m.lostness.toFixed(2) : '—'}
                        {m.lostness != null && <span className="block text-[11px] text-tertiary">{lostnessLabel(m.lostness)}</span>}
                      </td>
                    </tr>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
        <div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-separator px-6 py-3 text-[12px] text-tertiary">
          {Object.entries(OUTCOME_META).map(([k, m]) => (
            <span key={k} className="inline-flex items-center gap-1.5">
              <Dot color={m.color} />
              {m.label}
            </span>
          ))}
        </div>
      </Panel>
    </section>
  );
}

// ── Charts ──────────────────────────────────────────────────────────────────

const axisProps = { tick: { fill: '#86868b', fontSize: 12 }, axisLine: false, tickLine: false } as const;

function ChartCard({ title, caption, legend, children }: { title: string; caption?: string; legend?: ReactNode; children: ReactNode }) {
  return (
    <Panel className="p-6">
      <div className="mb-1 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[17px] font-semibold tracking-[-0.015em] text-label">{title}</h3>
          {caption && <p className="mt-0.5 text-[12px] text-tertiary">{caption}</p>}
        </div>
        {legend}
      </div>
      <div className="mt-4 h-[260px]">{children}</div>
    </Panel>
  );
}

function Legend({ vs, all }: { vs: VariantMetricsX[]; all: VariantMetricsX[] }) {
  return (
    <div className="flex flex-wrap justify-end gap-x-3 gap-y-1 text-[12px] text-secondary">
      {vs.map((v) => (
        <span key={v.variantId} className="inline-flex items-center gap-1.5">
          <Dot color={variantColor(all.indexOf(v))} />
          {v.name.split(/\s[—-]\s/)[0]}
        </span>
      ))}
    </div>
  );
}

function TipBox({ children }: { children: ReactNode }) {
  return <div className="rounded-[10px] bg-white/95 px-3 py-2 text-[12px] text-label shadow-[0_6px_24px_rgba(0,0,0,.14),0_0_0_0.5px_rgba(0,0,0,.08)] backdrop-blur-xl tabular-nums">{children}</div>;
}

const short = (s: string, n = 18) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function Charts({ a }: { a: StudyAnalyticsX }) {
  const vs = a.variants.filter((v) => v.sessions > 0);
  const key = (v: VariantMetricsX) => `v${a.variants.indexOf(v)}`;
  const successData = a.tasks.map((t) => {
    const row: Record<string, unknown> = { task: short(t.title) };
    for (const v of vs) {
      const m = v.tasks.find((x) => x.stepId === t.stepId);
      if (m?.successRate) {
        row[key(v)] = m.successRate.estimate * 100;
        row[`${key(v)}e`] = [(m.successRate.estimate - m.successRate.low) * 100, (m.successRate.high - m.successRate.estimate) * 100];
        row[`${key(v)}n`] = `${m.successes}/${m.n}`;
      }
    }
    return row;
  });
  const seqData = a.tasks.map((t) => {
    const row: Record<string, unknown> = { task: short(t.title) };
    for (const v of vs) {
      const m = v.tasks.find((x) => x.stepId === t.stepId);
      if (m?.seq) {
        row[key(v)] = m.seq.estimate;
        row[`${key(v)}e`] = [m.seq.estimate - m.seq.low, m.seq.high - m.seq.estimate];
      }
    }
    return row;
  });
  // Time strip plot: x = task index (+ offset per variant), y = seconds (log)
  const nV = vs.length;
  const timeSeries = vs.map((v, vi) => ({
    v,
    pts: a.tasks.flatMap((t, ti) => {
      const m = v.tasks.find((x) => x.stepId === t.stepId);
      return (m?.successTimesMs ?? []).map((ms, k) => ({
        x: ti + (nV > 1 ? (vi / (nV - 1) - 0.5) * 0.36 : 0) + (((k * 7919) % 100) / 100 - 0.5) * 0.12,
        y: ms / 1000,
        task: t.title,
      }));
    }),
    geo: a.tasks.map((t, ti) => {
      const m = v.tasks.find((x) => x.stepId === t.stepId);
      return m?.timeOnTaskMs ? { x: ti + (nV > 1 ? (vi / (nV - 1) - 0.5) * 0.36 : 0), y: m.timeOnTaskMs.estimate / 1000, task: t.title, geo: true } : null;
    }).filter(Boolean) as { x: number; y: number; task: string; geo: boolean }[],
  }));
  const susSeries = vs.map((v, vi) => ({
    v,
    pts: v.susScores.map((s, k) => ({ x: s, y: vi + (((k * 4231) % 100) / 100 - 0.5) * 0.5 })),
  }));
  const anyTime = timeSeries.some((s) => s.pts.length);
  const anySus = susSeries.some((s) => s.pts.length);
  const anySeq = seqData.some((r) => Object.keys(r).length > 1);
  return (
    <section>
      <SectionTitle title="Charts" caption="Whiskers show confidence intervals at the selected level." />
      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard title="Task success" caption="Completion rate per task, adjusted-Wald CI" legend={<Legend vs={vs} all={a.variants} />}>
          <ResponsiveContainer>
            <BarChart data={successData} barGap={2} barCategoryGap="28%" margin={{ top: 16, right: 4, left: -16, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="rgba(0,0,0,.06)" />
              <XAxis dataKey="task" {...axisProps} interval={0} />
              <YAxis {...axisProps} domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(v) => `${v}%`} />
              <Tooltip
                cursor={{ fill: 'rgba(0,0,0,.03)' }}
                content={({ active, payload, label }) =>
                  active && payload?.length ? (
                    <TipBox>
                      <div className="mb-1 font-semibold">{label}</div>
                      {payload.map((p) => (
                        <div key={String(p.dataKey)} className="flex items-center gap-1.5">
                          <Dot color={String(p.color)} />
                          {Math.round(Number(p.value))}% <span className="text-tertiary">({String((p.payload as Record<string, unknown>)[`${p.dataKey}n`] ?? '')})</span>
                        </div>
                      ))}
                    </TipBox>
                  ) : null
                }
              />
              {vs.map((v) => (
                <Bar key={key(v)} dataKey={key(v)} name={v.name} fill={variantColor(a.variants.indexOf(v))} radius={[4, 4, 0, 0]} maxBarSize={34} isAnimationActive={false}>
                  <ErrorBar dataKey={`${key(v)}e`} width={5} strokeWidth={1.25} stroke="#1d1d1f" strokeOpacity={0.6} />
                  {vs.length <= 2 && <LabelList dataKey={key(v)} position="insideBottom" offset={6} formatter={(val: unknown) => `${Math.round(Number(val))}`} style={{ fill: '#fff', fontSize: 11, fontWeight: 600 }} />}
                </Bar>
              ))}
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Time on task" caption="Successful attempts (log scale); ring = geometric mean" legend={<Legend vs={vs} all={a.variants} />}>
          {anyTime ? (
            <ResponsiveContainer>
              <ScatterChart margin={{ top: 12, right: 8, left: -12, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="rgba(0,0,0,.06)" />
                <XAxis
                  type="number"
                  dataKey="x"
                  domain={[-0.5, a.tasks.length - 0.5]}
                  ticks={a.tasks.map((_, i) => i)}
                  tickFormatter={(i) => short(a.tasks[i]?.title ?? '')}
                  {...axisProps}
                />
                <YAxis type="number" dataKey="y" scale="log" domain={['auto', 'auto']} allowDataOverflow={false} tickFormatter={(v) => secs(Number(v) * 1000)} {...axisProps} />
                <ZAxis range={[36, 36]} />
                <Tooltip
                  cursor={false}
                  content={({ active, payload }) => {
                    const p = payload?.[0]?.payload as { y: number; task: string; geo?: boolean } | undefined;
                    return active && p ? (
                      <TipBox>
                        <div className="font-semibold">{p.task}</div>
                        {p.geo ? 'Geometric mean ' : ''}
                        {secs(p.y * 1000)}
                      </TipBox>
                    ) : null;
                  }}
                />
                {timeSeries.map((s) => (
                  <Scatter key={s.v.variantId} data={s.pts} fill={variantColor(a.variants.indexOf(s.v))} fillOpacity={0.55} isAnimationActive={false} />
                ))}
                {timeSeries.map((s) => (
                  <Scatter
                    key={s.v.variantId + 'g'}
                    data={s.geo}
                    isAnimationActive={false}
                    shape={(props: { cx?: number; cy?: number }) => (
                      <circle cx={props.cx} cy={props.cy} r={8} fill="none" stroke={variantColor(a.variants.indexOf(s.v))} strokeWidth={2.5} />
                    )}
                  />
                ))}
              </ScatterChart>
            </ResponsiveContainer>
          ) : (
            <NoData />
          )}
        </ChartCard>

        <ChartCard title="SUS scores" caption="One dot per participant; bar = mean with CI; line = average 68" legend={<Legend vs={vs} all={a.variants} />}>
          {anySus ? (
            <ResponsiveContainer>
              <ScatterChart margin={{ top: 12, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid horizontal={false} stroke="rgba(0,0,0,.06)" />
                <XAxis type="number" dataKey="x" domain={[0, 100]} ticks={[0, 20, 40, 60, 80, 100]} {...axisProps} />
                <YAxis type="number" dataKey="y" domain={[-0.6, vs.length - 0.4]} ticks={vs.map((_, i) => i)} tickFormatter={(i) => vs[i]?.name.split(/\s[—-]\s/)[0] ?? ''} {...axisProps} width={40} />
                <ZAxis range={[40, 40]} />
                <ReferenceLine x={68} stroke="#86868b" strokeDasharray="3 3" label={{ value: 'Avg 68', position: 'top', fill: '#86868b', fontSize: 11 }} />
                {vs.map((v, vi) =>
                  v.sus ? (
                    <ReferenceLine
                      key={v.variantId + 'ci'}
                      segment={[
                        { x: v.sus.low, y: vi },
                        { x: v.sus.high, y: vi },
                      ]}
                      stroke={variantColor(a.variants.indexOf(v))}
                      strokeWidth={6}
                      strokeOpacity={0.25}
                      strokeLinecap="round"
                    />
                  ) : null,
                )}
                {vs.map((v, vi) =>
                  v.sus ? (
                    <ReferenceLine
                      key={v.variantId + 'm'}
                      segment={[
                        { x: v.sus.estimate, y: vi - 0.32 },
                        { x: v.sus.estimate, y: vi + 0.32 },
                      ]}
                      stroke={variantColor(a.variants.indexOf(v))}
                      strokeWidth={2.5}
                    />
                  ) : null,
                )}
                <Tooltip
                  cursor={false}
                  content={({ active, payload }) => {
                    const p = payload?.[0]?.payload as { x: number } | undefined;
                    return active && p ? <TipBox>SUS {p.x.toFixed(1)} · {susGrade(p.x).adjective}</TipBox> : null;
                  }}
                />
                {susSeries.map((s) => (
                  <Scatter key={s.v.variantId} data={s.pts} fill={variantColor(a.variants.indexOf(s.v))} fillOpacity={0.6} isAnimationActive={false} />
                ))}
              </ScatterChart>
            </ResponsiveContainer>
          ) : (
            <NoData />
          )}
        </ChartCard>

        <ChartCard title="Ease by task (SEQ)" caption="1 very difficult – 7 very easy; line = average 5.5" legend={<Legend vs={vs} all={a.variants} />}>
          {anySeq ? (
            <ResponsiveContainer>
              <BarChart data={seqData} baseValue={1} barGap={2} barCategoryGap="28%" margin={{ top: 16, right: 4, left: -24, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="rgba(0,0,0,.06)" />
                <XAxis dataKey="task" {...axisProps} interval={0} />
                <YAxis {...axisProps} domain={[1, 7]} ticks={[1, 2, 3, 4, 5, 6, 7]} />
                <ReferenceLine y={5.5} stroke="#86868b" strokeDasharray="3 3" />
                <Tooltip
                  cursor={{ fill: 'rgba(0,0,0,.03)' }}
                  content={({ active, payload, label }) =>
                    active && payload?.length ? (
                      <TipBox>
                        <div className="mb-1 font-semibold">{label}</div>
                        {payload.map((p) => (
                          <div key={String(p.dataKey)} className="flex items-center gap-1.5">
                            <Dot color={String(p.color)} />
                            {Number(p.value).toFixed(1)}
                          </div>
                        ))}
                      </TipBox>
                    ) : null
                  }
                />
                {vs.map((v) => (
                  <Bar key={key(v)} dataKey={key(v)} fill={variantColor(a.variants.indexOf(v))} radius={[4, 4, 0, 0]} maxBarSize={34} isAnimationActive={false}>
                    <ErrorBar dataKey={`${key(v)}e`} width={5} strokeWidth={1.25} stroke="#1d1d1f" strokeOpacity={0.6} />
                  </Bar>
                ))}
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <NoData />
          )}
        </ChartCard>
      </div>
    </section>
  );
}

function NoData() {
  return <div className="flex h-full items-center justify-center text-[13px] text-tertiary">No data yet</div>;
}

function Methods({ a }: { a: StudyAnalyticsX }) {
  return (
    <section className="max-w-3xl text-[12px] leading-relaxed text-tertiary">
      <p>
        Methods follow Sauro &amp; Lewis, <em>Quantifying the User Experience</em>. Preview{a.includePreview ? ' sessions are included' : ' and withdrawn sessions are excluded'}; sessions idle for 15 minutes count as abandoned.
        Small samples give wide intervals: read overlapping intervals and “inconclusive” verdicts as “not enough evidence yet”, not as “no difference”.
        SUS grades use the Sauro–Lewis curved grading scale and Bangor et al. (2009) adjectives.{' '}
        <Link to="sessions" className="text-brand-500 hover:underline">
          Review individual sessions
        </Link>
        .
      </p>
    </section>
  );
}
