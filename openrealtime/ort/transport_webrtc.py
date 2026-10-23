"""WebRTC transport: ``POST /v1/realtime/calls`` (SDP offer → answer) via aiortc.

* Data channel ``oai-events`` (created by the client) carries the JSON events.
* Inbound mic track → mono → 16 kHz → session.
* Outbound `OutboundAudioTrack`: one 20 ms 48 kHz frame per tick on a drift-free clock, pulled
  from `RTCAudioOutput` (silence when empty). Every pulled frame is stamped with its play time
  (pull time + estimated network/jitter-buffer delay), so "played ms" is exact for truncation.
* Emits output_audio_buffer.started / stopped / cleared.
* ICE: host candidates on all interfaces (localhost + LAN), no STUN unless ORT_STUN is set.
  Browser offers without candidates (non-trickle, like ThinkAloud's) work through
  peer-reflexive discovery.
"""
from __future__ import annotations

import asyncio
import contextlib
import fractions
import json
import logging
import time

import numpy as np

from . import events as E
from .audio import Resampler, float32_to_int16
from .session import IN_SR, OUT_SR, AudioOutput, Session

log = logging.getLogger("ort.webrtc")

RTC_SR = 48000
FRAME_MS = 20
FRAME_24 = OUT_SR * FRAME_MS // 1000      # 480
FRAME_48 = RTC_SR * FRAME_MS // 1000      # 960


class RTCAudioOutput(AudioOutput):
    kind = "webrtc"

    def __init__(self, playout_delay_ms: int = 60):
        super().__init__()
        self.delay = playout_delay_ms / 1000.0
        self._up = Resampler(OUT_SR, RTC_SR)
        self._fifo = np.zeros(0, np.float32)
        self._playing: str | None = None     # response id whose audio is currently going out
        self.frames = 0
        self.last_nonsilent_at = 0.0

    def _emit_buf(self, typ: str, response_id: str) -> None:
        if self.on_event is not None:
            self.on_event(typ, response_id)

    def pull_24k(self) -> np.ndarray:
        """Next 20 ms at 24 kHz (zeros where nothing is queued) and its bookkeeping."""
        out = np.zeros(FRAME_24, np.float32)
        filled = 0
        base = time.monotonic() + self.delay
        while filled < FRAME_24:
            it = self._head()
            if it is None:
                break
            if not it.started:
                it.started = True
                if self._playing != it.response_id:
                    self._playing = it.response_id
                    self._emit_buf("started", it.response_id)
            pcm = self._take(it, FRAME_24 - filled)
            if pcm.size == 0:
                break
            out[filled:filled + pcm.size] = pcm
            it.mark_sent(int(pcm.size), base + filled / OUT_SR)
            filled += pcm.size
        if filled:
            self.last_nonsilent_at = time.monotonic()
        # stopped: the response's audio is fully out and nothing else follows
        self._head()
        return out

    def _item_done(self, it) -> None:
        if it.started and self._playing == it.response_id:
            nxt = self.order[0] if self.order else None
            if nxt is None or nxt.response_id != it.response_id:
                self._playing = None
                self._emit_buf("stopped", it.response_id)

    def _on_clear(self, hit) -> None:
        seen = []
        for it in hit:
            if it.response_id not in seen:
                seen.append(it.response_id)
        if self._playing and self._playing not in seen:
            seen.append(self._playing)
        self._playing = None
        for rid in seen:
            self._emit_buf("cleared", rid)

    def pull_frame(self) -> np.ndarray:
        """Next 20 ms of 48 kHz audio for the outbound track."""
        x = self.pull_24k()
        y = self._up.process(x)
        self._fifo = np.concatenate([self._fifo, y]) if self._fifo.size else y
        if self._fifo.size >= FRAME_48:
            f, self._fifo = self._fifo[:FRAME_48], self._fifo[FRAME_48:]
        else:
            f = np.concatenate([self._fifo, np.zeros(FRAME_48 - self._fifo.size, np.float32)])
            self._fifo = np.zeros(0, np.float32)
        self.frames += 1
        return f


def _make_track_class():
    import av
    from aiortc import MediaStreamTrack
    from aiortc.mediastreams import MediaStreamError

    class OutboundAudioTrack(MediaStreamTrack):
        kind = "audio"

        def __init__(self, output: RTCAudioOutput):
            super().__init__()
            self.output = output
            self._t0: float | None = None
            self._n = 0
            self._tb = fractions.Fraction(1, RTC_SR)

        async def recv(self):
            if self.readyState != "live":
                raise MediaStreamError
            now = time.monotonic()
            if self._t0 is None:
                self._t0 = now
            target = self._t0 + self._n * FRAME_MS / 1000
            wait = target - now
            if wait > 0:
                await asyncio.sleep(wait)
            elif wait < -0.25:   # stalled (loop blocked): re-anchor rather than bursting
                self._t0 = now - self._n * FRAME_MS / 1000
            pcm = self.output.pull_frame()
            frame = av.AudioFrame(format="s16", layout="mono", samples=FRAME_48)
            frame.planes[0].update(float32_to_int16(pcm).tobytes())
            frame.sample_rate = RTC_SR
            frame.pts = self._n * FRAME_48
            frame.time_base = self._tb
            self._n += 1
            return frame

    return OutboundAudioTrack


_TrackCls = None


def outbound_track(output: RTCAudioOutput):
    global _TrackCls
    if _TrackCls is None:
        _TrackCls = _make_track_class()
    return _TrackCls(output)


def frame_to_mono_float(frame) -> tuple[np.ndarray, int]:
    arr = frame.to_ndarray()
    ch = len(frame.layout.channels)
    fmt = frame.format.name
    if fmt in ("s16", "s16p"):
        x = arr.astype(np.float32) / 32768.0
    elif fmt in ("flt", "fltp"):
        x = arr.astype(np.float32)
    elif fmt in ("s32", "s32p"):
        x = arr.astype(np.float32) / 2147483648.0
    else:
        x = arr.astype(np.float32)
    if frame.format.is_planar:
        x = x.reshape(ch, -1).mean(axis=0) if ch > 1 else x.reshape(-1)
    else:
        x = x.reshape(-1, ch).mean(axis=1) if ch > 1 else x.reshape(-1)
    return x, frame.sample_rate


class Call:
    """One WebRTC peer connection bound to one Session."""

    def __init__(self, state, session: Session, pc, output: RTCAudioOutput):
        self.id = E.new_id("rtc")
        self.state = state
        self.session = session
        self.pc = pc
        self.output = output
        self.dc = None
        self.pending: list[str] = []
        self.in_q: asyncio.Queue = asyncio.Queue()
        self.tasks: list[asyncio.Task] = []
        self.closed = False
        session.add_listener(self._on_event)

    # session → client
    def _on_event(self, ev: dict) -> None:
        data = json.dumps(ev, ensure_ascii=False, separators=(",", ":"))
        dc = self.dc
        if dc is not None and dc.readyState == "open":
            try:
                dc.send(data)
            except Exception:  # pragma: no cover
                log.exception("datachannel send failed")
        else:
            self.pending.append(data)

    def attach_channel(self, dc) -> None:
        self.dc = dc

        def flush():
            for d in self.pending:
                dc.send(d)
            self.pending.clear()

        if dc.readyState == "open":
            flush()
        else:
            dc.on("open", flush)

        @dc.on("message")
        def _msg(m):
            if isinstance(m, (bytes, bytearray)):
                m = m.decode("utf-8", "replace")
            self.in_q.put_nowait(m)

        @dc.on("close")
        def _close():
            asyncio.ensure_future(self.close())

    async def _event_worker(self) -> None:
        while True:
            m = await self.in_q.get()
            try:
                ev = json.loads(m)
            except ValueError:
                self._on_event(E.error_event("invalid_json", "The server could not parse the event as JSON."))
                continue
            await self.session.handle(ev)

    async def _read_mic(self, track) -> None:
        from aiortc.mediastreams import MediaStreamError
        rs: Resampler | None = None
        rate = 0
        try:
            while True:
                frame = await track.recv()
                x, sr = frame_to_mono_float(frame)
                if rs is None or sr != rate:
                    rate = sr
                    rs = Resampler(sr, IN_SR)
                self.session.feed_input_16k(rs.process(x))
        except (MediaStreamError, asyncio.CancelledError):
            pass

    def start(self) -> None:
        loop = asyncio.get_running_loop()
        self.tasks.append(loop.create_task(self._event_worker()))

    def on_track(self, track) -> None:
        if track.kind == "audio":
            self.tasks.append(asyncio.get_running_loop().create_task(self._read_mic(track)))

    async def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        self.state.calls.pop(self.id, None)
        self.state.untrack(self.session)
        for t in self.tasks:
            t.cancel()
        await self.session.close()
        with contextlib.suppress(Exception):
            await self.pc.close()


async def create_call(state, offer_sdp: str, token, model: str | None) -> Call:
    from aiortc import RTCConfiguration, RTCIceServer, RTCPeerConnection, RTCSessionDescription

    servers = [RTCIceServer(urls=u) for u in state.cfg.stun]
    pc = RTCPeerConnection(RTCConfiguration(iceServers=servers))
    output = RTCAudioOutput(state.cfg.webrtc_playout_delay_ms)
    session = state.new_session(token, model, transport="webrtc", output_factory=lambda s: output)
    call = Call(state, session, pc, output)

    @pc.on("datachannel")
    def _dc(ch):
        if ch.label == "oai-events" or call.dc is None:
            call.attach_channel(ch)

    @pc.on("track")
    def _track(track):
        call.on_track(track)

    @pc.on("connectionstatechange")
    async def _state():
        if pc.connectionState in ("failed", "closed"):
            await call.close()

    try:
        await pc.setRemoteDescription(RTCSessionDescription(sdp=offer_sdp, type="offer"))
        pc.addTrack(outbound_track(output))   # binds to the offer's audio m-line (sendrecv or recvonly)
        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
    except Exception:
        await pc.close()
        await session.close()
        raise
    state.calls[call.id] = call
    state.track(session)
    call.start()
    session.start()
    return call
