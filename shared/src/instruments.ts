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

// ── Session-language wording ─────────────────────────────────────────────────
//
// Standard instruments are presented in the session language. Where a published / widely used
// translation exists it is stored here verbatim; otherwise the English original is used and the
// moderator translates it while reading (Question.translateTo). Question ids, scales and scoring
// never change, and every answer records which wording was presented (Question.wording).

interface Wording {
  /** Recorded with each answer, e.g. "SUS/de: Rummel (2016) German SUS". */
  label: string;
  intro?: string;
  /** Item texts in order (`{p}` = product, `{pd}` = product in the dative where the grammar needs it). */
  items: string[];
  /** Scale end labels per item (falls back to `labels`). */
  itemLabels?: [string, string][];
  labels?: [string, string];
}

const EN_WORDING: Record<InstrumentId, string> = {
  SUS: 'SUS/en: Brooke (1996)',
  SEQ: 'SEQ/en: Sauro & Dumas (2009)',
  UMUX_LITE: 'UMUX-Lite/en: Lewis, Utesch & Maher (2013)',
  NASA_TLX: 'NASA-TLX/en: Hart & Staveland (1988), raw',
  NPS: 'NPS/en: Reichheld (2003)',
};

/** German: SUS after the widely used German translation by Rummel (SAP, 2016); the others are ThinkAloud translations. */
const DE_WORDING: Record<InstrumentId, Wording> = {
  SUS: {
    label: 'SUS/de: Rummel (2016) German SUS',
    intro: 'Ich lese Ihnen jetzt zehn kurze Aussagen vor. Sagen Sie mir bitte jeweils, wie sehr Sie zustimmen, von 1, stimme überhaupt nicht zu, bis 5, stimme voll und ganz zu.',
    items: [
      'Ich denke, dass ich {p} gerne häufig benutzen würde.',
      'Ich fand {p} unnötig komplex.',
      'Ich fand {p} einfach zu benutzen.',
      'Ich glaube, ich würde die Hilfe einer technisch versierten Person benötigen, um {p} benutzen zu können.',
      'Ich fand, die verschiedenen Funktionen in {pd} waren gut integriert.',
      'Ich denke, {p} enthielt zu viele Inkonsistenzen.',
      'Ich kann mir vorstellen, dass die meisten Menschen den Umgang mit {pd} sehr schnell lernen.',
      'Ich fand {p} sehr umständlich zu nutzen.',
      'Ich fühlte mich bei der Benutzung von {pd} sehr sicher.',
      'Ich musste eine Menge lernen, bevor ich anfangen konnte, {p} zu verwenden.',
    ],
    labels: ['Stimme überhaupt nicht zu', 'Stimme voll und ganz zu'],
  },
  SEQ: {
    label: 'SEQ/de: ThinkAloud German translation (not separately validated)',
    items: ['Wie schwierig oder einfach war es insgesamt, die Aufgabe zu erledigen?'],
    labels: ['Sehr schwierig', 'Sehr einfach'],
  },
  UMUX_LITE: {
    label: 'UMUX-Lite/de: ThinkAloud German translation (not separately validated)',
    intro: 'Zwei kurze Aussagen. Sagen Sie mir bitte, wie sehr Sie zustimmen, von 1, stimme überhaupt nicht zu, bis 7, stimme voll und ganz zu.',
    items: ['Die Funktionen von {pd} erfüllen meine Anforderungen.', '{P} ist einfach zu benutzen.'],
    labels: ['Stimme überhaupt nicht zu', 'Stimme voll und ganz zu'],
  },
  NASA_TLX: {
    label: 'NASA-TLX/de: ThinkAloud German translation (not separately validated), raw',
    intro: 'Jetzt sechs Fragen zur Beanspruchung. Bewerten Sie jede von 0 bis 100.',
    items: [
      'Geistige Anforderung: Wie geistig anspruchsvoll war die Aufgabe?',
      'Körperliche Anforderung: Wie körperlich anspruchsvoll war die Aufgabe?',
      'Zeitliche Anforderung: Wie gehetzt oder unter Zeitdruck fühlten Sie sich?',
      'Leistung: Wie erfolgreich haben Sie das erreicht, worum Sie gebeten wurden?',
      'Anstrengung: Wie sehr mussten Sie sich anstrengen, um Ihre Leistung zu erreichen?',
      'Frustration: Wie unsicher, entmutigt, gereizt, gestresst und verärgert waren Sie?',
    ],
    itemLabels: [
      ['Sehr gering', 'Sehr hoch'],
      ['Sehr gering', 'Sehr hoch'],
      ['Sehr gering', 'Sehr hoch'],
      ['Perfekt', 'Misserfolg'],
      ['Sehr gering', 'Sehr hoch'],
      ['Sehr gering', 'Sehr hoch'],
    ],
  },
  NPS: {
    label: 'NPS/de: ThinkAloud German translation',
    items: ['Wie wahrscheinlich ist es, dass Sie {p} einem Freund oder Kollegen weiterempfehlen?'],
    labels: ['Überhaupt nicht wahrscheinlich', 'Äußerst wahrscheinlich'],
  },
};

const STORED: Record<string, Record<InstrumentId, Wording>> = { de: DE_WORDING };

const baseLang = (lang?: string) => (lang || 'en').toLowerCase().split(/[-_]/)[0];

/** Display name of a language code (for "translate into …"). */
const LANG_NAMES: Record<string, string> = {
  fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese', nl: 'Dutch', tr: 'Turkish', pl: 'Polish', sv: 'Swedish', da: 'Danish',
  no: 'Norwegian', fi: 'Finnish', cs: 'Czech', ru: 'Russian', uk: 'Ukrainian', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', ar: 'Arabic',
  hi: 'Hindi', he: 'Hebrew', el: 'Greek', ro: 'Romanian', hu: 'Hungarian',
};

/** Whether this instrument has a stored wording in the language (English always). */
export function hasInstrumentWording(id: InstrumentId, lang?: string): boolean {
  const l = baseLang(lang);
  return l === 'en' || Boolean(STORED[l]?.[id]);
}

/** The instrument's spoken lead-in in the session language ('' if none; English when no stored translation). */
export function instrumentIntro(id: InstrumentId, lang?: string): string {
  const l = baseLang(lang);
  if (l === 'en') return INSTRUMENTS[id].intro;
  const w = STORED[l]?.[id];
  return w ? (w.intro ?? '') : INSTRUMENTS[id].intro;
}

/** The instrument's items in the session language (ids, kinds and scales unchanged). */
export function instrumentItems(id: InstrumentId, productName: string | undefined, lang?: string): Question[] {
  const l = baseLang(lang);
  const name = productName?.trim();
  const en = INSTRUMENTS[id].items(name || 'this system');
  if (l === 'en') return en.map((q) => ({ ...q, wording: EN_WORDING[id] }));
  const w = STORED[l]?.[id];
  if (!w) {
    // No stored translation: the moderator translates the English original while reading it.
    const langName = LANG_NAMES[l] ?? lang ?? l;
    return en.map((q) => ({ ...q, wording: `${EN_WORDING[id]} (no stored ${langName} version: translated live by the AI moderator)`, translateTo: langName }));
  }
  const p = name || 'das System';
  const pd = name || 'diesem System';
  return en.map((q, i) => {
    const text = (w.items[i] ?? q.prompt).replaceAll('{P}', cap(p)).replaceAll('{pd}', pd).replaceAll('{p}', p);
    const lab = w.itemLabels?.[i] ?? w.labels;
    return {
      ...q,
      prompt: text,
      ...(q.scale && lab ? { scale: { ...q.scale, minLabel: lab[0], maxLabel: lab[1] } } : {}),
      wording: w.label,
    };
  });
}

/** Questions for a questionnaire step (standard instrument or custom), in the session language. */
export function questionnaireItems(step: { instrument: InstrumentId | 'custom'; questions?: Question[]; productName?: string }, lang?: string): Question[] {
  if (step.instrument === 'custom') return step.questions ?? [];
  return instrumentItems(step.instrument, step.productName, lang);
}

/** SEQ question used when TaskStep.askSEQ is true. Id is `seq`, step scoped by stepId in Answer. */
export const SEQ_QUESTION: Question = INSTRUMENTS.SEQ.items('')[0];

/** The SEQ in the session language. */
export function seqQuestion(lang?: string): Question {
  return instrumentItems('SEQ', '', lang)[0];
}
