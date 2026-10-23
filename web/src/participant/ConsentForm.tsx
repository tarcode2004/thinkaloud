// Study consent form for participants: the typeset document (with the original for download),
// participant-info fields with accessible validation, capture opt-ins, signature, agree / decline.
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, Check, Download, FileText } from 'lucide-react';
import { collectsAge, validateParticipantInfo, type ConsentSignature, type ParticipantField, type ParticipantInfo, type PublicConsentForm, type PublicLinkInfo } from '@thinkaloud/shared';
import { apiDownload } from '../lib/api.ts';
import { safeMarkdown } from '../lib/markdown.ts';
import { Button, cn } from '../ui/index.tsx';
import { SwitchRow, type ConsentChoice } from './screens.tsx';

const ICON = { strokeWidth: 1.75 } as const;

export interface ConsentSubmission {
  choice: ConsentChoice;
  info: ParticipantInfo;
  signature: ConsentSignature;
}

const localDate = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const ext = (name: string) => (name.split('.').pop() ?? '').toUpperCase();

export function ConsentFormScreen({
  info,
  form,
  busy,
  error,
  serverErrors,
  onAccept,
  onDecline,
  onUnderAge,
}: {
  info: PublicLinkInfo;
  form: PublicConsentForm;
  busy: boolean;
  error?: string | null;
  serverErrors?: Record<string, string> | null;
  onAccept: (s: ConsentSubmission) => void;
  onDecline: () => void;
  onUnderAge: () => void;
}) {
  const c = info.consent;
  const html = useMemo(() => safeMarkdown(form.text), [form.text]);
  const words = useMemo(() => form.text.split(/\s+/).filter(Boolean).length, [form.text]);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [voice, setVoice] = useState(true);
  const [screen, setScreen] = useState(c.recordScreen);
  const [eye, setEye] = useState(false);
  const [age, setAge] = useState(false);
  const [sigName, setSigName] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [read, setRead] = useState(!form.requireScroll);
  const [summary, setSummary] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const docRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const today = useMemo(localDate, []);
  const needAgeConfirm = c.ageGate && !collectsAge(form);
  const fields = form.fields;

  useEffect(() => {
    if (read || !endRef.current || !docRef.current) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setRead(true), { root: docRef.current, threshold: 0.1 });
    io.observe(endRef.current);
    return () => io.disconnect();
  }, [read]);

  useEffect(() => {
    if (serverErrors && Object.keys(serverErrors).length) {
      setErrors((e) => ({ ...e, ...serverErrors }));
      focusFirst(Object.keys(serverErrors));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverErrors]);

  const focusFirst = (ids: string[]) => {
    const order = [...fields.map((f) => f.id), 'ageConfirm', 'signature', 'agree'];
    const first = order.find((id) => ids.includes(id));
    if (first) requestAnimationFrame(() => document.getElementById(`pf-${first}`)?.focus());
  };

  const valueFor = (f: ParticipantField): unknown => {
    const v = values[f.id];
    if (f.allowOther && v === OTHER) return other[f.id]?.trim() || '';
    if (f.allowOther && Array.isArray(v) && v.includes(OTHER)) return [...v.filter((x) => x !== OTHER), ...(other[f.id]?.trim() ? [other[f.id].trim()] : [])];
    return v;
  };

  const submit = () => {
    const raw: Record<string, unknown> = {};
    for (const f of fields) raw[f.id] = valueFor(f);
    const v = validateParticipantInfo(fields, raw, { minAge: form.minAge });
    const errs: Record<string, string> = { ...v.errors };
    for (const f of fields) if (f.allowOther && (values[f.id] === OTHER || (Array.isArray(values[f.id]) && (values[f.id] as unknown[]).includes(OTHER))) && !other[f.id]?.trim()) errs[f.id] = 'Please describe in your own words, or choose another option.';
    if (form.signature.mode === 'typed_name' && sigName.trim().length < 2) errs.signature = 'Type your full name to sign.';
    if (form.signature.mode === 'checkbox' && !agreed) errs.agree = 'Please confirm that you agree to take part.';
    if (needAgeConfirm && !age) errs.ageConfirm = `Please confirm that you are ${form.minAge} or older.`;
    setErrors(errs);
    if (!read) {
      setSummary('Please read the information to the end before you agree.');
      docRef.current?.focus();
      docRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const n = Object.keys(errs).length;
    if (n) {
      setSummary(n === 1 ? 'One answer needs your attention.' : `${n} answers need your attention.`);
      focusFirst(Object.keys(errs));
      return;
    }
    if (v.underAge) return onUnderAge();
    setSummary(null);
    onAccept({
      choice: { voice, screen, eyeTracking: eye, ageConfirmed: needAgeConfirm ? age : !v.underAge },
      info: v.values,
      signature: form.signature.mode === 'typed_name' ? { mode: 'typed_name', name: sigName.trim(), date: today, agreed: true } : { mode: 'checkbox', date: today, agreed: true },
    });
  };

  const set = (id: string, v: unknown) => {
    setValues((s) => ({ ...s, [id]: v }));
    if (errors[id]) setErrors(({ [id]: _drop, ...rest }) => rest);
  };

  const download = async () => {
    if (!form.document) return;
    setDownloading(true);
    try {
      await apiDownload(form.document.url, form.document.filename);
    } catch {
      setSummary('The original document could not be downloaded. The full text is shown above.');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div data-testid="consent" data-consent-form={form.version}>
      <p className="text-[15px] font-medium text-secondary">{info.studyName}</p>
      <h1 className="mt-1 text-[34px] font-bold leading-tight tracking-[-0.022em] text-label">{form.title}</h1>
      <p className="mt-2 text-[15px] text-secondary">
        Please read this carefully. It takes about {Math.max(1, Math.round(words / 200))} {Math.round(words / 200) > 1 ? 'minutes' : 'minute'}.
      </p>

      <div className="relative mt-6 overflow-hidden rounded-[22px] bg-surface shadow-[0_1px_2px_rgba(0,0,0,.04),0_4px_20px_rgba(0,0,0,.04)] ring-1 ring-black/[0.04]">
        <div className="relative">
        <div
          ref={docRef}
          tabIndex={0}
          role="region"
          aria-label="Consent information"
          data-testid="consent-doc"
          className={cn('overflow-y-auto px-7 py-7 outline-none focus-visible:ring-4 focus-visible:ring-brand-500/20 sm:px-10 sm:py-9', form.requireScroll && 'max-h-[min(62vh,640px)]')}
        >
          <div className="prose-doc mx-auto max-w-[62ch]" dangerouslySetInnerHTML={{ __html: html }} />
          <div ref={endRef} className="h-px" aria-hidden />
        </div>
        {!read && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-linear-to-t from-white to-white/0" aria-hidden />}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-separator px-5 py-3 text-[13px]">
          <span className={cn('inline-flex items-center gap-1.5', read ? 'text-secondary' : 'text-tertiary')} aria-live="polite" data-testid="read-status">
            {read ? <><Check className="size-3.5 text-sys-green" strokeWidth={2.5} /> Read to the end</> : 'Scroll to the end to continue'}
          </span>
          <span className="flex items-center gap-3 text-tertiary">
            <span className="tabular-nums">Version {form.version}</span>
            {form.document && (
              <button type="button" onClick={download} disabled={downloading} className="inline-flex items-center gap-1 font-medium text-brand-500 hover:underline disabled:opacity-60" data-testid="download-original">
                <Download className="size-3.5" {...ICON} /> Original {ext(form.document.filename)} · {kb(form.document.size)}
              </button>
            )}
          </span>
        </div>
      </div>

      {fields.length > 0 && (
        <section className="mt-10" aria-labelledby="about-you">
          <h2 id="about-you" className="mb-1 ml-1 text-[22px] font-semibold tracking-[-0.015em] text-label">About you</h2>
          <p className="mb-4 ml-1 text-[15px] text-secondary">Fields marked optional can be left blank.</p>
          <div className="overflow-hidden rounded-[18px] bg-surface ring-1 ring-black/[0.04]">
            {fields.map((f) => (
              <FieldRow key={f.id} f={f} error={errors[f.id]}>
                <FieldInput f={f} value={values[f.id]} other={other[f.id] ?? ''} invalid={Boolean(errors[f.id])} onChange={(v) => set(f.id, v)} onOther={(t) => (setOther((o) => ({ ...o, [f.id]: t })), errors[f.id] && setErrors(({ [f.id]: _d, ...r }) => r))} />
              </FieldRow>
            ))}
          </div>
        </section>
      )}

      <h2 className="mb-2 ml-5 mt-10 text-[13px] text-secondary">Your choices</h2>
      <div className="overflow-hidden rounded-[18px] bg-surface">
        <SwitchRow checked={voice} onChange={setVoice} label="Talk with the moderator using my microphone" detail={`Your voice is ${c.storeAudio ? 'recorded and ' : ''}transcribed. Turn this off to type instead.`} testId="opt-voice" />
        {c.recordScreen && <SwitchRow checked={screen} onChange={setScreen} label="Record my activity on the website" detail="Clicks, scrolling and pages visited. Text you type is masked." testId="opt-screen" />}
        {c.offerEyeTracking && <SwitchRow checked={eye} onChange={setEye} label="Use my webcam to estimate where I look" detail="Optional. Processed on your device — no video is stored." testId="opt-eye" />}
        {needAgeConfirm && (
          <div id="pf-ageConfirm" tabIndex={-1} className="outline-none">
            <SwitchRow checked={age} onChange={(v) => (setAge(v), setErrors(({ ageConfirm: _a, ...r }) => r))} label={`I am ${form.minAge} years or older`} testId="opt-age" />
          </div>
        )}
      </div>
      {errors.ageConfirm && <ErrorText id="err-ageConfirm">{errors.ageConfirm}</ErrorText>}

      <section className="mt-10" aria-labelledby="sign">
        <h2 id="sign" className="mb-4 ml-1 text-[22px] font-semibold tracking-[-0.015em] text-label">Your consent</h2>
        <div className="rounded-[18px] bg-surface p-5 ring-1 ring-black/[0.04]">
          {form.signature.mode === 'typed_name' ? (
            <>
              <p className="text-[15px] leading-relaxed text-label">{form.signature.agreeLabel}</p>
              <label htmlFor="pf-signature" className="mt-4 block text-[13px] font-medium text-secondary">Type your full name to sign</label>
              <div className="mt-1.5 flex flex-wrap items-end gap-x-6 gap-y-3">
                <input
                  id="pf-signature"
                  data-testid="sig-name"
                  value={sigName}
                  onChange={(e) => (setSigName(e.target.value), errors.signature && setErrors(({ signature: _s, ...r }) => r))}
                  autoComplete="name"
                  aria-invalid={Boolean(errors.signature)}
                  aria-describedby={errors.signature ? 'err-signature' : undefined}
                  className={cn(inputCls, 'min-w-0 flex-1 font-medium italic tracking-[-0.01em]', errors.signature && invalidCls)}
                />
                <div className="pb-2.5 text-[15px] text-secondary">
                  Date <span className="ml-1 tabular-nums text-label">{new Date(`${today}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}</span>
                </div>
              </div>
              {errors.signature && <ErrorText id="err-signature">{errors.signature}</ErrorText>}
            </>
          ) : (
            <>
              <label className="flex cursor-pointer items-start gap-3.5">
                <input id="pf-agree" type="checkbox" checked={agreed} onChange={(e) => (setAgreed(e.target.checked), setErrors(({ agree: _a, ...r }) => r))} className="peer sr-only" data-testid="sig-agree" aria-invalid={Boolean(errors.agree)} aria-describedby={errors.agree ? 'err-agree' : undefined} />
                <span aria-hidden className={cn('mt-0.5 flex size-[22px] shrink-0 items-center justify-center rounded-[7px] border-[1.5px] transition-colors peer-focus-visible:ring-4 peer-focus-visible:ring-brand-500/25', agreed ? 'border-brand-500 bg-brand-500 text-white' : errors.agree ? 'border-sys-red' : 'border-black/25')}>
                  {agreed && <Check className="size-3.5" strokeWidth={3} />}
                </span>
                <span className="text-[15px] leading-relaxed text-label">{form.signature.agreeLabel}</span>
              </label>
              {errors.agree && <ErrorText id="err-agree">{errors.agree}</ErrorText>}
            </>
          )}
        </div>
        <p className="mx-1 mt-2 text-[13px] leading-relaxed text-tertiary">The moderator is an AI. You can stop at any time with “Stop & withdraw”, and everything recorded is deleted.</p>
      </section>

      <div ref={summaryRef} role="alert" aria-live="assertive">
        {(summary || error) && (
          <p className="mt-6 flex items-start gap-2 text-[15px] text-sys-red" data-testid="consent-error">
            <AlertCircle className="mt-0.5 size-4 shrink-0" {...ICON} /> {summary ?? error}
          </p>
        )}
      </div>
      <div className="mt-8 flex flex-wrap items-center gap-3">
        <Button size="lg" loading={busy} onClick={submit} data-testid="accept-consent">
          I agree, continue
        </Button>
        <Button size="lg" variant="secondary" onClick={onDecline} disabled={busy} data-testid="decline-consent">
          No thanks
        </Button>
      </div>
    </div>
  );
}

const OTHER = '__other__';
const inputCls = 'block h-12 w-full rounded-[12px] border border-black/[0.12] bg-white px-4 text-[17px] text-label placeholder:text-tertiary transition-shadow duration-200 focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-brand-500/15';
const invalidCls = 'border-sys-red focus:border-sys-red focus:ring-sys-red/15';

function ErrorText({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="mt-2 flex items-center gap-1.5 text-[13px] text-sys-red">
      <AlertCircle className="size-3.5 shrink-0" {...ICON} /> {children}
    </p>
  );
}

function FieldRow({ f, error, children }: { f: ParticipantField; error?: string; children: ReactNode }) {
  const group = f.kind === 'single_select' || f.kind === 'multi_select' || f.kind === 'yes_no' || f.kind === 'likert';
  const Label = group ? 'div' : 'label';
  return (
    <div className="bg-surface px-5 py-4 [&+&]:border-t [&+&]:border-separator" data-testid={`field-${f.id}`} role={group ? 'group' : undefined} aria-labelledby={group ? `lbl-${f.id}` : undefined}>
      <Label id={`lbl-${f.id}`} {...(group ? {} : { htmlFor: `pf-${f.id}` })} className="flex items-baseline gap-2 text-[15px] font-medium text-label">
        {f.label}
        {!f.required && <span className="text-[13px] font-normal text-tertiary">Optional</span>}
      </Label>
      {f.help && <p id={`help-${f.id}`} className="mt-0.5 text-[13px] leading-snug text-secondary">{f.help}</p>}
      <div className="mt-2.5">{children}</div>
      {error && <ErrorText id={`err-${f.id}`}>{error}</ErrorText>}
    </div>
  );
}

function FieldInput({ f, value, other, invalid, onChange, onOther }: { f: ParticipantField; value: unknown; other: string; invalid: boolean; onChange: (v: unknown) => void; onOther: (t: string) => void }) {
  const describedBy = [f.help ? `help-${f.id}` : '', invalid ? `err-${f.id}` : ''].filter(Boolean).join(' ') || undefined;
  const common = { id: `pf-${f.id}`, 'aria-invalid': invalid || undefined, 'aria-describedby': describedBy, 'aria-required': f.required || undefined };
  const name = useId();
  switch (f.kind) {
    case 'short_text':
      return (
        <input
          {...common}
          type={f.builtin === 'email' ? 'email' : 'text'}
          inputMode={f.builtin === 'email' ? 'email' : undefined}
          autoComplete={f.builtin === 'full_name' ? 'name' : f.builtin === 'email' ? 'email' : f.builtin === 'country' ? 'country-name' : f.builtin === 'occupation' ? 'organization-title' : 'off'}
          value={String(value ?? '')}
          maxLength={200}
          onChange={(e) => onChange(e.target.value)}
          className={cn(inputCls, invalid && invalidCls)}
        />
      );
    case 'long_text':
      return <textarea {...common} rows={4} maxLength={5000} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} className={cn(inputCls, 'h-auto py-3 leading-relaxed', invalid && invalidCls)} />;
    case 'number':
      return (
        <input
          {...common}
          type="number"
          inputMode={f.builtin === 'age' ? 'numeric' : 'decimal'}
          min={f.min}
          max={f.max}
          value={value === undefined ? '' : String(value)}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
          className={cn(inputCls, 'max-w-[180px] tabular-nums', invalid && invalidCls)}
        />
      );
    case 'date':
      return <input {...common} type="date" max={localDate()} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} autoComplete={f.builtin === 'age' ? 'bday' : 'off'} className={cn(inputCls, 'max-w-[220px] tabular-nums', invalid && invalidCls)} />;
    case 'yes_no':
      return (
        <div className="inline-flex rounded-[12px] bg-black/[0.06] p-[3px]" role="radiogroup" aria-labelledby={`lbl-${f.id}`} aria-describedby={describedBy}>
          {([true, false] as const).map((b, i) => (
            <label key={String(b)} className={cn('cursor-pointer rounded-[9px] px-6 py-2 text-[15px] font-medium transition-all duration-200 ease-apple has-[:focus-visible]:ring-4 has-[:focus-visible]:ring-brand-500/25', value === b ? 'bg-white text-label shadow-[0_1px_3px_rgba(0,0,0,.12)]' : 'text-secondary hover:text-label')}>
              <input type="radio" name={name} id={i === 0 ? `pf-${f.id}` : undefined} className="sr-only" checked={value === b} onChange={() => onChange(b)} />
              {b ? 'Yes' : 'No'}
            </label>
          ))}
        </div>
      );
    case 'likert': {
      const pts = f.likert?.points ?? 5;
      return (
        <div role="radiogroup" aria-labelledby={`lbl-${f.id}`} aria-describedby={describedBy}>
          <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${pts}, minmax(0, 1fr))` }}>
            {Array.from({ length: pts }, (_, i) => i + 1).map((n) => (
              <label key={n} className={cn('flex h-11 cursor-pointer items-center justify-center rounded-[10px] text-[15px] font-medium tabular-nums transition-colors has-[:focus-visible]:ring-4 has-[:focus-visible]:ring-brand-500/25', value === n ? 'bg-brand-500 text-white' : 'bg-fill text-label hover:bg-black/[0.07]')}>
                <input type="radio" name={name} id={n === 1 ? `pf-${f.id}` : undefined} className="sr-only" checked={value === n} onChange={() => onChange(n)} aria-label={n === 1 ? `1, ${f.likert?.minLabel}` : n === pts ? `${pts}, ${f.likert?.maxLabel}` : String(n)} />
                {n}
              </label>
            ))}
          </div>
          <div className="mt-1.5 flex justify-between text-[12px] text-tertiary">
            <span>{f.likert?.minLabel}</span>
            <span>{f.likert?.maxLabel}</span>
          </div>
        </div>
      );
    }
    case 'single_select':
    case 'multi_select': {
      const multi = f.kind === 'multi_select';
      const sel = multi ? (Array.isArray(value) ? (value as string[]) : []) : value;
      const opts = [...(f.options ?? []), ...(f.allowOther ? [OTHER] : [])];
      const isOn = (o: string) => (multi ? (sel as string[]).includes(o) : sel === o);
      const toggle = (o: string) => (multi ? onChange(isOn(o) ? (sel as string[]).filter((x) => x !== o) : [...(sel as string[]), o]) : onChange(o));
      return (
        <div className="overflow-hidden rounded-[12px] border border-black/[0.08]" role={multi ? undefined : 'radiogroup'} aria-labelledby={`lbl-${f.id}`} aria-describedby={describedBy}>
          {opts.map((o, i) => {
            const on = isOn(o);
            return (
              <div key={o} className={cn(i > 0 && 'border-t border-black/[0.06]')}>
                <label className={cn('flex min-h-11 cursor-pointer items-center gap-3 px-4 py-2.5 text-[15px] transition-colors has-[:focus-visible]:bg-brand-500/[0.06]', on ? 'bg-brand-500/[0.05]' : 'hover:bg-black/[0.02]')}>
                  <input type={multi ? 'checkbox' : 'radio'} name={name} id={i === 0 ? `pf-${f.id}` : undefined} className="peer sr-only" checked={on} onChange={() => toggle(o)} data-option={o} />
                  <span aria-hidden className={cn('flex size-5 shrink-0 items-center justify-center border-[1.5px] transition-colors', multi ? 'rounded-[6px]' : 'rounded-full', on ? 'border-brand-500 bg-brand-500 text-white' : 'border-black/25')}>
                    {on && (multi ? <Check className="size-3" strokeWidth={3} /> : <span className="size-2 rounded-full bg-white" />)}
                  </span>
                  <span className="text-label">{o === OTHER ? f.otherLabel || 'Other' : o}</span>
                </label>
                {o === OTHER && on && (
                  <div className="px-4 pb-3 pl-12">
                    <input aria-label={f.otherLabel || 'Other'} autoFocus value={other} maxLength={200} onChange={(e) => onOther(e.target.value)} className={cn(inputCls, 'h-10 text-[15px]')} data-testid={`other-${f.id}`} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      );
    }
  }
}

// ── terminal screens ─────────────────────────────────────────────────────────

export function Declined() {
  return (
    <div data-testid="declined">
      <span className="flex size-12 items-center justify-center rounded-full bg-fill text-secondary">
        <FileText className="size-6" {...ICON} />
      </span>
      <h1 className="mt-6 text-[34px] font-bold leading-tight tracking-[-0.022em] text-label">No problem</h1>
      <p className="mt-3 text-[17px] leading-relaxed text-secondary">You chose not to take part, so nothing was recorded and none of your answers were saved. Thanks for considering it — you can close this window.</p>
    </div>
  );
}

export function UnderAge({ minAge }: { minAge: number }) {
  return (
    <div data-testid="under-age">
      <h1 className="text-[34px] font-bold leading-tight tracking-[-0.022em] text-label">Thanks for your interest</h1>
      <p className="mt-3 text-[17px] leading-relaxed text-secondary">This study is for people aged {minAge} and over, so we can’t include you this time. Nothing you entered has been saved. You can close this window.</p>
    </div>
  );
}
