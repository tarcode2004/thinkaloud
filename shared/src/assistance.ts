// Task assistance ladder (general prompts → direct cue) and the 2/1/0 completion score.
import type { AssistanceSummary, CompletionScore, TaskAssistance, TaskOutcome } from './types.ts';

export const ASSIST_FIRST_AFTER_SEC = 60;
export const ASSIST_GAP_SEC = 30;
/** No click, input or navigation for this long (and not talking) counts as stuck. */
export const ASSIST_STUCK_MS = 15_000;

/**
 * 2 = completed independently; 1 = completed (or partly) after general prompts only;
 * 0 = a direct cue was given, or the task was abandoned, timed out or failed.
 * A partial outcome without any help also scores 1: it is neither independent completion nor failure.
 */
export function completionScore(outcome: TaskOutcome, a: AssistanceSummary = { general: 0, direct: 0 }): CompletionScore {
  if (a.direct > 0) return 0;
  if (outcome === 'success') return a.general > 0 ? 1 : 2;
  if (outcome === 'partial') return 1;
  return 0;
}

export interface AssistState {
  /** Task time so far. */
  elapsedMs: number;
  /** Time since the last click / input / navigation / speech (whichever is latest). */
  idleMs: number;
  generalGiven: number;
  directGiven: boolean;
  /** Task time of the last assistance prompt, or null. */
  lastAssistMs: number | null;
  /** The participant explicitly asked for help or sounded hopeless (moderator tool). */
  helpRequested?: boolean;
}

export interface AssistAction {
  level: 'general' | 'direct';
  /** generalPrompts index for 'general'. */
  index: number;
  text: string;
}

/** Which assistance prompt is due now, if any. Pure: the runner supplies the clock and activity. */
export function nextAssistance(a: TaskAssistance | undefined, s: AssistState): AssistAction | null {
  if (!a || s.directGiven) return null;
  const prompts = a.generalPrompts.map((p) => p.trim()).filter(Boolean);
  const first = (a.firstAfterSec ?? ASSIST_FIRST_AFTER_SEC) * 1000;
  const gap = (a.gapSec ?? ASSIST_GAP_SEC) * 1000;
  if (s.elapsedMs < first) return null; // before that, even a plea for help gets a neutral deflection
  const stuck = s.idleMs >= ASSIST_STUCK_MS;
  const sinceLast = s.lastAssistMs == null ? Infinity : s.elapsedMs - s.lastAssistMs;
  if (!s.helpRequested && (!stuck || sinceLast < gap)) return null;
  if (s.generalGiven < prompts.length) return { level: 'general', index: s.generalGiven, text: prompts[s.generalGiven] };
  const cue = a.directCue?.trim();
  return cue ? { level: 'direct', index: -1, text: cue } : null;
}
