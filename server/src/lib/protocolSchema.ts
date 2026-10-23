// Zod schema for the `Protocol` type (shared/src/types.ts) plus normalization.
//
// The schema is deliberately forgiving about *shape noise* (missing optional
// fields, nulls, numbers sent as strings, enum spelling variants) because it
// parses AI output and protocols saved by older clients. It is strict about
// structure: unknown step types or a non-object protocol are rejected.
import { z } from 'zod';
import {
  DEFAULT_CLOSING,
  DEFAULT_CONSENT,
  DEFAULT_INTRO,
  DEFAULT_MODERATION,
  REALTIME_VOICES,
  type Protocol,
  type Question,
  type Step,
} from '@thinkaloud/shared';

// ── primitives ───────────────────────────────────────────────────────────────

/** Recursively drop `null` values from objects so optional fields can be modelled with `.optional()`. */
function stripNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.filter((x) => x !== null).map(stripNulls);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (val !== null) out[k] = stripNulls(val);
    return out;
  }
  return v;
}

const toNum = (v: unknown) => (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v);
const toBool = (v: unknown) => (v === 'true' ? true : v === 'false' ? false : v === 1 ? true : v === 0 ? false : v);

const num = (f: (n: z.ZodNumber) => z.ZodNumber = (n) => n) => z.preprocess(toNum, f(z.number()));
const bool = () => z.preprocess(toBool, z.boolean());
const text = (max = 20_000) => z.string().max(max);
const strList = (maxItems = 100) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.map((x) => (x && typeof x === 'object' ? textOf(x) : x)) : v),
    z.array(text(2000)).max(maxItems),
  );

/** AI output sometimes renders a list of strings as `[{prompt: "..."}]`. */
function textOf(x: object): unknown {
  const o = x as Record<string, unknown>;
  return o.prompt ?? o.text ?? o.question ?? o.value ?? x;
}

const normEnum = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase().replace(/[\s-]+/g, '_') : v);

// ── questions & rules ────────────────────────────────────────────────────────

export const QuestionKindSchema = z.preprocess(
  (v) => {
    const s = normEnum(v);
    const alias: Record<string, string> = {
      text: 'open',
      open_ended: 'open',
      free_text: 'open',
      single: 'single_choice',
      choice: 'single_choice',
      multiple_choice: 'single_choice',
      multi: 'multi_choice',
      checkbox: 'multi_choice',
      checkboxes: 'multi_choice',
      scale: 'rating',
      likert: 'rating',
      boolean: 'yes_no',
      yesno: 'yes_no',
      numeric: 'number',
    };
    return typeof s === 'string' ? (alias[s] ?? s) : s;
  },
  z.enum(['open', 'single_choice', 'multi_choice', 'rating', 'yes_no', 'number']),
);

export const RatingScaleSchema = z.object({
  min: num(),
  max: num(),
  step: num((n) => n.positive()).optional(),
  minLabel: text(200).optional(),
  maxLabel: text(200).optional(),
});

export const QuestionSchema = z.object({
  id: z.string().max(100).default(''),
  prompt: text(4000).default(''),
  kind: QuestionKindSchema.default('open'),
  options: strList(50).optional(),
  scale: RatingScaleSchema.optional(),
  required: bool().default(false),
  allowFollowUp: bool().optional(),
  intent: text(4000).optional(),
});

const validRegex = (p: string) => {
  try {
    new RegExp(p);
    return true;
  } catch {
    return false;
  }
};

export const SuccessRuleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('url_matches'), pattern: z.string().min(1).max(500).refine(validRegex, 'Invalid regular expression') }),
  z.object({ type: z.literal('element_visible'), selector: z.string().min(1).max(500) }),
  z.object({ type: z.literal('text_visible'), text: z.string().min(1).max(500) }),
  z
    .object({ type: z.literal('click_matches'), selector: z.string().max(500).optional(), text: z.string().max(500).optional() })
    .refine((r) => Boolean(r.selector || r.text), 'click_matches needs a selector or text'),
  z.object({ type: z.literal('custom_event'), name: z.string().min(1).max(200) }),
]);

/** Invalid individual rules are dropped instead of failing the whole protocol. */
const SuccessRulesSchema = z
  .array(z.unknown())
  .max(20)
  .transform((arr) => arr.flatMap((r) => {
    const p = SuccessRuleSchema.safeParse(r);
    return p.success ? [p.data] : [];
  }));

// ── steps ────────────────────────────────────────────────────────────────────

const base = {
  id: z.string().max(100).default(''),
  title: text(300).default(''),
};

export const InstructionStepSchema = z.object({
  ...base,
  type: z.literal('instruction'),
  script: text().default(''),
  showApp: bool().optional(),
  exploreSeconds: num((n) => n.min(0).max(3600)).optional(),
  startPath: text(2000).optional(),
});

export const QuestionStepSchema = z.object({
  ...base,
  type: z.literal('question'),
  question: QuestionSchema,
});

export const TaskStepSchema = z.object({
  ...base,
  type: z.literal('task'),
  instruction: text().default(''),
  startPath: text(2000).optional(),
  successCriteria: text().default(''),
  successRules: SuccessRulesSchema.default([]),
  optimalPathLength: num((n) => n.int().min(1).max(1000)).optional(),
  timeLimitSec: num((n) => n.min(0).max(7200)).optional(),
  probes: strList(30).default([]),
  postTaskQuestions: z.array(QuestionSchema).max(30).optional(),
  askSEQ: bool().optional(),
  softLimitSec: num((n) => n.min(0).max(7200)).optional(),
  assistance: z
    .object({
      generalPrompts: strList(10).default([]),
      firstAfterSec: num((n) => n.min(0).max(3600)).optional(),
      gapSec: num((n) => n.min(5).max(3600)).optional(),
      directCue: text(2000).optional(),
    })
    .optional(),
});

const InstrumentSchema = z.preprocess(
  (v) => {
    if (typeof v !== 'string') return v;
    const s = v.trim().toUpperCase().replace(/[\s-]+/g, '_');
    const alias: Record<string, string> = { UMUX: 'UMUX_LITE', UMUXLITE: 'UMUX_LITE', TLX: 'NASA_TLX', NASATLX: 'NASA_TLX', CUSTOM: 'custom' };
    return alias[s] ?? s;
  },
  z.enum(['SUS', 'UMUX_LITE', 'SEQ', 'NASA_TLX', 'NPS', 'custom']),
);

export const QuestionnaireStepSchema = z.object({
  ...base,
  type: z.literal('questionnaire'),
  instrument: InstrumentSchema,
  questions: z.array(QuestionSchema).max(100).optional(),
  productName: text(200).optional(),
  onScreen: bool().optional(),
});

export const InterviewStepSchema = z.object({
  ...base,
  type: z.literal('interview'),
  goal: text().default(''),
  questions: strList(50).default([]),
  maxFollowUps: num((n) => n.int().min(0).max(10)).optional(),
  showApp: bool().optional(),
  startPath: text(2000).optional(),
});

export const StepSchema = z.preprocess(
  (v) => (v && typeof v === 'object' && 'type' in v ? { ...(v as object), type: normEnum((v as { type: unknown }).type) } : v),
  z.discriminatedUnion('type', [InstructionStepSchema, QuestionStepSchema, TaskStepSchema, QuestionnaireStepSchema, InterviewStepSchema]),
);

// ── settings ─────────────────────────────────────────────────────────────────

const M = DEFAULT_MODERATION;
type Voice = (typeof REALTIME_VOICES)[number];
export const ModerationSchema = z.object({
  style: z
    .preprocess(normEnum, z.enum(['think_aloud_concurrent', 'think_aloud_retrospective', 'interview', 'unmoderated']))
    .catch(M.style)
    .default(M.style),
  probingLevel: z.preprocess(normEnum, z.enum(['none', 'light', 'moderate', 'deep'])).catch(M.probingLevel).default(M.probingLevel),
  allowClosedQuestions: bool().catch(M.allowClosedQuestions).default(M.allowClosedQuestions),
  silencePromptSeconds: num((n) => n.min(0).max(600)).catch(M.silencePromptSeconds).default(M.silencePromptSeconds),
  maxProbesPerStep: num((n) => n.int().min(0).max(10)).catch(M.maxProbesPerStep).default(M.maxProbesPerStep),
  probeOnBehavior: bool().catch(M.probeOnBehavior).default(M.probeOnBehavior),
  language: z.string().trim().min(2).max(20).catch(M.language).default(M.language),
  voice: z
    .preprocess(normEnum, z.enum(REALTIME_VOICES))
    .catch(M.voice as Voice)
    .default(M.voice as Voice),
  tone: text(1000).catch(M.tone).default(M.tone),
  customRules: strList(50).catch(() => []).default(() => []),
  allowTextFallback: bool().catch(M.allowTextFallback).default(M.allowTextFallback),
});

const C = DEFAULT_CONSENT;
export const ConsentSchema = z.object({
  text: text(50_000).default(C.text),
  storeAudio: bool().default(C.storeAudio),
  recordScreen: bool().default(C.recordScreen),
  offerEyeTracking: bool().default(C.offerEyeTracking),
  ageGate: bool().default(C.ageGate),
  version: z.preprocess((v) => (typeof v === 'number' ? String(v) : v), z.string().min(1).max(50)).default(C.version),
});

const ProtocolObject = z.object({
  schemaVersion: z.literal(1).catch(1).default(1),
  title: text(300).default('Untitled protocol'),
  researchGoals: strList(50).default([]),
  productContext: text().default(''),
  intro: text().default(DEFAULT_INTRO),
  closing: text().default(DEFAULT_CLOSING),
  moderation: ModerationSchema.default(() => ModerationSchema.parse({})),
  consent: ConsentSchema.default(() => ConsentSchema.parse({})),
  steps: z.array(StepSchema).max(200).default([]),
  randomizeTasks: bool().default(false),
  estimatedMinutes: num((n) => n.min(1).max(600)).catch(15).default(15),
});

/** Validates/coerces anything protocol-shaped. Output is structurally a `Protocol` (ids may still be empty — use normalizeProtocol). */
export const ProtocolSchema = z.preprocess(stripNulls, ProtocolObject);

// Compile-time guarantee that the schema output fits the shared type.
type _Out = z.output<typeof ProtocolObject>;
const _check: (p: _Out) => Protocol = (p) => p;
void _check;

// ── normalization ────────────────────────────────────────────────────────────

function slug(s: string): string {
  return s
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

function uniquifier() {
  const used = new Set<string>();
  return (wanted: string, fallback: string): string => {
    const b = slug(wanted) || slug(fallback) || 'item';
    let id = b;
    for (let i = 2; used.has(id); i++) id = `${b}_${i}`;
    used.add(id);
    return id;
  };
}

const TYPE_TITLES: Record<Step['type'], string> = {
  instruction: 'Instruction',
  question: 'Question',
  task: 'Task',
  questionnaire: 'Questionnaire',
  interview: 'Interview',
};

function normQuestion(q: Question, uniq: (w: string, f: string) => string, fallback: string, reserved: string[] = []): Question {
  let id = q.id;
  if (reserved.includes(slug(id))) id = `${id}_q`;
  const out: Question = { ...q, id: uniq(id, fallback) };
  if (out.kind === 'rating' && !out.scale) out.scale = { min: 1, max: 7 };
  if (out.scale && out.scale.max < out.scale.min) out.scale = { ...out.scale, min: out.scale.max, max: out.scale.min };
  if ((out.kind === 'single_choice' || out.kind === 'multi_choice') && out.options) {
    out.options = [...new Set(out.options.map((o) => o.trim()).filter(Boolean))];
  }
  return out;
}

/**
 * Parse + normalize any protocol-shaped input into a valid `Protocol`:
 * fills defaults (DEFAULT_MODERATION / DEFAULT_CONSENT / intro / closing),
 * guarantees unique, slug-safe step ids and question ids, default titles and
 * rating scales. Throws a ZodError (→ 400) when the structure is unusable.
 */
export function normalizeProtocol(input: unknown): Protocol {
  const p = ProtocolSchema.parse(input) as Protocol;
  const stepIds = uniquifier();
  const questionIds = uniquifier();
  const counters: Record<string, number> = {};

  const steps: Step[] = p.steps.map((s) => {
    counters[s.type] = (counters[s.type] ?? 0) + 1;
    const n = counters[s.type];
    const title = s.title.trim() || `${TYPE_TITLES[s.type]} ${n}`;
    const id = stepIds(s.id || s.title.toLowerCase(), `${s.type}_${n}`);
    switch (s.type) {
      case 'question':
        return { ...s, id, title, question: normQuestion(s.question, questionIds, `${id}_q`) };
      case 'task':
        return {
          ...s,
          id,
          title,
          probes: (s.probes ?? []).map((x) => x.trim()).filter(Boolean),
          postTaskQuestions: s.postTaskQuestions?.map((q, i) =>
            // `seq` is reserved for the automatic SEQ answer of this task.
            normQuestion(q, questionIds, `${id}_q${i + 1}`, s.askSEQ ? ['seq'] : []),
          ),
        };
      case 'questionnaire':
        return {
          ...s,
          id,
          title,
          questions: s.instrument === 'custom' ? (s.questions ?? []).map((q, i) => normQuestion(q, questionIds, `${id}_q${i + 1}`)) : s.questions,
        };
      case 'interview':
        return { ...s, id, title, questions: s.questions.map((x) => x.trim()).filter(Boolean) };
      default:
        return { ...s, id, title };
    }
  });

  // JSON round-trip drops undefined keys so the result is exactly what gets stored.
  return JSON.parse(JSON.stringify({
    ...p,
    researchGoals: p.researchGoals.map((g) => g.trim()).filter(Boolean),
    moderation: { ...p.moderation, customRules: p.moderation.customRules.map((r) => r.trim()).filter(Boolean) },
    estimatedMinutes: Math.round(p.estimatedMinutes),
    steps,
  })) as Protocol;
}
