// Behavioural capture: navigation, clicks (dead/rage), fields, scroll, focus,
// errors, console errors, network errors, visibility, mouse samples.
import { emit, post, state } from './bridge.ts';
import { describe, isSensitiveField, resolveTarget } from './describe.ts';
import { collapse, currentPath, now, safe, stripQuery, throttle } from './util.ts';

const on = (target: EventTarget, type: string, fn: (e: any) => void, opts: AddEventListenerOptions = { capture: true, passive: true }) =>
  target.addEventListener(type, safe(fn), opts);

// ── DOM / URL change tracking (dead-click detection) ────────────────────────
let mutationCount = 0;
let urlChangeCount = 0;

function observeMutations() {
  try {
    const mo = new MutationObserver((records) => {
      mutationCount += records.length;
    });
    mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  } catch {
    /* ignore */
  }
}

// ── Navigation ──────────────────────────────────────────────────────────────
let lastPath = '';

function navigated(kind: 'load' | 'push' | 'replace' | 'pop' | 'hash') {
  const path = currentPath();
  if (kind !== 'load' && path === lastPath) return;
  const from = lastPath || undefined;
  if (kind === 'pop' && from && from.split('#')[0] === path.split('#')[0]) kind = 'hash';
  lastPath = path;
  urlChangeCount++;
  const at = now();
  // Apps usually update document.title just after the route renders: read it a little later.
  const send = safe(() => emit('app.navigate', { path, from, title: collapse(document.title, 200), kind }, at));
  if (kind === 'load') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', send, { once: true });
    else send();
  } else setTimeout(send, 300);
}

function patchHistory() {
  for (const method of ['pushState', 'replaceState'] as const) {
    const orig = history[method];
    if (typeof orig !== 'function') continue;
    history[method] = function (this: History, ...args: Parameters<History['pushState']>) {
      const r = orig.apply(this, args);
      safe(navigated)(method === 'pushState' ? 'push' : 'replace');
      return r;
    } as History['pushState'];
  }
  on(window, 'popstate', () => navigated('pop'));
  on(window, 'hashchange', () => navigated('hash'));
}

// ── Clicks ──────────────────────────────────────────────────────────────────
const RAGE_WINDOW = 700;
const RAGE_RADIUS = 30;
let recentClicks: { x: number; y: number; at: number }[] = [];
let rageReported = false;

function clickHandler(e: MouseEvent) {
  if (state.paused) return;
  const target = e.target instanceof Element ? e.target : (e.target as Node | null)?.parentElement;
  if (!target) return;
  const { el, interactive } = resolveTarget(target);
  const desc = describe(el, interactive);
  const data = {
    x: Math.round(e.clientX),
    y: Math.round(e.clientY),
    pageX: Math.round(e.clientX + window.scrollX),
    pageY: Math.round(e.clientY + window.scrollY),
    vw: window.innerWidth,
    vh: window.innerHeight,
    path: currentPath(),
    el: desc,
  };
  emit('app.click', data);

  // Rage clicks: ≥3 clicks within 700ms within 30px.
  const t = now();
  recentClicks = recentClicks.filter((c) => t - c.at <= RAGE_WINDOW);
  const first = recentClicks[0];
  if (first && Math.hypot(first.x - data.x, first.y - data.y) > RAGE_RADIUS) {
    recentClicks = [];
    rageReported = false;
  }
  if (!recentClicks.length) rageReported = false;
  recentClicks.push({ x: data.x, y: data.y, at: t });
  if (recentClicks.length >= 3 && !rageReported) {
    rageReported = true;
    emit('app.rage_click', { ...data, count: recentClicks.length });
  }

  // Dead clicks: non-interactive target and nothing happens within ~500ms.
  if (!interactive && !isSelectingText()) {
    const m0 = mutationCount;
    const u0 = urlChangeCount;
    setTimeout(
      safe(() => {
        if (mutationCount === m0 && urlChangeCount === u0) emit('app.dead_click', data);
      }),
      500,
    );
  }
}

function isSelectingText(): boolean {
  try {
    const s = window.getSelection();
    return !!s && !s.isCollapsed && s.toString().length > 0;
  } catch {
    return false;
  }
}

// ── Fields (never values) ───────────────────────────────────────────────────
const FIELD_RE = /^(INPUT|TEXTAREA|SELECT)$/;
const pendingInput = new WeakMap<Element, ReturnType<typeof setTimeout>>();

function fieldData(el: Element) {
  const i = el as HTMLInputElement;
  const isChoice = el.tagName === 'SELECT' || i.type === 'checkbox' || i.type === 'radio';
  const len = isChoice ? undefined : typeof i.value === 'string' ? i.value.length : undefined;
  return { el: describe(el, true), fieldType: el.tagName === 'INPUT' ? (i.type || 'text').toLowerCase() : el.tagName.toLowerCase(), length: len, path: currentPath() };
}

function fieldTarget(e: Event): Element | null {
  const t = (e.composedPath?.()[0] ?? e.target) as Element | null;
  if (!t || !(t instanceof Element)) return null;
  if (FIELD_RE.test(t.tagName)) return t;
  if ((t as HTMLElement).isContentEditable) return t;
  return null;
}

function inputHandler(e: Event) {
  const el = fieldTarget(e);
  if (!el || isSensitiveField(el)) return;
  // One event per field per burst of typing (trailing 1s debounce), so we get final length.
  const prev = pendingInput.get(el);
  if (prev) clearTimeout(prev);
  pendingInput.set(
    el,
    setTimeout(
      safe(() => {
        pendingInput.delete(el);
        const d = fieldData(el);
        if ((el as HTMLElement).isContentEditable && !FIELD_RE.test(el.tagName)) d.length = (el.textContent || '').length;
        emit('app.input', d);
      }),
      1000,
    ),
  );
}

function changeHandler(e: Event) {
  const el = fieldTarget(e);
  if (!el || isSensitiveField(el)) return;
  emit('app.change', fieldData(el));
}

let lastFocused: Element | null = null;
function focusHandler(e: FocusEvent) {
  const t = e.target;
  if (!(t instanceof Element) || t === lastFocused) return;
  lastFocused = t;
  emit('app.focus', { el: describe(t), path: currentPath() });
}

// ── Scroll ──────────────────────────────────────────────────────────────────
function scrollState() {
  const de = document.documentElement;
  return {
    scrollX: Math.round(window.scrollX),
    scrollY: Math.round(window.scrollY),
    vw: window.innerWidth,
    vh: window.innerHeight,
    docW: Math.max(de.scrollWidth, document.body?.scrollWidth || 0),
    docH: Math.max(de.scrollHeight, document.body?.scrollHeight || 0),
  };
}

const sendScrollState = throttle(safe(() => post({ type: 'scroll_state', ...scrollState() })), 150);
const emitWindowScroll = throttle(
  safe(() => {
    const s = scrollState();
    emit('app.scroll', { ...s, path: currentPath(), depth: s.docH ? Math.min(1, (s.scrollY + s.vh) / s.docH) : 1 });
  }),
  1000,
);
const elementScrolls = new WeakMap<Element, () => void>();

function scrollHandler(e: Event) {
  const t = e.target;
  if (t === document || t === window || t === document.documentElement || t === document.body) {
    sendScrollState();
    emitWindowScroll();
    return;
  }
  if (!(t instanceof Element)) return;
  let fn = elementScrolls.get(t);
  if (!fn) {
    fn = throttle(
      safe(() => emit('app.scroll', { el: describe(t), scrollX: Math.round(t.scrollLeft), scrollY: Math.round(t.scrollTop), path: currentPath() })),
      1000,
    );
    elementScrolls.set(t, fn);
  }
  fn();
}

// ── Errors ──────────────────────────────────────────────────────────────────
let errorCount = 0;
const errorBudget = () => ++errorCount <= 200; // never flood the host

function errorHandler(e: ErrorEvent | Event) {
  if (!errorBudget()) return;
  const target = e.target as Element | null;
  if (target && target !== (window as unknown) && target instanceof Element) {
    // Resource failed to load (<img>, <script>, <link>).
    const src = target.getAttribute('src') || target.getAttribute('href') || '';
    emit('app.network_error', { kind: 'resource', tag: target.tagName.toLowerCase(), url: stripQuery(src), status: 0, path: currentPath() });
    return;
  }
  const ee = e as ErrorEvent;
  emit('app.error', {
    message: collapse(ee.message || String(ee.error || 'Error'), 500),
    stack: ee.error?.stack ? String(ee.error.stack).slice(0, 2000) : undefined,
    source: ee.filename ? stripQuery(ee.filename) : undefined,
    line: ee.lineno,
    col: ee.colno,
    path: currentPath(),
  });
}

function rejectionHandler(e: PromiseRejectionEvent) {
  if (!errorBudget()) return;
  const r = e.reason;
  emit('app.error', {
    message: collapse('Unhandled promise rejection: ' + (r?.message ?? String(r)), 500),
    stack: r?.stack ? String(r.stack).slice(0, 2000) : undefined,
    path: currentPath(),
  });
}

function stringifyArg(a: unknown): string {
  if (a instanceof Error) return a.message;
  if (typeof a === 'string') return a;
  try {
    return JSON.stringify(a) ?? String(a);
  } catch {
    return String(a);
  }
}

function patchConsole() {
  const orig = console.error;
  if (typeof orig !== 'function') return;
  let inside = false;
  console.error = function (...args: unknown[]) {
    if (!inside) {
      inside = true;
      try {
        if (errorBudget()) {
          const err = args.find((a) => a instanceof Error) as Error | undefined;
          emit('app.console_error', {
            message: collapse(args.map(stringifyArg).join(' '), 500),
            stack: err?.stack ? String(err.stack).slice(0, 2000) : undefined,
            path: currentPath(),
          });
        }
      } catch {
        /* ignore */
      }
      inside = false;
    }
    return orig.apply(this, args);
  };
}

function reportNetwork(method: string, url: string, status: number, message?: string, durationMs?: number) {
  if (!errorBudget()) return;
  emit('app.network_error', { kind: 'request', method: method.toUpperCase(), url: stripQuery(url), status, message, durationMs, path: currentPath() });
}

function patchFetch() {
  const orig = window.fetch;
  if (typeof orig !== 'function') return;
  window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    const start = now();
    let method = 'GET';
    let url = '';
    try {
      method = init?.method || (input instanceof Request ? input.method : 'GET');
      url = input instanceof Request ? input.url : String(input);
    } catch {
      /* ignore */
    }
    const p = orig.call(this ?? window, input, init);
    try {
      p.then(
        (res) => {
          if (res.status >= 400) safe(reportNetwork)(method, url, res.status, res.statusText, now() - start);
        },
        (err) => {
          if (err?.name !== 'AbortError') safe(reportNetwork)(method, url, 0, collapse(err?.message || 'Network failure', 200), now() - start);
        },
      );
    } catch {
      /* ignore */
    }
    return p;
  } as typeof window.fetch;
}

function patchXhr() {
  const proto = XMLHttpRequest.prototype;
  const open = proto.open;
  const send = proto.send;
  const meta = new WeakMap<XMLHttpRequest, { method: string; url: string; start: number; aborted?: boolean }>();
  proto.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    try {
      meta.set(this, { method, url: String(url), start: 0 });
    } catch {
      /* ignore */
    }
    return (open as (...a: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof proto.open;
  proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    try {
      const m = meta.get(this);
      if (m) {
        m.start = now();
        this.addEventListener('abort', () => (m.aborted = true));
        this.addEventListener(
          'loadend',
          safe(() => {
            if (m.aborted) return;
            if (this.status >= 400 || this.status === 0) reportNetwork(m.method, m.url, this.status, this.status === 0 ? 'Network failure' : this.statusText, now() - m.start);
          }),
        );
      }
    } catch {
      /* ignore */
    }
    return send.call(this, body);
  };
}

// ── Mouse sampling ──────────────────────────────────────────────────────────
let mouseX = -1;
let mouseY = -1;
let mouseMoved = false;
let points: [number, number, number][] = [];
let sampler: ReturnType<typeof setInterval> | undefined;

export function setMouseSampleMs(ms: number) {
  if (sampler) clearInterval(sampler);
  const every = Math.max(16, Number(ms) || 50);
  sampler = setInterval(
    safe(() => {
      if (!mouseMoved || state.paused) return;
      mouseMoved = false;
      // NOTE: first tuple item is wall clock (Date.now()); the host converts it to session time.
      points.push([now(), mouseX, mouseY]);
    }),
    every,
  );
}

export function flushPoints() {
  if (!points.length) return;
  const batch = points;
  points = [];
  emit('mouse', { points: batch, vw: window.innerWidth, vh: window.innerHeight, path: currentPath(), scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY) });
}

// ── Install ─────────────────────────────────────────────────────────────────
export function installCapture() {
  patchHistory();
  patchConsole();
  patchFetch();
  safe(patchXhr)();
  observeMutations();
  on(document, 'click', clickHandler);
  on(document, 'input', inputHandler);
  on(document, 'change', changeHandler);
  on(document, 'focusin', focusHandler);
  on(document, 'scroll', scrollHandler);
  on(window, 'error', errorHandler, { capture: true });
  on(window, 'unhandledrejection', rejectionHandler);
  on(document, 'visibilitychange', () => emit('app.visibility', { state: document.visibilityState, path: currentPath() }));
  on(document, 'mousemove', (e: MouseEvent) => {
    mouseX = Math.round(e.clientX);
    mouseY = Math.round(e.clientY);
    mouseMoved = true;
  });
  on(window, 'resize', () => sendScrollState());
  setMouseSampleMs(50);
  navigated('load');
}

export { scrollState };
