import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ChevronRight, Plus, Search } from 'lucide-react';
import type { StudyStatus } from '@thinkaloud/shared';
import { useAsync, timeAgo } from '../lib/hooks.ts';
import { Button, cn, Field, Input, Modal, Spinner, Textarea } from '../ui/index.tsx';
import { useToast } from '../ui/toast.tsx';
import { Callout, Segmented, StatusBadge } from './components/index.tsx';
import { useAuth } from './auth.tsx';
import { errorMessage, rApi, type StudySummary } from './lib.ts';
import { notifyStudiesChanged } from './AppShell.tsx';

type Filter = 'all' | StudyStatus;

export default function StudiesPage() {
  const { user } = useAuth();
  const { data, loading, error, reload } = useAsync(() => rApi.studies(), []);
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(params.get('new') === '1');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const studies = data?.studies ?? [];
  const shown = useMemo(
    () =>
      [...studies]
        .filter((s) => (filter === 'all' ? true : s.status === filter))
        .filter((s) => !q || (s.name + ' ' + s.description).toLowerCase().includes(q.toLowerCase()))
        .sort((a, b) => Math.max(b.updatedAt, b.lastSessionAt ?? 0) - Math.max(a.updatedAt, a.lastSessionAt ?? 0)),
    [studies, q, filter],
  );
  const totalSessions = studies.reduce((s, x) => s + (x.sessionCount ?? 0), 0);
  const liveCount = studies.filter((s) => s.status === 'live').length;
  const guide = params.get('guide') === '1';

  return (
    <div className="mx-auto max-w-[1120px] px-8 py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[34px] font-bold leading-tight tracking-[-0.022em]">Studies</h1>
          <p className="mt-1 text-[15px] text-secondary">
            {greeting()}, {user?.name?.split(' ')[0] || 'there'}.
            {studies.length > 0 && <> {liveCount} live · {totalSessions} session{totalSessions !== 1 ? 's' : ''} in total.</>}
          </p>
        </div>
        <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)} data-testid="new-study">
          New study
        </Button>
      </div>

      {studies.length > 0 && (
        <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
          <Segmented<Filter>
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'live', label: 'Live' },
              { value: 'draft', label: 'Draft' },
              { value: 'paused', label: 'Paused' },
              { value: 'closed', label: 'Closed' },
            ]}
          />
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-tertiary" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className="h-8 rounded-full border-transparent bg-black/[0.05] pl-9 focus:bg-white" />
          </div>
        </div>
      )}

      <div className="mt-4">
        {loading && !data ? (
          <div className="flex justify-center py-20"><Spinner /></div>
        ) : error ? (
          <Callout tone="error" title="Could not load studies">{errorMessage(error)} <button className="text-brand-500" onClick={() => reload()}>Try again</button></Callout>
        ) : studies.length === 0 ? (
          <FirstRun onCreate={() => setCreating(true)} />
        ) : shown.length === 0 ? (
          <div className="rounded-[18px] bg-surface py-12 text-center text-[15px] text-secondary ring-1 ring-black/[0.04]">No studies match.</div>
        ) : (
          <div className="overflow-hidden rounded-[18px] bg-surface ring-1 ring-black/[0.04]">
            <div className="hidden grid-cols-[minmax(0,1fr)_100px_140px_80px_110px] gap-4 border-b border-separator px-5 py-2.5 text-[12px] font-medium text-secondary md:grid">
              <span>Name</span><span>Status</span><span>Sessions</span><span>Variants</span><span className="text-right">Last activity</span>
            </div>
            <ul>
              {shown.map((s, i) => <StudyRow key={s.id} s={s} first={i === 0} />)}
            </ul>
          </div>
        )}
      </div>

      <CreateStudyModal open={creating} onClose={() => { setCreating(false); if (params.get('new')) setParams({}); }} />
      <GuideModal open={guide} onClose={() => setParams({})} />
    </div>
  );
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function StudyRow({ s, first }: { s: StudySummary; first: boolean }) {
  const last = Math.max(s.lastSessionAt ?? 0, s.updatedAt);
  return (
    <li className={cn('relative', !first && 'before:absolute before:left-5 before:right-0 before:top-0 before:h-px before:bg-separator')}>
      <Link to={`/studies/${s.id}`} className="group grid grid-cols-1 items-center gap-1 px-5 py-3.5 transition-colors hover:bg-black/[0.02] md:grid-cols-[minmax(0,1fr)_100px_140px_80px_110px] md:gap-4" data-testid="study-row">
        <div className="min-w-0">
          <div className="truncate text-[15px] font-medium text-label">{s.name}</div>
          <div className="truncate text-[13px] text-secondary">{s.description || 'No description'}</div>
        </div>
        <div><StatusBadge status={s.status} /></div>
        <div className="text-[13px] tabular-nums text-secondary">
          <span className="text-label">{s.completedCount ?? 0}</span> of {s.sessionCount ?? 0} completed
        </div>
        <div className="text-[13px] tabular-nums text-secondary">{s.variantCount ?? 0}</div>
        <div className="flex items-center justify-end gap-1 text-[13px] text-secondary">
          {timeAgo(last)}
          <ChevronRight className="size-4 text-tertiary" />
        </div>
      </Link>
    </li>
  );
}

function FirstRun({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="mt-6 rounded-[22px] bg-surface px-10 py-14 ring-1 ring-black/[0.04]">
      <div className="max-w-[560px]">
        <h2 className="text-[28px] font-semibold leading-tight tracking-[-0.02em]">Create your first study.</h2>
        <p className="mt-3 text-[17px] leading-relaxed text-secondary">
          A study holds the protocol the moderator follows, the app being tested, A/B variants and the links you share. Every new study comes with a starter protocol you can edit.
        </p>
        <Button className="mt-6" size="lg" onClick={onCreate} data-testid="new-study-empty">New study</Button>
      </div>
      <ol className="mt-12 grid gap-6 border-t border-separator pt-8 sm:grid-cols-4">
        {[
          ['Write the protocol', 'Tasks, questions and questionnaires. Or describe your goals and let AI draft it.'],
          ['Add your app', 'Upload a .zip, connect git or paste a URL.'],
          ['Share a link', 'Works with Prolific and other panels.'],
          ['Read the results', 'Replays, metrics and findings with sources.'],
        ].map(([t, d], i) => (
          <li key={t}>
            <div className="text-[13px] tabular-nums text-tertiary">{i + 1}</div>
            <div className="mt-1 text-[15px] font-medium">{t}</div>
            <div className="mt-1 text-[13px] leading-relaxed text-secondary">{d}</div>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function CreateStudyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [template, setTemplate] = useState<'starter' | 'blank'>('starter');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    if (!name.trim()) return setErr('Give your study a name.');
    setBusy(true);
    setErr('');
    try {
      const { study } = await rApi.createStudy({ name: name.trim(), description: description.trim(), template });
      notifyStudiesChanged();
      toast('Study created');
      onClose();
      setName('');
      setDescription('');
      nav(`/studies/${study.id}`);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New study"
      width="max-w-xl"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={busy} data-testid="create-study-submit">Create study</Button>
        </>
      }
    >
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Field label="Study name">
          <Input autoFocus name="study-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Checkout redesign — round 1" />
        </Field>
        <Field label="Description" hint="Optional. Only visible to your team.">
          <Textarea name="study-description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What are you trying to learn?" />
        </Field>
        <div>
          <span className="mb-1.5 block text-[13px] font-medium text-secondary">Start from</span>
          <div className="grid gap-3 sm:grid-cols-2">
            {([
              ['starter', 'Starter protocol', 'Warm-up, first impressions, two tasks with SEQ, SUS and a wrap-up interview.'],
              ['blank', 'Blank', 'Start empty. Write steps yourself or generate them with AI.'],
            ] as const).map(([v, t, d]) => (
              <button
                type="button"
                key={v}
                onClick={() => setTemplate(v)}
                className={cn('rounded-[14px] p-4 text-left ring-1 transition-shadow duration-200', template === v ? 'ring-2 ring-brand-500' : 'ring-black/10 hover:ring-black/20')}
              >
                <div className="flex items-center gap-2 text-[15px] font-medium">
                  <span className={cn('grid size-[18px] place-items-center rounded-full ring-1', template === v ? 'bg-brand-500 ring-brand-500' : 'ring-black/20')}>{template === v && <span className="size-1.5 rounded-full bg-white" />}</span>
                  {t}
                </div>
                <div className="mt-1.5 pl-[26px] text-[13px] leading-relaxed text-secondary">{d}</div>
              </button>
            ))}
          </div>
        </div>
        {err && <p className="text-[13px] text-sys-red">{err}</p>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function GuideModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const steps = [
    ['Write or generate the protocol', 'Open the Protocol tab. Each task needs a neutral, scenario-based instruction and hidden success criteria. Add success rules (for example, URL matches ^/checkout/done) so outcomes are detected automatically. Run the methodology check before launch.'],
    ['Add the app you’re testing', 'In App builds, upload a .zip of your project or paste a URL. We detect Vite, CRA, Next.js static export and Expo web, then build the project. Hosted builds are instrumented automatically.'],
    ['Set up variants', 'Variant A is created for you. To run an A/B test, add a variant with a different app build or protocol. Each participant sees only one variant.'],
    ['Preview, then go live', 'Use Preview to take the session yourself. Preview sessions are left out of results. Then click Go live and share the link from Recruit.'],
    ['Read the results', 'Results shows each session with replay and transcript in sync, task metrics with confidence intervals, variant comparisons and AI synthesis.'],
  ] as const;
  return (
    <Modal open={open} onClose={onClose} title="Getting started" width="max-w-2xl" footer={<Button onClick={onClose}>Done</Button>}>
      <ol className="space-y-5">
        {steps.map(([t, d], i) => (
          <li key={i} className="flex gap-4">
            <span className="w-5 shrink-0 pt-px text-right text-[15px] tabular-nums text-tertiary">{i + 1}</span>
            <div>
              <div className="text-[15px] font-semibold">{t}</div>
              <p className="mt-0.5 text-[14px] leading-relaxed text-secondary">{d}</p>
            </div>
          </li>
        ))}
      </ol>
    </Modal>
  );
}
