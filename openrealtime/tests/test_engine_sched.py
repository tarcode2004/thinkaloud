"""Cross-session GPU scheduling: finals before partials, first TTS clause before later ones."""
import asyncio
import threading
import time

import numpy as np
import pytest

from engine_common import SR, pad, requires_gpu, speech16k, stt, tts, wer
from ort.audio import PriorityExecutor


# ---------------------------------------------------------------- executor (no GPU)
def test_priority_order_fifo_within_priority():
    ex = PriorityExecutor()
    gate, order = threading.Event(), []
    ex.submit_prio(0, gate.wait)                       # occupy the worker
    futs = [ex.submit_prio(p, order.append, name) for p, name in
            [(2, "p1"), (0, "f1"), (1, "n1"), (2, "p2"), (0, "f2")]]
    gate.set()
    for f in futs:
        f.result(timeout=5)
    assert order == ["f1", "f2", "n1", "p1", "p2"]
    ex.shutdown()


def test_supersede_drop_and_urgent_waiting():
    ex = PriorityExecutor()
    gate, running = threading.Event(), threading.Event()
    ex.submit_prio(0, lambda: (running.set(), gate.wait()))
    assert running.wait(5)
    a = ex.submit_prio(2, lambda: "old", key="s1", supersede=True, dropped_result="dropped")
    b = ex.submit_prio(2, lambda: "new", key="s1", supersede=True, dropped_result="dropped")
    c = ex.submit_prio(2, lambda: "other", key="s2", supersede=True, dropped_result="dropped")
    assert a.result(timeout=1) == "dropped"            # resolved immediately, never ran
    assert ex.drop("s2") == 1 and c.result(timeout=1) == "dropped"
    assert not ex.urgent_waiting(2)
    ex.submit_prio(0, lambda: None)
    assert ex.urgent_waiting(2) and not ex.urgent_waiting(0)
    gate.set()
    assert b.result(timeout=5) == "new"
    ex.shutdown()


def test_run_in_executor_compatible():
    ex = PriorityExecutor()

    async def go():
        return await asyncio.get_running_loop().run_in_executor(ex, lambda a, b: a + b, 2, 3)
    assert asyncio.run(go()) == 5
    with pytest.raises(ZeroDivisionError):
        ex.submit(lambda: 1 / 0).result(timeout=5)
    ex.shutdown()


# ---------------------------------------------------------------- STT
LONG = ("So I was thinking that maybe we could go to the beach tomorrow if the weather is nice, "
        "and then have dinner at that little place near the harbour.")
SHORT = "What time does the store close today?"


@requires_gpu
def test_final_jumps_ahead_of_queued_partials_from_other_sessions():
    s = stt()
    xl = pad(speech16k(LONG), 0.2, 0.2)
    xs = pad(speech16k(SHORT), 0.3, 0.3)

    async def final_alone():
        t0 = time.perf_counter()
        r = await s.transcribe(xs, "en", prompt=f"alone {t0}")
        return (time.perf_counter() - t0) * 1000, r

    async def flooded():
        parts = [asyncio.ensure_future(s.transcribe_full(xl, "en", f"p{i} {time.perf_counter()}", partial=True,
                                                         stream=("sess", i))) for i in range(8)]
        await asyncio.sleep(0.03)                      # first partial is on the GPU
        t0 = time.perf_counter()
        r = await s.transcribe(xs, "en", prompt=f"urgent {t0}")
        ms = (time.perf_counter() - t0) * 1000
        pr = await asyncio.gather(*parts)
        return ms, r, pr

    alone_ms, r0 = asyncio.run(final_alone())
    ms, r, partials = asyncio.run(flooded())
    assert wer(SHORT, r) <= 0.15 and wer(SHORT, r0) <= 0.15
    # FIFO would wait for 8 partials (~8 x 100 ms); now at most the in-flight encoder pass
    assert ms < alone_ms + 150, (ms, alone_ms)
    assert sum(p.text != "" for p in partials) >= 6     # the queued partials still run afterwards


@requires_gpu
def test_stale_partials_of_a_stream_are_dropped():
    s = stt()
    xl = pad(speech16k(LONG), 0.2, 0.2)
    ex = s._executor
    gate = threading.Event()
    ex.submit_prio(0, gate.wait)

    async def go():
        a = asyncio.ensure_future(s.transcribe_full(xl[:SR * 3], "en", "x", partial=True, stream="u1"))
        b = asyncio.ensure_future(s.transcribe_full(xl[:SR * 4], "en", "x", partial=True, stream="u1"))
        c = asyncio.ensure_future(s.transcribe_full(xl[:SR * 5], "en", "y", partial=True, stream="u2"))
        await asyncio.sleep(0.05)
        f = asyncio.ensure_future(s.transcribe(xl, "en", prompt=f"final {time.perf_counter()}", stream="u2"))
        await asyncio.sleep(0.05)
        gate.set()
        return await asyncio.gather(a, b, c, f)
    a, b, c, f = asyncio.run(go())
    assert a.filtered == "superseded"                 # replaced by the newer partial of u1
    assert b.text and b.filtered is None
    assert c.filtered == "superseded"                 # u2's final made its partial moot
    assert wer(LONG, f) <= 0.15


@requires_gpu
def test_streaming_transcriber_survives_preemption():
    from ort.stt import StreamingTranscriber
    s = stt()
    x = pad(speech16k(LONG), 0.2, 0.3)
    stop = [False]

    async def urgent_load():
        xs = pad(speech16k(SHORT), 0.3, 0.3)
        while not stop[0]:
            await s.transcribe(xs, "en", prompt=f"bg {time.perf_counter()}")
            await asyncio.sleep(0.05)

    async def go():
        bg = asyncio.ensure_future(urgent_load())
        st = StreamingTranscriber(s, language="en")
        deltas = []
        for i in range(0, len(x), int(0.1 * SR)):
            st.feed(x[i:i + int(0.1 * SR)])
            d = await st.partial()
            if d:
                deltas.append(d)
        stop[0] = True
        await bg
        return deltas, await st.final()
    deltas, final = asyncio.run(go())
    assert wer(LONG, final) <= 0.15
    joined = "".join(deltas).lower().split()
    assert joined == final.lower().split()[:len(joined)] or wer(" ".join(joined), final) < 0.5


# ---------------------------------------------------------------- TTS
@requires_gpu
def test_first_clause_jumps_ahead_of_other_streams_later_clauses():
    t = tts()
    long_text = " ".join(["This is a long answer that keeps the speech engine busy for quite a while."] * 12)

    async def words(text, delay=0.0):
        for w in text.split(" "):
            if delay:
                await asyncio.sleep(delay)
            yield w + " "

    async def consume(text):
        async for _ in t.stream(words(text), "alloy", lookahead=8):
            await asyncio.sleep(0)

    async def ttfa(text):
        t0 = time.perf_counter()
        async for _ in t.stream(words(text), "ash"):
            return (time.perf_counter() - t0) * 1000

    async def go():
        base = await ttfa("Sure, I can do that for you.")
        bg = [asyncio.ensure_future(consume(long_text)) for _ in range(6)]
        await asyncio.sleep(0.6)                     # background streams are mid-answer
        loaded = await ttfa("Sure, I can do that for you.")
        for b in bg:
            b.cancel()
        await asyncio.gather(*bg, return_exceptions=True)
        return base, loaded
    base, loaded = asyncio.run(go())
    # without priority the new first clause waited behind ~6 queued clauses (~6 x 100 ms)
    assert loaded < base + 250, (base, loaded)


@requires_gpu
def test_round_robin_between_streams():
    t = tts()
    text = "One sentence here. Another sentence here. A third one now. And a fourth. Then a fifth."
    order = []

    async def words():
        yield text

    async def run(name):
        async for c in t.stream(words(), "alloy", lookahead=8):
            order.append((name, c.index))

    async def go():
        await asyncio.gather(run("a"), run("b"), run("c"))
    asyncio.run(go())
    # clause k of every stream is produced before clause k+1 of any (allowing one in flight)
    by = {n: [i for m, i in order if m == n] for n in "abc"}
    assert all(len(v) >= 4 for v in by.values())
    pos = {(n, i): k for k, (n, i) in enumerate(order)}
    for k in range(1, 4):
        assert max(pos[(n, k)] for n in "abc") < min(pos[(n, k + 1)] for n in "abc") + 3
