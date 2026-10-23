import numpy as np
import pytest

import engine_common  # noqa: F401  (sys.path)
from ort.audio import (RingBuffer, Resampler, b64_to_float32, b64_to_int16, dbfs, float32_to_b64,
                       float32_to_int16, int16_to_b64, int16_to_float32, pcm16_bytes_to_float32,
                       float32_to_pcm16_bytes, resample)


def test_int16_float_roundtrip():
    x = np.array([-32768, -1, 0, 1, 32767], dtype=np.int16)
    f = int16_to_float32(x)
    assert f.dtype == np.float32 and f.min() >= -1 and f.max() < 1
    assert np.abs(float32_to_int16(f).astype(int) - x.astype(int)).max() <= 1
    assert float32_to_int16(np.array([2.0, -2.0], np.float32)).tolist() == [32767, -32768]


def test_b64_roundtrip():
    x = (np.sin(np.arange(2400) / 10) * 0.5).astype(np.float32)
    s = float32_to_b64(x)
    y = b64_to_float32(s)
    assert np.abs(x - y).max() < 1e-4
    i = float32_to_int16(x)
    assert np.array_equal(b64_to_int16(int16_to_b64(i)), i)
    assert np.allclose(pcm16_bytes_to_float32(float32_to_pcm16_bytes(x)), x, atol=1e-4)
    assert len(pcm16_bytes_to_float32(b"\x00\x01\x02")) == 1   # odd byte tolerated


@pytest.mark.parametrize("a,b", [(48000, 16000), (24000, 16000), (16000, 24000), (24000, 48000),
                                 (48000, 24000), (8000, 16000), (16000, 16000)])
def test_resample_lengths_and_streaming_matches_oneshot(a, b):
    t = np.arange(a) / a
    x = (0.5 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
    ref = resample(x, a, b)
    assert len(ref) == b
    r = Resampler(a, b)
    rng = np.random.default_rng(1)
    out, i = [], 0
    while i < len(x):
        n = int(rng.integers(1, 1200))
        out.append(r.process(x[i:i + n]))
        i += n
    out.append(r.flush())
    y = np.concatenate(out)
    assert len(y) == len(ref)
    assert np.abs(y - ref)[100:-100].max() < 1e-4


def test_resample_preserves_tone():
    x = (0.5 * np.sin(2 * np.pi * 1000 * np.arange(48000) / 48000)).astype(np.float32)
    y = resample(x, 48000, 16000)
    spec = np.abs(np.fft.rfft(y))
    assert abs(np.argmax(spec) * 16000 / len(y) - 1000) < 2
    assert abs(dbfs(y) - dbfs(x)) < 0.2


def test_ring_buffer():
    rb = RingBuffer(10)
    rb.write(np.arange(7))
    rb.write(np.arange(7, 15))
    assert rb.total == 15 and len(rb) == 10 and rb.oldest == 5
    assert rb.read(5).tolist() == list(range(5, 15))
    assert rb.read(0, 8).tolist() == [5, 6, 7]       # clipped to what is still held
    assert rb.last(3).tolist() == [12, 13, 14]
    rb.write(np.arange(15, 40))                       # bigger than capacity
    assert rb.read(0).tolist() == list(range(30, 40))
    rb.write(np.arange(40, 43))
    assert rb.read(35, 42).tolist() == list(range(35, 42))
    rb.clear()
    assert rb.total == 0 and len(rb.read(0)) == 0
