"""Turn detection with OpenAI Realtime semantics.

turn_detection config (the realtime `turn_detection` object; None = manual, no events):
  {"type": "server_vad", "threshold": 0.5, "prefix_padding_ms": 300, "silence_duration_ms": 500}
  {"type": "semantic_vad", "eagerness": "low"|"medium"|"high"|"auto"}
Extra (non-OpenAI) knobs accepted in the same dict: min_speech_ms (default 160),
pause_ms (semantic_vad first-check pause, default 200), energy_floor_dbfs (default -60).

speech_started.audio_ms = speech onset minus prefix_padding_ms (like OpenAI's audio_start_ms).
speech_stopped.audio_ms = end of speech, before the trailing silence (DESIGN contract).

semantic_vad: Silero decides speech presence; after a short pause (~200 ms) smart-turn v3
scores P(turn complete) on the utterance audio (last <= 8 s). Confident "complete" ends the turn
after ~0.2-0.6 s of silence depending on eagerness; "incomplete" waits up to the eagerness'
max timeout (low 8 s, medium/auto 4 s, high 2 s), re-scoring as the pause grows.

Robustness: a speech onset must accumulate `min_speech_ms` of voiced frames (tolerating short
gaps) before speech_started fires, so clicks/coughs don't barge in; Silero hysteresis
(on >= threshold, off < threshold - 0.15); frames below an energy floor never count as speech;
after a pause, resuming speech needs 2 voiced frames. NaN/inf input is zeroed; DC offset never
counts as energy.

Ambient noise (non-OpenAI, `onset_snr_db`, default 9): the level floor (20th percentile of the last
~3 s outside speech) is tracked; an onset must be `onset_snr_db` above it, and inside a turn a
frame no louder than floor + 5 dB is not speech. Steady babble / TV noise therefore neither
starts a turn nor keeps one open after the user stops.

Echo (assistant audio leaking into the mic, no / poor client AEC): the protocol layer calls
`push_playback(pcm, at_ms, sr)` with what is being played and `clear_playback()` on flush; see
`EchoGate`. `set_playing(True)` is a coarse fallback when no reference is available.
`set_transcript_hint(text)` lets semantic_vad use the (speculative) transcript as a lexical cue.
"""
from __future__ import annotations

import logging
import os
import re
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Literal

import numpy as np

from collections import deque

from .audio import RingBuffer, resample, sanitize
from .vad import FRAME, SR, VAD

log = logging.getLogger("ort.turn")

FRAME_MS = FRAME * 1000 // SR  # 32
_HERE = os.path.dirname(os.path.abspath(__file__))
SMART_TURN_PATH = os.environ.get(
    "ORT_SMART_TURN", os.path.join(os.path.dirname(_HERE), "models", "smart-turn-v3", "smart-turn-v3.2-cpu.onnx"))

# a transcript ending in one of these (or in ',' / '...') is not a finished turn, whatever the prosody
_CONTINUE = set("""
to the a an and but or of for with in on at by from into about than as my your our their his her its this
that these those is are was were be been am because so if which who whose when while where then like um uh
er erm hmm could would should can will shall might must i we you they he she it just really very also not
und oder aber der die das den dem des ein eine einen einem zu mit für von im am ich wir weil dass wenn also ähm äh
y o pero el la los las un una unos de del para con que porque si mi tu su eh este esta
et ou mais le les une des du pour avec parce si mon ma mes ton ta euh ce cette je nous vous il elle
""".split())

# ... and these even when Whisper put a full stop after them ("I'd like to.")
_CONTINUE_STRONG = set("""
to the a an and but or of for with from into about than my your our their because if which whose um uh er erm
und oder aber der die das den dem ein eine einen einem zu mit für von weil dass ähm äh
y o pero el la los las un una de del para con porque mi tu su eh et ou mais le les une des du pour avec parce euh
""".split())

EAGERNESS = {
    #          complete_wait_ms, extra_ms_if_unsure, max_timeout_ms
    "high": (200, 300, 2000),
    "medium": (380, 600, 4000),
    "low": (650, 1200, 8000),
}


@dataclass
class TurnEvent:
    type: Literal["speech_started", "speech_stopped"]
    audio_ms: int                       # position in the input stream (ms since reset)
    detected_ms: int = 0                # stream position when the event was decided
    p_complete: float | None = None     # semantic_vad: smart-turn score at the stop decision
    audio: np.ndarray | None = field(default=None, repr=False)  # speech_stopped: utterance (16 kHz)


class SmartTurn:
    """smart-turn v3 ONNX: P(turn complete) from the last <= 8 s of 16 kHz audio."""
    _sess = None
    _fe = None
    _lock = threading.Lock()

    def __init__(self, path: str = SMART_TURN_PATH, threads: int = 4):
        with SmartTurn._lock:
            if SmartTurn._sess is None:
                import onnxruntime as ort
                from transformers import WhisperFeatureExtractor
                so = ort.SessionOptions()
                so.intra_op_num_threads = threads
                so.inter_op_num_threads = 1
                so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
                so.log_severity_level = 3
                SmartTurn._sess = ort.InferenceSession(path, sess_options=so, providers=["CPUExecutionProvider"])
                SmartTurn._fe = WhisperFeatureExtractor(chunk_length=8)
        self.sess, self.fe = SmartTurn._sess, SmartTurn._fe
        self.last_ms = 0.0

    def predict(self, audio16k: np.ndarray) -> float:
        t = time.perf_counter()
        a = np.asarray(audio16k, dtype=np.float32)[-8 * SR:]
        f = self.fe(a, sampling_rate=SR, return_tensors="np", padding="max_length",
                    max_length=8 * SR, truncation=True, do_normalize=True).input_features.astype(np.float32)
        p = float(self.sess.run(None, {"input_features": f})[0].reshape(-1)[0])
        self.last_ms = (time.perf_counter() - t) * 1000
        return p


class EchoGate:
    """Keeps assistant playback (echo) from barging in when the client has no / poor AEC.

    The protocol layer tells the detector what is being played (`push_playback`: reference
    audio on the input timeline). Per 32 ms frame and per band (16 log-spaced bands, 150 Hz -
    6 kHz) the echo the mic could contain is predicted as coupling(band) x max of the
    reference power over the echo window (acoustic delay + reverb tail, decaying 2 dB/frame).
    A frame whose energy is mostly explained by that prediction (< 50 % of its power above
    `margin_db` over it) is echo: its speech probability is zeroed, so it can neither start
    a turn nor extend one. A user talking over the echo puts energy where the prediction has
    none and still barges in.

    Self-calibrating and robust to an unknown delay: until enough playback was heard the
    echo window spans every delay up to `max_delay_ms` and the coupling prior is 0 dB (the
    echo is assumed as loud as the reference). Every 0.5 s the delay is re-estimated by
    correlating mic and reference frame energies, and the per-band coupling is set to the
    90th percentile of mic/predicted ratios over the last 3 s of echo-only frames, so a
    well-cancelled mic (good browser AEC) quickly ends up with ~no gating at all.
    Coupling and delay persist across responses (same room, same device).
    """
    NB = 16
    HIST = 94                      # ~3 s of frames for delay / coupling estimation

    def __init__(self, max_delay_ms: int = 600, tail_ms: int = 300, margin_db: float = 4.5,
                 explained: float = 0.5, prior_db: float = -10.0):
        f = np.fft.rfftfreq(FRAME, 1 / SR)
        edges = np.geomspace(150, 6000, self.NB + 1)
        self._bins = [np.flatnonzero((f >= a) & (f < b)) for a, b in zip(edges[:-1], edges[1:])]
        self._win = np.hanning(FRAME).astype(np.float32)
        self.dmax = max(1, int(round(max_delay_ms / FRAME_MS)))
        self.tail = max(1, int(round(tail_ms / FRAME_MS)))
        self.margin = 10 ** (margin_db / 10)
        self.explained = explained
        self._decay = 10 ** (-2.0 / 10)          # 2 dB per frame reverb decay (conservative)
        self._lock = threading.Lock()
        self.log_h = np.full(self.NB, prior_db * np.log(10) / 10)   # log coupling mic/ref per band
        self.calibrated = False
        self.delay: int | None = None            # frames (>= -1), None = unknown
        self.gated = 0                           # frames gated as echo (stats)
        self.last_corr = 0.0
        self.reset_timeline()

    def reset_timeline(self) -> None:
        with self._lock:
            self._ref: dict[int, np.ndarray] = {}     # frame index -> reference samples
            self._refp: dict[int, np.ndarray] = {}    # frame index -> band powers (cache)
            self._last_ref = -10 ** 9                 # last frame index holding reference audio
        self._hm = np.zeros((self.HIST, self.NB))     # mic band powers of echo-only frames
        self._hi = np.full(self.HIST, -1, np.int64)   # their frame indices
        self._hn = 0
        self._since_est = 0

    # ---- reference side (called from the protocol thread)
    def push(self, x16k: np.ndarray, start_sample: int) -> None:
        x = np.asarray(x16k, np.float32).ravel()
        if not len(x):
            return
        with self._lock:
            pos, k = int(start_sample), 0
            while k < len(x):
                j, off = divmod(pos, FRAME)
                n = min(FRAME - off, len(x) - k)
                buf = self._ref.get(j)
                if buf is None:
                    buf = self._ref[j] = np.zeros(FRAME, np.float32)
                buf[off:off + n] += x[k:k + n]
                self._refp.pop(j, None)
                pos += n
                k += n
            self._last_ref = max(self._last_ref, (pos - 1) // FRAME)

    def clear(self, from_sample: int) -> None:
        """Playback stopped at `from_sample`: forget reference audio after it (what was
        already played keeps its reverb tail)."""
        j0, off = divmod(int(from_sample), FRAME)
        with self._lock:
            for j in [j for j in self._ref if j >= j0]:
                if j == j0 and off:
                    self._ref[j][off:] = 0
                    self._refp.pop(j, None)
                else:
                    del self._ref[j]
                    self._refp.pop(j, None)
            self._last_ref = max([j for j in self._ref] or [-10 ** 9])

    def active(self, i: int) -> bool:
        """Could frame i contain echo (reference played within the echo window)?"""
        return self._ref and i - self._last_ref <= self.dmax + self.tail + 1

    # ---- mic side (called from TurnDetector.feed)
    def _bandpow(self, frame: np.ndarray) -> np.ndarray:
        sp = np.abs(np.fft.rfft(frame * self._win)) ** 2
        return np.array([sp[b].sum() for b in self._bins]) / FRAME

    def _ref_matrix(self, lo: int, hi: int) -> np.ndarray:
        """Band powers of reference frames lo..hi (inclusive); zeros where nothing played."""
        out = np.zeros((hi - lo + 1, self.NB))
        with self._lock:
            for j in range(lo, hi + 1):
                if j in self._ref:
                    p = self._refp.get(j)
                    if p is None:
                        p = self._refp[j] = self._bandpow(self._ref[j])
                    out[j - lo] = p
        return out

    def _weights(self, delay: int | None):
        """(first lag, weights): echo of frame i ~ max_k w[k] * R[i - lag0 - k]."""
        if delay is None:
            return -1, np.ones(self.dmax + self.tail + 2)
        w = np.concatenate([[1.0, 1.0], self._decay ** np.arange(1, self.tail + 1)])
        return delay - 1, w

    def _predict(self, idx: np.ndarray, delay: int | None) -> np.ndarray:
        lag0, w = self._weights(delay)
        lo = int(idx.min()) - lag0 - len(w) + 1
        hi = int(idx.max()) - lag0
        R = self._ref_matrix(lo, hi)
        E = np.zeros((len(idx), self.NB))
        for k, wk in enumerate(w):
            E = np.maximum(E, wk * R[idx - lag0 - k - lo])
        return E

    def is_echo(self, i: int, frame: np.ndarray, learn: bool, strict: bool = False) -> bool:
        """True if frame i is (almost) fully explained by echo. strict=True (the user already has
        the floor) only gates frames with < 20 % unexplained power, so soft syllables survive."""
        pm = self._bandpow(frame)
        e = self._predict(np.array([i]), self.delay)[0]
        if e.sum() <= 1e-12:
            return False
        if learn:
            k = self._hn % self.HIST
            self._hm[k], self._hi[k] = pm, i
            self._hn += 1
            self._since_est += 1
            if self._since_est >= (16 if self.calibrated else 8):
                self._since_est = 0
                self._estimate()
        pred = self.margin * np.exp(self.log_h) * e
        excess = np.maximum(0.0, pm - pred).sum() / (pm.sum() + 1e-12)
        echo = excess < (0.2 if strict else self.explained)
        self.gated += int(echo)
        return echo

    def _estimate(self) -> None:
        n = min(self._hn, self.HIST)
        idx, pm = self._hi[:n], self._hm[:n]
        # delay: correlate mic frame energy with reference energy at each candidate lag
        lm = np.log(pm.sum(1) + 1e-10)
        R = self._ref_matrix(int(idx.min()) - self.dmax, int(idx.max()) + 1)
        lr_all = np.log(R.sum(1) + 1e-10)
        best, best_c = None, 0.0
        for d in range(-1, self.dmax + 1):
            lr = lr_all[idx - d - (int(idx.min()) - self.dmax)]
            if lr.std() < 1e-3 or lm.std() < 1e-3:
                continue
            c = float(np.corrcoef(lm, lr)[0, 1])
            if c > best_c:
                best, best_c = d, c
        if best is not None and best_c >= 0.5:
            self.delay = best
        # coupling: a high percentile of mic / predicted echo per band when the mic clearly
        # follows the reference (echo dominates); a low one when it doesn't (the mic holds
        # something else, e.g. the user talking over a well-cancelled echo)
        q = 10 + 80 * float(np.clip((best_c - 0.3) / 0.3, 0.0, 1.0))
        self.last_corr = best_c
        E = self._predict(idx, self.delay)
        ratio = np.log(pm + 1e-12) - np.log(E + 1e-12)
        new = self.log_h.copy()
        for b in range(self.NB):
            # only frames where the reference is loud in this band: elsewhere mic noise over a
            # tiny prediction would inflate the coupling (and such frames are never speech)
            ok = E[:, b] > max(1e-10, float(np.percentile(E[:, b], 50)))
            if ok.sum() >= 8:
                new[b] = np.percentile(ratio[ok, b], q)
        new = np.minimum(new, np.log(10.0))       # echo louder than +10 dB over reference: implausible
        self.log_h = new if not self.calibrated else 0.5 * self.log_h + 0.5 * new
        self.calibrated = True


class TurnDetector:
    def __init__(self, cfg: dict | None = None, on_pause: Callable | None = None,
                 history_s: float = 120.0):
        self.vad = VAD()
        self.ring = RingBuffer(int(history_s * SR))
        self.on_pause = on_pause   # on_pause(audio16k, start_ms, end_ms) at the first ~200 ms pause
        self._smart: SmartTurn | None = None
        self.last_utterance: np.ndarray | None = None
        self.echo = EchoGate()
        self.playing = False       # coarse fallback when no reference audio is pushed
        self.update(cfg)
        self.reset()

    # ---------------- config ----------------
    def update(self, cfg: dict | None) -> None:
        cfg = dict(cfg or {})
        t = cfg.get("type")
        self.mode = t if t in ("server_vad", "semantic_vad") else None
        self.threshold = float(cfg.get("threshold") or 0.5)
        self.neg_threshold = max(0.05, self.threshold - 0.15)
        pp = cfg.get("prefix_padding_ms")
        self.prefix_padding_ms = int(300 if pp is None else pp)
        sd = cfg.get("silence_duration_ms")
        self.silence_duration_ms = int(500 if sd is None else sd)
        e = (cfg.get("eagerness") or "auto").lower()
        self.eagerness = "medium" if e not in EAGERNESS else e
        self.min_speech_ms = int(cfg.get("min_speech_ms") or 160)
        self.pause_ms = int(cfg.get("pause_ms") or 200)
        self.energy_floor = 10 ** (float(cfg.get("energy_floor_dbfs") or -60) / 20)
        sn = cfg.get("onset_snr_db")
        self.onset_snr_db = float(9.0 if sn is None else sn)
        self.cfg = cfg
        if self.mode == "semantic_vad" and self._smart is None:
            self._smart = SmartTurn()

    def reset(self) -> None:
        """Forget all state and restart the timeline at 0 (e.g. input_audio_buffer.clear)."""
        self.vad.reset()
        self.ring.clear()
        self.echo.reset_timeline()
        self._pending = np.zeros(0, np.float32)
        self._frame_i = 0
        self._lvl = deque(maxlen=94)      # frame levels (dB, DC removed) outside speech, ~3 s
        self._floor_db = -200.0
        self._pow = self._pow_s = 0.0
        self._idle()
        self.in_speech = False

    def _idle(self):
        self.in_speech = False
        self._cand_start = None      # sample index of candidate onset
        self._cand_voiced = 0
        self._cand_gap = 0
        self._cand_pow = 0.0
        self._voiced = False
        self._utt_start = 0
        self._speech_start = 0
        self._last_speech_end = 0    # sample index
        self._resume = 0
        self._paused_fired = False
        self._p_complete = None
        self._next_eval = None
        self._required_ms = None
        self._hint_incomplete = self._hint_complete = False

    # ---------------- helpers ----------------
    @property
    def paused(self) -> bool:
        """True between an on_pause hint and the user either resuming or the turn ending."""
        return self._paused_fired

    @property
    def position_ms(self) -> int:
        return self.ring.total * 1000 // SR

    def _ms(self, samples: int) -> int:
        return samples * 1000 // SR

    def _utterance(self, end_sample: int) -> np.ndarray:
        tail = min(int(0.12 * SR), max(0, self.ring.total - end_sample))
        return self.ring.read(self._utt_start, end_sample + tail)

    def utterance_audio(self) -> np.ndarray:
        """Audio of the current (or last) utterance incl. prefix padding, 16 kHz."""
        if self.in_speech:
            return self._utterance(self._last_speech_end)
        return self.last_utterance if self.last_utterance is not None else np.zeros(0, np.float32)

    def _required_silence(self, p: float) -> int:
        cw, extra, mx = EAGERNESS[self.eagerness]
        if p >= 0.5:
            unsure = (0.9 - min(p, 0.9)) / 0.4          # 0 when p >= 0.9, 1 at p = 0.5
            return int(cw + unsure * extra)
        return int(mx * (0.5 + (0.5 - p)))              # p=0 -> max timeout, p->0.5 -> half

    # ---------------- echo / playback (barge-in protection without client AEC) ----------------
    def push_playback(self, pcm: np.ndarray, at_ms: int | None = None, sr: int = SR) -> None:
        """Tell the detector which assistant audio reaches the speaker, so its echo in the mic
        cannot barge in (see `EchoGate`). `pcm`: float32 mono at `sr` (e.g. the 24 kHz TTS
        chunk as it is sent). `at_ms`: when its first sample is played, on this detector's
        input timeline (`position_ms` basis; may lie in the future for buffered audio);
        default: now. Acoustic / jitter delays up to ~600 ms on top are estimated. Thread-safe."""
        x = sanitize(np.asarray(pcm, np.float32).ravel())
        if sr != SR:
            x = resample(x, sr, SR)
        start = self.ring.total if at_ms is None else int(at_ms) * SR // 1000
        self.echo.push(x, start)

    def clear_playback(self, at_ms: int | None = None) -> None:
        """Playback was stopped / flushed (barge-in, output_audio_buffer.clear) at `at_ms`
        (default now): reference audio scheduled after that is forgotten."""
        self.echo.clear(self.ring.total if at_ms is None else int(at_ms) * SR // 1000)

    def set_playing(self, playing: bool) -> None:
        """Coarse fallback when reference audio can't be provided: while True, speech onsets need
        a higher Silero threshold (+0.15) and twice min_speech_ms. Prefer push_playback()."""
        self.playing = bool(playing)

    def set_transcript_hint(self, text: str | None) -> None:
        """Optional lexical cue for semantic_vad: the transcript of the current utterance so far
        (e.g. the speculative STT result at the pause, or the streaming hypothesis). If it ends
        mid-phrase ("I'd like to", "and the", "um", trailing ',' / '...') the turn is treated as
        incomplete (P(complete) <= 0.3) even when smart-turn's prosody score says otherwise; a
        question or a short stand-alone answer ("Yes.", "Five.") counts as complete (>= 0.8).
        Re-scores immediately. Cleared automatically when the user resumes or the turn ends."""
        t = (text or "").strip()
        words = re.sub(r"[^\w\s']", " ", t).lower().split()
        last = words[-1] if words else ""
        inc = bool(t) and (t.endswith((",", "...", "…", "-", "–"))
                           or (last in _CONTINUE and not t.endswith(("?", "!", ".")))
                           or (last in _CONTINUE_STRONG and not t.endswith(("?", "!"))))  # Whisper adds '.'
        # a question, or a short stand-alone answer ("Yes.", "Five.", "No thanks"), is complete
        comp = bool(t) and not inc and (t.endswith(("?", "!")) or len(words) <= 3)
        self._hint_incomplete, self._hint_complete = inc, comp
        if self.in_speech and (inc or comp):
            self._next_eval = None        # re-score at the next frame

    @property
    def noise_floor_dbfs(self) -> float:
        return self._floor_db

    # ---------------- main entry ----------------
    def feed(self, pcm16k_chunk: np.ndarray) -> list[TurnEvent]:
        x = sanitize(np.asarray(pcm16k_chunk, dtype=np.float32).ravel())
        if not len(x):
            return []
        self.ring.write(x)
        probs = self.vad.feed(x)
        if self.mode is None:
            self._frame_i += len(probs)
            return []
        events: list[TurnEvent] = []
        for p in probs:
            i = self._frame_i
            self._frame_i += 1
            fs, fe = i * FRAME, (i + 1) * FRAME
            frame = self.ring.read(fs, fe)
            pw = 0.0
            if len(frame):
                f0 = frame - frame.mean()                     # DC offset must not look like energy
                pw = float(np.mean(f0 * f0))
                if self.echo.active(i):
                    # every frame calibrates the echo model (outside the user's speech)
                    echo = self.echo.is_echo(i, f0, learn=not self.in_speech and self._cand_start is None,
                                             strict=self.in_speech)
                    if echo:
                        p = 0.0                               # assistant echo, not the user
                if pw < self.energy_floor ** 2:
                    p = 0.0
            self._pow = pw
            self._pow_s = (self._pow_s * 2 + pw) / 3 if self.in_speech else pw   # ~100 ms smoothing
            if not self.in_speech:
                self._lvl.append(10 * np.log10(pw + 1e-12))
                if len(self._lvl) <= 16 or i % 4 == 0:
                    self._floor_db = float(np.percentile(self._lvl, 20))
            ev = self._step(p, fs, fe)
            if ev is not None:
                events.append(ev)
        return events

    def _step(self, p: float, fs: int, fe: int) -> TurnEvent | None:
        th, nth = self.threshold, self.neg_threshold
        if not self.in_speech:
            min_speech = self.min_speech_ms
            if self.playing:
                th, min_speech = min(0.95, th + 0.15), 2 * min_speech
            if p >= th:
                if self._cand_start is None:
                    self._cand_start = fs
                    self._cand_pow = 0.0
                self._cand_voiced += 1
                self._cand_pow += self._pow
                self._cand_gap = 0
                self._last_speech_end = fe
            elif self._cand_start is not None:
                if p < nth:
                    self._cand_gap += 1
                    if self._cand_gap > 3:            # >~100 ms gap: candidate was noise
                        self._cand_start, self._cand_voiced, self._cand_gap = None, 0, 0
            if self._cand_start is not None and self._cand_voiced * FRAME_MS >= min_speech:
                # onset must stand out from the ambient level (steady babble / TV-like noise
                # is "speech" to Silero but never rises above its own floor)
                lvl = 10 * np.log10(self._cand_pow / self._cand_voiced + 1e-12)
                if len(self._lvl) < 8 or lvl < self._floor_db + self.onset_snr_db:
                    self._cand_start, self._cand_voiced, self._cand_gap = None, 0, 0
                    return None
                self.in_speech = True
                self._voiced = True
                self._speech_start = self._cand_start
                pad = self.prefix_padding_ms * SR // 1000
                self._utt_start = max(0, self.ring.oldest, self._cand_start - pad)
                self._resume = 0
                self._paused_fired = False
                self._p_complete = None
                self._next_eval = None
                self._required_ms = None
                return TurnEvent("speech_started", self._ms(self._utt_start), self._ms(fe))
            return None

        # ---- in speech ----
        if p >= nth and len(self._lvl) >= 8 and \
                10 * np.log10(self._pow_s + 1e-12) < self._floor_db + self.onset_snr_db - 4:
            p = 0.0          # no louder than the ambient floor (babble / TV): not the user's speech
        silence_ms = self._ms(fe - self._last_speech_end)
        if p >= th:
            if silence_ms > 3 * FRAME_MS:
                self._resume += 1                     # resuming after a real pause: confirm
                if self._resume >= 2:
                    self._resume_speech(fe)
            else:
                self._resume_speech(fe)
            return None
        if p >= nth and self._voiced and silence_ms <= FRAME_MS:
            self._last_speech_end = fe                 # hysteresis: still inside the word
            return None
        self._voiced = False
        if p < nth:
            self._resume = 0
        silence_ms = self._ms(fe - self._last_speech_end)

        if silence_ms >= self.pause_ms and not self._paused_fired:
            self._paused_fired = True
            if self.on_pause is not None:
                try:
                    self.on_pause(self._utterance(self._last_speech_end),
                                  self._ms(self._utt_start), self._ms(self._last_speech_end))
                except Exception:  # never let a callback break turn detection
                    log.exception("on_pause callback failed")

        if self.mode == "server_vad":
            if silence_ms >= self.silence_duration_ms:
                return self._stop(fe, None)
            return None

        # semantic_vad
        if silence_ms >= self.pause_ms and (self._next_eval is None or silence_ms >= self._next_eval):
            audio = self.ring.read(max(self._utt_start, fe - 8 * SR), fe)   # model sees <= 8 s
            self._p_complete = self._smart.predict(audio)
            if self._hint_incomplete:
                self._p_complete = min(self._p_complete, 0.3)
            elif self._hint_complete:
                self._p_complete = max(self._p_complete, 0.8)
            self._required_ms = self._required_silence(self._p_complete)
            self._next_eval = silence_ms + 400
        mx = EAGERNESS[self.eagerness][2]
        if (self._required_ms is not None and silence_ms >= self._required_ms) or silence_ms >= mx:
            return self._stop(fe, self._p_complete)
        return None

    def _resume_speech(self, fe: int):
        self._voiced = True
        self._resume = 0
        self._last_speech_end = fe
        self._paused_fired = False
        self._p_complete = None
        self._next_eval = None
        self._required_ms = None
        self._hint_incomplete = self._hint_complete = False

    def _stop(self, fe: int, p_complete: float | None) -> TurnEvent:
        end = self._last_speech_end
        audio = self._utterance(end)
        self.last_utterance = audio
        ev = TurnEvent("speech_stopped", self._ms(end), self._ms(fe), p_complete, audio)
        self._idle()
        return ev

    def force_stop(self) -> TurnEvent | None:
        """End the current turn now (e.g. client commit / end of stream)."""
        if not self.in_speech:
            return None
        return self._stop(self.ring.total, self._p_complete)
