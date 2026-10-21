// One ordered event queue for the whole session. Every event gets a monotonic `seq`,
// `t` = ms since session begin (performance.now offset) and the active `stepId`.
// Flushed every 2s and on pagehide (sendBeacon). Server is idempotent on (sessionId, seq).
import type { EventKind, SessionEvent } from '@thinkaloud/shared';
import { pApi, type SessionAuth } from './api.ts';

export class EventQueue {
  private seq = 0;
  private pending: SessionEvent[] = [];
  private inflight: SessionEvent[] | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private perfAtBegin: number | null = null;
  private wallAtBegin: number | null = null;
  stepId: string | null = null;
  private auth: SessionAuth;
  private onPageHide = () => this.flushBeacon();
  /** For tests / debugging. */
  readonly log: SessionEvent[] = [];
  private listeners = new Set<(e: SessionEvent) => void>();

  constructor(auth: SessionAuth) {
    this.auth = auth;
    this.timer = setInterval(() => void this.flush(), 2000);
    window.addEventListener('pagehide', this.onPageHide);
    document.addEventListener('visibilitychange', this.onVis);
  }

  private onVis = () => {
    if (document.visibilityState === 'hidden') this.flushBeacon();
  };

  /** Mark session start (t = 0). Events pushed before begin get t = 0. */
  begin(wallClock = Date.now()) {
    this.perfAtBegin = performance.now();
    this.wallAtBegin = wallClock;
  }

  get begun() {
    return this.perfAtBegin != null;
  }

  /** Session clock now (ms since begin). */
  now(): number {
    return this.perfAtBegin == null ? 0 : Math.max(0, Math.round(performance.now() - this.perfAtBegin));
  }

  /** Convert a wall-clock time (e.g. from the probe) into session clock. */
  fromWall(at: number): number {
    if (this.wallAtBegin == null || this.perfAtBegin == null) return 0;
    // Use performance clock for "now" and correct by wall delta, robust to clock skew within the page.
    const delta = Date.now() - at;
    return Math.max(0, this.now() - delta);
  }

  subscribe(fn: (e: SessionEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  push<D extends Record<string, unknown>>(kind: EventKind, data: D, opts: { at?: number; t?: number; stepId?: string | null } = {}): SessionEvent<D> {
    const at = opts.at ?? Date.now();
    const ev: SessionEvent<D> = {
      seq: ++this.seq,
      kind,
      t: opts.t ?? (opts.at != null ? this.fromWall(opts.at) : this.now()),
      at,
      stepId: opts.stepId !== undefined ? opts.stepId : this.stepId,
      data,
    };
    this.pending.push(ev as SessionEvent);
    if (kind !== 'mouse' && kind !== 'gaze') {
      this.log.push(ev as SessionEvent);
      if (this.log.length > 2000) this.log.splice(0, 500);
    }
    for (const l of this.listeners) l(ev as SessionEvent);
    return ev;
  }

  async flush(): Promise<void> {
    if (this.inflight || !this.pending.length) return;
    const batch = this.pending.splice(0, 500);
    this.inflight = batch;
    try {
      await pApi.events(this.auth, batch);
    } catch {
      // Put back in front, retry on next tick (server dedupes on seq).
      this.pending.unshift(...batch);
    } finally {
      this.inflight = null;
    }
  }

  /** Flush everything right now (used before complete/withdraw). */
  async drain(): Promise<void> {
    for (let i = 0; i < 20 && (this.pending.length || this.inflight); i++) {
      if (this.inflight) await new Promise((r) => setTimeout(r, 100));
      else await this.flush();
    }
  }

  flushBeacon() {
    const all = [...(this.inflight ?? []), ...this.pending];
    if (!all.length) return;
    // sendBeacon payloads are limited (~64KB) – chunk.
    let chunk: SessionEvent[] = [];
    let size = 0;
    const send = () => {
      if (chunk.length) pApi.beaconEvents(this.auth, chunk);
      chunk = [];
      size = 0;
    };
    for (const e of all) {
      const s = JSON.stringify(e).length;
      if (size + s > 55_000) send();
      chunk.push(e);
      size += s;
    }
    send();
    // Keep them pending as well: if the page survives (visibilitychange), normal flush re-sends idempotently.
  }

  /** Drop everything (withdrawal). */
  discard() {
    this.pending = [];
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    window.removeEventListener('pagehide', this.onPageHide);
    document.removeEventListener('visibilitychange', this.onVis);
  }
}

/** Ordered rrweb chunk uploader (seq per chunk). */
export class RrwebUploader {
  private seq = 0;
  private buf: unknown[] = [];
  private timer: ReturnType<typeof setInterval>;
  private busy = false;
  constructor(private auth: SessionAuth) {
    this.timer = setInterval(() => void this.flush(), 4000);
  }
  add(events: unknown[]) {
    this.buf.push(...events);
    if (this.buf.length > 400) void this.flush();
  }
  async flush() {
    if (this.busy || !this.buf.length) return;
    this.busy = true;
    const events = this.buf.splice(0, this.buf.length);
    const seq = ++this.seq;
    try {
      await pApi.rrweb(this.auth, seq, events);
    } catch {
      // retry once later with the same seq
      try {
        await new Promise((r) => setTimeout(r, 1500));
        await pApi.rrweb(this.auth, seq, events);
      } catch {
        /* give up on this chunk */
      }
    } finally {
      this.busy = false;
    }
  }
  dispose() {
    clearInterval(this.timer);
  }
}
