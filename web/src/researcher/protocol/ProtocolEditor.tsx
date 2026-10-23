import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import {
  AlertCircle, AlertTriangle, ArrowDown, ArrowUp, Check, ChevronDown, CloudOff, Copy, FileText, Info, ListChecks, Loader2, MoreHorizontal, PanelRightClose, PanelRightOpen,
  Pencil, Plus, ScrollText, Settings2, ShieldCheck, SlidersHorizontal, Trash2, Wand2, GripVertical,
} from 'lucide-react';
import { emptyProtocol, type InstrumentId, type Protocol, type ProtocolRecord, type Step, type StepType } from '@thinkaloud/shared';
import { api, apiCredentials, apiUrl, authHeaders } from '../../lib/api.ts';
import { Button, cn, Input, Modal, Textarea } from '../../ui/index.tsx';
import { useToast } from '../../ui/toast.tsx';
import { Callout, InlineEdit, KeyHint, Menu, MenuItem } from '../components/index.tsx';
import { errorMessage } from '../lib.ts';
import { useStudy } from '../study/StudyContext.tsx';
import { GenerateModal, RefineModal } from './AiModals.tsx';
import { ScriptPreview } from './ScriptPreview.tsx';
import { ConsentSettingsEditor, GeneralSettings, ModerationSettingsEditor } from './SettingsEditors.tsx';
import { StepEditor } from './StepEditors.tsx';
import { cloneStep, INSTRUMENT_CHOICES, newStep, STEP_META, stepSummary } from './stepMeta.tsx';
import { validateProtocol, type LocalIssue } from './validate.ts';

type Section = 'general' | 'moderation' | 'consent';
type Selection = { kind: 'section'; id: Section } | { kind: 'step'; id: string };
type SaveState = 'saved' | 'dirty' | 'saving' | 'error';
interface ReviewIssue { stepId?: string; severity: 'high' | 'medium' | 'low'; message: string; suggestion: string }

/** /studies/:id/protocols → first protocol. */
export function ProtocolsIndex() {
  const { detail } = useStudy();
  const first = detail.protocols[0];
  if (first) return <Navigate to={first.id} replace />;
  return <CreateFirstProtocol />;
}

function CreateFirstProtocol() {
  const { detail, update } = useStudy();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  return (
    <div className="mx-auto max-w-lg px-6 py-20 text-center">
      <FileText className="mx-auto size-8 text-black/20" />
      <h2 className="mt-3 text-lg font-semibold">No protocol yet</h2>
      <p className="mt-1 text-sm text-secondary">A protocol is the script the AI moderator follows: intro, tasks, questions and closing.</p>
      <Button
        className="mt-5"
        loading={busy}
        icon={<Plus className="size-4" />}
        onClick={async () => {
          setBusy(true);
          try {
            const { protocol } = await api.post<{ protocol: ProtocolRecord }>(`/api/studies/${detail.study.id}/protocols`, { name: 'Protocol A', protocol: emptyProtocol() });
            update((d) => ({ ...d, protocols: [...d.protocols, protocol] }));
            nav(`/studies/${detail.study.id}/protocols/${protocol.id}`, { replace: true });
          } finally {
            setBusy(false);
          }
        }}
      >
        Create protocol
      </Button>
    </div>
  );
}

export default function ProtocolEditorRoute() {
  const { protocolId = '' } = useParams();
  const { detail } = useStudy();
  const rec = detail.protocols.find((p) => p.id === protocolId);
  if (!rec) return <Navigate to={`/studies/${detail.study.id}/protocols`} replace />;
  return <ProtocolEditor key={rec.id} record={rec} />;
}

function useAutosave(record: ProtocolRecord, onSaved: (r: ProtocolRecord) => void) {
  const [draft, setDraftState] = useState({ name: record.name, protocol: record.protocol });
  const [state, setState] = useState<SaveState>('saved');
  const [error, setError] = useState('');
  const latest = useRef(draft);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef(false);
  const again = useRef(false);
  const dirty = useRef(false);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  const save = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (saving.current) {
      again.current = true;
      return;
    }
    saving.current = true;
    again.current = false;
    dirty.current = false;
    setState('saving');
    const snap = latest.current;
    try {
      const { protocol } = await api.put<{ protocol: ProtocolRecord }>(`/api/protocols/${record.id}`, { name: snap.name, protocol: snap.protocol });
      onSavedRef.current(protocol);
      setError('');
      setState(dirty.current ? 'dirty' : 'saved');
    } catch (e) {
      dirty.current = true;
      setError(errorMessage(e));
      setState('error');
    } finally {
      saving.current = false;
      if (again.current) void save();
    }
  }, [record.id]);

  const setDraft = useCallback(
    (fn: (d: typeof draft) => typeof draft) => {
      setDraftState((d) => {
        const n = fn(d);
        latest.current = n;
        return n;
      });
      dirty.current = true;
      setState('dirty');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void save(), 700);
    },
    [save],
  );

  // Flush on unmount; warn on tab close while unsaved.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirty.current || saving.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (dirty.current) {
        const snap = latest.current;
        void fetch(apiUrl(`/api/protocols/${record.id}`), { method: 'PUT', credentials: apiCredentials(), keepalive: true, headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(snap) })
          .then((r) => (r.ok ? r.json() : null))
          .then((j: { protocol?: ProtocolRecord } | null) => j?.protocol && onSavedRef.current(j.protocol))
          .catch(() => {});
      }
    };
  }, [record.id]);

  return { draft, setDraft, state, error, save };
}

function ProtocolEditor({ record }: { record: ProtocolRecord }) {
  const { detail, update } = useStudy();
  const toast = useToast();
  const nav = useNavigate();
  const studyId = detail.study.id;
  const onSaved = useCallback((r: ProtocolRecord) => update((d) => ({ ...d, protocols: d.protocols.map((p) => (p.id === r.id ? r : p)) })), [update]);
  const { draft, setDraft, state, error, save } = useAutosave(record, onSaved);
  const p = draft.protocol;
  const setP = useCallback((fn: (p: Protocol) => Protocol) => setDraft((d) => ({ ...d, protocol: fn(d.protocol) })), [setDraft]);

  const [sel, setSel] = useState<Selection>(() => (record.protocol.steps[0] ? { kind: 'step', id: record.protocol.steps[0].id } : { kind: 'section', id: 'general' }));
  const [panel, setPanel] = useState<'checks' | 'script'>('checks');
  const [panelOpen, setPanelOpen] = useState(true);
  const [genOpen, setGenOpen] = useState(false);
  const [refineOpen, setRefineOpen] = useState(false);
  const [review, setReview] = useState<{ busy: boolean; issues: ReviewIssue[] | null; error?: string }>({ busy: false, issues: null });
  const [protoModal, setProtoModal] = useState<null | 'new'>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const issues = useMemo(() => validateProtocol(p), [p]);
  const issuesByStep = useMemo(() => {
    const m: Record<string, LocalIssue[]> = {};
    for (const i of issues) if (i.stepId) (m[i.stepId] ??= []).push(i);
    return m;
  }, [issues]);
  const selectedStep = sel.kind === 'step' ? p.steps.find((s) => s.id === sel.id) : undefined;
  const usedBy = detail.variants.filter((v) => v.protocolId === record.id);
  const editorRef = useRef<HTMLDivElement>(null);

  const select = (s: Selection) => {
    setSel(s);
    const el = editorRef.current;
    if (el) {
      const top = el.getBoundingClientRect().top;
      // Only scroll when the editor's top is hidden under the sticky toolbar (56px).
      if (top < 56) window.scrollTo({ top: window.scrollY + top - 56, behavior: 'smooth' });
    }
  };

  const updateStep = (s: Step) => setP((pp) => ({ ...pp, steps: pp.steps.map((x) => (x.id === s.id ? s : x)) }));
  const addStep = (type: StepType, instrument?: InstrumentId | 'custom') => {
    const s = newStep(type, p.steps, instrument);
    setP((pp) => {
      const idx = sel.kind === 'step' ? pp.steps.findIndex((x) => x.id === sel.id) : -1;
      const steps = [...pp.steps];
      steps.splice(idx >= 0 ? idx + 1 : steps.length, 0, s);
      return { ...pp, steps };
    });
    setSel({ kind: 'step', id: s.id });
  };
  const removeStep = (id: string) => {
    const idx = p.steps.findIndex((s) => s.id === id);
    const next = p.steps.filter((s) => s.id !== id);
    setP((pp) => ({ ...pp, steps: pp.steps.filter((s) => s.id !== id) }));
    const neighbour = next[Math.min(idx, next.length - 1)];
    setSel(neighbour ? { kind: 'step', id: neighbour.id } : { kind: 'section', id: 'general' });
  };
  const duplicateStep = (id: string) => {
    const idx = p.steps.findIndex((s) => s.id === id);
    const c = cloneStep(p.steps[idx]);
    c.title = `${c.title} (copy)`;
    setP((pp) => {
      const steps = [...pp.steps];
      steps.splice(idx + 1, 0, c);
      return { ...pp, steps };
    });
    setSel({ kind: 'step', id: c.id });
  };
  const moveStep = (from: number, to: number) => {
    if (to < 0 || to >= p.steps.length || from === to) return;
    setP((pp) => {
      const steps = [...pp.steps];
      const [m] = steps.splice(from, 1);
      steps.splice(to, 0, m);
      return { ...pp, steps };
    });
  };

  // Keyboard: Alt+↑/↓ moves the selected step.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || sel.kind !== 'step') return;
      const i = p.steps.findIndex((s) => s.id === sel.id);
      if (e.key === 'ArrowUp') { e.preventDefault(); moveStep(i, i - 1); }
      if (e.key === 'ArrowDown') { e.preventDefault(); moveStep(i, i + 1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const runReview = async () => {
    setPanel('checks');
    setPanelOpen(true);
    setReview({ busy: true, issues: review.issues });
    try {
      const { issues } = await api.post<{ issues: ReviewIssue[] }>('/api/ai/review-protocol', { protocol: p });
      setReview({ busy: false, issues });
      toast(issues.length ? `Methodology check found ${issues.length} issue${issues.length > 1 ? 's' : ''}` : 'Methodology check passed');
    } catch (e) {
      setReview({ busy: false, issues: review.issues, error: errorMessage(e) });
    }
  };

  const applyGenerated = (gen: Protocol, mode: 'replace' | 'append') => {
    if (mode === 'replace') {
      setP(() => gen);
      setSel(gen.steps[0] ? { kind: 'step', id: gen.steps[0].id } : { kind: 'section', id: 'general' });
    } else {
      const added = gen.steps.map(cloneStep);
      setP((pp) => ({ ...pp, steps: [...pp.steps, ...added] }));
      if (added[0]) setSel({ kind: 'step', id: added[0].id });
    }
    toast(mode === 'replace' ? 'Protocol generated' : `${gen.steps.length} steps appended`);
  };

  const duplicateProtocol = async () => {
    await save();
    try {
      const { protocol } = await api.post<{ protocol: ProtocolRecord }>(`/api/protocols/${record.id}/duplicate`);
      update((d) => ({ ...d, protocols: [...d.protocols, protocol] }));
      toast('Protocol duplicated');
      nav(`/studies/${studyId}/protocols/${protocol.id}`);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  const deleteProtocol = async () => {
    try {
      await api.del(`/api/protocols/${record.id}`);
      const rest = detail.protocols.filter((x) => x.id !== record.id);
      update((d) => ({ ...d, protocols: d.protocols.filter((x) => x.id !== record.id) }));
      toast('Protocol deleted');
      nav(rest[0] ? `/studies/${studyId}/protocols/${rest[0].id}` : `/studies/${studyId}/protocols`);
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setDeleteOpen(false);
    }
  };

  const readyApp = detail.apps.find((a) => a.status === 'ready' && a.url);
  const counts = { error: issues.filter((i) => i.level === 'error').length, warning: issues.filter((i) => i.level === 'warning').length };
  const sectionIssues = (s: Section) => issues.filter((i) => i.section === s && i.level !== 'info');

  return (
    <div className="flex flex-col">
      {/* Toolbar */}
      <div className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-separator bg-white/95 px-4 backdrop-blur lg:px-6">
        <Menu
          trigger={({ toggle }) => (
            <button onClick={toggle} className="flex items-center gap-1.5 rounded-[10px] px-2 py-1.5 text-sm text-secondary hover:bg-black/[0.05]" title="Switch protocol">
              <FileText className="size-4" /> <span className="hidden sm:inline">Protocols</span> <ChevronDown className="size-3.5" />
            </button>
          )}
        >
          {(close) => (
            <>
              <div className="px-2.5 pb-1 pt-1.5 text-[12px] font-medium text-secondary">Protocols in this study</div>
              {detail.protocols.map((x) => {
                const vs = detail.variants.filter((v) => v.protocolId === x.id);
                return (
                  <MenuItem key={x.id} icon={x.id === record.id ? <Check className="size-4 text-brand-500" /> : <span className="block size-4" />} onClick={() => { close(); nav(`/studies/${studyId}/protocols/${x.id}`); }} description={`${x.protocol.steps.length} steps${vs.length ? ` · used by ${vs.map((v) => v.name).join(', ')}` : ' · not used by a variant'}`}>
                    {x.name}
                  </MenuItem>
                );
              })}
              <div className="my-1 border-t border-separator" />
              <MenuItem icon={<Plus className="size-4" />} onClick={() => { close(); setProtoModal('new'); }}>New protocol</MenuItem>
              <MenuItem icon={<Copy className="size-4" />} onClick={() => { close(); void duplicateProtocol(); }} description="e.g. to create variant B's protocol">Duplicate this protocol</MenuItem>
              <MenuItem danger icon={<Trash2 className="size-4" />} disabled={usedBy.length > 0} onClick={() => { close(); setDeleteOpen(true); }} description={usedBy.length ? 'Used by a variant, reassign it first' : undefined}>Delete protocol</MenuItem>
            </>
          )}
        </Menu>
        <span className="text-black/20">/</span>
        <InlineEdit value={draft.name} onSave={(name) => setDraft((d) => ({ ...d, name }))} className="max-w-56 py-1 text-sm font-semibold text-label" inputClassName="py-1 text-sm font-semibold" />
        {usedBy.length > 0 && <span className="hidden rounded-full bg-fill px-2 py-0.5 text-xs text-secondary md:inline">Variant {usedBy.map((v) => v.name).join(', ')}</span>}
        <SaveIndicator state={state} error={error} onRetry={save} />
        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="subtle" size="sm" icon={<Wand2 className="size-4" />} onClick={() => setGenOpen(true)} data-testid="ai-generate">
            <span className="hidden md:inline">Generate with AI</span>
          </Button>
          <Button variant="secondary" size="sm" icon={<Pencil className="size-3.5" />} onClick={() => setRefineOpen(true)} disabled={!p.steps.length}>
            <span className="hidden md:inline">Refine</span>
          </Button>
          <Button variant="secondary" size="sm" icon={<ShieldCheck className="size-4" />} loading={review.busy} onClick={runReview} disabled={!p.steps.length}>
            <span className="hidden md:inline">Methodology check</span>
          </Button>
          <button onClick={() => setPanelOpen((o) => !o)} className="hidden rounded-[10px] p-2 text-secondary hover:bg-black/[0.05] xl:block" title={panelOpen ? 'Hide side panel' : 'Show side panel'}>
            {panelOpen ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
          </button>
        </div>
      </div>

      <div className={cn('grid flex-1 grid-cols-1 md:grid-cols-[272px_minmax(0,1fr)]', panelOpen && 'xl:grid-cols-[272px_minmax(0,1fr)_380px]')}>
        {/* Outline */}
        <aside className="border-r border-separator bg-white md:sticky md:top-14 md:h-[calc(100vh-3.5rem)] md:overflow-y-auto">
          <div className="p-3">
            <div className="px-2 pb-1.5 text-[12px] font-medium text-secondary">Settings</div>
            {([
              ['general', <Settings2 key="g" className="size-4" />, 'General', 'Goals, intro and closing'],
              ['moderation', <SlidersHorizontal key="m" className="size-4" />, 'Moderation', `${p.moderation.voice.charAt(0).toUpperCase() + p.moderation.voice.slice(1)} voice, ${p.moderation.probingLevel} probing`],
              ['consent', <ShieldCheck key="c" className="size-4" />, 'Consent', p.consent.recordScreen ? 'Voice and screen replay' : 'Voice only'],
            ] as const).map(([id, icon, label, sub]) => {
              const n = sectionIssues(id).length;
              const active = sel.kind === 'section' && sel.id === id;
              return (
                <button key={id} onClick={() => select({ kind: 'section', id })} className={cn('flex w-full items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-left transition', active ? 'bg-black/[0.06] text-label' : 'text-label hover:bg-black/[0.03]')}>
                  <span className={cn(active ? 'text-brand-500' : 'text-tertiary')}>{icon}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{label}</span>
                    <span className="block truncate text-[12px] text-secondary">{sub}</span>
                  </span>
                  {n > 0 && <span className="size-1.5 rounded-full bg-sys-orange" />}
                </button>
              );
            })}
          </div>
          <div className="border-t border-separator p-3">
            <div className="flex items-center justify-between px-2 pb-1.5">
              <span className="text-[12px] font-medium text-secondary">Steps · {p.steps.length}</span>
              <span className="text-[11px] text-tertiary">~{p.estimatedMinutes} min</span>
            </div>
            <StepList
              steps={p.steps}
              selectedId={sel.kind === 'step' ? sel.id : undefined}
              issues={issuesByStep}
              onSelect={(id) => select({ kind: 'step', id })}
              onMove={moveStep}
            />
            {p.steps.length === 0 && (
              <div className="rounded-[10px] border border-dashed border-black/15 px-3 py-5 text-center text-xs text-secondary">
                No steps yet. Add one below or <button onClick={() => setGenOpen(true)} className="font-medium text-brand-500 hover:underline">generate with AI</button>.
              </div>
            )}
            <AddStepMenu onAdd={addStep} />
          </div>
        </aside>

        {/* Editor */}
        <div className="min-w-0 bg-canvas" ref={editorRef}>
          <div className="mx-auto max-w-3xl px-5 py-6 lg:px-8">
            {sel.kind === 'section' ? (
              <>
                <SectionHeader icon={sel.id === 'general' ? <Settings2 className="size-4" /> : sel.id === 'moderation' ? <SlidersHorizontal className="size-4" /> : <ShieldCheck className="size-4" />} title={sel.id === 'general' ? 'General' : sel.id === 'moderation' ? 'Moderation' : 'Consent'} description={sel.id === 'general' ? 'Protocol-wide settings and the spoken bookends of the session.' : sel.id === 'moderation' ? 'How the AI moderator behaves. Neutrality rules (no hints, no leading questions, no praise) always apply.' : 'Informed consent shown before anything is recorded.'} />
                <SectionIssues issues={sectionIssues(sel.id)} />
                {sel.id === 'general' && <GeneralSettings p={p} onChange={(np) => setP(() => np)} />}
                {sel.id === 'moderation' && <ModerationSettingsEditor p={p} onChange={(np) => setP(() => np)} />}
                {sel.id === 'consent' && <ConsentSettingsEditor p={p} onChange={(np) => setP(() => np)} />}
              </>
            ) : selectedStep ? (
              <StepPane
                key={selectedStep.id}
                step={selectedStep}
                index={p.steps.findIndex((s) => s.id === selectedStep.id)}
                total={p.steps.length}
                issues={issuesByStep[selectedStep.id] ?? []}
                onChange={updateStep}
                onDuplicate={() => duplicateStep(selectedStep.id)}
                onRemove={() => removeStep(selectedStep.id)}
                onMove={(d) => {
                  const i = p.steps.findIndex((s) => s.id === selectedStep.id);
                  moveStep(i, i + d);
                }}
              />
            ) : (
              <div className="py-20 text-center text-sm text-secondary">Select a step on the left.</div>
            )}
          </div>
        </div>

        {/* Side panel */}
        {panelOpen && (
          <aside className="hidden border-l border-separator bg-white xl:sticky xl:top-14 xl:block xl:h-[calc(100vh-3.5rem)] xl:overflow-y-auto">
            <div className="sticky top-0 z-10 flex gap-1 border-b border-separator bg-white px-3 pt-2">
              {([
                ['checks', <ListChecks key="c" className="size-4" />, 'Checks', counts.error + counts.warning],
                ['script', <ScrollText key="s" className="size-4" />, 'Moderator script', undefined],
              ] as const).map(([id, icon, label, n]) => (
                <button key={id} onClick={() => setPanel(id)} className={cn('relative flex items-center gap-1.5 px-2.5 pb-2.5 pt-1.5 text-sm font-medium', panel === id ? 'text-label' : 'text-secondary hover:text-label')}>
                  {icon} {label}
                  {n ? <span className={cn('rounded-full px-1.5 text-[11px]', counts.error ? 'bg-sys-red/10 text-[#d70015]' : 'bg-sys-orange/15 text-[#c93400]')}>{n}</span> : null}
                  {panel === id && <span className="absolute inset-x-1 bottom-0 h-0.5 rounded-full bg-brand-600" />}
                </button>
              ))}
            </div>
            <div className="p-4">
              {panel === 'checks' ? (
                <ChecksPanel
                  issues={issues}
                  steps={p.steps}
                  review={review}
                  onRunReview={runReview}
                  onJump={(i) => (i.stepId && p.steps.some((s) => s.id === i.stepId) ? select({ kind: 'step', id: i.stepId }) : i.section && select({ kind: 'section', id: i.section }))}
                />
              ) : (
                <>
                  <p className="mb-3 text-xs leading-relaxed text-secondary">How the session flows for a participant. Click a step to edit it.</p>
                  <ScriptPreview p={p} activeId={sel.kind === 'step' ? sel.id : undefined} onJump={(id) => select({ kind: 'step', id })} />
                </>
              )}
            </div>
          </aside>
        )}
      </div>

      <GenerateModal open={genOpen} onClose={() => setGenOpen(false)} current={p} defaults={{ productName: detail.study.name, appUrl: readyApp?.url }} onApply={applyGenerated} />
      <RefineModal open={refineOpen} onClose={() => setRefineOpen(false)} current={p} onApply={(np) => { setP(() => np); toast('Changes applied'); }} />
      <NewProtocolModal open={protoModal === 'new'} onClose={() => setProtoModal(null)} />
      <Modal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Delete protocol?"
        footer={<><Button variant="ghost" onClick={() => setDeleteOpen(false)}>Cancel</Button><Button variant="danger" onClick={deleteProtocol}>Delete</Button></>}
      >
        <p className="text-sm text-secondary">“{draft.name}” and its {p.steps.length} steps will be deleted. Sessions already run keep their own snapshot of the protocol.</p>
      </Modal>
    </div>
  );
}

function SaveIndicator({ state, error, onRetry }: { state: SaveState; error: string; onRetry: () => void }) {
  if (state === 'error')
    return (
      <button onClick={onRetry} title={error} className="ml-2 inline-flex items-center gap-1.5 rounded-full bg-sys-red/[0.06] px-2.5 py-1 text-xs font-medium text-[#d70015] ring-1 ring-sys-red/20 hover:bg-sys-red/10" data-testid="save-state">
        <CloudOff className="size-3.5" /> Not saved · Retry
      </button>
    );
  return (
    <span className="ml-2 inline-flex items-center gap-1.5 text-xs text-secondary" data-testid="save-state" data-state={state}>
      {state === 'saving' || state === 'dirty' ? <Loader2 className="size-3.5 animate-spin text-tertiary" /> : <Check className="size-3.5 text-sys-green" />}
      {state === 'saved' ? 'Saved' : 'Saving…'}
    </span>
  );
}

function SectionHeader({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return (
    <div className="mb-5 flex items-start gap-3">
      <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-[10px] bg-white text-secondary ring-1 ring-black/[0.06]">{icon}</span>
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        <p className="mt-0.5 text-sm text-secondary">{description}</p>
      </div>
    </div>
  );
}

function SectionIssues({ issues }: { issues: LocalIssue[] }) {
  if (!issues.length) return null;
  return (
    <div className="mb-4 space-y-2">
      {issues.map((i, k) => (
        <Callout key={k} tone={i.level === 'error' ? 'error' : 'warn'} icon={i.level === 'error' ? <AlertCircle className="size-4" /> : <AlertTriangle className="size-4" />}>{i.message}</Callout>
      ))}
    </div>
  );
}

function StepPane({ step, index, total, issues, onChange, onDuplicate, onRemove, onMove }: { step: Step; index: number; total: number; issues: LocalIssue[]; onChange: (s: Step) => void; onDuplicate: () => void; onRemove: () => void; onMove: (d: number) => void }) {
  const meta = STEP_META[step.type];
  const visible = issues.filter((i) => i.level !== 'info');
  const infos = issues.filter((i) => i.level === 'info');
  return (
    <div>
      <div className="mb-5 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-secondary">Step {index + 1} of {total} · {meta.label}</div>
          {/* Wrapping single-line title: long AI-generated titles must not be clipped. */}
          <Textarea
            rows={1}
            value={step.title}
            onChange={(e) => onChange({ ...step, title: e.target.value.replace(/\n/g, ' ') })}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), e.currentTarget.blur())}
            className="-ml-3 mt-0.5 !min-h-0 resize-none [field-sizing:content] !border-transparent !bg-transparent px-3 py-1 text-[22px] font-semibold leading-snug tracking-[-0.015em] hover:!bg-black/[0.03] focus:!border-brand-500 focus:!bg-white"
            aria-label="Step title"
            data-testid="step-title"
          />
        </div>
        <div className="flex shrink-0 items-center gap-0.5 pt-4">
          <button onClick={() => onMove(-1)} disabled={index === 0} className="rounded-md p-1.5 text-tertiary hover:bg-white hover:text-label disabled:opacity-30" title="Move up (Alt+↑)"><ArrowUp className="size-4" /></button>
          <button onClick={() => onMove(1)} disabled={index === total - 1} className="rounded-md p-1.5 text-tertiary hover:bg-white hover:text-label disabled:opacity-30" title="Move down (Alt+↓)"><ArrowDown className="size-4" /></button>
          <Menu align="right" trigger={({ toggle }) => <button onClick={toggle} className="rounded-md p-1.5 text-tertiary hover:bg-white hover:text-label" aria-label="Step actions"><MoreHorizontal className="size-4" /></button>}>
            {(close) => (
              <>
                <MenuItem icon={<Copy className="size-4" />} onClick={() => { close(); onDuplicate(); }}>Duplicate step</MenuItem>
                <MenuItem danger icon={<Trash2 className="size-4" />} onClick={() => { close(); onRemove(); }}>Delete step</MenuItem>
              </>
            )}
          </Menu>
        </div>
      </div>
      {visible.length > 0 && (
        <div className="mb-4 space-y-2">
          {visible.map((i, k) => (
            <Callout key={k} tone={i.level === 'error' ? 'error' : 'warn'} icon={i.level === 'error' ? <AlertCircle className="size-4" /> : <AlertTriangle className="size-4" />}>{i.message.replace(/^[^:]+: /, '')}</Callout>
          ))}
        </div>
      )}
      <StepEditor step={step} onChange={onChange} />
      {infos.length > 0 && <p className="mt-4 flex items-start gap-1.5 text-xs text-secondary"><Info className="mt-0.5 size-3.5 shrink-0" /> {infos.map((i) => i.message.replace(/^[^:]+: /, '')).join(' ')}</p>}
    </div>
  );
}

function StepList({ steps, selectedId, issues, onSelect, onMove }: { steps: Step[]; selectedId?: string; issues: Record<string, LocalIssue[]>; onSelect: (id: string) => void; onMove: (from: number, to: number) => void }) {
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [over, setOver] = useState<{ idx: number; after: boolean } | null>(null);
  let taskN = 0;
  return (
    <ol className="space-y-0.5" onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null); }}>
      {steps.map((s, i) => {
        if (s.type === 'task') taskN++;
        const meta = STEP_META[s.type];
        const iss = issues[s.id] ?? [];
        const level = iss.some((x) => x.level === 'error') ? 'error' : iss.some((x) => x.level === 'warning') ? 'warning' : null;
        const active = selectedId === s.id;
        return (
          <li
            key={s.id}
            draggable
            onDragStart={(e) => {
              setDragIdx(i);
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', s.id);
            }}
            onDragEnd={() => {
              setDragIdx(null);
              setOver(null);
            }}
            onDragOver={(e) => {
              if (dragIdx == null) return;
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              setOver({ idx: i, after: e.clientY > r.top + r.height / 2 });
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragIdx == null || !over) return;
              let to = over.after ? over.idx + 1 : over.idx;
              if (dragIdx < to) to--;
              onMove(dragIdx, to);
              setDragIdx(null);
              setOver(null);
            }}
            className={cn('relative', dragIdx === i && 'opacity-40')}
            data-testid="step-item"
          >
            {over?.idx === i && dragIdx !== null && (
              <span className={cn('pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-brand-500', over.after ? '-bottom-px' : '-top-px')} />
            )}
            <button
              onClick={() => onSelect(s.id)}
              className={cn('group flex w-full items-start gap-2 rounded-[10px] px-1.5 py-1.5 text-left transition', active ? 'bg-black/[0.06]' : 'hover:bg-black/[0.03]')}
            >
              <GripVertical className="mt-1 size-3.5 shrink-0 cursor-grab text-black/20 opacity-0 transition group-hover:opacity-100" />
              <span className={cn('mt-[3px] shrink-0', active ? 'text-brand-500' : 'text-tertiary')}>{meta.icon('size-3.5')}</span>
              <span className="min-w-0 flex-1">
                <span className={cn('flex items-center gap-1.5 text-sm font-medium', active ? 'text-label' : 'text-label')}>
                  <span className="truncate">{s.title || meta.label}</span>
                  {level && <span className={cn('size-1.5 shrink-0 rounded-full', level === 'error' ? 'bg-sys-red' : 'bg-sys-orange')} title={iss.map((x) => x.message).join('\n')} />}
                </span>
                <span className="block truncate text-[11px] text-secondary">{s.type === 'task' ? `T${taskN} · ` : ''}{stepSummary(s) || <i>empty</i>}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function AddStepMenu({ onAdd }: { onAdd: (t: StepType, inst?: InstrumentId | 'custom') => void }) {
  return (
    <Menu
      className="w-72"
      trigger={({ toggle }) => (
        <button onClick={toggle} className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-[10px] border border-dashed border-black/15 py-2 text-sm font-medium text-secondary transition hover:border-brand-500/50 hover:bg-brand-500/[0.04] hover:text-brand-500" data-testid="add-step">
          <Plus className="size-4" /> Add step
        </button>
      )}
    >
      {(close) => (
        <>
          {(['task', 'question', 'instruction', 'interview'] as StepType[]).map((t) => (
            <MenuItem key={t} icon={STEP_META[t].icon('size-4')} description={STEP_META[t].description} onClick={() => { close(); onAdd(t); }}>
              {STEP_META[t].label}
            </MenuItem>
          ))}
          <div className="my-1 border-t border-separator" />
          <div className="flex items-center gap-2 px-2.5 pb-1 pt-1.5 text-[12px] font-medium text-secondary">
            {STEP_META.questionnaire.icon('size-3.5')} Questionnaire
          </div>
          <div className="grid grid-cols-3 gap-1 p-1">
            {INSTRUMENT_CHOICES.map((c) => (
              <button key={c.id} title={c.description} onClick={() => { close(); onAdd('questionnaire', c.id); }} className="rounded-md bg-fill px-2 py-1.5 text-xs font-medium text-label hover:bg-sys-green/15">
                {c.short}
              </button>
            ))}
          </div>
        </>
      )}
    </Menu>
  );
}

function ChecksPanel({ issues, steps, review, onRunReview, onJump }: { issues: LocalIssue[]; steps: Step[]; review: { busy: boolean; issues: ReviewIssue[] | null; error?: string }; onRunReview: () => void; onJump: (i: { stepId?: string; section?: Section }) => void }) {
  const local = issues.filter((i) => i.level !== 'info');
  const stepTitle = (id?: string) => {
    const i = steps.findIndex((s) => s.id === id);
    return i >= 0 ? `${i + 1}. ${steps[i].title}` : null;
  };
  const sevTone = { high: 'bg-sys-red/10 text-[#d70015]', medium: 'bg-sys-orange/15 text-[#c93400]', low: 'bg-fill text-secondary' };
  return (
    <div className="space-y-6">
      <section>
        <h4 className="mb-2 flex items-center gap-1.5 text-[13px] font-medium text-secondary">Automatic checks</h4>
        {local.length === 0 ? (
          <div className="flex items-center gap-2 rounded-[10px] bg-sys-green/[0.08] px-3 py-2.5 text-sm text-label"><Check className="size-4" /> No problems found.</div>
        ) : (
          <ul className="space-y-1.5">
            {local.map((i, k) => (
              <li key={k}>
                <button onClick={() => onJump(i)} className="flex w-full items-start gap-2 rounded-[10px] border border-separator px-3 py-2 text-left text-sm hover:border-black/15 hover:bg-black/[0.03]">
                  {i.level === 'error' ? <AlertCircle className="mt-0.5 size-4 shrink-0 text-sys-red" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-sys-orange" />}
                  <span className="text-label">{i.message}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-[13px] font-medium text-secondary">AI methodology review</h4>
          {review.issues && <button onClick={onRunReview} disabled={review.busy} className="text-xs font-medium text-brand-500 hover:underline">Re-run</button>}
        </div>
        {review.error && <Callout tone="error" className="mb-2">{review.error}</Callout>}
        {review.busy ? (
          <div className="flex items-center gap-2 rounded-[10px] bg-brand-500/[0.08] px-3 py-3 text-sm text-label"><Loader2 className="size-4 animate-spin" /> Reviewing wording, neutrality and task design…</div>
        ) : review.issues === null ? (
          <div className="rounded-[14px] border border-dashed border-black/15 p-4 text-center">
                        <p className="mt-2 text-sm text-secondary">Flags leading or double-barreled questions, tasks that reveal the answer, and missing success criteria.</p>
            <Button size="sm" variant="subtle" className="mt-3" icon={<ShieldCheck className="size-4" />} onClick={onRunReview} disabled={!steps.length}>Run methodology check</Button>
          </div>
        ) : review.issues.length === 0 ? (
          <div className="flex items-center gap-2 rounded-[10px] bg-sys-green/[0.08] px-3 py-2.5 text-sm text-label"><Check className="size-4" /> The AI review found no methodology issues.</div>
        ) : (
          <ul className="space-y-2">
            {review.issues.map((i, k) => (
              <li key={k} className="rounded-[10px] border border-separator p-3">
                <div className="flex items-center gap-2">
                  <span className={cn('rounded px-1.5 py-px text-[11px] font-medium', sevTone[i.severity])}>{i.severity}</span>
                  {stepTitle(i.stepId) && <button onClick={() => onJump({ stepId: i.stepId })} className="truncate text-xs font-medium text-brand-500 hover:underline">{stepTitle(i.stepId)}</button>}
                </div>
                <p className="mt-1.5 text-sm text-label">{i.message}</p>
                {i.suggestion && <p className="mt-1 text-xs leading-relaxed text-secondary"><span className="font-medium text-secondary">Try: </span>{i.suggestion}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="text-[11px] leading-relaxed text-tertiary">Tip: <KeyHint>Alt</KeyHint> + <KeyHint>↑</KeyHint>/<KeyHint>↓</KeyHint> moves the selected step. Drag steps in the outline to reorder.</p>
    </div>
  );
}

function NewProtocolModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { detail, update } = useStudy();
  const nav = useNavigate();
  const toast = useToast();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const n = name.trim() || `Protocol ${String.fromCharCode(65 + detail.protocols.length)}`;
      const { protocol } = await api.post<{ protocol: ProtocolRecord }>(`/api/studies/${detail.study.id}/protocols`, { name: n, protocol: emptyProtocol(n) });
      update((d) => ({ ...d, protocols: [...d.protocols, protocol] }));
      onClose();
      setName('');
      nav(`/studies/${detail.study.id}/protocols/${protocol.id}`);
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="New protocol" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={submit}>Create</Button></>}>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-3">
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={`Protocol ${String.fromCharCode(65 + detail.protocols.length)}`} />
        <p className="text-xs text-secondary">Starts empty. To compare wording between variants, duplicate an existing protocol instead.</p>
      </form>
    </Modal>
  );
}
