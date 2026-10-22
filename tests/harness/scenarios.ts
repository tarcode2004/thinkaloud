// Scenario library: persona + protocol (+ app) + scripted beats + expectations.
import type { Action, Beat, BeatCtx } from './agent.ts';
import type { CheckId } from './judge.ts';
import { APPS, crossweaveReplayProtocol, shopProtocol, stackyProtocol } from './protocols.ts';

type Json = Record<string, unknown>;

export interface Scenario {
  name: string;
  description: string;
  persona: string;
  protocol: () => Json;
  app: { kind: 'static'; dir: string } | { kind: 'git'; url: string } | null;
  beats?: Beat[];
  /** Gate for the persona rules when no beat matches (default: always). */
  rulesWhen?: (c: BeatCtx) => boolean;
  /** Click/type plan per task step id. */
  plans?: Record<string, Action[]>;
  /** Mock semantic-VAD holds (ms) — how long a pause may be before the turn is committed. */
  vad?: { holdMs?: number; holdUnfinishedMs?: number };
  maxMinutes: number;
  seed?: number;
  /** Per-check severity override ('off' = not applicable for this scenario). */
  expect?: Partial<Record<CheckId, 'fail' | 'warn' | 'off'>>;
  /** Not part of `--scenario all` (slow: builds a server app from git). */
  optIn?: boolean;
  /** The real-session problem moments this scenario reproduces. */
  reproduces?: string[];
}

const say = (intent: Extract<Action, { kind: 'speak' }>['intent'], ...parts: (string | number)[]): Action => {
  const chunks: { text: string; pauseAfterMs: number }[] = [];
  for (const p of parts) {
    if (typeof p === 'number') {
      if (chunks.length) chunks[chunks.length - 1].pauseAfterMs = p;
    } else chunks.push({ text: p, pauseAfterMs: 0 });
  }
  return { kind: 'speak', intent, chunks };
};
const wait = (seconds: number, untilModerator = false): Action => ({ kind: 'wait', seconds, untilModerator, intent: 'silence' });

const HOW_WENT = /how do you feel (that|it) went|how did (that|it) go|how (was|did) (that|it) (go|feel)|how do you think (that|it) went/i;
const step = (c: BeatCtx, id: string) => c.obs.stepId === id;
const active = (c: BeatCtx) => c.obs.phase === 'active';
const post = (c: BeatCtx) => c.obs.phase === 'post';
const modSaid = (c: BeatCtx, re: RegExp) => c.trigger === 'moderator' && re.test(c.mod);

/**
 * Replay of real session P-XKC5 (tests/fixtures/real-sessions/stacky-P-XKC5.*): every problem moment
 * the participant hit, in order, with the participant's own words where possible.
 */
const REPLAY_BEATS: Beat[] = [
  { id: 'intro_ready', when: (c) => step(c, 'intro') && c.trigger === 'moderator', do: [say('ready', "Yep, let's begin.")] },
  // t_find
  {
    id: 'find_explore',
    when: (c) => step(c, 't_find') && active(c) && (c.taskSec ?? 0) > 2,
    do: [
      say('think_aloud', 'Okay, this is interesting.', 1300, "So it looks like there's some stuff on the left. Tariffs, hmm."),
      { kind: 'click', role: 'link', name: 'Search' },
      { kind: 'type', name: 'Search hashtags', text: 'chinese evs', enter: true },
      { kind: 'click', role: 'link', name: '#ChineseEVs' },
    ],
  },
  {
    id: 'find_done',
    reproduces: 'Done button → "How do you feel that went?" took 17s (button stuck pending)',
    when: (c) => step(c, 't_find') && active(c) && c.since('find_explore') > 3,
    do: [say('declare_done', 'Okay, I was able to find it using the search button.'), { kind: 'press_done' }],
  },
  {
    id: 'find_howwent',
    reproduces: 'Pause-split answer after "How do you feel that went?" cut off ("The interfaces")',
    when: (c) => step(c, 't_find') && modSaid(c, HOW_WENT),
    do: [say('answer', 'The interface…', 2600, '…was okay I guess. I found it through the search, but it took me a second.')],
  },
  { id: 'find_seq', when: (c) => step(c, 't_find') && post(c) && c.obs.cardVisible && c.obs.card?.activeQuestionId === 'seq' && (c.trigger === 'moderator' || c.trigger === 'card'), do: [{ kind: 'answer_card', value: 2 }] },
  // t_claim
  {
    id: 'claim_say',
    when: (c) => step(c, 't_claim') && active(c) && (c.taskSec ?? 0) > 3,
    do: [say('answer', "I think it's talking about how America is behind,", 1500, 'specifically when it comes to manufacturing and batteries.')],
  },
  {
    id: 'claim_ask_done',
    reproduces: '"Do I click done?" → moderator ended the task instead of answering',
    when: (c) => step(c, 't_claim') && active(c) && c.since('claim_say') > 5,
    do: [say('meta_question', 'Do I click done?')],
  },
  {
    id: 'claim_done',
    when: (c) => step(c, 't_claim') && active(c) && c.since('claim_ask_done') > 4 && (c.trigger === 'moderator' || c.since('claim_ask_done') > 14),
    do: [{ kind: 'press_done' }],
  },
  { id: 'claim_howwent', when: (c) => step(c, 't_claim') && modSaid(c, HOW_WENT), do: [say('answer', 'Pretty good, I think I did it.')] },
  // t_ai
  {
    id: 'ai_again',
    reproduces: '"What am I supposed to do again?" (task re-read)',
    when: (c) => step(c, 't_ai') && active(c) && (c.taskSec ?? 0) > 4,
    do: [say('clarify', "Let's see, what am I supposed to do again?")],
  },
  {
    id: 'ai_nopost',
    reproduces: 'Observation "I don\'t see any poster" → deflected with "What would you do if I weren\'t here?"',
    when: (c) => step(c, 't_ai') && active(c) && c.since('ai_again') > 3 && (c.trigger === 'moderator' || c.since('ai_again') > 14),
    do: [{ kind: 'click', role: 'article', name: 'Post by David Gelles' }, say('observation', "Hmm. I don't see any post like that.")],
  },
  {
    id: 'ai_whatmean',
    reproduces: '"What does that mean?" about the moderator\'s own words → "What do you think it means?"',
    when: (c) => step(c, 't_ai') && active(c) && c.fired.has('ai_nopost') && c.trigger === 'moderator' && c.since('ai_nopost') < 40,
    do: [say('clarify', 'What does that mean?')],
  },
  {
    id: 'ai_whatmean_task',
    reproduces: 'Clarification about the task wording',
    when: (c) => step(c, 't_ai') && active(c) && !c.fired.has('ai_whatmean') && c.since('ai_nopost') > 14,
    do: [say('clarify', "Sorry, what do you mean by 'take a close look at it'?")],
  },
  {
    id: 'ai_annoyed',
    reproduces: 'Frustration ("Are you saying I need to find it without your help?")',
    when: (c) => {
      const t = Math.max(c.since('ai_whatmean'), c.since('ai_whatmean_task'));
      return step(c, 't_ai') && active(c) && t > 3 && (c.trigger === 'moderator' || t > 12);
    },
    do: [say('complaint', "I don't know. Are you saying I need to find it without your help?")],
  },
  {
    id: 'ai_skip',
    reproduces: 'Skip a task that has open post-task questions → no on-screen UI for them',
    when: (c) => step(c, 't_ai') && active(c) && c.since('ai_annoyed') > 4 && (c.trigger === 'moderator' || c.since('ai_annoyed') > 12),
    do: [say('complaint', "I can't see any modified by AI post. Whatever."), { kind: 'press_skip' }],
  },
  {
    id: 'ai_green_what',
    when: (c) => step(c, 't_ai') && post(c) && modSaid(c, /green text/i),
    do: [say('clarify', 'What green text?')],
  },
  {
    id: 'ai_green_idk',
    once: false,
    when: (c) => step(c, 't_ai') && post(c) && c.fired.has('ai_green_what') && modSaid(c, /green text/i) && c.readings('Who do you think wrote the highlighted green text?') <= 4,
    do: [say('answer', "I don't know.")],
  },
  {
    id: 'ai_orig_idk',
    once: false,
    reproduces: '"I don\'t know" to a yes/no question → question repeated 3–4 times',
    when: (c) => step(c, 't_ai') && post(c) && modSaid(c, /original post|yes or no|closest to you/i) && c.readings('Was the original post itself changed?') <= 4,
    do: (c) => (c.readings('Was the original post itself changed?') >= 3 && c.obs.cardVisible ? [{ kind: 'answer_card', value: 0 }] : [say('answer', "I don't know.")]),
  },
  // wrap
  {
    id: 'wrap_q1',
    reproduces: 'Pause-split interview answer',
    when: (c) => step(c, 'wrap') && modSaid(c, /describe reading discussions/i),
    do: [say('answer', "It's kind of cool that they just post on the side…", 2400, "…but we didn't really get to explore the filters.")],
  },
  {
    id: 'wrap_q2_silence',
    reproduces: 'Silence after the wrap-up question → "Thanks" and moved on',
    when: (c) => step(c, 'wrap') && modSaid(c, /change one thing/i),
    do: [wait(18)],
  },
  { id: 'wrap_q2_idk', when: (c) => step(c, 'wrap') && c.fired.has('wrap_q2_silence') && c.trigger === 'moderator', do: [say('answer', "Hmm. I don't know, honestly.")] },
  // Nobody re-prompted after the silence: they answer anyway (as the real participant did).
  { id: 'wrap_q2_late', when: (c) => step(c, 'wrap') && c.since('wrap_q2_silence') > 26 && !c.fired.has('wrap_q2_idk'), do: [say('answer', "Hmm. I don't know, honestly.")] },
];

const SHOP_PLANS: Record<string, Action[]> = {
  task_lamp: [
    { kind: 'click', role: 'link', name: 'Lighting' },
    { kind: 'click', role: 'link', name: 'Aurora desk lamp' },
    { kind: 'click', role: 'button', name: 'Add to cart' },
  ],
  task_gift: [
    { kind: 'click', role: 'link', name: 'Decor' },
    { kind: 'click', role: 'link', name: 'Ceramic vase' },
  ],
};

const personaScenario = (persona: string, description: string, over: Partial<Scenario> = {}): Scenario => ({
  name: persona,
  description,
  persona,
  protocol: () => shopProtocol(persona === 'german' ? 'de' : 'en'),
  app: { kind: 'static', dir: APPS.shop },
  plans: SHOP_PLANS,
  maxMinutes: 9,
  ...over,
});

export const SCENARIOS: Scenario[] = [
  {
    name: 'replay',
    description: 'Replay of real CrossWeave session P-XKC5 on a stand-in app: the exact problem moments the participant reported.',
    persona: 'replay',
    protocol: crossweaveReplayProtocol,
    app: { kind: 'static', dir: APPS.crossweaveLite },
    beats: REPLAY_BEATS,
    // Task behaviour is scripted (the real participant never found the AI post): rules only answer outside active tasks.
    rulesWhen: (c) => !(c.obs.type === 'task' && c.obs.phase !== 'post'),
    maxMinutes: 12,
    reproduces: REPLAY_BEATS.filter((b) => b.reproduces).map((b) => b.reproduces!),
  },
  personaScenario('novice', 'Confused novice on the shop protocol: asks what the moderator\'s words mean, slow, fillers.'),
  personaScenario('expert', 'Terse expert: fast, one-word answers, presses buttons.'),
  personaScenario('chatty', 'Chatty think-aloud: long answers in several bursts with mid-sentence pauses, talks over.'),
  personaScenario('impatient', 'Impatient participant who gets annoyed and skips.'),
  personaScenario('nonnative', 'Non-native English speaker: simple English, asks to repeat.'),
  personaScenario('idk', '"I don\'t know" to everything (incl. yes/no) and skips tasks.'),
  personaScenario('silent', 'Goes silent: no think-aloud, long silences after questions.'),
  personaScenario('german', 'German-speaking participant on a German protocol.'),
  {
    name: 'stacky-full',
    description: 'Full CrossWeave protocol (examples/stacky/protocol.json) against the real Stacky client built from git (slow, opt-in).',
    persona: 'novice',
    protocol: stackyProtocol,
    app: { kind: 'git', url: process.env.STACKY_GIT || 'git@github.com:stacky-social/client.git' },
    maxMinutes: 25,
    optIn: true,
  },
];

export function pickScenarios(sel: string): Scenario[] {
  if (sel === 'all') return SCENARIOS.filter((s) => !s.optIn);
  const names = sel.split(',').map((s) => s.trim());
  const out = names.map((n) => SCENARIOS.find((s) => s.name === n));
  const bad = names.filter((n, i) => !out[i]);
  if (bad.length) throw new Error(`Unknown scenario(s): ${bad.join(', ')}. Known: ${SCENARIOS.map((s) => s.name).join(', ')}`);
  return out as Scenario[];
}
