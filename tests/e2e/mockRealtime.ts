// A local, scripted stand-in for the OpenAI realtime API (WebRTC + data channel), injected into the
// participant page with `context.addInitScript(MOCK_REALTIME)`. Nothing reaches OpenAI: the spec also
// routes the realtime-token endpoint and api.openai.com. The mock "model" follows the briefs the runner
// sends (say_verbatim, record_answer, complete_step), speaks dictated "# NOW" texts, answers forced
// tool calls, and classifies quiet-phase utterances with a test-provided function. Audio playback is
// simulated with output_audio_buffer.started/stopped at ~2.8 words/s; transcripts stream instantly
// (like the real API, much faster than the audio).
//
// Test controls (window.__mockRt):
//   userSays(text, ms?)          participant speech: speech_started → (ms) → speech_stopped → transcript
//   config.rules                 [regex, label][] for out-of-band classifications (default "NO")
//   config.oobDelayMs            how long a classification stays "in progress" on the server
//   config.oobBlocksResponses    reject in-band response.create while a classification runs
//                                (conversation_already_has_active_response), like the real API did
//   sent                         every client event (for assertions)

export const MOCK_REALTIME = () => {
  if (window.top !== window) return;
  type Ev = Record<string, unknown> & { type: string };
  const WPS = 2.8;
  let seq = 0;
  const id = (p: string) => `${p}_mock${++seq}`;
  const config = {
    rules: [] as [string, string][],
    oobDelayMs: 300,
    oobBlocksResponses: true,
  };
  const st = {
    dc: null as null | { onmessage: ((m: { data: string }) => void) | null; onopen: (() => void) | null; onclose: (() => void) | null; readyState: string },
    createResponse: true,
    brief: null as null | Record<string, unknown>,
    said: [] as string[],
    lastUser: '',
    lastUserItem: '',
    lastUserAt: 0,
    lastSaidAt: 0,
    active: null as null | { id: string; done: boolean },
    oobLive: new Map<string, ReturnType<typeof setTimeout>>(),
    playing: null as null | { rid: string; timer: ReturnType<typeof setTimeout> },
  };
  const sent: Ev[] = [];
  const emit = (ev: Ev) => {
    const dc = st.dc;
    if (dc?.readyState === 'open') setTimeout(() => dc.onmessage?.({ data: JSON.stringify({ event_id: id('evt'), ...ev }) }), 0);
  };
  const parseBrief = (text: string) => {
    const i = text.lastIndexOf('[STEP] ');
    if (i < 0) return;
    try {
      st.brief = JSON.parse(text.slice(i + 7));
    } catch {
      /* ignore */
    }
  };

  function speak(rid: string, text: string) {
    const item = id('item');
    emit({ type: 'response.output_item.added', response_id: rid, item: { id: item, type: 'message', phase: 'final_answer' } });
    for (const w of text.split(/(?<= )/)) emit({ type: 'response.output_audio_transcript.delta', response_id: rid, item_id: item, delta: w });
    emit({ type: 'response.output_audio_transcript.done', response_id: rid, item_id: item, transcript: text });
    emit({ type: 'response.done', response: { id: rid, status: 'completed', output: [{ type: 'message', id: item }] } });
    st.said.push(text);
    st.lastSaidAt = Date.now();
    if (st.playing) clearTimeout(st.playing.timer);
    emit({ type: 'output_audio_buffer.started', response_id: rid });
    const ms = Math.max(600, (text.split(/\s+/).length / WPS) * 1000);
    st.playing = {
      rid,
      timer: setTimeout(() => {
        st.playing = null;
        emit({ type: 'output_audio_buffer.stopped', response_id: rid });
      }, ms),
    };
    st.active = null;
  }

  function call(rid: string, name: string, args: Record<string, unknown>) {
    const call_id = id('call');
    const a = JSON.stringify(args);
    emit({ type: 'response.function_call_arguments.done', response_id: rid, call_id, name, arguments: a });
    emit({ type: 'response.done', response: { id: rid, status: 'completed', output: [{ type: 'function_call', call_id, name, arguments: a }] } });
    st.active = null;
  }

  const dontKnow = (t: string) => /\b(don'?t know|not sure|no idea)\b/i.test(t);

  /** What the mock model does on a plain response.create (no dictated text). */
  function policy(rid: string) {
    const b = (st.brief ?? {}) as { step?: { type?: string }; say_verbatim?: string; question?: { question_id: string } };
    const userSinceSaid = st.lastUserAt > st.lastSaidAt;
    if (b.step?.type === 'intro' && userSinceSaid) return call(rid, 'complete_step', { summary: 'The participant is ready.' });
    if (b.question && userSinceSaid) {
      const t = st.lastUser;
      st.lastUserAt = 0; // consumed
      return call(rid, 'record_answer', { question_id: b.question.question_id, text: t, ...(dontKnow(t) ? { declined: true } : {}) });
    }
    if (b.say_verbatim && !st.said.some((s) => s.includes(b.say_verbatim!))) return speak(rid, b.say_verbatim);
    const job = String((b as { your_job?: string }).your_job ?? '');
    if (!b.question && /call complete_step/i.test(job) && !/do not call complete_step/i.test(job)) return call(rid, 'complete_step', { summary: 'Step finished.' });
    return speak(rid, 'Mm-hm.');
  }

  function onCreate(ev: Ev, delayMs = 250) {
    const r = (ev.response ?? {}) as { conversation?: string; metadata?: Record<string, string>; instructions?: string; tool_choice?: unknown };
    if (r.conversation === 'none') {
      const rid = id('resp_oob');
      emit({ type: 'response.created', response: { id: rid, metadata: r.metadata ?? null } });
      const label = config.rules.find(([re]) => new RegExp(re, 'i').test(st.lastUser))?.[1] ?? 'NO';
      st.oobLive.set(
        rid,
        setTimeout(() => {
          st.oobLive.delete(rid);
          emit({ type: 'response.done', response: { id: rid, metadata: r.metadata ?? null, status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: label }] }] } });
        }, config.oobDelayMs),
      );
      return;
    }
    if (st.active || (config.oobBlocksResponses && st.oobLive.size)) {
      if (delayMs === 800) return; // a VAD turn while busy: the server just doesn't reply
      emit({ type: 'error', error: { type: 'invalid_request_error', code: 'conversation_already_has_active_response', message: 'Conversation already has an active response in progress.' } });
      return;
    }
    const rid = id('resp');
    st.active = { id: rid, done: false };
    emit({ type: 'response.created', response: { id: rid } });
    setTimeout(() => {
      if (st.active?.id !== rid) return;
      const tc = r.tool_choice as { type?: string; name?: string } | string | undefined;
      if (tc && typeof tc === 'object' && tc.name) {
        const b = (st.brief ?? {}) as { question?: { question_id: string } };
        if (tc.name === 'set_task_outcome') return call(rid, tc.name, { outcome: 'success', evidence: 'mock judgement' });
        if (tc.name === 'record_answer') return call(rid, tc.name, { question_id: b.question?.question_id ?? '', text: st.lastUser, declined: true });
      }
      const now = r.instructions?.split('# NOW').pop();
      if (r.instructions && now !== undefined && r.instructions.includes('# NOW')) {
        // The runner hands over the participant's complete answer turn: the model reacts to exactly those words.
        const turn = /Their complete answer turn[^:]*: "([^"]*)"/.exec(now)?.[1];
        if (turn != null) {
          st.lastUser = turn;
          st.lastUserAt = Date.now();
          return policy(rid);
        }
        const quoted = [...now.matchAll(/"([^"]{2,})"/g)].map((m) => m[1]);
        if (/set_task_outcome now/.test(now)) return call(rid, 'set_task_outcome', { outcome: 'success', evidence: 'mock judgement' });
        return speak(rid, quoted.at(-1) ?? 'Okay.');
      }
      policy(rid);
    }, delayMs);
  }

  function handle(ev: Ev) {
    sent.push(ev);
    switch (ev.type) {
      case 'session.update': {
        const td = ((ev.session as { audio?: { input?: { turn_detection?: { create_response?: boolean } } } })?.audio?.input?.turn_detection) ?? null;
        if (td && typeof td.create_response === 'boolean') st.createResponse = td.create_response;
        break;
      }
      case 'conversation.item.create': {
        const item = ev.item as { type: string; role?: string; content?: { text?: string }[]; output?: string };
        if (item.type === 'message' && item.role === 'system') parseBrief(item.content?.[0]?.text ?? '');
        if (item.type === 'message' && item.role === 'user') {
          st.lastUser = item.content?.[0]?.text ?? '';
          st.lastUserAt = Date.now();
        }
        if (item.type === 'function_call_output') {
          try {
            const o = JSON.parse(item.output ?? '{}');
            if (o && o.step) st.brief = o;
            else if (o?.current?.step) st.brief = o.current;
          } catch {
            /* ignore */
          }
        }
        break;
      }
      case 'response.create':
        onCreate(ev);
        break;
      case 'conversation.item.delete':
        // The runner dropped this utterance (noise): the model no longer "heard" it.
        if (ev.item_id === st.lastUserItem) st.lastUserAt = 0;
        break;
      case 'response.cancel': {
        const rid = ev.response_id as string | undefined;
        if (rid && st.oobLive.has(rid)) {
          clearTimeout(st.oobLive.get(rid));
          st.oobLive.delete(rid);
          emit({ type: 'response.done', response: { id: rid, status: 'cancelled', output: [] } });
        } else if (!rid && st.active) {
          const a = st.active;
          st.active = null;
          emit({ type: 'response.done', response: { id: a.id, status: 'cancelled', output: [] } });
        }
        break;
      }
      case 'output_audio_buffer.clear':
        if (st.playing) {
          clearTimeout(st.playing.timer);
          const rid = st.playing.rid;
          st.playing = null;
          emit({ type: 'output_audio_buffer.cleared', response_id: rid });
        }
        break;
    }
  }

  async function userSays(text: string, ms = Math.max(800, (text.split(/\s+/).length / 2.6) * 1000)) {
    const item = id('item_user');
    emit({ type: 'input_audio_buffer.speech_started', item_id: item });
    await new Promise((r) => setTimeout(r, ms));
    emit({ type: 'input_audio_buffer.speech_stopped', item_id: item });
    // Like the real API: the VAD creates the reply at speech_stopped, before the transcript arrives.
    if (st.createResponse) onCreate({ type: 'response.create' }, 800);
    await new Promise((r) => setTimeout(r, 300));
    st.lastUser = text;
    st.lastUserAt = Date.now();
    st.lastUserItem = item;
    emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: item, transcript: text });
  }

  class FakeDC {
    readyState = 'connecting';
    onmessage: ((m: { data: string }) => void) | null = null;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    send(s: string) {
      handle(JSON.parse(s));
    }
    close() {
      this.readyState = 'closed';
    }
  }
  class FakePC {
    connectionState = 'new';
    ontrack: unknown = null;
    onconnectionstatechange: unknown = null;
    private dc: FakeDC | null = null;
    addTrack() {}
    addTransceiver() {}
    getSenders() {
      return [];
    }
    createDataChannel() {
      this.dc = new FakeDC();
      st.dc = this.dc;
      return this.dc;
    }
    async createOffer() {
      return { type: 'offer', sdp: 'v=0 mock' };
    }
    async setLocalDescription() {}
    async setRemoteDescription() {
      this.connectionState = 'connected';
      const dc = this.dc!;
      setTimeout(() => {
        dc.readyState = 'open';
        dc.onopen?.();
      }, 20);
    }
    close() {
      this.connectionState = 'closed';
    }
  }
  (window as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = FakePC;
  (window as unknown as { __mockRt: unknown }).__mockRt = { config, sent, userSays, state: st };
};
