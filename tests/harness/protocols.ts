// Small, focused protocols for harness scenarios (each session should take only a few minutes),
// plus the full CrossWeave protocol from examples/stacky/protocol.json.
import fs from 'node:fs';
import path from 'node:path';
import { HARNESS_DIR, ROOT } from './lib/env.ts';

type Json = Record<string, unknown>;

export const APPS = {
  shop: path.join(ROOT, 'tests/mocks/shop-app'),
  crossweaveLite: path.join(HARNESS_DIR, 'apps/crossweave-lite'),
};

const CONSENT = {
  text: '## Before we start\n\nAn **AI moderator** will guide you through a short session. We record your voice, your clicks on the website and your answers.',
  storeAudio: true,
  recordScreen: true,
  offerEyeTracking: false,
  ageGate: true,
  version: 'harness-1',
};

function moderation(over: Json = {}): Json {
  return {
    style: 'think_aloud_concurrent',
    probingLevel: 'light',
    allowClosedQuestions: false,
    silencePromptSeconds: 15,
    maxProbesPerStep: 1,
    probeOnBehavior: true,
    language: 'en',
    voice: 'marin',
    tone: 'warm, calm and strictly neutral',
    customRules: [],
    allowTextFallback: true,
    ...over,
  };
}

/** Lumen shop: one rule-checked task (+SEQ), one open task with open + yes/no post-task questions, a 1-question interview. */
export function shopProtocol(lang: 'en' | 'de' = 'en'): Json {
  if (lang === 'de') {
    return {
      schemaVersion: 1,
      title: 'Lumen Home Nutzerstudie',
      researchGoals: ['Finden Menschen ein Produkt und legen es in den Warenkorb?'],
      productContext: 'Lumen Home ist ein Online-Shop für Möbel und Leuchten.',
      intro:
        'Hallo und danke, dass Sie teilnehmen. Ich bin ein KI-Moderator. Wir testen die Website, nicht Sie – es gibt also keine falschen Antworten. Bitte denken Sie laut, während Sie die Aufgaben bearbeiten. Sind Sie bereit?',
      closing: 'Das war alles. Vielen Dank für Ihre Zeit und Ihr ehrliches Feedback.',
      moderation: moderation({ language: 'de' }),
      consent: CONSENT,
      steps: [
        {
          id: 'task_lamp',
          type: 'task',
          title: 'Schreibtischlampe',
          instruction: 'Stellen Sie sich vor, Sie möchten eine neue Lampe für Ihren Schreibtisch. Finden Sie die Aurora-Schreibtischlampe und legen Sie sie in den Warenkorb.',
          startPath: '/',
          successCriteria: 'Die Aurora-Schreibtischlampe ist im Warenkorb.',
          successRules: [{ type: 'url_matches', pattern: '^/cart' }],
          timeLimitSec: 180,
          probes: [],
          askSEQ: true,
        },
        {
          id: 'task_gift',
          type: 'task',
          title: 'Geschenk',
          instruction: 'Suchen Sie jetzt ein kleines Geschenk für eine Freundin, das weniger als fünfzig Dollar kostet. Sagen Sie mir Bescheid, wenn Sie etwas gefunden haben.',
          startPath: '/',
          successCriteria: 'Die Keramikvase ($39) wird gefunden.',
          successRules: [],
          timeLimitSec: 150,
          probes: [],
          askSEQ: false,
          postTaskQuestions: [
            { id: 'why_choice', prompt: 'Was hat Sie zu dieser Wahl bewogen?', kind: 'open', required: true, allowFollowUp: false },
            { id: 'would_buy', prompt: 'Würden Sie es tatsächlich kaufen?', kind: 'yes_no', required: true },
          ],
        },
        { id: 'wrap', type: 'interview', title: 'Abschluss', goal: 'Gesamteindruck', questions: ['Was, wenn überhaupt, war auf der Website verwirrend?'], maxFollowUps: 0 },
      ],
      randomizeTasks: false,
      estimatedMinutes: 5,
    };
  }
  return {
    schemaVersion: 1,
    title: 'Lumen Home usability study',
    researchGoals: ['Can people find a product and add it to the cart?'],
    productContext: 'Lumen Home is an online shop for furniture and lighting.',
    intro: "Hi, and thanks for joining. I'm an AI moderator. We're testing the website, not you, so there are no wrong answers. Please think out loud as you go. Are you ready to begin?",
    closing: "That's everything. Thank you so much for your time and your honest feedback.",
    moderation: moderation(),
    consent: CONSENT,
    steps: [
      {
        id: 'task_lamp',
        type: 'task',
        title: 'Find a desk lamp',
        instruction: 'Imagine you want a new lamp for your desk. Find the Aurora desk lamp and add it to your cart.',
        startPath: '/',
        successCriteria: 'The Aurora desk lamp is in the cart.',
        successRules: [{ type: 'url_matches', pattern: '^/cart' }],
        timeLimitSec: 180,
        probes: [],
        askSEQ: true,
      },
      {
        id: 'task_gift',
        type: 'task',
        title: 'Find a gift',
        instruction: "Now look for a small gift for a friend that costs less than fifty dollars. Tell me when you've found something.",
        startPath: '/',
        successCriteria: 'Participant finds the ceramic vase ($39).',
        successRules: [],
        timeLimitSec: 150,
        probes: [],
        askSEQ: false,
        postTaskQuestions: [
          { id: 'why_choice', prompt: 'What made you choose that one?', kind: 'open', required: true, allowFollowUp: false },
          { id: 'would_buy', prompt: 'Would you actually buy it?', kind: 'yes_no', required: true },
        ],
      },
      { id: 'wrap', type: 'interview', title: 'Wrap-up', goal: 'Overall impression', questions: ['What, if anything, was confusing about the website?'], maxFollowUps: 0 },
    ],
    randomizeTasks: false,
    estimatedMinutes: 5,
  };
}

/**
 * Replay of the real CrossWeave session P-XKC5 on a small stand-in app: the same task / question
 * wording and moderation settings as examples/stacky/protocol.json, reduced to the steps where the
 * participant hit problems.
 */
export const REAL_SESSION = path.join(ROOT, 'tests/fixtures/real-sessions/stacky-P-XKC5.session.json');

export function crossweaveReplayProtocol(): Json {
  // Same protocol (wording, moderation settings, custom rules) the real participant had; falls back to
  // the current examples/stacky/protocol.json when the (gitignored) recording is not present.
  let full = stackyProtocol();
  if (fs.existsSync(REAL_SESSION) && !process.env.HARNESS_REPLAY_CURRENT_PROTOCOL) {
    const d = JSON.parse(fs.readFileSync(REAL_SESSION, 'utf8')) as { protocol: Json; steps: Json[] };
    full = { ...d.protocol, steps: d.steps };
  }
  const mod = full.moderation as Json;
  const byId = Object.fromEntries((full.steps as Json[]).map((s) => [s.id as string, s]));
  const find = { ...byId.t_find, successRules: [], timeLimitSec: 180, probes: [] };
  const claim = { ...byId.t_claim, timeLimitSec: 150, probes: [] };
  const ai = { ...byId.t_ai, startPath: (byId.t_ai as Json).startPath ?? '/ChineseEVs', timeLimitSec: 180 };
  const wrap = {
    ...byId.wrap,
    questions: ['Overall, how would you describe reading discussions this way?', 'If you could change one thing, what would it be?'],
    maxFollowUps: 0,
  };
  return {
    ...full,
    title: 'CrossWeave replay (P-XKC5)',
    moderation: { ...mod, silencePromptSeconds: 15 },
    consent: { ...(full.consent as Json), offerEyeTracking: false },
    steps: [find, claim, ai, wrap],
    estimatedMinutes: 8,
  };
}

export function stackyProtocol(): Json {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'examples/stacky/protocol.json'), 'utf8')) as Json;
}

/** Participant-facing texts the moderator must read verbatim (for the judge). */
export function verbatimTexts(p: Json): { kind: string; stepId: string; id?: string; text: string }[] {
  const out: { kind: string; stepId: string; id?: string; text: string }[] = [];
  out.push({ kind: 'intro', stepId: 'intro', text: String(p.intro) });
  for (const s of (p.steps as Json[]) ?? []) {
    const id = String(s.id);
    if (s.type === 'task') {
      out.push({ kind: 'task', stepId: id, text: String(s.instruction) });
      if (s.askSEQ) out.push({ kind: 'question', stepId: id, id: 'seq', text: 'Overall, how difficult or easy was the task to complete?' });
      for (const q of (s.postTaskQuestions as Json[]) ?? []) out.push({ kind: 'question', stepId: id, id: String(q.id), text: String(q.prompt) });
    } else if (s.type === 'question') out.push({ kind: 'question', stepId: id, id: String((s.question as Json).id), text: String((s.question as Json).prompt) });
    else if (s.type === 'interview') (s.questions as string[]).forEach((q, i) => out.push({ kind: 'interview', stepId: id, id: `${id}_q${i + 1}`, text: q }));
    else if (s.type === 'instruction') out.push({ kind: 'instruction', stepId: id, text: String(s.script) });
  }
  out.push({ kind: 'closing', stepId: 'closing', text: String(p.closing) });
  return out;
}
