// postMessage bridge to the ThinkAloud wrapper (window.parent).
import type { EventKind, HostToProbe, ProbeToHost } from '@thinkaloud/shared';
import { now } from './util.ts';

type Outgoing = ProbeToHost extends infer M ? (M extends { source: string } ? Omit<M, 'source'> : never) : never;
export type ProbeEvent = { kind: EventKind; at: number; data: Record<string, unknown> };

export const embedded = (() => {
  try {
    return window.parent && window.parent !== window;
  } catch {
    return false;
  }
})();

export function post(msg: Outgoing) {
  if (!embedded) return;
  try {
    window.parent.postMessage({ source: 'thinkaloud-probe', ...msg }, '*');
  } catch {
    /* data not cloneable, or parent gone */
  }
}

let queue: ProbeEvent[] = [];
export const state = { paused: false };

export function emit(kind: EventKind, data: Record<string, unknown>, at = now()) {
  if (state.paused || !embedded) return;
  queue.push({ kind, at, data });
  if (queue.length > 500) flush();
}

export function flush() {
  if (!queue.length) return;
  const events = queue;
  queue = [];
  post({ type: 'events', events });
}

export function onHostMessage(handler: (msg: HostToProbe) => void) {
  window.addEventListener('message', (e: MessageEvent) => {
    try {
      if (e.source !== window.parent) return;
      const d = e.data as HostToProbe | undefined;
      if (!d || typeof d !== 'object' || d.source !== 'thinkaloud-host') return;
      handler(d);
    } catch {
      /* never throw into the app */
    }
  });
}
