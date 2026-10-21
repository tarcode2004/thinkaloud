// ─────────────────────────────────────────────────────────────────────────────
// Turn-taking heuristics shared by the participant runner (and unit-tested on the
// server). They are deliberately conservative: when unsure, they say "complete" /
// "not noise", and the realtime model's own judgement takes over.
// ─────────────────────────────────────────────────────────────────────────────

const words = (text: string) => text.trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));

/** Words that leave a sentence hanging when they come last ("and", "but", "the", "um"). */
const TRAILING =
  /\b(and|but|or|so|because|cause|the|a|an|to|of|with|for|that|which|if|then|um+|uh+|er+|erm|like|i|it's|is|was|und|aber|oder|weil|der|die|das|ein|eine|et|mais|ou|parce|le|la|les|un|une|y|pero|porque|el|ve|ama|çünkü|bir)$/i;

/**
 * Does this transcript look like the participant is still mid-sentence?
 * A short fragment (fewer than 4 words) without terminal punctuation, a trailing dash/ellipsis,
 * or a dangling conjunction/article means they are probably still talking.
 */
export function isUnfinishedUtterance(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/(\.\.\.|…|--|—|–|-)\s*$/.test(t)) return true;
  const terminal = /[.!?。！？؟]["'”’)\]]*\s*$/.test(t);
  const n = words(t).length;
  if (n < 4 && !terminal) return true;
  const last = t.replace(/[^\p{L}\p{N}' ]+$/u, '').trim().split(/\s+/).pop() ?? '';
  return !terminal && TRAILING.test(last);
}

/** "I don't know" / "not sure" / "I didn't see it" in common session languages. */
const DONT_KNOW =
  /(?<![\p{L}\p{N}])((do\s*n[o']?t|don'?t|doesn'?t|does\s*not)\s*(really\s*)?know|dunno|no idea|not sure|i'?m not sure|no clue|can'?t say|i (did\s*n[o']?t|never) (see|notice|get to see)|i can'?t tell|hard to say|weiß (ich )?nicht|keine ahnung|nicht sicher|je ne sais pas|aucune idée|pas sûr|no (lo )?sé|ni idea|no estoy segur|non (lo )?so|bilmiyorum|emin değilim|fikrim yok|weet (ik )?niet|geen idee|nie wiem|não sei|не знаю)(?![\p{L}\p{N}])/iu;

export function isDontKnow(text: string | undefined): boolean {
  return Boolean(text && DONT_KNOW.test(text));
}

/** A compact list of very common English words (to recognise real English fragments). */
const EN_COMMON = new Set(
  (
    'a about after again all also am an and any are as at back be because been but by can could did do does done dont down even ' +
    'find for from get go going good got had has have he her here hmm how i if im in into is it its just know let lets like look ' +
    'looks maybe me more my no not now of oh ok okay on one or out page post posts pretty really right says see seems should so ' +
    'some that thats the their them then there these they thing think this to too try uh um up us very wait want was we well ' +
    'went what when where which who why will with would yeah yes yep you your nice cool great fine sure next skip stop help ' +
    'click button where hm huh interesting'
  ).split(' '),
);

/** Characters from scripts other than Latin (Cyrillic, Greek, CJK, Arabic, Hebrew, Devanagari, Thai, Hangul…). */
const NON_LATIN = /[Ͱ-ϿЀ-ӿ֐-׿؀-ۿऀ-ॿ฀-๿぀-ヿ㐀-鿿가-힯]/;
/** Latin letters with diacritics (rare in English speech transcripts). */
const DIACRITIC = /[À-ÖØ-öø-ɏ]/;
const LATIN_LANGS = new Set(['en', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'tr', 'pl', 'sv', 'da', 'no', 'fi', 'cs', 'ro', 'hu']);

export interface NoiseCheck {
  text: string;
  /** Session language (ISO code, e.g. "en"). */
  language?: string;
  /** Mean token log-probability of the transcription, if known (0 = certain, -1 = very unsure). */
  avgLogprob?: number | null;
}

/**
 * Very short, low-confidence or wrong-language fragments are background noise / mis-transcriptions
 * ("Tja, wol zančanic.", "Wortfrieden-Text.") — never answers. Longer utterances are always kept.
 */
export function isLikelyNoise({ text, language, avgLogprob }: NoiseCheck): boolean {
  const t = text.trim();
  const w = words(t);
  if (!w.length) return true;
  if (w.length > 4) return false;
  const lang = (language || 'en').toLowerCase().split(/[-_]/)[0];
  if (avgLogprob != null && Number.isFinite(avgLogprob) && avgLogprob < -1.0) return true;
  if (LATIN_LANGS.has(lang) && NON_LATIN.test(t)) return true;
  if (lang === 'en') {
    const clean = w.map((x) => x.toLowerCase().replace(/[^a-z']/g, '').replace(/'/g, ''));
    const known = clean.filter((x) => EN_COMMON.has(x)).length;
    if (DIACRITIC.test(t) && known < w.length) return true;
    // A hyphenated capitalised compound with no common English word ("Wortfrieden-Text").
    if (/\p{Lu}\p{Ll}{5,}-\p{Lu}/u.test(t) && known === 0) return true;
  }
  return false;
}

/** Mean log-probability of a transcription's tokens (realtime `logprobs`), or null. */
export function meanLogprob(logprobs: unknown): number | null {
  if (!Array.isArray(logprobs) || !logprobs.length) return null;
  const vals = logprobs.map((l) => (l && typeof l === 'object' ? Number((l as { logprob?: unknown }).logprob) : NaN)).filter((v) => Number.isFinite(v));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// ── "I'm done" answer window ─────────────────────────────────────────────────

/** After their last words, the participant must have been quiet this long before a task is wrapped up. */
export const WRAP_QUIET_MS = 2000;
/** …or this long when their last words were a fragment (they are probably still talking). */
export const WRAP_FRAGMENT_QUIET_MS = 6000;
/** No answer at all to "How do you feel that went?" → move on after this much silence. */
export const WRAP_SILENCE_MS = 10_000;
/** Hard cap on an answer window. */
export const WRAP_MAX_MS = 75_000;

export interface WrapUpInput {
  /** Why the window is open: the Done button, a spoken "I'm done", a delivered tell/explain answer, or the model's own set_task_outcome. */
  source: 'button' | 'verbal' | 'delivered' | 'model';
  /** Meaningful (non-noise) participant utterances in the window. */
  heard: string[];
  /** The last utterance was typed (deliberate, complete). */
  typed: boolean;
  /** Times (ms, same clock as `now`). */
  now: number;
  listenFrom: number;
  lastHeardAt: number;
  /** Last participant speech start/stop. */
  lastUserSpeech: number;
  userSpeaking: boolean;
  /** A speech segment ended but its transcript has not arrived yet. */
  transcriptPending: boolean;
}

export type WrapUpDecision = { ready: false } | { ready: true; answered: boolean; ack: string };

/**
 * Has the participant finished answering? Ready when they have been quiet ~2 s after a complete
 * answer, ~6 s after a fragment ("The interfaces", "cod", "But--"), or ~10 s when they said nothing
 * at all (then the moderator moves on with "Okay, let's continue." instead of "Thanks.").
 */
export function wrapUpDecision(i: WrapUpInput): WrapUpDecision {
  if (i.userSpeaking) return { ready: false };
  if (i.transcriptPending && i.now - i.lastUserSpeech < 4000) return { ready: false }; // their words are still being transcribed
  const lastVoice = Math.max(i.lastUserSpeech, i.lastHeardAt, i.listenFrom);
  const capped = i.now - i.listenFrom > WRAP_MAX_MS;
  let ready: boolean;
  if (!i.heard.length) ready = i.now - lastVoice >= WRAP_SILENCE_MS;
  else {
    const last = i.heard[i.heard.length - 1];
    const need = i.typed ? 1200 : isUnfinishedUtterance(last) ? WRAP_FRAGMENT_QUIET_MS : WRAP_QUIET_MS;
    ready = i.now - lastVoice >= need;
  }
  if (!ready && !capped) return { ready: false };
  const all = i.heard.join(' ').trim();
  const answered = Boolean(all) && (i.source === 'delivered' || i.source === 'model' || i.heard.some((h) => !isUnfinishedUtterance(h)) || all.split(/\s+/).length >= 4);
  return { ready: true, answered, ack: answered ? 'Thanks.' : "Okay, let's continue." };
}
