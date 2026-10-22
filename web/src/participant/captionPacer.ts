// ─────────────────────────────────────────────────────────────────────────────
// CaptionPacer — moderator captions that follow what is actually audible.
//
// The realtime API streams the moderator's transcript much faster than the audio
// plays back, so captions used to show a whole paragraph while the voice was still
// on the first sentence. The pacer keeps the full text per transcript item and
// reveals it word by word only while that response's audio is playing:
//  * nothing is shown before output_audio_buffer.started for the response;
//  * words advance at the measured speaking rate, and only while the remote audio
//    meter actually hears speech (pauses pause the caption) — so it never runs ahead;
//  * output_audio_buffer.stopped flushes the full text; output_audio_buffer.cleared
//    (interruption) cuts the caption where the audio stopped;
//  * the transcript is "committed" (logged) at that moment, with the cut text when
//    interrupted, so the log reflects what the participant really heard.
// ─────────────────────────────────────────────────────────────────────────────

export interface PacedSegment {
  /** Caption id (`${responseId}:${itemId}`). */
  id: string;
  responseId: string;
  itemId: string;
  full: string;
  done: boolean;
  phase?: string;
  shownWords: number;
  committed: boolean;
  createdAt: number;
}

export interface CaptionPacerOptions {
  /** Show (or update) a caption. */
  show: (id: string, text: string, final: boolean) => void;
  /** The segment's text is final for the log: `text` is what was audible, `truncated` if cut off. `late`: its audio had already ended. */
  commit: (seg: PacedSegment, text: string, truncated: boolean, late: boolean) => void;
  /** Instantaneous remote-audio level 0..1, or null when there is no meter. */
  level: () => number | null;
  /** Clock (ms). Default performance.now — injectable for tests. */
  now?: () => number;
  /** Don't run the internal timer (tests call tick()). */
  manual?: boolean;
}

/** Initial speaking rate (words/s) — adapted to the measured rate after each response. */
const DEFAULT_RATE = 2.7;
const SPEECH_LEVEL = 0.035;
/** Commit transcript text that never became audible (no audio for its response) after this long. */
const UNHEARD_COMMIT_MS = 2500;

const tokens = (s: string) => s.split(/(\s+)/).filter((t) => t.length);
export const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;
/** The first `n` words of `s`, keeping its original spacing. */
export function firstWords(s: string, n: number): string {
  if (n <= 0) return '';
  let seen = 0;
  let out = '';
  for (const t of tokens(s)) {
    if (/^\s+$/.test(t)) {
      if (seen >= n) break;
      out += t;
      continue;
    }
    if (seen >= n) break;
    out += t;
    seen++;
  }
  return out.trimEnd();
}

export class CaptionPacer {
  private segs: PacedSegment[] = [];
  /** Response whose audio is playing right now. */
  private playing: string | null = null;
  private startedAt = 0;
  private lastTick = 0;
  private budget = 0;
  private activeMs = 0;
  private revealedThisResponse = 0;
  private soundSeen = false;
  private hangUntil = 0;
  private pauseUntil = 0;
  private ended = new Map<string, 'stopped' | 'cleared'>();
  private heard = new Set<string>();
  private readonly timer: ReturnType<typeof setInterval>;
  /** Measured speaking rate, words per second of audible speech. */
  rate = DEFAULT_RATE;

  private now: () => number;

  constructor(private o: CaptionPacerOptions) {
    this.now = o.now ?? (() => performance.now());
    this.lastTick = this.now();
    this.timer = o.manual ? (0 as unknown as ReturnType<typeof setInterval>) : setInterval(() => this.tick(), 70);
  }

  dispose() {
    clearInterval(this.timer);
  }

  private seg(id: string): PacedSegment {
    let s = this.segs.find((x) => x.id === id);
    if (!s) {
      const [responseId, itemId = ''] = id.split(':');
      s = { id, responseId, itemId, full: '', done: false, shownWords: 0, committed: false, createdAt: this.now() };
      this.segs.push(s);
      if (this.segs.length > 40) this.segs.splice(0, this.segs.length - 40);
    }
    return s;
  }

  delta(id: string, delta: string) {
    const s = this.seg(id);
    if (!s.done) s.full += delta;
  }

  done(id: string, text: string, phase?: string) {
    const s = this.seg(id);
    if (s.committed) return;
    if (text) s.full = text;
    s.done = true;
    s.phase = phase;
    const end = this.ended.get(s.responseId);
    // Its audio already ended before the transcript arrived (e.g. a cancelled response).
    if (end === 'stopped') this.commit(s, s.full, false, true);
    else if (end === 'cleared') this.commit(s, firstWords(s.full, s.shownWords), s.shownWords < wordCount(s.full), true);
  }

  /** output_audio_buffer.started */
  audioStart(responseId?: string) {
    const rid = responseId ?? this.segs.find((s) => !s.committed)?.responseId ?? null;
    if (!rid) return;
    // A different response starts playing: anything still open from the previous one is final.
    if (this.playing && this.playing !== rid) this.audioStop(this.playing, false);
    this.playing = rid;
    this.heard.add(rid);
    this.startedAt = this.now();
    this.lastTick = this.startedAt;
    this.budget = 0.6; // the first word is audible almost at once
    this.activeMs = 0;
    this.revealedThisResponse = 0;
    this.soundSeen = false;
    this.hangUntil = 0;
    this.pauseUntil = 0;
  }

  /**
   * output_audio_buffer.stopped (cleared = false) or .cleared (cleared = true).
   * Returns the segment that was cut and how much of its audio was played (for conversation.item.truncate).
   */
  audioStop(responseId: string | undefined, cleared: boolean): { seg: PacedSegment; playedMs: number } | null {
    const rid = responseId ?? this.playing;
    if (!rid) return null;
    const playedMs = Math.max(0, Math.round(this.now() - this.startedAt));
    if (this.playing === rid) this.tick(); // catch up to "now" before cutting
    this.ended.set(rid, cleared ? 'cleared' : 'stopped');
    if (this.ended.size > 60) this.ended.delete(this.ended.keys().next().value!);
    let cut: { seg: PacedSegment; playedMs: number } | null = null;
    for (const s of this.segs.filter((x) => x.responseId === rid && !x.committed)) {
      const total = wordCount(s.full);
      if (!cleared) {
        if (s.done) this.commit(s, s.full, false, false);
        else this.o.show(s.id, s.full, false); // transcript still arriving: show it all, commit on done()
        continue;
      }
      if (!s.done) continue; // committed (cut) when its transcript arrives
      const spoken = firstWords(s.full, s.shownWords);
      if (s.shownWords < total && !cut && s.shownWords > 0) cut = { seg: s, playedMs };
      this.commit(s, spoken, s.shownWords < total, false);
    }
    // Rate adaptation from a complete, uninterrupted response.
    if (!cleared && this.playing === rid && this.activeMs > 1500 && this.revealedThisResponse >= 4) {
      const words = this.segs.filter((x) => x.responseId === rid).reduce((n, x) => n + wordCount(x.full), 0);
      const measured = words / (this.activeMs / 1000);
      if (Number.isFinite(measured)) this.rate = Math.min(4.2, Math.max(1.8, this.rate * 0.6 + measured * 0.4));
    }
    if (this.playing === rid) this.playing = null;
    return cut;
  }

  /**
   * response.done with status "cancelled": if none of it was ever audible, nothing of it was said —
   * its transcript is committed empty (never logged as a moderator line, never counts as a reading).
   */
  cancelled(responseId: string) {
    if (this.heard.has(responseId) || this.playing === responseId) return;
    this.ended.set(responseId, 'cleared');
    for (const s of this.segs.filter((x) => x.responseId === responseId && !x.committed && x.done)) this.commit(s, '', true, true);
  }

  private commit(s: PacedSegment, text: string, truncated: boolean, late: boolean) {
    if (s.committed) return;
    s.committed = true;
    s.shownWords = wordCount(text);
    this.o.commit(s, text, truncated, late);
  }

  tick() {
    const now = this.now();
    const dt = Math.min(250, now - this.lastTick);
    this.lastTick = now;
    // Transcripts whose response never became audible (no audio events at all): log them anyway.
    for (const s of this.segs) {
      if (!s.committed && s.done && !this.heard.has(s.responseId) && s.responseId !== this.playing && now - s.createdAt > UNHEARD_COMMIT_MS && !this.ended.has(s.responseId)) this.commit(s, s.full, false, false);
    }
    const rid = this.playing;
    if (!rid) return;
    const lvl = this.o.level();
    let speaking: boolean;
    if (lvl == null) speaking = true;
    else {
      if (lvl > SPEECH_LEVEL) {
        this.soundSeen = true;
        this.hangUntil = now + 160;
      }
      // A meter that never hears anything (e.g. muted output) must not freeze the captions.
      speaking = now < this.hangUntil || (!this.soundSeen && now - this.startedAt > 1200);
    }
    if (!speaking || now < this.pauseUntil) return;
    this.activeMs += dt;
    this.budget = Math.min(this.budget + (dt / 1000) * this.rate, 1.5);
    const metered = lvl != null && this.soundSeen;
    while (this.budget >= 1) {
      const s = this.segs.find((x) => x.responseId === rid && !x.committed && x.shownWords < wordCount(x.full));
      if (!s) break;
      s.shownWords++;
      this.revealedThisResponse++;
      this.budget -= 1;
      const text = firstWords(s.full, s.shownWords);
      this.o.show(s.id, text, false);
      // Without a meter, approximate the pauses at punctuation.
      if (!metered) {
        if (/[.!?…。！？]["'”’)]*$/.test(text)) this.pauseUntil = now + 450;
        else if (/[,;:—–]["'”’)]*$/.test(text)) this.pauseUntil = now + 200;
        if (this.pauseUntil > now) break;
      }
    }
  }

  /** Words of `id` revealed so far (tests / debugging). */
  shown(id: string) {
    return this.segs.find((s) => s.id === id)?.shownWords ?? 0;
  }
}
