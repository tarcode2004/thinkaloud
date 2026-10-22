// Offline mock of the OpenAI Realtime layer — zero network, zero cost.
//
// Browser side (init script): replaces RTCPeerConnection with a fake whose "oai-events" data channel
// is bridged to Node (page.exposeBinding / page.evaluate); the remote audio track is a local
// oscillator that hums while the mock moderator "speaks". Playwright routes fulfil the ephemeral
// token request and the SDP exchange and abort anything else that would reach api.openai.com.
//
// Node side (MockRealtime): speaks the real server-event protocol on realistic timings —
// session.updated, input_audio_buffer.speech_started/stopped (+committed), input_audio_transcription
// delta/completed (ASR lag), response.created/output_item/audio transcript deltas/done,
// output_audio_buffer.started/stopped/cleared, function_call_arguments.done, response.done, errors —
// and emulates semantic VAD turn-taking (a pause longer than the hold commits the turn and, when
// create_response is on, starts a response; speech during moderator audio interrupts it).
// What the moderator says/does is decided by the deterministic ScriptedModerator.
import type { BrowserContext, Page } from '@playwright/test';
import { ScriptedModerator, type ModeratorOutput } from '../moderatorScript.ts';

export interface MockStats {
  responses: number;
  oob: number;
  toolCalls: number;
  interruptions: number;
  blockedRequests: string[];
}

/** In-page fake WebRTC (top frame only). */
export const FAKE_RTC = () => {
  if (window.top !== window) return;
  const w = window as unknown as Record<string, any>;
  let actx: AudioContext | null = null;
  let osc: OscillatorNode | null = null;
  let gain: GainNode | null = null;
  let remote: MediaStream | null = null;
  const remoteStream = () => {
    if (remote) return remote;
    actx = new AudioContext();
    const dest = actx.createMediaStreamDestination();
    osc = actx.createOscillator();
    gain = actx.createGain();
    gain.gain.value = 0;
    osc.frequency.value = 180;
    osc.connect(gain).connect(dest);
    osc.start();
    remote = dest.stream;
    return remote;
  };
  w.__mockRtVoice = (on: boolean) => {
    if (gain && actx) gain.gain.setTargetAtTime(on ? 0.05 : 0, actx.currentTime, 0.02);
  };
  class FakeDC extends EventTarget {
    label: string;
    readyState: RTCDataChannelState = 'connecting';
    onopen: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onclose: ((e: Event) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    constructor(label: string) {
      super();
      this.label = label;
    }
    send(data: string) {
      if (this.readyState !== 'open') throw new Error('data channel not open');
      void w.__mockRtUp(data);
    }
    close() {
      if (this.readyState === 'closed') return;
      this.readyState = 'closed';
      this.onclose?.(new Event('close'));
    }
    _open() {
      this.readyState = 'open';
      this.onopen?.(new Event('open'));
    }
    _deliver(data: string) {
      if (this.readyState === 'open') this.onmessage?.(new MessageEvent('message', { data }));
    }
  }
  class FakePC extends EventTarget {
    connectionState: RTCPeerConnectionState = 'new';
    iceConnectionState = 'new';
    signalingState = 'stable';
    ontrack: ((e: RTCTrackEvent) => void) | null = null;
    onconnectionstatechange: ((e: Event) => void) | null = null;
    private dc: FakeDC | null = null;
    private senders: { track: MediaStreamTrack | null }[] = [];
    createDataChannel(label: string) {
      this.dc = new FakeDC(label);
      w.__mockRtDc = this.dc;
      return this.dc as unknown as RTCDataChannel;
    }
    addTrack(track: MediaStreamTrack) {
      const s = { track };
      this.senders.push(s);
      return s as unknown as RTCRtpSender;
    }
    addTransceiver() {
      return {} as RTCRtpTransceiver;
    }
    getSenders() {
      return this.senders as unknown as RTCRtpSender[];
    }
    async createOffer() {
      return { type: 'offer', sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=thinkaloud-harness-mock\r\n' } as RTCSessionDescriptionInit;
    }
    async setLocalDescription() {}
    async setRemoteDescription() {
      this.connectionState = 'connected';
      this.onconnectionstatechange?.(new Event('connectionstatechange'));
      const stream = remoteStream();
      setTimeout(() => {
        this.ontrack?.({ streams: [stream], track: stream.getAudioTracks()[0] } as unknown as RTCTrackEvent);
        void w.__mockRtUp(JSON.stringify({ type: '__mock.connect' }));
        setTimeout(() => this.dc?._open(), 30);
      }, 40);
    }
    close() {
      this.connectionState = 'closed';
      this.dc?.close();
    }
  }
  w.RTCPeerConnection = FakePC;
  w.webkitRTCPeerConnection = FakePC;
  w.__mockRtDown = (batch: string[]) => {
    for (const d of batch) (w.__mockRtDc as FakeDC | undefined)?._deliver(d);
  };
};

type Ev = Record<string, unknown> & { type: string };
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
let idSeq = 0;
const nid = (p: string) => `${p}_mock${(++idSeq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export interface MockOptions {
  /** Semantic-VAD hold: silence (ms) after which a turn that sounds complete is committed. */
  vadHoldMs?: number;
  /** Hold for a turn that sounds unfinished ("The interface…", trailing "and"). */
  vadHoldUnfinishedMs?: number;
  /** ASR latency after speech_stopped (ms). */
  asrLagMs?: [number, number];
  /** Moderator speaking rate (seconds per word). */
  secPerWord?: number;
  rand?: () => number;
  log?: (s: string) => void;
}

interface SpeechSeg {
  itemId: string;
  texts: string[];
  speaking: boolean;
  commitTimer: ReturnType<typeof setTimeout> | null;
  startedAt: number;
}

export class MockRealtime {
  readonly stats: MockStats = { responses: 0, oob: 0, toolCalls: 0, interruptions: 0, blockedRequests: [] };
  readonly moderator: ScriptedModerator;
  private page!: Page;
  private out: string[] = [];
  private flushing = false;
  private createResponse = true;
  private interruptResponse = true;
  private active: { id: string; itemId: string; text: string; audio: boolean; done: boolean; audioOn: boolean; timers: ReturnType<typeof setTimeout>[]; oob: boolean } | null = null;
  private seg: SpeechSeg | null = null;
  private pendingAuto = false;
  private o: Required<Omit<MockOptions, 'log'>> & { log?: (s: string) => void };
  /** Wall-clock windows of moderator audio (for the participant engine). */
  moderatorAudio = false;
  moderatorAudioSince = 0;
  lastModeratorAudioEnd = 0;

  constructor(opts: MockOptions & { language: string }) {
    const given = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined));
    this.o = { vadHoldMs: 650, vadHoldUnfinishedMs: 1500, asrLagMs: [350, 900], secPerWord: 0.36, rand: Math.random, ...given } as typeof this.o;
    this.moderator = new ScriptedModerator({ language: opts.language, rand: this.o.rand });
  }

  async attach(context: BrowserContext, page: Page) {
    this.page = page;
    await context.addInitScript(FAKE_RTC);
    await page.exposeBinding('__mockRtUp', (_src, data: string) => {
      try {
        this.onClient(JSON.parse(data) as Ev);
      } catch (e) {
        this.o.log?.(`[mock] bad client event: ${(e as Error).message}`);
      }
    });
    // Ephemeral token (the server, keyless, would answer 503) and SDP exchange are served locally.
    await page.route('**/api/p/sessions/*/realtime-token', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ value: 'ek_harness_mock', expiresAt: Date.now() + 600_000, model: 'mock-realtime', voice: 'marin', transcription: { model: 'mock-asr', language: this.moderator.language } }) }),
    );
    await page.route('https://api.openai.com/**', (r) => {
      const u = r.request().url();
      if (u.startsWith('https://api.openai.com/v1/realtime/calls')) return r.fulfill({ status: 201, contentType: 'application/sdp', body: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=mock-answer\r\n' });
      this.stats.blockedRequests.push(u);
      return r.abort('blockedbyclient');
    });
  }

  // ── transport ──────────────────────────────────────────────────────────────
  private send(ev: Ev) {
    if (!ev.event_id) ev.event_id = nid('event');
    this.out.push(JSON.stringify(ev));
    void this.flush();
  }
  private async flush() {
    if (this.flushing || this.page.isClosed()) return;
    this.flushing = true;
    try {
      while (this.out.length) {
        const batch = this.out.splice(0);
        await this.page.evaluate((b) => (window as unknown as { __mockRtDown?: (b: string[]) => void }).__mockRtDown?.(b), batch).catch(() => {});
      }
    } finally {
      this.flushing = false;
    }
  }
  private voice(on: boolean) {
    void this.page.evaluate((v) => (window as unknown as { __mockRtVoice?: (v: boolean) => void }).__mockRtVoice?.(v), on).catch(() => {});
  }
  private after(ms: number, fn: () => void, bag?: ReturnType<typeof setTimeout>[]) {
    const t = setTimeout(fn, Math.max(0, ms));
    bag?.push(t);
    return t;
  }

  // ── client → server ────────────────────────────────────────────────────────
  private onClient(ev: Ev) {
    switch (ev.type) {
      case '__mock.connect':
        this.moderator.onConnect();
        this.active = null;
        this.send({ type: 'session.created', session: { id: nid('sess'), model: 'mock-realtime' } });
        return;
      case 'session.update': {
        const s = (ev.session ?? {}) as Record<string, any>;
        if (typeof s.instructions === 'string') this.moderator.setInstructions(s.instructions);
        if (Array.isArray(s.tools)) this.moderator.setTools(s.tools);
        const td = s.audio?.input?.turn_detection ?? s.turn_detection;
        if (td && typeof td === 'object') {
          if (typeof td.create_response === 'boolean') this.createResponse = td.create_response;
          if (typeof td.interrupt_response === 'boolean') this.interruptResponse = td.interrupt_response;
        }
        this.send({ type: 'session.updated', session: { type: 'realtime' } });
        return;
      }
      case 'conversation.item.create': {
        const item = (ev.item ?? {}) as Record<string, any>;
        const id = item.id ?? nid('item');
        if (item.type === 'function_call_output') this.moderator.addToolOutput(String(item.call_id), String(item.output ?? ''));
        else if (item.type === 'message') {
          const text = (item.content ?? []).map((c: any) => c.text ?? '').join('');
          if (item.role === 'system') this.moderator.addSystem(text, id);
          else if (item.role === 'user') this.moderator.addUser(text, id);
        }
        this.send({ type: 'conversation.item.added', item: { id, type: item.type } });
        return;
      }
      case 'conversation.item.delete':
        this.moderator.deleteItem(String(ev.item_id ?? ''));
        this.send({ type: 'conversation.item.deleted', item_id: ev.item_id });
        return;
      case 'conversation.item.truncate':
        this.moderator.truncated(String(ev.item_id ?? ''), Number(ev.audio_end_ms ?? 0));
        return;
      case 'response.create':
        this.onCreate(ev);
        return;
      case 'response.cancel':
        this.cancel(false);
        return;
      case 'output_audio_buffer.clear':
        this.clearAudio();
        return;
      default:
        return;
    }
  }

  private onCreate(ev: Ev) {
    const r = (ev.response ?? {}) as Record<string, any>;
    const oob = r.conversation === 'none';
    if (this.active && !this.active.done && !oob) {
      this.send({ type: 'error', error: { type: 'invalid_request_error', code: 'conversation_already_has_active_response', message: 'Conversation already has an active response in progress.', event_id: ev.event_id } });
      return;
    }
    if (oob) {
      this.stats.oob++;
      const id = nid('resp');
      const text = this.moderator.classify(String(r.instructions ?? ''));
      const meta = r.metadata ?? null;
      this.after(80, () => this.send({ type: 'response.created', response: { id, status: 'in_progress', metadata: meta, conversation_id: null } }));
      this.after(250 + this.o.rand() * 400, () => {
        this.send({ type: 'response.output_text.delta', response_id: id, item_id: nid('item'), delta: text });
        this.send({ type: 'response.done', response: { id, status: 'completed', metadata: meta, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] } });
      });
      return;
    }
    const out = this.moderator.respond({ instructions: typeof r.instructions === 'string' ? r.instructions : undefined, toolChoice: r.tool_choice, textOnly: Array.isArray(r.output_modalities) && !r.output_modalities.includes('audio') });
    this.run(out);
  }

  /** Execute one moderator response (speech or tool call) with realistic event timing. */
  private run(out: ModeratorOutput) {
    this.stats.responses++;
    const id = nid('resp');
    const itemId = nid('item');
    const resp = { id, itemId, text: out.kind === 'speech' ? out.text : '', audio: out.kind === 'speech' && !out.textOnly, done: false, audioOn: false, timers: [] as ReturnType<typeof setTimeout>[], oob: false };
    this.active = resp;
    const T = resp.timers;
    this.after(90 + this.o.rand() * 120, () => this.send({ type: 'response.created', response: { id, status: 'in_progress', output: [] } }), T);
    if (out.kind === 'none') {
      this.after(300, () => this.finishResponse(resp, 'completed', []), T);
      return;
    }
    if (out.kind === 'tool') {
      this.stats.toolCalls++;
      const callId = nid('call');
      const args = JSON.stringify(out.args);
      const item = { id: itemId, type: 'function_call', call_id: callId, name: out.name, arguments: args, status: 'completed' };
      this.after(350 + this.o.rand() * 450, () => {
        this.send({ type: 'response.output_item.added', response_id: id, item: { ...item, arguments: '' } });
        this.send({ type: 'response.function_call_arguments.done', response_id: id, item_id: itemId, call_id: callId, name: out.name, arguments: args });
        this.send({ type: 'response.output_item.done', response_id: id, item });
        this.finishResponse(resp, 'completed', [item]);
      }, T);
      return;
    }
    // Speech: transcript is generated faster than real time; playback takes words × secPerWord.
    const text = out.text;
    const durMs = Math.max(900, words(text) * this.o.secPerWord * 1000);
    const first = 420 + this.o.rand() * 380;
    this.moderator.noteSpoken(text, itemId);
    this.after(first - 120, () => this.send({ type: 'response.output_item.added', response_id: id, item: { id: itemId, type: 'message', role: 'assistant', phase: 'final_answer', content: [] } }), T);
    const parts = text.split(/(?<=\s)/);
    const genMs = Math.min(1400, 200 + parts.length * 45);
    parts.forEach((p, i) => this.after(first + (genMs * i) / parts.length, () => this.send({ type: out.textOnly ? 'response.output_text.delta' : 'response.output_audio_transcript.delta', response_id: id, item_id: itemId, delta: p }), T));
    if (!out.textOnly) {
      this.after(first, () => {
        resp.audioOn = true;
        this.moderatorAudio = true;
        this.moderatorAudioSince = Date.now();
        this.voice(true);
        this.send({ type: 'output_audio_buffer.started', response_id: id });
      }, T);
      this.after(first + durMs, () => this.endAudio(resp, false), T);
    }
    this.after(first + genMs + 60, () => {
      this.send({ type: out.textOnly ? 'response.output_text.done' : 'response.output_audio_transcript.done', response_id: id, item_id: itemId, ...(out.textOnly ? { text } : { transcript: text }) });
      const item = { id: itemId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: out.textOnly ? 'output_text' : 'output_audio', transcript: text }] };
      this.send({ type: 'response.output_item.done', response_id: id, item });
      this.finishResponse(resp, 'completed', [item]);
    }, T);
  }

  private finishResponse(resp: NonNullable<MockRealtime['active']>, status: string, output: unknown[]) {
    if (resp.done) return;
    resp.done = true;
    this.send({ type: 'response.done', response: { id: resp.id, status, output } });
    if (this.active === resp && !resp.audioOn) this.active = null;
    if (this.pendingAuto) {
      this.pendingAuto = false;
      this.after(150, () => this.autoRespond());
    }
  }

  private endAudio(resp: NonNullable<MockRealtime['active']>, cleared: boolean) {
    if (!resp.audioOn) return;
    resp.audioOn = false;
    this.moderatorAudio = false;
    this.lastModeratorAudioEnd = Date.now();
    this.voice(false);
    this.send({ type: cleared ? 'output_audio_buffer.cleared' : 'output_audio_buffer.stopped', response_id: resp.id });
    if (this.active === resp && resp.done) this.active = null;
  }

  private cancel(byServer: boolean) {
    const a = this.active;
    if (!a) {
      if (!byServer) this.send({ type: 'error', error: { type: 'invalid_request_error', code: 'response_cancel_not_active', message: 'Cancellation failed: no active response found' } });
      return;
    }
    if (!a.done) {
      for (const t of a.timers) clearTimeout(t);
      // Audio already buffered keeps playing until output_audio_buffer.clear (or a VAD interruption).
      if (a.audioOn) a.timers.push(setTimeout(() => this.endAudio(a, false), 1200));
      if (a.text) this.send({ type: 'response.output_audio_transcript.done', response_id: a.id, item_id: a.itemId, transcript: a.text.split(/\s+/).slice(0, Math.max(1, Math.ceil(words(a.text) / 3))).join(' ') });
      this.finishResponse(a, 'cancelled', []);
    }
  }

  private clearAudio() {
    const a = this.active;
    if (a?.audioOn) this.endAudio(a, true);
  }

  // ── participant audio (driven by the persona engine) ───────────────────────
  /** Participant starts a speech chunk (they are heard ~250 ms later). */
  userSpeechStart() {
    const startNew = !this.seg;
    if (this.seg?.commitTimer) {
      // Resumed within the VAD hold: the same turn continues.
      clearTimeout(this.seg.commitTimer);
      this.seg.commitTimer = null;
    }
    if (startNew) this.seg = { itemId: nid('item'), texts: [], speaking: true, commitTimer: null, startedAt: Date.now() };
    this.seg!.speaking = true;
    const seg = this.seg!;
    this.after(250, () => {
      if (this.seg !== seg) return;
      if (startNew) this.send({ type: 'input_audio_buffer.speech_started', audio_start_ms: Date.now() - seg.startedAt, item_id: seg.itemId });
      // Barge-in: speech while the moderator is audible interrupts it.
      const a = this.active;
      if (this.interruptResponse && a && (a.audioOn || !a.done) && !a.oob) {
        this.stats.interruptions++;
        this.moderator.interrupted();
        if (!a.done) this.cancel(true);
        if (a.audioOn) this.endAudio(a, true);
      }
    });
  }

  /** Participant finished a speech chunk with this (ASR-style) text; `continuing` = prosody says more is coming. */
  userSpeechEnd(asrText: string, continuing = false) {
    const seg = this.seg;
    if (!seg) return;
    seg.texts.push(asrText);
    seg.speaking = false;
    const so_far = seg.texts.join(' ');
    const hold = continuing || this.moderator.soundsUnfinished(so_far) ? this.o.vadHoldUnfinishedMs : this.o.vadHoldMs;
    seg.commitTimer = this.after(hold, () => this.commit(seg));
  }

  private commit(seg: SpeechSeg) {
    if (this.seg !== seg) return;
    this.seg = null;
    const text = seg.texts.join(' ').replace(/\s+/g, ' ').trim();
    this.send({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: Date.now() - seg.startedAt, item_id: seg.itemId });
    this.send({ type: 'input_audio_buffer.committed', item_id: seg.itemId, previous_item_id: null });
    // The model hears the audio right away; the client gets the transcript after the ASR lag.
    this.moderator.addUser(text, seg.itemId);
    const lag = this.o.asrLagMs[0] + this.o.rand() * (this.o.asrLagMs[1] - this.o.asrLagMs[0]);
    const half = text.split(' ').slice(0, Math.ceil(text.split(' ').length / 2)).join(' ');
    this.after(lag * 0.5, () => this.send({ type: 'conversation.item.input_audio_transcription.delta', item_id: seg.itemId, content_index: 0, delta: half }));
    this.after(lag, () => this.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: seg.itemId, content_index: 0, transcript: text }));
    if (this.createResponse) {
      if (this.active && !this.active.done) this.pendingAuto = true;
      else this.after(120, () => this.autoRespond());
    }
  }

  /** VAD-created response (create_response: true). */
  private autoRespond() {
    if (this.active && !this.active.done) {
      this.pendingAuto = true;
      return;
    }
    const out = this.moderator.respond({ auto: true });
    if (out.kind === 'none' && out.silent) return; // the model chose not to answer (no response at all)
    this.run(out);
  }

  get userSpeaking() {
    return Boolean(this.seg?.speaking);
  }
}
