// Offline regression tests (no OpenAI) for the harness findings of 2026-10-22: answer windows for
// every spoken answer, explicit task completion, answers only after the question was heard, and
// standard instruments in the session language.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBrief,
  buildModeratorInstructions,
  hasTerminalPunctuation,
  instrumentIntro,
  questionnaireItems,
  quietNeededMs,
  seqQuestion,
  stepQuestions,
  turnDecision,
  wrapUpDecision,
  ANSWER_SILENCE_MS,
  CLOSED_QUIET_MS,
  OPEN_ENDED_QUIET_MS,
  WRAP_FRAGMENT_QUIET_MS,
  WRAP_QUIET_MS,
  type Protocol,
  type Step,
  type TaskStep,
  type TurnInput,
} from '@thinkaloud/shared';
import { CaptionPacer } from '../../../web/src/participant/captionPacer.ts';

const turn = (o: Partial<TurnInput>): TurnInput => ({ heard: [], typed: false, now: 0, listenFrom: 0, lastHeardAt: 0, lastUserSpeech: 0, userSpeaking: false, transcriptPending: false, ...o });

test('answer window: a thinking pause mid-answer is not the end (replay wrap-up, chatty, nonnative)', () => {
  // Replay "Overall, how would you describe reading discussions this way?" → "It's kind of cool that they just post on the side…" 2.4 s … "but we didn't really get to explore the filters."
  const part1 = turn({ listenFrom: 0, heard: ["It's kind of cool that they just post on the side"], lastHeardAt: 6300, lastUserSpeech: 6000 });
  assert.deepEqual(turnDecision({ ...part1, now: 8400 }), { state: 'wait' }, 'no closing punctuation: 2.4 s is not enough');
  assert.equal(turnDecision({ ...part1, now: 6300 + OPEN_ENDED_QUIET_MS + 10 }).state, 'finished');
  // Chatty: "…not a ton was confusing, honestly," (fragment) → waits ~6 s.
  const frag = turn({ heard: ['Hmm, you know, not a ton was confusing, honestly,'], lastHeardAt: 1000, lastUserSpeech: 900 });
  assert.equal(turnDecision({ ...frag, now: 1000 + 3000 }).state, 'wait');
  assert.equal(turnDecision({ ...frag, now: 1000 + WRAP_FRAGMENT_QUIET_MS + 10 }).state, 'finished');
  // Nonnative: "because it is small" + "and" trailing → fragment.
  assert.equal(turnDecision(turn({ heard: ['Hmm, because it is small and'], lastHeardAt: 0, now: 3000 })).state, 'wait');
  // They resume talking / their transcript is still on its way: wait.
  assert.equal(turnDecision({ ...part1, now: 9000, userSpeaking: true }).state, 'wait');
  assert.equal(turnDecision({ ...part1, now: 9000, lastUserSpeech: 8800, transcriptPending: true }).state, 'wait');
  // The complete answer, then ~2 s of quiet → finished.
  const full = { ...part1, heard: [...part1.heard, "but we didn't really get to explore the filters."], lastHeardAt: 12_000, lastUserSpeech: 11_700 };
  assert.equal(turnDecision({ ...full, now: 13_000 }).state, 'wait');
  assert.equal(turnDecision({ ...full, now: 12_000 + WRAP_QUIET_MS + 10 }).state, 'finished');
});

test('answer window: closed and typed answers are quick; silence is "silent", never "finished"', () => {
  assert.equal(quietNeededMs('Hmm, 6, I guess.', { closed: true }), CLOSED_QUIET_MS);
  assert.equal(quietNeededMs('6', { closed: true }), WRAP_FRAGMENT_QUIET_MS); // a lone fragment still waits
  assert.equal(quietNeededMs('pretty good', { typed: true }), CLOSED_QUIET_MS);
  assert.equal(quietNeededMs('It was fine.'), WRAP_QUIET_MS);
  assert.equal(hasTerminalPunctuation('Is it?'), true);
  assert.equal(hasTerminalPunctuation('It is'), false);
  // Silence after the question: reported as silence (the runner re-prompts once, never records it).
  const d = turnDecision(turn({ listenFrom: 1000, now: 1000 + ANSWER_SILENCE_MS }));
  assert.deepEqual(d, { state: 'silent', quietMs: ANSWER_SILENCE_MS });
  // Speech whose transcript was dropped as noise keeps the window open briefly, then counts as silence.
  assert.equal(turnDecision(turn({ listenFrom: 0, lastUserSpeech: 5000, now: 5500 })).state, 'wait');
  assert.equal(turnDecision(turn({ listenFrom: 0, lastUserSpeech: 5000, now: 8000 })).state, 'silent');
});

test('wrap-up: the silence limit is configurable (re-ask once, then a longer wait)', () => {
  const base = { source: 'button' as const, heard: [], typed: false, listenFrom: 0, lastHeardAt: 0, lastUserSpeech: 0, userSpeaking: false, transcriptPending: false };
  assert.equal(wrapUpDecision({ ...base, now: 10_100 }).ready, true);
  assert.equal(wrapUpDecision({ ...base, now: 10_100, silenceMs: 20_000 }).ready, false);
  assert.deepEqual(wrapUpDecision({ ...base, now: 20_100, silenceMs: 20_000 }), { ready: true, answered: false, ack: "Okay, let's continue." });
  // An unpunctuated answer waits longer than a complete one.
  const open = { ...base, heard: ['It went okay I think'], lastHeardAt: 1000, lastUserSpeech: 900 };
  assert.equal(wrapUpDecision({ ...open, now: 3200 }).ready, false);
  assert.equal(wrapUpDecision({ ...open, now: 1000 + OPEN_ENDED_QUIET_MS + 10 }).ready, true);
});

// ── session language ─────────────────────────────────────────────────────────

const proto = (language: string): Protocol =>
  ({
    schemaVersion: 1,
    title: 'T',
    researchGoals: [],
    productContext: '',
    intro: 'Hallo.',
    closing: 'Danke.',
    moderation: { style: 'think_aloud_concurrent', probingLevel: 'light', allowClosedQuestions: false, silencePromptSeconds: 15, maxProbesPerStep: 1, probeOnBehavior: true, language, voice: 'marin', tone: '', customRules: [], allowTextFallback: true },
    consent: { text: '', storeAudio: false, recordScreen: false, offerEyeTracking: false, ageGate: true, version: '1' },
    steps: [],
    randomizeTasks: false,
    estimatedMinutes: 5,
  }) as unknown as Protocol;

const lampTask: TaskStep = { id: 'task_lamp', type: 'task', title: 'Lampe', instruction: 'Finden Sie die Lampe.', successCriteria: '', successRules: [], probes: [], askSEQ: true } as unknown as TaskStep;

test('SEQ follows the session language (German session read it in English); ids and scale are stable; the wording is recorded', () => {
  const de = seqQuestion('de');
  assert.equal(de.id, 'seq');
  assert.equal(de.prompt, 'Wie schwierig oder einfach war es insgesamt, die Aufgabe zu erledigen?');
  assert.deepEqual(de.scale, { min: 1, max: 7, minLabel: 'Sehr schwierig', maxLabel: 'Sehr einfach' });
  assert.match(de.wording!, /^SEQ\/de/);
  assert.equal(seqQuestion('en').prompt, 'Overall, how difficult or easy was the task to complete?');
  assert.match(seqQuestion('en-US').wording!, /Sauro & Dumas/);
  // The post-task brief dictates the German text.
  const steps: Step[] = [lampTask];
  const q = stepQuestions(lampTask, 'de')[0];
  const b = buildBrief({ protocol: proto('de'), steps, index: 0, taskPhase: 'post', remainingFollowUps: 1, nextQuestion: q, answeredCount: 0 });
  assert.equal(b.say_verbatim, de.prompt);
  assert.match(String(b.question?.answer_format), /Sehr schwierig/);
});

test('SUS in German uses the stored translation; languages without one are translated live by the moderator (ids unchanged)', () => {
  const sus = questionnaireItems({ instrument: 'SUS' }, 'de');
  assert.equal(sus.length, 10);
  assert.deepEqual(sus.map((q) => q.id), Array.from({ length: 10 }, (_, i) => `sus_${i + 1}`));
  assert.equal(sus[0].prompt, 'Ich denke, dass ich das System gerne häufig benutzen würde.');
  assert.equal(sus[4].prompt, 'Ich fand, die verschiedenen Funktionen in diesem System waren gut integriert.');
  assert.equal(sus[0].scale?.minLabel, 'Stimme überhaupt nicht zu');
  assert.match(sus[0].wording!, /SUS\/de: Rummel/);
  assert.match(instrumentIntro('SUS', 'de'), /zehn kurze Aussagen/);
  const named = questionnaireItems({ instrument: 'SUS', productName: 'CrossWeave' }, 'de');
  assert.equal(named[2].prompt, 'Ich fand CrossWeave einfach zu benutzen.');
  // French: English original + translate at read time; the brief says so.
  const fr = seqQuestion('fr');
  assert.equal(fr.prompt, 'Overall, how difficult or easy was the task to complete?');
  assert.equal(fr.translateTo, 'French');
  assert.match(fr.wording!, /translated live/);
  const b = buildBrief({ protocol: proto('fr'), steps: [lampTask], index: 0, taskPhase: 'post', remainingFollowUps: 1, nextQuestion: fr, answeredCount: 0 });
  assert.equal(b.translate_to, 'French');
  // Researcher-written questions are never altered.
  const custom = { id: 'x', prompt: 'Eigene Frage?', kind: 'open', required: false } as const;
  assert.deepEqual(stepQuestions({ ...lampTask, askSEQ: false, postTaskQuestions: [custom] } as TaskStep, 'de'), [custom]);
});

test('a tell/explain task is only ended by an explicit "done"; "Do I click done?" gets a plain answer', () => {
  const p = proto('en');
  const text = buildModeratorInstructions(p, [lampTask]);
  assert.match(text, /Never call set_task_outcome on your own/);
  assert.match(text, /is NOT over just because they said something that sounds like the answer/);
  assert.match(text, /Do I click done\?/);
  assert.doesNotMatch(text, /they do not need to press "I'm done" or say "done"/);
  assert.match(text, /never record anything they said BEFORE you asked the question/);
  assert.match(text, /Silence is not an answer/);
  const b = buildBrief({ protocol: p, steps: [{ ...lampTask, instruction: 'Tell me when you have found something.' } as TaskStep], index: 0, taskPhase: 'active', remainingFollowUps: 1 });
  assert.match(b.your_job, /never call it yourself/);
  assert.match(b.your_job, /do not end the task — wait for their "done"/);
});

test('captions: a response cancelled before it was audible is never logged as said', () => {
  const commits: { text: string; truncated: boolean }[] = [];
  let t = 0;
  const p = new CaptionPacer({ show: () => {}, commit: (_s, text, truncated) => commits.push({ text, truncated }), level: () => null, now: () => t, manual: true });
  p.done('r9:i1', 'Overall, how difficult or easy was the task to complete?', 'final_answer');
  p.cancelled('r9');
  t += 5000;
  p.tick();
  assert.deepEqual(commits, [{ text: '', truncated: true }]);
});
