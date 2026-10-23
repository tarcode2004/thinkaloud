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


# ---------------------------------------------------------------- robustness (hardening pass)
@pytest.mark.parametrize("a,b", [(24000, 16000), (48000, 16000), (44100, 16000), (8000, 16000),
                                 (16000, 8000), (16000, 24000), (22050, 16000), (96000, 16000)])
@pytest.mark.parametrize("chunk", [1, 7, 13, 441, 1023])
def test_resampler_tiny_and_odd_chunks_match_oneshot(a, b, chunk):
    # regression: chunks smaller than the filter delay (e.g. 1-13 samples) produced extra
    # samples and misaligned output (errors up to 0.5 full scale)
    x = (np.random.default_rng(0).standard_normal(int(0.3 * a)) * 0.1).astype(np.float32)
    ref = resample(x, a, b)
    r = Resampler(a, b)
    y = np.concatenate([r.process(x[i:i + chunk]) for i in range(0, len(x), chunk)] + [r.flush()])
    assert len(y) == len(ref)
    assert np.abs(y - ref).max() < 1e-4
    # reusable after flush
    y2 = np.concatenate([r.process(x), r.flush()])
    assert np.abs(y2 - ref).max() < 1e-4


def test_resampler_44k1_tone_and_length():
    x = (0.5 * np.sin(2 * np.pi * 1000 * np.arange(44100) / 44100)).astype(np.float32)
    r = Resampler(44100, 16000)
    y = np.concatenate([r.process(x[i:i + 441]) for i in range(0, len(x), 441)] + [r.flush()])
    assert len(y) == 16000
    spec = np.abs(np.fft.rfft(y))
    assert abs(np.argmax(spec) - 1000) <= 1


def test_nan_inf_are_sanitised():
    bad = np.array([0.1, np.nan, np.inf, -np.inf, 0.2], np.float32)
    assert np.array_equal(float32_to_int16(bad), np.array([3277, 0, 0, 0, 6553], np.int16))
    r = Resampler(24000, 16000)
    y = np.concatenate([r.process(np.concatenate([bad, np.zeros(2000, np.float32)])), r.flush()])
    assert np.isfinite(y).all()
    assert np.isfinite(resample(bad, 48000, 16000)).all()


def test_int16_clipping_saturates():
    x = np.array([1.5, -1.5, 1.0, -1.0, 0.99999], np.float32)
    assert list(float32_to_int16(x)) == [32767, -32768, 32767, -32767, 32767]


def test_g711_bit_exact_and_roundtrip():
    from ort.audio import g711_decode, g711_encode
    allc = bytes(range(256))
    # all 256 codes decode and re-encode to themselves (except the duplicate zero codes)
    for ulaw in (True, False):
        dec = g711_decode(allc, ulaw)
        assert dec.dtype == np.float32 and np.abs(dec).max() <= 1.0
        re = g711_encode(dec, ulaw)
        same = sum(a == b for a, b in zip(allc, re))
        assert same >= 254, (ulaw, same)
    try:
        import audioop  # stdlib until 3.13: bit-exact reference
    except ImportError:
        return
    pcm = np.arange(-32768, 32768, dtype=np.int32).astype("<i2")
    assert g711_encode(pcm, True) == audioop.lin2ulaw(pcm.tobytes(), 2)
    assert g711_encode(pcm, False) == audioop.lin2alaw(pcm.tobytes(), 2)
    assert np.array_equal(float32_to_int16(g711_decode(allc, True)) // 1,
                          float32_to_int16(int16_to_float32(audioop.ulaw2lin(allc, 2))))


def test_g711_8k_speechlike_roundtrip_snr():
    from ort.audio import g711_decode, g711_encode
    t = np.arange(8000) / 8000
    x = (0.3 * np.sin(2 * np.pi * 300 * t) * (0.5 + 0.5 * np.sin(2 * np.pi * 3 * t))).astype(np.float32)
    for ulaw in (True, False):
        y = g711_decode(g711_encode(x, ulaw), ulaw)
        snr = 10 * np.log10(np.sum(x * x) / np.sum((x - y) ** 2))
        assert snr > 30, (ulaw, snr)
    # 8 kHz G.711 -> 16 kHz engine rate in odd chunks keeps the length exact
    r = Resampler(8000, 16000)
    raw = g711_encode(x, True)
    y = np.concatenate([r.process(g711_decode(raw[i:i + 161], True)) for i in range(0, len(raw), 161)] + [r.flush()])
    assert len(y) == 16000
