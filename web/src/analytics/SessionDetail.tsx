import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ChevronLeft, ChevronRight, Lock, Trash2, X } from 'lucide-react';
import type { SessionEvent, Step, TaskOutcome, TaskStep } from '@thinkaloud/shared';
import { seqQuestion, stepQuestions } from '@thinkaloud/shared';
import { api } from '../lib/api.ts';
import { useApiMediaUrl, useAsync } from '../lib/hooks.ts';
import { Button, FullPageSpinner, Modal, cn } from '../ui/index.tsx';
import { useToast } from '../ui/toast.tsx';
import { ResultsNav, useResults } from './ResultsRoutes.tsx';
import { Dot, Empty, Panel, Segmented } from './components.tsx';
import { clock, infoText, OUTCOME_META, secs, susGrade } from './format.ts';
import { Controls, Stage, Timeline, usePlayerClock, type PlayerClock } from './Player.tsx';
import type { FlatPoint, Note, SessionDetail as Detail } from './types.ts';

export default function SessionDetail() {
  const { sessionId = '' } = useParams();
  const { data, error, loading, reload, setData } = useAsync(() => api.get<Detail>(`/api/sessions/${sessionId}`), [sessionId]);
  if (loading && !data) return <FullPageSpinner />;
  if (error || !data)
    return (
      <div className="mx-auto max-w-[1200px] px-10 py-10">
        <Empty title="Session not found">{error?.message}</Empty>
      </div>
    );
  return <Loaded key={sessionId} d={data} reload={reload} setData={setData} />;
}

interface RREvent {
  type: number;
  timestamp: number;
}

function Loaded({ d, reload, setData }: { d: Detail; reload: () => void; setData: (d: Detail) => void }) {
  const { base } = useResults();
  const nav = useNavigate();
  const toast = useToast();
  const [params] = useSearchParams();
  const sid = d.session.id;
  const startedAt = d.session.startedAt ?? d.session.createdAt;

  const replayQ = useAsync(() => (d.hasReplay ? api.get<RREvent[]>(`/api/sessions/${sid}/replay`) : Promise.resolve(null)), [sid]);
  const mouseQ = useAsync(() => (d.pointBatches.mouse ? api.get<{ points: FlatPoint[] }>(`/api/sessions/${sid}/points?kind=mouse`) : Promise.resolve({ points: [] })), [sid]);
  const gazeQ = useAsync(() => (d.pointBatches.gaze ? api.get<{ points: FlatPoint[] }>(`/api/sessions/${sid}/points?kind=gaze`) : Promise.resolve({ points: [] })), [sid]);
  const replay = replayQ.data ?? null;

  const lastEventT = d.events.length ? d.events[d.events.length - 1].t : 0;
  const replayDur = replay && replay.length ? replay[replay.length - 1].timestamp - startedAt : 0;
  const duration = Math.max(d.durationMs ?? 0, lastEventT, replayDur, 1000);

  const audioRef = useRef<HTMLAudioElement>(null);
  const audioTrack = d.audioTracks[0];
  const audioSrc = useApiMediaUrl(audioTrack ? `/api/sessions/${sid}/audio?track=${audioTrack}` : null);
  const audioStart = useMemo(() => {
    const e = d.events.find((x) => x.kind === 'media.audio_start' && (!(x.data as { track?: string }).track || (x.data as { track?: string }).track === audioTrack));
    return e ? Number((e.data as { t?: number }).t ?? e.t) : 0;
  }, [d.events, audioTrack]);
  const initialT = Number(params.get('t') ?? 0) || 0;
  const c = usePlayerClock(duration, initialT, audioRef, audioStart);
  const [audioState, setAudioState] = useState(audioTrack ? 'Loading audio…' : 'No audio');

  const [showMouse, setShowMouse] = useState(true);
  const [showGaze, setShowGaze] = useState(true);
  const [captions, setCaptions] = useState(true);
  const [pane, setPane] = useState<'transcript' | 'events' | 'notes'>('transcript');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const viewport = { w: d.session.device?.viewportW ?? 1280, h: d.session.device?.viewportH ?? 800 };

  // Space toggles play
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.code === 'Space') {
        e.preventDefault();
        c.toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [c]);

  const steps = d.steps;
  const del = async () => {
    await api.del(`/api/sessions/${sid}`);
    toast('Session deleted');
    nav(`${base}/sessions`);
  };
  const statusText = d.effectiveStatus.replace('_', ' ');
  const date = new Date(startedAt);
  return (
    <div className="mx-auto max-w-[1480px] px-6 pb-16 pt-8 lg:px-10">
      <div className="mb-4">
        <ResultsNav />
      </div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link to={`${base}/sessions`} className="mb-1 inline-flex items-center gap-0.5 text-[13px] text-brand-500 hover:underline">
            <ChevronLeft className="size-3.5" strokeWidth={2} /> Sessions
          </Link>
          <h1 className="text-[34px] font-bold leading-tight tracking-[-0.022em] text-label">{d.session.participantCode}</h1>
          <p className="mt-1 text-[15px] text-secondary tabular-nums">
            {d.variantName ?? 'Unknown variant'} · <span className="capitalize">{statusText}</span> · {date.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })} at{' '}
            {date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} · {secs(d.durationMs)}
            {d.session.device && ` · ${d.session.device.viewportW}×${d.session.device.viewportH}`}
            {d.session.preview && ' · Preview'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" disabled={!d.prevSessionId} onClick={() => nav(`${base}/sessions/${d.prevSessionId}`)} icon={<ChevronLeft className="size-3.5" strokeWidth={2} />}>
            Newer
          </Button>
          <Button variant="secondary" size="sm" disabled={!d.nextSessionId} onClick={() => nav(`${base}/sessions/${d.nextSessionId}`)}>
            Older <ChevronRight className="size-3.5" strokeWidth={2} />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(true)} aria-label="Delete session" className="text-sys-red hover:bg-sys-red/10">
            <Trash2 className="size-4" strokeWidth={1.75} />
          </Button>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0 space-y-6">
          {/* Player */}
          <div className="overflow-hidden rounded-[22px] bg-[#0b0b0c] shadow-[0_8px_40px_rgba(0,0,0,.18)]">
            <div className="relative aspect-[16/10] w-full bg-[#141416] p-5">
              <Stage
                clock={c}
                replay={replay as never}
                startedAt={startedAt}
                points={{ mouse: mouseQ.data?.points ?? [], gaze: gazeQ.data?.points ?? [] }}
                showMouse={showMouse}
                showGaze={showGaze}
                events={d.events}
                viewport={viewport}
              />
              {captions && <CurrentCaption events={d.events} t={c.t} />}
            </div>
            <div className="material-dark border-t border-white/[0.06] px-5 pb-4 pt-3">
              <Timeline clock={c} events={d.events} steps={steps} results={d.taskResults} notes={d.notes} />
              <div className="mt-2">
                <Controls
                  clock={c}
                  showMouse={showMouse}
                  setShowMouse={setShowMouse}
                  showGaze={showGaze}
                  setShowGaze={setShowGaze}
                  hasGaze={d.pointBatches.gaze > 0}
                  hasMouse={d.pointBatches.mouse > 0 && !replay}
                  audioState={audioState}
                  captions={captions}
                  setCaptions={setCaptions}
                />
              </div>
            </div>
            {audioTrack && (
              <audio
                ref={audioRef}
                preload="auto"
                src={audioSrc}
                onCanPlay={() => setAudioState(audioTrack === 'mixed' ? 'Audio: participant + moderator' : 'Audio: participant')}
                onError={() => setAudioState('Audio unavailable')}
              />
            )}
          </div>

          <StepsPanel d={d} c={c} onChanged={reload} />
          <ParticipantPanel d={d} />
          <AnswersPanel d={d} />
        </div>

        {/* Side panes */}
        <div className="min-w-0">
          <Panel className="flex h-[calc(100vh-140px)] min-h-[560px] flex-col overflow-hidden xl:sticky xl:top-6">
            <div className="flex items-center justify-between gap-2 border-b border-separator px-4 py-3">
              <Segmented
                size="sm"
                options={[
                  { value: 'transcript', label: 'Transcript' },
                  { value: 'events', label: 'Events' },
                  { value: 'notes', label: `Notes${d.notes.length ? ` ${d.notes.length}` : ''}` },
                ]}
                value={pane}
                onChange={setPane}
              />
            </div>
            <div className="min-h-0 flex-1">
              {pane === 'transcript' && <TranscriptPane events={d.events} c={c} />}
              {pane === 'events' && <EventsPane events={d.events} steps={steps} c={c} />}
              {pane === 'notes' && <NotesPane d={d} c={c} onChange={(notes) => setData({ ...d, notes })} />}
            </div>
          </Panel>
        </div>
      </div>

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this session?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={del}>
              Delete
            </Button>
          </>
        }
      >
        <p className="text-[15px] text-secondary">The recording, transcript, answers and notes for {d.session.participantCode} are removed permanently. This can't be undone.</p>
      </Modal>
    </div>
  );
}

// ── Caption overlay ─────────────────────────────────────────────────────────

function CurrentCaption({ events, t }: { events: SessionEvent[]; t: number }) {
  const line = useMemo(() => {
    let cur: SessionEvent | null = null;
    for (const e of events) {
      if (e.kind !== 'transcript.participant' && e.kind !== 'transcript.moderator') continue;
      const st = Number((e.data as { startT?: number }).startT ?? e.t);
      const en = Number((e.data as { endT?: number }).endT ?? st + 4000);
      if (st <= t && t <= en + 600) cur = e;
      if (st > t) break;
    }
    return cur;
  }, [events, t]);
  if (!line) return null;
  const isP = line.kind === 'transcript.participant';
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-10">
      <div className="max-w-[80%] rounded-[12px] bg-black/75 px-4 py-1.5 text-center text-[14px] leading-snug text-white backdrop-blur-xl">
        <span className={cn('mr-2 text-[11px] font-semibold uppercase tracking-wide', isP ? 'text-[#64d2ff]' : 'text-white/50')}>{isP ? 'Participant' : 'Moderator'}</span>
        {String((line.data as { text?: string }).text ?? '')}
      </div>
    </div>
  );
}

// ── Transcript ──────────────────────────────────────────────────────────────

function TranscriptPane({ events, c }: { events: SessionEvent[]; c: PlayerClock }) {
  const lines = useMemo(
    () =>
      events
        .filter((e) => e.kind === 'transcript.participant' || e.kind === 'transcript.moderator')
        .map((e) => ({ t: Number((e.data as { startT?: number }).startT ?? e.t), p: e.kind === 'transcript.participant', text: String((e.data as { text?: string }).text ?? ''), stepId: e.stepId })),
    [events],
  );
  const [q, setQ] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const userScroll = useRef(0);
  let current = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i].t <= c.t) current = i;
  useEffect(() => {
    if (Date.now() - userScroll.current < 4000 || current < 0 || q) return;
    const el = box.current?.querySelector<HTMLElement>(`[data-i="${current}"]`);
    if (el && box.current) {
      const b = box.current;
      const top = el.offsetTop - b.clientHeight / 3;
      b.scrollTo({ top, behavior: 'smooth' });
    }
  }, [current, q]);
  const shown = q.trim() ? lines.map((l, i) => ({ ...l, i })).filter((l) => l.text.toLowerCase().includes(q.trim().toLowerCase())) : lines.map((l, i) => ({ ...l, i }));
  if (!lines.length) return <div className="p-6 text-[13px] text-tertiary">No transcript for this session.</div>;
  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pt-3">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search transcript" className="h-8 w-full rounded-[9px] bg-fill px-3 text-[13px] outline-none placeholder:text-tertiary focus:ring-4 focus:ring-brand-500/20" />
      </div>
      <div ref={box} className="relative min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 py-3" onWheel={() => (userScroll.current = Date.now())}>
        {shown.map((l) => (
          <button
            key={l.i}
            data-i={l.i}
            onClick={() => c.seek(l.t)}
            className={cn(
              'group flex w-full gap-3 rounded-[12px] px-2.5 py-2 text-left transition-colors duration-200',
              l.i === current ? 'bg-brand-500/[0.08]' : 'hover:bg-black/[0.03]',
            )}
          >
            <span className={cn('w-10 shrink-0 pt-px text-[12px] tabular-nums', l.i === current ? 'text-brand-500' : 'text-tertiary')}>{clock(l.t)}</span>
            <span className="min-w-0">
              <span className={cn('block text-[11px] font-semibold', l.p ? 'text-label' : 'text-tertiary')}>{l.p ? 'Participant' : 'Moderator'}</span>
              <span className={cn('block text-[14px] leading-snug', l.p ? 'text-label' : 'text-secondary')}>{l.text}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Events ──────────────────────────────────────────────────────────────────

const GROUPS = {
  all: { label: 'All', test: (_k: string) => true },
  behaviour: { label: 'Behaviour', test: (k: string) => k.startsWith('app.') },
  issues: { label: 'Issues', test: (k: string) => ['app.error', 'app.network_error', 'app.crash', 'app.rage_click', 'app.dead_click', 'app.console_error'].includes(k) },
  protocol: { label: 'Protocol', test: (k: string) => k.startsWith('step.') || k.startsWith('task.') || k === 'answer' || k.startsWith('moderator.') },
} as const;

const KIND_LABEL: Record<string, string> = {
  'app.click': 'Click',
  'app.dead_click': 'Dead click',
  'app.rage_click': 'Rage click',
  'app.navigate': 'Navigate',
  'app.input': 'Input',
  'app.change': 'Change',
  'app.scroll': 'Scroll',
  'app.error': 'Error',
  'app.console_error': 'Console error',
  'app.network_error': 'Network error',
  'app.crash': 'Crash',
  'app.custom': 'Custom event',
  'app.ready': 'App ready',
  'step.enter': 'Step',
  'step.exit': 'Step exit',
  'task.start': 'Task start',
  'task.end': 'Task end',
  answer: 'Answer',
  'moderator.probe': 'Probe',
  'moderator.nudge': 'Nudge',
  'task.assist': 'Assistance',
  'moderator.tool': 'Moderator tool',
  'session.start': 'Session start',
  'session.end': 'Session end',
  'eyetracking.calibrated': 'Eye tracking calibrated',
  'media.audio_start': 'Audio started',
};
const KIND_COLOR: Record<string, string> = {
  'app.error': '#ff3b30',
  'app.network_error': '#ff3b30',
  'app.crash': '#ff3b30',
  'app.console_error': '#ff3b30',
  'app.rage_click': '#ff9f0a',
  'app.dead_click': '#ffcc00',
  'task.start': '#0071e3',
  'task.end': '#0071e3',
  'moderator.probe': '#5ac8fa',
  'moderator.nudge': '#a2a2f0',
  'task.assist': '#ff9f0a',
};

function describe(e: SessionEvent, steps: Map<string, Step>): string {
  const d = e.data as Record<string, unknown>;
  const el = d.el as { text?: string; selector?: string } | undefined;
  switch (e.kind) {
    case 'app.click':
    case 'app.dead_click':
    case 'app.rage_click':
      return `${el?.text ? `“${el.text}”` : ''} ${el?.selector ? el.selector : ''}`.trim();
    case 'app.navigate':
      return String(d.path ?? '');
    case 'app.error':
    case 'app.console_error':
    case 'app.crash':
      return String(d.message ?? '');
    case 'app.network_error':
      return `${d.method ?? ''} ${d.url ?? ''} ${d.status ?? ''}`.trim();
    case 'app.input':
      return String(d.selector ?? '');
    case 'app.custom':
      return String(d.name ?? '');
    case 'step.enter':
    case 'task.start':
      return steps.get(e.stepId ?? '')?.title ?? e.stepId ?? '';
    case 'task.end':
      return `${steps.get(e.stepId ?? '')?.title ?? ''} · ${OUTCOME_META[d.outcome as TaskOutcome]?.label ?? d.outcome}`;
    case 'answer':
      return `${d.questionId}${d.value != null ? ` = ${d.value}` : ''}${d.text ? ` “${String(d.text).slice(0, 60)}”` : ''}`;
    case 'moderator.probe':
    case 'moderator.nudge':
      return String(d.text ?? '');
    case 'task.assist':
      return `${d.level === 'direct' ? 'Direct cue' : 'General prompt'}: “${String(d.text ?? '').slice(0, 80)}”`;
    default:
      return '';
  }
}

function EventsPane({ events, steps, c }: { events: SessionEvent[]; steps: Step[]; c: PlayerClock }) {
  const [g, setG] = useState<keyof typeof GROUPS>('all');
  const stepMap = useMemo(() => new Map(steps.map((s) => [s.id, s])), [steps]);
  const rows = useMemo(() => events.filter((e) => !e.kind.startsWith('transcript.') && !['speech.start', 'speech.stop'].includes(e.kind) && GROUPS[g].test(e.kind)), [events, g]);
  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pt-3">
        <Segmented size="sm" options={Object.entries(GROUPS).map(([k, v]) => ({ value: k as keyof typeof GROUPS, label: v.label }))} value={g} onChange={setG} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {rows.map((e, i) => (
          <button key={i} onClick={() => c.seek(e.t)} className={cn('flex w-full items-baseline gap-3 rounded-[10px] px-2.5 py-1.5 text-left text-[13px] hover:bg-black/[0.03]', Math.abs(e.t - c.t) < 600 && 'bg-brand-500/[0.07]')}>
            <span className="w-10 shrink-0 text-[12px] tabular-nums text-tertiary">{clock(e.t)}</span>
            <span className="inline-flex w-28 shrink-0 items-center gap-1.5 text-secondary">
              <Dot color={KIND_COLOR[e.kind] ?? '#c7c7cc'} />
              {KIND_LABEL[e.kind] ?? e.kind}
            </span>
            <span className="min-w-0 truncate text-label">{describe(e, stepMap)}</span>
          </button>
        ))}
        {!rows.length && <div className="p-4 text-[13px] text-tertiary">No events in this group.</div>}
      </div>
    </div>
  );
}

// ── Notes ───────────────────────────────────────────────────────────────────

const PRESET_TAGS = ['pain point', 'quote', 'bug', 'positive', 'confusion'];

function NotesPane({ d, c, onChange }: { d: Detail; c: PlayerClock; onChange: (n: Note[]) => void }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const r = await api.post<{ note: Note }>(`/api/sessions/${d.session.id}/notes`, { t: Math.round(c.tRef.current), text, tags });
      onChange([...d.notes, r.note].sort((a, b) => a.t - b.t));
      setText('');
      setTags([]);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const remove = async (n: Note) => {
    await api.del(`/api/notes/${n.id}`);
    onChange(d.notes.filter((x) => x.id !== n.id));
  };
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-separator p-4">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && save()}
          placeholder={`Note at ${clock(c.t)}`}
          rows={3}
          className="block w-full resize-none rounded-[12px] bg-fill px-3 py-2 text-[14px] text-label outline-none placeholder:text-tertiary focus:ring-4 focus:ring-brand-500/20"
        />
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {PRESET_TAGS.map((t) => (
            <button
              key={t}
              onClick={() => setTags((x) => (x.includes(t) ? x.filter((y) => y !== t) : [...x, t]))}
              className={cn('rounded-full px-2.5 py-0.5 text-[12px] font-medium transition-colors', tags.includes(t) ? 'bg-label text-white' : 'bg-fill text-secondary hover:text-label')}
            >
              {t}
            </button>
          ))}
          <Button size="sm" className="ml-auto" onClick={save} loading={busy} disabled={!text.trim()}>
            Add at {clock(c.t)}
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {d.notes.map((n) => (
          <div key={n.id} className="group flex gap-3 rounded-[12px] px-2.5 py-2 hover:bg-black/[0.03]">
            <button onClick={() => c.seek(n.t)} className="w-10 shrink-0 pt-px text-left text-[12px] tabular-nums text-brand-500 hover:underline">
              {clock(n.t)}
            </button>
            <div className="min-w-0 flex-1">
              <p className="whitespace-pre-wrap text-[14px] leading-snug text-label">{n.text}</p>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-tertiary">
                {n.tags.map((t) => (
                  <span key={t} className="rounded-full bg-fill px-2 py-px text-secondary">
                    {t}
                  </span>
                ))}
                {n.authorName && <span>{n.authorName}</span>}
              </div>
            </div>
            <button onClick={() => remove(n)} className="self-start rounded-full p-1 text-tertiary opacity-0 transition-opacity hover:bg-black/5 group-hover:opacity-100" aria-label="Delete note">
              <X className="size-3.5" strokeWidth={2} />
            </button>
          </div>
        ))}
        {!d.notes.length && <div className="p-4 text-[13px] text-tertiary">No notes yet. Pause on a moment and write what you notice.</div>}
      </div>
    </div>
  );
}

// ── Steps & tasks ───────────────────────────────────────────────────────────

function StepsPanel({ d, c, onChanged }: { d: Detail; c: PlayerClock; onChanged: () => void }) {
  const toast = useToast();
  const enterT = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of d.events) if ((e.kind === 'step.enter' || e.kind === 'task.start') && e.stepId && !m.has(e.stepId)) m.set(e.stepId, e.t);
    return m;
  }, [d.events]);
  const currentStep = useMemo(() => {
    let cur: string | null = null;
    for (const e of d.events) {
      if (e.t > c.t) break;
      if (e.kind === 'step.enter' && e.stepId) cur = e.stepId;
    }
    return cur;
  }, [d.events, c.t]);
  const override = async (stepId: string, outcome: TaskOutcome) => {
    try {
      await api.put(`/api/sessions/${d.session.id}/tasks/${stepId}`, { outcome });
      toast('Outcome updated');
      onChanged();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const seqOf = (stepId: string) => d.answers.find((a) => a.stepId === stepId && a.questionId === 'seq')?.value;
  return (
    <Panel>
      <div className="px-6 pb-2 pt-5">
        <h2 className="text-[17px] font-semibold tracking-[-0.015em] text-label">Steps</h2>
        <p className="mt-0.5 text-[13px] text-secondary">Click a step to jump there. Task outcomes can be corrected; your override is used in all results.</p>
      </div>
      <div className="px-3 pb-3">
        {d.steps.map((s, i) => {
          const r = d.taskResults.find((x) => x.stepId === s.id);
          const t = enterT.get(s.id);
          const isTask = s.type === 'task';
          const seq = isTask ? seqOf(s.id) : undefined;
          return (
            <div key={s.id} className={cn('flex items-center gap-4 rounded-[12px] px-3 py-2.5 transition-colors', currentStep === s.id ? 'bg-brand-500/[0.07]' : 'hover:bg-black/[0.025]')}>
              <span className="w-5 text-right text-[12px] tabular-nums text-tertiary">{i + 1}</span>
              <button className="min-w-0 flex-1 text-left disabled:cursor-default" disabled={t == null} onClick={() => t != null && c.seek(t)}>
                <div className="truncate text-[14px] font-medium text-label">{s.title}</div>
                <div className="truncate text-[12px] text-tertiary">
                  {stepKind(s)}
                  {t != null ? ` · ${clock(t)}` : ' · not reached'}
                  {r && ` · ${secs(r.durationMs)}`}
                  {seq != null && ` · SEQ ${seq}/7`}
                  {r?.completionScore != null && ` · Score ${r.completionScore}`}
                  {r?.assistance && (r.assistance.general || r.assistance.direct) ? ` (${assistText(r.assistance)})` : ''}
                </div>
              </button>
              {isTask && (
                <div className="flex shrink-0 items-center gap-2">
                  {r && (
                    <span className="hidden text-[12px] text-tertiary md:inline" title={r.evidence}>
                      {r.source === 'researcher' ? 'Your override' : `by ${r.source}`}
                    </span>
                  )}
                  <span className="relative inline-flex items-center">
                    <Dot color={r ? OUTCOME_META[r.outcome].color : '#d1d1d6'} className="pointer-events-none absolute left-2.5" />
                    <select
                      value={r?.outcome ?? ''}
                      onChange={(e) => override(s.id, e.target.value as TaskOutcome)}
                      className="h-7 appearance-none rounded-full bg-fill pl-6 pr-3 text-[12px] font-medium text-label outline-none focus:ring-4 focus:ring-brand-500/20"
                      aria-label={`Outcome for ${s.title}`}
                    >
                      {!r && <option value="">No result</option>}
                      {(Object.keys(OUTCOME_META) as TaskOutcome[]).map((o) => (
                        <option key={o} value={o}>
                          {OUTCOME_META[o].label}
                        </option>
                      ))}
                    </select>
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {d.steps.some((s) => s.type === 'task' && (s as TaskStep).successCriteria) && (
        <details className="border-t border-separator px-6 py-3 text-[13px] text-secondary">
          <summary className="cursor-pointer text-[13px] font-medium text-label">Success criteria</summary>
          <ul className="mt-2 space-y-1.5">
            {d.steps
              .filter((s): s is TaskStep => s.type === 'task')
              .map((s) => (
                <li key={s.id}>
                  <span className="text-label">{s.title}:</span> {s.successCriteria}
                </li>
              ))}
          </ul>
        </details>
      )}
    </Panel>
  );
}

function assistText(a: { general: number; direct: number }) {
  const parts = [];
  if (a.general) parts.push(`${a.general} general prompt${a.general > 1 ? 's' : ''}`);
  if (a.direct) parts.push('direct cue');
  return parts.join(' + ');
}

function stepKind(s: Step) {
  return s.type === 'questionnaire' ? (s.instrument === 'custom' ? 'Questionnaire' : s.instrument.replace('_', '-')) : s.type.charAt(0).toUpperCase() + s.type.slice(1);
}

// ── Participant ─────────────────────────────────────────────────────────────

function InfoRow({ label, children, pii }: { label: ReactNode; children: ReactNode; pii?: boolean }) {
  return (
    <div className="ml-6 flex items-baseline justify-between gap-6 border-t border-separator py-2.5 pr-6 text-[14px] first:border-t-0">
      <span className="inline-flex shrink-0 items-center gap-1.5 text-secondary">
        {label}
        {pii && (
          <span title="Personal information — left out of exports that exclude personal information">
            <Lock className="size-3 text-tertiary" strokeWidth={1.75} aria-hidden />
            <span className="sr-only">(personal information)</span>
          </span>
        )}
      </span>
      <span className="min-w-0 text-right text-label tabular-nums [overflow-wrap:anywhere]">{children}</span>
    </div>
  );
}

function fmtDay(v: string | number | undefined): string {
  if (v == null || v === '') return '';
  const dt = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00`) : new Date(v);
  return isNaN(dt.getTime()) ? String(v) : dt.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

function ParticipantPanel({ d }: { d: Detail }) {
  const consent = d.session.consent;
  const info = d.session.participantInfo ?? null;
  const fields = d.participantFields?.length ? d.participantFields : (consent?.fields ?? []);
  const hasInfo = fields.length > 0 || (info != null && Object.keys(info).length > 0);
  const hasForm = consent != null && (consent.formVersion != null || consent.signature != null);
  if (!hasInfo && !hasForm) return null;
  // Values for fields that are no longer listed (e.g. removed later) still show, by id.
  const known = new Set(fields.map((f) => f.id));
  const extra = Object.keys(info ?? {}).filter((k) => !known.has(k));
  const sig = consent?.signature;
  const sigDate = fmtDay(sig?.date) || (consent ? fmtDay(consent.acceptedAt) : '');
  const yesNo = (v: boolean) => (v ? 'Yes' : <span className="text-tertiary">No</span>);
  return (
    <Panel>
      <div className="px-6 pb-2 pt-5">
        <h2 className="text-[17px] font-semibold tracking-[-0.015em] text-label">Participant</h2>
        {d.effectiveStatus === 'withdrawn' && <p className="mt-0.5 text-[13px] text-secondary">Withdrew from the study. Their personal information was deleted.</p>}
      </div>
      {hasInfo && (
        <div className="pb-2">
          {fields.map((f) => {
            const v = infoText(info?.[f.id], f.kind);
            return (
              <InfoRow key={f.id} label={f.label} pii={f.pii}>
                {v || <span className="text-tertiary">—</span>}
              </InfoRow>
            );
          })}
          {extra.map((k) => (
            <InfoRow key={k} label={k}>
              {infoText(info?.[k]) || <span className="text-tertiary">—</span>}
            </InfoRow>
          ))}
        </div>
      )}
      {consent && (
        <>
          <div className="border-t border-separator px-6 pb-1 pt-4 text-[12px] font-semibold text-secondary">Consent</div>
          <div className="pb-3">
            {consent.formVersion != null && (
              <InfoRow label="Consent form">
                Version {consent.formVersion}
                {consent.formHash && (
                  <span className="ml-2 font-mono text-[12px] text-tertiary" title={`Content hash ${consent.formHash}`}>
                    {consent.formHash.slice(0, 8)}
                  </span>
                )}
              </InfoRow>
            )}
            <InfoRow label="Signed" pii={sig?.mode === 'typed_name' && !!sig.name}>
              {sig?.mode === 'typed_name' && sig.name ? <span className="italic">{sig.name}</span> : 'Agreed by checkbox'}
              {sigDate && <span className="text-secondary"> · {sigDate}</span>}
            </InfoRow>
            <InfoRow label="Voice audio">{yesNo(consent.audio)}</InfoRow>
            <InfoRow label="Screen recording">{yesNo(consent.screen)}</InfoRow>
            <InfoRow label="Eye tracking">{yesNo(consent.eyeTracking)}</InfoRow>
            {consent.ageConfirmed && <InfoRow label="Confirmed 18 or older">Yes</InfoRow>}
          </div>
        </>
      )}
    </Panel>
  );
}

// ── Answers ─────────────────────────────────────────────────────────────────

function AnswersPanel({ d }: { d: Detail }) {
  const prompts = useMemo(() => {
    const m = new Map<string, { prompt: string; max?: number }>();
    // stepQuestions covers every kind, incl. interview questions (ids like "<step>_q1").
    // Standard instruments in the session language (as the participant saw them).
    const lang = d.protocol?.moderation.language;
    for (const st of d.steps) {
      if (st.type === 'task') m.set(`${st.id}:seq`, { prompt: seqQuestion(lang).prompt, max: 7 });
      for (const q of stepQuestions(st, lang)) m.set(`${st.id}:${q.id}`, { prompt: q.prompt, max: q.scale?.max });
    }
    return m;
  }, [d.steps, d.protocol]);
  const titles = new Map(d.steps.map((s) => [s.id, s.title]));
  const groups = useMemo(() => {
    const g = new Map<string, typeof d.answers>();
    for (const a of d.answers) g.set(a.stepId, [...(g.get(a.stepId) ?? []), a]);
    return [...g.entries()];
  }, [d.answers]);
  const scores: ReactNode[] = [];
  if (d.scores.SUS != null) scores.push(<Score key="sus" label="SUS" value={d.scores.SUS.toFixed(1)} sub={susGrade(d.scores.SUS).adjective} />);
  if (d.scores.UMUX_LITE != null) scores.push(<Score key="umux" label="UMUX-Lite" value={d.scores.UMUX_LITE.toFixed(1)} />);
  if (d.scores.NASA_TLX != null) scores.push(<Score key="tlx" label="NASA-TLX" value={d.scores.NASA_TLX.toFixed(1)} sub="workload" />);
  if (d.scores.NPS != null) scores.push(<Score key="nps" label="Recommend" value={`${d.scores.NPS}/10`} sub={d.scores.NPS >= 9 ? 'Promoter' : d.scores.NPS >= 7 ? 'Passive' : 'Detractor'} />);
  if (!d.answers.length) return null;
  return (
    <Panel>
      <div className="px-6 pb-2 pt-5">
        <h2 className="text-[17px] font-semibold tracking-[-0.015em] text-label">Answers</h2>
      </div>
      {scores.length > 0 && <div className="flex flex-wrap gap-x-10 gap-y-3 px-6 pb-4 pt-2">{scores}</div>}
      <div className="divide-y divide-separator border-t border-separator">
        {groups.map(([stepId, as]) => {
          const compact = as.length > 3 && as.every((a) => a.value != null && !a.text);
          return (
            <div key={stepId} className="px-6 py-4">
              <div className="mb-2 text-[12px] font-semibold text-secondary">{titles.get(stepId) ?? stepId}</div>
              {compact ? (
                <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
                  {as.map((a) => {
                    const p = prompts.get(`${stepId}:${a.questionId}`);
                    return (
                      <div key={a.questionId} className="flex items-baseline justify-between gap-3 text-[13px]">
                        <span className="min-w-0 truncate text-secondary" title={p?.prompt}>
                          {p?.prompt ?? a.questionId}
                        </span>
                        <span className="shrink-0 font-medium tabular-nums text-label">
                          {a.value}
                          {p?.max ? <span className="text-tertiary">/{p.max}</span> : null}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="space-y-2.5">
                  {as.map((a) => {
                    const p = prompts.get(`${stepId}:${a.questionId}`);
                    return (
                      <div key={a.questionId} className="text-[14px]">
                        <div className="text-[13px] text-secondary">{p?.prompt ?? a.questionId}</div>
                        <div className="mt-0.5 text-label">
                          {a.value != null && (
                            <span className="mr-2 font-medium tabular-nums">
                              {a.value}
                              {p?.max ? <span className="text-tertiary">/{p.max}</span> : null}
                            </span>
                          )}
                          {!a.declined && a.choices?.join(', ')}
                          {a.declined && <span className="mr-2 text-secondary">Declined</span>}
                          {a.text && <span className="leading-relaxed">“{a.text}”</span>}
                        </div>
                        {a.wording && <div className="mt-0.5 text-[12px] text-tertiary">Wording: {a.wording}</div>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function Score({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="text-[12px] font-medium text-secondary">{label}</div>
      <div className="text-[28px] font-semibold leading-tight tracking-[-0.02em] text-label tabular-nums">{value}</div>
      {sub && <div className="text-[12px] text-tertiary">{sub}</div>}
    </div>
  );
}
