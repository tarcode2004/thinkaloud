"""Shared helpers for engine tests: lazily-loaded models (once per process) and Kokoro test speech."""
from __future__ import annotations

import functools
import os
import re
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import pytest  # noqa: E402

SR = 16000


def has_cuda() -> bool:
    try:
        import torch
        return torch.cuda.is_available()
    except Exception:
        return False


requires_gpu = pytest.mark.skipif(not has_cuda(), reason="needs CUDA GPU")


@functools.lru_cache(maxsize=1)
def tts():
    from ort.tts import TTS
    t = TTS()
    t.warmup()
    return t


@functools.lru_cache(maxsize=1)
def stt():
    from ort.stt import STT
    s = STT()
    s.warmup()
    return s


@functools.lru_cache(maxsize=64)
def speech16k(text: str, voice: str = "af_heart", language: str = "en") -> np.ndarray:
    """Kokoro speech for `text`, resampled to 16 kHz (cached)."""
    from ort.audio import resample
    t = tts()
    kv, key = t.resolve(voice, language)

    def synth():
        import torch
        torch.manual_seed(0)       # Kokoro's harmonic source is random: keep test audio reproducible
        return t._synth(text, kv, key, 1.0, None)
    a, _ = t._executor.submit(synth).result()
    return resample(a, 24000, SR)


def pad(x: np.ndarray, before_s: float = 1.0, after_s: float = 3.0, noise_db: float | None = None,
        seed: int = 0) -> np.ndarray:
    y = np.concatenate([np.zeros(int(before_s * SR), np.float32), x, np.zeros(int(after_s * SR), np.float32)])
    if noise_db is not None:
        rng = np.random.default_rng(seed)
        y = y + (rng.standard_normal(len(y)) * 10 ** (noise_db / 20)).astype(np.float32)
    return y.astype(np.float32)


def feed_stream(td, x: np.ndarray, chunk: int = 320):
    """Feed x in `chunk`-sample pieces (20 ms default); return all TurnEvents."""
    ev = []
    for i in range(0, len(x), chunk):
        ev.extend(td.feed(x[i:i + chunk]))
    return ev


def _words(s: str) -> list[str]:
    return re.sub(r"[^\w\s']", " ", s.lower()).split()


def wer(ref: str, hyp: str) -> float:
    r, h = _words(ref), _words(hyp)
    d = np.zeros((len(r) + 1, len(h) + 1), int)
    d[:, 0] = np.arange(len(r) + 1)
    d[0, :] = np.arange(len(h) + 1)
    for i in range(1, len(r) + 1):
        for j in range(1, len(h) + 1):
            d[i, j] = min(d[i - 1, j] + 1, d[i, j - 1] + 1, d[i - 1, j - 1] + (r[i - 1] != h[j - 1]))
    return d[len(r), len(h)] / max(1, len(r))


def pink_noise(n: int, db: float, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    w = np.fft.rfft(rng.standard_normal(n))
    f = np.arange(len(w))
    f[0] = 1
    y = np.fft.irfft(w / np.sqrt(f), n)
    y = y / (np.sqrt(np.mean(y * y)) + 1e-9) * 10 ** (db / 20)
    return y.astype(np.float32)


def clicks(n: int, every_s: float = 0.4, amp: float = 0.6, seed: int = 0) -> np.ndarray:
    """Keyboard-like transient clicks (5 ms decaying bursts)."""
    rng = np.random.default_rng(seed)
    y = np.zeros(n, np.float32)
    L = int(0.005 * SR)
    env = np.exp(-np.arange(L) / (L / 5)).astype(np.float32)
    for s in range(int(0.2 * SR), n - L, int(every_s * SR)):
        y[s:s + L] += amp * env * rng.standard_normal(L).astype(np.float32)
    return y


# ---------------------------------------------------------------- synthetic acoustics
BABBLE_TEXTS = [
    "The weather was nice yesterday and we went for a walk.", "Can you pass me the salt please, thank you.",
    "I think the meeting is at three in the afternoon.", "She bought a new car last week, a red one.",
    "We should probably leave soon or we will miss the train.", "Did you see the game last night, it was amazing.",
    "My sister is moving to Berlin next month for work.", "Let's order the pasta and maybe a salad to share."]
BABBLE_VOICES = ["af_bella", "am_onyx", "bf_emma", "am_michael", "af_sarah", "bm_george", "af_nicole", "am_adam"]


def babble(n: int, db: float, voices: int = 8) -> np.ndarray:
    """Cafe-like babble: `voices` overlapping Kokoro talkers (looped, offset), RMS `db` dBFS."""
    y = np.zeros(n, np.float32)
    for i in range(voices):
        a = speech16k(BABBLE_TEXTS[i], BABBLE_VOICES[i])
        a = np.tile(a, int(np.ceil((n + i * 2777) / len(a))) + 1)
        y += a[i * 2777:i * 2777 + n]
    return (y / (np.sqrt(np.mean(y * y)) + 1e-12) * 10 ** (db / 20)).astype(np.float32)


def room_echo(ref: np.ndarray, atten_db: float, delay_s: float, rt60: float = 0.4, seed: int = 0) -> np.ndarray:
    """What a mic hears of `ref` played on a speaker: delayed, reverberant, attenuated."""
    from scipy.signal import fftconvolve
    rng = np.random.default_rng(seed)
    n = int(0.5 * SR)
    t = np.arange(n) / SR
    h = rng.standard_normal(n) * np.exp(-6.9 * t / rt60) * 0.3
    h[0] = 1.0
    h /= np.sqrt(np.sum(h * h))
    e = fftconvolve(ref, h)[:len(ref)] * 10 ** (atten_db / 20)
    return np.concatenate([np.zeros(int(delay_s * SR)), e]).astype(np.float32)


def active_dbfs(x: np.ndarray) -> float:
    v = x[np.abs(x) > 0.005]
    return float(10 * np.log10(np.mean(v * v))) if len(v) else -200.0


def at_level(x: np.ndarray, db: float) -> np.ndarray:
    """Scale speech so its active level is `db` dBFS."""
    return (x * 10 ** ((db - active_dbfs(x)) / 20)).astype(np.float32)
