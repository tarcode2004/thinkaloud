"""Small offline fakes for the engine + LLM interfaces in DESIGN.md (protocol tests only)."""
from __future__ import annotations

import asyncio
import json
from collections import deque
from dataclasses import dataclass
from typing import Any, Callable

import numpy as np

from ort.llm import LLMEvent, ToolCall
from ort.session import Engine

SR16 = 16000

# Event waits get this much slack when the machine is busy (GPU tests of other suites running):
# waits are event-driven, so a larger timeout never slows a passing test.
import os as _os
T = float(_os.environ.get("ORT_TEST_TIMEOUT_SCALE", "3"))


async def wait_until(pred, timeout: float = 5.0, step: float = 0.02) -> bool:
    """Poll a condition (state that has no event) until true or timeout x T."""
    import time as _t
    end = _t.monotonic() + timeout * T
    while _t.monotonic() < end:
        if pred():
            return True
        await asyncio.sleep(step)
    return bool(pred())


# ----------------------------------------------------------------- LLM

class FakeLLM:
    """Scripted LLM. Each `stream()` call pops the next script entry:
    a str (spoken text, streamed word by word), a ToolCall, a list mixing both, or a callable
    (messages, tools) -> any of those. Default: echo of the last user message."""

    def __init__(self, script: list | None = None, *, ttft: float = 0.0, token_delay: float = 0.0):
        self.script: deque = deque(script or [])
        self.ttft = ttft
        self.token_delay = token_delay
        self.calls: list[dict] = []
        self.cancelled = 0

    def push(self, *entries: Any) -> None:
        self.script.extend(entries)

    def _plan(self, messages, tools) -> list:
        if self.script:
            e = self.script.popleft()
        else:
            last = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "nothing")
            e = f"You said: {last}."
        if callable(e):
            e = e(messages, tools)
        return e if isinstance(e, list) else [e]

    async def stream(self, messages, tools, tool_choice="auto", temperature=None, max_tokens=None):
        self.calls.append({"messages": messages, "tools": tools, "tool_choice": tool_choice, "max_tokens": max_tokens})
        plan = self._plan(messages, tools)
        try:
            if self.ttft:
                await asyncio.sleep(self.ttft)
            out_chars = 0
            for p in plan:
                if isinstance(p, ToolCall):
                    yield LLMEvent("tool_call", tool_call=p)
                elif isinstance(p, LLMEvent):
                    yield p
                    if p.type == "error":
                        return
                else:
                    words = str(p).split(" ")
                    for i, w in enumerate(words):
                        if self.token_delay:
                            await asyncio.sleep(self.token_delay)
                        tok = w if i == 0 else " " + w
                        out_chars += len(tok)
                        yield LLMEvent("text_delta", text=tok)
            yield LLMEvent("done", usage={"prompt_tokens": 42, "completion_tokens": max(1, out_chars // 4)},
                           meta={"provider": "fake", "ttft_ms": self.ttft * 1000})
        except (asyncio.CancelledError, GeneratorExit):
            self.cancelled += 1
            raise


def tool_call(name: str, args: dict, call_id: str = "call_test1") -> ToolCall:
    return ToolCall(call_id=call_id, name=name, arguments=json.dumps(args))


# ----------------------------------------------------------------- TTS

class FakeTTS:
    """Like ort.tts.TTS: consumes LLM deltas, segments with the real ClauseSegmenter and yields one
    `SpokenAudio` (220 Hz tone, `ms_per_char` per character) per segment, `.text` attached."""
    sample_rate = 24000

    def __init__(self, ms_per_char: float = 20.0, delay: float = 0.0):
        self.ms_per_char = ms_per_char
        self.delay = delay
        self.texts: list[str] = []

    def warmup(self):
        pass

    async def stream(self, text_chunks, voice: str = "alloy", speed: float = 1.0, language: str | None = None):
        from ort.tts import ClauseSegmenter, SpokenAudio
        seg = ClauseSegmenter()

        async def synth(t):
            t = t.strip()
            if not t:
                return None
            self.texts.append(t)
            n = int(len(t) * self.ms_per_char / 1000 * self.sample_rate / max(0.25, speed))
            if self.delay:
                await asyncio.sleep(self.delay)
            x = (0.2 * np.sin(2 * np.pi * 220 * np.arange(n) / self.sample_rate)).astype(np.float32)
            return SpokenAudio(x, text=t, spoken=t, words=None, index=len(self.texts) - 1)

        async for d in text_chunks:
            for s in seg.feed(d):
                a = await synth(s)
                if a is not None:
                    yield a
        for s in seg.flush():
            a = await synth(s)
            if a is not None:
                yield a


# ----------------------------------------------------------------- STT

class FakeSTT:
    def __init__(self, texts: list[str] | None = None, default: str = "hello there", delay: float = 0.0):
        self.texts = deque(texts or [])
        self.default = default
        self.delay = delay
        self.calls: list[dict] = []

    def warmup(self):
        pass

    async def transcribe(self, pcm16k: np.ndarray, language: str | None = None, prompt: str | None = None, **_kw) -> str:
        self.calls.append({"samples": int(pcm16k.size), "language": language, "prompt": prompt})
        if self.delay:
            await asyncio.sleep(self.delay)
        return self.texts.popleft() if self.texts else self.default


# ----------------------------------------------------------------- turn detection

@dataclass
class TurnEvent:
    type: str
    audio_ms: int


class FakeTurnDetector:
    """Energy VAD with server_vad semantics on 20 ms frames. Also signals `likely_end` after
    `likely_ms` of silence (speculation hook) and `speech_resumed` if speech returns before the stop."""

    FRAME = 320

    def __init__(self, cfg: dict | None, likely_ms: int = 100, threshold: float = 0.02):
        self.likely_ms = likely_ms
        self.threshold = threshold
        self.update(cfg)
        self._buf = np.zeros(0, np.float32)
        self.pos = 0            # samples processed
        self.in_speech = False
        self.run = 0            # consecutive speech frames
        self.silence = 0        # ms of silence while in speech
        self.last_speech_end = 0
        self.likely_sent = False

    def update(self, cfg: dict | None) -> None:
        self.cfg = cfg or {}
        self.silence_ms = int(self.cfg.get("silence_duration_ms", 200 if self.cfg.get("type") != "semantic_vad" else 300))

    def feed(self, chunk: np.ndarray) -> list[TurnEvent]:
        out = []
        self._buf = np.concatenate([self._buf, np.asarray(chunk, np.float32)])
        while self._buf.size >= self.FRAME:
            f, self._buf = self._buf[:self.FRAME], self._buf[self.FRAME:]
            start_ms = self.pos * 1000 // SR16
            self.pos += self.FRAME
            end_ms = self.pos * 1000 // SR16
            speech = float(np.sqrt(np.mean(f * f))) > self.threshold
            if speech:
                self.run += 1
                if self.likely_sent and self.in_speech:
                    out.append(TurnEvent("speech_resumed", end_ms))
                self.likely_sent = False
                self.silence = 0
                self.last_speech_end = end_ms
                if not self.in_speech and self.run >= 2:
                    self.in_speech = True
                    pad = int(self.cfg.get("prefix_padding_ms", 300))
                    out.append(TurnEvent("speech_started", max(0, start_ms - 20 - pad)))
            else:
                self.run = 0
                if self.in_speech:
                    self.silence += 20
                    if not self.likely_sent and self.silence >= self.likely_ms and self.silence < self.silence_ms:
                        self.likely_sent = True
                        out.append(TurnEvent("likely_end", self.last_speech_end))
                    if self.silence >= self.silence_ms:
                        self.in_speech = False
                        self.likely_sent = False
                        out.append(TurnEvent("speech_stopped", self.last_speech_end))
        return out


# ----------------------------------------------------------------- bundle

def make_engine(llm: FakeLLM | None = None, tts: FakeTTS | None = None, stt: FakeSTT | None = None,
                turn_factory: Callable | None = None) -> Engine:
    return Engine(llm=llm or FakeLLM(), tts=tts or FakeTTS(), stt=stt or FakeSTT(),
                  turn_factory=turn_factory or (lambda cfg: FakeTurnDetector(cfg)), name="fake")


def tone(seconds: float, sr: int = 24000, freq: float = 300.0, amp: float = 0.3) -> np.ndarray:
    t = np.arange(int(seconds * sr)) / sr
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def silence(seconds: float, sr: int = 24000) -> np.ndarray:
    return np.zeros(int(seconds * sr), np.float32)


# ----------------------------------------------------------------- in-process server + WS client

import base64
import contextlib
import time

from aiohttp.test_utils import TestClient, TestServer


def make_config(**kw):
    from ort.config import Config
    c = Config(llm="mock", speculative=True, partial_transcripts=False, ws_audio_lead_ms=200,
               webrtc_playout_delay_ms=0, cors_origins=["*"])
    for k, v in kw.items():
        setattr(c, k, v)
    return c


@contextlib.asynccontextmanager
async def running_app(engine: Engine | None = None, **cfg_kw):
    from ort.server import create_app
    app = create_app(make_config(**cfg_kw), engine or make_engine())
    client = TestClient(TestServer(app))
    await client.start_server()
    try:
        yield client
    finally:
        await client.close()


class RT:
    """Minimal realtime WS client that records every server event."""

    def __init__(self, ws):
        self.ws = ws
        self.events: list[dict] = []
        self._cursor = 0
        self._new = asyncio.Event()
        self._task = asyncio.get_running_loop().create_task(self._reader())

    @classmethod
    async def connect(cls, client: TestClient, path: str = "/v1/realtime?model=gpt-realtime", headers=None, **kw):
        ws = await client.ws_connect(path, headers=headers or {}, **kw)
        return cls(ws)

    async def _reader(self):
        async for msg in self.ws:
            if msg.type.name == "TEXT":
                self.events.append(json.loads(msg.data))
                self._new.set()

    async def send(self, ev: dict):
        await self.ws.send_str(json.dumps(ev))

    async def append(self, pcm24: np.ndarray, chunk_ms: int = 20, realtime: bool = False):
        n = 24000 * chunk_ms // 1000
        for i in range(0, pcm24.size, n):
            c = np.clip(pcm24[i:i + n] * 32767, -32768, 32767).astype("<i2").tobytes()
            await self.send({"type": "input_audio_buffer.append", "audio": base64.b64encode(c).decode()})
            if realtime:
                await asyncio.sleep(chunk_ms / 1000)

    async def wait_for(self, pred, timeout: float = 5.0, *, from_start: bool = False) -> dict:
        """Next event (after the cursor) matching pred (a type string or callable). Advances the cursor."""
        if isinstance(pred, str):
            t = pred
            pred = lambda e: e["type"] == t  # noqa: E731
        deadline = time.monotonic() + timeout * T
        i = 0 if from_start else self._cursor
        while True:
            while i < len(self.events):
                e = self.events[i]
                i += 1
                if pred(e):
                    self._cursor = i
                    return e
            left = deadline - time.monotonic()
            if left <= 0:
                raise AssertionError(f"timeout waiting; last events: {[e['type'] for e in self.events[-25:]]}")
            self._new.clear()
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self._new.wait(), left)

    def types(self, start: int = 0) -> list[str]:
        return [e["type"] for e in self.events[start:]]

    def of(self, typ: str) -> list[dict]:
        return [e for e in self.events if e["type"] == typ]

    async def close(self):
        await self.ws.close()
        self._task.cancel()
