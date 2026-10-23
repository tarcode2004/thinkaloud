"""Engine latency benchmark (no network, no LLM).

    .venv/bin/python bench/engine_bench.py [--n 20]

Prints p50/p95 for: Silero VAD per 32 ms frame, smart-turn v3 inference, TurnDetector cost per
second of audio, Whisper STT on 1/3/6/10 s (final + partial modes), Kokoro TTS time-to-first-audio
for short/long replies (instant text and a 50 tok/s simulated LLM), and TTS real-time factor.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

from ort.audio import resample  # noqa: E402

SR = 16000


def pct(xs):
    xs = np.asarray(xs, dtype=float)
    return f"p50 {np.percentile(xs, 50):8.2f} ms   p95 {np.percentile(xs, 95):8.2f} ms   (n={len(xs)})"


def row(name, xs):
    print(f"  {name:<38s} {pct(xs)}")


SENT = ("The quick brown fox jumps over the lazy dog, and then it runs into the forest where nobody "
        "can find it. After a while it comes back home, tired but happy, and falls asleep by the fire.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=20)
    args = ap.parse_args()
    n = args.n

    import torch
    print(f"torch {torch.__version__}  cuda={torch.cuda.is_available()}  "
          f"{torch.cuda.get_device_name(0) if torch.cuda.is_available() else ''}")

    # ---------------- TTS (also produces the test speech) ----------------
    from ort.tts import TTS
    tts = TTS()
    t = time.perf_counter()
    tts.warmup()
    print(f"\nTTS warmup {time.perf_counter() - t:.1f}s")
    kv, key = tts.resolve("alloy", "en")
    speech24, _ = tts._executor.submit(tts._synth, SENT, kv, key, 1.0, None).result()
    speech = resample(speech24, 24000, SR)
    long_speech = np.concatenate([speech, speech])

    # ---------------- VAD ----------------
    from ort.vad import FRAME, VAD
    print("\nVAD (Silero v5 ONNX, CPU, 1 thread)")
    v = VAD()
    x = np.concatenate([speech] * 3)
    per = []
    for i in range(0, len(x) - FRAME, FRAME):
        t = time.perf_counter()
        v.feed(x[i:i + FRAME])
        per.append((time.perf_counter() - t) * 1000)
    row("per 32 ms frame", per)

    # ---------------- smart-turn ----------------
    from ort.turn import SmartTurn, TurnDetector
    print("\nsmart-turn v3.2 (ONNX CPU, 4 threads, incl. features)")
    st = SmartTurn()
    for d in (2, 8):
        a = long_speech[: d * SR]
        st.predict(a)
        row(f"{d} s window", [(lambda: (st.predict(a), st.last_ms)[1])() for _ in range(n)])

    print("\nTurnDetector CPU cost per second of audio (20 ms chunks)")
    for cfg in ({"type": "server_vad"}, {"type": "semantic_vad", "eagerness": "medium"}):
        costs = []
        stream = np.concatenate([np.zeros(SR, np.float32), speech, np.zeros(SR * 5, np.float32)])
        for _ in range(3):
            td = TurnDetector(cfg)
            t = time.perf_counter()
            for i in range(0, len(stream), 320):
                td.feed(stream[i:i + 320])
            costs.append((time.perf_counter() - t) * 1000 / (len(stream) / SR))
        row(cfg.get("eagerness", cfg["type"]), costs)

    # ---------------- STT ----------------
    from ort.stt import STT
    stt = STT()
    t = time.perf_counter()
    stt.warmup()
    print(f"\nSTT whisper-large-v3-turbo fp16 (CUDA graphs)  warmup {time.perf_counter() - t:.1f}s")
    for d in (1, 3, 6, 10):
        a = long_speech[: d * SR]
        for partial in (False, True):
            ts, txt = [], ""
            for i in range(n):
                y = a + np.float32(1e-7 * (i + 1))    # defeat the result cache
                r = stt._executor.submit(stt._transcribe_sync, y, "en", None, False, partial).result()
                ts.append(r.ms)
                txt = r.text
            row(f"{d:>2d} s {'partial' if partial else 'final'} (bucket {r.bucket_s}s, {r.tokens} tok)", ts)
        print(f"        -> {txt[:90]}")
    a = long_speech[: 3 * SR]
    ts = []
    for i in range(n):
        y = a + np.float32(1e-7 * (i + 1))
        r = stt._executor.submit(stt._transcribe_sync, y, None, None, False, False).result()
        ts.append(r.ms)
    row(" 3 s final, language auto-detect", ts)

    # ---------------- TTS latency ----------------
    print("\nTTS Kokoro-82M (GPU) time-to-first-audio")
    replies = {
        "short": "Sure, no problem.",
        "medium": "Sure, I can help you with that. What time would you like the table for?",
        "long": ("Absolutely. The restaurant opens at 5:30 pm, and a table for two usually costs about $40. "
                 "I can book it for tomorrow evening, and I'll send you a confirmation by email. "
                 "Is there anything else you would like me to arrange?"),
        "no-early-clause": "I think the best option for you would be the second one because it is cheaper.",
    }

    async def ttfa(text, tok_rate=None):
        async def gen():
            for w in text.split(" "):
                if tok_rate:
                    await asyncio.sleep(1 / tok_rate)
                yield w + " "
        t0 = time.perf_counter()
        first = None
        dur = 0.0
        async for c in tts.stream(gen(), "alloy"):
            if first is None:
                first = (time.perf_counter() - t0) * 1000
            dur += c.duration
        return first, (time.perf_counter() - t0) * 1000, dur

    for name, text in replies.items():
        for rate in (None, 50):
            res = [asyncio.run(ttfa(text, rate)) for _ in range(max(5, n // 2))]
            label = f"{name:<15s} {'instant' if rate is None else str(rate) + ' w/s LLM'}"
            row(label, [r[0] for r in res])
        f, total, dur = res[-1]
        print(f"        -> {dur:.1f} s of audio, all synthesized after {total:.0f} ms")

    print("\nTTS throughput")
    ts = []
    for _ in range(5):
        t = time.perf_counter()
        a, _ = tts._executor.submit(tts._synth, SENT, kv, key, 1.0, None).result()
        ts.append((time.perf_counter() - t) * 1000)
    row(f"{len(a) / 24000:.1f} s sentence synth", ts)
    print(f"  real-time factor ~{np.median(ts) / 1000 / (len(a) / 24000):.3f}")
    for lang, txt in (("es", "Hola, ¿cómo estás? Me alegro de verte."), ("de", "Guten Tag, wie geht es Ihnen heute?")):
        kv2, key2 = tts.resolve("alloy", lang)
        tts._executor.submit(tts._synth, txt, kv2, key2, 1.0, None).result()
        ts = []
        for _ in range(5):
            t = time.perf_counter()
            tts._executor.submit(tts._synth, txt, kv2, key2, 1.0, None).result()
            ts.append((time.perf_counter() - t) * 1000)
        row(f"{lang} ({kv2}, {key2}) sentence", ts)


if __name__ == "__main__":
    main()
