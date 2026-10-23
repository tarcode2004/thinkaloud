"""Cross-session scheduling of the shared STT/TTS executors (see bench/load_bench.py for numbers)."""
import asyncio
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["OPENREALTIME_LLM"] = "mock"

from fakes import RT, FakeLLM, FakeSTT, FakeTTS, make_engine, running_app, silence, tone, wait_until  # noqa: E402
from ort.session import SCHED, Engine  # noqa: E402
from ort.server import STATE  # noqa: E402

pytestmark = pytest.mark.asyncio


class SlowSTT(FakeSTT):
    """One shared FIFO 'GPU': partial and final calls are serialized, finals are slow."""

    def __init__(self):
        super().__init__(default="words")
        self.lock = asyncio.Lock()
        self.log = []

    async def transcribe(self, pcm, language=None, prompt=None, **_kw):
        async with self.lock:
            self.log.append("final")
            await asyncio.sleep(0.4)
            return "final words"

    async def transcribe_full(self, pcm, language=None, prompt=None, partial=False, **_kw):
        async with self.lock:
            self.log.append("partial")
            await asyncio.sleep(0.15)
            from types import SimpleNamespace
            return SimpleNamespace(text="partial words here", language="en")


async def test_partials_yield_to_a_pending_final_transcript():
    from ort.stt import StreamingTranscriber
    stt = SlowSTT()
    eng = make_engine(stt=stt, tts=FakeTTS(ms_per_char=1))
    eng = Engine(llm=eng.llm, tts=eng.tts, stt=stt, turn_factory=eng.turn_factory,
                 streaming_factory=lambda s, language=None, prompt=None: StreamingTranscriber(s, language=language, interval_ms=200))
    vad = {"type": "session.update", "session": {"audio": {"input": {"transcription": {"model": "whisper"},
                                                                     "turn_detection": {"type": "server_vad", "silence_duration_ms": 200,
                                                                                        "create_response": False}}}}}
    async with running_app(eng, partial_transcripts=True, speculative=False) as client:
        a, b = await RT.connect(client), await RT.connect(client)
        for rt in (a, b):
            await rt.wait_for("session.created")
            await rt.send(vad)
            await rt.wait_for("session.updated")
        before = dict(SCHED.counters)
        # A finishes a turn (its final transcript runs ~0.4 s) while B talks for a long time
        talk = asyncio.ensure_future(b.append(tone(4.0), realtime=True))
        await b.wait_for("input_audio_buffer.speech_started")
        await asyncio.sleep(1.0)                      # B's partials are running now
        await a.append(np.concatenate([tone(0.8), silence(0.4)]), realtime=False)
        await a.wait_for("input_audio_buffer.committed")
        await a.wait_for("conversation.item.input_audio_transcription.completed", timeout=5)
        talk.cancel()
        assert SCHED.counters["partials_skipped"] > before["partials_skipped"]
        # while A's final was pending, no partial of B was started in front of it
        i = stt.log.index("final")
        assert "partial" not in stt.log[i + 1:i + 2] or stt.log.count("final") > 1
        for rt in (a, b):
            await rt.close()


async def test_tts_read_ahead_is_bounded_by_playback():
    text = " ".join(f"This is sentence number {i}, and it goes on a bit." for i in range(30))
    tts = FakeTTS(ms_per_char=20)
    async with running_app(make_engine(llm=FakeLLM([text]), tts=tts), ws_audio_lead_ms=200, tts_ahead_s=1.0) as client:
        rt = await RT.connect(client)
        await rt.wait_for("session.created")
        await rt.send({"type": "session.update", "session": {"audio": {"input": {"turn_detection": None}}}})
        await rt.send({"type": "conversation.item.create", "item": {"type": "message", "role": "user",
                                                                     "content": [{"type": "input_text", "text": "go"}]}})
        await rt.send({"type": "response.create"})
        await rt.wait_for("response.output_audio.delta")
        await asyncio.sleep(1.5)
        sess = next(iter(client.app[STATE].sessions))
        m = sess.active.msg
        ahead = (m.total_samples - sess.output.played_samples(m.item["id"])) / 24000
        # bounded: ~ahead + one chunk (~1 s at 20 ms/char) + the TTS lookahead of 2 chunks
        assert ahead < 1.0 + 3 * 1.2, ahead
        assert len(tts.texts) < 12, len(tts.texts)        # not all 30+ clauses synthesized up front
        await rt.send({"type": "response.cancel"})
        await rt.wait_for("response.done")
        await rt.close()
