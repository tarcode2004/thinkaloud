import type { ReactNode } from 'react';
import { Code2, Eye, Lock, MousePointerClick, Plus, Route, Trash2, Type, Zap } from 'lucide-react';
import {
  questionnaireItems, type InstructionStep, type InterviewStep, type Question, type QuestionKind, type QuestionnaireStep, type QuestionStep, type Step, type SuccessRule, type TaskStep,
} from '@thinkaloud/shared';
import { Field, Input, Select, Textarea, Toggle, cn } from '../../ui/index.tsx';
import { FormSection, NumberInput, StringListEditor, FieldGroup } from '../components/index.tsx';
import { INSTRUMENT_CHOICES, newQuestion, QUESTION_KINDS } from './stepMeta.tsx';

export function StepEditor({ step, onChange }: { step: Step; onChange: (s: Step) => void }) {
  switch (step.type) {
    case 'instruction':
      return <InstructionEditor step={step} onChange={onChange} />;
    case 'question':
      return <QuestionStepEditor step={step} onChange={onChange} />;
    case 'task':
      return <TaskEditor step={step} onChange={onChange} />;
    case 'questionnaire':
      return <QuestionnaireEditor step={step} onChange={onChange} />;
    case 'interview':
      return <InterviewEditor step={step} onChange={onChange} />;
  }
}

export function HiddenLabel({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {children}
      <span className="inline-flex items-center gap-1 rounded-full bg-fill px-1.5 py-px text-[11px] font-medium text-secondary">
        <Lock className="size-2.5" /> hidden
      </span>
    </span>
  );
}

function SpokenLabel({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {children}
      <span className="rounded-full bg-brand-500/[0.08] px-1.5 py-px text-[11px] font-medium text-brand-500">read aloud</span>
    </span>
  );
}

function InstructionEditor({ step, onChange }: { step: InstructionStep; onChange: (s: Step) => void }) {
  return (
    <FormSection title="What the moderator says" description="Delivered close to verbatim, then the session moves on.">
      <Field label={<SpokenLabel>Script</SpokenLabel>}>
        <Textarea rows={5} value={step.script} onChange={(e) => onChange({ ...step, script: e.target.value })} placeholder="e.g. Next, take a minute to look around the homepage without clicking anything…" />
      </Field>
      <Toggle checked={!!step.showApp} onChange={(v) => onChange({ ...step, showApp: v })} label="Show the app during this step" description="Use for first-impression or free-exploration moments." />
      {step.showApp && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Exploration time" hint="0 = move on as soon as the script is delivered.">
            <NumberInput value={step.exploreSeconds ?? 0} min={0} max={600} suffix="sec" onChange={(v) => onChange({ ...step, exploreSeconds: v ?? 0 })} />
          </Field>
          <Field label="Start page" hint="App path loaded when the step starts. Leave empty to keep the current page.">
            <Input className="font-mono text-xs" value={step.startPath ?? ''} onChange={(e) => onChange({ ...step, startPath: e.target.value || undefined })} placeholder="/" />
          </Field>
        </div>
      )}
    </FormSection>
  );
}

function QuestionStepEditor({ step, onChange }: { step: QuestionStep; onChange: (s: Step) => void }) {
  return (
    <FormSection title="Question" description="Asked by the moderator. Open questions get optional AI follow-ups.">
      <QuestionEditor q={step.question} onChange={(q) => onChange({ ...step, question: q })} />
    </FormSection>
  );
}

export function QuestionEditor({ q, onChange, compact }: { q: Question; onChange: (q: Question) => void; compact?: boolean }) {
  const setKind = (kind: QuestionKind) => {
    const next: Question = { ...q, kind };
    if ((kind === 'single_choice' || kind === 'multi_choice') && !q.options?.length) next.options = ['', ''];
    if (kind === 'rating' && !q.scale) next.scale = { min: 1, max: 7, minLabel: '', maxLabel: '' };
    onChange(next);
  };
  return (
    <div className="space-y-4">
      <div className={cn('grid gap-3', compact ? 'sm:grid-cols-[1fr_170px]' : 'sm:grid-cols-[1fr_190px]')}>
        <Field label={<SpokenLabel>Question</SpokenLabel>}>
          <Textarea rows={compact ? 2 : 3} value={q.prompt} onChange={(e) => onChange({ ...q, prompt: e.target.value })} placeholder="e.g. What did you expect to see on this page?" />
        </Field>
        <Field label="Answer type">
          <Select value={q.kind} onChange={(e) => setKind(e.target.value as QuestionKind)}>
            {QUESTION_KINDS.map((k) => (
              <option key={k.value} value={k.value}>{k.label}</option>
            ))}
          </Select>
        </Field>
      </div>
      {(q.kind === 'single_choice' || q.kind === 'multi_choice') && (
        <FieldGroup label="Options">
          <StringListEditor items={q.options ?? []} onChange={(options) => onChange({ ...q, options })} placeholder="Option" addLabel="Add option" />
        </FieldGroup>
      )}
      {q.kind === 'rating' && (
        <div className="grid gap-3 rounded-[10px] bg-canvas p-3 sm:grid-cols-4">
          <Field label="Min"><NumberInput value={q.scale?.min ?? 1} onChange={(v) => onChange({ ...q, scale: { ...(q.scale ?? { min: 1, max: 7 }), min: v ?? 0 } })} /></Field>
          <Field label="Max"><NumberInput value={q.scale?.max ?? 7} onChange={(v) => onChange({ ...q, scale: { ...(q.scale ?? { min: 1, max: 7 }), max: v ?? 0 } })} /></Field>
          <Field label="Min label"><Input value={q.scale?.minLabel ?? ''} placeholder="Very difficult" onChange={(e) => onChange({ ...q, scale: { ...(q.scale ?? { min: 1, max: 7 }), minLabel: e.target.value } })} /></Field>
          <Field label="Max label"><Input value={q.scale?.maxLabel ?? ''} placeholder="Very easy" onChange={(e) => onChange({ ...q, scale: { ...(q.scale ?? { min: 1, max: 7 }), maxLabel: e.target.value } })} /></Field>
        </div>
      )}
      <div className="flex flex-wrap gap-x-8 gap-y-3">
        <Toggle checked={q.required} onChange={(v) => onChange({ ...q, required: v })} label="Required" />
        <Toggle checked={!!q.allowFollowUp} onChange={(v) => onChange({ ...q, allowFollowUp: v })} label="Allow one AI follow-up" description='e.g. "Can you tell me more about why?"' />
      </div>
      <Field label={<HiddenLabel>Intent</HiddenLabel>} hint="What you want to learn. Guides the moderator's follow-up and the AI synthesis.">
        <Input value={q.intent ?? ''} onChange={(e) => onChange({ ...q, intent: e.target.value })} placeholder="e.g. Understand expectations before seeing the page" />
      </Field>
    </div>
  );
}

function QuestionListEditor({ questions, onChange, addLabel }: { questions: Question[]; onChange: (q: Question[]) => void; addLabel: string }) {
  return (
    <div className="space-y-3">
      {questions.map((q, i) => (
        <div key={q.id} className="relative rounded-[14px] border border-separator bg-canvas p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[13px] font-medium text-secondary">Item {i + 1}</span>
            <button type="button" onClick={() => onChange(questions.filter((_, j) => j !== i))} className="rounded-md p-1 text-tertiary hover:bg-sys-red/10 hover:text-sys-red" aria-label="Remove question">
              <Trash2 className="size-4" />
            </button>
          </div>
          <QuestionEditor compact q={q} onChange={(nq) => onChange(questions.map((x, j) => (j === i ? nq : x)))} />
        </div>
      ))}
      <button type="button" onClick={() => onChange([...questions, newQuestion('open')])} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-brand-500 hover:bg-brand-500/[0.08]">
        <Plus className="size-4" /> {addLabel}
      </button>
    </div>
  );
}

// ── Task ─────────────────────────────────────────────────────────────────────

const RULE_TYPES: { type: SuccessRule['type']; label: string; icon: ReactNode; hint: string }[] = [
  { type: 'url_matches', label: 'URL matches', icon: <Route className="size-3.5" />, hint: 'Regular expression tested against path + query + hash, e.g. ^/checkout/done' },
  { type: 'element_visible', label: 'Element visible', icon: <Eye className="size-3.5" />, hint: 'CSS selector that appears when the task is done, e.g. .order-confirmation' },
  { type: 'text_visible', label: 'Text visible', icon: <Type className="size-3.5" />, hint: 'Text that appears on screen, e.g. "Thanks for your order"' },
  { type: 'click_matches', label: 'Click on', icon: <MousePointerClick className="size-3.5" />, hint: 'Participant clicks an element matching a selector and/or text' },
  { type: 'custom_event', label: 'Custom event', icon: <Zap className="size-3.5" />, hint: 'Your app calls window.ThinkAloud.track("name")' },
];

function blankRule(type: SuccessRule['type']): SuccessRule {
  switch (type) {
    case 'url_matches': return { type, pattern: '' };
    case 'element_visible': return { type, selector: '' };
    case 'text_visible': return { type, text: '' };
    case 'click_matches': return { type, selector: '', text: '' };
    case 'custom_event': return { type, name: '' };
  }
}

export function SuccessRulesEditor({ rules, onChange }: { rules: SuccessRule[]; onChange: (r: SuccessRule[]) => void }) {
  const set = (i: number, r: SuccessRule) => onChange(rules.map((x, j) => (j === i ? r : x)));
  return (
    <div className="space-y-2">
      {rules.length === 0 && <p className="text-xs text-secondary">No rules: the AI moderator judges success from what the participant does and says. Add a rule for objective, automatic detection.</p>}
      {rules.map((r, i) => (
        <div key={i} className="group flex flex-wrap items-center gap-2 rounded-[10px] border border-separator bg-white p-2">
          {i > 0 && <span className="w-full px-1 text-[11px] font-medium text-tertiary sm:w-auto">or</span>}
          <Select value={r.type} onChange={(e) => set(i, blankRule(e.target.value as SuccessRule['type']))} className="h-9 w-full sm:w-44" aria-label="Rule type">
            {RULE_TYPES.map((t) => (
              <option key={t.type} value={t.type}>{t.label}</option>
            ))}
          </Select>
          <div className="flex min-w-0 flex-1 gap-2">
            {r.type === 'url_matches' && <Input className="h-9 font-mono text-xs" value={r.pattern} placeholder="^/checkout/(done|success)" onChange={(e) => set(i, { ...r, pattern: e.target.value })} />}
            {r.type === 'element_visible' && <Input className="h-9 font-mono text-xs" value={r.selector} placeholder=".order-confirmation, [data-testid=done]" onChange={(e) => set(i, { ...r, selector: e.target.value })} />}
            {r.type === 'text_visible' && <Input className="h-9" value={r.text} placeholder="Thanks for your order" onChange={(e) => set(i, { ...r, text: e.target.value })} />}
            {r.type === 'click_matches' && (
              <>
                <Input className="h-9 font-mono text-xs" value={r.selector ?? ''} placeholder="selector (optional)" onChange={(e) => set(i, { ...r, selector: e.target.value })} />
                <Input className="h-9" value={r.text ?? ''} placeholder="button text (optional)" onChange={(e) => set(i, { ...r, text: e.target.value })} />
              </>
            )}
            {r.type === 'custom_event' && <Input className="h-9 font-mono text-xs" value={r.name} placeholder="order_placed" onChange={(e) => set(i, { ...r, name: e.target.value })} />}
          </div>
          <button type="button" onClick={() => onChange(rules.filter((_, j) => j !== i))} className="rounded-md p-1.5 text-tertiary hover:bg-sys-red/10 hover:text-sys-red" aria-label="Remove rule">
            <Trash2 className="size-4" />
          </button>
          <p className="w-full px-1 text-[11px] text-secondary">{RULE_TYPES.find((t) => t.type === r.type)?.hint}</p>
        </div>
      ))}
      <div className="flex flex-wrap gap-1.5 pt-1">
        {RULE_TYPES.map((t) => (
          <button
            key={t.type}
            type="button"
            onClick={() => onChange([...rules, blankRule(t.type)])}
            className="inline-flex items-center gap-1.5 rounded-full border border-separator bg-white px-2.5 py-1 text-xs font-medium text-secondary hover:border-brand-500/40 hover:bg-brand-500/[0.08] hover:text-brand-500"
          >
            <Plus className="size-3" /> {t.label}
          </button>
        ))}
      </div>
      {rules.some((r) => r.type === 'custom_event') && (
        <div className="flex items-start gap-2 rounded-[10px] bg-label px-3 py-2 font-mono text-[11px] text-white/85">
          <Code2 className="mt-0.5 size-3.5 shrink-0 text-tertiary" />
          <span>window.ThinkAloud?.track('{(rules.find((r) => r.type === 'custom_event') as { name: string } | undefined)?.name || 'event_name'}')</span>
        </div>
      )}
    </div>
  );
}

function TaskEditor({ step, onChange }: { step: TaskStep; onChange: (s: Step) => void }) {
  return (
    <div className="space-y-5">
      <FormSection title="Scenario" description="Give a realistic goal and motivation. Do not name buttons or menus, and do not hint at the path.">
        <Field label={<SpokenLabel>Task instruction</SpokenLabel>}>
          <Textarea
            rows={4}
            value={step.instruction}
            onChange={(e) => onChange({ ...step, instruction: e.target.value })}
            placeholder="e.g. Imagine your friend's birthday is next week and you want to send them a gift under $50. Use the site to find something you'd buy."
            data-testid="task-instruction"
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Start page" hint="App path loaded when the task starts. Leave empty to continue where they are.">
            <Input className="font-mono text-xs" value={step.startPath ?? ''} onChange={(e) => onChange({ ...step, startPath: e.target.value })} placeholder="/" />
          </Field>
          <Field label="Time limit" hint={step.timeLimitSec ? `≈ ${Math.round((step.timeLimitSec / 60) * 10) / 10} min. The task ends as a timeout after this.` : 'No limit'}>
            <NumberInput value={step.timeLimitSec} min={0} step={30} suffix="sec" onChange={(v) => onChange({ ...step, timeLimitSec: v })} placeholder="300" />
          </Field>
          <Field
            label="Check-in after"
            hint={
              step.softLimitSec
                ? step.timeLimitSec && step.softLimitSec >= step.timeLimitSec
                  ? 'Must be shorter than the time limit.'
                  : 'The moderator asks once whether to keep trying or move on. Keeping going runs on to the time limit.'
                : 'Optional soft limit.'
            }
          >
            <NumberInput value={step.softLimitSec} min={0} step={30} suffix="sec" onChange={(v) => onChange({ ...step, softLimitSec: v || undefined })} placeholder="none" />
          </Field>
        </div>
      </FormSection>

      <AssistanceEditor step={step} onChange={onChange} />

      <FormSection title={<HiddenLabel>Success</HiddenLabel>} description="Never read to the participant. Used by the moderator to know when the task is done, and by analytics.">
        <Field label="Success criteria">
          <Textarea rows={2} value={step.successCriteria} onChange={(e) => onChange({ ...step, successCriteria: e.target.value })} placeholder="e.g. A product under $50 is in the cart and the participant reached the cart page." data-testid="task-success" />
        </Field>
        <FieldGroup label="Automatic detection" hint="Any matching rule marks the task as a success.">
          <SuccessRulesEditor rules={step.successRules ?? []} onChange={(successRules) => onChange({ ...step, successRules })} />
        </FieldGroup>
        <Field label="Optimal path length" hint="Minimum number of unique screens needed. Enables the lostness metric." className="max-w-xs">
          <NumberInput value={step.optimalPathLength} min={1} suffix="screens" onChange={(v) => onChange({ ...step, optimalPathLength: v })} />
        </Field>
      </FormSection>

      <FormSection title="After the task" description="Retrospective probes come after the task, never during it, so time-on-task stays clean.">
        <Toggle checked={!!step.askSEQ} onChange={(v) => onChange({ ...step, askSEQ: v })} label="Ask the Single Ease Question (SEQ)" description='"Overall, how difficult or easy was the task to complete?" 1–7, with a follow-up if the rating is low.' />
        <FieldGroup label="Suggested probes" hint="Open, neutral questions the AI may use, depending on what happened.">
          <StringListEditor items={step.probes ?? []} onChange={(probes) => onChange({ ...step, probes })} placeholder="e.g. What did you expect to happen when you clicked that?" addLabel="Add probe" />
        </FieldGroup>
        <FieldGroup label="Post-task questions">
          <QuestionListEditor questions={step.postTaskQuestions ?? []} onChange={(postTaskQuestions) => onChange({ ...step, postTaskQuestions })} addLabel="Add question" />
        </FieldGroup>
      </FormSection>
    </div>
  );
}

function AssistanceEditor({ step, onChange }: { step: TaskStep; onChange: (s: Step) => void }) {
  const a = step.assistance;
  const set = (patch: Partial<NonNullable<TaskStep['assistance']>>) => {
    const next = { generalPrompts: [], ...a, ...patch };
    // a freshly added (still empty) prompt row keeps the block; removing everything clears it
    const empty = next.generalPrompts.length === 0 && !next.directCue;
    onChange({ ...step, assistance: empty ? undefined : next });
  };
  return (
    <FormSection
      title="Assistance"
      description="Standard hints for a participant who seems stuck: not talking, no clicks or page changes for 15 seconds. General prompts score the task 1; a direct cue scores it 0."
    >
      <FieldGroup label={<SpokenLabel>General prompts</SpokenLabel>} hint="Said verbatim, one at a time, in this order.">
        <StringListEditor numbered items={a?.generalPrompts ?? []} onChange={(generalPrompts) => set({ generalPrompts })} placeholder="e.g. What are you looking for right now?" addLabel="Add prompt" />
      </FieldGroup>
      {!!a?.generalPrompts.length && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="First prompt after" hint="Task time before any help.">
            <NumberInput value={a.firstAfterSec} min={0} step={10} suffix="sec" onChange={(v) => set({ firstAfterSec: v })} placeholder="60" />
          </Field>
          <Field label="Then every" hint="Further stuck time before the next prompt.">
            <NumberInput value={a.gapSec} min={5} step={5} suffix="sec" onChange={(v) => set({ gapSec: v })} placeholder="30" />
          </Field>
        </div>
      )}
      <Field label={<HiddenLabel>Direct cue</HiddenLabel>} hint="Last resort, after every general prompt. Leave empty to never give one.">
        <Textarea rows={2} value={a?.directCue ?? ''} onChange={(e) => set({ directCue: e.target.value || undefined })} placeholder="e.g. Try the category labels above the posts on the right." />
      </Field>
    </FormSection>
  );
}

function QuestionnaireEditor({ step, onChange }: { step: QuestionnaireStep; onChange: (s: Step) => void }) {
  const items = questionnaireItems(step);
  return (
    <div className="space-y-5">
      <FormSection title="Instrument">
        <div className="grid gap-2 sm:grid-cols-3">
          {INSTRUMENT_CHOICES.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() =>
                onChange({
                  ...step,
                  instrument: c.id,
                  title: step.title === INSTRUMENT_CHOICES.find((x) => x.id === step.instrument)?.name || !step.title ? c.name : step.title,
                  questions: c.id === 'custom' ? step.questions?.length ? step.questions : [newQuestion('rating')] : step.questions,
                })
              }
              className={cn('rounded-[14px] border p-3 text-left transition', step.instrument === c.id ? 'border-brand-500 ring-1 ring-brand-500' : 'border-separator hover:border-black/15')}
            >
              <div className="text-sm font-semibold">{c.short}</div>
              <div className="mt-0.5 text-xs leading-snug text-secondary">{c.description}</div>
            </button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {step.instrument !== 'custom' && (
            <Field label="Product name in wording" hint={`Replaces "this system", e.g. "I thought ${step.productName || 'this system'} was easy to use."`}>
              <Input value={step.productName ?? ''} onChange={(e) => onChange({ ...step, productName: e.target.value })} placeholder="this system" />
            </Field>
          )}
          <div className="pt-1 sm:pt-7">
            <Toggle checked={step.onScreen !== false} onChange={(v) => onChange({ ...step, onScreen: v })} label="Answer on screen" description="Off: the moderator reads each item aloud and records the spoken answer." />
          </div>
        </div>
      </FormSection>
      {step.instrument === 'custom' ? (
        <FormSection title="Items">
          <QuestionListEditor questions={step.questions ?? []} onChange={(questions) => onChange({ ...step, questions })} addLabel="Add item" />
        </FormSection>
      ) : (
        <FormSection title={`Items (${items.length})`} description="Standardized wording and scoring. Not editable, which keeps scores comparable to published benchmarks.">
          <ol className="space-y-1.5">
            {items.map((q, i) => (
              <li key={q.id} className="flex gap-3 rounded-[10px] bg-canvas px-3 py-2 text-sm">
                <span className="w-5 shrink-0 text-right text-xs font-medium text-tertiary">{i + 1}</span>
                <span className="flex-1 text-label">{q.prompt}</span>
                {q.scale && <span className="shrink-0 text-xs text-tertiary">{q.scale.min}–{q.scale.max}</span>}
              </li>
            ))}
          </ol>
        </FormSection>
      )}
    </div>
  );
}

function InterviewEditor({ step, onChange }: { step: InterviewStep; onChange: (s: Step) => void }) {
  return (
    <FormSection title="Interview block" description="Open questions asked in order, verbatim. The AI follows up on what the participant says, up to the limit below.">
      <Field label={<HiddenLabel>Goal</HiddenLabel>} hint="What this block should uncover. Steers the follow-ups.">
        <Textarea rows={2} value={step.goal} onChange={(e) => onChange({ ...step, goal: e.target.value })} placeholder="e.g. Understand what would make them switch from their current tool." />
      </Field>
      <FieldGroup label={<SpokenLabel>Questions</SpokenLabel>}>
        <StringListEditor numbered multiline items={step.questions} onChange={(questions) => onChange({ ...step, questions })} placeholder="e.g. Walk me through the last time you…" addLabel="Add question" />
      </FieldGroup>
      <Field label="Follow-ups per question" hint="Overrides the protocol-wide probe limit for this block." className="max-w-xs">
        <NumberInput value={step.maxFollowUps} min={0} max={10} onChange={(v) => onChange({ ...step, maxFollowUps: v })} placeholder="default" />
      </Field>
      <Toggle checked={!!step.showApp} onChange={(v) => onChange({ ...step, showApp: v })} label="Show the app during this block" description='For questions about what is on screen, e.g. "What do you think this page is for?"' />
      {step.showApp && (
        <Field label="Start page" hint="App path loaded when the block starts. Leave empty to keep the current page." className="max-w-xs">
          <Input className="font-mono text-xs" value={step.startPath ?? ''} onChange={(e) => onChange({ ...step, startPath: e.target.value || undefined })} placeholder="/" />
        </Field>
      )}
    </FormSection>
  );
}
