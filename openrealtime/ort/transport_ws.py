"""WebSocket transport: ``GET /v1/realtime?model=...`` (OpenAI Realtime WS protocol).

Audio in: ``input_audio_buffer.append`` with base64 pcm16 24 kHz (or G.711 when the session format
says so). Audio out: ``response.output_audio.delta`` (base64), sent at most ``ws_audio_lead_ms``
ahead of a virtual playout clock (real time from the first delta), so the server knows how much
the client has played when the user barges in and captions can be paced to the voice.
"""
from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging
import time

import numpy as np
from aiohttp import WSMsgType, web

from . import events as E
from .audio import Resampler, float32_to_pcm16_bytes
from .session import OUT_SR, AudioOutput, Session, _g711_encode

log = logging.getLogger("ort.ws")

PIECE = OUT_SR // 10   # 100 ms per output_audio.delta


class WSAudioOutput(AudioOutput):
    kind = "websocket"

    def __init__(self, lead_ms: int = 600, format_getter=None):
        super().__init__()
        self.lead = lead_ms / 1000.0
        self.format_getter = format_getter or (lambda: {"type": "audio/pcm", "rate": 24000})
        self._clock_end = 0.0
        self._task: asyncio.Task | None = None
        self._down: dict[str, Resampler] = {}

    def start(self) -> None:
        self._task = asyncio.get_running_loop().create_task(self._run())

    def _on_clear(self, hit) -> None:
        self._clock_end = time.monotonic()
        self.wakeup.set()

    def _encode(self, it, pcm: np.ndarray) -> str:
        fmt = self.format_getter() or {}
        ftype = fmt.get("type", "audio/pcm")
        if ftype in ("audio/pcmu", "audio/pcma"):
            rs = self._down.setdefault(it.item_id, Resampler(OUT_SR, 8000))
            return base64.b64encode(_g711_encode(rs.process(pcm), ftype == "audio/pcmu")).decode("ascii")
        return base64.b64encode(float32_to_pcm16_bytes(pcm)).decode("ascii")

    def _item_done(self, it) -> None:
        self._down.pop(it.item_id, None)

    async def _run(self) -> None:
        while True:
            it = self._head()
            if it is None:
                self.wakeup.clear()
                if self._head() is None:
                    await self.wakeup.wait()
                continue
            now = time.monotonic()
            ahead = self._clock_end - now
            if ahead > self.lead:
                self.wakeup.clear()
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(self.wakeup.wait(), ahead - self.lead)
                continue
            pcm = self._take(it, PIECE)
            if pcm.size == 0:
                continue
            play_start = max(now, self._clock_end)
            self._clock_end = play_start + pcm.size / OUT_SR
            data = self._encode(it, pcm)
            it.mark_sent(int(pcm.size), play_start)
            if self.emit is not None:
                self.emit(E.server_event("response.output_audio.delta", response_id=it.response_id, item_id=it.item_id,
                                         output_index=it.output_index, content_index=it.content_index, delta=data))

    async def close(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(BaseException):
                await self._task


def _subprotocol_key(request: web.Request) -> str | None:
    for p in request.headers.get("Sec-WebSocket-Protocol", "").split(","):
        p = p.strip()
        if p.startswith("openai-insecure-api-key."):
            return p[len("openai-insecure-api-key."):]
    return None


async def handle_ws(request: web.Request) -> web.StreamResponse:
    """aiohttp handler for GET /v1/realtime."""
    app = request.app
    from .server import STATE
    state = app[STATE]
    key = state.bearer(request) or _subprotocol_key(request) or request.query.get("api_key")
    ok, token, err = state.authorize(key)
    if not ok:
        return web.json_response({"error": {"type": "invalid_request_error", "code": "invalid_api_key", "message": err}}, status=401)

    call_id = request.query.get("call_id")
    offered = [p.strip() for p in request.headers.get("Sec-WebSocket-Protocol", "").split(",") if p.strip()]
    protocols = tuple(p for p in offered if p in ("realtime", "openai-beta.realtime-v1")) or ("realtime",)
    ws = web.WebSocketResponse(protocols=protocols, max_msg_size=32 * 1024 * 1024, heartbeat=30, compress=False)
    await ws.prepare(request)

    out_q: asyncio.Queue = asyncio.Queue()

    def listener(ev: dict) -> None:
        out_q.put_nowait(ev)

    async def sender() -> None:
        while True:
            ev = await out_q.get()
            if ev is None:
                return
            try:
                await ws.send_str(json.dumps(ev, ensure_ascii=False, separators=(",", ":")))
            except (ConnectionResetError, RuntimeError):
                return

    send_task = asyncio.get_running_loop().create_task(sender())
    owned = True
    if call_id:
        # Sideband control channel for an existing WebRTC call.
        sess = state.calls.get(call_id)
        if sess is None:
            await ws.send_str(json.dumps(E.error_event("call_not_found", f"No call with id '{call_id}'")))
            await ws.close()
            send_task.cancel()
            return ws
        session: Session = sess.session
        owned = False
        session.add_listener(listener)
        listener(E.server_event("session.created", session=session.public_session()))
    else:
        if state.at_capacity():
            await ws.send_str(json.dumps(E.error_event("session_limit_reached", "Too many concurrent sessions", type_="server_error")))
            await ws.close()
            send_task.cancel()
            return ws
        model = request.query.get("model")
        session = state.new_session(token, model, transport="websocket", output_factory=lambda s: WSAudioOutput(
            state.cfg.ws_audio_lead_ms, lambda: s.config["audio"]["output"].get("format")))
        session.add_listener(listener)
        session.output.start()
        session.start()
        state.track(session)

    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                try:
                    ev = json.loads(msg.data)
                except ValueError:
                    listener(E.error_event("invalid_json", "The server could not parse the event as JSON."))
                    continue
                await session.handle(ev)
            elif msg.type == WSMsgType.BINARY:
                # Non-standard convenience: raw pcm16 frames as binary messages.
                session.append_input(msg.data, session.config["audio"]["input"].get("format"))
            elif msg.type in (WSMsgType.ERROR, WSMsgType.CLOSE):
                break
    finally:
        session.remove_listener(listener)
        out_q.put_nowait(None)
        try:
            if owned:
                state.untrack(session)
                # Shielded so a cancelled handler (client vanished) still tears the session down fully.
                await asyncio.shield(session.close())
        finally:
            send_task.cancel()
            with contextlib.suppress(BaseException):
                await send_task
    return ws
