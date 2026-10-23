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
after a pause, resuming speech needs 2 voiced frames.
"""
from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Literal

import numpy as np

from .audio import RingBuffer
from .vad import FRAME, SR, VAD

log = logging.getLogger("ort.turn")

FRAME_MS = FRAME * 1000 // SR  # 32
_HERE = os.path.dirname(os.path.abspath(__file__))
SMART_TURN_PATH = os.environ.get(
    "ORT_SMART_TURN", os.path.join(os.path.dirname(_HERE), "models", "smart-turn-v3", "smart-turn-v3.2-cpu.onnx"))

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


class TurnDetector:
    def __init__(self, cfg: dict | None = None, on_pause: Callable | None = None,
                 history_s: float = 120.0):
        self.vad = VAD()
        self.ring = RingBuffer(int(history_s * SR))
        self.on_pause = on_pause   # on_pause(audio16k, start_ms, end_ms) at the first ~200 ms pause
        self._smart: SmartTurn | None = None
        self.last_utterance: np.ndarray | None = None
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
        self.cfg = cfg
        if self.mode == "semantic_vad" and self._smart is None:
            self._smart = SmartTurn()

    def reset(self) -> None:
        """Forget all state and restart the timeline at 0 (e.g. input_audio_buffer.clear)."""
        self.vad.reset()
        self.ring.clear()
        self._pending = np.zeros(0, np.float32)
        self._frame_i = 0
        self._idle()
        self.in_speech = False

    def _idle(self):
        self.in_speech = False
        self._cand_start = None      # sample index of candidate onset
        self._cand_voiced = 0
        self._cand_gap = 0
        self._voiced = False
        self._utt_start = 0
        self._speech_start = 0
        self._last_speech_end = 0    # sample index
        self._resume = 0
        self._paused_fired = False
        self._p_complete = None
        self._next_eval = None
        self._required_ms = None

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

    # ---------------- main entry ----------------
    def feed(self, pcm16k_chunk: np.ndarray) -> list[TurnEvent]:
        x = np.asarray(pcm16k_chunk, dtype=np.float32).ravel()
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
            if len(frame) and float(np.sqrt(np.mean(frame * frame))) < self.energy_floor:
                p = 0.0
            ev = self._step(p, fs, fe)
            if ev is not None:
                events.append(ev)
        return events

    def _step(self, p: float, fs: int, fe: int) -> TurnEvent | None:
        th, nth = self.threshold, self.neg_threshold
        if not self.in_speech:
            if p >= th:
                if self._cand_start is None:
                    self._cand_start = fs
                self._cand_voiced += 1
                self._cand_gap = 0
                self._last_speech_end = fe
            elif self._cand_start is not None:
                if p < nth:
                    self._cand_gap += 1
                    if self._cand_gap > 3:            # >~100 ms gap: candidate was noise
                        self._cand_start, self._cand_voiced, self._cand_gap = None, 0, 0
            if self._cand_start is not None and self._cand_voiced * FRAME_MS >= self.min_speech_ms:
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
            audio = self.ring.read(self._utt_start, fe)
            self._p_complete = self._smart.predict(audio)
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
