import type { DemographicsBreakdown, DemographicsResponse } from '@thinkaloud/shared';
import { api } from '../lib/api.ts';
import { plural, useAsync } from '../lib/hooks.ts';
import { FullPageSpinner } from '../ui/index.tsx';
import { ResultsPage, useResults } from './ResultsRoutes.tsx';
import { Empty, Panel, Switch } from './components.tsx';

const BAR = '#0071e3';

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

export default function Participants() {
  const { studyId, includePreview, setIncludePreview } = useResults();
  const { data, loading, error } = useAsync(
    () => api.get<DemographicsResponse>(`/api/studies/${studyId}/demographics${includePreview ? '?includePreview=1' : ''}`),
    [studyId, includePreview],
  );

  if (loading && !data) return <FullPageSpinner />;
  return (
    <ResultsPage
      title="Participants"
      subtitle={
        data && data.breakdowns.length > 0 ? (
          <span className="tabular-nums">
            {data.withInfo} of {plural(data.sessions, 'session')} shared information
          </span>
        ) : undefined
      }
      actions={<Switch checked={includePreview} onChange={setIncludePreview} label="Show previews" />}
    >
      {error ? (
        <Empty title="Participant info couldn't load">{error.message}</Empty>
      ) : !data || data.breakdowns.length === 0 ? (
        <Empty title="No participant info">Turn on the consent form and choose fields to collect under Consent.</Empty>
      ) : (
        <div className="grid gap-6 md:grid-cols-2">
          {data.breakdowns.map((b) => (
            <BreakdownPanel key={b.fieldId} b={b} />
          ))}
        </div>
      )}
    </ResultsPage>
  );
}

function BreakdownPanel({ b }: { b: DemographicsBreakdown }) {
  const max = Math.max(1, ...b.counts.map((c) => c.n));
  // Multi-select answers can add up to more than n; percentages are always of respondents.
  const total = b.n || 1;
  const s = b.stats;
  return (
    <Panel className="px-6 pb-5 pt-5">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="min-w-0 truncate text-[17px] font-semibold tracking-[-0.015em] text-label" title={b.label}>
          {b.label}
        </h2>
        <span className="shrink-0 text-[12px] tabular-nums text-tertiary">{plural(b.n, 'response')}</span>
      </div>
      {s && (
        <p className="mt-1 text-[13px] tabular-nums text-secondary">
          Median {fmt(s.median)} · Mean {s.mean.toFixed(1)} ± {s.sd.toFixed(1)} · Range {fmt(s.min)}–{fmt(s.max)}
        </p>
      )}
      {b.counts.length > 0 ? (
        <div className="mt-4 space-y-2">
          {b.counts.map((c) => (
            <div key={c.label} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_2.5rem_2.75rem] items-center gap-3 text-[13px]">
              <span className="truncate text-secondary" title={c.label}>
                {c.label}
              </span>
              <div className="h-2 rounded-full bg-fill">
                <div className="h-2 rounded-full" style={{ width: `${(c.n / max) * 100}%`, background: BAR, minWidth: c.n ? 4 : 0 }} />
              </div>
              <span className="text-right font-medium tabular-nums text-label">{c.n}</span>
              <span className="text-right tabular-nums text-tertiary">{Math.round((c.n / total) * 100)}%</span>
            </div>
          ))}
        </div>
      ) : (
        !s && <p className="mt-3 text-[13px] text-tertiary">{b.n ? 'Free-text answers are listed per session.' : 'No answers yet.'}</p>
      )}
    </Panel>
  );
}
