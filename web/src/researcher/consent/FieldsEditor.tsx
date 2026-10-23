// Participant-info fields collected at consent: built-ins (toggle, required/optional) and custom questions.
import { useState } from 'react';
import { ChevronDown, ChevronRight, Lock, Plus, Trash2 } from 'lucide-react';
import { FIELD_KIND_LABEL, PREFER_NOT_TO_SAY, type ParticipantField, type ParticipantFieldKind } from '@thinkaloud/shared';
import { Field, Input, Select, cn } from '../../ui/index.tsx';
import { Group, Menu, MenuItem, NumberInput, Row, Segmented, StringListEditor, Switch } from '../components/index.tsx';

const BUILTIN_DETAIL: Record<string, string> = {
  full_name: 'Personal information',
  age: 'Used for the minimum-age check',
  sex: `Female, male, intersex, ${PREFER_NOT_TO_SAY.toLowerCase()}`,
  gender: 'Woman, man, non-binary, self-describe, prefer not to say',
  email: 'Personal information · validated',
  country: 'Free text',
  occupation: 'Free text',
};

const ADDABLE: ParticipantFieldKind[] = ['short_text', 'long_text', 'number', 'single_select', 'multi_select', 'date', 'yes_no', 'likert'];

function newCustom(kind: ParticipantFieldKind): ParticipantField {
  const id = `cf_${Math.random().toString(36).slice(2, 8)}`;
  const f: ParticipantField = { id, kind, label: '', required: false, pii: false, enabled: true };
  if (kind === 'single_select' || kind === 'multi_select') f.options = ['', ''];
  if (kind === 'likert') f.likert = { points: 5, minLabel: 'Strongly disagree', maxLabel: 'Strongly agree' };
  return f;
}

export function FieldsEditor({ fields, onChange }: { fields: ParticipantField[]; onChange: (f: ParticipantField[]) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const set = (id: string, patch: Partial<ParticipantField>) => onChange(fields.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  const builtins = fields.filter((f) => f.builtin);
  const custom = fields.filter((f) => !f.builtin);

  return (
    <div className="space-y-6">
      <Group>
        {builtins.map((f) => (
          <Row
            key={f.id}
            label={
              <span className="inline-flex items-center gap-1.5">
                {f.builtin === 'age' ? (f.ageFormat === 'date_of_birth' ? 'Date of birth' : 'Age') : f.label}
                {f.pii && <Lock className="size-3 text-tertiary" aria-label="Personal information" />}
              </span>
            }
            description={BUILTIN_DETAIL[f.builtin!]}
          >
            <div className="flex items-center gap-3" data-testid={`builtin-${f.id}`}>
              {f.enabled && f.builtin === 'age' && (
                <Segmented
                  size="sm"
                  value={f.ageFormat ?? 'years'}
                  onChange={(v) => set(f.id, { ageFormat: v, kind: v === 'date_of_birth' ? 'date' : 'number', label: v === 'date_of_birth' ? 'Date of birth' : 'Age', pii: v === 'date_of_birth' })}
                  options={[{ value: 'years', label: 'Age' }, { value: 'date_of_birth', label: 'Date of birth' }]}
                />
              )}
              {f.enabled && (
                <Segmented size="sm" value={f.required ? 'req' : 'opt'} onChange={(v) => set(f.id, { required: v === 'req' })} options={[{ value: 'req', label: 'Required' }, { value: 'opt', label: 'Optional' }]} />
              )}
              <Switch checked={f.enabled} onChange={(v) => set(f.id, { enabled: v })} label={`Ask for ${f.label.toLowerCase()}`} />
            </div>
          </Row>
        ))}
      </Group>

      <div>
        <div className="mb-2 flex items-end justify-between px-1">
          <div>
            <h4 className="text-[13px] font-medium text-secondary">Your questions</h4>
            {!custom.length && <p className="mt-0.5 text-[13px] text-tertiary">Add anything else you need, like experience with similar products.</p>}
          </div>
          <Menu
            align="right"
            trigger={({ toggle }) => (
              <button type="button" onClick={toggle} className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[14px] text-brand-500 hover:bg-brand-500/[0.08]" data-testid="add-field">
                <Plus className="size-4" /> Add question
              </button>
            )}
          >
            {(close) =>
              ADDABLE.map((k) => (
                <MenuItem
                  key={k}
                  onClick={() => {
                    close();
                    const f = newCustom(k);
                    onChange([...fields, f]);
                    setOpen(f.id);
                  }}
                >
                  {FIELD_KIND_LABEL[k]}
                </MenuItem>
              ))
            }
          </Menu>
        </div>
        {custom.length > 0 && (
          <Group>
            {custom.map((f) => (
              <div key={f.id} data-testid={`custom-${f.id}`}>
                <button type="button" onClick={() => setOpen(open === f.id ? null : f.id)} className="flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-black/[0.02]" aria-expanded={open === f.id}>
                  {open === f.id ? <ChevronDown className="size-4 text-tertiary" /> : <ChevronRight className="size-4 text-tertiary" />}
                  <span className="min-w-0 flex-1">
                    <span className={cn('block truncate text-[14px]', f.label ? 'text-label' : 'text-tertiary')}>{f.label || 'Untitled question'}</span>
                    <span className="block text-[12px] text-secondary">
                      {FIELD_KIND_LABEL[f.kind]} · {f.required ? 'Required' : 'Optional'}
                      {f.pii ? ' · Personal' : ''}
                    </span>
                  </span>
                </button>
                {open === f.id && <CustomFieldForm f={f} onChange={(patch) => set(f.id, patch)} onDelete={() => onChange(fields.filter((x) => x.id !== f.id))} />}
              </div>
            ))}
          </Group>
        )}
      </div>
    </div>
  );
}

function CustomFieldForm({ f, onChange, onDelete }: { f: ParticipantField; onChange: (p: Partial<ParticipantField>) => void; onDelete: () => void }) {
  const select = f.kind === 'single_select' || f.kind === 'multi_select';
  return (
    <div className="space-y-4 border-t border-separator bg-canvas/60 px-5 py-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
        <Field label="Question">
          <Input autoFocus value={f.label} onChange={(e) => onChange({ label: e.target.value })} placeholder="e.g. How often do you shop online?" data-testid="custom-label" />
        </Field>
        <Field label="Answer type">
          <Select
            value={f.kind}
            onChange={(e) => {
              const kind = e.target.value as ParticipantFieldKind;
              onChange({ kind, options: kind === 'single_select' || kind === 'multi_select' ? (f.options?.length ? f.options : ['', '']) : undefined, likert: kind === 'likert' ? f.likert ?? { points: 5, minLabel: 'Strongly disagree', maxLabel: 'Strongly agree' } : undefined });
            }}
          >
            {ADDABLE.map((k) => (
              <option key={k} value={k}>{FIELD_KIND_LABEL[k]}</option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Help text" hint="Optional. Shown under the question.">
        <Input value={f.help ?? ''} onChange={(e) => onChange({ help: e.target.value })} />
      </Field>
      {select && (
        <div>
          <div className="mb-1.5 text-[13px] font-medium text-secondary">Options</div>
          <StringListEditor items={f.options ?? []} onChange={(options) => onChange({ options })} placeholder="Option" addLabel="Add option" />
          <label className="mt-3 flex items-center justify-between gap-4 text-[14px]">
            <span>
              Let people describe in their own words
              <span className="block text-[12px] text-secondary">Adds a “Prefer to self-describe” choice with a text box.</span>
            </span>
            <Switch checked={Boolean(f.allowOther)} onChange={(v) => onChange({ allowOther: v, otherLabel: v ? f.otherLabel || 'Prefer to self-describe' : undefined })} label="Allow self-describe" />
          </label>
        </div>
      )}
      {f.kind === 'number' && (
        <div className="grid max-w-sm grid-cols-2 gap-3">
          <Field label="Minimum"><NumberInput value={f.min} onChange={(min) => onChange({ min })} /></Field>
          <Field label="Maximum"><NumberInput value={f.max} onChange={(max) => onChange({ max })} /></Field>
        </div>
      )}
      {f.kind === 'likert' && f.likert && (
        <div className="grid gap-3 sm:grid-cols-[auto_1fr_1fr] sm:items-end">
          <div>
            <div className="mb-1.5 text-[13px] font-medium text-secondary">Points</div>
            <Segmented value={String(f.likert.points)} onChange={(v) => onChange({ likert: { ...f.likert!, points: v === '7' ? 7 : 5 } })} options={[{ value: '5', label: '5' }, { value: '7', label: '7' }]} />
          </div>
          <Field label="Low end"><Input value={f.likert.minLabel} onChange={(e) => onChange({ likert: { ...f.likert!, minLabel: e.target.value } })} /></Field>
          <Field label="High end"><Input value={f.likert.maxLabel} onChange={(e) => onChange({ likert: { ...f.likert!, maxLabel: e.target.value } })} /></Field>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-separator pt-4 text-[14px]">
        <label className="inline-flex items-center gap-2.5">
          <Switch checked={f.required} onChange={(required) => onChange({ required })} label="Required" /> Required
        </label>
        <label className="inline-flex items-center gap-2.5" title="Left out of exports when you choose “Exclude personal information”.">
          <Switch checked={f.pii} onChange={(pii) => onChange({ pii })} label="Personal information" /> Personal information
        </label>
        <button type="button" onClick={onDelete} className="ml-auto inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[13px] text-sys-red hover:bg-sys-red/[0.08]">
          <Trash2 className="size-3.5" /> Delete
        </button>
      </div>
    </div>
  );
}
