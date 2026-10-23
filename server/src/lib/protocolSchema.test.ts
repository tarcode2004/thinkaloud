import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONSENT, DEFAULT_INTRO, DEFAULT_MODERATION, emptyProtocol, starterProtocol, type TaskStep } from '@thinkaloud/shared';
import { ProtocolSchema, normalizeProtocol } from './protocolSchema.ts';

test('starter and empty protocols round-trip unchanged', () => {
  for (const p of [starterProtocol('Acme Shop'), emptyProtocol('X')]) {
    assert.deepEqual(normalizeProtocol(p), JSON.parse(JSON.stringify(p)));
  }
});

test('missing fields get defaults', () => {
  const p = normalizeProtocol({});
  assert.equal(p.schemaVersion, 1);
  assert.equal(p.intro, DEFAULT_INTRO);
  assert.deepEqual(p.moderation, DEFAULT_MODERATION);
  assert.deepEqual(p.consent, DEFAULT_CONSENT);
  assert.deepEqual(p.steps, []);
  assert.equal(p.randomizeTasks, false);
  assert.equal(p.estimatedMinutes, 15);
});

test('partial moderation is merged with defaults; bad enum values fall back', () => {
  const p = normalizeProtocol({ moderation: { voice: 'robot', style: 'Think aloud retrospective', language: null, maxProbesPerStep: '3' } });
  assert.equal(p.moderation.voice, DEFAULT_MODERATION.voice);
  assert.equal(p.moderation.style, 'think_aloud_retrospective');
  assert.equal(p.moderation.language, 'en');
  assert.equal(p.moderation.maxProbesPerStep, 3);
  assert.equal(p.moderation.tone, DEFAULT_MODERATION.tone);
});

test('coercion of AI-ish output: nulls, string numbers, enum aliases, object lists', () => {
  const p = normalizeProtocol({
    title: 'T',
    estimatedMinutes: '20',
    steps: [
      {
        type: 'Task',
        title: 'Find a jacket',
        instruction: 'Imagine…',
        successCriteria: 'Product page of a red jacket',
        timeLimitSec: '120',
        startPath: null,
        successRules: [{ type: 'url_matches', pattern: '(' }, { type: 'url_matches', pattern: '^/product/' }, { type: 'nope' }, { type: 'click_matches' }],
        postTaskQuestions: [{ id: 'seq', prompt: 'Extra', kind: 'likert' }],
        askSEQ: 'true',
      },
      { type: 'questionnaire', instrument: 'umux-lite' },
      { type: 'interview', goal: 'g', questions: [{ prompt: 'Why?' }, 'How?'] },
      { type: 'question', question: { prompt: 'Pick', kind: 'multiple choice', options: ['a', 'a', ' b '] } },
    ],
  });
  assert.equal(p.estimatedMinutes, 20);
  const t = p.steps[0] as TaskStep;
  assert.equal(t.id, 'find_a_jacket');
  assert.equal(t.timeLimitSec, 120);
  assert.equal(t.startPath, undefined);
  assert.deepEqual(t.successRules, [{ type: 'url_matches', pattern: '^/product/' }]);
  assert.equal(t.askSEQ, true);
  assert.notEqual(t.postTaskQuestions![0].id, 'seq', 'seq id is reserved when askSEQ');
  assert.deepEqual(t.postTaskQuestions![0].scale, { min: 1, max: 7 });
  assert.equal(p.steps[1].type === 'questionnaire' && p.steps[1].instrument, 'UMUX_LITE');
  assert.deepEqual(p.steps[2].type === 'interview' && p.steps[2].questions, ['Why?', 'How?']);
  const q = p.steps[3].type === 'question' ? p.steps[3].question : null;
  assert.equal(q?.kind, 'single_choice');
  assert.deepEqual(q?.options, ['a', 'b']);
});

test('step ids and question ids are made unique and titles filled', () => {
  const p = normalizeProtocol({
    steps: [
      { id: 'a', type: 'instruction', script: 'x' },
      { id: 'a', type: 'instruction', script: 'y' },
      { type: 'task' },
      { type: 'task' },
      { id: 'q', type: 'question', question: { id: 'same', prompt: '1' } },
      { id: 'q2', type: 'question', question: { id: 'same', prompt: '2' } },
    ],
  });
  const ids = p.steps.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids.slice(0, 4), ['a', 'a_2', 'task_1', 'task_2']);
  assert.equal(p.steps[2].title, 'Task 1');
  const qids = p.steps.flatMap((s) => (s.type === 'question' ? [s.question.id] : []));
  assert.equal(new Set(qids).size, 2);
});

test('structural errors are rejected', () => {
  assert.equal(ProtocolSchema.safeParse({ steps: [{ type: 'video' }] }).success, false);
  assert.equal(ProtocolSchema.safeParse({ steps: 'nope' }).success, false);
  assert.equal(ProtocolSchema.safeParse('x').success, false);
  assert.throws(() => normalizeProtocol({ steps: [{ type: 'questionnaire', instrument: 'XYZ' }] }));
});

test('assistance ladder, soft limit and app-visible interview steps round-trip', () => {
  const p = starterProtocol('Acme Shop');
  p.steps = [
    { id: 'look', type: 'instruction', title: 'Look', script: 'Take a look.', showApp: true, exploreSeconds: 30, startPath: '/ChineseEVs' },
    { id: 'mm', type: 'interview', title: 'Mental model', goal: 'g', questions: ['What do you think this page is for?'], showApp: true, startPath: '/ChineseEVs' },
    {
      id: 't1', type: 'task', title: 'T1', instruction: 'Do it.', successCriteria: 's', successRules: [], probes: [], timeLimitSec: 300, softLimitSec: 120,
      assistance: { generalPrompts: ['What are you looking for right now?', 'What on the page might help?'], firstAfterSec: 60, gapSec: 30, directCue: 'Try the filters.' },
    },
  ];
  assert.deepEqual(normalizeProtocol(p).steps, JSON.parse(JSON.stringify(p.steps)));
});
