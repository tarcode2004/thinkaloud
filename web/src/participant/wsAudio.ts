// Audio for the WebSocket realtime transport (fallback when WebRTC media cannot get through, e.g.
// symmetric NAT). WebRTC gives us echo-cancelled Opus both ways and the server's playout events;
// over a WebSocket the client does it itself:
//  * capture: the participant's mic (the same getUserMedia stream, so AEC/NS/AGC stay on) is
//    resampled to 24 kHz mono pcm16 in an AudioWorklet and handed out in 40 ms chunks;
//  * playback: response.output_audio.delta pcm16 goes into a jitter-buffered AudioWorklet player
//    (~100 ms prebuffer) that reports, per response, when its first sample is rendered and when its
//    last sample has been rendered, and — on a clear — exactly how many samples of each item were
//    played (stopping within one render quantum), so barge-in truncation matches what was heard.
import { audioContext } from './media.ts';

export const WS_RATE = 24000;
/** 40 ms of 24 kHz input per input_audio_buffer.append. */
const CHUNK = 960;
/** Playback prebuffer before a response starts / after an underrun (24 kHz samples). */
const PREBUFFER = 2400; // 100 ms
const REBUFFER = 1440; // 60 ms

const WORKLETS = /* js */ `
class TaCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / ${WS_RATE};
    this.acc = 0; this.sum = 0; this.cnt = 0; this.last = 0;
    this.buf = new Int16Array(${CHUNK}); this.n = 0;
  }
  emit(v) {
    const s = v < -1 ? -1 : v > 1 ? 1 : v;
    this.buf[this.n++] = s < 0 ? s * 32768 : s * 32767;
    if (this.n === this.buf.length) {
      this.port.postMessage(this.buf.buffer, [this.buf.buffer]);
      this.buf = new Int16Array(${CHUNK}); this.n = 0;
    }
  }
  process(inputs) {
    const inp = inputs[0];
    if (!inp || !inp.length) return true;
    const a = inp[0], b = inp.length > 1 ? inp[1] : null;
    for (let i = 0; i < a.length; i++) {
      // Box-filter decimation (anti-aliasing for the usual 48/44.1 kHz -> 24 kHz).
      this.sum += b ? (a[i] + b[i]) * 0.5 : a[i]; this.cnt++; this.acc += 1;
      while (this.acc >= this.ratio) {
        this.acc -= this.ratio;
        const v = this.cnt ? this.sum / this.cnt : this.last;
        this.last = v; this.sum = 0; this.cnt = 0;
        this.emit(v);
      }
    }
    return true;
  }
}
registerProcessor('ta-capture', TaCapture);

class TaPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = ${WS_RATE} / sampleRate;
    this.q = [];          // { rid, item, d: Float32Array } at 24 kHz
    this.off = 0;         // fractional read position in q[0]
    this.buffered = 0;    // samples queued (whole chunks, including the part of q[0] already read)
    this.playing = false; // false: (pre)buffering
    this.cur = null;      // response whose audio is audible now ("started", not yet "stopped")
    this.ended = new Set();
    this.done = {};       // item -> samples of fully played chunks
    this.port.onmessage = (e) => this.msg(e.data);
  }
  playedOf(item) {
    return (this.done[item] || 0) + (this.q.length && this.q[0].item === item ? Math.floor(this.off) : 0);
  }
  msg(m) {
    if (m.t === 'push') {
      this.q.push({ rid: m.rid, item: m.item, d: m.d });
      this.buffered += m.d.length;
    } else if (m.t === 'end') {
      this.ended.add(m.rid);
    } else if (m.t === 'clear') {
      const played = {};
      for (const k of Object.keys(this.done)) played[k] = this.done[k];
      if (this.q.length) played[this.q[0].item] = this.playedOf(this.q[0].item);
      this.port.postMessage({ t: 'cleared', seq: m.seq, played, cur: this.cur });
      this.q = []; this.off = 0; this.buffered = 0; this.playing = false; this.cur = null;
      this.ended.clear(); this.done = {};
    } else if (m.t === 'forget') {
      delete this.done[m.item];
    }
  }
  hasRid(rid) {
    for (const c of this.q) if (c.rid === rid) return true;
    return false;
  }
  stop() {
    const rid = this.cur;
    this.cur = null;
    this.ended.delete(rid);
    this.port.postMessage({ t: 'stopped', rid });
  }
  process(inputs, outputs) {
    const out = outputs[0][0];
    if (this.cur !== null && this.ended.has(this.cur) && !this.hasRid(this.cur)) this.stop();
    if (!this.playing) {
      const head = this.q[0];
      if (!head) return true;
      const need = this.cur === head.rid ? ${REBUFFER} : ${PREBUFFER};
      let ready = this.buffered - this.off >= need;
      if (!ready && this.ended.has(head.rid)) ready = true; // all of its audio is here
      if (!ready) return true;
      this.playing = true;
    }
    for (let i = 0; i < out.length; i++) {
      let h = this.q[0];
      while (h && this.off >= h.d.length) {
        this.off -= h.d.length;
        this.buffered -= h.d.length;
        this.done[h.item] = (this.done[h.item] || 0) + h.d.length;
        this.q.shift();
        h = this.q[0];
      }
      if (!h) {
        // Underrun (or the end): silence until enough arrives again.
        this.playing = false;
        this.off = 0;
        if (this.cur !== null && this.ended.has(this.cur)) this.stop();
        break;
      }
      if (this.cur !== h.rid) {
        if (this.cur !== null) this.stop();
        this.cur = h.rid;
        this.port.postMessage({ t: 'started', rid: h.rid, item: h.item });
      }
      const k = Math.floor(this.off), fr = this.off - k;
      const a = h.d[k];
      const b = k + 1 < h.d.length ? h.d[k + 1] : this.q.length > 1 ? this.q[1].d[0] : a;
      out[i] = a + (b - a) * fr;
      this.off += this.step;
    }
    return true;
  }
}
registerProcessor('ta-player', TaPlayer);
`;

const loaded = new WeakMap<BaseAudioContext, Promise<void>>();
function loadWorklets(ctx: AudioContext): Promise<void> {
  let p = loaded.get(ctx);
  if (!p) {
    const url = URL.createObjectURL(new Blob([WORKLETS], { type: 'application/javascript' }));
    p = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    p.catch(() => loaded.delete(ctx));
    loaded.set(ctx, p);
  }
  return p;
}

export function pcm16ToBase64(buf: ArrayBuffer): string {
  const u8 = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

function base64ToFloat32(b64: string): Float32Array<ArrayBuffer> {
  const bin = atob(b64);
  const n = bin.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    if (v >= 0x8000) v -= 0x10000;
    out[i] = v / 32768;
  }
  return out;
}

export interface WsAudioHandlers {
  /** 40 ms of mic audio, 24 kHz mono pcm16 (little endian). */
  onChunk: (pcm: ArrayBuffer) => void;
  /** The first sample of response `rid` is being rendered. */
  onStarted: (rid: string, itemId: string) => void;
  /** The last sample of response `rid` has been rendered. */
  onStopped: (rid: string) => void;
}

export interface ClearResult {
  /** 24 kHz samples actually rendered, per item (items with queued or playing audio). */
  played: Record<string, number>;
  /** The response that was audible when the clear hit (null: nothing was playing). */
  audible: string | null;
}

export class WsAudio {
  /** The moderator's voice as a MediaStream (level meter, session recording). */
  readonly stream: MediaStream;
  private clearSeq = 0;
  private clears = new Map<number, (r: ClearResult) => void>();
  private micSrc: MediaStreamAudioSourceNode | null = null;
  private sink: GainNode;
  /** Samples handed to the player and not yet confirmed stopped/cleared. */
  private queued = 0;

  private constructor(
    private ctx: AudioContext,
    private capture: AudioWorkletNode | null,
    private player: AudioWorkletNode,
    private dest: MediaStreamAudioDestinationNode,
    mic: MediaStream | null,
    private h: WsAudioHandlers,
  ) {
    this.stream = dest.stream;
    this.player.port.onmessage = (e) => this.onPlayer(e.data as { t: string; rid: string; item: string; seq: number; played: Record<string, number>; cur: string | null });
    // A zero-gain sink keeps the capture worklet pulled by the graph without making it audible.
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.sink.connect(ctx.destination);
    if (capture && mic?.getAudioTracks().length) {
      this.micSrc = ctx.createMediaStreamSource(mic);
      this.micSrc.connect(capture);
      capture.connect(this.sink);
      capture.port.onmessage = (e) => this.h.onChunk(e.data as ArrayBuffer);
    }
  }

  static async create(mic: MediaStream | null, h: WsAudioHandlers): Promise<WsAudio> {
    const ctx = audioContext();
    await loadWorklets(ctx);
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    const player = new AudioWorkletNode(ctx, 'ta-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
    const dest = ctx.createMediaStreamDestination();
    player.connect(ctx.destination);
    player.connect(dest);
    const capture = mic ? new AudioWorkletNode(ctx, 'ta-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] }) : null;
    return new WsAudio(ctx, capture, player, dest, mic, h);
  }

  get sampleRate() {
    return this.ctx.sampleRate;
  }

  /** Something is queued or playing. */
  get busy() {
    return this.queued > 0;
  }

  private onPlayer(m: { t: string; rid: string; item: string; seq: number; played: Record<string, number>; cur: string | null }) {
    if (m.t === 'started') this.h.onStarted(m.rid, m.item);
    else if (m.t === 'stopped') this.h.onStopped(m.rid);
    else if (m.t === 'cleared') {
      const r = this.clears.get(m.seq);
      this.clears.delete(m.seq);
      r?.({ played: m.played, audible: m.cur });
    }
  }

  /** Queue a base64 pcm16 24 kHz delta; returns its length in samples. */
  push(rid: string, itemId: string, b64: string): number {
    const d = base64ToFloat32(b64);
    const n = d.length; // read before the transfer detaches the buffer
    if (!n) return 0;
    this.queued += n;
    this.player.port.postMessage({ t: 'push', rid, item: itemId, d }, [d.buffer]);
    return n;
  }

  /** No more audio will arrive for response `rid`. */
  end(rid: string) {
    this.player.port.postMessage({ t: 'end', rid });
  }

  /** The player has nothing left for these samples (stopped / cleared bookkeeping). */
  settle(samples: number) {
    this.queued = Math.max(0, this.queued - samples);
  }

  forget(itemId: string) {
    this.player.port.postMessage({ t: 'forget', item: itemId });
  }

  /** Stop playback now (within one render quantum) and drop everything queued. */
  clear(): Promise<ClearResult> {
    const seq = ++this.clearSeq;
    this.queued = 0;
    return new Promise((resolve) => {
      const to = setTimeout(() => {
        this.clears.delete(seq);
        resolve({ played: {}, audible: null });
      }, 500);
      this.clears.set(seq, (r) => {
        clearTimeout(to);
        resolve(r);
      });
      this.player.port.postMessage({ t: 'clear', seq });
    });
  }

  dispose() {
    for (const r of this.clears.values()) r({ played: {}, audible: null });
    this.clears.clear();
    for (const n of [this.micSrc, this.capture, this.player, this.sink]) {
      try {
        n?.disconnect();
      } catch {
        /* ignore */
      }
    }
    if (this.capture) this.capture.port.onmessage = null;
    this.player.port.onmessage = null;
    this.dest.stream.getTracks().forEach((t) => t.stop());
  }
}
