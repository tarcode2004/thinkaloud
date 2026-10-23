"""GPU contention: many concurrent STT / TTS requests (several sessions at once)."""
import asyncio
import threading
import time

import numpy as np
import pytest

from engine_common import SR, pad, requires_gpu, speech16k, stt, tts, wer

pytestmark = requires_gpu

TEXTS = [
    "I would like to book a table for two people tomorrow evening.",
    "What time does the store close today?",
    "Please send the report to my manager before Friday.",
    "The quick brown fox jumps over the lazy dog.",
    "Can you remind me to call my sister at six?",
    "How much does a return ticket to Berlin cost?",
    "Could you turn the music down a little bit?",
    "Turn off the lights in the kitchen please.",
]


def _pct(xs, q):
    return float(np.percentile(np.asarray(xs), q))


async def _one_stt(s, x, prompt):
    t0 = time.perf_counter()
    r = await s.transcribe(x, "en", prompt=prompt)   # distinct prompt: no cache hits
    return (time.perf_counter() - t0) * 1000, r


async def _one_tts(t, text):
    t0, first = time.perf_counter(), None
    n = 0
    async for c in t.stream(_words(text), "alloy"):
        if first is None:
            first = (time.perf_counter() - t0) * 1000
        n += len(c)
    return first, (time.perf_counter() - t0) * 1000, n


async def _words(text):
    for w in text.split(" "):
        yield w + " "


def _load(conc: int, rounds: int = 3):
    s, t = stt(), tts()
    xs = [pad(speech16k(tx), 0.3, 0.3) for tx in TEXTS]

    async def go():
        stt_ms, ttfa, tts_total, bad = [], [], [], []
        for r in range(rounds):
            jobs = []
            for i in range(conc):
                k = (i + r) % len(TEXTS)
                jobs.append(_one_stt(s, xs[k], f"round {r} job {i} {time.perf_counter()}"))
                jobs.append(_one_tts(t, TEXTS[k]))
            res = await asyncio.gather(*jobs)
            for i in range(conc):
                k = (i + r) % len(TEXTS)
                ms, text = res[2 * i]
                stt_ms.append(ms)
                if wer(TEXTS[k], text) > 0.2:
                    bad.append((TEXTS[k], text))
                f, tot, n = res[2 * i + 1]
                ttfa.append(f)
                tts_total.append(tot)
                if n < 0.5 * 24000:
                    bad.append((TEXTS[k], f"tts produced {n} samples"))
        return stt_ms, ttfa, tts_total, bad
    return asyncio.run(go())


@pytest.mark.parametrize("conc", [1, 4, 8])
def test_concurrent_stt_and_tts_are_correct_and_degrade_gracefully(conc, capsys):
    stt_ms, ttfa, tts_total, bad = _load(conc)
    assert not bad, bad[:3]                       # no cross-talk / CUDA-graph races
    with capsys.disabled():
        print(f"\n[load x{conc}] STT p50 {_pct(stt_ms, 50):.0f} p95 {_pct(stt_ms, 95):.0f} ms | "
              f"TTS first audio p50 {_pct(ttfa, 50):.0f} p95 {_pct(ttfa, 95):.0f} ms | "
              f"TTS total p50 {_pct(tts_total, 50):.0f} p95 {_pct(tts_total, 95):.0f} ms")
    # one GPU worker per model: latency grows ~linearly with the queue, never explodes
    assert _pct(stt_ms, 95) < 250 * conc + 400
    assert _pct(ttfa, 95) < 150 * conc + 400


def test_lazy_load_while_other_model_runs():
    """--no-warmup: Whisper loads and captures its CUDA graphs while Kokoro is synthesising.
    Used to invalidate the capture (permanent slow eager decoding) and break Kokoro
    ('expected scalar type Float but found Half' while transformers switched the default dtype)."""
    from ort.stt import STT
    t = tts()
    kv, key = t.resolve("alloy", "en")
    stop, errors, runs = threading.Event(), [], [0]

    def background():
        while not stop.is_set():
            try:
                t._executor.submit(t._synth, "This sentence keeps the GPU busy for a while.", kv, key, 1.0, None).result()
                runs[0] += 1
            except Exception as e:     # pragma: no cover - the regression
                errors.append(repr(e))
    th = threading.Thread(target=background)
    th.start()
    try:
        s = STT()
        x = pad(speech16k(TEXTS[1]), 0.3, 0.3)
        out = s.transcribe_sync(x, "en")
        part = asyncio.run(s.transcribe_full(x, None, "lazy", partial=True)).text
    finally:
        stop.set()
        th.join()
    assert not errors, errors[:2]
    assert runs[0] > 0
    assert s.fw.use_graphs, "CUDA graph capture was invalidated"
    assert wer(TEXTS[1], out) <= 0.15 and wer(TEXTS[1], part) <= 0.2
    del s
