// Standardized questionnaires with exact published wording and scoring.
// Sources: Brooke (1996) SUS; Sauro & Dumas (2009) SEQ; Lewis, Utesch & Maher (2013) UMUX-Lite;
// Hart & Staveland (1988) NASA-TLX (raw); Reichheld (2003) NPS.
import type { InstrumentId, Question } from './types.ts';

const agree5 = { min: 1, max: 5, minLabel: 'Strongly disagree', maxLabel: 'Strongly agree' };
const agree7 = { min: 1, max: 7, minLabel: 'Strongly disagree', maxLabel: 'Strongly agree' };

export interface InstrumentDef {
  id: InstrumentId;
  name: string;
  description: string;
  /** Spoken lead-in before the items. */
  intro: string;
  items: (productName: string) => Question[];
  /** Returns the instrument score (null if incomplete). Keys are question ids. */
  score: (answers: Record<string, number>) => number | null;
  scoreLabel: string;
  scoreRange: [number, number];
  /** Published benchmark mean (for "above/below average" context). */
  benchmark?: number;
}

const SUS_ITEMS = [
  'I think that I would like to use {p} frequently.',
  'I found {p} unnecessarily complex.',
  'I thought {p} was easy to use.',
  'I think that I would need the support of a technical person to be able to use {p}.',
  'I found the various functions in {p} were well integrated.',
  'I thought there was too much inconsistency in {p}.',
  'I would imagine that most people would learn to use {p} very quickly.',
  'I found {p} very cumbersome to use.',
  'I felt very confident using {p}.',
  'I needed to learn a lot of things before I could get going with {p}.',
];

const TLX = [
  ['tlx_mental', 'Mental demand: How mentally demanding was the task?', 'Very low', 'Very high'],
  ['tlx_physical', 'Physical demand: How physically demanding was the task?', 'Very low', 'Very high'],
  ['tlx_temporal', 'Temporal demand: How hurried or rushed was the pace of the task?', 'Very low', 'Very high'],
  ['tlx_performance', 'Performance: How successful were you in accomplishing what you were asked to do?', 'Perfect', 'Failure'],
  ['tlx_effort', 'Effort: How hard did you have to work to accomplish your level of performance?', 'Very low', 'Very high'],
  ['tlx_frustration', 'Frustration: How insecure, discouraged, irritated, stressed, and annoyed were you?', 'Very low', 'Very high'],
] as const;

export const INSTRUMENTS: Record<InstrumentId, InstrumentDef> = {
  SUS: {
    id: 'SUS',
    name: 'System Usability Scale (SUS)',
    description: '10-item standardized usability questionnaire. Score 0–100, average ≈ 68.',
    intro: 'I have ten short statements. For each one, tell me how much you agree, from 1, strongly disagree, to 5, strongly agree.',
    items: (p) =>
      SUS_ITEMS.map((t, i) => ({
        id: `sus_${i + 1}`,
        prompt: t.replaceAll('{p}', p),
        kind: 'rating' as const,
        scale: agree5,
        required: true,
      })),
    score: (a) => {
      let sum = 0;
      for (let i = 1; i <= 10; i++) {
        const v = a[`sus_${i}`];
        if (typeof v !== 'number') return null;
        sum += i % 2 === 1 ? v - 1 : 5 - v;
      }
      return sum * 2.5;
    },
    scoreLabel: 'SUS',
    scoreRange: [0, 100],
    benchmark: 68,
  },
  SEQ: {
    id: 'SEQ',
    name: 'Single Ease Question (SEQ)',
    description: 'One 7-point question asked right after a task. Average ≈ 5.5.',
    intro: '',
    items: () => [
      {
        id: 'seq',
        prompt: 'Overall, how difficult or easy was the task to complete?',
        kind: 'rating',
        scale: { min: 1, max: 7, minLabel: 'Very difficult', maxLabel: 'Very easy' },
        required: true,
        allowFollowUp: true,
        intent: 'Perceived task ease. If the rating is low (1-4), ask one open follow-up about what made it difficult.',
      },
    ],
    score: (a) => (typeof a.seq === 'number' ? a.seq : null),
    scoreLabel: 'SEQ',
    scoreRange: [1, 7],
    benchmark: 5.5,
  },
  UMUX_LITE: {
    id: 'UMUX_LITE',
    name: 'UMUX-Lite',
    description: '2-item usability metric. 0–100; SUS-equivalent = 0.65 × score + 22.9.',
    intro: 'Two quick statements. Tell me how much you agree, from 1, strongly disagree, to 7, strongly agree.',
    items: (p) => [
      { id: 'umux_1', prompt: `${cap(p)}'s capabilities meet my requirements.`, kind: 'rating', scale: agree7, required: true },
      { id: 'umux_2', prompt: `${cap(p)} is easy to use.`, kind: 'rating', scale: agree7, required: true },
    ],
    score: (a) =>
      typeof a.umux_1 === 'number' && typeof a.umux_2 === 'number' ? ((a.umux_1 - 1 + (a.umux_2 - 1)) / 12) * 100 : null,
    scoreLabel: 'UMUX-Lite',
    scoreRange: [0, 100],
  },
  NASA_TLX: {
    id: 'NASA_TLX',
    name: 'NASA-TLX (Raw)',
    description: 'Six workload subscales, 0–100. Raw TLX = unweighted mean.',
    intro: 'Now six questions about workload. Rate each from 0 to 100.',
    items: () =>
      TLX.map(([id, prompt, lo, hi]) => ({
        id,
        prompt,
        kind: 'rating' as const,
        scale: { min: 0, max: 100, step: 5, minLabel: lo, maxLabel: hi },
        required: true,
      })),
    score: (a) => {
      const vals = TLX.map(([id]) => a[id]);
      if (vals.some((v) => typeof v !== 'number')) return null;
      return (vals as number[]).reduce((s, v) => s + v, 0) / vals.length;
    },
    scoreLabel: 'Raw TLX',
    scoreRange: [0, 100],
  },
  NPS: {
    id: 'NPS',
    name: 'Net Promoter Score (NPS)',
    description: 'Likelihood to recommend, 0–10.',
    intro: '',
    items: (p) => [
      {
        id: 'nps',
        prompt: `How likely are you to recommend ${p} to a friend or colleague?`,
        kind: 'rating',
        scale: { min: 0, max: 10, minLabel: 'Not at all likely', maxLabel: 'Extremely likely' },
        required: true,
        allowFollowUp: true,
        intent: 'Ask one open follow-up: what is the main reason for that score?',
      },
    ],
    score: (a) => (typeof a.nps === 'number' ? a.nps : null),
    scoreLabel: 'NPS rating',
    scoreRange: [0, 10],
  },
};

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Questions for a questionnaire step (standard instrument or custom). */
export function questionnaireItems(step: { instrument: InstrumentId | 'custom'; questions?: Question[]; productName?: string }): Question[] {
  if (step.instrument === 'custom') return step.questions ?? [];
  return INSTRUMENTS[step.instrument].items(step.productName?.trim() || 'this system');
}

/** SEQ question used when TaskStep.askSEQ is true. Id is `seq`, step scoped by stepId in Answer. */
export const SEQ_QUESTION: Question = INSTRUMENTS.SEQ.items('')[0];
