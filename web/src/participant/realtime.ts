// OpenAI Realtime (gpt-realtime-2) over WebRTC — see docs/REALTIME.md.
// Responsibilities: connect (ephemeral token → SDP exchange), data-channel events,
// function-call dedupe on call_id, response scheduling (never two active responses),
// one automatic reconnect, and exposing remote audio for playback/recording.
import type { RealtimeTokenResponse } from '@thinkaloud/shared';

export type RealtimeStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'closed';

export interface FunctionCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  rawArgs: string;
  responseId?: string;
}

export interface RealtimeHandlers {
  onStatus?: (s: RealtimeStatus, detail?: string) => void;
  /** Any server event (for debugging / fine-grained UI). */
  onServerEvent?: (ev: ServerEvent) => void;
  onFunctionCall?: (call: FunctionCall) => Promise<{ output: unknown; respond: boolean }> | { output: unknown; respond: boolean };
  /** `itemId`: the input item this speech segment becomes (its transcript arrives later with the same id). */
  onUserSpeechStart?: (itemId?: string) => void;
  onUserSpeechStop?: () => void;
  onUserTranscriptDelta?: (itemId: string, delta: string) => void;
  /** `logprobs`: transcription token log-probabilities when the session includes them. */
  onUserTranscript?: (itemId: string, text: string, logprobs?: unknown) => void;
  onAssistantTranscriptDelta?: (responseId: string, delta: string) => void;
  /** `phase`: gpt-realtime-2 marks spoken preambles as 'commentary' and the actual reply as 'final_answer'. */
  onAssistantTranscript?: (responseId: string, text: string, phase?: string) => void;
  onAssistantAudioStart?: (responseId?: string) => void;
  /** `cleared`: playback was cut (interruption); `byClient`: we asked for the clear (not the server's VAD). */
  onAssistantAudioStop?: (responseId: string | undefined, cleared: boolean, byClient: boolean) => void;
  onResponseStart?: () => void;
  onResponseDone?: (status: string, responseId?: string) => void;
  /** Called after a (re)connect once the data channel is open — send session.update + context here. */
  onReady?: (reconnected: boolean) => void;
  onRemoteStream?: (stream: MediaStream) => void;
  onError?: (message: string, code?: string) => void;
}

export type ServerEvent = { type: string; [k: string]: unknown };

/** `none` = speak only; `{type:'function', name}` = must call exactly this tool. */
export type ToolChoice = 'none' | { type: 'function'; name: string };
type CreateReq = { instructions?: string; toolChoice?: ToolChoice; textOnly?: boolean; retried?: boolean };

export interface RealtimeOptions {
  getToken: () => Promise<RealtimeTokenResponse>;
  /** Participant mic (null = text mode, receive-only audio). */
  mic: MediaStream | null;
  handlers: RealtimeHandlers;
  audioEl: HTMLAudioElement;
  /**
   * Turn-taking gate: may a spoken response start right now? While it returns false (the participant
   * is talking), response.create for spoken responses is held and re-tried — the moderator never
   * starts talking over the participant. Text-only responses are never held.
   */
  canSpeak?: () => boolean;
}

export class RealtimeClient {
  status: RealtimeStatus = 'idle';
  model = '';
  voice = '';
  remoteStream: MediaStream | null = null;
  /** Input-transcription settings from the token (language-pinned). */
  transcription: RealtimeTokenResponse['transcription'] | null = null;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private seenCalls = new Set<string>();
  private activeResponse = false;
  private wantResponse: CreateReq | null = null;
  /** The last response.create we sent (re-sent if the server rejects it as "already has an active response"). */
  private lastCreate: CreateReq | null = null;
  /** In-band responses the server created and has not finished yet. */
  private liveResponses = new Set<string>();
  /** Out-of-band (classification) responses still running on the server. */
  private liveOob = new Set<string>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private gateTimer: ReturnType<typeof setTimeout> | null = null;
  /** The request behind the response that is live now (re-sent once if the server cancels it before it was audible). */
  private liveCreate: CreateReq | null = null;
  private audibleResponses = new Set<string>();
  /** Responses we cancelled ourselves (never re-queued); `cancelNextCreated`: a cancel sent before its response.created. */
  private cancelledByUs = new Set<string>();
  private cancelNextCreated = false;
  private pendingCallOutputs = 0;
  private respondAfterCalls = false;
  private reconnects = 0;
  private connectedAt = 0;
  /** A session was established before (so a later onReady is a resume, not a fresh start). */
  private everReady = false;
  /** Out-of-band (conversation: 'none', text-only) classification requests, by our id / by response id. */
  private oob = new Map<string, { resolve: (text: string | null) => void; text: string }>();
  private oobByResponse = new Map<string, string>();
  private oobSeq = 0;
  private itemPhase = new Map<string, string>();
  /** Last ~150 client/server event types (diagnostics; read by tests). */
  readonly trace: string[] = [];
  private tr(line: string) {
    this.trace.push(`${Math.round(performance.now())} ${line}`);
    if (this.trace.length > 150) this.trace.shift();
  }
  private closedByUs = false;
  assistantAudioPlaying = false;
  userSpeaking = false;
  private outbox: unknown[] = [];

  constructor(private opts: RealtimeOptions) {}

  private setStatus(s: RealtimeStatus, detail?: string) {
    this.status = s;
    this.opts.handlers.onStatus?.(s, detail);
  }

  async connect(): Promise<void> {
    this.closedByUs = false;
    this.setStatus(this.reconnects ? 'reconnecting' : 'connecting');
    const token = await this.opts.getToken();
    this.model = token.model;
    this.voice = token.voice;
    this.transcription = token.transcription ?? null;
    const pc = new RTCPeerConnection();
    this.pc = pc;
    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      this.remoteStream = stream;
      this.opts.audioEl.srcObject = stream;
      void this.opts.audioEl.play().catch(() => {});
      this.opts.handlers.onRemoteStream?.(stream);
    };
    const micTrack = this.opts.mic?.getAudioTracks()[0];
    if (micTrack) pc.addTrack(micTrack, this.opts.mic!);
    else pc.addTransceiver('audio', { direction: 'recvonly' });

    const dc = pc.createDataChannel('oai-events');
    this.dc = dc;
    const opened = new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('Realtime data channel timeout')), 15000);
      dc.onopen = () => {
        clearTimeout(to);
        resolve();
      };
    });
    dc.onmessage = (m) => {
      try {
        this.handle(JSON.parse(m.data as string) as ServerEvent);
      } catch (e) {
        console.warn('[realtime] bad event', e);
      }
    };
    dc.onclose = () => {
      if (!this.closedByUs && this.pc === pc) void this.handleDrop('data channel closed');
    };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        // 'disconnected' can recover on its own; give it a moment.
        const st = pc.connectionState;
        setTimeout(() => {
          if (this.pc === pc && (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') && !this.closedByUs) void this.handleDrop(`peer ${st}`);
        }, st === 'failed' ? 0 : 4000);
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const res = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      body: offer.sdp,
      headers: { Authorization: `Bearer ${token.value}`, 'Content-Type': 'application/sdp' },
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Realtime SDP exchange failed (${res.status}) ${t.slice(0, 200)}`);
    }
    const sdp = await res.text();
    await pc.setRemoteDescription({ type: 'answer', sdp });
    await opened;
    this.activeResponse = false;
    this.connectedAt = Date.now();
    this.setStatus('connected');
    const queued = this.outbox.splice(0);
    const resumed = this.everReady;
    this.everReady = true;
    this.opts.handlers.onReady?.(resumed);
    for (const q of queued) this.send(q);
  }

  /**
   * Initial connect with one retry (fresh token + SDP exchange) before giving up, so a transient
   * failure does not drop the participant into the on-screen fallback.
   */
  async connectWithRetry(): Promise<void> {
    try {
      await this.connect();
    } catch (e) {
      if (this.closedByUs) throw e;
      console.warn('[realtime] connect failed, retrying once:', (e as Error).message);
      this.teardown();
      await new Promise((r) => setTimeout(r, 1500));
      if (this.closedByUs) throw e;
      this.reconnects++;
      try {
        await this.connect();
      } catch (e2) {
        this.teardown();
        throw e2;
      }
    }
  }

  private async handleDrop(reason: string) {
    if (this.closedByUs) return;
    console.warn('[realtime] connection dropped:', reason);
    this.teardown();
    // One reconnect attempt per drop; a connection that drops again within a minute is given up.
    if (this.reconnects >= 1 && Date.now() - this.connectedAt < 60_000) {
      this.setStatus('failed', reason);
      return;
    }
    this.reconnects++;
    try {
      await this.connect();
    } catch (e) {
      this.teardown();
      this.setStatus('failed', (e as Error).message);
    }
  }

  private teardown() {
    const pc = this.pc;
    this.pc = null;
    this.dc = null;
    for (const o of this.oob.values()) o.resolve(null);
    this.oob.clear();
    this.oobByResponse.clear();
    this.liveOob.clear();
    this.liveResponses.clear();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.gateTimer) clearTimeout(this.gateTimer);
    this.gateTimer = null;
    this.activeResponse = false;
    this.assistantAudioPlaying = false;
    this.userSpeaking = false;
    try {
      pc?.getSenders().forEach((s) => {
        // do not stop the shared mic track – it belongs to the session
        if (s.track && s.track.kind !== 'audio') s.track.stop();
      });
      pc?.close();
    } catch {
      /* ignore */
    }
  }

  close() {
    this.closedByUs = true;
    this.teardown();
    this.setStatus('closed');
  }

  get open() {
    return this.dc?.readyState === 'open';
  }

  private createSeq = 0;
  private createdSeen = 0;

  send(ev: unknown) {
    if ((ev as { type?: string }).type === 'response.create') {
      // Watchdog: if the server never acknowledges our response.create, unstick the scheduler.
      const mine = ++this.createSeq;
      const seenBefore = this.createdSeen;
      setTimeout(() => {
        if (mine === this.createSeq && this.createdSeen === seenBefore && this.activeResponse && !this.liveResponses.size) {
          this.activeResponse = false;
          // Re-send it once (it may have been dropped); never loop on a request the server keeps rejecting.
          if (!this.wantResponse && this.lastCreate && !this.lastCreate.retried) {
            this.tr('! response.create never acknowledged; retrying once');
            this.wantResponse = { ...this.lastCreate, retried: true };
          }
          this.maybeContinue();
        }
      }, 5000);
    }
    const e = ev as { type?: string; response?: { instructions?: string; tool_choice?: unknown } };
    this.tr(`> ${e.type}${e.response?.tool_choice ? ` tool_choice=${JSON.stringify(e.response.tool_choice)}` : ''}${e.response?.instructions ? ` NOW:${e.response.instructions.split('# NOW').pop()?.slice(0, 60).replace(/\s+/g, ' ')}` : ''}`);
    if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(ev));
    else if (this.status === 'connecting' || this.status === 'reconnecting') this.outbox.push(ev);
  }

  /**
   * Ask the model a side question without speaking and without touching the conversation
   * (out-of-band response: conversation 'none', text output). It still sees the conversation so
   * far, including the participant's latest audio. Resolves null on timeout / no connection.
   */
  classify(instructions: string, timeoutMs = 4000): Promise<string | null> {
    if (this.dc?.readyState !== 'open') return Promise.resolve(null);
    const id = `ta_oob_${++this.oobSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // Timed out: stop it on the server too, so it never blocks a real response.
        for (const [rid, oid] of this.oobByResponse) if (oid === id && this.liveOob.has(rid)) this.send({ type: 'response.cancel', response_id: rid });
        done(null);
      }, timeoutMs);
      const done = (t: string | null) => {
        clearTimeout(timer);
        if (!this.oob.has(id)) return;
        this.oob.delete(id);
        resolve(t);
      };
      this.oob.set(id, { resolve: done, text: '' });
      this.dc!.send(
        JSON.stringify({
          type: 'response.create',
          event_id: id,
          response: { conversation: 'none', metadata: { ta_oob: id }, output_modalities: ['text'], instructions, tool_choice: 'none', max_output_tokens: 400 },
        }),
      );
    });
  }

  private oobOf(ev: ServerEvent): { id: string; o: { resolve: (t: string | null) => void; text: string } } | null {
    const resp = ev.response as { id?: string; metadata?: Record<string, string> | null } | undefined;
    const rid = (ev.response_id as string | undefined) ?? resp?.id;
    let id = rid ? this.oobByResponse.get(rid) : undefined;
    if (!id && resp?.metadata?.ta_oob) {
      id = resp.metadata.ta_oob;
      if (rid) this.oobByResponse.set(rid, id);
    }
    const o = id ? this.oob.get(id) : undefined;
    return id && o ? { id, o } : id ? { id, o: { resolve: () => {}, text: '' } } : null;
  }

  updateSession(session: Record<string, unknown>) {
    this.send({ type: 'session.update', session: { type: 'realtime', ...session } });
  }

  addSystemItem(text: string) {
    this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] } });
  }

  /** Cancel any classification still running (an urgent spoken response must not wait for it). */
  cancelClassifications() {
    for (const rid of this.liveOob) this.send({ type: 'response.cancel', response_id: rid });
    for (const o of [...this.oob.values()]) o.resolve(null);
  }

  /** Remove an item from the conversation (e.g. a noise transcript the model must not treat as an answer). */
  deleteItem(itemId: string) {
    if (itemId) this.send({ type: 'conversation.item.delete', item_id: itemId });
  }

  addUserText(text: string) {
    this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
  }

  /**
   * Ask the model to respond. Queued until the active response (and pending tool calls) finish, and — for spoken responses — until the participant is not talking.
   * `noRetry`: if the participant cuts in before it is audible, drop it (e.g. a silence nudge) instead of sending it again.
   */
  requestResponse(instructions?: string, toolChoice?: ToolChoice, textOnly?: boolean, noRetry?: boolean) {
    if (this.activeResponse || this.pendingCallOutputs > 0 || (!textOnly && this.gated())) {
      this.wantResponse = instructions
        ? { instructions, toolChoice, textOnly, retried: noRetry }
        : { instructions: this.wantResponse?.instructions, toolChoice: toolChoice ?? this.wantResponse?.toolChoice, textOnly: textOnly ?? this.wantResponse?.textOnly, retried: noRetry ?? this.wantResponse?.retried };
      if (!this.activeResponse && this.pendingCallOutputs === 0) this.pollGate();
      return;
    }
    this.activeResponse = true; // optimistic, avoids double-create races
    this.sendCreate({ instructions, toolChoice, textOnly, retried: noRetry });
  }

  /** A spoken response is waiting for the participant to stop talking (or for the active response). */
  get pendingRequest() {
    return Boolean(this.wantResponse);
  }

  private gated() {
    return Boolean(this.opts.canSpeak && !this.opts.canSpeak());
  }

  private pollGate() {
    if (this.gateTimer) return;
    this.gateTimer = setTimeout(() => {
      this.gateTimer = null;
      this.maybeContinue();
    }, 150);
  }

  private sendCreate(w: CreateReq) {
    this.lastCreate = w;
    const response: Record<string, unknown> = {};
    if (w.instructions) response.instructions = w.instructions;
    if (w.toolChoice) response.tool_choice = w.toolChoice;
    if (w.textOnly) response.output_modalities = ['text'];
    this.send({ type: 'response.create', ...(Object.keys(response).length ? { response } : {}) });
  }

  /** A response is being generated / played, or one is queued. */
  get responding() {
    return this.activeResponse || Boolean(this.wantResponse);
  }

  private clearRequestedAt = 0;
  private truncSeq = 0;

  cancelResponse() {
    // A queued (not yet sent) request is dropped too: the caller decided it is no longer wanted.
    this.wantResponse = null;
    this.respondAfterCalls = false;
    for (const rid of this.liveResponses) this.cancelledByUs.add(rid);
    if (this.activeResponse && !this.liveResponses.size) this.cancelNextCreated = true;
    if (this.activeResponse || this.liveResponses.size) this.send({ type: 'response.cancel' });
    if (this.assistantAudioPlaying) {
      this.clearRequestedAt = performance.now();
      this.send({ type: 'output_audio_buffer.clear' });
    }
  }

  /** Tell the server how much of an assistant item was actually heard (after we cut its playback). */
  truncate(itemId: string, audioEndMs: number) {
    if (!itemId) return;
    this.send({ type: 'conversation.item.truncate', event_id: `ta_trunc_${++this.truncSeq}`, item_id: itemId, content_index: 0, audio_end_ms: Math.max(0, Math.round(audioEndMs)) });
  }

  private async runFunctionCall(call: FunctionCall) {
    this.pendingCallOutputs++;
    let result: { output: unknown; respond: boolean };
    try {
      result = (await this.opts.handlers.onFunctionCall?.(call)) ?? { output: { ok: false, error: 'No handler' }, respond: true };
    } catch (e) {
      result = { output: { ok: false, error: (e as Error).message, hint: 'Call get_current_step.' }, respond: true };
    }
    this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: call.callId, output: JSON.stringify(result.output) } });
    if (result.respond) this.respondAfterCalls = true;
    this.pendingCallOutputs--;
    this.maybeContinue();
  }

  private scheduleRetry(ms = 600) {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.liveResponses.size) return; // its response.done continues
      this.activeResponse = false;
      this.maybeContinue();
    }, ms);
  }

  private maybeContinue() {
    if (this.activeResponse || this.pendingCallOutputs > 0) return;
    const next = this.wantResponse ?? (this.respondAfterCalls ? ({} as CreateReq) : null);
    if (next && !next.textOnly && this.gated()) return this.pollGate();
    if (this.wantResponse) {
      // An explicit request (possibly with instructions) wins over a plain continuation.
      const w = this.wantResponse;
      this.wantResponse = null;
      this.respondAfterCalls = false;
      this.activeResponse = true;
      this.sendCreate(w);
      return;
    }
    if (this.respondAfterCalls) {
      this.respondAfterCalls = false;
      this.activeResponse = true;
      this.sendCreate({});
    }
  }

  private handle(ev: ServerEvent) {
    const h = this.opts.handlers;
    h.onServerEvent?.(ev);
    if (!/delta$|^output_audio_buffer\.|^rate_limits|^conversation\.item\.(added|done)$|content_part|transcript\.segment/.test(ev.type) || ev.type.startsWith('output_audio_buffer.st'))
      this.tr(`< ${ev.type}${ev.type === 'error' ? ` ${JSON.stringify(ev.error).slice(0, 160)}` : ev.type === 'response.done' ? ` ${(ev.response as { status?: string })?.status}` : ''}`);
    // Out-of-band classification responses never affect the conversation state or captions.
    if (ev.type.startsWith('response.')) {
      const oob = this.oobOf(ev);
      if (oob) {
        const rid = (ev.response as { id?: string } | undefined)?.id ?? (ev.response_id as string | undefined);
        if (ev.type === 'response.created' && rid) this.liveOob.add(rid);
        if (ev.type === 'response.output_text.delta') oob.o.text += (ev.delta as string) ?? '';
        if (ev.type === 'response.done') {
          const resp = ev.response as { output?: { content?: { text?: string; transcript?: string }[] }[] } | undefined;
          const text = resp?.output?.flatMap((i) => i.content ?? []).map((c) => c.text ?? c.transcript ?? '').join('') || oob.o.text;
          oob.o.resolve(text.trim());
          if (rid) {
            this.liveOob.delete(rid);
            this.oobByResponse.delete(rid);
          }
          // A spoken response may have been waiting for this one to finish.
          this.maybeContinue();
        }
        return;
      }
    }
    switch (ev.type) {
      case 'response.created': {
        this.createdSeen++;
        const rid = (ev.response as { id?: string } | undefined)?.id;
        if (rid) this.liveResponses.add(rid);
        if (rid && this.cancelNextCreated) this.cancelledByUs.add(rid);
        this.cancelNextCreated = false;
        this.liveCreate = this.lastCreate;
        this.activeResponse = true;
        h.onResponseStart?.();
        break;
      }
      case 'response.done': {
        const rid = (ev.response as { id?: string } | undefined)?.id;
        if (rid) this.liveResponses.delete(rid);
        this.activeResponse = this.liveResponses.size > 0;
        const resp = ev.response as { status?: string; output?: { type: string; call_id?: string; name?: string; arguments?: string }[] } | undefined;
        // Function calls may only be reported here (safety net).
        for (const item of resp?.output ?? []) {
          if (item.type === 'function_call' && item.call_id) this.onCall(item.call_id, item.name ?? '', item.arguments ?? '{}');
        }
        // A spoken response the server cancelled before a word was audible (the participant started
        // talking — VAD interruption): send it once more when they have finished, instead of losing it.
        const lc = this.liveCreate;
        const byUs = rid ? this.cancelledByUs.delete(rid) : false;
        if (resp?.status === 'cancelled' && rid && !byUs && !this.audibleResponses.has(rid) && lc && !lc.textOnly && !lc.retried && !this.wantResponse) {
          this.tr('! response cancelled before it was audible; re-queued');
          this.wantResponse = { ...lc, retried: true };
        }
        if (this.cancelledByUs.size > 100) this.cancelledByUs.clear();
        h.onResponseDone?.(resp?.status ?? 'completed', rid);
        this.maybeContinue();
        break;
      }
      case 'response.function_call_arguments.done':
        this.onCall(ev.call_id as string, ev.name as string, (ev.arguments as string) ?? '{}');
        break;
      case 'response.output_item.added':
      case 'response.output_item.done': {
        const item = ev.item as { id?: string; type?: string; call_id?: string; name?: string; arguments?: string; phase?: string } | undefined;
        if (item?.type === 'message' && item.id && item.phase) {
          this.itemPhase.set(item.id, item.phase);
          if (this.itemPhase.size > 200) this.itemPhase.delete(this.itemPhase.keys().next().value!);
        }
        if (ev.type === 'response.output_item.added') break;
        if (item?.type === 'function_call' && item.call_id) this.onCall(item.call_id, item.name ?? '', item.arguments ?? '{}');
        break;
      }
      case 'input_audio_buffer.speech_started':
        this.userSpeaking = true;
        h.onUserSpeechStart?.(ev.item_id as string | undefined);
        break;
      case 'input_audio_buffer.speech_stopped':
        this.userSpeaking = false;
        h.onUserSpeechStop?.();
        break;
      case 'conversation.item.input_audio_transcription.delta':
        h.onUserTranscriptDelta?.(ev.item_id as string, (ev.delta as string) ?? '');
        break;
      case 'conversation.item.input_audio_transcription.completed':
        h.onUserTranscript?.(ev.item_id as string, ((ev.transcript as string) ?? '').trim(), ev.logprobs);
        break;
      case 'response.output_audio_transcript.delta':
      case 'response.output_text.delta':
        h.onAssistantTranscriptDelta?.(`${ev.response_id as string}:${(ev.item_id as string) ?? ''}`, (ev.delta as string) ?? '');
        break;
      case 'response.output_audio_transcript.done':
        h.onAssistantTranscript?.(`${ev.response_id as string}:${(ev.item_id as string) ?? ''}`, ((ev.transcript as string) ?? '').trim(), this.itemPhase.get(ev.item_id as string));
        break;
      case 'response.output_text.done':
        h.onAssistantTranscript?.(`${ev.response_id as string}:${(ev.item_id as string) ?? ''}`, ((ev.text as string) ?? '').trim(), this.itemPhase.get(ev.item_id as string));
        break;
      case 'output_audio_buffer.started':
        this.assistantAudioPlaying = true;
        if (ev.response_id) {
          this.audibleResponses.add(ev.response_id as string);
          if (this.audibleResponses.size > 200) this.audibleResponses.delete(this.audibleResponses.values().next().value!);
        }
        h.onAssistantAudioStart?.(ev.response_id as string | undefined);
        break;
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        if (this.assistantAudioPlaying) {
          this.assistantAudioPlaying = false;
          const cleared = ev.type === 'output_audio_buffer.cleared';
          h.onAssistantAudioStop?.(ev.response_id as string | undefined, cleared, cleared && performance.now() - this.clearRequestedAt < 3000);
        }
        break;
      case 'error': {
        const err = ev.error as { message?: string; code?: string; event_id?: string } | undefined;
        const code = err?.code;
        if (err?.event_id?.startsWith('ta_trunc_')) break; // e.g. the server already truncated it itself
        if (err?.event_id?.startsWith('ta_oob_')) {
          console.warn('[realtime] classification failed', err.message);
          this.oob.get(err.event_id)?.resolve(null);
          break;
        }
        if (code === 'conversation_already_has_active_response') {
          // Our response.create was rejected: another response (VAD-created, or a classification still
          // running) is active. Keep what we asked for — including directed instructions — and re-send
          // it as soon as that response ends. Out-of-band responses never report done to the in-band
          // scheduler, so also retry on a short timer instead of waiting for the watchdog.
          this.wantResponse = this.wantResponse ?? this.lastCreate ?? {};
          this.activeResponse = this.liveResponses.size > 0;
          this.scheduleRetry();
        } else if (code === 'response_cancel_not_active') {
          /* harmless */
        } else {
          console.warn('[realtime] error', err);
          // A rejected response.create never produces response.created: don't stay "busy" forever.
          if (this.activeResponse && !this.liveResponses.size && /response/i.test(`${err?.message ?? ''} ${err?.event_id ?? ''}`)) this.scheduleRetry(1500);
          h.onError?.(err?.message ?? 'Realtime error', code);
        }
        break;
      }
    }
  }

  private onCall(callId: string, name: string, rawArgs: string) {
    if (!callId || this.seenCalls.has(callId)) return;
    this.seenCalls.add(callId);
    let args: Record<string, unknown> = {};
    try {
      args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
    } catch {
      args = { __invalid_json: rawArgs };
    }
    void this.runFunctionCall({ callId, name, args, rawArgs });
  }
}
