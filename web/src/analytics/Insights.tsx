import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { marked } from 'marked';
import { Play, ShieldCheck } from 'lucide-react';
import { api, ApiError } from '../lib/api.ts';
import { plural, useAsync, timeAgo } from '../lib/hooks.ts';
import { Button, FullPageSpinner, cn } from '../ui/index.tsx';
import { useToast } from '../ui/toast.tsx';
import { ResultsPage, useResults } from './ResultsRoutes.tsx';
import { Dot, Empty, Panel, Segmented } from './components.tsx';
import { clock } from './format.ts';
import type { InsightX, StudyAnalyticsX, SynthesisX } from './types.ts';

const SEVERITY: Record<InsightX['severity'], { label: string; color: string }> = {
  critical: { label: 'Critical', color: '#ff3b30' },
  major: { label: 'Major', color: '#ff9f0a' },
  minor: { label: 'Minor', color: '#ffcc00' },
  info: { label: 'Observation', color: '#8e8e93' },
  positive: { label: 'Working well', color: '#34c759' },
};

/** Markdown → HTML with raw HTML escaped (model output is untrusted). */
function md(s: string) {
  const escaped = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return marked.parse(escaped, { async: false, gfm: true, breaks: false }) as string;
}

const PROSE = '[&_p]:my-2 [&_p:first-child]:mt-0 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1 [&_strong]:font-semibold [&_strong]:text-label [&_h2]:mt-4 [&_h2]:text-[17px] [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:font-semibold [&_a]:text-brand-500';

const STAGES = ['Collecting transcripts and behaviour', 'Reading sessions', 'Drafting insights', 'Checking every quote against the transcripts', 'Saving'];

export default function Insights() {
  const { studyId, base } = useResults();
  const toast = useToast();
  const q = useAsync(() => api.get<SynthesisX | null>(`/api/studies/${studyId}/synthesis`), [studyId]);
  const meta = useAsync(() => api.get<StudyAnalyticsX>(`/api/studies/${studyId}/analytics`), [studyId]);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [sev, setSev] = useState<'all' | InsightX['severity']>('all');
  const [variant, setVariant] = useState('');
  const [tag, setTag] = useState('');

  useEffect(() => {
    if (!running) return;
    const t0 = Date.now();
    const id = setInterval(() => setElapsed(Date.now() - t0), 250);
    return () => clearInterval(id);
  }, [running]);

  const run = async () => {
    setRunning(true);
    setElapsed(0);
    try {
      const s = await api.post<SynthesisX>(`/api/studies/${studyId}/synthesis`);
      q.setData(s);
      toast(`${s.insights.length} insights · ${s.verification.evidenceVerified} citations verified`);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Synthesis failed', 'error');
    } finally {
      setRunning(false);
    }
  };

  const s = q.data;
  const variants = meta.data?.variants ?? [];
  const tasks = new Map((meta.data?.tasks ?? []).map((t) => [t.stepId, t.title]));
  const vName = new Map(variants.map((v) => [v.variantId, v.name]));
  const tags = useMemo(() => [...new Set((s?.insights ?? []).flatMap((i) => i.tags))].sort(), [s]);
  const shown = (s?.insights ?? []).filter((i) => (sev === 'all' || i.severity === sev) && (!variant || i.variantId === variant || !i.variantId) && (!tag || i.tags.includes(tag)));
  const stage = Math.min(STAGES.length - 1, Math.floor(elapsed / 9000));

  if (q.loading && !s) return <FullPageSpinner />;
  const runBtn = (
    <Button onClick={run} loading={running}>
      {s ? 'Run again' : 'Run synthesis'}
    </Button>
  );
  return (
    <ResultsPage
      title="Insights"
      subtitle={
        s ? (
          <span className="tabular-nums">
            From {plural(s.sessionCount, 'session')} · {s.generatedBy === 'seed' ? 'demo synthesis' : s.model} · {timeAgo(s.createdAt)}
          </span>
        ) : (
          'AI synthesis of every transcript, task outcome and behaviour event, with citations you can check.'
        )
      }
      actions={runBtn}
    >
      {running && (
        <Panel className="mb-8 px-6 py-5">
          <div className="flex items-center justify-between text-[14px]">
            <span className="font-medium text-label">{STAGES[stage]}…</span>
            <span className="tabular-nums text-tertiary">{Math.round(elapsed / 1000)}s</span>
          </div>
          <div className="mt-3 h-1 overflow-hidden rounded-full bg-fill">
            <div className="h-full rounded-full bg-brand-500 transition-[width] duration-500 ease-apple" style={{ width: `${Math.min(95, 8 + (elapsed / 60000) * 87)}%` }} />
          </div>
          <p className="mt-2 text-[12px] text-tertiary">Usually takes under a minute. Quotes the model can't back up with the transcript are removed before you see them.</p>
        </Panel>
      )}
      {!s ? (
        !running && (
          <Empty title="No synthesis yet">
            Run a synthesis to get an executive summary and prioritized findings. Every insight cites participant quotes and moments you can open in the replay.
          </Empty>
        )
      ) : (
        <div className="space-y-10">
          <Verification s={s} />
          <Panel className="px-8 py-7">
            <div className="mb-2 text-[13px] font-semibold text-secondary">Executive summary</div>
            <div className={cn(PROSE, 'max-w-3xl text-[15px] leading-relaxed text-label')} dangerouslySetInnerHTML={{ __html: md(s.summary.replace(/^\s*#{1,3}\s*executive summary\s*\n/i, '')) }} />
          </Panel>

          <section>
            <div className="mb-5 flex flex-wrap items-center gap-3">
              <h2 className="mr-2 text-[22px] font-semibold tracking-[-0.015em] text-label">Findings</h2>
              <Segmented
                size="sm"
                options={[
                  { value: 'all', label: `All ${s.insights.length}` },
                  ...(['critical', 'major', 'minor', 'positive', 'info'] as const)
                    .filter((k) => s.insights.some((i) => i.severity === k))
                    .map((k) => ({ value: k, label: `${SEVERITY[k].label} ${s.insights.filter((i) => i.severity === k).length}` })),
                ]}
                value={sev}
                onChange={setSev}
              />
              {variants.length > 1 && (
                <Segmented size="sm" options={[{ value: '', label: 'All variants' }, ...variants.map((v) => ({ value: v.variantId, label: v.name.split(/\s[—-]\s/)[0] }))]} value={variant} onChange={setVariant} />
              )}
              {tags.length > 0 && (
                <select value={tag} onChange={(e) => setTag(e.target.value)} className="h-7 rounded-full bg-fill px-3 text-[12px] text-label outline-none" aria-label="Tag">
                  <option value="">Any tag</option>
                  {tags.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              )}
            </div>
            <div className="space-y-4">
              {shown.map((i) => (
                <InsightCard key={i.id} i={i} base={base} task={i.stepId ? tasks.get(i.stepId) : undefined} variant={i.variantId ? vName.get(i.variantId) : undefined} />
              ))}
              {!shown.length && <div className="py-8 text-center text-[13px] text-tertiary">No findings match these filters.</div>}
            </div>
          </section>
        </div>
      )}
    </ResultsPage>
  );
}

function Verification({ s }: { s: SynthesisX }) {
  const v = s.verification;
  const removed = v.insightsProposed - v.insightsKept;
  return (
    <div className="flex items-start gap-3 text-[13px] leading-relaxed text-secondary">
      <ShieldCheck className="mt-0.5 size-[18px] shrink-0 text-[#248a3d]" strokeWidth={1.75} />
      <p className="tabular-nums">
        <span className="font-medium text-label">Citations checked.</span> {v.evidenceVerified} of {v.evidenceProposed} citations matched the cited participant's transcript or a logged event.
        {v.evidenceDropped > 0 && ` ${v.evidenceDropped} unverifiable ${v.evidenceDropped === 1 ? 'citation was' : 'citations were'} removed`}
        {removed > 0 && `, and ${removed} ${removed === 1 ? 'finding' : 'findings'} without remaining evidence ${removed === 1 ? 'was' : 'were'} dropped`}
        {v.evidenceDropped > 0 || removed > 0 ? '.' : ''}
        {v.timestampsCorrected > 0 && ` ${v.timestampsCorrected} timestamp${v.timestampsCorrected === 1 ? ' was' : 's were'} corrected to the matching utterance.`}
      </p>
    </div>
  );
}

function InsightCard({ i, base, task, variant }: { i: InsightX; base: string; task?: string; variant?: string }) {
  const [open, setOpen] = useState(false);
  const sev = SEVERITY[i.severity];
  const quotes = i.evidence.filter((e) => e.quote);
  const events = i.evidence.filter((e) => !e.quote);
  const participants = new Set(i.evidence.map((e) => e.sessionId)).size;
  const visible = open ? quotes : quotes.slice(0, 2);
  return (
    <Panel className="px-7 py-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
        <span className="inline-flex items-center gap-1.5 font-semibold" style={{ color: i.severity === 'minor' ? '#a37f00' : sev.color }}>
          <Dot color={sev.color} />
          {sev.label}
        </span>
        {task && <span className="text-secondary">{task}</span>}
        {variant && <span className="text-secondary">{variant}</span>}
        <span className="text-tertiary tabular-nums">
          {participants} participant{participants === 1 ? '' : 's'} cited
        </span>
      </div>
      <h3 className="mt-2 text-[20px] font-semibold leading-snug tracking-[-0.015em] text-label">{i.title}</h3>
      <div className={cn(PROSE, 'mt-1.5 max-w-3xl text-[15px] leading-relaxed text-secondary')} dangerouslySetInnerHTML={{ __html: md(i.body) }} />
      {i.recommendation && (
        <p className="mt-3 max-w-3xl text-[14px] leading-relaxed text-label">
          <span className="font-semibold">Recommendation. </span>
          {i.recommendation}
        </p>
      )}
      {quotes.length > 0 && (
        <div className="mt-5 space-y-2">
          {visible.map((e, k) => (
            <Link
              key={k}
              to={`${base}/sessions/${e.sessionId}?t=${Math.max(0, e.t - 2000)}`}
              className="group flex items-start gap-3 rounded-[14px] bg-canvas px-4 py-3 transition-colors hover:bg-black/[0.05]"
              title="Open the replay at this moment"
            >
              <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-white text-brand-500 shadow-[0_1px_2px_rgba(0,0,0,.08)] transition-transform group-hover:scale-105">
                <Play className="ml-px size-3" fill="currentColor" strokeWidth={0} />
              </span>
              <span className="min-w-0">
                <span className="block text-[15px] leading-snug text-label">“{e.quote}”</span>
                <span className="mt-0.5 block text-[12px] text-tertiary tabular-nums">
                  {e.participantCode} · {clock(e.t)}
                  {e.timeCorrected && ' · time corrected'}
                </span>
              </span>
            </Link>
          ))}
          {quotes.length > 2 && (
            <button onClick={() => setOpen(!open)} className="px-1 text-[13px] font-medium text-brand-500 hover:underline">
              {open ? 'Show fewer quotes' : `Show all ${quotes.length} quotes`}
            </button>
          )}
        </div>
      )}
      {events.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-2 text-[12px]">
          <span className="text-tertiary">Behaviour</span>
          {events.map((e, k) => (
            <Link
              key={k}
              to={`${base}/sessions/${e.sessionId}?t=${Math.max(0, e.t - 2000)}`}
              className="inline-flex items-center gap-1.5 rounded-full bg-fill px-2.5 py-1 text-secondary transition-colors hover:bg-black/[0.08] hover:text-label tabular-nums"
            >
              {(e.eventKind ?? '').replace('app.', '').replace('_', ' ')} · {e.participantCode} {clock(e.t)}
            </Link>
          ))}
        </div>
      )}
      {i.tags.length > 0 && (
        <div className={cn('mt-4 flex flex-wrap gap-1.5')}>
          {i.tags.map((t) => (
            <span key={t} className="rounded-full bg-fill px-2.5 py-0.5 text-[12px] text-secondary">
              {t}
            </span>
          ))}
        </div>
      )}
    </Panel>
  );
}
