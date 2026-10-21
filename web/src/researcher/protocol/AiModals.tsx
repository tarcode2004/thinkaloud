import { useState } from 'react';
import { AlertTriangle, ArrowRight, Check, Minus, Plus, Wand2 } from 'lucide-react';
import type { ModerationStyle, Protocol, Step } from '@thinkaloud/shared';
import { api } from '../../lib/api.ts';
import { Button, Field, Input, Modal, Select, Textarea, Toggle, cn } from '../../ui/index.tsx';
import { Callout, NumberInput } from '../components/index.tsx';
import { errorMessage } from '../lib.ts';
import { STEP_META, stepSummary } from './stepMeta.tsx';
import { STYLES } from './SettingsEditors.tsx';

function StepPreviewList({ steps, marks }: { steps: Step[]; marks?: Record<string, 'added' | 'changed'> }) {
  return (
    <ol className="space-y-1.5">
      {steps.map((s, i) => {
        const mk = marks?.[s.id];
        return (
          <li key={s.id + i} className={cn('flex items-start gap-3 rounded-[10px] border px-3 py-2', mk === 'added' ? 'border-sys-green/25 bg-sys-green/[0.05]' : mk === 'changed' ? 'border-sys-orange/25 bg-sys-orange/[0.05]' : 'border-separator bg-white')}>
            <span className="mt-0.5 shrink-0 text-tertiary">{STEP_META[s.type].icon('size-4')}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-medium">
                <span className="text-tertiary">{i + 1}.</span> {s.title}
                {mk && <span className={cn('rounded px-1 text-[11px] font-medium', mk === 'added' ? 'bg-sys-green/15 text-[#248a3d]' : 'bg-sys-orange/15 text-[#c93400]')}>{mk}</span>}
              </div>
              <div className="line-clamp-2 text-xs text-secondary">{stepSummary(s)}</div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

const LOADING_LINES = ['Reading your goals…', 'Drafting neutral, scenario-based tasks…', 'Adding success criteria and probes…', 'Checking wording for leading language…'];

function Thinking({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center py-12 text-center">
      <span className="size-12 animate-pulse rounded-full bg-[radial-gradient(circle_at_40%_35%,#fff,rgba(0,113,227,0.3)_55%,rgba(0,113,227,0.06)_72%)] shadow-[0_0_30px_rgba(0,113,227,0.2)]" />
      <div className="mt-5 text-sm font-medium text-label">{label ?? 'Working on it…'}</div>
      <div className="mt-1 h-5 overflow-hidden text-xs text-secondary">
        <div className="animate-[ta-scroll_8s_steps(4)_infinite]">
          {LOADING_LINES.map((l) => <div key={l} className="h-5">{l}</div>)}
        </div>
      </div>
      <style>{`@keyframes ta-scroll { to { transform: translateY(-80px) } }`}</style>
    </div>
  );
}

export function GenerateModal({ open, onClose, current, defaults, onApply }: { open: boolean; onClose: () => void; current: Protocol; defaults: { productName: string; appUrl?: string }; onApply: (p: Protocol, mode: 'replace' | 'append') => void }) {
  const [form, setForm] = useState({
    goal: current.researchGoals.join('\n'),
    productName: defaults.productName,
    productContext: current.productContext,
    audience: '',
    durationMinutes: current.estimatedMinutes || 20,
    taskCount: 3,
    includeSUS: true,
    style: current.moderation.style as ModerationStyle,
    appUrl: defaults.appUrl ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<Protocol | null>(null);
  const set = (p: Partial<typeof form>) => setForm((f) => ({ ...f, ...p }));

  const run = async () => {
    if (!form.goal.trim()) return setErr('Describe what you want to learn.');
    if (!form.productName.trim()) return setErr('Name the product being tested.');
    setErr('');
    setBusy(true);
    try {
      const { protocol } = await api.post<{ protocol: Protocol }>('/api/ai/generate-protocol', {
        ...form,
        productContext: form.productContext || undefined,
        audience: form.audience || undefined,
        appUrl: form.appUrl || undefined,
      });
      setResult(protocol);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    setResult(null);
    setErr('');
    onClose();
  };
  const hasSteps = current.steps.length > 0;

  return (
    <Modal
      open={open}
      onClose={close}
      width="max-w-2xl"
      title="Generate a protocol"
      footer={
        result ? (
          <>
            <Button variant="secondary" onClick={() => setResult(null)}>Back</Button>
            {hasSteps && <Button variant="secondary" icon={<Plus className="size-4" />} onClick={() => { onApply(result, 'append'); close(); }}>Append {result.steps.length} steps</Button>}
            <Button icon={<Check className="size-4" />} onClick={() => { onApply(result, 'replace'); close(); }}>{hasSteps ? 'Replace protocol' : 'Use this protocol'}</Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={close}>Cancel</Button>
            <Button icon={<Wand2 className="size-4" />} loading={busy} onClick={run}>Generate</Button>
          </>
        )
      }
    >
      {busy ? (
        <Thinking label="Drafting your protocol" />
      ) : result ? (
        <div className="space-y-4">
          <div>
            <div className="text-lg font-semibold">{result.title}</div>
            <div className="mt-1 text-sm text-secondary">{result.steps.length} steps · ~{result.estimatedMinutes} min · {STYLES.find((s) => s.value === result.moderation.style)?.label}</div>
          </div>
          {result.researchGoals.length > 0 && (
            <div>
              <div className="mb-1 text-[13px] font-medium text-secondary">Research goals</div>
              <ul className="list-disc space-y-0.5 pl-5 text-sm text-label">{result.researchGoals.map((g) => <li key={g}>{g}</li>)}</ul>
            </div>
          )}
          <div>
            <div className="mb-1.5 text-[13px] font-medium text-secondary">Steps</div>
            <StepPreviewList steps={result.steps} />
          </div>
          {hasSteps && <Callout tone="warn" icon={<AlertTriangle className="size-4" />}>Replace overwrites your current {current.steps.length} steps and settings. Append keeps them and adds these steps at the end.</Callout>}
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-secondary">Describe the study. You get a complete, editable protocol with neutral task wording, hidden success criteria, probes and standard questionnaires.</p>
          <Field label="What do you want to learn?">
            <Textarea autoFocus rows={3} value={form.goal} onChange={(e) => set({ goal: e.target.value })} placeholder="e.g. Can first-time visitors find and buy a plant that suits a low-light apartment? Where do they hesitate in checkout?" />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Product name"><Input value={form.productName} onChange={(e) => set({ productName: e.target.value })} placeholder="e.g. Leafly shop" /></Field>
            <Field label="Audience" hint="Optional"><Input value={form.audience} onChange={(e) => set({ audience: e.target.value })} placeholder="e.g. first-time plant buyers, 25–45" /></Field>
          </div>
          <Field label="Product context" hint="Optional. What it does and the key flows.">
            <Textarea rows={2} value={form.productContext} onChange={(e) => set({ productContext: e.target.value })} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Duration"><NumberInput value={form.durationMinutes} min={5} max={90} suffix="min" onChange={(v) => set({ durationMinutes: v ?? 20 })} /></Field>
            <Field label="Tasks"><NumberInput value={form.taskCount} min={0} max={10} onChange={(v) => set({ taskCount: v ?? 3 })} /></Field>
            <Field label="Style">
              <Select value={form.style} onChange={(e) => set({ style: e.target.value as ModerationStyle })}>
                {STYLES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </Select>
            </Field>
          </div>
          <Field label="App URL" hint="Optional. Helps tailor start pages.">
            <Input value={form.appUrl} onChange={(e) => set({ appUrl: e.target.value })} placeholder="https://…" />
          </Field>
          <Toggle checked={form.includeSUS} onChange={(v) => set({ includeSUS: v })} label="Include SUS at the end" description="System Usability Scale, 10 items, benchmarkable." />
          {err && <Callout tone="error" icon={<AlertTriangle className="size-4" />}>{err}</Callout>}
        </div>
      )}
    </Modal>
  );
}

const REFINE_CHIPS = [
  'Make every task more neutral and scenario-based',
  'Add a first-impressions step before the tasks',
  'Shorten the session to about 10 minutes',
  'Add NASA-TLX after the last task',
  'Add success rules where the URL makes success obvious',
  'Translate participant-facing text to German',
];

export function diffProtocols(a: Protocol, b: Protocol) {
  const aIds = new Map(a.steps.map((s) => [s.id, s]));
  const bIds = new Set(b.steps.map((s) => s.id));
  const marks: Record<string, 'added' | 'changed'> = {};
  for (const s of b.steps) {
    const prev = aIds.get(s.id);
    if (!prev) marks[s.id] = 'added';
    else if (JSON.stringify(prev) !== JSON.stringify(s)) marks[s.id] = 'changed';
  }
  const removed = a.steps.filter((s) => !bIds.has(s.id));
  const settings: string[] = [];
  if (a.title !== b.title) settings.push('Title');
  if (JSON.stringify(a.researchGoals) !== JSON.stringify(b.researchGoals)) settings.push('Research goals');
  if (a.productContext !== b.productContext) settings.push('Product context');
  if (a.intro !== b.intro) settings.push('Intro');
  if (a.closing !== b.closing) settings.push('Closing');
  if (JSON.stringify(a.moderation) !== JSON.stringify(b.moderation)) settings.push('Moderation');
  if (JSON.stringify(a.consent) !== JSON.stringify(b.consent)) settings.push('Consent');
  if (a.estimatedMinutes !== b.estimatedMinutes) settings.push('Duration');
  if (a.randomizeTasks !== b.randomizeTasks) settings.push('Task randomization');
  return { marks, removed, settings };
}

export function RefineModal({ open, onClose, current, onApply }: { open: boolean; onClose: () => void; current: Protocol; onApply: (p: Protocol) => void }) {
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<{ protocol: Protocol; changes: string[] } | null>(null);
  const close = () => {
    setResult(null);
    setErr('');
    onClose();
  };
  const run = async () => {
    if (!instruction.trim()) return setErr('Tell the AI what to change.');
    setBusy(true);
    setErr('');
    try {
      setResult(await api.post<{ protocol: Protocol; changes: string[] }>('/api/ai/refine-protocol', { protocol: current, instruction }));
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const diff = result ? diffProtocols(current, result.protocol) : null;
  return (
    <Modal
      open={open}
      onClose={close}
      width="max-w-2xl"
      title="Refine with AI"
      footer={
        result ? (
          <>
            <Button variant="secondary" onClick={() => setResult(null)}>Discard</Button>
            <Button icon={<Check className="size-4" />} onClick={() => { onApply(result.protocol); close(); setInstruction(''); }}>Apply changes</Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={close}>Cancel</Button>
            <Button icon={<Wand2 className="size-4" />} loading={busy} onClick={run}>Refine</Button>
          </>
        )
      }
    >
      {busy ? (
        <Thinking label="Revising your protocol" />
      ) : result && diff ? (
        <div className="space-y-5">
          <div>
            <div className="mb-1.5 text-[13px] font-medium text-secondary">What changed</div>
            <ul className="space-y-1.5">
              {result.changes.map((c, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-label"><ArrowRight className="mt-0.5 size-3.5 shrink-0 text-brand-500" /> {c}</li>
              ))}
              {!result.changes.length && <li className="text-sm text-secondary">No changes reported.</li>}
            </ul>
          </div>
          {(diff.settings.length > 0 || diff.removed.length > 0) && (
            <div className="flex flex-wrap gap-2 text-xs">
              {diff.settings.map((s) => <span key={s} className="rounded-full bg-sys-orange/[0.08] px-2 py-0.5 font-medium text-[#c93400] ring-1 ring-sys-orange/25">{s} updated</span>)}
              {diff.removed.map((s) => <span key={s.id} className="inline-flex items-center gap-1 rounded-full bg-sys-red/[0.06] px-2 py-0.5 font-medium text-[#d70015] ring-1 ring-sys-red/20"><Minus className="size-3" /> {s.title}</span>)}
            </div>
          )}
          <div>
            <div className="mb-1.5 text-[13px] font-medium text-secondary">Resulting steps</div>
            <StepPreviewList steps={result.protocol.steps} marks={diff.marks} />
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <Field label="What should change?">
            <Textarea autoFocus rows={3} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="e.g. Make task 2 less leading and add a question about trust after checkout." />
          </Field>
          <div className="flex flex-wrap gap-1.5">
            {REFINE_CHIPS.map((c) => (
              <button key={c} type="button" onClick={() => setInstruction(c)} className="rounded-full border border-separator bg-white px-2.5 py-1 text-xs text-secondary hover:border-brand-500/40 hover:bg-brand-500/[0.08] hover:text-brand-500">
                {c}
              </button>
            ))}
          </div>
          <p className="text-xs text-secondary">You will see a list of changes and can review them before anything is applied.</p>
          {err && <Callout tone="error" icon={<AlertTriangle className="size-4" />}>{err}</Callout>}
        </div>
      )}
    </Modal>
  );
}
