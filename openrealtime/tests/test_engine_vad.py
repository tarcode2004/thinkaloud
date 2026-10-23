import time

import numpy as np

from engine_common import pad, requires_gpu, speech16k, pink_noise
from ort.vad import FRAME, VAD


def test_silence_low_probability():
    v = VAD()
    p = v.feed(np.zeros(16000 * 2, np.float32))
    assert len(p) == 2 * 16000 // FRAME
    assert max(p) < 0.1


def test_noise_mostly_not_speech():
    v = VAD()
    p = np.array(v.feed(pink_noise(16000 * 4, -30)))
    assert (p > 0.5).mean() < 0.05


def test_arbitrary_chunking_is_equivalent():
    x = pink_noise(16000, -25, seed=3)
    a = VAD().feed(x)
    v, b, i = VAD(), [], 0
    rng = np.random.default_rng(0)
    while i < len(x):
        n = int(rng.integers(1, 900))
        b += v.feed(x[i:i + n])
        i += n
    assert len(a) == len(b) and np.allclose(a, b, atol=1e-6)


def test_per_frame_cost_is_small():
    v = VAD()
    x = pink_noise(16000 * 10, -30)
    t = time.perf_counter()
    n = len(v.feed(x))
    per = (time.perf_counter() - t) / n * 1000
    assert per < 1.0, f"{per:.3f} ms/frame"


@requires_gpu
def test_detects_kokoro_speech():
    s = speech16k("I would like to book a table for two people tomorrow evening.")
    x = pad(s, 1.0, 1.0)
    p = np.array(VAD().feed(x))
    lead = int(1.0 * 16000 / FRAME)
    assert p[:lead - 2].max() < 0.3
    assert (p[lead:lead + len(s) // FRAME] > 0.5).mean() > 0.7
