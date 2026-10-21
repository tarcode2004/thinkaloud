// Host side of the probe ↔ wrapper bridge (see docs/API.md "Probe ↔ wrapper bridge").
// Validates event.source === iframe.contentWindow and data.source === 'thinkaloud-probe'.
import type { EventKind, HostToProbe, ProbeToHost } from '@thinkaloud/shared';

export interface ProbeEvent {
  kind: EventKind;
  at: number;
  data: Record<string, unknown>;
}

export interface ScrollState {
  scrollX: number;
  scrollY: number;
  vw: number;
  vh: number;
  docW: number;
  docH: number;
}

export interface ProbeHandlers {
  onHello?: (path: string, title: string) => void;
  onEvents?: (events: ProbeEvent[]) => void;
  onRrweb?: (events: unknown[]) => void;
  onHeartbeat?: (path: string) => void;
}

export class ProbeBridge {
  iframe: HTMLIFrameElement | null = null;
  connected = false;
  lastHeartbeat = 0;
  lastPath = '';
  scroll: ScrollState | null = null;
  private queries = new Map<string, (matched: boolean) => void>();
  private qid = 0;
  private handlers: ProbeHandlers;
  private configMsg: HostToProbe | null = null;

  constructor(handlers: ProbeHandlers) {
    this.handlers = handlers;
    window.addEventListener('message', this.onMessage);
  }

  attach(iframe: HTMLIFrameElement | null) {
    if (this.iframe === iframe) return;
    this.iframe = iframe;
    this.connected = false;
  }

  /** Config is (re)sent on every hello (each full page load inside the iframe). */
  setConfig(cfg: Omit<Extract<HostToProbe, { type: 'config' }>, 'source' | 'type'>) {
    this.configMsg = { source: 'thinkaloud-host', type: 'config', ...cfg };
    if (this.connected) this.post(this.configMsg);
  }

  private onMessage = (e: MessageEvent) => {
    if (!this.iframe || e.source !== this.iframe.contentWindow) return;
    const d = e.data as ProbeToHost;
    if (!d || typeof d !== 'object' || d.source !== 'thinkaloud-probe') return;
    switch (d.type) {
      case 'hello':
        this.connected = true;
        this.lastHeartbeat = Date.now();
        this.lastPath = d.path;
        if (this.configMsg) this.post(this.configMsg);
        this.handlers.onHello?.(d.path, d.title);
        break;
      case 'heartbeat':
        this.connected = true;
        this.lastHeartbeat = Date.now();
        if (d.path) this.lastPath = d.path;
        this.handlers.onHeartbeat?.(d.path);
        break;
      case 'events':
        this.lastHeartbeat = Date.now();
        if (Array.isArray(d.events)) this.handlers.onEvents?.(d.events);
        break;
      case 'rrweb':
        if (Array.isArray(d.events)) this.handlers.onRrweb?.(d.events);
        break;
      case 'dom_query_result': {
        const fn = this.queries.get(d.requestId);
        if (fn) {
          this.queries.delete(d.requestId);
          fn(Boolean(d.matched));
        }
        break;
      }
      case 'scroll_state':
        this.scroll = { scrollX: d.scrollX, scrollY: d.scrollY, vw: d.vw, vh: d.vh, docW: d.docW, docH: d.docH };
        break;
    }
  };

  post(msg: HostToProbe) {
    try {
      this.iframe?.contentWindow?.postMessage(msg, '*');
    } catch {
      /* ignore */
    }
  }

  navigate(path: string) {
    this.post({ source: 'thinkaloud-host', type: 'navigate', path });
  }

  pause() {
    this.post({ source: 'thinkaloud-host', type: 'pause' });
  }
  resume() {
    this.post({ source: 'thinkaloud-host', type: 'resume' });
  }

  /** Ask the probe whether a selector / text is currently visible. Resolves false on timeout. */
  query(q: { selector?: string; text?: string }, timeoutMs = 1200): Promise<boolean> {
    if (!this.connected) return Promise.resolve(false);
    const requestId = `q${++this.qid}`;
    return new Promise((resolve) => {
      const to = setTimeout(() => {
        this.queries.delete(requestId);
        resolve(false);
      }, timeoutMs);
      this.queries.set(requestId, (m) => {
        clearTimeout(to);
        resolve(m);
      });
      this.post({ source: 'thinkaloud-host', type: 'dom_query', requestId, ...q });
    });
  }

  dispose() {
    window.removeEventListener('message', this.onMessage);
    this.queries.clear();
  }
}
