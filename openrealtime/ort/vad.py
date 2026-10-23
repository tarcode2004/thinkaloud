"""Silero VAD (v5/v6 ONNX) streaming on 512-sample 16 kHz frames.

`VAD.feed(chunk)` accepts any chunk size, buffers internally, and returns one speech
probability per completed 32 ms frame. Runs on CPU via onnxruntime (~0.1 ms/frame).
One VAD instance per audio stream (it is stateful); the ONNX session is shared.
"""
from __future__ import annotations

import os
import threading

import numpy as np

FRAME = 512          # samples per frame @16 kHz (32 ms)
CONTEXT = 64         # Silero v5 context samples prepended to each frame
SR = 16000
FRAME_MS = FRAME * 1000 // SR  # 32

_session = None
_session_lock = threading.Lock()


def _model_path() -> str:
    import silero_vad
    return os.path.join(os.path.dirname(silero_vad.__file__), "data", "silero_vad.onnx")


def get_session():
    global _session
    with _session_lock:
        if _session is None:
            import onnxruntime as ort
            so = ort.SessionOptions()
            so.intra_op_num_threads = 1
            so.inter_op_num_threads = 1
            so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
            so.log_severity_level = 3
            _session = ort.InferenceSession(_model_path(), sess_options=so,
                                            providers=["CPUExecutionProvider"])
        return _session


class VAD:
    def __init__(self):
        self.sess = get_session()
        self._sr = np.array(SR, dtype=np.int64)
        self.reset()

    def reset(self) -> None:
        self._state = np.zeros((2, 1, 128), np.float32)
        self._context = np.zeros(CONTEXT, np.float32)
        self._buf = np.zeros(0, np.float32)
        self.frames = 0  # frames processed since reset

    def _run(self, frame: np.ndarray) -> float:
        x = np.concatenate([self._context, frame])[None, :]
        out, self._state = self.sess.run(None, {"input": x, "state": self._state, "sr": self._sr})
        self._context = frame[-CONTEXT:]
        self.frames += 1
        return float(out[0, 0])

    def feed(self, pcm16k: np.ndarray) -> list[float]:
        """Feed float32 16 kHz audio (any length). Returns probabilities for completed frames."""
        x = np.asarray(pcm16k, dtype=np.float32).ravel()
        buf = np.concatenate([self._buf, x]) if len(self._buf) else x
        n = len(buf) // FRAME
        probs = [self._run(buf[i * FRAME:(i + 1) * FRAME]) for i in range(n)]
        self._buf = buf[n * FRAME:].copy()
        return probs

    def prob(self, frame: np.ndarray) -> float:
        """Process exactly one 512-sample frame."""
        return self._run(np.asarray(frame, dtype=np.float32))
