import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { AudioLines, MonitorPlay, Search } from 'lucide-react';
import type { TaskOutcome } from '@thinkaloud/shared';
import { api } from '../lib/api.ts';
import { plural, useAsync } from '../lib/hooks.ts';
import { FullPageSpinner, cn } from '../ui/index.tsx';
import { ResultsPage, useResults } from './ResultsRoutes.tsx';
import { Dot, Empty, ExportMenu, OutcomeDots, Panel, Segmented, Switch } from './components.tsx';
import { infoText, OUTCOME_META, secs, susGrade, variantColor } from './format.ts';
import type { ParticipantFieldCol, SessionRow, SessionsResponse } from './types.ts';

const STATUS: Record<string, { label: string; color: string }> = {
  completed: { label: 'Completed', color: '#34c759' },
  abandoned: { label: 'Abandoned', color: '#ff9f0a' },
  in_progress: { label: 'In progress', color: '#0071e3' },
  consented: { label: 'Started', color: '#0071e3' },
  created: { label: 'Created', color: '#c7c7cc' },
  withdrawn: { label: 'Withdrawn', color: '#8e8e93' },
};

type Sort = 'recent' | 'duration' | 'sus' | 'tasks';

/** Compact participant-info summary: name on top, then age · gender (or sex); else the first couple of values. */
function infoSummary(s: SessionRow, fields: ParticipantFieldCol[]): { primary: string; secondary: string } | null {
  const info = s.participantInfo;
  if (!info) return null;
  const kind = new Map(fields.map((f) => [f.id, f.kind]));
  const get = (id: string) => infoText(info[id], kind.get(id));
  const name = get('full_name');
  const demo = [get('age'), get('gender') || get('sex')].filter(Boolean);
  if (!name && !demo.length) {
    const rest = fields.map((f) => get(f.id)).filter(Boolean);
    if (!rest.length) return null;
    return { primary: rest[0], secondary: rest.slice(1, 3).join(' · ') };
  }
  return name ? { primary: name, secondary: demo.join(' · ') } : { primary: demo.join(' · '), secondary: '' };
}

export default function SessionsList() {
  const { studyId, base, includePreview, setIncludePreview } = useResults();
  const nav = useNavigate();
  const { data, loading, error } = useAsync(() => api.get<SessionsResponse>(`/api/studies/${studyId}/sessions`), [studyId]);
  const [variant, setVariant] = useState<string>('all');
  const [status, setStatus] = useState<string>('all');
  const [outcome, setOutcome] = useState<string>('all');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>('recent');

  const all = data?.sessions ?? [];
  const fields = data?.participantFields ?? [];
  const showInfo = fields.length > 0;
  const variants = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of all) m.set(s.variantId, s.variantName);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [all]);
  const variantIndex = (id: string) => variants.findIndex(([v]) => v === id);

  const rows = useMemo(() => {
    let r = all.filter((s) => includePreview || !s.preview);
    if (variant !== 'all') r = r.filter((s) => s.variantId === variant);
    if (status !== 'all') r = r.filter((s) => s.effectiveStatus === status);
    if (outcome !== 'all') r = r.filter((s) => s.outcomes.includes(outcome as TaskOutcome));
    if (q.trim()) {
      const n = q.trim().toLowerCase();
      const hit = (v: unknown) => (Array.isArray(v) ? v.join(' ') : String(v)).toLowerCase().includes(n);
      r = r.filter(
        (s) =>
          s.participantCode.toLowerCase().includes(n) ||
          s.id.includes(n) ||
          Object.values(s.urlParams ?? {}).some(hit) ||
          Object.values(s.participantInfo ?? {}).some((v) => typeof v !== 'boolean' && hit(v)),
      );
    }
    const sorted = [...r];
    if (sort === 'duration') sorted.sort((a, b) => (b.durationMs ?? -1) - (a.durationMs ?? -1));
    if (sort === 'sus') sorted.sort((a, b) => (b.sus ?? -1) - (a.sus ?? -1));
    if (sort === 'tasks') sorted.sort((a, b) => b.tasksSucceeded - a.tasksSucceeded);
    return sorted;
  }, [all, includePreview, variant, status, outcome, q, sort]);

  if (loading && !data) return <FullPageSpinner />;
  const head = 'px-3 py-3 text-left text-[12px] font-medium text-tertiary';
  return (
    <ResultsPage
      title="Sessions"
      subtitle={<span className="tabular-nums">{rows.length} of {plural(all.filter((s) => includePreview || !s.preview).length, 'session')}</span>}
      actions={<ExportMenu studyId={studyId} includePreview={includePreview} />}
    >
      {error ? (
        <Empty title="Sessions couldn't load">{error.message}</Empty>
      ) : all.length === 0 ? (
        <Empty title="No sessions yet">When participants open your study link, their sessions show up here with replay, transcript and task outcomes.</Empty>
      ) : (
        <>
          <div className="mb-5 flex flex-wrap items-center gap-3">
            {variants.length > 1 && (
              <Segmented
                options={[{ value: 'all', label: 'All variants' }, ...variants.map(([id, name]) => ({ value: id, label: name.split(/\s[—-]\s/)[0] }))]}
                value={variant}
                onChange={setVariant}
              />
            )}
            <select value={status} onChange={(e) => setStatus(e.target.value)} className="h-8 rounded-full bg-fill px-3 text-[13px] text-label outline-none focus:ring-4 focus:ring-brand-500/20" aria-label="Status">
              <option value="all">Any status</option>
              {Object.entries(STATUS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </select>
            <select value={outcome} onChange={(e) => setOutcome(e.target.value)} className="h-8 rounded-full bg-fill px-3 text-[13px] text-label outline-none focus:ring-4 focus:ring-brand-500/20" aria-label="Task outcome">
              <option value="all">Any task outcome</option>
              {Object.entries(OUTCOME_META).map(([k, v]) => (
                <option key={k} value={k}>
                  Has a {v.label.toLowerCase()} task
                </option>
              ))}
            </select>
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="h-8 rounded-full bg-fill px-3 text-[13px] text-label outline-none focus:ring-4 focus:ring-brand-500/20" aria-label="Sort">
              <option value="recent">Most recent</option>
              <option value="duration">Longest</option>
              <option value="sus">Highest SUS</option>
              <option value="tasks">Most tasks passed</option>
            </select>
            <label className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-tertiary" strokeWidth={2} />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={showInfo ? 'Participant, name or Prolific ID' : 'Participant or Prolific ID'}
                className="h-8 w-60 rounded-full bg-fill pl-8 pr-3 text-[13px] text-label outline-none placeholder:text-tertiary focus:ring-4 focus:ring-brand-500/20"
              />
            </label>
            <div className="ml-auto">
              <Switch checked={includePreview} onChange={setIncludePreview} label="Show previews" />
            </div>
          </div>
          <Panel className="overflow-x-auto">
            <table className={cn('w-full border-collapse text-[13px]', showInfo ? 'min-w-[1100px]' : 'min-w-[960px]')}>
              <thead>
                <tr className="border-b border-separator">
                  <th className={cn(head, 'pl-6')}>Participant</th>
                  {showInfo && <th className={head}>Participant info</th>}
                  <th className={head}>Variant</th>
                  <th className={head}>Status</th>
                  <th className={head}>Date</th>
                  <th className={cn(head, 'text-right')}>Duration</th>
                  <th className={head}>Tasks</th>
                  <th className={cn(head, 'text-right')}>SUS</th>
                  <th className={cn(head, 'text-right')} title="Rage clicks · misclicks · errors">Friction</th>
                  <th className={cn(head, 'pr-6 text-right')}>Media</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const st = STATUS[s.effectiveStatus] ?? STATUS.created;
                  const info = showInfo ? infoSummary(s, fields) : null;
                  return (
                    <tr
                      key={s.id}
                      onClick={() => nav(`${base}/sessions/${s.id}`)}
                      onKeyDown={(e) => e.key === 'Enter' && nav(`${base}/sessions/${s.id}`)}
                      tabIndex={0}
                      className="cursor-pointer border-b border-separator/70 transition-colors last:border-0 hover:bg-black/[0.025] focus:bg-brand-500/[0.06] focus:outline-none"
                    >
                      <td className="py-3 pl-6 pr-3">
                        <Link to={`${base}/sessions/${s.id}`} onClick={(e) => e.stopPropagation()} tabIndex={-1} className="font-medium tabular-nums text-label hover:underline">
                          {s.participantCode}
                        </Link>
                        {(s.preview || s.urlParams?.PROLIFIC_PID) && (
                          <div className="text-[11px] text-tertiary">{s.preview ? 'Preview' : `Prolific ${s.urlParams.PROLIFIC_PID.slice(0, 8)}…`}</div>
                        )}
                      </td>
                      {showInfo && (
                        <td className="max-w-[220px] px-3 py-3">
                          {info ? (
                            <>
                              <div className="truncate text-label" title={info.primary}>
                                {info.primary}
                              </div>
                              {info.secondary && <div className="truncate text-[11px] tabular-nums text-tertiary">{info.secondary}</div>}
                            </>
                          ) : (
                            <span className="text-tertiary">—</span>
                          )}
                        </td>
                      )}
                      <td className="px-3 py-3 text-secondary">
                        <span className="inline-flex items-center gap-1.5">
                          <Dot color={variantColor(variantIndex(s.variantId))} />
                          {s.variantName}
                        </span>
                      </td>
                      <td className="px-3 py-3">
                        <span className="inline-flex items-center gap-1.5 text-secondary" title={s.stale ? 'No activity for 15+ minutes' : undefined}>
                          <Dot color={st.color} />
                          {st.label}
                          {s.stale && <span className="text-tertiary">(idle)</span>}
                        </span>
                      </td>
                      <td className="px-3 py-3 tabular-nums text-secondary">
                        {new Date(s.startedAt ?? s.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}{' '}
                        <span className="text-tertiary">{new Date(s.startedAt ?? s.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-label">{secs(s.durationMs)}</td>
                      <td className="px-3 py-3">
                        <span className="inline-flex items-center gap-2.5">
                          <OutcomeDots outcomes={s.outcomes} total={s.tasksTotal} />
                          <span className="tabular-nums text-secondary">
                            {s.tasksSucceeded}/{s.tasksTotal}
                          </span>
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums" title={s.sus != null ? susGrade(s.sus).adjective : undefined}>
                        {s.sus != null ? <span className="text-label">{s.sus.toFixed(1)}</span> : <span className="text-tertiary">—</span>}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-secondary">
                        <span className={s.rageClicks ? 'text-label' : 'text-tertiary'}>{s.rageClicks}</span>
                        <span className="text-tertiary"> · </span>
                        <span className={s.deadClicks ? 'text-label' : 'text-tertiary'}>{s.deadClicks}</span>
                        <span className="text-tertiary"> · </span>
                        <span className={s.errors ? 'text-label' : 'text-tertiary'}>{s.errors}</span>
                      </td>
                      <td className="py-3 pl-3 pr-6">
                        <span className="flex justify-end gap-2 text-tertiary">
                          <span title={s.hasReplay ? 'Screen recording' : 'No screen recording'}>
                            <MonitorPlay className={cn('size-4', s.hasReplay ? 'text-secondary' : 'opacity-30')} strokeWidth={1.75} />
                          </span>
                          <span title={s.hasAudio ? 'Audio' : 'No audio'}>
                            <AudioLines className={cn('size-4', s.hasAudio ? 'text-secondary' : 'opacity-30')} strokeWidth={1.75} />
                          </span>
                        </span>
                      </td>
                    </tr>
                  );
                })}
                {!rows.length && (
                  <tr>
                    <td colSpan={showInfo ? 10 : 9} className="px-6 py-12 text-center text-[13px] text-tertiary">
                      No sessions match these filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Panel>
        </>
      )}
    </ResultsPage>
  );
}
