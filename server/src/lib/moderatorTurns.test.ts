// Regression tests from the real CrossWeave session P-XKC5 (tests/fixtures/real-sessions): turn-taking
// heuristics, noise filtering, "I don't know" answers and the moderator's neutrality rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildBrief,
  buildModeratorInstructions,
  isDontKnow,
  isLikelyNoise,
  resumeFrom,
  isUnfinishedUtterance,
  MODERATOR_TOOLS,
  type Protocol,
  type Step,
  type TaskStep,
} from '@thinkaloud/shared';

const FIXTURE = path.resolve(import.meta.dirname, '../../../tests/fixtures/real-sessions/stacky-P-XKC5.session.json');
const real = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { protocol: Protocol; steps: Step[]; events: { kind: string; data: Record<string, unknown> }[] };

test('fragments after "How do you feel that went?" count as unfinished; full sentences do not', () => {
  for (const t of ['The interfaces', 'cod', 'But--', 'I think the', 'It was okay, but', 'Well, um', 'So the search...']) assert.equal(isUnfinishedUtterance(t), true, t);
  for (const t of ['Pretty good, I think I did it.', 'I mean, I don\'t know what that means.', 'It went fine.', 'Okay, I was able to find it using the search button.', 'It was pretty easy overall I would say'])
    assert.equal(isUnfinishedUtterance(t), false, t);
});

test('background-noise transcripts in the wrong language are noise; short real answers are not', () => {
  for (const t of ['Tja, wol zančanic.', 'Wortfrieden-Text.', 'Привет', '谢谢']) assert.equal(isLikelyNoise({ text: t, language: 'en' }), true, t);
  for (const t of ['pretty good', 'I don\'t know.', 'What post?', 'Yes.', 'No', 'cod', 'Nice.', 'skip this one', 'The interfaces'])
    assert.equal(isLikelyNoise({ text: t, language: 'en' }), false, t);
  // Low transcription confidence on a short fragment → noise; long utterances are always kept.
  assert.equal(isLikelyNoise({ text: 'Free delivery', language: 'en', avgLogprob: -1.6 }), true);
  assert.equal(isLikelyNoise({ text: 'So this post is basically saying that we are behind China', language: 'en', avgLogprob: -1.6 }), false);
  // German sessions keep German words and umlauts.
  assert.equal(isLikelyNoise({ text: 'Das lief gut.', language: 'de' }), false);
  assert.equal(isLikelyNoise({ text: 'Schön.', language: 'de' }), false);
});

test('"I don\'t know" is recognised in several languages', () => {
  for (const t of ["I don't know.", 'I dont know', 'Not sure', 'No idea', "I didn't see that", 'Keine Ahnung', 'Ich weiß nicht', 'je ne sais pas', 'no sé', 'bilmiyorum'])
    assert.equal(isDontKnow(t), true, t);
  for (const t of ['Yes', 'No', 'The AI wrote it', 'I know where it is']) assert.equal(isDontKnow(t), false, t);
});

test('record_answer accepts declined answers; set_task_outcome only when the system says so (never on a tell/explain answer alone)', () => {
  const rec = MODERATOR_TOOLS.find((t) => t.name === 'record_answer')!;
  assert.ok((rec.parameters as { properties: Record<string, unknown> }).properties.declined);
  assert.match(rec.description, /I don't know/);
  const out = MODERATOR_TOOLS.find((t) => t.name === 'set_task_outcome')!;
  assert.match(out.description, /ONLY when the system tells you to/);
  assert.match(out.description, /Never call it on your own/);
  assert.doesNotMatch(out.description, /do not need to press a button/);
  assert.match(out.description, /Never call it while the participant is still talking/);
});

test('neutrality rules: no "if I weren\'t here", plain answers to task-wording questions, narrow custom rules', () => {
  const text = buildModeratorInstructions(real.protocol, real.steps);
  // The deflection is only mentioned as banned, never offered as an example reply.
  const mentions = text.split("What would you do if I weren't here?").length - 1;
  assert.equal(mentions, 1);
  assert.match(text, /Never say "What would you do if I weren't here\?"/);
  assert.doesNotMatch(text, /redirect neutrally: "What would you expect\?" \/ "What would you do if I weren't here\?"/);
  assert.match(text, /OBSERVATION/);
  assert.match(text, /TASK WORDING or about something YOU just said/);
  assert.match(text, /remind them ONCE per task/);
  // The study's custom rule "if asked, reply 'What do you think it means?'" is scoped narrowly.
  assert.match(text, /What do you think it means\?/);
  assert.match(text, /Researcher rules never override rule 3b/);
  assert.match(text, /never to unclear fragments/);
  assert.match(text, /Never ask the same question more than twice/);
  assert.match(text, /background noise/i);
});

test('post-task questions after a skipped task accept "I didn\'t see that"; a question asked twice is not asked again', () => {
  const steps = real.steps;
  const index = steps.findIndex((s) => s.id === 't_ai');
  const step = steps[index] as TaskStep;
  const q = step.postTaskQuestions![0];
  const base = { protocol: real.protocol, steps, index, taskPhase: 'post' as const, remainingFollowUps: 2, nextQuestion: q, answeredCount: 0 };
  const skipped = buildBrief({ ...base, taskEndedAs: 'abandoned' });
  assert.equal(skipped.say_verbatim, q.prompt);
  assert.match(skipped.your_job, /did not finish this task/);
  assert.match(skipped.your_job, /declined: true/);
  const twice = buildBrief({ ...base, taskEndedAs: 'abandoned', timesAsked: 2 });
  assert.equal(twice.say_verbatim, undefined);
  assert.match(twice.your_job, /already asked this question twice — do NOT ask it again/);
});

test('the real session shows the regressions these rules address', () => {
  const said = real.events.filter((e) => e.kind === 'transcript.moderator').map((e) => String(e.data.text));
  assert.ok(said.includes("What would you do if I weren't here?"));
  const err = real.events.find((e) => e.kind === 'moderator.tool' && e.data.ok === false);
  assert.equal(err?.data.error, 'value must be 1 (yes) or 0 (no).');
});

test('isLikelyNoise: more words than anyone can say in the speech behind them is noise', () => {
  // The real case: "It could be too." from 0.17 s of "speech" during the intro.
  assert.equal(isLikelyNoise({ text: 'It could be too.', language: 'en', durationMs: 170 }), true);
  assert.equal(isLikelyNoise({ text: 'It could be too.', language: 'en', durationMs: 470 }), true);
  // Real answers, also with VAD padding missing.
  assert.equal(isLikelyNoise({ text: "Yes, I'm ready.", language: 'en', durationMs: 600 }), false);
  assert.equal(isLikelyNoise({ text: 'Yes.', language: 'en', durationMs: 120 }), false);
  assert.equal(isLikelyNoise({ text: 'I think the second post is the one about batteries.', language: 'en', durationMs: 1500 }), false);
  assert.equal(isLikelyNoise({ text: 'I think the second post is the one about batteries.', language: 'en', durationMs: 900 }), true);
  // Unknown duration: unchanged behaviour.
  assert.equal(isLikelyNoise({ text: 'It could be too.', language: 'en' }), false);
});

test('resumeFrom: continue a cut-off turn from the start of the sentence it was cut in', () => {
  const full = "Hi, and thanks for joining. I'm an AI moderator, and I'll guide you through this session. Are you okay with recording?";
  assert.equal(resumeFrom(full, "Hi, and thanks for joining. I'm an AI moderator,"), "I'm an AI moderator, and I'll guide you through this session. Are you okay with recording?");
  assert.equal(resumeFrom(full, 'Hi, and thanks for joining.'), "I'm an AI moderator, and I'll guide you through this session. Are you okay with recording?");
  assert.equal(resumeFrom(full, ''), full);
  assert.equal(resumeFrom(full, full), '');
});
