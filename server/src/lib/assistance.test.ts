// Assistance ladder timing and the 2/1/0 completion score.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBrief, completionScore, nextAssistance, type Protocol, type Step, type TaskAssistance } from '@thinkaloud/shared';

const ladder: TaskAssistance = { generalPrompts: ['What are you looking for right now?', 'What on the page might help?'], directCue: 'Try the category labels on the right.' };
const st = (elapsedSec: number, idleSec: number, generalGiven = 0, lastAssistSec: number | null = null, extra: object = {}) => ({
  elapsedMs: elapsedSec * 1000,
  idleMs: idleSec * 1000,
  generalGiven,
  directGiven: false,
  lastAssistMs: lastAssistSec == null ? null : lastAssistSec * 1000,
  ...extra,
});

test('no help in the first 60 s, even when asked', () => {
  assert.equal(nextAssistance(ladder, st(59, 59)), null);
  assert.equal(nextAssistance(ladder, st(30, 30, 0, null, { helpRequested: true })), null);
});

test('first general prompt at 60 s only when stuck (15 s without clicks or navigation)', () => {
  assert.equal(nextAssistance(ladder, st(61, 10)), null);
  assert.deepEqual(nextAssistance(ladder, st(61, 16)), { level: 'general', index: 0, text: 'What are you looking for right now?' });
});

test('then one prompt per gap, then the direct cue, then nothing', () => {
  assert.equal(nextAssistance(ladder, st(80, 20, 1, 61)), null, 'gap not over');
  assert.deepEqual(nextAssistance(ladder, st(92, 20, 1, 61))?.index, 1);
  assert.equal(nextAssistance(ladder, st(100, 20, 2, 92)), null);
  assert.deepEqual(nextAssistance(ladder, st(123, 20, 2, 92)), { level: 'direct', index: -1, text: 'Try the category labels on the right.' });
  assert.equal(nextAssistance(ladder, { ...st(200, 100, 2, 123), directGiven: true }), null);
  assert.equal(nextAssistance({ generalPrompts: ['Hint?'] }, st(200, 100, 1, 100)), null, 'no direct cue configured');
});

test('an explicit plea for help skips the gap and the stuck check, in ladder order', () => {
  assert.equal(nextAssistance(ladder, st(65, 0, 1, 61, { helpRequested: true }))?.index, 1);
  assert.equal(nextAssistance(ladder, st(66, 0, 2, 65, { helpRequested: true }))?.level, 'direct');
});

test('completionScore', () => {
  assert.equal(completionScore('success'), 2);
  assert.equal(completionScore('success', { general: 2, direct: 0 }), 1);
  assert.equal(completionScore('success', { general: 2, direct: 1 }), 0);
  assert.equal(completionScore('partial'), 1);
  for (const o of ['failure', 'abandoned', 'timeout'] as const) assert.equal(completionScore(o), 0);
});

test('task brief flags the assistance ladder and the prompt rules allow only system prompts', () => {
  const p = {
    schemaVersion: 1, title: 'T', researchGoals: [], productContext: '', intro: 'Hi.', closing: 'Bye.',
    moderation: { style: 'think_aloud_concurrent', probingLevel: 'light', allowClosedQuestions: false, silencePromptSeconds: 15, maxProbesPerStep: 1, probeOnBehavior: true, language: 'en', voice: 'marin', tone: '', customRules: [], allowTextFallback: true },
    consent: { text: '', storeAudio: false, recordScreen: false, offerEyeTracking: false, ageGate: true, version: '1' },
    steps: [], randomizeTasks: false, estimatedMinutes: 5,
  } as unknown as Protocol;
  const steps = [{ id: 't', type: 'task', title: 't', instruction: 'Find it.', successCriteria: 'secret', successRules: [], probes: [], assistance: ladder }] as unknown as Step[];
  const b = buildBrief({ protocol: p, steps, index: 0, taskPhase: 'active', remainingFollowUps: 0 }) as unknown as Record<string, unknown>;
  assert.equal(b.assistance, true);
  assert.match(String(b.your_job), /participant_needs_help/);
  // the direct cue is never in the brief: only the runner hands it out
  assert.doesNotMatch(JSON.stringify(b), /category labels/);
});
