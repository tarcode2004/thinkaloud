"""Echo of the assistant's own voice in the mic must not barge in (WS client without AEC).

Real Kokoro TTS + real TurnDetector; the client plays every output_audio.delta back into its
"mic" attenuated and delayed, in real time. With the echo gate the response finishes; without
it the echo triggers speech_started and cancels the response.
"""
from __future__ import annotations

import asyncio
import base64
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(__file__))
from engine_common import has_cuda, speech16k, tts  # noqa: E402
from fakes import RT, FakeLLM, FakeSTT, running_app  # noqa: E402

from ort.audio import resample  # noqa: E402
from ort.session import Engine  # noqa: E402
from ort.turn import TurnDetector  # noqa: E402

pytestmark = [pytest.mark.asyncio, pytest.mark.skipif(not has_cuda(), reason="needs the GPU engine")]

REPLY = "Thanks for waiting. I found three lamps that match, and the cheapest one costs forty dollars."
VAD = {"type": "session.update", "session": {"audio": {"input": {"turn_detection": {
    "type": "server_vad", "silence_duration_ms": 500, "create_response": False, "interrupt_response": True}}}}}


def _engine(llm):
    return Engine(llm=llm, tts=tts(), stt=FakeSTT(default="hello"), turn_factory=lambda cfg: TurnDetector(cfg), name="echo")


async def _loopback(rt: RT, gain_db: float, delay_ms: int, stop: asyncio.Event, extra: np.ndarray | None = None):
    """Play output deltas back as mic input (24 kHz pcm16), in real time, plus optional user speech."""
    gain = 10 ** (gain_db / 20)
    seen = 0
    pending = np.zeros(int(24000 * delay_ms / 1000), np.float32)
    user = extra
    while not stop.is_set():
        for e in rt.events[seen:]:
            if e["type"] == "response.output_audio.delta":
                x = np.frombuffer(base64.b64decode(e["delta"]), "<i2").astype(np.float32) / 32768
                pending = np.concatenate([pending, x * gain])
        seen = len(rt.events)
        n = 480  # 20 ms
        chunk = pending[:n] if pending.size >= n else np.concatenate([pending, np.zeros(n - pending.size, np.float32)])
        pending = pending[n:]
        if user is not None and user.size:
            u, user = user[:n], user[n:]
            chunk = chunk.copy()
            chunk[:u.size] += u
        c = np.clip(chunk * 32767, -32768, 32767).astype("<i2").tobytes()
        await rt.send({"type": "input_audio_buffer.append", "audio": base64.b64encode(c).decode()})
        await asyncio.sleep(0.02)


async def _run(echo_gate: bool, gain_db: float = -15, user_speech: bool = False) -> list[str]:
    llm = FakeLLM()
    llm.push(REPLY)
    async with running_app(_engine(llm), echo_gate=echo_gate, ws_audio_lead_ms=0) as client:
        rt = await RT.connect(client)
        await rt.wait_for("session.created")
        await rt.send(VAD)
        await rt.wait_for("session.updated")
        stop = asyncio.Event()
        user = None
        if user_speech:   # the user talks over the echo, starting ~1.5 s into the reply
            s = resample(speech16k("Wait, stop, I have a question."), 16000, 24000)
            user = np.concatenate([np.zeros(int(24000 * 1.5), np.float32), s])
        loop = asyncio.ensure_future(_loopback(rt, gain_db, 120, stop, user))
        await asyncio.sleep(0.6)           # let the detector see some room tone first
        await rt.send({"type": "conversation.item.create", "item": {"type": "message", "role": "user",
                                                                     "content": [{"type": "input_text", "text": "lamps?"}]}})
        await rt.send({"type": "response.create"})
        done = await rt.wait_for("response.done", timeout=20)
        stop.set()
        await loop
        types = [e["type"] for e in rt.events]
        await rt.close()
        return types + [f"status:{done['response']['status']}"]


async def test_echo_does_not_barge_in_with_gate():
    types = await _run(echo_gate=True)
    assert "input_audio_buffer.speech_started" not in types, types
    assert "status:completed" in types


async def test_echo_barges_in_without_gate():
    # Documents why the gate exists: the same loop without it interrupts itself.
    types = await _run(echo_gate=False)
    assert "input_audio_buffer.speech_started" in types


async def test_user_over_echo_still_barges_in():
    types = await _run(echo_gate=True, user_speech=True)
    assert "input_audio_buffer.speech_started" in types
    assert "status:cancelled" in types
