// A new task is announced by number, and the first task says once how to finish.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBrief, taskNumber, type Protocol, type Step, type TaskStep } from '@thinkaloud/shared';

const proto = (language: string) =>
  ({
    schemaVersion: 1,
    title: 'T',
    researchGoals: [],
    productContext: '',
    intro: 'Hi.',
    closing: 'Bye.',
    moderation: { style: 'think_aloud_concurrent', probingLevel: 'light', allowClosedQuestions: false, silencePromptSeconds: 15, maxProbesPerStep: 1, probeOnBehavior: true, language, voice: 'marin', tone: '', customRules: [], allowTextFallback: true },
    consent: { text: '', storeAudio: false, recordScreen: false, offerEyeTracking: false, ageGate: true, version: '1' },
    steps: [],
    randomizeTasks: false,
    estimatedMinutes: 5,
  }) as unknown as Protocol;
const task = (id: string, instruction: string) => ({ id, type: 'task', title: id, instruction, successCriteria: '', successRules: [], probes: [], askSEQ: false }) as unknown as TaskStep;
const steps: Step[] = [
  { id: 'warm', type: 'interview', title: 'Warm-up', goal: '', questions: ['Hi?'], maxFollowUps: 0 } as unknown as Step,
  task('t1', 'Find the lamp.'),
  task('t2', 'Find the poster.'),
];
const brief = (index: number, language = 'en') => buildBrief({ protocol: proto(language), steps, index, taskPhase: 'briefing', remainingFollowUps: 0 });

test('tasks are numbered among tasks only', () => {
  assert.deepEqual(taskNumber(steps, steps[1]), { n: 1, total: 2 });
  assert.deepEqual(taskNumber(steps, steps[2]), { n: 2, total: 2 });
  assert.equal(taskNumber(steps, steps[0]), null);
});

test('English: "Task one of two." + how to finish (first task only); "Task two of two." next', () => {
  assert.equal(brief(1).say_verbatim, "Task one of two. Find the lamp. When you're finished, just tell me, or press I'm done.");
  assert.equal(brief(2).say_verbatim, 'Task two of two. Find the poster.');
  assert.equal(brief(2).task_number, '2 of 2');
  // Dictated text must stay quotable (the runner wraps it in double quotes).
  assert.doesNotMatch(String(brief(1).say_verbatim), /"/);
});

test('a single task is not numbered; other languages keep the text and get the number as an instruction', () => {
  const one: Step[] = [task('t1', 'Find the lamp.')];
  assert.equal(buildBrief({ protocol: proto('en'), steps: one, index: 0, taskPhase: 'briefing', remainingFollowUps: 0 }).say_verbatim, "Find the lamp. When you're finished, just tell me, or press I'm done.");
  const de = brief(2, 'de');
  assert.equal(de.say_verbatim, 'Find the poster.');
  assert.match(String(de.your_job), /task 2 of 2/);
});
