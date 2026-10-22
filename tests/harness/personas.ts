// Rule-based synthetic participant personas (no LLM): phrase templates + behaviour knobs that the
// persona engine applies with a seeded RNG, so every run is reproducible for a given --seed.

export interface Knobs {
  /** Probability that a spoken answer is split into chunks with a 1.2–3 s thinking pause. */
  pause: number;
  /** Probability (per moderator question) of first asking what it means. */
  clarify: number;
  /** Probability (per task) of giving up and skipping. */
  skip: number;
  /** Probability (per moderator question) of staying silent for a long while. */
  silence: number;
  /** Probability (per question) of answering "I don't know" (at least the first time). */
  dontKnow: number;
  /** How the participant signals they finished a task. */
  done: 'voice' | 'button' | 'mixed';
  /** How on-screen questions are answered. */
  answer: 'screen' | 'voice' | 'mixed';
  /** Seconds between think-aloud utterances / actions during a task. */
  tempoSec: [number, number];
  /** Reaction delay after the moderator stops talking (ms). */
  reactMs: [number, number];
  /** Keeps talking when the moderator starts speaking into a pause (vs. stopping to listen). */
  talksOver: boolean;
  /** Speaking rate (words per second). */
  wps: number;
  /** Probability of a filler at the start of an utterance. */
  filler: number;
  /** Probability of a mid-sentence restart ("I would — no, wait, …"). */
  restart: number;
  /** Rating they tend to give (on a 1–7 scale; scaled for others). */
  rating: number;
}

export type Phrase =
  | 'ready'
  | 'howWent'
  | 'thinkStart'
  | 'thinkClick'
  | 'thinkNudge'
  | 'done'
  | 'skip'
  | 'clarify'
  | 'dontKnow'
  | 'rating'
  | 'yes'
  | 'no'
  | 'open'
  | 'confusing'
  | 'deflected'
  | 'ok'
  | 'interrupted'
  | 'remindSkip';

export interface Persona {
  id: string;
  name: string;
  language: 'en' | 'de';
  knobs: Knobs;
  fillers: string[];
  /** Phrase templates; `{x}` = clicked label / page, `{n}` = number. */
  say: Partial<Record<Phrase, string[]>>;
}

const EN: Record<Phrase, string[]> = {
  ready: ["Yes, I'm ready.", "Yep, let's begin.", 'Sure, ready when you are.'],
  howWent: ['It went okay, I think, it took me a moment to find it.', 'Pretty good, I think I found what I was looking for.', 'Fine, it was quite straightforward once I saw the menu.'],
  thinkStart: ["Okay, let me have a look. There's a menu at the top.", "So I'm looking at the home page now, there are a few categories.", 'Let me see what is on this page.'],
  thinkClick: ["I'll try {x}, that seems like the right place.", "Okay, {x} looks promising, I'm clicking that.", "Let's see what {x} does."],
  thinkNudge: ["I'm just looking at the page and trying to find the right section.", "I'm reading what is here and deciding where to click.", 'Right now I am scanning the options on this page.'],
  done: ["I think I'm done.", 'Okay, I found it. I think that is it.', "Okay, done, I've got it."],
  skip: ["I can't find it. I'd like to skip this one.", "I'll skip this one, I give up."],
  clarify: ['What does that mean?', 'Sorry, what do you mean by that?', 'Can you say that differently?'],
  dontKnow: ["I don't know.", "Hmm, I don't really know.", 'No idea, to be honest.'],
  rating: ["I'd say a {n}.", 'Maybe a {n}.', 'Hmm, {n}, I guess.'],
  yes: ['Yes, I think so.', 'Yeah, probably.'],
  no: ['No, not really.', "No, I don't think so."],
  open: ['It looked simple and the price was right, so it felt like a safe choice.', 'Mostly the layout, it was easy to see the categories at the top.', 'Nothing major, maybe the categories could be a bit clearer.'],
  confusing: ['Honestly the categories were a bit confusing at first, but then it was fine.', 'Not much, maybe the cart was a little hard to spot.'],
  deflected: ["Okay… I'm not sure what you mean.", 'Hmm. Okay.'],
  ok: ['Okay.', 'Alright.', 'Mm-hm.'],
  interrupted: ["Sorry, I wasn't finished — {x}", 'Wait, let me finish — {x}'],
  remindSkip: ["No, it's fine, I'll keep trying.", 'Okay, I will try a bit more.'],
};

const DE: Record<Phrase, string[]> = {
  ready: ['Ja, ich bin bereit.', 'Ja, wir können anfangen.'],
  howWent: ['Ganz gut, ich habe es ziemlich schnell gefunden.', 'Eigentlich ganz entspannt, ähm, war nicht schwer.'],
  thinkStart: ['Okay, mal gucken. Oben gibt es ein Menü.', 'Also, ich sehe die Startseite mit ein paar Kategorien.'],
  thinkClick: ['Ich probiere mal {x}, das klingt richtig.', 'Okay, {x}, da klicke ich mal drauf.'],
  thinkNudge: ['Ich schaue mir gerade die Seite an und suche den richtigen Bereich.', 'Ich lese gerade, was hier steht.'],
  done: ['Ich bin fertig.', 'Okay, ich glaube, ich bin fertig.'],
  skip: ['Ich finde es nicht, ich würde das gern überspringen.'],
  clarify: ['Wie meinen Sie das?', 'Was bedeutet das?'],
  dontKnow: ['Ich weiß es nicht.', 'Keine Ahnung, ehrlich gesagt.'],
  rating: ['Ich würde sagen, {n}.', 'Vielleicht eine {n}.'],
  yes: ['Ja, ich glaube schon.'],
  no: ['Nein, eher nicht.'],
  open: ['Sie sah schlicht aus und der Preis hat gepasst, also eine sichere Wahl.', 'Eigentlich nichts Großes, die Kategorien könnten etwas klarer sein.'],
  confusing: ['Am Anfang waren die Kategorien etwas verwirrend, dann ging es.'],
  deflected: ['Okay… ich weiß nicht genau, was Sie meinen.'],
  ok: ['Okay.', 'Alles klar.'],
  interrupted: ['Moment, ich war noch nicht fertig — {x}'],
  remindSkip: ['Nein, passt schon, ich versuche es weiter.'],
};

const base = (o: Partial<Knobs>): Knobs => ({
  pause: 0.3,
  clarify: 0.1,
  skip: 0.05,
  silence: 0.05,
  dontKnow: 0.05,
  done: 'mixed',
  answer: 'mixed',
  tempoSec: [6, 10],
  reactMs: [600, 1400],
  talksOver: false,
  wps: 2.6,
  filler: 0.3,
  restart: 0.05,
  rating: 6,
  ...o,
});

export const PERSONAS: Record<string, Persona> = {
  novice: {
    id: 'novice',
    name: 'Confused novice',
    language: 'en',
    knobs: base({ pause: 0.6, clarify: 0.5, skip: 0.1, done: 'voice', tempoSec: [7, 12], reactMs: [900, 2000], wps: 2.1, filler: 0.6, restart: 0.2, rating: 4 }),
    fillers: ['Um, ', 'Hmm, ', 'Let me see… '],
    say: { clarify: ['What does that mean?', 'Sorry, what do you mean by that?', 'What am I supposed to do?'], deflected: ["I don't understand what you mean.", 'Sorry, I still don’t get it.'] },
  },
  expert: {
    id: 'expert',
    name: 'Terse expert',
    language: 'en',
    knobs: base({ pause: 0.05, clarify: 0, skip: 0, silence: 0, dontKnow: 0, done: 'button', answer: 'screen', tempoSec: [3, 5], reactMs: [350, 800], wps: 3.2, filler: 0, restart: 0, rating: 6 }),
    fillers: [],
    say: { howWent: ['Fine.', 'Easy.'], thinkClick: ['{x}.', '{x}, there.'], thinkStart: ['Menu… categories.'], thinkNudge: ['Scanning.'], open: ['Cheap, simple.', 'Nothing.'], confusing: ['Nothing.'], rating: ['{n}.'], done: ['Done.'] },
  },
  chatty: {
    id: 'chatty',
    name: 'Chatty think-aloud',
    language: 'en',
    knobs: base({ pause: 0.9, clarify: 0.05, skip: 0, done: 'voice', answer: 'voice', tempoSec: [4, 7], reactMs: [400, 1000], talksOver: true, wps: 2.9, filler: 0.5, rating: 6 }),
    fillers: ['So, like, ', 'Oh, okay, ', 'Hmm, you know, '],
    say: {
      howWent: ['Oh, it went pretty well actually, I just went straight to the menu and then it was right there, which was nice.', 'Honestly it was quite easy, I mean, I had to look around a little bit at first, but once I saw the categories it made sense.'],
      open: ['I picked it because it felt simple and kind of tasteful, you know, like something most people would actually put on a shelf, and the price was well under fifty.'],
      confusing: ['Not a ton was confusing, honestly, the only little thing was that I had to click around a bit to figure out where the categories were, but once I found them it was fine.'],
    },
  },
  impatient: {
    id: 'impatient',
    name: 'Impatient, gets annoyed',
    language: 'en',
    knobs: base({ pause: 0.25, clarify: 0.2, skip: 0.4, done: 'mixed', tempoSec: [3, 6], reactMs: [250, 700], talksOver: true, wps: 3.0, filler: 0.1, rating: 3 }),
    fillers: ['Ugh, ', 'Okay, okay, '],
    say: { deflected: ["Why won't you just tell me?", 'That is not an answer.', 'Can we move on?'], clarify: ['What? What does that even mean?'], howWent: ['Fine. Slow, but fine.'], skip: ["This is taking too long, I'm skipping it."] },
  },
  nonnative: {
    id: 'nonnative',
    name: 'Non-native English speaker',
    language: 'en',
    knobs: base({ pause: 0.55, clarify: 0.35, dontKnow: 0.05, tempoSec: [6, 10], reactMs: [900, 1900], wps: 2.0, filler: 0.4, rating: 5 }),
    fillers: ['Hmm, ', 'How you say… '],
    say: {
      clarify: ['Sorry, can you say again more slowly?', 'Sorry, what do you mean? Can you say it simpler, please?'],
      howWent: ['It was not so much difficult, I am search the lamp and I find it.', 'Okay I think, I needed a moment for find the button.'],
      thinkClick: ['I am click on {x}, I think is there.'],
      open: ['Because it is small and not expensive, is good for gift.'],
      confusing: ['Not so much confusing. Maybe only the categories a little bit, because I needed to look around.'],
    },
  },
  idk: {
    id: 'idk',
    name: '"I don\'t know" + skipper',
    language: 'en',
    knobs: base({ pause: 0.15, clarify: 0.1, skip: 0.7, silence: 0.2, dontKnow: 0.75, done: 'mixed', answer: 'voice', tempoSec: [8, 14], reactMs: [1200, 2500], wps: 2.3, filler: 0.2, rating: 4 }),
    fillers: ['Uh, ', 'Meh, '],
    say: { skip: ["I'll skip this one.", 'Skip.'], howWent: ["I don't know. Fine?"] },
  },
  silent: {
    id: 'silent',
    name: 'Goes silent',
    language: 'en',
    knobs: base({ pause: 0.2, clarify: 0.05, silence: 0.6, done: 'button', answer: 'screen', tempoSec: [14, 22], reactMs: [1500, 3500], wps: 2.2, filler: 0.2, rating: 5 }),
    fillers: ['Um, '],
    say: { howWent: ['Fine, I guess.', 'Okay.'], open: ['It was cheap.'], confusing: ['Nothing really.'] },
  },
  german: {
    id: 'german',
    name: 'German speaker',
    language: 'de',
    knobs: base({ pause: 0.5, clarify: 0.15, tempoSec: [6, 10], reactMs: [700, 1500], wps: 2.4, filler: 0.4, rating: 6 }),
    fillers: ['Ähm, ', 'Also, ', 'Mal gucken… '],
    say: {},
  },
  replay: {
    id: 'replay',
    name: 'Replay of P-XKC5',
    language: 'en',
    knobs: base({ pause: 0.5, clarify: 0.1, skip: 0, silence: 0, dontKnow: 0.3, done: 'button', answer: 'screen', tempoSec: [6, 11], reactMs: [700, 1500], wps: 2.6, filler: 0.2, rating: 4 }),
    fillers: ['Hmm, '],
    say: {},
  },
};

export function phrases(p: Persona, k: Phrase): string[] {
  return p.say[k] ?? (p.language === 'de' ? DE[k] : EN[k]);
}
