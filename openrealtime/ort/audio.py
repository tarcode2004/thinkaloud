"""PCM helpers: int16 <-> float32, resampling between 48k/24k/16k, base64 pcm16, ring buffer.

All float audio in the engine is mono float32 in [-1, 1].
"""
from __future__ import annotations

import base64
from functools import lru_cache
from math import gcd

import numpy as np
from scipy.signal import resample_poly

__all__ = [
    "int16_to_float32", "float32_to_int16", "resample", "b64_to_float32", "float32_to_b64",
    "b64_to_int16", "int16_to_b64", "pcm16_bytes_to_float32", "float32_to_pcm16_bytes",
    "rms", "dbfs", "RingBuffer", "Resampler",
]


def int16_to_float32(x: np.ndarray | bytes | bytearray | memoryview) -> np.ndarray:
    if not isinstance(x, np.ndarray):
        x = np.frombuffer(x, dtype="<i2")
    return x.astype(np.float32) * (1.0 / 32768.0)


def float32_to_int16(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, dtype=np.float32)
    return np.clip(np.rint(x * 32767.0), -32768, 32767).astype("<i2")


def pcm16_bytes_to_float32(b: bytes | bytearray | memoryview) -> np.ndarray:
    if len(b) % 2:
        b = bytes(b)[:-1]
    return int16_to_float32(np.frombuffer(b, dtype="<i2"))


def float32_to_pcm16_bytes(x: np.ndarray) -> bytes:
    return float32_to_int16(x).tobytes()


def b64_to_int16(s: str) -> np.ndarray:
    b = base64.b64decode(s)
    if len(b) % 2:
        b = b[:-1]
    return np.frombuffer(b, dtype="<i2")


def int16_to_b64(x: np.ndarray) -> str:
    return base64.b64encode(np.asarray(x, dtype="<i2").tobytes()).decode("ascii")


def b64_to_float32(s: str) -> np.ndarray:
    return int16_to_float32(b64_to_int16(s))


def float32_to_b64(x: np.ndarray) -> str:
    return base64.b64encode(float32_to_pcm16_bytes(x)).decode("ascii")


@lru_cache(maxsize=32)
def _ratio(sr_in: int, sr_out: int) -> tuple[int, int]:
    g = gcd(sr_in, sr_out)
    return sr_out // g, sr_in // g


def resample(x: np.ndarray, sr_in: int, sr_out: int) -> np.ndarray:
    """One-shot polyphase resample (good quality, Kaiser window). Use `Resampler` for streams."""
    x = np.asarray(x, dtype=np.float32)
    if sr_in == sr_out or x.size == 0:
        return x
    up, down = _ratio(sr_in, sr_out)
    return resample_poly(x, up, down).astype(np.float32, copy=False)


class Resampler:
    """Streaming polyphase resampler for arbitrary chunk sizes (no boundary clicks).

    Overlap-save: each call resamples [history + new] and keeps only the output region whose
    filter support is complete. Adds a fixed latency of `delay` input samples (~1-4 ms);
    `flush()` drains it. Total output length == round(total_in * sr_out / sr_in).
    """

    def __init__(self, sr_in: int, sr_out: int):
        self.sr_in, self.sr_out = sr_in, sr_out
        self.up, self.down = _ratio(sr_in, sr_out)
        half = int(np.ceil(10 * max(self.up, self.down) / self.up)) + 2   # filter half-length (input)
        self.delay = int(np.ceil(half / self.down) * self.down)
        self.reset()

    def reset(self):
        self._hist = np.zeros(2 * self.delay, np.float32)
        self._pending = np.zeros(0, np.float32)
        self._first = True

    def process(self, x: np.ndarray) -> np.ndarray:
        x = np.asarray(x, dtype=np.float32).ravel()
        if self.sr_in == self.sr_out:
            return x
        buf = np.concatenate([self._pending, x]) if len(self._pending) else x
        usable = (len(buf) // self.down) * self.down
        self._pending = buf[usable:].copy()
        if usable == 0:
            return np.zeros(0, np.float32)
        full = np.concatenate([self._hist, buf[:usable]])
        y = resample_poly(full, self.up, self.down)
        a = (len(self._hist) - (0 if self._first else self.delay)) * self.up // self.down
        b = (len(full) - self.delay) * self.up // self.down
        self._hist = full[-2 * self.delay:]
        self._first = False
        return y[a:b].astype(np.float32, copy=False)

    def flush(self) -> np.ndarray:
        if self.sr_in == self.sr_out:
            return np.zeros(0, np.float32)
        n_pend = len(self._pending)
        pad = (-(n_pend + self.delay)) % self.down
        out = self.process(np.zeros(self.delay + pad, np.float32))
        # trim the zero padding we added beyond real input
        real = int(round((n_pend) * self.up / self.down)) + self.delay * self.up // self.down
        out = out[:max(0, real)]
        self.reset()
        return out


def rms(x: np.ndarray) -> float:
    x = np.asarray(x, dtype=np.float32)
    return float(np.sqrt(np.mean(x * x))) if x.size else 0.0


def dbfs(x: np.ndarray) -> float:
    r = rms(x)
    return 20.0 * np.log10(r) if r > 1e-10 else -200.0


class RingBuffer:
    """Fixed-capacity float32 ring buffer that tracks the absolute sample position.

    `total` is the number of samples ever written; `read(start_abs, end_abs)` returns the
    samples between two absolute positions if they are still held.
    """

    def __init__(self, capacity: int):
        self.capacity = int(capacity)
        self._buf = np.zeros(self.capacity, np.float32)
        self.total = 0

    def __len__(self) -> int:
        return min(self.total, self.capacity)

    def write(self, x: np.ndarray) -> None:
        x = np.asarray(x, dtype=np.float32).ravel()
        n = len(x)
        if n == 0:
            return
        if n >= self.capacity:
            self._buf[:] = x[-self.capacity:]
            self.total += n
            # normalise layout so that position total % cap is the write head
            head = self.total % self.capacity
            self._buf = np.roll(self._buf, head)
            return
        head = self.total % self.capacity
        k = min(n, self.capacity - head)
        self._buf[head:head + k] = x[:k]
        if k < n:
            self._buf[:n - k] = x[k:]
        self.total += n

    @property
    def oldest(self) -> int:
        return max(0, self.total - self.capacity)

    def read(self, start: int, end: int | None = None) -> np.ndarray:
        end = self.total if end is None else min(end, self.total)
        start = max(start, self.oldest)
        if end <= start:
            return np.zeros(0, np.float32)
        n = end - start
        s = start % self.capacity
        if s + n <= self.capacity:
            return self._buf[s:s + n].copy()
        k = self.capacity - s
        return np.concatenate([self._buf[s:], self._buf[:n - k]])

    def last(self, n: int) -> np.ndarray:
        return self.read(self.total - n)

    def clear(self) -> None:
        self.total = 0
