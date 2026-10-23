// Study consent forms: defaults, normalization, participant-info validation, readability and the
// deterministic informed-consent lint. Pure functions, shared by the server (authoritative) and the
// web app (live checks and client-side validation). Types live in types.ts ("Consent").
import type {
  BuiltinFieldId,
  ConsentCapture,
  ConsentElementId,
  ConsentElementStatus,
  ConsentForm,
  ConsentIssue,
  ConsentReadability,
  ParticipantField,
  ParticipantFieldKind,
  ParticipantFieldSnapshot,
  ParticipantInfo,
  ParticipantValue,
  SignatureMode,
} from './types.ts';

// ── Defaults ─────────────────────────────────────────────────────────────────

export const PREFER_NOT_TO_SAY = 'Prefer not to say';

export const BUILTIN_FIELDS: Record<BuiltinFieldId, ParticipantField> = {
  full_name: { id: 'full_name', builtin: 'full_name', kind: 'short_text', label: 'Full name', required: true, pii: true, enabled: false },
  age: { id: 'age', builtin: 'age', kind: 'number', label: 'Age', help: 'In years.', required: true, pii: false, enabled: false, ageFormat: 'years', min: 0, max: 120 },
  sex: {
    id: 'sex', builtin: 'sex', kind: 'single_select', label: 'Sex', help: 'Sex recorded at birth.', required: false, pii: false, enabled: false,
    options: ['Female', 'Male', 'Intersex', PREFER_NOT_TO_SAY],
  },
  gender: {
    id: 'gender', builtin: 'gender', kind: 'single_select', label: 'Gender identity', required: false, pii: false, enabled: false,
    options: ['Woman', 'Man', 'Non-binary', PREFER_NOT_TO_SAY], allowOther: true, otherLabel: 'Prefer to self-describe',
  },
  email: { id: 'email', builtin: 'email', kind: 'short_text', label: 'Email address', help: 'Only used to contact you about this study.', required: true, pii: true, enabled: false },
  country: { id: 'country', builtin: 'country', kind: 'short_text', label: 'Country of residence', required: false, pii: false, enabled: false },
  occupation: { id: 'occupation', builtin: 'occupation', kind: 'short_text', label: 'Occupation', required: false, pii: false, enabled: false },
};
export const BUILTIN_ORDER: BuiltinFieldId[] = ['full_name', 'age', 'sex', 'gender', 'email', 'country', 'occupation'];

export const FIELD_KIND_LABEL: Record<ParticipantFieldKind, string> = {
  short_text: 'Short text',
  long_text: 'Long text',
  number: 'Number',
  single_select: 'Single choice',
  multi_select: 'Multiple choice',
  date: 'Date',
  yes_no: 'Yes / no',
  likert: 'Agreement scale',
};

export const DEFAULT_AGREE_LABEL = 'I have read this information and agree to take part.';

export const DEFAULT_CONSENT_DOCUMENT = `## About this study

We are testing a website to find out how easy it is to use. **We are testing the website, not you**, so there are no wrong answers.

## What will happen

An **AI moderator** (a computer voice, not a person) will guide you. You will try a few short tasks on the website and say out loud what you are thinking. Afterwards we will ask you a few questions. The session takes about 15 minutes.

## What we record

- Your voice, and a written transcript of what you say
- What you do on the website: clicks, scrolling and the pages you visit. Text you type into the website is hidden.
- Your answers to our questions
- If you choose to turn it on: an estimate of where you look on the screen, worked out from your webcam on your own device. No video is saved.

Your voice is processed by our AI provider (OpenAI) to run the conversation.

## Risks and benefits

There are no known risks beyond everyday computer use. Some tasks may feel hard; you can skip any task. You will not benefit directly, but you will help us make the website better.

## Payment

You will receive the payment described in the study listing. You will be paid even if you stop early.

## Your data

We keep your data private and store it securely on our servers. Only the research team can see it. We will delete it 12 months after the study ends. When we report results, we will not use your name.

## Taking part is your choice

Taking part is voluntary. You can stop at any time, without giving a reason, using the **Stop & withdraw** button. If you withdraw, everything recorded in your session is deleted.

You must be 18 or older to take part.

## Questions

Contact the researcher at researcher@example.org. If you have concerns about how this study is run, contact the ethics board at ethics@example.org.`;

export function defaultConsentForm(): ConsentForm {
  return {
    enabled: false,
    title: 'Consent to take part',
    text: DEFAULT_CONSENT_DOCUMENT,
    documentId: null,
    version: 0,
    hash: '',
    updatedAt: 0,
    fields: BUILTIN_ORDER.map((id) => ({ ...BUILTIN_FIELDS[id], options: BUILTIN_FIELDS[id].options ? [...BUILTIN_FIELDS[id].options!] : undefined })),
    signature: { mode: 'checkbox', agreeLabel: DEFAULT_AGREE_LABEL },
    minAge: 18,
    requireScroll: true,
    lastCheck: null,
    history: [],
  };
}

// ── Normalization ────────────────────────────────────────────────────────────

const KINDS: ParticipantFieldKind[] = ['short_text', 'long_text', 'number', 'single_select', 'multi_select', 'date', 'yes_no', 'likert'];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const s = (v: unknown, max: number, fallback = ''): string => (typeof v === 'string' ? v.slice(0, max) : fallback);
const n = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const strList = (v: unknown, maxItems = 50, maxLen = 200): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string').map((x) => x.trim().slice(0, maxLen)).filter(Boolean))].slice(0, maxItems) : [];

export const MAX_CUSTOM_FIELDS = 40;
export const MAX_CONSENT_TEXT = 100_000;

function normalizeField(raw: Record<string, unknown>, base?: ParticipantField): ParticipantField | null {
  const kind = (base?.kind && base.builtin !== 'age' ? base.kind : KINDS.includes(raw.kind as ParticipantFieldKind) ? (raw.kind as ParticipantFieldKind) : base?.kind) ?? null;
  if (!kind) return null;
  const f: ParticipantField = {
    id: base?.id ?? s(raw.id, 64),
    kind,
    label: s(raw.label, 200).trim() || base?.label || 'Untitled question',
    required: typeof raw.required === 'boolean' ? raw.required : (base?.required ?? false),
    pii: typeof raw.pii === 'boolean' ? raw.pii : (base?.pii ?? false),
    enabled: base ? (typeof raw.enabled === 'boolean' ? raw.enabled : base.enabled) : true,
  };
  if (base?.builtin) f.builtin = base.builtin;
  const help = s(raw.help, 500).trim();
  if (help) f.help = help;
  else if (base?.help && raw.help === undefined) f.help = base.help;
  if (kind === 'single_select' || kind === 'multi_select') {
    const opts = strList(raw.options);
    f.options = opts.length ? opts : base?.options ? [...base.options] : [];
    if (typeof raw.allowOther === 'boolean' ? raw.allowOther : base?.allowOther) {
      f.allowOther = true;
      f.otherLabel = s(raw.otherLabel, 100).trim() || base?.otherLabel || 'Other';
    }
  }
  if (kind === 'number') {
    const min = n(raw.min) ?? base?.min;
    const max = n(raw.max) ?? base?.max;
    if (min !== undefined) f.min = min;
    if (max !== undefined) f.max = max;
  }
  if (kind === 'likert') {
    const l = isObj(raw.likert) ? raw.likert : {};
    f.likert = { points: l.points === 7 ? 7 : 5, minLabel: s(l.minLabel, 60).trim() || 'Strongly disagree', maxLabel: s(l.maxLabel, 60).trim() || 'Strongly agree' };
  }
  if (base?.builtin === 'age') {
    f.ageFormat = raw.ageFormat === 'date_of_birth' ? 'date_of_birth' : 'years';
    f.kind = f.ageFormat === 'date_of_birth' ? 'date' : 'number';
    if (f.kind === 'number') {
      f.min = 0;
      f.max = 120;
    }
    if (raw.label === undefined || raw.label === BUILTIN_FIELDS.age.label || raw.label === 'Date of birth') f.label = f.ageFormat === 'date_of_birth' ? 'Date of birth' : 'Age';
    if (raw.help === undefined || raw.help === BUILTIN_FIELDS.age.help) f.help = f.ageFormat === 'date_of_birth' ? undefined : BUILTIN_FIELDS.age.help;
    if (!f.help) delete f.help;
  }
  return f;
}

/** Tolerant parse of a stored/edited form: fills defaults, keeps every built-in in order, sanitizes custom fields. */
export function normalizeConsentForm(raw: unknown): ConsentForm {
  const d = defaultConsentForm();
  if (!isObj(raw)) return d;
  const rawFields = Array.isArray(raw.fields) ? raw.fields.filter(isObj) : [];
  const fields: ParticipantField[] = [];
  for (const id of BUILTIN_ORDER) {
    const r = rawFields.find((f) => f.id === id || f.builtin === id) ?? {};
    fields.push(normalizeField(r, BUILTIN_FIELDS[id])!);
  }
  const seen = new Set<string>(BUILTIN_ORDER);
  for (const r of rawFields) {
    if (BUILTIN_ORDER.includes(r.id as BuiltinFieldId) || r.builtin) continue;
    let id = s(r.id, 64).replace(/[^a-zA-Z0-9_-]/g, '');
    if (!/^cf_/.test(id)) id = `cf_${id || Math.random().toString(36).slice(2, 8)}`;
    while (seen.has(id)) id = `${id}_2`;
    const f = normalizeField({ ...r, id });
    if (!f) continue;
    f.id = id;
    seen.add(id);
    fields.push(f);
    if (fields.length >= BUILTIN_ORDER.length + MAX_CUSTOM_FIELDS) break;
  }
  const sig = isObj(raw.signature) ? raw.signature : {};
  const mode: SignatureMode = sig.mode === 'typed_name' ? 'typed_name' : 'checkbox';
  const minAge = n(raw.minAge);
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : d.enabled,
    title: s(raw.title, 200).trim() || d.title,
    text: typeof raw.text === 'string' ? raw.text.slice(0, MAX_CONSENT_TEXT) : d.text,
    documentId: typeof raw.documentId === 'string' && raw.documentId ? raw.documentId.slice(0, 100) : null,
    version: Math.max(0, Math.floor(n(raw.version) ?? 0)),
    hash: s(raw.hash, 128),
    updatedAt: n(raw.updatedAt) ?? 0,
    fields,
    signature: { mode, agreeLabel: s(sig.agreeLabel, 300).trim() || DEFAULT_AGREE_LABEL },
    minAge: minAge === undefined ? 18 : Math.max(0, Math.min(99, Math.round(minAge))),
    requireScroll: typeof raw.requireScroll === 'boolean' ? raw.requireScroll : d.requireScroll,
    lastCheck: isObj(raw.lastCheck) ? (raw.lastCheck as unknown as ConsentForm['lastCheck']) : null,
    history: Array.isArray(raw.history) ? (raw.history.filter(isObj).slice(0, 100) as unknown as ConsentForm['history']) : [],
  };
}

/** Canonical participant-facing content of a form (hashed for versioning). */
export function consentContent(f: ConsentForm): string {
  return JSON.stringify({
    title: f.title,
    text: f.text.replace(/\r\n/g, '\n').trim(),
    fields: f.fields.filter((x) => x.enabled),
    signature: f.signature,
    minAge: f.minAge,
    requireScroll: f.requireScroll,
  });
}

export const activeFields = (f: Pick<ConsentForm, 'fields'>) => f.fields.filter((x) => x.enabled);
export const fieldSnapshot = (f: ParticipantField): ParticipantFieldSnapshot => ({ id: f.id, label: f.label, kind: f.kind, pii: f.pii });
export const collectsAge = (f: Pick<ConsentForm, 'fields'>) => f.fields.some((x) => x.builtin === 'age' && x.enabled);

// ── Participant info validation ──────────────────────────────────────────────

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseIsoDate(v: string): Date | null {
  const m = ISO_DATE.exec(v);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? d : null;
}

/** Whole years between a date of birth and today (UTC). */
export function ageFromDob(dob: Date, today = new Date()): number {
  let age = today.getUTCFullYear() - dob.getUTCFullYear();
  const m = today.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && today.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}

export const isEmptyValue = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length);

export interface ParticipantInfoResult {
  values: ParticipantInfo;
  errors: Record<string, string>;
  /** Age in years when an age / date-of-birth field was answered. */
  age: number | null;
  underAge: boolean;
}

function lc(label: string) {
  return label.charAt(0).toLowerCase() + label.slice(1);
}

/** Validate participant-info values against the form's enabled fields. Unknown keys are dropped. */
export function validateParticipantInfo(fields: ParticipantField[], raw: Record<string, unknown> | null | undefined, opts: { minAge?: number; today?: Date } = {}): ParticipantInfoResult {
  const values: ParticipantInfo = {};
  const errors: Record<string, string> = {};
  let age: number | null = null;
  const input = raw ?? {};
  for (const f of fields) {
    if (!f.enabled) continue;
    const v = input[f.id];
    if (isEmptyValue(v) || (f.kind === 'yes_no' && typeof v !== 'boolean')) {
      if (!isEmptyValue(v) && f.kind === 'yes_no') errors[f.id] = 'Please answer yes or no.';
      else if (f.required)
        errors[f.id] =
          f.kind === 'single_select' || f.kind === 'likert' ? 'Please choose an option.' : f.kind === 'multi_select' ? 'Please choose at least one option.' : f.kind === 'yes_no' ? 'Please answer yes or no.' : `Please enter your ${lc(f.label)}.`;
      continue;
    }
    const set = (x: ParticipantValue) => (values[f.id] = x);
    switch (f.kind) {
      case 'short_text':
      case 'long_text': {
        if (typeof v !== 'string') { errors[f.id] = 'Please enter text.'; break; }
        const t = v.trim();
        const max = f.kind === 'short_text' ? 200 : 5000;
        if (t.length > max) errors[f.id] = `Please keep this under ${max} characters.`;
        else if (f.builtin === 'email' && !EMAIL.test(t)) errors[f.id] = 'Please enter a valid email address, like name@example.com.';
        else set(t);
        break;
      }
      case 'number': {
        const x = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
        if (!Number.isFinite(x)) { errors[f.id] = 'Please enter a number.'; break; }
        if (f.builtin === 'age' && !Number.isInteger(x)) { errors[f.id] = 'Please enter your age in whole years.'; break; }
        if (f.min !== undefined && x < f.min) { errors[f.id] = `Please enter a number of at least ${f.min}.`; break; }
        if (f.max !== undefined && x > f.max) { errors[f.id] = `Please enter a number no higher than ${f.max}.`; break; }
        set(x);
        if (f.builtin === 'age') age = x;
        break;
      }
      case 'date': {
        const d = typeof v === 'string' ? parseIsoDate(v) : null;
        if (!d) { errors[f.id] = 'Please enter a valid date.'; break; }
        const today = opts.today ?? new Date();
        if (d.getTime() > today.getTime()) { errors[f.id] = 'Please enter a date that is not in the future.'; break; }
        if (f.builtin === 'age') {
          const a = ageFromDob(d, today);
          if (a > 120) { errors[f.id] = 'Please check the year.'; break; }
          age = a;
        }
        set(v as string);
        break;
      }
      case 'single_select': {
        if (typeof v !== 'string') { errors[f.id] = 'Please choose an option.'; break; }
        const t = v.trim();
        if ((f.options ?? []).includes(t)) set(t);
        else if (f.allowOther && t.length <= 200) set(t);
        else errors[f.id] = 'Please choose one of the options.';
        break;
      }
      case 'multi_select': {
        const arr = Array.isArray(v) ? v : [v];
        if (!arr.every((x) => typeof x === 'string')) { errors[f.id] = 'Please choose from the options.'; break; }
        const clean = [...new Set((arr as string[]).map((x) => x.trim()).filter(Boolean))];
        const bad = clean.filter((x) => !(f.options ?? []).includes(x));
        if (bad.length && !(f.allowOther && bad.length === 1 && bad[0].length <= 200)) errors[f.id] = 'Please choose from the options.';
        else if (!clean.length && f.required) errors[f.id] = 'Please choose at least one option.';
        else if (clean.length) set(clean);
        break;
      }
      case 'yes_no':
        set(v as boolean);
        break;
      case 'likert': {
        const x = typeof v === 'number' ? v : Number(v);
        const pts = f.likert?.points ?? 5;
        if (!Number.isInteger(x) || x < 1 || x > pts) errors[f.id] = 'Please choose an option.';
        else set(x);
        break;
      }
    }
  }
  const minAge = opts.minAge ?? 0;
  return { values, errors, age, underAge: age !== null && minAge > 0 && age < minAge };
}

// ── Readability ──────────────────────────────────────────────────────────────

/** Markdown → plain prose lines (headings dropped; list items kept as their own sentences). */
export function consentPlainText(md: string): { prose: string[]; headings: string[] } {
  const prose: string[] = [];
  const headings: string[] = [];
  for (const raw of md.replace(/\r\n/g, '\n').split('\n')) {
    let line = raw.trim();
    if (!line) continue;
    if (/^#{1,6}\s/.test(line)) {
      headings.push(line.replace(/^#+\s*/, ''));
      continue;
    }
    line = line
      .replace(/^([-*+]|\d+[.)])\s+/, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/[*_`~]+/g, '')
      .replace(/^>\s*/, '')
      .trim();
    if (line && !/^[-=_*]{3,}$/.test(line)) prose.push(line);
  }
  return { prose, headings };
}

export function splitSentences(prose: string[]): string[] {
  const out: string[] = [];
  for (const line of prose) {
    // Protect common abbreviations and e-mail/URLs from splitting.
    const safe = line.replace(/\b(e\.g|i\.e|etc|approx|Dr|Mr|Mrs|Ms|Prof|vs)\./gi, (m) => m.replace('.', '․')).replace(/(\w)\.(\w)/g, '$1․$2');
    for (const part of safe.split(/(?<=[.!?])\s+/)) {
      const t = part.replace(/․/g, '.').trim();
      if (t) out.push(t);
    }
  }
  return out;
}

const WORD = /[A-Za-zÀ-ÖØ-öø-ÿ'’]+(?:-[A-Za-zÀ-ÖØ-öø-ÿ]+)*|\d+(?:[.,]\d+)?/g;
export const wordsOf = (t: string) => t.match(WORD) ?? [];

export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 1;
  if (w.length <= 3) return 1;
  const stripped = w.replace(/(?:[^laeiouy]es|[^laeiouy]ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const groups = stripped.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

export function readability(md: string): ConsentReadability {
  const sentences = splitSentences(consentPlainText(md).prose);
  let words = 0;
  let syl = 0;
  for (const sn of sentences) {
    for (const w of wordsOf(sn)) {
      words++;
      syl += /^\d/.test(w) ? 1 : syllables(w);
    }
  }
  const sc = Math.max(1, sentences.length);
  const wc = Math.max(1, words);
  const wps = wc / sc;
  const spw = syl / wc;
  const round1 = (x: number) => Math.round(x * 10) / 10;
  return {
    grade: words ? round1(Math.max(0, 0.39 * wps + 11.8 * spw - 15.59)) : 0,
    ease: words ? round1(Math.max(0, Math.min(100, 206.835 - 1.015 * wps - 84.6 * spw))) : 100,
    words,
    sentences: sentences.length,
    avgSentenceWords: words ? round1(wps) : 0,
    minutes: Math.max(1, Math.round(words / 200)),
  };
}

// ── Lint ─────────────────────────────────────────────────────────────────────

export const CONSENT_ELEMENTS: { id: ConsentElementId; label: string; test: RegExp; suggestion: string; severity: 'high' | 'medium' }[] = [
  { id: 'purpose', label: 'Purpose', severity: 'high', test: /\b(purpose|aim of|goal of|why we|we are (studying|testing|researching|evaluating|trying)|we want to (learn|understand|find out)|this (study|research) (is|aims|looks|explores|will)|to find out|to learn (how|whether|about))/i, suggestion: 'We are testing a website to find out how easy it is to use.' },
  { id: 'procedures', label: 'What will happen', severity: 'high', test: /\b(you will (be asked|try|use|complete|do|see|answer|talk)|you('ll| will) be|what (will )?happens?|procedures?|during (the|this) session|you('ll| will) (try|do|complete|answer))/i, suggestion: 'You will try a few short tasks on a website and say out loud what you are thinking. Then we will ask you a few questions.' },
  { id: 'recording', label: 'What is recorded', severity: 'high', test: /\b(record(ed|ing|s)?|we (collect|capture|save|keep)|what we collect)\b/i, suggestion: 'We record your voice, what you do on the website (clicks, scrolling and pages visited) and your answers.' },
  { id: 'duration', label: 'Duration', severity: 'medium', test: /\b(\d+\s*(?:[-–]|to)?\s*\d*\s*(min|mins|minutes?|hours?|hrs?)\b|how long|duration)/i, suggestion: 'The session takes about 15 minutes.' },
  { id: 'risks', label: 'Risks', severity: 'high', test: /\b(risks?|discomfort|harms?|distress)\b/i, suggestion: 'There are no known risks beyond everyday computer use. Some tasks may feel hard; you can skip any task.' },
  { id: 'benefits', label: 'Benefits', severity: 'medium', test: /\b(benefits?|benefit you|you will not benefit|help (us )?(to )?(make|improve))/i, suggestion: 'You will not benefit directly, but you will help us improve the website.' },
  { id: 'compensation', label: 'Compensation', severity: 'medium', test: /\b(compensat\w*|paid|payment|pay you|reward|gift card|voucher|incentive|reimburs\w*|unpaid|no (payment|compensation))\b|[£$€]\s?\d/i, suggestion: 'You will receive [amount] for taking part. You will be paid even if you stop early.' },
  { id: 'confidentiality', label: 'Confidentiality', severity: 'high', test: /\b(confidential\w*|anonymous(ly)?|anonymi[sz]\w*|pseudonymi[sz]\w*|de-?identif\w*|privacy|private|will not (use|share|publish) your name|not (be )?identif\w*)/i, suggestion: 'We keep your data private. When we report results, we will not use your name or anything that identifies you.' },
  { id: 'storage', label: 'Storage and retention', severity: 'high', test: /\b(stor(e|ed|age|ing)|kept|keep (it|your|the)|retain\w*|retention|securely|encrypted|delete(d)? (it |your data |the data )?(after|when|within))\b/i, suggestion: 'We store your data securely and delete it 12 months after the study ends.' },
  { id: 'access', label: 'Who has access', severity: 'medium', test: /\b(who (can|will) (see|access|have access)|access to (your|the) data|only (the )?(research(ers)?|research team|study team|team)|shared? (it |your data |the data )?with|third[- ]part\w*|processor|service provider|AI provider|OpenAI|can see (it|your data))/i, suggestion: 'Only the research team can see your data. Your voice is processed by our AI provider (OpenAI) to run the conversation.' },
  { id: 'voluntary', label: 'Voluntary participation', severity: 'high', test: /\b(voluntary|voluntarily|you (do not|don['’]t) have to|your choice|free to (decide|choose|decline|stop))\b/i, suggestion: 'Taking part is voluntary. You do not have to take part.' },
  { id: 'withdrawal', label: 'Right to withdraw', severity: 'high', test: /\b(withdraw\w*|stop at any time|stop (the session )?(at )?any time|leave (the study |at )?any time|opt out)\b/i, suggestion: 'You can stop at any time without giving a reason, using the Stop & withdraw button. If you withdraw, everything recorded in your session is deleted.' },
  { id: 'ai_disclosure', label: 'AI disclosure', severity: 'high', test: /\bAI\b|\bA\.I\.|artificial intelligence|automated (moderator|voice|assistant|system)|virtual (moderator|assistant)|computer voice|language model|chatbot/i, suggestion: 'An AI moderator (a computer voice, not a person) will guide you through the session.' },
  { id: 'contact', label: 'Researcher contact', severity: 'high', test: /[^\s@]+@[^\s@]+\.[a-z]{2,}|\+?\d[\d ()-]{7,}\d|https?:\/\//i, suggestion: 'If you have questions, contact the researcher at [name@example.org].' },
  { id: 'ethics_contact', label: 'Ethics board / IRB', severity: 'medium', test: /\b(ethics|ethical review|IRB|institutional review board|review board|research ethics committee|REC)\b/i, suggestion: 'If you have concerns about how this study is run, contact [ethics board name] at [ethics@example.org].' },
  { id: 'age', label: 'Age requirement', severity: 'medium', test: /\b(\d{2}\s*(years?( of age| old)?)?\s*(or older|or over|and over|\+)|aged \d{2}|(over|under) (the age of )?\d{2}|at least \d{2}|adults? only|of legal age)/i, suggestion: 'You must be 18 or older to take part.' },
];

const JARGON: [RegExp, string][] = [
  [/\bhereinafter\b/i, 'from now on'],
  [/\baforementioned\b/i, 'this / these'],
  [/\bpursuant to\b/i, 'under / following'],
  [/\bnotwithstanding\b/i, 'despite / even if'],
  [/\bheretofore\b/i, 'until now'],
  [/\bwhereas\b/i, 'while'],
  [/\bin accordance with\b/i, 'following'],
  [/\bremuneration\b/i, 'payment'],
  [/\bindemnif\w*\b/i, '(remove: participants cannot be asked to indemnify you)'],
  [/\bdata subjects?\b/i, 'you / participants'],
  [/\bpseudonymi[sz]\w*\b/i, 'we replace your name with a code'],
  [/\banonymi[sz]ation\b/i, 'removing your name and details that identify you'],
  [/\b(?:data )?controller\b/i, 'the organization responsible for your data'],
  [/\blawful basis\b/i, 'the legal reason we can use your data'],
  [/\bprocessing of (personal )?data\b/i, 'using your data'],
  [/\bstimuli\b/i, 'things we show you'],
  [/\bparadigm\b/i, 'method'],
  [/\bprotocol\b/i, 'study plan'],
  [/\brandomi[sz]ed\b/i, 'assigned by chance'],
  [/\bcohort\b/i, 'group'],
  [/\bheuristic\w*\b/i, 'rule of thumb'],
  [/\bmetadata\b/i, 'technical details (like your browser and screen size)'],
  [/\bcommence\b/i, 'start'],
  [/\bterminate\b/i, 'end / stop'],
  [/\butili[sz]e\b/i, 'use'],
  [/\bprior to\b/i, 'before'],
  [/\bsubsequent(ly)?\b/i, 'later / after'],
  [/\bfacilitate\b/i, 'help / make easier'],
];

const COERCIVE: { re: RegExp; severity: 'high' | 'medium'; message: string; explanation: string; suggestion: string }[] = [
  { re: /\b(waive|give up|release\w*)\b[^.]{0,80}\b(rights?|claims?|liabilit\w*)/i, severity: 'high', message: 'Asks participants to waive rights or release liability.', explanation: 'Consent forms may not include language that makes participants give up legal rights or releases the researchers from liability for negligence.', suggestion: 'Remove this sentence. Agreeing to take part does not change your legal rights.' },
  { re: /\b(you (must|have to|are required to) (complete|finish|stay)|cannot (withdraw|stop|leave)|may not (withdraw|stop|leave)|not (be )?(allowed|able) to (withdraw|stop))/i, severity: 'high', message: 'Suggests participants cannot stop.', explanation: 'Participants must be free to stop at any time without penalty.', suggestion: 'You can stop at any time, without giving a reason.' },
  { re: /\b(only (be )?paid|paid only|will not (be )?(paid|compensated)|lose (your )?(payment|compensation|reward)|forfeit\w*|penalt(y|ies)|penali[sz]ed)\b[^.]{0,60}\b(if|unless|when)?/i, severity: 'high', message: 'Makes payment depend on finishing, or threatens a penalty.', explanation: 'Withholding payment when someone stops early pressures them to continue, which undermines voluntary participation.', suggestion: 'You will be paid even if you stop early.' },
  { re: /\b(no risks?( at all)?|there (are|is) no risks?|completely (safe|risk[- ]free)|risk[- ]free|zero risk)\b/i, severity: 'medium', message: 'Claims there are no risks at all.', explanation: 'No study is entirely without risk (for example, data breaches or mild frustration). Absolute claims can mislead.', suggestion: 'There are no known risks beyond everyday computer use.' },
  { re: /\b(100\s?% (secure|safe|anonymous|private)|guarantee\w*|absolutely (secure|safe|anonymous|private)|cannot be (hacked|accessed|identified))\b/i, severity: 'medium', message: 'Makes an absolute promise about security or privacy.', explanation: 'Absolute guarantees cannot be kept and may mislead participants about the real risks.', suggestion: 'We store your data securely and take steps to protect it.' },
  { re: /\b(we (really )?need you|please don['’]t (stop|quit|leave)|it is (very )?important that you (finish|complete)|your participation is (essential|critical|required))/i, severity: 'medium', message: 'Pressures participants to take part or keep going.', explanation: 'Emotional pressure can make participation feel less voluntary.', suggestion: 'Taking part is your choice, and you can stop at any time.' },
  { re: /\b(by (continuing|scrolling|staying|using this site)|continuing (means|implies)|implied consent)\b/i, severity: 'medium', message: 'Treats continuing as consent.', explanation: 'Consent should be an explicit choice. Here participants agree with a separate button or signature.', suggestion: 'If you agree to take part, choose "I agree" below.' },
];

const has = (re: RegExp, t: string) => re.test(t);
/** First sentence (verbatim) matching re, for quoting. */
function quoteOf(sentences: string[], re: RegExp): string | undefined {
  return sentences.find((x) => re.test(x));
}

const MENTIONS = {
  voice: /\b(voice|audio|microphone|speak|spoken|speech|talk|say out loud|think(ing)? aloud|out loud)\b/i,
  recorded: /\brecord(ed|ing|s)?\b/i,
  transcript: /\btranscri\w*/i,
  screen: /\b(screen|clicks?|scroll\w*|interactions?|pages? (you )?visit\w*|activity|session replay|mouse|what you do on)\b/i,
  eye: /\b(webcam|web cam|camera|eye[- ]?track\w*|gaze|where you look)\b/i,
  provider: /\b(openai|ai provider|third[- ]part\w*|service providers?|processor|external (service|provider|company))\b/i,
  anonymous: /\b(anonymous(ly)?|anonymi[sz]ed)\b/i,
  delete: /\b(delet\w*|remov\w*|destroy\w*|eras\w*|discard\w*)\b/i,
  period: /\b(\d+\s*(days?|weeks?|months?|years?)|until the (end|study)|end of the (study|project)|retention period|no longer needed)\b/i,
  custom: /\b(questions? about (you|yourself)|demographic\w*|information about (you|yourself)|your background|about yourself)\b/i,
};

const FIELD_MENTIONS: Record<BuiltinFieldId, { re: RegExp; what: string }> = {
  full_name: { re: /\b(ask|collect|record|keep|store|need|provide|give|enter|type|sign)\w*\b[^.]{0,80}\byour (full )?names?\b|\byour (full )?name\b[^.]{0,40}\b(is|are|will be) (collected|recorded|stored|kept)/i, what: 'your name' },
  age: { re: /\b(your age|age|date of birth|birth ?date|how old)\b/i, what: 'your age' },
  sex: { re: /\bsex\b/i, what: 'your sex' },
  gender: { re: /\bgender\b/i, what: 'your gender' },
  email: { re: /\b(ask|collect|record|keep|store|need|provide|give|enter)\w*\b[^.]{0,80}\b(e-?mail address(es)?|your e-?mail)\b/i, what: 'your email address' },
  country: { re: /\b(country|where you live|location|residence)\b/i, what: 'your country' },
  occupation: { re: /\b(occupation|job|profession|work)\b/i, what: 'your occupation' },
};

/**
 * Deterministic informed-consent lint: required elements, consistency with what the study actually
 * collects, readability and coercive or misleading wording. Always runs (offline).
 */
export function lintConsent(text: string, capture: ConsentCapture): { issues: ConsentIssue[]; elements: ConsentElementStatus[]; readability: ConsentReadability } {
  const issues: ConsentIssue[] = [];
  const { prose } = consentPlainText(text);
  const all = prose.join('\n');
  const sentences = splitSentences(prose);
  const status = new Map<ConsentElementId, ConsentElementStatus['status']>();

  if (!all.trim()) {
    issues.push({ key: 'empty', source: 'lint', category: 'missing', severity: 'high', message: 'The consent document is empty.', suggestion: 'Upload your consent document or start from the template.' });
  }

  // Required elements.
  for (const el of CONSENT_ELEMENTS) {
    let ok = has(el.test, all);
    if (el.id === 'recording') ok = ok || (has(MENTIONS.voice, all) && has(MENTIONS.screen, all));
    if (el.id === 'contact') ok = ok && /\b(contact|questions?|reach|email|e-mail|call|write to)\b/i.test(all);
    status.set(el.id, ok ? 'ok' : 'missing');
    if (!ok && all.trim())
      issues.push({
        key: `missing:${el.id}`,
        source: 'lint',
        category: 'missing',
        element: el.id,
        severity: el.severity,
        message: `Missing: ${el.label}.`,
        explanation: ELEMENT_WHY[el.id],
        suggestion: el.suggestion,
      });
  }

  const flag = (id: ConsentElementId) => status.get(id) === 'ok' && status.set(id, 'inconsistent');
  const add = (i: Omit<ConsentIssue, 'source'>) => issues.push({ source: 'lint', ...i });

  // Storage needs a retention period; withdrawal should say data is deleted.
  if (status.get('storage') === 'ok' && !has(MENTIONS.period, all)) {
    flag('storage');
    add({ key: 'storage:period', category: 'missing', element: 'storage', severity: 'medium', message: "Doesn't say how long data is kept.", explanation: 'Participants should know when their data will be deleted.', suggestion: 'We will delete your data 12 months after the study ends.' });
  }
  if (status.get('withdrawal') === 'ok') {
    const w = sentences.filter((x) => /withdraw|stop at any time|any time/i.test(x));
    const near = w.some((x) => has(MENTIONS.delete, x)) || prose.some((p) => /withdraw/i.test(p) && has(MENTIONS.delete, p));
    if (!near) {
      flag('withdrawal');
      add({ key: 'withdrawal:deletion', category: 'consistency', element: 'withdrawal', severity: 'medium', message: "Doesn't say that withdrawing deletes the data.", explanation: 'In ThinkAloud, "Stop & withdraw" deletes everything recorded in the session. Say so, so participants know what withdrawing means.', quote: w[0], suggestion: 'If you withdraw, everything recorded in your session is deleted.' });
    }
  }
  if (status.get('age') === 'ok' && capture.minAge > 0 && (capture.ageGate || capture.fields.some((f) => f.id === 'age'))) {
    const nums = [...all.matchAll(/\b(\d{2})\s*(?:years?(?: of age| old)?)?\s*(?:or older|or over|and over|\+)|\baged (\d{2})|\bat least (\d{2})|(?:over|under) (?:the age of )?(\d{2})/gi)].map((m) => Number(m[1] ?? m[2] ?? m[3] ?? m[4]));
    if (nums.length && !nums.includes(capture.minAge)) {
      flag('age');
      add({ key: 'age:mismatch', category: 'consistency', element: 'age', severity: 'high', message: `The age stated (${nums[0]}) differs from the study's minimum age (${capture.minAge}).`, quote: quoteOf(sentences, /\b\d{2}\b.*(older|over|\+)|aged \d{2}|at least \d{2}/i), suggestion: `You must be ${capture.minAge} or older to take part.` });
    }
  }

  // Consistency with what the study captures.
  if (capture.voice && !has(MENTIONS.voice, all)) {
    flag('recording');
    add({ key: 'capture:voice', category: 'consistency', element: 'recording', severity: 'high', message: "Doesn't mention that participants talk with a voice moderator.", explanation: 'The study uses the microphone for voice moderation, so participants must know their voice is captured.', suggestion: 'You will talk with the moderator using your microphone. We record your voice and a written transcript of what you say.' });
  } else if (capture.storeAudio && !has(MENTIONS.recorded, all)) {
    flag('recording');
    add({ key: 'capture:audio_stored', category: 'consistency', element: 'recording', severity: 'medium', message: 'Mentions voice, but not that it is recorded and stored.', explanation: 'Voice recordings are stored for this study.', suggestion: 'We record your voice and keep the recording with the rest of your session.' });
  }
  if (capture.voice && !has(MENTIONS.transcript, all))
    add({ key: 'capture:transcript', category: 'consistency', element: 'recording', severity: 'low', message: "Doesn't mention the written transcript.", suggestion: 'We also keep a written transcript of what you say.' });
  if (capture.voice && !has(MENTIONS.provider, all))
    add({ key: 'capture:provider', category: 'consistency', element: 'access', severity: 'medium', message: "Doesn't say that voice is processed by an external AI provider.", explanation: 'The AI moderator runs on a third-party service (OpenAI by default, or your self-hosted server). Participants should know who processes their voice.', suggestion: 'Your voice is processed by our AI provider (OpenAI) to run the conversation.' });
  if (capture.screen && !has(MENTIONS.screen, all)) {
    flag('recording');
    add({ key: 'capture:screen', category: 'consistency', element: 'recording', severity: 'high', message: "Screen recording is on, but the form doesn't mention it.", explanation: 'The study records a replay of what participants do on the website.', suggestion: 'We record what you do on the website: clicks, scrolling and the pages you visit. Text you type is hidden.' });
  }
  if (capture.eyeTracking && !has(MENTIONS.eye, all)) {
    flag('recording');
    add({ key: 'capture:eye_tracking', category: 'consistency', element: 'recording', severity: 'high', message: "Eye tracking is offered, but the form doesn't mention the webcam.", explanation: 'Participants can opt into webcam eye tracking. The form must explain it before they choose.', suggestion: 'If you choose to turn it on, we estimate where you look on the screen using your webcam. This is worked out on your device and no video is saved.' });
  }
  if (!capture.eyeTracking && has(MENTIONS.eye, all))
    add({ key: 'capture:eye_tracking_unused', category: 'consistency', element: 'recording', severity: 'low', message: 'Mentions the webcam or eye tracking, but the study does not offer it.', quote: quoteOf(sentences, MENTIONS.eye), suggestion: 'Remove the sentence about the webcam, or turn on eye tracking in the protocol.' });
  if (!capture.screen && /\b(session replay|screen recording|record (your|the) screen)\b/i.test(all))
    add({ key: 'capture:screen_unused', category: 'consistency', element: 'recording', severity: 'low', message: 'Mentions screen recording, but the study does not record a replay.', quote: quoteOf(sentences, /session replay|screen recording|record (your|the) screen/i), suggestion: 'Remove the sentence, or turn on session replay in the protocol.' });

  const fieldIds = new Set(capture.fields.map((f) => f.id));
  for (const id of BUILTIN_ORDER) {
    if (!fieldIds.has(id)) continue;
    const m = FIELD_MENTIONS[id];
    if (!has(m.re, all)) {
      flag('recording');
      const label = capture.fields.find((f) => f.id === id)?.label ?? id;
      add({ key: `field:${id}`, category: 'consistency', element: 'recording', severity: id === 'full_name' || id === 'email' ? 'high' : 'medium', message: `The study asks for ${label.toLowerCase()}, but the form doesn't say so.`, explanation: 'Every piece of personal information you collect should be listed, with why you need it.', suggestion: `We will ask for ${m.what}.` });
    }
  }
  const custom = capture.fields.filter((f) => f.id.startsWith('cf_'));
  if (custom.length && !has(MENTIONS.custom, all))
    add({ key: 'field:custom', category: 'consistency', element: 'recording', severity: 'low', message: `The study asks ${custom.length} more question${custom.length > 1 ? 's' : ''} about the participant (${custom.slice(0, 3).map((f) => f.label).join(', ')}${custom.length > 3 ? ', …' : ''}).`, suggestion: 'We will also ask a few questions about you and your background.' });

  const identifying = capture.fields.filter((f) => f.pii);
  const anon = quoteOf(sentences, MENTIONS.anonymous);
  if (anon && (identifying.length || capture.storeAudio)) {
    flag('confidentiality');
    add({
      key: 'consistency:anonymous',
      category: 'consistency',
      element: 'confidentiality',
      severity: identifying.length ? 'high' : 'medium',
      message: `Says data is anonymous, but the study collects ${identifying.length ? identifying.map((f) => f.label.toLowerCase()).join(', ') : 'voice recordings'}.`,
      explanation: identifying.length ? 'Names and email addresses identify people, so the data is not anonymous.' : 'Voice recordings can identify people, so the data is not anonymous. Use "confidential" instead.',
      quote: anon,
      suggestion: 'We keep your data confidential. When we report results, we will not use your name or anything that identifies you.',
    });
  }

  // Coercive or misleading language.
  for (const c of COERCIVE) {
    const q = quoteOf(sentences, c.re);
    if (q) add({ key: `language:${c.message.slice(0, 24)}`, category: 'language', severity: c.severity, message: c.message, explanation: c.explanation, quote: q, suggestion: c.suggestion });
  }

  // Readability.
  const r = readability(text);
  if (r.words >= 40 && r.grade > 8)
    add({ key: 'readability:grade', category: 'readability', severity: r.grade > 12 ? 'high' : 'medium', message: `Reading level is grade ${r.grade.toFixed(1)}. Aim for grade 8 or lower.`, explanation: 'Most adults read comfortably at grade 8. Use short sentences and everyday words.', suggestion: 'Split long sentences, and replace long words with short ones ("use" instead of "utilize").' });
  let long = 0;
  sentences.forEach((sn, i) => {
    const wc = wordsOf(sn).length;
    if (wc > 25 && long < 6) {
      long++;
      add({ key: `readability:long:${i}`, category: 'readability', severity: wc > 40 ? 'medium' : 'low', message: `Long sentence (${wc} words).`, explanation: 'Sentences over 25 words are hard to follow. Aim for 15–20.', quote: sn, suggestion: 'Split this into two or three shorter sentences.' });
    }
  });
  const jargonSeen = new Set<string>();
  for (const [re, plain] of JARGON) {
    const q = quoteOf(sentences, re);
    if (!q) continue;
    const word = q.match(re)?.[0] ?? '';
    if (jargonSeen.has(word.toLowerCase())) continue;
    jargonSeen.add(word.toLowerCase());
    add({ key: `jargon:${word.toLowerCase()}`, category: 'readability', severity: 'low', message: `Jargon: "${word}".`, quote: q, suggestion: `Say "${plain}" instead.` });
  }

  const rank = { high: 0, medium: 1, low: 2 } as const;
  issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return { issues, readability: r, elements: CONSENT_ELEMENTS.map((e) => ({ id: e.id, label: e.label, status: status.get(e.id) ?? 'missing' })) };
}

const ELEMENT_WHY: Record<ConsentElementId, string> = {
  purpose: 'Participants need to know why the study is being done.',
  procedures: 'Describe what participants will do, step by step, in plain words.',
  recording: 'List everything that is recorded or collected.',
  duration: 'Say how long the session takes so people can decide if they have time.',
  risks: 'Even minimal-risk studies should state the risks (or that none are known beyond everyday life).',
  benefits: 'Say whether participants benefit directly; most usability studies offer no direct benefit.',
  compensation: 'State the payment, or that there is none, and that people are paid even if they stop early.',
  confidentiality: 'Explain how identities are protected in reports and publications.',
  storage: 'Say where data is stored, how it is protected and how long it is kept.',
  access: 'Say who can see the data, including service providers that process it.',
  voluntary: 'Participation must be a free choice.',
  withdrawal: 'Participants must know they can stop at any time without penalty.',
  ai_disclosure: 'Participants must be told the moderator is an AI, not a person (transparency, EU AI Act Art. 50).',
  contact: 'Give a way to reach the researcher with questions.',
  ethics_contact: 'Give the ethics board or IRB contact for concerns about the study.',
  age: 'State who can take part, including the minimum age.',
};
