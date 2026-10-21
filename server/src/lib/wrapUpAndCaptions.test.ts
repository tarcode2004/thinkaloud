// Offline regression tests (no OpenAI): the "I'm done" answer window, record_answer validation
// and the caption pacer, replaying timings from the real CrossWeave session P-XKC5.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRecordAnswer, wrapUpDecision, type Question, type WrapUpInput } from '@thinkaloud/shared';
import { CaptionPacer, firstWords, type PacedSegment } from '../../../web/src/participant/captionPacer.ts';

const win = (o: Partial<WrapUpInput>): WrapUpInput => ({
  source: 'button',
  heard: [],
  typed: false,
  now: 0,
  listenFrom: 0,
  lastHeardAt: 0,
  lastUserSpeech: 0,
  userSpeaking: false,
  transcriptPending: false,
  ...o,
});

test('wrap-up: the real session\'s "The interfaces" (t=194.8) is not an answer 0.4 s later', () => {
  // Question finished at 180.4 s; participant spoke 181.9–194.2; transcript "The interfaces" at 194.8; the model judged at 195.2.
  const base = win({ listenFrom: 180_400, heard: ['The interfaces'], lastHeardAt: 194_800, lastUserSpeech: 194_200 });
  assert.deepEqual(wrapUpDecision({ ...base, now: 195_200 }), { ready: false });
  assert.deepEqual(wrapUpDecision({ ...base, now: 197_500 }), { ready: false }); // fragment → waits ~6 s
  // They go on talking: still not ready while speaking or while the transcript is pending.
  assert.deepEqual(wrapUpDecision({ ...base, now: 198_000, userSpeaking: true }), { ready: false });
  assert.deepEqual(wrapUpDecision({ ...base, now: 199_000, lastUserSpeech: 198_500, transcriptPending: true }), { ready: false });
  // Full answer, then 2 s of quiet → ready, "Thanks."
  const full = { ...base, heard: ['The interfaces', 'were a bit confusing at first, but I found it in the end.'], lastHeardAt: 199_600, lastUserSpeech: 199_000 };
  assert.deepEqual(wrapUpDecision({ ...full, now: 200_500 }), { ready: false });
  assert.deepEqual(wrapUpDecision({ ...full, now: 201_700 }), { ready: true, answered: true, ack: 'Thanks.' });
});

test('wrap-up: "cod" (t=366) waits; a lone fragment ends with "Okay, let\'s continue." not "Thanks."', () => {
  const base = win({ listenFrom: 355_300, heard: ['cod'], lastHeardAt: 366_000, lastUserSpeech: 365_500 });
  assert.deepEqual(wrapUpDecision({ ...base, now: 366_700 }), { ready: false });
  assert.deepEqual(wrapUpDecision({ ...base, now: 372_100 }), { ready: true, answered: false, ack: "Okay, let's continue." });
});

test('wrap-up: silence after the question → ~10 s, then "Okay, let\'s continue."', () => {
  const base = win({ listenFrom: 10_000 });
  assert.deepEqual(wrapUpDecision({ ...base, now: 15_000 }), { ready: false });
  assert.deepEqual(wrapUpDecision({ ...base, now: 19_900 }), { ready: false });
  assert.deepEqual(wrapUpDecision({ ...base, now: 20_100 }), { ready: true, answered: false, ack: "Okay, let's continue." });
});

test('wrap-up: complete answers ("Pretty good, I think I did it.") after 2 s; typed answers sooner; the window is capped', () => {
  const base = win({ listenFrom: 0, heard: ['Pretty good, I think I did it.'], lastHeardAt: 5000, lastUserSpeech: 4600 });
  assert.equal(wrapUpDecision({ ...base, now: 6500 }).ready, false);
  assert.deepEqual(wrapUpDecision({ ...base, now: 7100 }), { ready: true, answered: true, ack: 'Thanks.' });
  // "pretty good" typed (t=715): deliberate, no fragment wait.
  const typed = win({ heard: ['pretty good'], typed: true, lastHeardAt: 5000 });
  assert.equal(wrapUpDecision({ ...typed, now: 6300 }).ready, true);
  // A delivered tell/explain answer counts as answered.
  const del = win({ source: 'delivered', heard: ['So this post is basically saying we are falling behind China.'], lastHeardAt: 1000 });
  assert.deepEqual(wrapUpDecision({ ...del, now: 3100 }), { ready: true, answered: true, ack: 'Thanks.' });
  // Someone who never stops: capped.
  assert.equal(wrapUpDecision(win({ heard: ['and'], lastHeardAt: 79_000, lastUserSpeech: 79_500, now: 80_000 })).ready, true);
});

const yesNo: Question = { id: 'orig_changed', prompt: 'Was the original post itself changed?', kind: 'yes_no', required: true };
const open: Question = { id: 'who_green', prompt: 'Who do you think wrote the highlighted green text?', kind: 'open', required: true };
const rating: Question = { id: 'seq', prompt: 'How easy?', kind: 'rating', scale: { min: 1, max: 7 }, required: true };

test('record_answer: "I don\'t know" is valid for yes/no (was "value must be 1 (yes) or 0 (no)") and every other kind', () => {
  // The exact failing call from the real session (t=593.1).
  assert.deepEqual(parseRecordAnswer(yesNo, { question_id: 'orig_changed', text: "They said they don't know and didn't see anything." } as never), {
    text: "They said they don't know and didn't see anything.",
    declined: true,
  });
  assert.deepEqual(parseRecordAnswer(rating, { text: 'Not sure, honestly' }), { text: 'Not sure, honestly', declined: true });
  assert.deepEqual(parseRecordAnswer(open, { declined: true, text: "I didn't get to see that" }), { text: "I didn't get to see that", declined: true });
  assert.deepEqual(parseRecordAnswer(yesNo, { declined: true }), { text: "I don't know", declined: true });
  // Ordinary answers still validate.
  assert.deepEqual(parseRecordAnswer(yesNo, { text: 'Yes, it was' }), { value: 1, choices: ['Yes'], text: 'Yes, it was' });
  assert.ok('error' in parseRecordAnswer(rating, { text: 'somewhere in the middle' }));
  assert.ok('error' in parseRecordAnswer(yesNo, { text: 'What post?' }));
  // …but never a third reading: once asked twice, whatever they said is kept as declined.
  assert.deepEqual(parseRecordAnswer(yesNo, { text: 'What post?' }, { timesAsked: 2 }), { text: 'What post?', declined: true });
});

// ── caption pacer ────────────────────────────────────────────────────────────
const INTRO =
  "Hi, and thanks for joining! I'm an AI moderator, and I'll guide you through this session. We're testing a social media reading app, not you, so there are no wrong answers. Ready to begin?";

function pacer(level: () => number | null = () => null) {
  let t = 0;
  const shown = new Map<string, string>();
  const commits: { seg: PacedSegment; text: string; truncated: boolean }[] = [];
  const p = new CaptionPacer({
    show: (id, text) => shown.set(id, text),
    commit: (seg, text, truncated) => commits.push({ seg, text, truncated }),
    level,
    now: () => t,
    manual: true,
  });
  const advance = (ms: number) => {
    for (let i = 0; i < ms; i += 70) {
      t += 70;
      p.tick();
    }
  };
  return { p, shown, commits, advance, words: (id: string) => (shown.get(id) ?? '').split(/\s+/).filter(Boolean).length };
}

test('captions: nothing before the audio starts, then never ahead of a ~3 words/s voice even though the transcript arrived at once', () => {
  const { p, shown, commits, advance, words } = pacer();
  const id = 'resp_1:item_1';
  // The whole transcript streams in (much faster than real time) before any audio plays.
  for (const w of INTRO.split(/(?<= )/)) p.delta(id, w);
  p.done(id, INTRO, 'final_answer');
  advance(1500);
  assert.equal(shown.get(id), undefined, 'no caption before output_audio_buffer.started');
  p.audioStart('resp_1');
  let ms = 0;
  for (let i = 0; i < 40; i++) {
    advance(250);
    ms += 250;
    assert.ok(words(id) <= Math.ceil((ms / 1000) * 3.2) + 1, `${words(id)} words after ${ms} ms`);
  }
  assert.ok(words(id) < INTRO.split(/\s+/).length, 'still revealing after 10 s');
  assert.equal(commits.length, 0, 'transcript is logged when the audio ends, not when generated');
  p.audioStop('resp_1', false);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].text, INTRO);
  assert.equal(commits[0].truncated, false);
});

test('captions pause while the voice is silent (remote audio meter) and resume with it', () => {
  let level = 0.2;
  const { p, advance, words } = pacer(() => level);
  const id = 'r2:i';
  p.done(id, 'One two three four five six seven eight nine ten.', 'final_answer');
  p.audioStart('r2');
  advance(1000);
  const atPause = words(id);
  assert.ok(atPause >= 2 && atPause <= 4, `${atPause}`);
  level = 0; // a pause in the speech
  advance(1500);
  assert.equal(words(id), atPause);
  level = 0.2;
  advance(700);
  assert.ok(words(id) > atPause);
});

test('captions: an interruption cuts the caption and the logged transcript where the audio stopped', () => {
  const { p, commits, advance, words } = pacer();
  const id = 'r3:item_9';
  const text = 'Find a post on the right that is marked as modified by AI. Take a close look at it and tell me which words came from the person who wrote the post.';
  p.done(id, text, 'final_answer');
  p.audioStart('r3');
  advance(2000);
  const n = words(id);
  const cut = p.audioStop('r3', true);
  assert.ok(cut && cut.seg.itemId === 'item_9' && cut.playedMs >= 1900, 'returns the item + played ms for conversation.item.truncate');
  assert.equal(commits[0].truncated, true);
  assert.equal(commits[0].text, firstWords(text, n));
  assert.ok(commits[0].text.length < text.length);
});

test('captions: the measured speaking rate adapts the pace', () => {
  const { p, advance } = pacer();
  const before = p.rate;
  const long = Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ');
  p.done('r4:i', long, 'final_answer');
  p.audioStart('r4');
  advance(6000); // 30 words in 6 s = 5 words/s actually spoken
  p.audioStop('r4', false);
  assert.ok(p.rate > before, `${before} → ${p.rate}`);
});
