// ThinkAloud probe — injected as the first <script> of every hosted app page
// (or installed via the snippet on external sites). Talks to the wrapper via
// window.parent.postMessage; a no-op when the page is not framed.
// Contract: docs/API.md "Probe ↔ wrapper bridge", ProbeToHost/HostToProbe in shared types.
import type { HostToProbe } from '@thinkaloud/shared';
import { embedded, emit, flush, onHostMessage, post, state } from './bridge.ts';
import { checkBlank, flushPoints, installCapture, scrollState, setMouseSampleMs } from './capture.ts';
import { resnapshot, startRecording, stopRecording, flushRrweb } from './recorder.ts';
import { collapse, currentPath, now, safe, sanitize } from './util.ts';

const VERSION = '0.1.0';

declare global {
  interface Window {
    __THINKALOUD_PROBE__?: string;
    ThinkAloud?: { version?: string; track: (name: string, data?: unknown) => void; q?: [string, unknown][] };
  }
}

function isVisible(el: Element): boolean {
  const he = el as HTMLElement;
  if (!he.getClientRects().length) return false;
  const cs = getComputedStyle(he);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

function domQuery(selector?: string, text?: string): boolean {
  const needle = text ? norm(text) : '';
  if (selector) {
    let els: Element[] = [];
    try {
      els = Array.from(document.querySelectorAll(selector));
    } catch {
      return false; // invalid selector
    }
    return els.some((el) => isVisible(el) && (!needle || norm((el as HTMLElement).innerText || el.textContent || '').includes(needle)));
  }
  if (needle) return norm(document.body?.innerText || '').includes(needle);
  return false;
}

function hostNavigate(path: string) {
  let url: URL;
  try {
    url = new URL(path, window.location.href);
  } catch {
    return;
  }
  if (url.origin !== window.location.origin) {
    window.location.assign(url.href);
    return;
  }
  const target = url.pathname + url.search + url.hash;
  if (target === currentPath()) return;
  // Hash-router apps (#/route): navigate within the hash.
  if (window.location.hash.startsWith('#/') && !path.startsWith('#') && !url.hash) {
    window.location.hash = '#' + url.pathname + url.search;
    return;
  }
  // Next.js (app + pages router) exposes its router: a synthetic popstate would make the app
  // router restore the *old* tree (history.state.__NA) or reload, so use router.push instead.
  const nextRouter = (window as unknown as { next?: { router?: { push?: (href: string) => unknown } } }).next?.router;
  if (typeof nextRouter?.push === 'function') {
    nextRouter.push(target);
    return;
  }
  const st = history.state as { __NA?: boolean } | null;
  if (st && st.__NA) {
    window.location.assign(target); // Next app router without a reachable router instance
    return;
  }
  history.pushState(history.state, '', target);
  window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
}

function handleHost(msg: HostToProbe) {
  switch (msg.type) {
    case 'config':
      setMouseSampleMs(msg.mouseSampleMs);
      if (msg.recordScreen) startRecording(msg.maskAllInputs);
      else stopRecording();
      post({ type: 'scroll_state', ...scrollState() });
      break;
    case 'navigate':
      hostNavigate(msg.path);
      break;
    case 'dom_query':
      post({ type: 'dom_query_result', requestId: msg.requestId, matched: safe(domQuery)(msg.selector, msg.text) ?? false });
      break;
    case 'pause':
      flushAll();
      state.paused = true;
      break;
    case 'resume':
      if (state.paused) {
        state.paused = false;
        resnapshot();
      }
      break;
  }
}

function flushAll() {
  flushPoints();
  flush();
  flushRrweb();
}

function installTrackApi() {
  const prev = window.ThinkAloud;
  const queued = Array.isArray(prev?.q) ? prev!.q! : [];
  const track = (name: string, data?: unknown) => {
    try {
      emit('app.custom', { name: collapse(String(name), 120), data: sanitize(data), path: currentPath() });
    } catch {
      /* ignore */
    }
  };
  window.ThinkAloud = { version: VERSION, track };
  for (const [n, d] of queued) track(n, d);
}

/**
 * Hosted by the ThinkAloud app host (tag has data-ta-hosted): disable service workers. A worker
 * registered by one build keeps serving its cached files after a rebuild on the same origin, and
 * can bypass the injected probe. register() returns a promise that never settles (no error noise).
 */
function disableServiceWorkers() {
  const sw = navigator.serviceWorker;
  if (!sw) return;
  try {
    sw.getRegistrations?.().then((regs) => regs.forEach((r) => r.unregister()), () => {});
    const never = new Promise<ServiceWorkerRegistration>(() => {});
    Object.defineProperty(sw, 'register', { configurable: true, value: () => never });
  } catch {
    /* ignore */
  }
}

/**
 * Hosted + framed: the study wrapper is often a different site, where Lax/unspecified cookies set
 * from JS are silently dropped. Rewrite them to SameSite=None; Secure; Partitioned (CHIPS) so apps
 * that keep state in document.cookie still work inside the frame. Secure contexts only.
 */
function partitionDocumentCookies() {
  if (!window.isSecureContext) return;
  const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
  if (!desc?.get || !desc.set) return;
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get() {
      return desc.get!.call(document);
    },
    set(v: string) {
      let c = String(v);
      try {
        if (!(/;\s*samesite\s*=\s*none/i.test(c) && /;\s*partitioned/i.test(c))) {
          c = c.replace(/;\s*samesite\s*=\s*\w+/gi, '') + '; SameSite=None';
          if (!/;\s*secure(\s*;|\s*$)/i.test(c)) c += '; Secure';
          if (!/;\s*partitioned/i.test(c)) c += '; Partitioned';
        }
      } catch {
        c = String(v);
      }
      desc.set!.call(document, c);
    },
  });
}

function init() {
  if (window.__THINKALOUD_PROBE__) return; // injected twice (e.g. host injection + snippet)
  window.__THINKALOUD_PROBE__ = VERSION;
  const hosted = (document.currentScript as HTMLScriptElement | null)?.hasAttribute('data-ta-hosted');
  if (hosted) safe(disableServiceWorkers)();
  if (hosted && embedded) safe(partitionDocumentCookies)();
  installTrackApi();
  if (!embedded) return; // top-level window: nothing to talk to

  onHostMessage(safe(handleHost));
  installCapture();

  const sayHello = safe(() => post({ type: 'hello', version: VERSION, path: currentPath(), title: collapse(document.title, 200) }));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sayHello, { once: true });
  else sayHello();

  window.addEventListener(
    'load',
    safe(() => {
      const nav = performance.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined;
      emit('app.ready', { path: currentPath(), title: collapse(document.title, 200), loadMs: nav ? Math.round(nav.loadEventStart || nav.domContentLoadedEventEnd) : undefined });
      post({ type: 'scroll_state', ...scrollState() });
    }),
    { once: true },
  );

  setInterval(
    safe(() => {
      flushPoints();
      flush();
    }),
    500,
  );
  setInterval(
    safe(() => {
      post({ type: 'heartbeat', at: now(), path: currentPath() });
      checkBlank();
    }),
    1000,
  );
  window.addEventListener('pagehide', safe(flushAll));
}

try {
  init();
} catch {
  /* never break the host app */
}
