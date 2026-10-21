import { ClipboardList, MessageCircleQuestion, MessageSquareText, MessagesSquare, Target } from 'lucide-react';
import type { ReactNode } from 'react';
import { INSTRUMENTS, newId, type InstrumentId, type Question, type QuestionKind, type Step, type StepType } from '@thinkaloud/shared';

export const STEP_META: Record<StepType, { label: string; icon: (cls?: string) => ReactNode; color: string; ring: string; description: string }> = {
  instruction: {
    label: 'Instruction',
    icon: (c = 'size-4') => <MessageSquareText className={c} />,
    color: 'text-secondary',
    ring: '',
    description: 'The moderator says something, optionally shows the app for free exploration.',
  },
  question: {
    label: 'Question',
    icon: (c = 'size-4') => <MessageCircleQuestion className={c} />,
    color: 'text-secondary',
    ring: '',
    description: 'A single open, choice, rating, yes/no or number question.',
  },
  task: {
    label: 'Task',
    icon: (c = 'size-4') => <Target className={c} />,
    color: 'text-secondary',
    ring: '',
    description: 'A scenario the participant completes in the app while thinking aloud.',
  },
  questionnaire: {
    label: 'Questionnaire',
    icon: (c = 'size-4') => <ClipboardList className={c} />,
    color: 'text-secondary',
    ring: '',
    description: 'Standardized instruments (SUS, SEQ, UMUX-Lite, NASA-TLX, NPS) or your own items.',
  },
  interview: {
    label: 'Interview',
    icon: (c = 'size-4') => <MessagesSquare className={c} />,
    color: 'text-secondary',
    ring: '',
    description: 'A block of open questions with AI follow-up probing.',
  },
};

export const QUESTION_KINDS: { value: QuestionKind; label: string }[] = [
  { value: 'open', label: 'Open answer' },
  { value: 'single_choice', label: 'Single choice' },
  { value: 'multi_choice', label: 'Multiple choice' },
  { value: 'rating', label: 'Rating scale' },
  { value: 'yes_no', label: 'Yes / No' },
  { value: 'number', label: 'Number' },
];

export const INSTRUMENT_CHOICES: { id: InstrumentId | 'custom'; short: string; name: string; description: string }[] = [
  ...(['SUS', 'SEQ', 'UMUX_LITE', 'NASA_TLX', 'NPS'] as InstrumentId[]).map((id) => ({
    id,
    short: id === 'UMUX_LITE' ? 'UMUX-Lite' : id === 'NASA_TLX' ? 'NASA-TLX' : id,
    name: INSTRUMENTS[id].name,
    description: INSTRUMENTS[id].description,
  })),
  { id: 'custom', short: 'Custom', name: 'Custom questionnaire', description: 'Your own list of items, answered on screen or read aloud.' },
];

export function newQuestion(kind: QuestionKind = 'open', prompt = ''): Question {
  const q: Question = { id: newId('q'), prompt, kind, required: kind !== 'open', allowFollowUp: kind === 'open' || kind === 'rating' };
  if (kind === 'single_choice' || kind === 'multi_choice') q.options = ['', ''];
  if (kind === 'rating') q.scale = { min: 1, max: 7, minLabel: 'Very difficult', maxLabel: 'Very easy' };
  return q;
}

export function newStep(type: StepType, steps: Step[], instrument?: InstrumentId | 'custom'): Step {
  const n = steps.filter((s) => s.type === type).length + 1;
  switch (type) {
    case 'instruction':
      return { id: newId('step'), type, title: `Instruction ${n}`, script: '', showApp: false, exploreSeconds: 0 };
    case 'question':
      return { id: newId('step'), type, title: `Question ${n}`, question: newQuestion('open') };
    case 'task':
      return {
        id: newId('task'),
        type,
        title: `Task ${steps.filter((s) => s.type === 'task').length + 1}`,
        instruction: '',
        startPath: '',
        successCriteria: '',
        successRules: [],
        timeLimitSec: 300,
        probes: [],
        postTaskQuestions: [],
        askSEQ: true,
      };
    case 'questionnaire': {
      const inst = instrument ?? 'SUS';
      return {
        id: newId('step'),
        type,
        title: inst === 'custom' ? 'Questionnaire' : INSTRUMENT_CHOICES.find((c) => c.id === inst)!.name,
        instrument: inst,
        questions: inst === 'custom' ? [newQuestion('rating')] : undefined,
        productName: '',
        onScreen: true,
      };
    }
    case 'interview':
      return { id: newId('step'), type, title: `Interview ${n}`, goal: '', questions: [''], maxFollowUps: 2 };
  }
}

/** Fresh ids for a step (used when duplicating / appending AI steps). */
export function cloneStep(s: Step): Step {
  const c = structuredClone(s) as Step;
  c.id = newId(s.type === 'task' ? 'task' : 'step');
  if (c.type === 'question') c.question.id = newId('q');
  if (c.type === 'task') c.postTaskQuestions = c.postTaskQuestions?.map((q) => ({ ...q, id: newId('q') }));
  if (c.type === 'questionnaire' && c.questions) c.questions = c.questions.map((q) => ({ ...q, id: newId('q') }));
  return c;
}

export function stepSummary(s: Step): string {
  switch (s.type) {
    case 'instruction':
      return s.script;
    case 'question':
      return s.question.prompt;
    case 'task':
      return s.instruction;
    case 'questionnaire':
      return s.instrument === 'custom' ? `${s.questions?.length ?? 0} custom items` : INSTRUMENT_CHOICES.find((c) => c.id === s.instrument)?.short ?? s.instrument;
    case 'interview':
      return s.questions.filter(Boolean).join(' · ');
  }
}
