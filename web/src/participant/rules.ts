// Deterministic task success rules (evaluated client-side) + behaviour helpers.
import type { ElementDescriptor, SuccessRule } from '@thinkaloud/shared';

export function urlMatches(pattern: string, path: string): boolean {
  try {
    return new RegExp(pattern).test(path);
  } catch {
    // Invalid regex → treat as plain substring.
    return path.includes(pattern);
  }
}

/** Parse a simple compound selector "tag#id.cls1.cls2[attr]" into parts. */
function parseSimple(sel: string) {
  const s = sel.trim().split(/\s+|>/).filter(Boolean).pop() ?? '';
  const tag = /^[a-z][a-z0-9-]*/i.exec(s)?.[0]?.toLowerCase();
  const id = /#([\w-]+)/.exec(s)?.[1];
  const classes = [...s.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
  const attrs = [...s.matchAll(/\[([\w-]+)(?:[~^$*|]?=["']?([^"'\]]*)["']?)?\]/g)].map((m) => ({ name: m[1], value: m[2] }));
  return { tag, id, classes, attrs };
}

/**
 * Best-effort match of a CSS selector against the element descriptor reported by the probe
 * (we cannot run querySelector across origins). Exact string match, then token match on the
 * last compound selector (tag, #id, .classes, [aria-label]/[href]/[role]).
 */
export function selectorMatches(selector: string, el: ElementDescriptor): boolean {
  if (!selector) return true;
  const want = selector.trim();
  if (el.selector === want || el.selector?.endsWith(want)) return true;
  const w = parseSimple(want);
  const h = parseSimple(el.selector || el.tag);
  if (w.tag && w.tag !== (el.tag || h.tag || '').toLowerCase()) return false;
  if (w.id && w.id !== h.id) return false;
  if (w.classes.some((c) => !h.classes.includes(c))) return false;
  for (const a of w.attrs) {
    const v = a.name === 'aria-label' ? el.ariaLabel : a.name === 'href' ? el.href : a.name === 'role' ? el.role : undefined;
    if (v == null) return false;
    if (a.value != null && a.value !== '' && !v.includes(a.value)) return false;
  }
  return Boolean(w.tag || w.id || w.classes.length || w.attrs.length);
}

export function textMatches(want: string, have: string | undefined): boolean {
  if (!want) return true;
  if (!have) return false;
  return norm(have).includes(norm(want));
}

export function norm(s: string) {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function clickRuleMatches(rule: Extract<SuccessRule, { type: 'click_matches' }>, el: ElementDescriptor): boolean {
  if (!rule.selector && !rule.text) return false;
  return (!rule.selector || selectorMatches(rule.selector, el)) && (!rule.text || textMatches(rule.text, el.text || el.ariaLabel));
}

/** Does this participant utterance look like it is addressed to the moderator (during quiet phases)? */
export function addressedToModerator(text: string): boolean {
  const t = norm(text);
  if (!t) return false;
  if (t.includes('?')) return true;
  return /\b(i('| a)?m done|i am done|i'?m finished|i think i('| a)?m done|done now|that'?s it|finished|i give up|give up|skip|next task|can you (help|repeat)|repeat (the|that)|what (was|is) the task|i don'?t know (what|how) to|i can'?t find|is (this|that) (right|correct)|am i (done|right)|should i|what should|where (do|should|can) i|how do i|hello\??|are you there|stop)\b/.test(
    t,
  );
}

/** Rough similarity: is `said` (moderator transcript) a reading of `prompt`? (`threshold`: share of the prompt's words heard) */
export function isReadingOf(said: string, prompt: string, threshold = 0.6): boolean {
  const a = norm(said).replace(/[^\p{L}\p{N} ]/gu, '');
  const b = norm(prompt).replace(/[^\p{L}\p{N} ]/gu, '');
  if (!b) return false;
  const words = b.split(' ').filter((w) => w.length > 3);
  if (!words.length) return a.includes(b);
  const hit = words.filter((w) => a.includes(w)).length;
  return hit / words.length >= threshold;
}

export function describeElement(el: ElementDescriptor | undefined): string {
  if (!el) return 'an element';
  const label = (el.text || el.ariaLabel || '').trim().slice(0, 60);
  const kind = el.role || (el.tag === 'a' ? 'link' : el.tag === 'button' ? 'button' : el.tag || 'element');
  return label ? `${kind} "${label}"` : kind;
}
