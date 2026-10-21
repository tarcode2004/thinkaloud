// Audio helpers: shared AudioContext, level meters, a speaker test chime and the
// mixed (mic + moderator) session recorder uploaded as `track=mixed` chunks.
import { pApi, type SessionAuth } from './api.ts';

let ctx: AudioContext | null = null;
export function audioContext(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  return ctx;
}

/** RMS level meter (0..1) for a stream. Call `read()` per animation frame. */
export class LevelMeter {
  private analyser: AnalyserNode;
  private src: MediaStreamAudioSourceNode;
  private buf: Float32Array<ArrayBuffer>;
  private smoothed = 0;
  constructor(stream: MediaStream) {
    const ac = audioContext();
    this.src = ac.createMediaStreamSource(stream);
    this.analyser = ac.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.6;
    this.src.connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);
  }
  /** Instantaneous level (0..1), no smoothing and no side effects on `read()`. */
  raw(): number {
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
    return Math.min(1, Math.sqrt(sum / this.buf.length) * 6);
  }
  read(): number {
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
    const rms = Math.sqrt(sum / this.buf.length);
    const level = Math.min(1, rms * 6);
    this.smoothed = level > this.smoothed ? level : this.smoothed * 0.85 + level * 0.15;
    return this.smoothed;
  }
  dispose() {
    try {
      this.src.disconnect();
    } catch {
      /* ignore */
    }
  }
}

/** A pleasant two-note chime through the speakers. */
export async function playChime(): Promise<void> {
  const ac = audioContext();
  await ac.resume().catch(() => {});
  const now = ac.currentTime;
  [659.25, 880].forEach((f, i) => {
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    const t0 = now + i * 0.18;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.25, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.9);
    o.connect(g).connect(ac.destination);
    o.start(t0);
    o.stop(t0 + 1);
  });
  await new Promise((r) => setTimeout(r, 1100));
}

export function pickAudioMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) if (MediaRecorder.isTypeSupported(m)) return m;
  return undefined;
}

/** Records mic + remote moderator audio mixed into one stream, uploads 5s chunks. */
export class MixedRecorder {
  private dest: MediaStreamAudioDestinationNode;
  private sources: MediaStreamAudioSourceNode[] = [];
  private rec: MediaRecorder | null = null;
  private seq = 0;
  private uploads: Promise<void>[] = [];
  started = false;

  constructor(private auth: SessionAuth) {
    this.dest = audioContext().createMediaStreamDestination();
  }

  addStream(stream: MediaStream) {
    if (!stream.getAudioTracks().length) return;
    const src = audioContext().createMediaStreamSource(stream);
    src.connect(this.dest);
    this.sources.push(src);
  }

  /** Returns false if recording isn't supported. */
  start(): boolean {
    const mime = pickAudioMime();
    if (!mime) return false;
    try {
      this.rec = new MediaRecorder(this.dest.stream, { mimeType: mime, audioBitsPerSecond: 48_000 });
    } catch {
      return false;
    }
    this.rec.ondataavailable = (e) => {
      if (!e.data || e.data.size === 0) return;
      const seq = ++this.seq;
      const p = pApi.audio(this.auth, seq, 'mixed', e.data).catch(async () => {
        await new Promise((r) => setTimeout(r, 2000));
        await pApi.audio(this.auth, seq, 'mixed', e.data).catch(() => {});
      });
      this.uploads.push(p);
    };
    this.rec.start(5000);
    this.started = true;
    return true;
  }

  async stop(): Promise<void> {
    if (this.rec && this.rec.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        this.rec!.onstop = () => resolve();
        this.rec!.stop();
        setTimeout(resolve, 1500);
      });
    }
    await Promise.allSettled(this.uploads);
    this.sources.forEach((s) => {
      try {
        s.disconnect();
      } catch {
        /* ignore */
      }
    });
    this.sources = [];
  }

  /** Withdraw: stop without uploading what's left. */
  abort() {
    if (this.rec) {
      this.rec.ondataavailable = null;
      if (this.rec.state !== 'inactive') this.rec.stop();
    }
  }
}
