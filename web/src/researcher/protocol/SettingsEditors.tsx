import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { DEFAULT_CLOSING, DEFAULT_CONSENT, DEFAULT_INTRO, REALTIME_VOICES, type ModerationStyle, type ProbingLevel, type Protocol } from '@thinkaloud/shared';
import { Field, Input, Select, Textarea, cn } from '../../ui/index.tsx';
import { FormSection, Group, Markdown, NumberInput, Row, Segmented, StringListEditor, Switch, FieldGroup } from '../components/index.tsx';
import { HiddenLabel } from './StepEditors.tsx';

type P = { p: Protocol; onChange: (p: Protocol) => void };

export function GeneralSettings({ p, onChange }: P) {
  return (
    <div className="space-y-5">
      <FormSection title="Basics">
        <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
          <Field label="Title" hint="Shown to participants on the welcome screen.">
            <Input value={p.title} onChange={(e) => onChange({ ...p, title: e.target.value })} />
          </Field>
          <Field label="Estimated duration">
            <NumberInput value={p.estimatedMinutes} min={1} max={180} suffix="min" onChange={(v) => onChange({ ...p, estimatedMinutes: v ?? 1 })} />
          </Field>
        </div>
        <div className="flex items-center gap-4 border-t border-separator pt-4">
          <div className="flex-1">
            <div className="text-[14px]">Randomize task order</div>
            <div className="text-[12px] text-secondary">Shuffles tasks for each participant to reduce order and learning effects. Other steps stay in place.</div>
          </div>
          <Switch checked={p.randomizeTasks} onChange={(v) => onChange({ ...p, randomizeTasks: v })} label="Randomize task order" />
        </div>
      </FormSection>
      <FormSection title={<HiddenLabel>Research context</HiddenLabel>} description="Gives the moderator and the AI synthesis focus. It is never used to help participants.">
        <FieldGroup label="Research goals">
          <StringListEditor items={p.researchGoals} onChange={(researchGoals) => onChange({ ...p, researchGoals })} placeholder="e.g. Find where people get stuck in checkout" addLabel="Add goal" />
        </FieldGroup>
        <Field label="Product context" hint="What the product is and who it is for.">
          <Textarea rows={3} value={p.productContext} onChange={(e) => onChange({ ...p, productContext: e.target.value })} placeholder="e.g. An online plant shop for first-time plant owners…" />
        </Field>
      </FormSection>
      <FormSection title="Spoken intro and closing" description="The intro should disclose that the moderator is an AI, say we are testing the product and not the participant, and ask them to think aloud.">
        <Field label={<span className="flex items-center justify-between">Intro <ResetBtn onClick={() => onChange({ ...p, intro: DEFAULT_INTRO })} /></span>}>
          <Textarea rows={5} value={p.intro} onChange={(e) => onChange({ ...p, intro: e.target.value })} />
        </Field>
        <Field label={<span className="flex items-center justify-between">Closing <ResetBtn onClick={() => onChange({ ...p, closing: DEFAULT_CLOSING })} /></span>}>
          <Textarea rows={3} value={p.closing} onChange={(e) => onChange({ ...p, closing: e.target.value })} />
        </Field>
      </FormSection>
    </div>
  );
}

function ResetBtn({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={(e) => { e.preventDefault(); onClick(); }} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-normal text-secondary hover:bg-black/[0.05] hover:text-label">
      <RotateCcw className="size-3" /> Reset to default
    </button>
  );
}

export const STYLES: { value: ModerationStyle; label: string; description: string }[] = [
  { value: 'think_aloud_concurrent', label: 'Concurrent think-aloud', description: 'Participants narrate while doing tasks. Neutral nudges when they go quiet, probes after each task. Recommended.' },
  { value: 'think_aloud_retrospective', label: 'Retrospective think-aloud', description: 'Tasks are done silently, then discussed afterwards. Cleaner task times, less live insight.' },
  { value: 'interview', label: 'Interview-led', description: 'Conversation first. The app is shown only when a task needs it.' },
  { value: 'unmoderated', label: 'Unmoderated', description: 'The AI only reads instructions and collects answers. It never probes.' },
];

const LANGUAGES: [string, string][] = [
  ['en', 'English'], ['de', 'German'], ['fr', 'French'], ['es', 'Spanish'], ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['sv', 'Swedish'],
  ['da', 'Danish'], ['no', 'Norwegian'], ['fi', 'Finnish'], ['pl', 'Polish'], ['cs', 'Czech'], ['tr', 'Turkish'], ['ru', 'Russian'], ['uk', 'Ukrainian'],
  ['el', 'Greek'], ['ar', 'Arabic'], ['he', 'Hebrew'], ['hi', 'Hindi'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'], ['id', 'Indonesian'], ['vi', 'Vietnamese'], ['th', 'Thai'],
];

export function ModerationSettingsEditor({ p, onChange }: P) {
  const m = p.moderation;
  const set = (patch: Partial<Protocol['moderation']>) => onChange({ ...p, moderation: { ...m, ...patch } });
  return (
    <div className="space-y-5">
      <FormSection title="Moderation style">
        <div className="grid gap-2 sm:grid-cols-2">
          {STYLES.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => set({ style: s.value })}
              className={cn('rounded-[14px] border p-3.5 text-left transition', m.style === s.value ? 'border-brand-500 bg-brand-500/[0.04] ring-2 ring-brand-500/20' : 'border-separator hover:border-black/15')}
            >
              <div className="flex items-center gap-2 text-sm font-semibold">
                <span className={cn('size-3.5 rounded-full border-2', m.style === s.value ? 'border-brand-600 bg-brand-600 shadow-[inset_0_0_0_2px_white]' : 'border-black/15')} />
                {s.label}
              </div>
              <p className="mt-1 pl-5.5 text-xs leading-relaxed text-secondary">{s.description}</p>
            </button>
          ))}
        </div>
      </FormSection>

      <FormSection title="Probing" description="Open-ended first, one question at a time, never double-barreled. These limits keep the moderator from steering.">
        <FieldGroup label="Probing depth">
          <Segmented<ProbingLevel>
            value={m.probingLevel}
            onChange={(probingLevel) => set({ probingLevel })}
            options={[
              { value: 'none', label: 'None', hint: 'No follow-ups' },
              { value: 'light', label: 'Light', hint: 'Occasional clarifications' },
              { value: 'moderate', label: 'Moderate', hint: 'Follow-up on notable moments' },
              { value: 'deep', label: 'Deep', hint: 'Probe funnel: why → why' },
            ]}
          />
        </FieldGroup>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Max probes per step" hint="Hard cap on AI follow-ups per task or question.">
            <NumberInput value={m.maxProbesPerStep} min={0} max={10} onChange={(v) => set({ maxProbesPerStep: v ?? 0 })} />
          </Field>
          <FieldGroup label={`Silence nudge: ${m.silencePromptSeconds ? `after ${m.silencePromptSeconds}s` : 'off'}`} hint='"Keep talking. What are you thinking?" 5–15 s recommended. Never mid-action.'>
            <input
              type="range"
              min={0}
              max={60}
              step={1}
              value={m.silencePromptSeconds}
              onChange={(e) => set({ silencePromptSeconds: Number(e.target.value) })}
              className="mt-3 w-full accent-brand-600"
            />
          </FieldGroup>
        </div>
        <Group className="-mx-1 bg-canvas ring-0">
          <Row label="Probe on behaviour" description='Notices errors, rage clicks and backtracking: "I noticed you went back. What were you looking for?"'><Switch checked={m.probeOnBehavior} onChange={(v) => set({ probeOnBehavior: v })} label="Probe on behaviour" /></Row>
          <Row label="Allow closed questions" description="Yes/no or either/or, only to confirm after an open question."><Switch checked={m.allowClosedQuestions} onChange={(v) => set({ allowClosedQuestions: v })} label="Allow closed questions" /></Row>
          <Row label="Allow typing instead of speaking" description="For participants who cannot or prefer not to use a microphone."><Switch checked={m.allowTextFallback} onChange={(v) => set({ allowTextFallback: v })} label="Allow typing" /></Row>
        </Group>
      </FormSection>

      <FormSection title="Voice and persona">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Language" hint="The moderator speaks and transcribes in this language.">
            <Select value={m.language} onChange={(e) => set({ language: e.target.value })}>
              {!LANGUAGES.some(([c]) => c === m.language) && <option value={m.language}>{m.language}</option>}
              {LANGUAGES.map(([c, l]) => (
                <option key={c} value={c}>{l} ({c})</option>
              ))}
            </Select>
          </Field>
          <Field label="Voice">
            <Select value={m.voice} onChange={(e) => set({ voice: e.target.value })}>
              {REALTIME_VOICES.map((v) => (
                <option key={v} value={v}>{v.charAt(0).toUpperCase() + v.slice(1)}{v === 'marin' || v === 'cedar' ? ' (most natural)' : ''}</option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Tone" hint="Persona guidance. Neutrality rules always apply.">
          <Input value={m.tone} onChange={(e) => set({ tone: e.target.value })} placeholder="warm, calm, curious and strictly neutral" />
        </Field>
        <FieldGroup label="Custom rules" hint="Extra guardrails appended verbatim to the moderator's rules.">
          <StringListEditor items={m.customRules} onChange={(customRules) => set({ customRules })} placeholder="e.g. Never mention competitor products by name." addLabel="Add rule" />
        </FieldGroup>
      </FormSection>
    </div>
  );
}

export function ConsentSettingsEditor({ p, onChange }: P) {
  const c = p.consent;
  const set = (patch: Partial<Protocol['consent']>) => onChange({ ...p, consent: { ...c, ...patch } });
  const [mode, setMode] = useState<'split' | 'write' | 'preview'>('split');
  return (
    <div className="space-y-5">
      <FormSection
        title="Consent text"
        description="Shown before anything is captured. Markdown supported. Cover purpose, procedure, duration, data collected, retention, voluntary participation and withdrawal."
        actions={
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => set({ text: DEFAULT_CONSENT.text })} className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-secondary hover:bg-black/[0.05]"><RotateCcw className="size-3" /> Default</button>
            <Segmented size="sm" value={mode} onChange={setMode} options={[{ value: 'write', label: 'Write' }, { value: 'split', label: 'Split' }, { value: 'preview', label: 'Preview' }]} />
          </div>
        }
      >
        <div className={cn('grid gap-3', mode === 'split' && 'lg:grid-cols-2')}>
          {mode !== 'preview' && <Textarea rows={18} value={c.text} onChange={(e) => set({ text: e.target.value })} className="font-mono text-xs leading-relaxed" />}
          {mode !== 'write' && (
            <div className="max-h-[440px] overflow-y-auto rounded-[10px] border border-separator bg-canvas px-4 py-2">
              <Markdown text={c.text} />
            </div>
          )}
        </div>
      </FormSection>
      <FormSection flush title="What is captured" description="Each item is shown to participants as a separate opt-in.">
        <Group className="ring-0">
          <Row label="Store voice recordings" description="The microphone is always needed for voice moderation. Turn this off to keep transcripts only."><Switch checked={c.storeAudio} onChange={(v) => set({ storeAudio: v })} label="Store voice recordings" /></Row>
          <Row label="Record session replay" description="DOM replay of the app. All inputs are masked."><Switch checked={c.recordScreen} onChange={(v) => set({ recordScreen: v })} label="Record session replay" /></Row>
          <Row label="Offer webcam eye tracking" description="Optional for the participant. Processed on device; only gaze points are stored."><Switch checked={c.offerEyeTracking} onChange={(v) => set({ offerEyeTracking: v })} label="Offer eye tracking" /></Row>
          <Row label="Require 18+ confirmation"><Switch checked={c.ageGate} onChange={(v) => set({ ageGate: v })} label="Require 18+" /></Row>
          <Row label="Consent version" description="Stored with every consent record. Change it when you edit the text."><Input value={c.version} onChange={(e) => set({ version: e.target.value })} className="h-8 w-24 text-right" /></Row>
        </Group>
      </FormSection>
    </div>
  );
}
