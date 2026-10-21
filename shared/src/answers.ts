// record_answer validation (participant runner), shared so it can be unit-tested.
import type { Question } from './types.ts';
import { isDontKnow } from './turns.ts';

export interface ParsedAnswer {
  text?: string;
  value?: number;
  choices?: string[];
  /** "I don't know" / "not sure" / "I didn't see that" — valid for every kind of question. */
  declined?: boolean;
}

/** Validate a value against the question kind (no "I don't know" handling). */
export function validateAnswerValue(q: Question, a: { text?: unknown; value?: unknown; choices?: unknown }): ParsedAnswer | { error: string } {
  const text = typeof a.text === 'string' && a.text.trim() ? a.text.trim().slice(0, 4000) : undefined;
  let value = typeof a.value === 'number' && isFinite(a.value) ? a.value : typeof a.value === 'string' && a.value.trim() !== '' && isFinite(Number(a.value)) ? Number(a.value) : undefined;
  let choices = Array.isArray(a.choices) ? a.choices.map(String) : undefined;
  switch (q.kind) {
    case 'rating': {
      const sc = q.scale ?? { min: 1, max: 5 };
      if (value == null) return { error: 'A numeric value from the scale is required.' };
      if (value < sc.min || value > sc.max) return { error: `Value must be between ${sc.min} and ${sc.max}.` };
      const st = sc.step ?? 1;
      value = Math.round((value - sc.min) / st) * st + sc.min;
      return { value, text };
    }
    case 'number':
      if (value == null) return { error: 'A number is required.' };
      return { value, text };
    case 'yes_no': {
      if (value == null && choices?.length) value = /^y|^ja|^oui|^s[ií]|^evet/i.test(choices[0]) ? 1 : 0;
      if (value == null && text) value = /^(yes|yeah|yep|ja|oui|sí|si|evet)\b/i.test(text) ? 1 : /^(no|nope|nein|non|hayır)\b/i.test(text) ? 0 : undefined;
      if (value !== 0 && value !== 1) return { error: 'value must be 1 (yes) or 0 (no).' };
      return { value, choices: [value ? 'Yes' : 'No'], text };
    }
    case 'single_choice':
    case 'multi_choice': {
      const opts = q.options ?? [];
      if (!choices?.length && value != null && opts[value]) choices = [opts[value]];
      if (!choices?.length) return { error: `choices is required. Options: ${opts.join(' | ')}` };
      const mapped = choices.map((c) => opts.find((o) => o.toLowerCase().trim() === c.toLowerCase().trim()) ?? opts.find((o) => o.toLowerCase().includes(c.toLowerCase().trim())));
      if (mapped.some((m) => !m)) return { error: `Choices must be exact option labels: ${opts.join(' | ')}` };
      if (q.kind === 'single_choice' && mapped.length > 1) return { error: 'Only one choice allowed.' };
      return { choices: mapped as string[], value: opts.indexOf(mapped[0]!), text };
    }
    default:
      if (!text) return { error: 'text is required for open questions (the participant’s answer in their own words).' };
      return { text };
  }
}

/**
 * Parse a record_answer call. "I don't know" (declined: true, or recognisable text without a value)
 * is accepted for every kind of question; once a question has been asked twice, anything the
 * participant said is kept as a declined answer instead of an error (never a third reading).
 */
export function parseRecordAnswer(
  q: Question,
  args: { text?: unknown; value?: unknown; choices?: unknown; declined?: unknown },
  opts: { timesAsked?: number; prev?: ParsedAnswer } = {},
): ParsedAnswer | { error: string } {
  const rawText = typeof args.text === 'string' ? args.text.trim().slice(0, 4000) : '';
  const noAnswerGiven = args.value == null && !(Array.isArray(args.choices) && args.choices.length);
  // (An open answer that merely contains "I don't know how…" is still an answer: only short ones count.)
  const shortEnough = q.kind !== 'open' || rawText.split(/\s+/).length <= 10;
  if (args.declined === true || (noAnswerGiven && shortEnough && isDontKnow(rawText))) return { text: rawText || "I don't know", declined: true };
  // Follow-up enrichment keeps the earlier value/choices when only text is added.
  const parsed = validateAnswerValue(q, { text: args.text, value: args.value ?? opts.prev?.value, choices: args.choices ?? opts.prev?.choices });
  if ('error' in parsed && (opts.timesAsked ?? 0) >= 2 && rawText) return { text: rawText, declined: true };
  return parsed;
}
