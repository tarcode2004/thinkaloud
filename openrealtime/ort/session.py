"""Realtime session state machine (OpenAI GA Realtime semantics).

One `Session` per connection. It owns the conversation (items), the input audio buffer, turn
detection, input transcription and responses (LLM → clause segmenter → TTS → AudioOutput), and
emits server events to its listeners (the transport). Transports feed it client events
(`await handle(ev)`) and input audio (`feed_input_16k` / `append_pcm16_24k`), and provide an
`AudioOutput` that plays assistant audio and reports how much of it was actually played.

Timing model
------------
* Assistant audio is queued on an AudioOutput (WebRTC: pulled 20 ms at a time by the outbound
  track; WebSocket: sent a bounded lead ahead of a virtual playout clock). Every queued piece gets
  a play-start time, so `played_samples(item)` is known precisely at any moment.
* Transcript deltas are paced to that clock (ORT_TRANSCRIPT_PACING=audio): a word is emitted when
  its audio starts playing, so captions never run ahead of the voice. Consequently a spoken
  response stays active (response.done comes) until its audio has finished playing.
* Barge-in (speech_started with interrupt_response) cancels the LLM/TTS, flushes the output queue
  at once and truncates the assistant item to the words that were heard.
"""
from __future__ import annotations

import asyncio
import base64
import bisect
import contextlib
import copy
import json
import logging
import re
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Callable

import numpy as np

from . import audio as _audio

from . import events as E
from .audio import Resampler, pcm16_bytes_to_float32
from .config import Config

log = logging.getLogger("ort.session")

IN_SR = 16000      # engine input rate (VAD / STT)
OUT_SR = 24000     # TTS / wire output rate


# ===================================================================== cross-session scheduling

class _Scheduler:
    """Process-wide view of the shared STT / TTS executors (one GPU thread each, FIFO).

    Latency-critical work: final / speculative transcripts, and the first TTS chunk of a response.
    Partial transcripts are optional: they are skipped while any session waits for critical work,
    so with N concurrent sessions they never sit in the queue in front of someone's final
    transcript. TTS read-ahead is bounded per session (`tts_ahead_s` of unplayed audio), so one
    long answer cannot fill the TTS queue ahead of another session's first clause."""

    def __init__(self) -> None:
        self.urgent_stt = 0
        self.first_tts = 0
        self.counters = {"stt_urgent": 0, "partials_run": 0, "partials_skipped": 0, "tts_first": 0, "tts_throttled": 0}
        self.ewma = {"stt_urgent_ms": 0.0, "tts_first_ms": 0.0}

    def busy(self) -> bool:
        return self.urgent_stt > 0 or self.first_tts > 0

    def note(self, key: str, ms: float) -> None:
        self.ewma[key] = ms if not self.ewma[key] else 0.8 * self.ewma[key] + 0.2 * ms

    async def urgent_transcribe(self, stt, audio, **kw) -> str:
        self.urgent_stt += 1
        self.counters["stt_urgent"] += 1
        t0 = time.monotonic()
        try:
            return await stt.transcribe(audio, **kw)
        finally:
            self.urgent_stt -= 1
            self.note("stt_urgent_ms", (time.monotonic() - t0) * 1000)

    def snapshot(self) -> dict:
        return {**self.counters, **{k: round(v, 1) for k, v in self.ewma.items()},
                "urgent_stt_now": self.urgent_stt, "first_tts_now": self.first_tts}


SCHED = _Scheduler()


# ===================================================================== engine bundle

@dataclass
class Engine:
    """Everything a session needs from the audio engine + LLM layer (see DESIGN.md interfaces)."""
    llm: Any
    tts: Any
    stt: Any
    turn_factory: Callable[[dict | None], Any]
    streaming_factory: Callable[..., Any] | None = None   # (stt, language) -> StreamingTranscriber
    name: str = "engine"

    def warmup(self) -> None:
        for part in (self.stt, self.tts):
            w = getattr(part, "warmup", None)
            if callable(w):
                w()


def load_engine(cfg: Config, llm: Any = None) -> Engine:
    """Build the real engine (Whisper / Kokoro / Silero + smart-turn) and the configured LLM."""
    from .stt import STT
    from .tts import TTS
    from .turn import TurnDetector
    try:
        from .stt import StreamingTranscriber
    except ImportError:  # pragma: no cover
        StreamingTranscriber = None
    if llm is None:
        from .llm import make_llm
        llm = make_llm({"llm": cfg.llm})
    stt = STT(device=cfg.device)
    tts = TTS(device=cfg.device)
    sf = (lambda s, language=None, prompt=None: StreamingTranscriber(s, language=language, prompt=prompt)) \
        if StreamingTranscriber else None
    return Engine(llm=llm, tts=tts, stt=stt, turn_factory=lambda c: TurnDetector(c), streaming_factory=sf, name="ort")


# ===================================================================== audio output

class _OutItem:
    __slots__ = ("item_id", "response_id", "output_index", "content_index", "chunks", "pushed", "sent",
                 "finished", "drained", "starts", "offs", "lens", "cleared", "started", "forget")

    def __init__(self, response_id: str, item_id: str, output_index: int, content_index: int):
        self.item_id, self.response_id = item_id, response_id
        self.output_index, self.content_index = output_index, content_index
        self.chunks: deque[np.ndarray] = deque()
        self.pushed = 0          # samples queued (24 kHz)
        self.sent = 0            # samples that left the server
        self.finished = False    # no more audio will be pushed
        self.drained = asyncio.Event()
        self.starts: list[float] = []   # play-start time (monotonic) of each sent piece
        self.offs: list[int] = []       # sample offset of each sent piece
        self.lens: list[int] = []
        self.cleared = False
        self.started = False
        self.forget = False

    def pending(self) -> int:
        return self.pushed - self.sent

    def mark_sent(self, n: int, play_start: float) -> None:
        self.starts.append(play_start)
        self.offs.append(self.sent)
        self.lens.append(n)
        self.sent += n
        self._check_drained()

    def _check_drained(self) -> None:
        if self.finished and self.sent >= self.pushed:
            self.drained.set()

    def played(self, now: float) -> int:
        i = bisect.bisect_right(self.starts, now) - 1
        if i < 0:
            return 0
        return self.offs[i] + min(self.lens[i], int((now - self.starts[i]) * OUT_SR))

    def play_end(self) -> float:
        return self.starts[-1] + self.lens[-1] / OUT_SR if self.starts else 0.0


class AudioOutput:
    """Queue of assistant audio (mono float32 @24 kHz) with a playout clock.

    Subclasses move samples out (`_take`) and call `item.mark_sent(n, play_start)`; the base
    class answers "how much of item X has been played". `on_event(type, response_id)` reports
    output_audio_buffer.started/stopped/cleared (only WebRTC sends those on the wire).
    """
    kind = "null"

    def __init__(self) -> None:
        self.items: dict[str, _OutItem] = {}
        self.order: deque[_OutItem] = deque()
        self.on_event: Callable[[str, str], None] | None = None
        self.emit: Callable[[dict], None] | None = None
        self.wakeup = asyncio.Event()
        # Echo-gating hooks: what was sent to the speaker (pcm @24 kHz, monotonic play start) and cuts.
        self.on_sent: Callable[[np.ndarray, float], None] | None = None
        self.on_cleared: Callable[[], None] | None = None

    def _mark(self, it: "_OutItem", pcm: np.ndarray, play_start: float) -> None:
        it.mark_sent(int(pcm.size), play_start)
        if self.on_sent is not None:
            try:
                self.on_sent(pcm, play_start)
            except Exception:  # pragma: no cover - never let a hook break playout
                log.exception("on_sent hook failed")

    # --- producer side (session)
    def begin(self, response_id: str, item_id: str, output_index: int, content_index: int = 0) -> None:
        it = _OutItem(response_id, item_id, output_index, content_index)
        self.items[item_id] = it
        self.order.append(it)

    def push(self, item_id: str, pcm: np.ndarray) -> None:
        it = self.items.get(item_id)
        if it is None or it.cleared or it.finished or pcm.size == 0:
            return
        it.chunks.append(np.asarray(pcm, np.float32))
        it.pushed += int(pcm.size)
        self.wakeup.set()

    def finish(self, item_id: str) -> None:
        it = self.items.get(item_id)
        if it and not it.finished:
            it.finished = True
            it._check_drained()
            self.wakeup.set()

    def clear(self, response_ids: set[str] | None = None) -> list[_OutItem]:
        """Drop everything not yet played (only of `response_ids` when given). Returns the items that
        still had audio queued or playing."""
        now = time.monotonic()
        hit = []
        keep: deque[_OutItem] = deque()
        queued = list(self.order)
        # items fully sent (no longer queued) whose audio is still playing are cut too
        playing = [it for it in self.items.values() if it not in queued and not it.cleared and it.play_end() > now]
        for it in queued + playing:
            if response_ids is not None and it.response_id not in response_ids:
                if it in queued:
                    keep.append(it)
                continue
            if it.pending() > 0 or it.play_end() > now or not it.finished:
                hit.append(it)
            # Sent-but-unplayed audio is cut too where the transport can recall it (WS clients flush their
            # buffer): the played clock stops at the cut time. WebRTC frames already sent will still play.
            it.chunks.clear()
            it.cleared = True
            cut = self._cut_time(now)
            if it.starts:
                p = it.sent if cut == float("inf") else it.played(cut)
                i = bisect.bisect_right(it.starts, cut) - 1
                del it.starts[i + 1:], it.offs[i + 1:], it.lens[i + 1:]
                if i >= 0:
                    it.lens[i] = max(0, p - it.offs[i])
                it.pushed = it.sent = p
            else:
                it.pushed = it.sent      # nothing went through a playout clock (NullOutput: all "played")
            it.finished = True
            it.drained.set()
        self.order = keep
        self._on_clear(hit)
        if hit and self.on_cleared is not None:
            try:
                self.on_cleared()
            except Exception:  # pragma: no cover
                log.exception("on_cleared hook failed")
        return hit

    def was_cleared(self, item_id: str) -> bool:
        it = self.items.get(item_id)
        return bool(it and it.cleared)

    def _on_clear(self, hit: list[_OutItem]) -> None:
        pass

    def _cut_time(self, now: float) -> float:
        """Up to when queued-and-sent audio counts as heard after a clear."""
        return now

    def sent_samples(self, item_id: str) -> int:
        it = self.items.get(item_id)
        return it.sent if it else 0

    # --- clock
    def played_samples(self, item_id: str) -> int:
        it = self.items.get(item_id)
        return it.played(time.monotonic()) if it else 0

    def busy(self) -> bool:
        now = time.monotonic()
        return any(it.pending() > 0 or not it.finished or it.play_end() > now for it in self.order)

    async def wait_drained(self, item_id: str) -> None:
        it = self.items.get(item_id)
        if it:
            await it.drained.wait()

    def forget(self, item_id: str) -> None:
        """The session no longer needs this item's clock (dropped once it is fully out)."""
        it = self.items.get(item_id)
        if it is None:
            return
        now = time.monotonic()
        if it.drained.is_set() and it.play_end() <= now:
            self.items.pop(item_id, None)
            with contextlib.suppress(ValueError):
                self.order.remove(it)
        elif it.drained.is_set() and it not in self.order:
            # all audio is out but still playing: drop the clock once playback has ended
            with contextlib.suppress(RuntimeError):
                asyncio.get_running_loop().call_later(max(0.0, it.play_end() - now) + 0.05,
                                                      lambda: self.items.pop(item_id, None))
        else:
            it.forget = True  # type: ignore[attr-defined]

    def _head(self) -> _OutItem | None:
        while self.order:
            it = self.order[0]
            if it.chunks:
                return it
            if it.finished and it.pending() <= 0:
                self.order.popleft()
                self._item_done(it)
                if it.forget:
                    self.items.pop(it.item_id, None)
                continue
            return None   # head still generating: keep order (silence meanwhile)
        return None

    def _item_done(self, it: _OutItem) -> None:
        pass

    def _take(self, it: _OutItem, n: int) -> np.ndarray:
        """Pop up to n samples from the head item's chunks."""
        out = []
        need = n
        while need > 0 and it.chunks:
            c = it.chunks[0]
            if c.size <= need:
                out.append(it.chunks.popleft())
                need -= c.size
            else:
                out.append(c[:need])
                it.chunks[0] = c[need:]
                need = 0
        return np.concatenate(out) if len(out) > 1 else (out[0] if out else np.zeros(0, np.float32))

    async def close(self) -> None:
        pass


class NullOutput(AudioOutput):
    """Discards audio instantly (text-only / tests); played == pushed."""
    kind = "null"

    def push(self, item_id: str, pcm: np.ndarray) -> None:
        super().push(item_id, pcm)
        it = self.items.get(item_id)
        if it and it.chunks:
            n = sum(c.size for c in it.chunks)
            it.chunks.clear()
            it.sent += n
            it._check_drained()

    def played_samples(self, item_id: str) -> int:
        it = self.items.get(item_id)
        return it.sent if it else 0

    def busy(self) -> bool:
        return False


# ===================================================================== text ↔ audio mapping

def _chunk_marks(text: str, words: list | None, start: int, n: int, joiner: str) -> list[tuple[int, str]]:
    """(sample position, display word) for one TTS chunk. A word counts as heard once the middle
    of its spoken audio has played (word timings when the TTS has them, else even spacing)."""
    lead = text[: len(text) - len(text.lstrip())]
    dwords = [w for w in text.split() if w]
    if not dwords:
        return []
    nd = len(dwords)
    mids: list[float] = []
    if words:
        # only real words: Kokoro also reports punctuation (', ', '.') as timed tokens, which would
        # shift every later display word towards the end (truncation would under-count what was heard)
        mids = sorted((float(a) + float(b)) / 2 for w, a, b in words if any(ch.isalnum() for ch in str(w)))
    dur = n / OUT_SR
    out = []
    for k, w in enumerate(dwords):
        if mids:
            ns = len(mids)
            h = min(ns, max(1, -(-((k + 0.5) * ns) // nd)))   # ceil((k+.5)*ns/nd)
            t = mids[int(h) - 1]
        else:
            t = (k + 0.5) / nd * dur
        piece = (joiner + lead + w) if k == 0 else " " + w
        out.append((start + min(n, int(t * OUT_SR)), piece))
    return out


async def _queue_iter(q: asyncio.Queue) -> AsyncIterator[str]:
    while True:
        t = await q.get()
        if t is None:
            return
        yield t


# ===================================================================== responses

class _LLMFailure(Exception):
    def __init__(self, message: str, code: str | None = None):
        super().__init__(message)
        self.code = code or "llm_error"


class _ContextExceeded(Exception):
    pass


@dataclass
class _Msg:
    item: dict
    output_index: int
    audio: bool
    text: str = ""
    emitted: str = ""                 # transcript/text deltas sent so far
    marks: list[tuple[int, str]] = field(default_factory=list)   # (sample position, word incl. leading ws)
    mark_i: int = 0
    total_samples: int = 0
    spoken: str = ""                  # display text of the audio synthesised so far
    tts_q: asyncio.Queue | None = None
    tts_task: asyncio.Task | None = None
    pacer_task: asyncio.Task | None = None
    closed: bool = False


@dataclass
class Response:
    id: str
    in_band: bool
    modalities: list[str]
    instructions: str | None
    tools: list
    tool_choice: Any
    metadata: Any
    voice: str
    speed: float
    max_output_tokens: Any
    temperature: float | None = None
    input_items: list | None = None
    client_event_id: str | None = None
    auto: bool = False
    status: str = "in_progress"
    output: list = field(default_factory=list)
    task: asyncio.Task | None = None
    msg: _Msg | None = None
    finalized: bool = False
    llm_source: AsyncIterator | None = None
    usage: dict | None = None
    meta: dict | None = None
    created_at: float = field(default_factory=time.monotonic)
    first_audio_at: float | None = None
    prompt_chars: int = 0
    audio_out_samples: int = 0


def _heard_text(marks: list[tuple[int, str]], samples: int) -> str:
    return "".join(w for pos, w in marks if pos <= samples)


# ===================================================================== session

class Session:
    def __init__(self, engine: Engine, cfg: Config, session_config: dict, *, transport: str = "websocket",
                 output: AudioOutput | None = None):
        self.engine = engine
        self.cfg = cfg
        self.config = session_config
        self.id = session_config.get("id") or E.new_id("sess")
        self.config["id"] = self.id
        self.conversation_id = E.new_id("conv")
        self.transport = transport
        self.attach_output(output or NullOutput())
        self.listeners: list[Callable[[dict], None]] = []
        self.closed = False
        # conversation
        self.items: list[dict] = []
        self.index: dict[str, dict] = {}
        self._conv_version = 0
        # responses
        self.responses: dict[str, Response] = {}
        self.active: Response | None = None    # the in-band response (at most one)
        self._pending_auto = False
        # input audio
        self._exec = ThreadPoolExecutor(1, thread_name_prefix=f"turn-{self.id[-6:]}")
        self._in_q: asyncio.Queue = asyncio.Queue()
        self._in_task: asyncio.Task | None = None
        self._in_total = 0                       # 16k samples since session start
        self._buf: list[np.ndarray] = []
        self._buf_start = 0                      # absolute sample of _buf[0]
        self._buf_len = 0
        self._resamp_24_16 = Resampler(24000, IN_SR)
        self._speech_item: str | None = None
        self._speech_start = 0                   # absolute sample
        self._turn = None
        self._turn_cfg: dict | None = None
        self._turn_offset = 0                    # session sample where the detector's timeline starts
        self._pause_hit: tuple | None = None     # set by TurnDetector.on_pause (executor thread)
        self._streamer = None
        self._partial_task: asyncio.Task | None = None
        self._partial_emitted: dict[str, str] = {}
        self._transcripts: dict[str, asyncio.Future] = {}
        self._spec: dict | None = None
        self._idle_task: asyncio.Task | None = None
        self._call_ids: dict[str, None] = {}     # every function call id seen (in-band and out-of-band)
        self._tasks: set[asyncio.Task] = set()
        self.stats: dict[str, Any] = {}
        self._apply_turn_detection()

    # ------------------------------------------------------------------ plumbing
    def add_listener(self, fn: Callable[[dict], None]) -> None:
        self.listeners.append(fn)

    def remove_listener(self, fn: Callable[[dict], None]) -> None:
        with contextlib.suppress(ValueError):
            self.listeners.remove(fn)

    def _emit(self, ev: dict) -> None:
        if self.closed:
            return
        for fn in list(self.listeners):
            try:
                fn(ev)
            except Exception:  # pragma: no cover
                log.exception("listener failed")

    def _error(self, code: str | None, message: str, *, param: str | None = None, event_id: str | None = None,
               type_: str = "invalid_request_error") -> None:
        self._emit(E.error_event(code, message, type_=type_, param=param, event_id=event_id))

    def _spawn(self, coro) -> asyncio.Task:
        t = asyncio.get_running_loop().create_task(coro)
        self._tasks.add(t)
        t.add_done_callback(self._task_done)
        return t

    def _task_done(self, t: asyncio.Task) -> None:
        self._tasks.discard(t)
        if not t.cancelled() and t.exception() is not None:
            log.error("session task failed", exc_info=t.exception())

    def start(self) -> None:
        self._emit(E.server_event("session.created", session=self.public_session()))
        self._in_task = self._spawn(self._input_worker())
        self._arm_idle()

    def public_session(self) -> dict:
        return copy.deepcopy(self.config)

    async def close(self) -> None:
        if self.closed:
            return
        for r in list(self.responses.values()):
            if not r.finalized:
                self._cancel(r, "client_cancelled", emit=False)
        self._discard_spec()
        self.closed = True
        for t in list(self._tasks):
            t.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._exec.shutdown(wait=False, cancel_futures=True)
        await self.output.close()

    @property
    def td(self) -> dict | None:
        return self.config["audio"]["input"].get("turn_detection")

    # ------------------------------------------------------------------ client events
    async def handle(self, ev: Any) -> None:
        if not isinstance(ev, dict):
            return self._error("invalid_type", f"Invalid type for event: expected an object, but got {E._type_name(ev)} instead.")
        eid = ev.get("event_id") if isinstance(ev.get("event_id"), str) else None
        if "type" not in ev:
            return self._error("missing_required_parameter", "Missing required parameter: 'type'.", param="type", event_id=eid)
        if not isinstance(ev["type"], str):
            return self._error("invalid_type", f"Invalid type for 'type': expected a string, but got {E._type_name(ev['type'])} instead.",
                               param="type", event_id=eid)
        t = ev["type"]
        h = self._HANDLERS.get(t)
        if h is None:
            return self._error("invalid_value", f"Invalid value: '{t}'. Supported values are: "
                               + ", ".join(f"'{k}'" for k in self._HANDLERS) + ".", param="type", event_id=eid)
        try:
            r = h(self, ev)
            if asyncio.iscoroutine(r):
                await r
        except E.SessionConfigError as e:
            self._error(e.code, str(e), param=e.param, event_id=eid)
        except Exception as e:  # never kill the connection on one bad event
            log.exception("handling %s failed", t)
            self._error("server_error", f"Failed to handle {t}: {e}", event_id=eid, type_="server_error")

    # --- session
    async def _h_session_update(self, ev: dict) -> None:
        if "session" not in ev:
            raise E.SessionConfigError("Missing required parameter: 'session'.", "session", "missing_required_parameter")
        patch = ev["session"]
        if not isinstance(patch, dict):
            raise E._bad_type("session", "an object", patch)
        if patch.get("model") and patch["model"] != self.config.get("model"):
            name, _ = self.cfg.resolve_model(patch["model"])
            patch = {**patch, "model": name}
        was = copy.deepcopy(self.td)
        E.apply_session_patch(self.config, patch)
        if self.td != was:
            await self._drain_input()
            if self._speech_item is not None and (self.td is None or (was or {}).get("type") != self.td.get("type")):
                await self._reset_turn()    # VAD off / switched mid-speech: that turn is abandoned
        self._apply_turn_detection()
        self._arm_idle()
        self._emit(E.server_event("session.updated", session=self.public_session()))

    def _apply_turn_detection(self) -> None:
        td = self.td
        if td == self._turn_cfg and (self._turn is not None or td is None):
            return
        self._turn_cfg = copy.deepcopy(td)
        if self._turn is not None and hasattr(self._turn, "update"):
            try:
                self._turn.update(td)   # None → detector idles but keeps its timeline
                return
            except Exception:  # pragma: no cover
                log.exception("turn detector update failed; recreating")
        if td is None:
            self._turn = None
            return
        self._turn = self.engine.turn_factory(td)
        self._turn_offset = self._in_total
        if hasattr(self._turn, "on_pause"):
            self._turn.on_pause = self._on_pause

    def _on_pause(self, audio: Any, start_ms: int, end_ms: int) -> None:
        """TurnDetector callback (runs in the detector thread) at the first ~200 ms pause."""
        self._pause_hit = (audio, int(end_ms))

    # --- input audio buffer
    def _h_append(self, ev: dict) -> None:
        if "audio" not in ev:
            raise E.SessionConfigError("Missing required parameter: 'audio'.", "audio", "missing_required_parameter")
        raw = _b64(ev["audio"], "audio")
        fmt = self.config["audio"]["input"].get("format") or {}
        self.append_input(raw, fmt)

    def append_input(self, raw: bytes, fmt: dict | None = None) -> None:
        """Client audio in the session's input format (pcm16 24 kHz, or G.711 μ/A-law 8 kHz)."""
        ftype = (fmt or {}).get("type", "audio/pcm")
        if ftype in ("audio/pcmu", "audio/pcma"):
            pcm16_8k = _g711_decode(raw, ftype == "audio/pcmu")
            if not hasattr(self, "_resamp_8_16"):
                self._resamp_8_16 = Resampler(8000, IN_SR)
            self.feed_input_16k(self._resamp_8_16.process(pcm16_8k))
            return
        self.feed_input_16k(self._resamp_24_16.process(pcm16_bytes_to_float32(raw)))

    def append_pcm16_24k(self, raw: bytes) -> None:
        self.feed_input_16k(self._resamp_24_16.process(pcm16_bytes_to_float32(raw)))

    def feed_input_16k(self, pcm: np.ndarray) -> None:
        if self.closed or pcm.size == 0:
            return
        pcm = np.asarray(pcm, np.float32).ravel()
        # Huge appends reach the detector in <= 0.5 s pieces: bounded work per executor call and the
        # pause / speech hooks keep their per-chunk timing.
        step = IN_SR // 2
        for i in range(0, pcm.size, step):
            self._in_q.put_nowait(pcm[i:i + step])

    async def _drain_input(self) -> None:
        await self._in_q.join()

    async def _input_worker(self) -> None:
        loop = asyncio.get_running_loop()
        while True:
            chunk = await self._in_q.get()
            try:
                self._buf.append(chunk)
                self._buf_len += chunk.size
                self._in_total += chunk.size
                det = self._turn
                if det is not None:
                    evs = await loop.run_in_executor(self._exec, det.feed, chunk)
                    if self.td is not None:
                        if self._speech_item and self._streamer is not None:
                            with contextlib.suppress(Exception):
                                self._streamer.feed(chunk)
                        hit, self._pause_hit = self._pause_hit, None
                        if hit is not None:
                            self._maybe_speculate(hit[0], self._abs(hit[1]))
                        elif self._spec is not None and getattr(det, "in_speech", False) \
                                and getattr(det, "paused", True) is False:
                            self._discard_spec()   # the user resumed talking
                        for tev in evs or ():
                            self._on_turn_event(tev)
                if self._speech_item is None:
                    self._trim_buffer()
                self._cap_buffer()
            except Exception:
                log.exception("input processing failed")
            finally:
                self._in_q.task_done()

    def _trim_buffer(self) -> None:
        """Outside speech in VAD mode, keep only enough audio for the next prefix padding."""
        if self.td is None:
            return
        keep = int(IN_SR * (self.td.get("prefix_padding_ms", 300) + 700) / 1000)
        while self._buf and self._buf_len - self._buf[0].size >= keep:
            c = self._buf.pop(0)
            self._buf_len -= c.size
            self._buf_start += c.size

    def _cap_buffer(self) -> None:
        """Never keep more than max_input_buffer_s of uncommitted audio (manual mode with a mic that
        never commits, or a VAD stuck in speech): the oldest audio goes."""
        cap = int(IN_SR * max(30, int(getattr(self.cfg, "max_input_buffer_s", 600))))
        while self._buf and self._buf_len - self._buf[0].size >= cap:
            c = self._buf.pop(0)
            self._buf_len -= c.size
            self._buf_start += c.size

    def _buffer_slice(self, start: int, end: int) -> np.ndarray:
        if not self._buf:
            return np.zeros(0, np.float32)
        allb = np.concatenate(self._buf) if len(self._buf) > 1 else self._buf[0]
        s = max(0, start - self._buf_start)
        e = max(s, min(allb.size, end - self._buf_start))
        return allb[s:e]

    def _consume_buffer(self, upto: int) -> None:
        """Drop buffered audio before absolute sample `upto`."""
        if not self._buf:
            self._buf_start = upto
            return
        allb = np.concatenate(self._buf)
        cut = max(0, min(allb.size, upto - self._buf_start))
        rest = allb[cut:]
        self._buf = [rest] if rest.size else []
        self._buf_len = rest.size
        self._buf_start += cut

    async def _h_commit(self, ev: dict) -> None:
        await self._drain_input()
        if self._buf_len < IN_SR // 10:   # OpenAI requires >= 100 ms
            ms = self._buf_len * 1000 // IN_SR
            return self._error("input_audio_buffer_commit_empty",
                               f"Error committing input audio buffer: buffer too small. Expected at least 100ms of audio, but buffer only has {ms:.2f}ms of audio.",
                               event_id=ev.get("event_id"))
        item_id = self._speech_item or E.new_id("item")
        self._speech_item = None
        self._stop_partials()
        audio = self._buffer_slice(self._buf_start, self._buf_start + self._buf_len)
        self._consume_buffer(self._buf_start + self._buf_len)
        self._discard_spec()
        self._commit_item(item_id, audio)

    async def _h_clear(self, ev: dict) -> None:
        await self._drain_input()          # audio appended before the clear is part of what is cleared
        self._buf, self._buf_len = [], 0
        self._buf_start = self._in_total
        await self._reset_turn()           # a turn in progress is dropped: no dangling speech_stopped
        self._emit(E.server_event("input_audio_buffer.cleared"))

    async def _reset_turn(self) -> None:
        """Forget the current turn: speech item, partials, speculation and the detector's state."""
        self._speech_item = None
        self._stop_partials()
        self._discard_spec()
        self._pause_hit = None
        det = self._turn
        if det is None:
            return
        if hasattr(det, "reset"):
            try:
                await asyncio.get_running_loop().run_in_executor(self._exec, det.reset)
            except Exception:  # pragma: no cover
                log.exception("turn detector reset failed")
        else:
            self._turn = self.engine.turn_factory(self.td)
            if hasattr(self._turn, "on_pause"):
                self._turn.on_pause = self._on_pause
        self._turn_offset = self._in_total   # the detector's timeline restarts here

    def _commit_item(self, item_id: str, audio16k: np.ndarray, transcript_future: asyncio.Future | None = None) -> dict:
        item = {"id": item_id, "object": "realtime.item", "type": "message", "status": "completed", "role": "user",
                "content": [{"type": "input_audio", "transcript": None}],
                "_audio_ms": int(audio16k.size * 1000 / IN_SR)}
        prev = self._insert(item, None)
        if len(self._transcripts) > 64:      # finished transcriptions are already stored on their items
            for k in [k for k, f in self._transcripts.items() if f.done()][:-16]:
                self._transcripts.pop(k, None)
        self._emit(E.server_event("input_audio_buffer.committed", previous_item_id=prev, item_id=item_id))
        self._announce_item(item, prev)
        if transcript_future is not None:
            self._transcripts[item_id] = transcript_future
            self._spawn(self._transcribe(item, audio16k, precomputed=transcript_future))
        else:
            self._transcripts[item_id] = self._spawn(self._transcribe(item, audio16k))
        return item

    async def _transcribe(self, item: dict, audio: np.ndarray, precomputed: asyncio.Future | None = None) -> str:
        tcfg = self.config["audio"]["input"].get("transcription")
        item_id = item["id"]
        t0 = time.monotonic()
        try:
            if precomputed is not None:
                text = await precomputed
            else:
                lang = (tcfg or {}).get("language")
                prompt = (tcfg or {}).get("prompt")
                text = await SCHED.urgent_transcribe(self.engine.stt, audio, language=lang, prompt=prompt,
                                                     **self._stt_stream_kw()) if audio.size else ""
            text = (text or "").strip()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.exception("transcription failed")
            if tcfg is not None:
                self._emit(E.server_event("conversation.item.input_audio_transcription.failed", item_id=item_id,
                                          content_index=0, error={"type": "transcription_error", "code": "audio_unintelligible",
                                                                  "message": str(e), "param": None}))
            return ""
        self.stats["last_stt_ms"] = (time.monotonic() - t0) * 1000
        if item_id in self.index:
            item["content"][0]["transcript"] = text
        if tcfg is not None and not self.closed:
            emitted = self._partial_emitted.pop(item_id, "")
            rest = text[len(emitted):] if text.startswith(emitted) else ("" if emitted else text)
            if rest or not emitted:
                self._emit(E.server_event("conversation.item.input_audio_transcription.delta", item_id=item_id,
                                          content_index=0, delta=rest))
            done = E.server_event("conversation.item.input_audio_transcription.completed", item_id=item_id,
                                  content_index=0, transcript=text,
                                  usage={"type": "duration", "seconds": round(audio.size / IN_SR, 3)})
            inc = self.config.get("include") or []
            done["logprobs"] = [] if "item.input_audio_transcription.logprobs" in inc else None
            self._emit(done)
        return text

    # --- turn detection
    def _abs(self, det_ms: int) -> int:
        """Detector timeline ms → absolute session sample."""
        return self._turn_offset + int(det_ms * IN_SR / 1000)

    def _on_turn_event(self, tev: Any) -> None:
        typ = getattr(tev, "type", None) or (tev.get("type") if isinstance(tev, dict) else None)
        det_ms = int(getattr(tev, "audio_ms", None) if not isinstance(tev, dict) else tev.get("audio_ms", 0) or 0)
        pos = self._abs(det_ms)                  # absolute sample
        ms = pos * 1000 // IN_SR                 # session ms (OpenAI: since the session's first audio)
        td = self.td or {}
        if typ == "speech_started":
            self._disarm_idle()
            self._discard_spec()
            if self._speech_item is None:
                self._speech_item = E.new_id("item")
                self._speech_start = pos         # already includes prefix padding (DESIGN contract)
            self._emit(E.server_event("input_audio_buffer.speech_started", audio_start_ms=ms, item_id=self._speech_item))
            if td.get("interrupt_response", True):
                self._barge_in()
            self._start_partials()
        elif typ == "speech_stopped":
            item_id = self._speech_item or E.new_id("item")
            self._speech_item = None
            self._stop_partials()
            self._emit(E.server_event("input_audio_buffer.speech_stopped", audio_end_ms=ms, item_id=item_id))
            end = min(self._in_total, pos + IN_SR // 5)   # keep a 200 ms tail for STT
            start = max(self._buf_start, self._speech_start)
            audio = self._buffer_slice(start, end)
            self._consume_buffer(end)
            spec = self._take_spec(item_id, pos)
            self._commit_item(item_id, audio, transcript_future=spec["stt"] if spec else None)
            if td.get("create_response", True):
                if self.active is not None and not self.active.finalized:
                    self._pending_auto = True
                    if spec:
                        self._cancel_spec_llm(spec)
                else:
                    self._start_response(self._response_from_session(auto=True),
                                         llm_source=self._spec_source(spec) if spec and spec.get("llm") else None)
            else:
                self._arm_idle()
        elif typ in ("likely_end", "speech_paused", "end_of_turn_candidate", "turn_likely_end"):
            self._maybe_speculate(None, pos)
        elif typ in ("speech_resumed", "resumed"):
            self._discard_spec()
        elif typ in ("timeout_triggered", "idle_timeout"):
            self._emit(E.server_event("input_audio_buffer.timeout_triggered", audio_start_ms=ms, audio_end_ms=ms,
                                      item_id=E.new_id("item")))

    # --- idle timeout (turn_detection.idle_timeout_ms, server_vad)
    def _arm_idle(self) -> None:
        """(Re)start the idle timer. It counts from the end of the last response's playback."""
        self._disarm_idle()
        td = self.td or {}
        ms = td.get("idle_timeout_ms")
        if self.closed or not ms or td.get("type") != "server_vad" or self._speech_item is not None:
            return
        if self.active is not None:
            return    # re-armed when that response is done
        self._idle_task = self._spawn(self._idle_wait(int(ms)))

    def _disarm_idle(self) -> None:
        if self._idle_task is not None:
            self._idle_task.cancel()
            self._idle_task = None

    async def _idle_wait(self, ms: int) -> None:
        while self.output.busy():          # "applied after the last model response's audio has finished playing"
            await asyncio.sleep(0.05)
        start = self._in_total
        await asyncio.sleep(ms / 1000)
        td = self.td or {}
        if (self.closed or td.get("idle_timeout_ms") != ms or self._speech_item is not None
                or (self.active is not None and not self.active.finalized)):
            return
        self._idle_task = None
        item_id = E.new_id("item")
        self._emit(E.server_event("input_audio_buffer.timeout_triggered", audio_start_ms=start * 1000 // IN_SR,
                                  audio_end_ms=self._in_total * 1000 // IN_SR, item_id=item_id))
        audio = self._buffer_slice(self._buf_start, self._buf_start + self._buf_len)
        self._consume_buffer(self._buf_start + self._buf_len)
        fut = asyncio.get_running_loop().create_future()
        fut.set_result("")                 # the committed audio is the silence itself
        item = self._commit_item(item_id, audio, transcript_future=fut)
        item["_idle_ms"] = ms
        if td.get("create_response", True):
            self._start_response(self._response_from_session(auto=True))
        else:
            self._arm_idle()

    def _barge_in(self) -> None:
        # Like OpenAI: only the default-conversation response is interrupted; out-of-band ones go on.
        r = self.active
        if r is not None and not r.finalized:
            self._cancel(r, "turn_detected")
        elif self.output.busy():
            inband = {rid for rid, x in self.responses.items() if x.in_band}
            self._clear_output_and_truncate(inband)

    # --- partial transcripts while talking
    def _start_partials(self) -> None:
        if not (self.cfg.partial_transcripts and self.engine.streaming_factory
                and self.config["audio"]["input"].get("transcription") is not None):
            return
        try:
            if self._streamer is None:
                tc = self.config["audio"]["input"]["transcription"] or {}
                self._streamer = self.engine.streaming_factory(self.engine.stt, language=tc.get("language"),
                                                               prompt=tc.get("prompt"))
            else:
                self._streamer.reset()
            pre = self._buffer_slice(max(self._buf_start, self._speech_start), self._in_total)
            if pre.size:
                self._streamer.feed(pre)
        except Exception:
            log.exception("streaming transcriber unavailable")
            self._streamer = None
            return
        if self._partial_task is None or self._partial_task.done():
            self._partial_task = self._spawn(self._partial_loop(self._speech_item))

    def _stop_partials(self) -> None:
        if self._partial_task is not None:
            self._partial_task.cancel()
            self._partial_task = None

    async def _partial_loop(self, item_id: str | None) -> None:
        if not item_id:
            return
        st = self._streamer
        while self._speech_item == item_id:
            await asyncio.sleep(0.1)
            try:
                if hasattr(st, "due") and not st.due():
                    continue
                if SCHED.busy():              # someone waits for a final transcript / first audio
                    SCHED.counters["partials_skipped"] += 1
                    continue
                SCHED.counters["partials_run"] += 1
                d = await st.partial()
            except Exception:
                log.exception("partial transcription failed")
                return
            if d and self._speech_item == item_id:
                if len(self._partial_emitted) > 32:
                    self._partial_emitted.pop(next(iter(self._partial_emitted)))
                self._partial_emitted[item_id] = self._partial_emitted.get(item_id, "") + d
                self._emit(E.server_event("conversation.item.input_audio_transcription.delta", item_id=item_id,
                                          content_index=0, delta=d))

    # --- speculative start (likely end of turn)
    def attach_output(self, out: "AudioOutput") -> None:
        """Make `out` this session's speaker: playout events, event emission and echo gating."""
        self.output = out
        out.on_event = self._on_output_event
        out.emit = self._emit
        if getattr(self.cfg, "echo_gate", True):
            out.on_sent = self._echo_sent
            out.on_cleared = self._echo_cleared

    # ------------------------------------------------------------- echo gating
    def _echo_sent(self, pcm24k: np.ndarray, play_start: float) -> None:
        """Feed what the speaker plays to the turn detector so its echo in the mic is not a barge-in."""
        det = self._turn
        if det is None or not hasattr(det, "push_playback"):
            return
        at_ms = int(det.position_ms + (play_start - time.monotonic()) * 1000)
        det.push_playback(pcm24k, at_ms=at_ms, sr=OUT_SR)

    def _stt_stream_kw(self) -> dict:
        """stream= for the engine's STT so a final drops this utterance's queued partials."""
        key = getattr(self._streamer, "stream_key", None)
        return {"stream": key} if key is not None else {}

    def _echo_cleared(self) -> None:
        det = self._turn
        if det is not None and hasattr(det, "clear_playback"):
            det.clear_playback()

    def _maybe_speculate(self, audio: np.ndarray | None, speech_end: int) -> None:
        """Likely end of turn: start STT now (and the LLM in auto-response mode). Confirmed by a
        speech_stopped with the same speech end; discarded if the user keeps talking."""
        if not self.cfg.speculative or self._spec is not None or self._speech_item is None:
            return
        td = self.td or {}
        if audio is None or not getattr(audio, "size", 0):
            audio = self._buffer_slice(max(self._buf_start, self._speech_start), min(self._in_total, speech_end + IN_SR // 5))
        if audio.size < IN_SR // 5:
            return
        tcfg = self.config["audio"]["input"].get("transcription") or {}
        stt = asyncio.ensure_future(SCHED.urgent_transcribe(self.engine.stt, audio, language=tcfg.get("language"),
                                                            prompt=tcfg.get("prompt"), **self._stt_stream_kw()))
        det = self._turn
        if det is not None and hasattr(det, "set_transcript_hint"):
            # Lexical end-of-turn hint for semantic_vad ("I'd like to..." is not finished).
            stt.add_done_callback(lambda f: (not f.cancelled() and f.exception() is None)
                                  and det.set_transcript_hint(f.result()))
        spec = {"item": self._speech_item, "end": speech_end, "stt": stt, "version": self._conv_version, "llm": None,
                "queue": None, "t": time.monotonic()}
        self._spec = spec
        if td.get("create_response", True) and (self.active is None or self.active.finalized):
            spec["queue"] = asyncio.Queue()
            spec["llm"] = self._spawn(self._spec_llm(spec))

    async def _spec_llm(self, spec: dict) -> None:
        q: asyncio.Queue = spec["queue"]
        try:
            text = (await spec["stt"]) or ""
            r = self._response_from_session(auto=True)
            msgs = self._build_messages(r, extra_user=text.strip())
            agen = self.engine.llm.stream(msgs, r.tools, r.tool_choice, r.temperature, _max_tokens(r.max_output_tokens))
            try:
                async for ev in agen:
                    q.put_nowait(ev)
                    if ev.type in ("done", "error"):
                        break
            finally:
                with contextlib.suppress(Exception):
                    await agen.aclose()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            from types import SimpleNamespace
            q.put_nowait(SimpleNamespace(type="error", error=str(e), text="", tool_call=None, usage=None, meta=None))
        finally:
            q.put_nowait(None)

    def _take_spec(self, item_id: str, end_sample: int) -> dict | None:
        spec, self._spec = self._spec, None
        if spec is None:
            return None
        ok = (spec["item"] == item_id and spec["version"] == self._conv_version
              and abs(end_sample - spec["end"]) <= IN_SR * 6 // 100 and not spec["stt"].cancelled())
        if not ok:
            self._kill_spec(spec)
            return None
        self.stats["speculative_hits"] = self.stats.get("speculative_hits", 0) + 1
        return spec

    def _cancel_spec_llm(self, spec: dict) -> None:
        if spec.get("llm"):
            spec["llm"].cancel()
            spec["llm"] = None

    def _kill_spec(self, spec: dict) -> None:
        self._cancel_spec_llm(spec)
        if not spec["stt"].done():
            spec["stt"].cancel()

    def _discard_spec(self) -> None:
        if self._spec is not None:
            self._kill_spec(self._spec)
            self._spec = None
            self.stats["speculative_discards"] = self.stats.get("speculative_discards", 0) + 1

    async def _spec_source(self, spec: dict) -> AsyncIterator:
        q: asyncio.Queue = spec["queue"]
        try:
            while True:
                ev = await q.get()
                if ev is None:
                    return
                yield ev
        finally:
            if spec.get("llm") and not spec["llm"].done():
                spec["llm"].cancel()

    # --- conversation items
    def _insert(self, item: dict, previous_item_id: str | None) -> str | None:
        if previous_item_id == "root":
            pos = 0
        elif previous_item_id:
            prev = self.index.get(previous_item_id)
            if prev is None:
                raise E.SessionConfigError(f"Previous item with id '{previous_item_id}' not found.",
                                           "item.previous_item_id", "item_not_found")
            pos = self.items.index(prev) + 1
        else:
            pos = len(self.items)
        self.items.insert(pos, item)
        self.index[item["id"]] = item
        self._conv_version += 1
        return self.items[pos - 1]["id"] if pos > 0 else None

    def _prev_id(self, item: dict) -> str | None:
        try:
            i = self.items.index(item)
        except ValueError:
            return None
        return self.items[i - 1]["id"] if i > 0 else None

    def _announce_item(self, item: dict, prev: str | None, done: bool = True) -> None:
        pub = E.public_item(item)
        if self.cfg.legacy_item_created:
            self._emit(E.server_event("conversation.item.created", previous_item_id=prev, item=pub))
        self._emit(E.server_event("conversation.item.added", previous_item_id=prev, item=pub))
        if done:
            self._emit(E.server_event("conversation.item.done", previous_item_id=prev, item=E.public_item(item)))

    def _h_item_create(self, ev: dict) -> None:
        if "item" not in ev:
            raise E.SessionConfigError("Missing required parameter: 'item'.", "item", "missing_required_parameter")
        raw = ev["item"]
        if not isinstance(raw, dict):
            raise E._bad_type("item", "an object", raw)
        prev_id = _id_param(ev, "previous_item_id", required=False)
        item = self._normalize_item(raw)
        if item["id"] in self.index:
            raise E.SessionConfigError(f"Item with id '{item['id']}' already exists.", "item.id", "duplicate_item_id")
        if item["type"] == "function_call_output" and item["call_id"] not in self._call_ids:
            raise E.SessionConfigError(f"Tool call ID '{item['call_id']}' not found in conversation.", "item.call_id")
        prev = self._insert(item, prev_id)
        if item["type"] == "function_call":
            self._remember_call(item["call_id"])
        self._announce_item(item, prev)
        if item.get("_audio16k") is not None:
            audio = item.pop("_audio16k")
            self._transcripts[item["id"]] = self._spawn(self._transcribe(item, audio))

    def _remember_call(self, call_id: str) -> None:
        self._call_ids[call_id] = None
        if len(self._call_ids) > 4096:
            for k in list(self._call_ids)[:1024]:
                self._call_ids.pop(k, None)

    def _normalize_item(self, raw: dict) -> dict:
        typ = raw.get("type", "message")
        rid = raw.get("id")
        if rid is not None:
            if not isinstance(rid, str):
                raise E._bad_type("item.id", "a string", rid)
            if not rid or len(rid) > 32:
                raise E.SessionConfigError("Invalid 'item.id': string too long. Expected a string with maximum length 32.",
                                           "item.id")
        item: dict = {"id": rid or E.new_id("item"), "object": "realtime.item", "type": typ}

        def text_of(c: dict, key: str, param: str) -> str:
            v = c.get(key, "")
            if v is None:
                return ""
            if not isinstance(v, str):
                raise E._bad_type(param, "a string", v)
            return v

        if typ == "message":
            role = raw.get("role")
            if role not in ("user", "assistant", "system"):
                raise E.SessionConfigError(f"Invalid value: '{role}'. Supported values are: 'user', 'assistant' and 'system'.",
                                           "item.role")
            content = raw.get("content")
            if isinstance(content, str):
                content = [{"type": "input_text" if role != "assistant" else "output_text", "text": content}]
            if content is None:
                content = []
            if not isinstance(content, list):
                raise E._bad_type("item.content", "an array", content)
            out = []
            for i, c in enumerate(content):
                pp = f"item.content[{i}]"
                if not isinstance(c, dict):
                    raise E._bad_type(pp, "an object", c)
                ct = c.get("type")
                if ct in ("input_text", "text", "output_text"):
                    t = text_of(c, "text", f"{pp}.text")
                    out.append({"type": "output_text" if role == "assistant" else "input_text", "text": t})
                elif ct == "input_audio" and role == "user":
                    tr = c.get("transcript")
                    if tr is not None and not isinstance(tr, str):
                        raise E._bad_type(f"{pp}.transcript", "a string", tr)
                    part = {"type": "input_audio", "transcript": tr}
                    if c.get("audio") is not None and not tr:
                        pcm = pcm16_bytes_to_float32(_b64(c["audio"], f"{pp}.audio"))
                        item["_audio16k"] = Resampler(24000, IN_SR).process(pcm)
                    out.append(part)
                elif ct in ("output_audio", "audio") and role == "assistant":
                    out.append({"type": "output_audio", "transcript": text_of(c, "transcript", f"{pp}.transcript")})
                elif ct == "input_image" and role == "user":
                    out.append({"type": "input_image", "image_url": c.get("image_url"), "detail": c.get("detail", "auto")})
                else:
                    raise E.SessionConfigError(f"Unsupported content type '{ct}' for role '{role}'", f"{pp}.type")
            item.update(status=raw.get("status") if raw.get("status") in ("completed", "incomplete", "in_progress") else "completed",
                        role=role, content=out)
        elif typ == "function_call":
            for k in ("call_id", "name"):
                if not raw.get(k):
                    raise E.SessionConfigError(f"Missing required parameter: 'item.{k}'.", f"item.{k}", "missing_required_parameter")
                if not isinstance(raw[k], str):
                    raise E._bad_type(f"item.{k}", "a string", raw[k])
            args = raw.get("arguments", "")
            item.update(status="completed", call_id=raw["call_id"], name=raw["name"],
                        arguments=args if isinstance(args, str) else json.dumps(args))
        elif typ == "function_call_output":
            if not raw.get("call_id"):
                raise E.SessionConfigError("Missing required parameter: 'item.call_id'.", "item.call_id", "missing_required_parameter")
            if not isinstance(raw["call_id"], str):
                raise E._bad_type("item.call_id", "a string", raw["call_id"])
            out = raw.get("output", "")
            item.update(status="completed", call_id=raw["call_id"], output=out if isinstance(out, str) else json.dumps(out))
        else:
            raise E.SessionConfigError(f"Invalid value: '{typ}'. Supported values are: 'message', 'function_call' and "
                                       "'function_call_output'.", "item.type")
        return item

    def _h_item_delete(self, ev: dict) -> None:
        iid = _id_param(ev, "item_id")
        item = self.index.get(iid)
        if item is None:
            return self._error("item_not_found", f"Item with item_id '{iid}' not found.", param="item_id", event_id=ev.get("event_id"))
        self.items.remove(item)
        del self.index[iid]
        self._conv_version += 1
        self._transcripts.pop(iid, None)   # a running transcription finishes but no longer affects anything
        self._emit(E.server_event("conversation.item.deleted", item_id=iid))

    def _h_item_retrieve(self, ev: dict) -> None:
        iid = _id_param(ev, "item_id")
        item = self.index.get(iid)
        if item is None:
            return self._error("item_not_found", f"Item with item_id '{iid}' not found.", param="item_id", event_id=ev.get("event_id"))
        self._emit(E.server_event("conversation.item.retrieved", item=E.public_item(item)))

    def _h_item_truncate(self, ev: dict) -> None:
        eid = ev.get("event_id")
        iid = _id_param(ev, "item_id")
        item = self.index.get(iid)
        if item is None:
            return self._error("item_not_found", f"Item with item_id '{iid}' not found.", param="item_id", event_id=eid)
        if item.get("type") != "message" or item.get("role") != "assistant":
            return self._error("invalid_value", "Only assistant message items can be truncated.", param="item_id", event_id=eid)
        ci = ev.get("content_index", 0)
        if ci is None:
            ci = 0
        if not (isinstance(ci, int) and not isinstance(ci, bool)):
            raise E._bad_type("content_index", "an integer", ci)
        content = item.get("content") or []
        if not 0 <= ci < len(content) or content[ci].get("type") != "output_audio":
            return self._error("invalid_value", f"Content index {ci} is not an audio part.", param="content_index", event_id=eid)
        if ev.get("audio_end_ms") is None:
            raise E.SessionConfigError("Missing required parameter: 'audio_end_ms'.", "audio_end_ms", "missing_required_parameter")
        ms = ev["audio_end_ms"]
        if not E._is_num(ms):
            raise E._bad_type("audio_end_ms", "an integer", ms)
        ms = int(ms)
        if ms < 0:
            return self._error("invalid_value", "audio_end_ms must be >= 0", param="audio_end_ms", event_id=eid)
        final = item.get("_audio_final", True)
        total_ms = int(item.get("_audio_samples", 0) * 1000 / OUT_SR)
        if item.get("_truncated_ms") is not None:
            total_ms = min(total_ms, int(item["_truncated_ms"]))   # already cut: that audio is gone
            final = True
        if ms > total_ms + 50 and final:
            return self._error("invalid_value", f"Audio content of {total_ms}ms is already shorter than {ms}ms",
                               param="audio_end_ms", event_id=eid)
        self._truncate_item(item, min(ms, total_ms) if final else ms)

    def _truncate_item(self, item: dict, audio_end_ms: int, emit: bool = True) -> None:
        marks = item.get("_marks")
        if marks:
            heard = _heard_text(marks, int(audio_end_ms * OUT_SR / 1000))
        else:   # marks compacted away (old item) or none: keep a proportional prefix of the words
            words = (item["content"][0].get("transcript") or "").split()
            total = max(1, int(item.get("_audio_samples", 0) * 1000 / OUT_SR))
            heard = " ".join(words[: int(len(words) * min(1.0, audio_end_ms / total))])
        item["content"][0]["transcript"] = heard
        item["_truncated_ms"] = audio_end_ms
        self._conv_version += 1
        if emit:
            self._emit(E.server_event("conversation.item.truncated", item_id=item["id"], content_index=0,
                                      audio_end_ms=audio_end_ms))

    # --- output audio buffer (WebRTC)
    def _h_output_clear(self, ev: dict) -> None:
        live = [r for r in self.responses.values() if not r.finalized and r.msg and r.msg.audio]
        for r in live:
            self._cancel(r, "client_cancelled")
        if not live or self.output.busy():
            self._clear_output_and_truncate()

    def _clear_output_and_truncate(self, response_ids: set[str] | None = None) -> None:
        hit = self.output.clear(response_ids)
        for it in hit:
            item = self.index.get(it.item_id)
            if item is not None and item.get("_marks") is not None:
                ms = int(it.sent * 1000 / OUT_SR)
                if ms < int(item.get("_audio_samples", 0) * 1000 / OUT_SR):
                    self._truncate_item(item, ms)
        if not hit and self.transport == "webrtc":
            self._emit(E.server_event("output_audio_buffer.cleared", response_id=None))

    def _on_output_event(self, typ: str, response_id: str) -> None:
        if self.transport != "webrtc":
            return
        self._emit(E.server_event(f"output_audio_buffer.{typ}", response_id=response_id))
        if typ == "started":
            r = self.responses.get(response_id)
            if r and r.first_audio_at is None:
                r.first_audio_at = time.monotonic()

    # --- responses
    def _response_from_session(self, auto: bool = False, spec: dict | None = None) -> Response:
        s = self.config
        spec = spec or {}
        audio_out = (spec.get("audio") or {}).get("output") or {}
        mods = spec.get("output_modalities") or spec.get("modalities") or s.get("output_modalities") or ["audio"]
        mods = ["audio"] if "audio" in mods else ["text"]
        conv = spec.get("conversation", "auto")
        return Response(
            id=E.new_id("resp"), in_band=conv not in ("none", None) if "conversation" in spec else True,
            modalities=mods,
            instructions=spec["instructions"] if spec.get("instructions") is not None else None,
            tools=spec["tools"] if spec.get("tools") is not None else s.get("tools") or [],
            tool_choice=spec.get("tool_choice") or s.get("tool_choice", "auto"),
            metadata=spec.get("metadata"),
            voice=audio_out.get("voice") or spec.get("voice") or s["audio"]["output"].get("voice", "alloy"),
            speed=float(s["audio"]["output"].get("speed", 1.0)),
            max_output_tokens=spec.get("max_output_tokens", spec.get("max_response_output_tokens", s.get("max_output_tokens", "inf"))),
            temperature=spec.get("temperature", s.get("temperature")),
            input_items=spec.get("input"),
            auto=auto,
        )

    def _h_response_create(self, ev: dict) -> None:
        spec = ev.get("response")
        if spec is None:
            spec = {}
        E.validate_response_spec(spec, self.config)
        if spec.get("input") is not None:
            resolved = []
            for i, raw in enumerate(spec["input"]):
                if raw.get("type") == "item_reference":
                    it = self.index.get(raw.get("id")) if isinstance(raw.get("id"), str) else None
                    if it is None:
                        raise E.SessionConfigError(f"Item with id '{raw.get('id')}' not found.", f"response.input[{i}].id",
                                                   "item_not_found")
                    resolved.append(it)
                else:
                    try:
                        resolved.append(self._normalize_item(raw))
                    except E.SessionConfigError as e:
                        raise E.SessionConfigError(str(e), f"response.input[{i}]" + (e.param or "")[4:], e.code)
            spec = {**spec, "input": resolved}
        r = self._response_from_session(spec=spec)
        r.client_event_id = ev.get("event_id")
        if r.in_band and self.active is not None and not self.active.finalized:
            return self._error("conversation_already_has_active_response",
                               f"Conversation already has an active response in progress: {self.active.id}. "
                               "Wait until the response is finished before creating a new one.",
                               event_id=ev.get("event_id"))
        if r.in_band:
            self._discard_spec()
        self._start_response(r)

    def _start_response(self, r: Response, llm_source: AsyncIterator | None = None) -> None:
        self.responses[r.id] = r
        if r.in_band:
            self.active = r
            self._pending_auto = False
            self._disarm_idle()
        r.llm_source = llm_source
        self._emit(E.server_event("response.created", response=self._response_obj(r)))
        r.task = self._spawn(self._run_response(r))

    def _response_obj(self, r: Response, usage: dict | None = None, details: dict | None = None) -> dict:
        return E.response_object(r.id, status=r.status, conversation_id=self.conversation_id if r.in_band else None,
                                 modalities=r.modalities, voice=r.voice, max_output_tokens=r.max_output_tokens,
                                 metadata=r.metadata, output=[E.public_item(i) for i in r.output],
                                 usage=usage, status_details=details)

    def _h_response_cancel(self, ev: dict) -> None:
        rid = _id_param(ev, "response_id", required=False)
        r = self.responses.get(rid) if rid else self.active
        if r is None or r.finalized:
            if rid is None:
                # an out-of-band response is the only one running
                live = [x for x in self.responses.values() if not x.finalized]
                if live:
                    r = live[-1]
            if r is None or r.finalized:
                return self._error("response_cancel_not_active", "Cancellation failed: no active response found",
                                   event_id=ev.get("event_id"))
        self._cancel(r, "client_cancelled")

    async def _await_inputs(self, r: Response) -> None:
        pending = [f for f in self._transcripts.values() if not f.done()]
        if pending:
            await asyncio.wait(pending, timeout=15)
        if len(self._transcripts) > 256:
            for k in [k for k, f in self._transcripts.items() if f.done()][:128]:
                self._transcripts.pop(k, None)

    def _build_messages(self, r: Response, extra_user: str | None = None) -> list[dict]:
        instructions = r.instructions if r.instructions is not None else self.config.get("instructions") or ""
        head: list[dict] = [{"role": "system", "content": instructions}] if instructions else []
        if r.input_items is not None:
            source = list(r.input_items)   # resolved + normalised in response.create
        else:
            source = list(self.items)
        outputs = {it["call_id"]: it for it in source if it.get("type") == "function_call_output"}
        used: set[str] = set()
        msgs: list[dict] = []     # conversation part (after instructions)
        srcs: list[str] = []      # item id each message came from (for sticky truncation)

        def add(m: dict, src: str) -> None:
            msgs.append(m)
            srcs.append(src)

        i = 0
        while i < len(source):
            it = source[i]
            typ = it.get("type")
            if typ == "message":
                role = it.get("role")
                texts = []
                for c in it.get("content") or []:
                    ct = c.get("type")
                    if ct in ("input_text", "output_text", "text"):
                        texts.append(c.get("text") or "")
                    elif ct in ("input_audio", "output_audio"):
                        tr = c.get("transcript")
                        if tr is None and ct == "input_audio":
                            f = self._transcripts.get(it["id"])
                            if f is not None and f.done() and not f.cancelled() and f.exception() is None:
                                tr = f.result()
                        texts.append(tr or "")
                text = " ".join(t for t in texts if t).strip()
                if text:
                    add({"role": role, "content": text}, it["id"])
                elif it.get("_idle_ms"):
                    add({"role": "system", "content": f"(The user has said nothing for {it['_idle_ms'] / 1000:g} seconds. "
                                                      "Gently prompt them to continue.)"}, it["id"])
                i += 1
            elif typ == "function_call":
                calls = []
                first = it["id"]
                while i < len(source) and source[i].get("type") == "function_call":
                    fc = source[i]
                    calls.append({"id": fc["call_id"], "type": "function",
                                  "function": {"name": fc["name"], "arguments": fc.get("arguments") or "{}"}})
                    i += 1
                if msgs and msgs[-1]["role"] == "assistant" and "tool_calls" not in msgs[-1]:
                    msgs[-1]["tool_calls"] = calls
                else:
                    add({"role": "assistant", "content": None, "tool_calls": calls}, first)
                for c in calls:
                    o = outputs.get(c["id"])
                    used.add(c["id"])
                    add({"role": "tool", "tool_call_id": c["id"],
                         "content": o["output"] if o is not None else '{"error": "no result was returned for this call"}'},
                        o["id"] if o is not None else first)
            elif typ == "function_call_output":
                if it["call_id"] not in used:
                    add({"role": "user", "content": f"[result of tool call {it['call_id']}]: {it.get('output', '')}"}, it["id"])
                i += 1
            else:
                i += 1
        if extra_user:
            add({"role": "user", "content": extra_user}, "")
        msgs = self._truncate_context(r, head, msgs, srcs, persist=r.input_items is None)
        out = head + msgs
        r.prompt_chars = sum(len(m.get("content") or "") for m in out)
        return out

    def _truncate_context(self, r: Response, head: list[dict], msgs: list[dict], srcs: list[str], *, persist: bool) -> list[dict]:
        """OpenAI `truncation`: drop the oldest conversation messages from the LLM request when it would
        not fit the context window. The realtime conversation itself is never touched.
        'auto' drops just enough; retention_ratio drops down to ratio x budget so the cut point (and the
        provider's prompt cache) stays put for many turns; 'disabled' fails the response instead.
        Tool calls stay with their results (a kept window never starts with a tool message)."""
        mode = self.config.get("truncation", "auto")
        ctx = max(256, int(getattr(self.cfg, "context_tokens", 32768)))
        mx = _max_tokens(r.max_output_tokens) or E.MAX_OUTPUT_TOKENS
        reserve = min(mx, ctx // 8)
        budget = ctx - reserve - E.estimate_tokens(head) - E.estimate_tokens(r.tools or [])
        ratio = None
        if isinstance(mode, dict):
            ratio = float(mode.get("retention_ratio", 1.0))
            pi = (mode.get("token_limits") or {}).get("post_instructions")
            if pi:
                budget = min(budget, int(pi))
        budget = max(1, budget)
        # groups: an assistant(+tool_calls) message and its tool results are dropped together
        starts = [k for k, m in enumerate(msgs) if m["role"] != "tool"]
        if not starts:
            return msgs
        if starts[0] != 0:
            starts.insert(0, 0)
        ends = starts[1:] + [len(msgs)]
        gtok = [E.estimate_tokens(msgs[a:b]) for a, b in zip(starts, ends)]
        total = sum(gtok)
        if mode == "disabled":
            if total > budget:
                raise _ContextExceeded(f"The conversation ({total} tokens) exceeds the input token limit ({budget}) "
                                       "and truncation is disabled.")
            return msgs
        g = 0
        cut = getattr(self, "_trunc_cut", None) if persist else None
        if cut:
            g = next((k for k, a in enumerate(starts) if srcs[a] == cut), 0)
        kept = sum(gtok[g:])
        if kept > budget:
            target = budget if ratio is None else max(1, int(budget * ratio))
            while g < len(starts) - 1 and kept > target:
                kept -= gtok[g]
                g += 1
        if persist:
            self._trunc_cut = srcs[starts[g]] if g > 0 else None
        if g:
            self.stats["truncated_messages"] = starts[g]
        return msgs[starts[g]:]

    async def _run_response(self, r: Response) -> None:
        agen = None
        try:
            if r.llm_source is None:
                await self._await_inputs(r)
                msgs = self._build_messages(r)
                r.llm_source = self.engine.llm.stream(msgs, r.tools, r.tool_choice, r.temperature,
                                                      _max_tokens(r.max_output_tokens))
            else:
                self._build_messages(r)  # for usage accounting only
            agen = r.llm_source
            async for ev in agen:
                et = getattr(ev, "type", None)
                if et == "text_delta":
                    if ev.text:
                        self._on_text(r, ev.text)
                elif et == "tool_call" and ev.tool_call is not None:
                    self._on_tool_call(r, ev.tool_call)
                elif et == "error":
                    raise _LLMFailure(ev.error or "LLM error", ((getattr(ev, "meta", None) or {}).get("code")))
                elif et == "done":
                    r.usage, r.meta = ev.usage, ev.meta
                    m = ev.meta or {}
                    log.info("response %s llm: provider=%s ttft=%sms text_ttft=%sms total=%sms finish=%s chars=%d",
                             r.id, m.get("provider_slug") or m.get("provider"), m.get("ttft_ms"),
                             m.get("text_ttft_ms"), m.get("total_ms"), m.get("finish_reason"), len(m.get("text") or ""))
                    break
            with contextlib.suppress(Exception):
                await agen.aclose()
            agen = None
            if r.msg is not None:
                await self._finish_message(r)
                if r.msg.audio and self.output.was_cleared(r.msg.item["id"]):
                    return self._finalize(r, "cancelled", reason="turn_detected")
            self._finalize(r, "completed")
        except asyncio.CancelledError:
            raise
        except _ContextExceeded as e:
            self._finalize(r, "failed", error={"type": "invalid_request_error", "code": "context_length_exceeded",
                                               "message": str(e)})
        except _LLMFailure as e:
            log.warning("response %s failed: %s", r.id, e)
            # meta.code from the LLM layer: insufficient_credits | rate_limited | context_length_exceeded | ...
            typ = "invalid_request_error" if e.code == "context_length_exceeded" else "server_error"
            self._finalize(r, "failed", error={"type": typ, "code": e.code, "message": str(e)})
        except Exception as e:
            log.exception("response %s crashed", r.id)
            self._finalize(r, "failed", error={"type": "server_error", "code": "server_error", "message": str(e)})
        finally:
            if agen is not None:
                with contextlib.suppress(BaseException):
                    await asyncio.shield(_aclose(agen))

    # --- message streaming
    def _open_message(self, r: Response) -> _Msg:
        audio = r.modalities == ["audio"]
        item = {"id": E.new_id("item"), "object": "realtime.item", "type": "message", "status": "in_progress",
                "role": "assistant", "content": []}
        m = _Msg(item=item, output_index=len(r.output), audio=audio)
        r.output.append(item)
        r.msg = m
        prev = self._insert(item, None) if r.in_band else None
        self._emit(E.server_event("response.output_item.added", response_id=r.id, output_index=m.output_index,
                                  item=E.public_item(item)))
        if r.in_band:
            self._announce_item(item, prev, done=False)
        part = {"type": "audio", "transcript": ""} if audio else {"type": "text", "text": ""}
        item["content"] = [{"type": "output_audio", "transcript": ""} if audio else {"type": "output_text", "text": ""}]
        self._emit(E.server_event("response.content_part.added", response_id=r.id, item_id=item["id"],
                                  output_index=m.output_index, content_index=0, part=part))
        if audio:
            item["_marks"] = m.marks
            item["_audio_samples"] = 0
            item["_audio_final"] = False
            self.output.begin(r.id, item["id"], m.output_index, 0)
            m.tts_q = asyncio.Queue()
            m.tts_task = self._spawn(self._tts_worker(r, m))
            if self.cfg.transcript_pacing != "eager":
                m.pacer_task = self._spawn(self._pacer(r, m))
        return m

    def _on_text(self, r: Response, text: str) -> None:
        m = r.msg or self._open_message(r)
        m.text += text
        if m.audio:
            m.tts_q.put_nowait(text)
            if self.cfg.transcript_pacing == "eager":
                self._emit_delta(r, m, text)
        else:
            self._emit_delta(r, m, text)

    def _emit_delta(self, r: Response, m: _Msg, delta: str) -> None:
        if not delta:
            return
        m.emitted += delta
        typ = "response.output_audio_transcript.delta" if m.audio else "response.output_text.delta"
        self._emit(E.server_event(typ, response_id=r.id, item_id=m.item["id"], output_index=m.output_index,
                                  content_index=0, delta=delta))

    def _tts_kwargs(self) -> dict:
        if not hasattr(self, "_tts_lang_ok"):
            import inspect
            try:
                self._tts_lang_ok = "language" in inspect.signature(self.engine.tts.stream).parameters
            except (TypeError, ValueError):
                self._tts_lang_ok = False
        lang = (self.config["audio"]["input"].get("transcription") or {}).get("language")
        return {"language": lang} if self._tts_lang_ok and lang else {}

    async def _tts_worker(self, r: Response, m: _Msg) -> None:
        """LLM text → TTS (which does its own clause segmentation) → output queue + word marks."""
        item_id = m.item["id"]
        agen = self.engine.tts.stream(_queue_iter(m.tts_q), r.voice, r.speed, **self._tts_kwargs())
        ahead = max(0.5, float(getattr(self.cfg, "tts_ahead_s", 2.0))) * OUT_SR
        SCHED.first_tts += 1
        first_pending, t0 = True, time.monotonic()
        try:
            async for chunk in agen:
                a = np.asarray(chunk, np.float32).ravel()
                if a.size == 0:
                    continue
                if first_pending:
                    first_pending = False
                    SCHED.first_tts -= 1
                    SCHED.counters["tts_first"] += 1
                    SCHED.note("tts_first_ms", (time.monotonic() - t0) * 1000)
                text = getattr(chunk, "text", None)
                start = m.total_samples
                if r.first_audio_at is None and self.transport != "webrtc":
                    r.first_audio_at = time.monotonic()
                self.output.push(item_id, a)
                m.total_samples += a.size
                m.item["_audio_samples"] = m.total_samples
                if text:
                    joiner = " " if m.spoken and not m.spoken[-1].isspace() and not text[0].isspace() else ""
                    marks = _chunk_marks(text, getattr(chunk, "words", None), start, a.size, joiner)
                    m.marks.extend(marks)
                    m.spoken += "".join(w for _, w in marks)
                # bounded read-ahead: the TTS stream (lookahead 2) pauses while plenty is queued
                throttled = False
                while (m.total_samples - self.output.played_samples(item_id) > ahead
                       and not self.output.was_cleared(item_id)):
                    throttled = True
                    await asyncio.sleep(0.05)
                if throttled:
                    SCHED.counters["tts_throttled"] += 1
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("TTS failed")
        finally:
            if first_pending:
                SCHED.first_tts -= 1
            with contextlib.suppress(BaseException):
                await asyncio.shield(_aclose(agen))
        if not m.marks and m.text.strip():
            # TTS without per-chunk text: attribute the whole text to the end of the audio
            m.marks.append((max(0, m.total_samples - 1), m.text))
            m.spoken = m.text
        m.item["_audio_final"] = True
        r.audio_out_samples = m.total_samples
        self.output.finish(item_id)

    async def _pacer(self, r: Response, m: _Msg) -> None:
        """Emit transcript words as their audio starts playing."""
        item_id = m.item["id"]
        while True:
            played = self.output.played_samples(item_id)
            buf = []
            while m.mark_i < len(m.marks) and m.marks[m.mark_i][0] <= played:
                buf.append(m.marks[m.mark_i][1])
                m.mark_i += 1
            if buf:
                self._emit_delta(r, m, "".join(buf))
            if self.output.was_cleared(item_id):
                return                      # audio cut (output_audio_buffer.clear / barge-in): nothing more plays
            if m.tts_task is not None and m.tts_task.done() and m.mark_i >= len(m.marks) and played >= m.total_samples:
                return
            await asyncio.sleep(0.02)

    async def _finish_message(self, r: Response) -> None:
        m = r.msg
        if m.audio:
            m.tts_q.put_nowait(None)
            await m.tts_task
            if m.pacer_task is not None:
                await m.pacer_task          # captions follow playback: done when the audio is out
            if self.transport != "webrtc":
                await self.output.wait_drained(m.item["id"])   # every output_audio.delta precedes .done

    def _close_message(self, r: Response, status: str, heard_samples: int | None = None) -> None:
        m = r.msg
        if m is None or m.closed:
            return
        m.closed = True
        item = m.item
        if m.audio:
            if status == "completed":
                transcript = m.text if self.cfg.transcript_pacing == "eager" else m.spoken
                if m.emitted != transcript and transcript.startswith(m.emitted):
                    self._emit_delta(r, m, transcript[len(m.emitted):])
            else:
                if heard_samples is None:
                    heard_samples = self.output.played_samples(item["id"])
                transcript = _heard_text(m.marks, heard_samples)
                if self.cfg.transcript_pacing != "eager" and transcript.startswith(m.emitted) and len(transcript) > len(m.emitted):
                    self._emit_delta(r, m, transcript[len(m.emitted):])
            item["content"] = [{"type": "output_audio", "transcript": transcript}]
            item["_audio_final"] = True
            self._emit(E.server_event("response.output_audio.done", response_id=r.id, item_id=item["id"],
                                      output_index=m.output_index, content_index=0))
            self._emit(E.server_event("response.output_audio_transcript.done", response_id=r.id, item_id=item["id"],
                                      output_index=m.output_index, content_index=0, transcript=transcript))
            part = {"type": "audio", "transcript": transcript}
        else:
            text = m.text if status == "completed" else m.emitted
            item["content"] = [{"type": "output_text", "text": text}]
            self._emit(E.server_event("response.output_text.done", response_id=r.id, item_id=item["id"],
                                      output_index=m.output_index, content_index=0, text=text))
            part = {"type": "text", "text": text}
        self._emit(E.server_event("response.content_part.done", response_id=r.id, item_id=item["id"],
                                  output_index=m.output_index, content_index=0, part=part))
        item["status"] = "completed" if status == "completed" else "incomplete"
        self._emit(E.server_event("response.output_item.done", response_id=r.id, output_index=m.output_index,
                                  item=E.public_item(item)))
        if r.in_band and item["id"] in self.index:
            self._emit(E.server_event("conversation.item.done", previous_item_id=self._prev_id(item), item=E.public_item(item)))

    def _on_tool_call(self, r: Response, tc: Any) -> None:
        if r.msg is not None and not r.msg.closed and not r.msg.audio:
            pass  # text part stays open; function call becomes the next output item
        call_id = getattr(tc, "call_id", None) or E.new_id("call")
        if call_id in self._call_ids:          # providers sometimes reuse ids across turns: keep them unique
            call_id = E.new_id("call")
        self._remember_call(call_id)
        args = getattr(tc, "arguments", "") or "{}"
        if not isinstance(args, str):
            args = json.dumps(args)
        item = {"id": E.new_id("item"), "object": "realtime.item", "type": "function_call", "status": "in_progress",
                "call_id": call_id, "name": tc.name, "arguments": ""}
        oi = len(r.output)
        r.output.append(item)
        prev = self._insert(item, None) if r.in_band else None
        self._emit(E.server_event("response.output_item.added", response_id=r.id, output_index=oi, item=E.public_item(item)))
        if r.in_band:
            self._announce_item(item, prev, done=False)
        self._emit(E.server_event("response.function_call_arguments.delta", response_id=r.id, item_id=item["id"],
                                  output_index=oi, call_id=call_id, delta=args))
        item["arguments"] = args
        item["status"] = "completed"
        self._emit(E.server_event("response.function_call_arguments.done", response_id=r.id, item_id=item["id"],
                                  output_index=oi, call_id=call_id, name=tc.name, arguments=args))
        self._emit(E.server_event("response.output_item.done", response_id=r.id, output_index=oi, item=E.public_item(item)))
        if r.in_band:
            self._emit(E.server_event("conversation.item.done", previous_item_id=self._prev_id(item), item=E.public_item(item)))

    # --- finish / cancel
    def _cancel(self, r: Response, reason: str, emit: bool = True) -> None:
        if r.finalized:
            return
        heard = None
        if r.task is not None and not r.task.done():
            r.task.cancel()
        m = r.msg
        if m is not None and m.audio:
            for t in (m.tts_task, m.pacer_task):
                if t is not None and not t.done():
                    t.cancel()
            self.output.clear({r.id})   # flush now: the next outbound frame is silence (other responses keep theirs)
            heard = min(self.output.sent_samples(m.item["id"]), m.total_samples)
            if emit and m.total_samples > 0 and r.in_band:
                ms = int(heard * 1000 / OUT_SR)
                m.item["_audio_samples"] = m.total_samples
                m.item["_truncated_ms"] = ms
                self._emit(E.server_event("conversation.item.truncated", item_id=m.item["id"], content_index=0, audio_end_ms=ms))
        if not emit:
            r.finalized = True
            return
        self._finalize(r, "cancelled", reason=reason, heard_samples=heard)

    def _finalize(self, r: Response, status: str, *, reason: str | None = None, error: dict | None = None,
                  heard_samples: int | None = None) -> None:
        if r.finalized:
            return
        r.finalized = True
        r.status = status
        if r.msg is not None:
            m = r.msg
            if status != "completed" and m.audio and heard_samples is None:
                heard_samples = min(self.output.played_samples(m.item["id"]), m.total_samples)
            self._close_message(r, status, heard_samples)
            for t in (m.tts_task, m.pacer_task):
                if t is not None and not t.done():
                    t.cancel()
            if m.audio:
                self.output.forget(m.item["id"])
                if r.in_band:
                    self._compact_marks(m.item)
        details = None
        if status == "cancelled":
            details = {"type": "cancelled", "reason": reason or "client_cancelled"}
        elif status == "failed":
            details = {"type": "failed", "error": error}
        elif status == "incomplete":
            details = {"type": "incomplete", "reason": reason or "max_output_tokens"}
        self._emit(E.server_event("response.done", response=self._response_obj(r, usage=self._usage(r), details=details)))
        if r.first_audio_at is not None:
            self.stats["last_first_audio_ms"] = (r.first_audio_at - r.created_at) * 1000
        if r.meta:
            self.stats["last_llm_meta"] = r.meta
        self._emit(E.rate_limits_event())
        if self.active is r:
            self.active = None
            if self._pending_auto and not self.closed:
                self._pending_auto = False
                self._start_response(self._response_from_session(auto=True))
            else:
                self._arm_idle()
        # drop old finished responses (keep memory bounded)
        if len(self.responses) > 64:
            for rid in [k for k, v in self.responses.items() if v.finalized][:32]:
                self.responses.pop(rid, None)

    KEEP_MARKS = 16

    def _compact_marks(self, item: dict) -> None:
        """Word timings are only needed to truncate recent items; older ones fall back to a
        proportional cut of the transcript (bounded memory in long sessions)."""
        q = self.__dict__.setdefault("_marked", deque())
        q.append(item)
        while len(q) > self.KEEP_MARKS:
            old = q.popleft()
            old.pop("_marks", None)

    def _usage(self, r: Response) -> dict:
        u = r.usage or {}
        in_text = int(u.get("prompt_tokens") or u.get("input_tokens") or max(1, r.prompt_chars // 4))
        out_text = int(u.get("completion_tokens") or u.get("output_tokens") or
                       max(0, len((r.msg.text if r.msg else "") + "".join(i.get("arguments", "") for i in r.output if i.get("type") == "function_call")) // 4))
        cached = int(((u.get("prompt_tokens_details") or {}).get("cached_tokens")) or 0)
        out_audio = int(r.audio_out_samples / OUT_SR * 20)
        return E.usage_object(in_text, 0, out_text, out_audio, cached)

    _HANDLERS: dict[str, Callable] = {}


def _b64(v: Any, param: str) -> bytes:
    if not isinstance(v, str):
        raise E._bad_type(param, "a base64 string", v)
    try:
        return base64.b64decode(v, validate=True)
    except (ValueError, TypeError):
        raise E.SessionConfigError(f"Invalid value for '{param}': not valid base64.", param, "invalid_value")


def _id_param(ev: dict, key: str, *, required: bool = True) -> str | None:
    if key not in ev or ev[key] is None:
        if required:
            raise E.SessionConfigError(f"Missing required parameter: '{key}'.", key, "missing_required_parameter")
        return None
    if not isinstance(ev[key], str):
        raise E._bad_type(key, "a string", ev[key])
    return ev[key]


def _max_tokens(v: Any) -> int | None:
    if v in (None, "inf"):
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


async def _aclose(agen: Any) -> None:
    close = getattr(agen, "aclose", None)
    if close is not None:
        await close()


def _g711_decode(raw: bytes, ulaw: bool) -> np.ndarray:
    return _audio.g711_decode(raw, ulaw)


def _g711_encode(pcm: np.ndarray, ulaw: bool) -> bytes:
    return _audio.g711_encode(pcm, ulaw)


Session._HANDLERS = {
    "session.update": Session._h_session_update,
    "input_audio_buffer.append": Session._h_append,
    "input_audio_buffer.commit": Session._h_commit,
    "input_audio_buffer.clear": Session._h_clear,
    "conversation.item.create": Session._h_item_create,
    "conversation.item.delete": Session._h_item_delete,
    "conversation.item.retrieve": Session._h_item_retrieve,
    "conversation.item.truncate": Session._h_item_truncate,
    "response.create": Session._h_response_create,
    "response.cancel": Session._h_response_cancel,
    "output_audio_buffer.clear": Session._h_output_clear,
}
