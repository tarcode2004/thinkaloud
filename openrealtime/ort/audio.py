"""PCM helpers: int16 <-> float32, resampling between 48k/24k/16k, base64 pcm16, ring buffer.

All float audio in the engine is mono float32 in [-1, 1].
"""
from __future__ import annotations

import base64
import threading
from contextlib import contextmanager
from functools import lru_cache
from math import gcd

import numpy as np
from scipy.signal import resample_poly

__all__ = [
    "int16_to_float32", "float32_to_int16", "resample", "b64_to_float32", "float32_to_b64",
    "b64_to_int16", "int16_to_b64", "pcm16_bytes_to_float32", "float32_to_pcm16_bytes",
    "rms", "dbfs", "RingBuffer", "Resampler", "sanitize", "g711_encode", "g711_decode", "GPU_GATE",
    "PriorityExecutor",
]


def sanitize(x: np.ndarray) -> np.ndarray:
    """Replace NaN/inf with 0 (a single NaN would otherwise poison stateful models such as Silero
    for the rest of the stream). Returns `x` itself when it is already finite."""
    if x.size and not np.isfinite(x).all():
        x = np.nan_to_num(x, nan=0.0, posinf=0.0, neginf=0.0)
    return x


def int16_to_float32(x: np.ndarray | bytes | bytearray | memoryview) -> np.ndarray:
    if not isinstance(x, np.ndarray):
        x = np.frombuffer(x, dtype="<i2")
    return x.astype(np.float32) * (1.0 / 32768.0)


def float32_to_int16(x: np.ndarray) -> np.ndarray:
    x = sanitize(np.asarray(x, dtype=np.float32))
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
    x = sanitize(np.asarray(x, dtype=np.float32))
    if sr_in == sr_out or x.size == 0:
        return x
    up, down = _ratio(sr_in, sr_out)
    return resample_poly(x, up, down).astype(np.float32, copy=False)


class Resampler:
    """Streaming polyphase resampler for arbitrary chunk sizes (no boundary clicks).

    Overlap-save with explicit sample accounting: each call resamples [history + new] and emits
    exactly the output samples whose filter support is complete, so any chunking (even 1-sample
    chunks) gives the same samples as the one-shot `resample`. Adds a fixed latency of `delay`
    input samples (~1-4 ms); `flush()` drains it. Total output == ceil(total_in * sr_out / sr_in),
    the same length `resample` returns. Non-finite input samples are replaced by 0.
    """

    def __init__(self, sr_in: int, sr_out: int):
        self.sr_in, self.sr_out = sr_in, sr_out
        self.up, self.down = _ratio(sr_in, sr_out)
        half = int(np.ceil(10 * max(self.up, self.down) / self.up)) + 2   # filter half-length (input)
        self.delay = int(np.ceil(half / self.down) * self.down)
        self.reset()

    def reset(self):
        self._hist = np.zeros(2 * self.delay, np.float32)   # virtual zeros before the stream
        self._pending = np.zeros(0, np.float32)
        self._n_in = 0       # real input samples consumed (always a multiple of `down`)
        self._n_out = 0      # output samples emitted

    def process(self, x: np.ndarray) -> np.ndarray:
        x = sanitize(np.asarray(x, dtype=np.float32).ravel())
        if self.sr_in == self.sr_out:
            return x
        buf = np.concatenate([self._pending, x]) if len(self._pending) else x
        usable = (len(buf) // self.down) * self.down
        self._pending = buf[usable:].copy()
        if usable == 0:
            return np.zeros(0, np.float32)
        full = np.concatenate([self._hist, buf[:usable]])
        y = resample_poly(full, self.up, self.down)
        base = (self._n_in - len(self._hist)) * self.up // self.down   # abs. output index of y[0]
        self._n_in += usable
        end = max(self._n_out, (self._n_in - self.delay) * self.up // self.down)
        out = y[self._n_out - base:end - base]
        self._n_out = end
        self._hist = full[-2 * self.delay:]
        return out.astype(np.float32, copy=False)

    def flush(self) -> np.ndarray:
        if self.sr_in == self.sr_out:
            return np.zeros(0, np.float32)
        total = -(-(self._n_in + len(self._pending)) * self.up // self.down)   # ceil
        pad = (-(len(self._pending) + self.delay)) % self.down
        out = self.process(np.zeros(self.delay + pad + self.down, np.float32))
        out = out[:max(0, total - (self._n_out - len(out)))]
        self.reset()
        return out


# ---------------------------------------------------------------- G.711 (bit-exact with audioop)
_SEG_UEND = np.array([0x3F, 0x7F, 0xFF, 0x1FF, 0x3FF, 0x7FF, 0xFFF, 0x1FFF], np.int32)
_SEG_AEND = np.array([0x1F, 0x3F, 0x7F, 0xFF, 0x1FF, 0x3FF, 0x7FF, 0xFFF], np.int32)


def _ulaw_lut() -> np.ndarray:
    u = ~np.arange(256, dtype=np.int32) & 0xFF
    t = (((u & 0x0F) << 3) + 0x84) << ((u & 0x70) >> 4)
    return np.where(u & 0x80, 0x84 - t, t - 0x84).astype(np.int16)


def _alaw_lut() -> np.ndarray:
    a = np.arange(256, dtype=np.int32) ^ 0x55
    t = (a & 0x0F) << 4
    seg = (a & 0x70) >> 4
    t = np.where(seg == 0, t + 8, np.where(seg == 1, t + 0x108, (t + 0x108) << np.maximum(seg - 1, 0)))
    return np.where(a & 0x80, t, -t).astype(np.int16)


_ULAW_LUT, _ALAW_LUT = _ulaw_lut(), _alaw_lut()


def g711_decode(raw: bytes | bytearray | memoryview | np.ndarray, ulaw: bool = True) -> np.ndarray:
    """G.711 mu-law (ulaw=True, audio/pcmu) or A-law (audio/pcma) bytes -> float32 in [-1, 1]."""
    codes = raw if isinstance(raw, np.ndarray) else np.frombuffer(bytes(raw), np.uint8)
    return int16_to_float32((_ULAW_LUT if ulaw else _ALAW_LUT)[codes.astype(np.uint8)])


def g711_encode(x: np.ndarray, ulaw: bool = True) -> bytes:
    """float32 [-1, 1] (or int16) -> G.711 bytes. Out-of-range / NaN input is clipped / zeroed."""
    x = np.asarray(x)
    s = (x.astype(np.int32) if x.dtype == np.int16 else float32_to_int16(x).astype(np.int32))
    if ulaw:
        neg = s < 0
        v = s >> 2                                     # 14-bit, arithmetic shift like audioop
        v = np.where(neg, -v, v)
        v = np.minimum(v, 8159) + 0x21
        seg = np.searchsorted(_SEG_UEND, v)            # first seg with v <= end
        mask = np.where(neg, 0x7F, 0xFF)
        u = (np.minimum(seg, 7) << 4) | ((v >> (np.minimum(seg, 7) + 1)) & 0x0F)
        u = np.where(seg >= 8, 0x7F, u)
        return ((u ^ mask) & 0xFF).astype(np.uint8).tobytes()
    v = s >> 3                                         # 13-bit
    neg = v < 0
    mask = np.where(neg, 0x55, 0xD5)
    v = np.where(neg, -v - 1, v)
    seg = np.searchsorted(_SEG_AEND, v)
    sg = np.minimum(seg, 7)
    a = (sg << 4) | (np.where(sg < 2, v >> 1, v >> np.maximum(sg, 1)) & 0x0F)
    a = np.where(seg >= 8, 0x7F, a)
    return ((a ^ mask) & 0xFF).astype(np.uint8).tobytes()


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


class SharedExclusiveLock:
    """Readers-writer lock for the GPU models. Inference (Whisper decode, Kokoro synth) holds it
    shared, so STT and TTS still overlap; model loading and CUDA-graph capture hold it exclusive.
    Without it, a capture racing with Kokoro is invalidated (Whisper silently falls back to slow
    eager decoding for good) and Kokoro fails ('expected scalar type Float but found Half')
    while transformers temporarily switches the default dtype to load Whisper in fp16.
    Writers have priority; the exclusive holder may also take it shared (re-entrant)."""

    def __init__(self):
        self._cond = threading.Condition()
        self._readers = 0
        self._writer: int | None = None
        self._depth = 0
        self._waiting = 0

    @contextmanager
    def shared(self):
        me = threading.get_ident()
        with self._cond:
            if self._writer != me:
                while self._writer is not None or self._waiting:
                    self._cond.wait()
            self._readers += 1
        try:
            yield
        finally:
            with self._cond:
                self._readers -= 1
                self._cond.notify_all()

    @contextmanager
    def exclusive(self):
        me = threading.get_ident()
        with self._cond:
            if self._writer == me:
                self._depth += 1
            else:
                self._waiting += 1
                while self._writer is not None or self._readers:
                    self._cond.wait()
                self._waiting -= 1
                self._writer, self._depth = me, 1
        try:
            yield
        finally:
            with self._cond:
                self._depth -= 1
                if not self._depth:
                    self._writer = None
                self._cond.notify_all()


GPU_GATE = SharedExclusiveLock()


class PriorityExecutor:
    """Single worker thread running jobs by priority (lower first; FIFO within equal priority).

    Drop-in for `ThreadPoolExecutor(1)`: `submit(fn, *args, **kw)` runs at priority 1 and
    `loop.run_in_executor(ex, fn, ...)` works. `submit_prio(prio, fn, *args, key=None,
    supersede=False, **kw)` sets the priority (any sortable value, e.g. a tuple); with
    supersede=True, queued (not yet running) jobs with the same `key` are dropped first, their
    futures resolved with `dropped_result`. `drop(key)` drops queued jobs with that key.
    `urgent_waiting(than)` tells a running job whether something more important is queued
    (lets long low-priority work give up the GPU early)."""

    def __init__(self, name: str = "ort-gpu"):
        import concurrent.futures
        import heapq
        import itertools
        self._cf, self._heapq = concurrent.futures, heapq
        self._seq = itertools.count()
        self._heap: list = []
        self._cond = threading.Condition()
        self._shutdown = False
        self.counters = {"run": 0, "dropped": 0}
        self._thread = threading.Thread(target=self._worker, name=name, daemon=True)
        self._thread.start()

    def submit(self, fn, *args, **kw):
        return self.submit_prio(1, fn, *args, **kw)

    def submit_prio(self, prio, fn, *args, key=None, supersede: bool = False, dropped_result=None, **kw):
        fut = self._cf.Future()
        with self._cond:
            if self._shutdown:
                raise RuntimeError("executor shut down")
            if supersede and key is not None:
                self._drop_locked(key)
            self._heapq.heappush(self._heap, (prio, next(self._seq), fn, args, kw, fut, key, dropped_result))
            self._cond.notify()
        return fut

    def _drop_locked(self, key) -> int:
        keep, n = [], 0
        for item in self._heap:
            if item[6] == key:
                n += 1
                if item[5].set_running_or_notify_cancel():
                    item[5].set_result(item[7])
            else:
                keep.append(item)
        if n:
            self._heapq.heapify(keep)
            self._heap = keep
            self.counters["dropped"] += n
        return n

    def drop(self, key) -> int:
        with self._cond:
            return self._drop_locked(key)

    def urgent_waiting(self, than) -> bool:
        with self._cond:
            return bool(self._heap) and self._heap[0][0] < than

    def queued(self) -> int:
        with self._cond:
            return len(self._heap)

    def _worker(self):
        while True:
            with self._cond:
                while not self._heap and not self._shutdown:
                    self._cond.wait()
                if not self._heap:
                    return
                _, _, fn, args, kw, fut, _, _ = self._heapq.heappop(self._heap)
            if not fut.set_running_or_notify_cancel():
                continue
            self.counters["run"] += 1
            try:
                fut.set_result(fn(*args, **kw))
            except BaseException as e:
                fut.set_exception(e)

    def shutdown(self, wait: bool = True, **_):
        with self._cond:
            self._shutdown = True
            self._cond.notify_all()
        if wait and threading.current_thread() is not self._thread:
            self._thread.join()
