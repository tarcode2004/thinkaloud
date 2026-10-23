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
MIC_GAP_S = 0.3                           # no mic frame for this long → feed silence


class PassThroughAudioJitterBuffer:
    """Replacement for aiortc's audio JitterBuffer(capacity=16, prefetch=4) on the *mic* receiver.

    The server never plays the mic audio, it only feeds VAD/STT, so there is nothing to smooth:
    frames are released the moment they arrive, in sequence order. A gap (lost packet) is skipped
    immediately (the hole is filled with silence from the RTP timestamps in `Call._read_mic`), and a
    packet older than one already released is dropped. aiortc's buffer instead stalls at every hole
    until 16 later packets arrived and then keeps discarding real frames: at 15 % packet loss it
    delivered ~40 % of the audio."""

    capacity = 16

    def __init__(self) -> None:
        self._next: int | None = None
        self.released = 0
        self.lost = 0
        self.late = 0

    def add(self, packet):
        from aiortc.jitterbuffer import JitterFrame
        seq = packet.sequence_number
        if self._next is not None:
            d = (seq - self._next) & 0xFFFF
            if d >= 0x8000:            # behind what was already released
                self.late += 1
                return False, None
            self.lost += d
        self._next = (seq + 1) & 0xFFFF
        self.released += 1
        return False, JitterFrame(data=packet._data, timestamp=packet.timestamp)


def install_mic_jitter_buffer(pc) -> None:
    for t in pc.getTransceivers():
        if t.kind == "audio" and t.receiver is not None and hasattr(t.receiver, "_RTCRtpReceiver__jitter_buffer"):
            t.receiver._RTCRtpReceiver__jitter_buffer = PassThroughAudioJitterBuffer()


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
        self._clock_end = 0.0                 # playout time (monotonic) at which the last pulled frame ends

    def _emit_buf(self, typ: str, response_id: str) -> None:
        if self.on_event is not None:
            self.on_event(typ, response_id)

    def pull_24k(self) -> np.ndarray:
        """Next 20 ms at 24 kHz (zeros where nothing is queued) and its bookkeeping."""
        out = np.zeros(FRAME_24, np.float32)
        filled = 0
        # Frames play back to back at the receiver: a burst after a stall plays sequentially, so a
        # frame plays at max(arrival + delay, end of the previous frame). A jitter buffer that has
        # grown (stall) speeds up a little until it is back at its target delay (NetEQ "accelerate"):
        # converge by <= 2 ms per frame, re-sync if more than 300 ms behind. No drift, no bunching.
        now = time.monotonic() + self.delay
        excess = self._clock_end - now
        base = now if excess <= 0 or excess > 0.3 else self._clock_end - min(excess, 0.002)
        self._clock_end = base + FRAME_MS / 1000
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
            self._mark(it, pcm, base + filled / OUT_SR)
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

    def _cut_time(self, now: float) -> float:
        return float("inf")      # RTP already sent cannot be recalled: all of it is heard

    def _on_clear(self, hit) -> None:
        seen = []
        for it in hit:
            if it.response_id not in seen:
                seen.append(it.response_id)
        if self._playing and self._playing not in seen and not any(it.response_id == self._playing for it in self.order):
            seen.append(self._playing)
        if self._playing in seen:
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
        self.mic_gaps = 0
        self.mic_filled_s = 0.0
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
            if len(self.pending) > 5000:      # channel never opened: keep the newest, bounded
                del self.pending[:1000]

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

    def pending_events(self) -> list[dict]:
        """Events queued while the data channel is not open (tests / diagnostics)."""
        return [json.loads(d) for d in self.pending]

    async def _event_worker(self) -> None:
        limit = getattr(self.session.cfg, "max_event_bytes", None)
        while True:
            m = await self.in_q.get()
            try:
                ev, err = E.parse_client_event(m, limit)
                if err is not None:
                    self._on_event(err)
                    continue
                await self.session.handle(ev)
            except asyncio.CancelledError:
                raise
            except Exception:  # pragma: no cover - handle() already reports; never let the worker die
                log.exception("data channel event failed")

    async def _read_mic(self, track) -> None:
        from aiortc.mediastreams import MediaStreamError
        rs: Resampler | None = None
        rate = 0
        got_any = False
        gap = MIC_GAP_S
        next_pts: float | None = None     # RTP-timeline position (s) where the next frame should start
        wall_filled = 0.0                 # silence already fed by the wall-clock gap filler
        try:
            while True:
                try:
                    frame = await (asyncio.wait_for(track.recv(), gap) if got_any else track.recv())
                except asyncio.TimeoutError:
                    # No frames (track removed / network gap): keep the input timeline moving with
                    # silence, so a turn in progress still ends and idle timeouts still count.
                    self.session.feed_input_16k(np.zeros(int(IN_SR * gap), np.float32))
                    wall_filled += gap
                    self.mic_gaps += 1
                    continue
                got_any = True
                x, sr = frame_to_mono_float(frame)
                # Lost / jitter-buffer-dropped RTP packets leave holes in the RTP timeline (aiortc
                # drops whole runs of frames around a loss). Fill them with silence so the input
                # timeline (VAD timing, audio_start/end_ms, truncation) stays real time.
                if frame.pts is not None and frame.time_base:
                    t = float(frame.pts * frame.time_base)
                    if next_pts is not None:
                        hole = t - next_pts
                        if hole < -0.01 and hole > -600:
                            continue                          # late duplicate / reordered frame
                        if 0.005 < hole < 10:
                            fill = hole - wall_filled
                            if fill > 0.005:
                                self.session.feed_input_16k(np.zeros(int(IN_SR * fill), np.float32))
                                self.mic_filled_s += fill
                    next_pts = t + x.size / sr
                    wall_filled = 0.0
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

    async def _connect_watchdog(self, timeout: float) -> None:
        """A peer that never completes ICE/DTLS (blocked UDP, tab closed right after the offer) would
        otherwise hold its session forever. Once connected, aioice consent checks (RFC 7675) turn a
        vanished peer into connectionState 'failed', which closes the call."""
        await asyncio.sleep(timeout)
        if not self.closed and self.pc.connectionState != "connected":
            log.info("call %s not connected after %.0fs (%s): closing", self.id, timeout, self.pc.connectionState)
            await self.close()

    async def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        self.state.calls.pop(self.id, None)
        self.state.untrack(self.session)
        me = asyncio.current_task()
        for t in self.tasks:
            if t is not me:
                t.cancel()
        await asyncio.shield(self.session.close())
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
        install_mic_jitter_buffer(pc)
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
    call.tasks.append(asyncio.get_running_loop().create_task(call._connect_watchdog(state.cfg.webrtc_connect_timeout_s)))
    return call
