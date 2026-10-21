// Element descriptors: short robust selector, visible text, interactive detection.
import type { ElementDescriptor } from '@thinkaloud/shared';
import { collapse } from './util.ts';

const INTERACTIVE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'SUMMARY', 'OPTION', 'DETAILS']);
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'option', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'treeitem', 'gridcell',
]);
const TEST_ATTRS = ['data-testid', 'data-test', 'data-cy', 'data-qa', 'data-test-id'];

function isAppRoot(el: Element): boolean {
  if (el.parentElement === document.body || el === document.body || el === document.documentElement) return true;
  try {
    return Object.keys(el).some((k) => k.startsWith('__reactContainer'));
  } catch {
    return false;
  }
}

/** Does this element itself look interactive (semantics / handlers / pointer cursor)? */
export function isInteractiveSelf(el: Element): boolean {
  if (INTERACTIVE_TAGS.has(el.tagName)) {
    if (el.tagName === 'A') return (el as HTMLAnchorElement).hasAttribute('href') || el.hasAttribute('role');
    return !(el as HTMLButtonElement).disabled;
  }
  const role = el.getAttribute('role');
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  if (el.hasAttribute('onclick') || el.hasAttribute('contenteditable')) return true;
  const ti = el.getAttribute('tabindex');
  if (ti !== null && ti !== '-1') return true;
  // React sets a no-op `onclick` property on elements with onClick (Safari delegation fix)
  // — a good signal, except on the app root container where it is always present.
  if ((el as HTMLElement).onclick && !isAppRoot(el)) return true;
  return false;
}

function hasPointerCursor(el: Element): boolean {
  try {
    return getComputedStyle(el).cursor === 'pointer';
  } catch {
    return false;
  }
}

/**
 * The element the participant most plausibly meant to click: the nearest
 * interactive ancestor (≤6 levels), else the raw target.
 */
export function resolveTarget(target: Element): { el: Element; interactive: boolean } {
  let cur: Element | null = target;
  for (let i = 0; cur && i < 7 && cur !== document.body; i++, cur = cur.parentElement) {
    if (isInteractiveSelf(cur)) return { el: cur, interactive: true };
  }
  // No semantic signal: a pointer cursor is the best hint of a JS click handler (React etc.).
  cur = target;
  for (let i = 0; cur && i < 4 && cur !== document.body; i++, cur = cur.parentElement) {
    if (!isAppRoot(cur) && hasPointerCursor(cur)) return { el: cur, interactive: true };
  }
  return { el: target, interactive: false };
}

function cssEscape(s: string): string {
  try {
    return CSS.escape(s);
  } catch {
    return s.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }
}

/** Ids / classes that look machine-generated are useless as selectors. */
const looksGenerated = (s: string) =>
  /[:]|^\d|\d{4,}|^(css|sc|jsx|emotion|svelte)-|^_[a-z0-9]{5,}|[A-Za-z0-9]{6,}_[A-Za-z0-9]{5}$/.test(s) || s.length > 40;

function segment(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id;
  if (id && !looksGenerated(id)) return `${tag}#${cssEscape(id)}`;
  let seg = tag;
  const classes = Array.from(el.classList).filter((c) => !looksGenerated(c)).slice(0, 2);
  if (classes.length) seg += classes.map((c) => '.' + cssEscape(c)).join('');
  const parent = el.parentElement;
  if (parent) {
    const same = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
    if (same.length > 1) seg += `:nth-of-type(${same.indexOf(el) + 1})`;
  }
  return seg;
}

export function selectorFor(el: Element): string {
  for (const a of TEST_ATTRS) {
    const v = el.getAttribute(a);
    if (v) return `[${a}="${v.replace(/"/g, '\\"')}"]`;
  }
  const tag = el.tagName.toLowerCase();
  if (el.id && !looksGenerated(el.id)) return `${tag}#${cssEscape(el.id)}`;
  const name = el.getAttribute('name');
  if (name && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(el.tagName)) return `${tag}[name="${name.replace(/"/g, '\\"')}"]`;
  const parts: string[] = [];
  let cur: Element | null = el;
  for (let depth = 0; cur && depth < 4 && cur !== document.documentElement; depth++) {
    const seg = segment(cur);
    parts.unshift(seg);
    if (seg.includes('#') || cur === document.body) break;
    cur = cur.parentElement;
  }
  return parts.join(' > ');
}

const FIELD_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

function labelFor(el: Element): string {
  const he = el as HTMLInputElement;
  const aria = el.getAttribute('aria-label');
  if (aria) return aria;
  try {
    if (he.labels && he.labels[0]) return he.labels[0].textContent || '';
  } catch {
    /* ignore */
  }
  return he.placeholder || el.getAttribute('name') || '';
}

/** Visible-ish text without ever reading form field values. */
export function textOf(el: Element): string {
  if (FIELD_TAGS.has(el.tagName)) {
    const type = ((el as HTMLInputElement).type || '').toLowerCase();
    if (el.tagName === 'INPUT' && (type === 'submit' || type === 'button' || type === 'reset')) {
      return collapse((el as HTMLInputElement).value);
    }
    return collapse(labelFor(el));
  }
  if (el.tagName === 'IMG') return collapse(el.getAttribute('alt'));
  let t = '';
  try {
    t = (el as HTMLElement).innerText ?? el.textContent ?? '';
  } catch {
    t = el.textContent || '';
  }
  if (!t.trim()) t = el.getAttribute('aria-label') || el.getAttribute('title') || '';
  return collapse(t);
}

export function describe(el: Element, interactive?: boolean): ElementDescriptor {
  const d: ElementDescriptor = {
    selector: selectorFor(el),
    tag: el.tagName.toLowerCase(),
    interactive: interactive ?? isInteractiveSelf(el),
  };
  const text = textOf(el);
  if (text) d.text = text;
  const role = el.getAttribute('role');
  if (role) d.role = role;
  const aria = el.getAttribute('aria-label');
  if (aria) d.ariaLabel = collapse(aria);
  const href = el.getAttribute('href');
  if (href && el.tagName === 'A') d.href = href.split('?')[0].slice(0, 300);
  return d;
}

/** Fields whose content we never report anything about. */
export function isSensitiveField(el: Element): boolean {
  if (!FIELD_TAGS.has(el.tagName)) return false;
  const i = el as HTMLInputElement;
  const type = (i.type || '').toLowerCase();
  if (type === 'password' || type === 'email' || type === 'tel') return true;
  const hay = `${i.name || ''} ${i.id || ''} ${i.autocomplete || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
  return /pass|email|e-mail|cc-|card|cvv|cvc|csc|iban|ssn|social.?security|one-time-code|otp|pin\b|secret/.test(hay);
}
