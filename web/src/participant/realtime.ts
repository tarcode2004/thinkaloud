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
  onUserSpeechStart?: () => void;
  onUserSpeechStop?: () => void;
  onUserTranscriptDelta?: (itemId: string, delta: string) => void;
  onUserTranscript?: (itemId: string, text: string) => void;
  onAssistantTranscriptDelta?: (responseId: string, delta: string) => void;
  onAssistantTranscript?: (responseId: string, text: string) => void;
  onAssistantAudioStart?: () => void;
  onAssistantAudioStop?: () => void;
  onResponseStart?: () => void;
  onResponseDone?: (status: string) => void;
  /** Called after a (re)connect once the data channel is open — send session.update + context here. */
  onReady?: (reconnected: boolean) => void;
  onRemoteStream?: (stream: MediaStream) => void;
  onError?: (message: string, code?: string) => void;
}

export type ServerEvent = { type: string; [k: string]: unknown };

export interface RealtimeOptions {
  getToken: () => Promise<RealtimeTokenResponse>;
  /** Participant mic (null = text mode, receive-only audio). */
  mic: MediaStream | null;
  handlers: RealtimeHandlers;
  audioEl: HTMLAudioElement;
}

export class RealtimeClient {
  status: RealtimeStatus = 'idle';
  model = '';
  voice = '';
  remoteStream: MediaStream | null = null;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private seenCalls = new Set<string>();
  private activeResponse = false;
  private wantResponse: { instructions?: string; toolChoice?: 'none' } | null = null;
  private pendingCallOutputs = 0;
  private respondAfterCalls = false;
  private reconnects = 0;
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
    this.setStatus('connected');
    const queued = this.outbox.splice(0);
    this.opts.handlers.onReady?.(this.reconnects > 0);
    for (const q of queued) this.send(q);
  }

  private async handleDrop(reason: string) {
    if (this.closedByUs) return;
    console.warn('[realtime] connection dropped:', reason);
    this.teardown();
    if (this.reconnects >= 1) {
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
    this.activeResponse = false;
    this.assistantAudioPlaying = false;
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
        if (mine === this.createSeq && this.createdSeen === seenBefore && this.activeResponse) {
          this.activeResponse = false;
          this.maybeContinue();
        }
      }, 8000);
    }
    if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(ev));
    else if (this.status === 'connecting' || this.status === 'reconnecting') this.outbox.push(ev);
  }

  updateSession(session: Record<string, unknown>) {
    this.send({ type: 'session.update', session: { type: 'realtime', ...session } });
  }

  addSystemItem(text: string) {
    this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] } });
  }

  addUserText(text: string) {
    this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
  }

  /** Ask the model to respond. Queued until the active response (and pending tool calls) finish. */
  requestResponse(instructions?: string, toolChoice?: 'none') {
    if (this.activeResponse || this.pendingCallOutputs > 0) {
      this.wantResponse = { instructions: instructions ?? this.wantResponse?.instructions, toolChoice: toolChoice ?? this.wantResponse?.toolChoice };
      return;
    }
    this.activeResponse = true; // optimistic, avoids double-create races
    this.sendCreate({ instructions, toolChoice });
  }

  private sendCreate(w: { instructions?: string; toolChoice?: 'none' }) {
    const response: Record<string, unknown> = {};
    if (w.instructions) response.instructions = w.instructions;
    if (w.toolChoice) response.tool_choice = w.toolChoice;
    this.send({ type: 'response.create', ...(Object.keys(response).length ? { response } : {}) });
  }

  get responding() {
    return this.activeResponse;
  }

  cancelResponse() {
    if (this.activeResponse) this.send({ type: 'response.cancel' });
    if (this.assistantAudioPlaying) this.send({ type: 'output_audio_buffer.clear' });
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

  private maybeContinue() {
    if (this.activeResponse || this.pendingCallOutputs > 0) return;
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
    switch (ev.type) {
      case 'response.created':
        this.createdSeen++;
        this.activeResponse = true;
        h.onResponseStart?.();
        break;
      case 'response.done': {
        this.activeResponse = false;
        const resp = ev.response as { status?: string; output?: { type: string; call_id?: string; name?: string; arguments?: string }[] } | undefined;
        // Function calls may only be reported here (safety net).
        for (const item of resp?.output ?? []) {
          if (item.type === 'function_call' && item.call_id) this.onCall(item.call_id, item.name ?? '', item.arguments ?? '{}');
        }
        h.onResponseDone?.(resp?.status ?? 'completed');
        this.maybeContinue();
        break;
      }
      case 'response.function_call_arguments.done':
        this.onCall(ev.call_id as string, ev.name as string, (ev.arguments as string) ?? '{}');
        break;
      case 'response.output_item.done': {
        const item = ev.item as { type?: string; call_id?: string; name?: string; arguments?: string } | undefined;
        if (item?.type === 'function_call' && item.call_id) this.onCall(item.call_id, item.name ?? '', item.arguments ?? '{}');
        break;
      }
      case 'input_audio_buffer.speech_started':
        this.userSpeaking = true;
        h.onUserSpeechStart?.();
        break;
      case 'input_audio_buffer.speech_stopped':
        this.userSpeaking = false;
        h.onUserSpeechStop?.();
        break;
      case 'conversation.item.input_audio_transcription.delta':
        h.onUserTranscriptDelta?.(ev.item_id as string, (ev.delta as string) ?? '');
        break;
      case 'conversation.item.input_audio_transcription.completed':
        h.onUserTranscript?.(ev.item_id as string, ((ev.transcript as string) ?? '').trim());
        break;
      case 'response.output_audio_transcript.delta':
      case 'response.output_text.delta':
        h.onAssistantTranscriptDelta?.(`${ev.response_id as string}:${(ev.item_id as string) ?? ''}`, (ev.delta as string) ?? '');
        break;
      case 'response.output_audio_transcript.done':
        h.onAssistantTranscript?.(`${ev.response_id as string}:${(ev.item_id as string) ?? ''}`, ((ev.transcript as string) ?? '').trim());
        break;
      case 'response.output_text.done':
        h.onAssistantTranscript?.(`${ev.response_id as string}:${(ev.item_id as string) ?? ''}`, ((ev.text as string) ?? '').trim());
        break;
      case 'output_audio_buffer.started':
        this.assistantAudioPlaying = true;
        h.onAssistantAudioStart?.();
        break;
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        if (this.assistantAudioPlaying) {
          this.assistantAudioPlaying = false;
          h.onAssistantAudioStop?.();
        }
        break;
      case 'error': {
        const err = ev.error as { message?: string; code?: string } | undefined;
        const code = err?.code;
        if (code === 'conversation_already_has_active_response') {
          // Our response.create raced with a VAD-created response: retry after it ends.
          this.activeResponse = true;
          this.wantResponse = this.wantResponse ?? {};
        } else if (code === 'response_cancel_not_active') {
          /* harmless */
        } else {
          console.warn('[realtime] error', err);
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
