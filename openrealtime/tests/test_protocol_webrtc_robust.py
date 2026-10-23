"""WebRTC robustness: Chromium-style multi-codec offers, a mic that starts late / stops sending
frames, simulated packet loss, and the outbound audio clock over 10+ minutes (no drift, no bunching)."""
import asyncio
import os
import random
import sys
import types

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["OPENREALTIME_LLM"] = "mock"

av = pytest.importorskip("av")
pytest.importorskip("aiortc")

from fakes import FakeLLM, FakeSTT, FakeTTS, make_engine, running_app  # noqa: E402
from test_protocol_webrtc import MicTrack, Peer, _connect  # noqa: E402
from ort.server import STATE  # noqa: E402

pytestmark = pytest.mark.asyncio

FP = ":".join(f"{b:02X}" for b in bytes(range(32)))


def chrome_offer(payloads="111 63 9 0 8 13 110 126", direction="sendrecv"):
    lines = f"""v=0
o=- 4611731400430051336 2 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE 0 1
a=extmap-allow-mixed
a=msid-semantic: WMS 3f1c9a54-0d8e-4a8e-9a2b-7d1f0c2b9e11
m=audio 9 UDP/TLS/RTP/SAVPF {payloads}
c=IN IP4 0.0.0.0
a=rtcp:9 IN IP4 0.0.0.0
a=ice-ufrag:Hq3v
a=ice-pwd:xS9Bo0w2v3PaH1sZb2c3d4e5
a=ice-options:trickle
a=fingerprint:sha-256 {FP}
a=setup:actpass
a=mid:0
a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level
a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time
a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01
a=extmap:4 urn:ietf:params:rtp-hdrext:sdes:mid
a={direction}
a=msid:3f1c9a54-0d8e-4a8e-9a2b-7d1f0c2b9e11 6b0e2a8c-1f55-4a3b-8d6e-2f7c9a0b1c2d
a=rtcp-mux
a=rtpmap:111 opus/48000/2
a=rtcp-fb:111 transport-cc
a=fmtp:111 minptime=10;useinbandfec=1
a=rtpmap:63 red/48000/2
a=fmtp:63 111/111
a=rtpmap:9 G722/8000
a=rtpmap:0 PCMU/8000
a=rtpmap:8 PCMA/8000
a=rtpmap:13 CN/8000
a=rtpmap:110 telephone-event/48000
a=rtpmap:126 telephone-event/8000
a=ssrc:2861341262 cname:q5f8x0Vb0aZ7m2Lc
a=ssrc:2861341262 msid:3f1c9a54-0d8e-4a8e-9a2b-7d1f0c2b9e11 6b0e2a8c-1f55-4a3b-8d6e-2f7c9a0b1c2d
m=application 9 UDP/DTLS/SCTP webrtc-datachannel
c=IN IP4 0.0.0.0
a=ice-ufrag:Hq3v
a=ice-pwd:xS9Bo0w2v3PaH1sZb2c3d4e5
a=ice-options:trickle
a=fingerprint:sha-256 {FP}
a=setup:actpass
a=mid:1
a=sctp-port:5000
a=max-message-size:262144
"""
    return "\r\n".join(lines.strip().split("\n")) + "\r\n"


@pytest.mark.parametrize("payloads,direction", [("111 63 9 0 8 13 110 126", "sendrecv"),
                                                ("63 111 9 0 8 13 110 126", "sendrecv"),   # RED preferred (Chrome flag)
                                                ("111 63 9 0 8 13 110 126", "recvonly")])  # listen-only client
async def test_chromium_style_offer_negotiates_opus(payloads, direction):
    async with running_app() as client:
        r = await client.post("/v1/realtime/calls", data=chrome_offer(payloads, direction),
                              headers={"Content-Type": "application/sdp"})
        assert r.status == 201, await r.text()
        ans = await r.text()
        audio = next(l for l in ans.split("\r\n") if l.startswith("m=audio"))
        pts = audio.split()[3:]
        assert pts[0] == "111", audio                       # opus first, never RED/CN/G722
        assert "a=rtpmap:111 opus/48000/2" in ans
        assert "m=application" in ans and "webrtc-datachannel" in ans
        assert ("a=sendonly" if direction == "recvonly" else "a=sendrecv") in ans
        state = client.app[STATE]
        assert len(state.calls) == 1
        for c in list(state.calls.values()):
            await c.close()


async def test_garbage_offer_is_rejected_cleanly():
    async with running_app() as client:
        r = await client.post("/v1/realtime/calls", data="v=0\r\nm=video 9 FOO 1\r\n", headers={"Content-Type": "application/sdp"})
        assert r.status == 400 and (await r.json())["error"]["code"] == "invalid_offer"
        assert not client.app[STATE].sessions and not client.app[STATE].calls and client.app[STATE]._reserved == 0


class StallMic(MicTrack):
    """MicTrack that can start late and can stop delivering frames (no silence, nothing)."""

    def __init__(self, start_delay: float = 0.0):
        super().__init__()
        self.start_delay = start_delay
        self.flowing = asyncio.Event()
        self.flowing.set()

    async def recv(self):
        if self.t0 is None and self.start_delay:
            await asyncio.sleep(self.start_delay)
        await self.flowing.wait()
        return await super().recv()


async def _connect_with(client, mic, session=None):
    import test_protocol_webrtc as base
    orig = base.MicTrack
    base.MicTrack = lambda: mic
    try:
        return await _connect(client, False, session=session)
    finally:
        base.MicTrack = orig


VAD_SESSION = {"type": "realtime", "audio": {"input": {"transcription": {"model": "whisper-1"},
                                                       "turn_detection": {"type": "server_vad", "silence_duration_ms": 300,
                                                                          "create_response": False}}}}


async def test_mic_track_arriving_late_still_works():
    stt = FakeSTT(["late hello"])
    async with running_app(make_engine(stt=stt)) as client:
        mic = StallMic(start_delay=2.0)
        peer, _ = await _connect_with(client, mic, VAD_SESSION)
        await peer.wait("session.created")
        await asyncio.sleep(2.2)
        mic.talking = True
        await asyncio.sleep(0.6)
        mic.talking = False
        comp = await peer.wait("conversation.item.input_audio_transcription.completed", timeout=5)
        assert comp["transcript"] == "late hello"
        await peer.close()


async def test_mic_frames_stop_mid_speech_turn_still_ends():
    """Frames stop arriving while the user is talking (track removed, network gap): the server keeps
    the input timeline moving with silence, so the turn ends instead of hanging in speech."""
    stt = FakeSTT(["cut off"])
    async with running_app(make_engine(stt=stt)) as client:
        mic = StallMic()
        peer, _ = await _connect_with(client, mic, VAD_SESSION)
        await peer.wait("session.created")
        mic.talking = True
        await peer.wait("input_audio_buffer.speech_started", timeout=3)
        await asyncio.sleep(0.3)
        mic.flowing.clear()            # nothing more arrives
        t = asyncio.get_running_loop().time()
        sp = await peer.wait("input_audio_buffer.speech_stopped", timeout=3)
        assert asyncio.get_running_loop().time() - t < 3.0     # without the gap filler: never
        comp = await peer.wait("conversation.item.input_audio_transcription.completed", timeout=3)
        assert comp["item_id"] == sp["item_id"]
        call = next(iter(client.app[STATE].calls.values()))
        assert call.mic_gaps >= 1
        mic.talking = False
        mic.flowing.set()
        await peer.close()


async def test_packet_loss_on_mic_keeps_turn_taking_working():
    random.seed(7)
    stt = FakeSTT(["lossy one", "lossy two"])
    llm = FakeLLM(["This is a long reply that keeps talking for quite a while so the user can interrupt it."])
    async with running_app(make_engine(stt=stt, llm=llm, tts=FakeTTS(ms_per_char=30))) as client:
        mic = StallMic()
        peer, _ = await _connect_with(client, mic, {**VAD_SESSION, "audio": {**VAD_SESSION["audio"], "input": {
            **VAD_SESSION["audio"]["input"], "turn_detection": {"type": "server_vad", "silence_duration_ms": 300,
                                                                 "create_response": False, "interrupt_response": True}}}})
        await peer.wait("session.created")
        dtls = peer.pc.getTransceivers()[0].sender.transport
        orig = dtls._send_rtp
        dropped = [0, 0]

        async def lossy(data):
            dropped[1] += 1
            if random.random() < 0.15:
                dropped[0] += 1
                return
            await orig(data)
        dtls._send_rtp = lossy
        mic.talking = True
        await asyncio.sleep(1.0)
        mic.talking = False
        sp = await peer.wait("input_audio_buffer.speech_stopped", timeout=4)
        st = next(e for e in peer.events if e["type"] == "input_audio_buffer.speech_started")
        dur = sp["audio_end_ms"] - st["audio_start_ms"] - 300   # minus prefix padding
        assert 600 <= dur <= 1300, dur
        await peer.wait("conversation.item.input_audio_transcription.completed", timeout=3)
        assert dropped[0] > 5
        # barge-in still works under loss
        peer.send({"type": "response.create"})
        await peer.wait("output_audio_buffer.started", timeout=5)
        await asyncio.sleep(0.8)
        mic.talking = True
        rd = await peer.wait("response.done", timeout=4)
        assert rd["response"]["status"] == "cancelled"
        mic.talking = False
        await peer.close()


# ------------------------------------------------------------------ outbound clock over 12 minutes (simulated)

async def test_outbound_clock_no_drift_no_bunching_over_12_minutes(monkeypatch):
    import ort.session as S
    import ort.transport_webrtc as W
    clock = {"t": 1000.0}
    fake_time = types.SimpleNamespace(monotonic=lambda: clock["t"], time=lambda: clock["t"])
    rnd = random.Random(3)
    stalls = set(rnd.sample(range(1000, 35000), 12))     # 12 loop stalls of 150 ms
    state = {"n": 0}

    async def fake_sleep(d):
        jitter = rnd.uniform(0, 0.006)                    # sleep overshoot like a real loop
        if state["n"] in stalls:
            jitter += 0.15
        clock["t"] += max(0.0, d) + jitter
        await asyncio.sleep(0)

    fake_asyncio = types.SimpleNamespace(**{k: getattr(asyncio, k) for k in dir(asyncio) if not k.startswith("__")})
    fake_asyncio.sleep = fake_sleep
    monkeypatch.setattr(W, "time", fake_time)
    monkeypatch.setattr(S, "time", fake_time)
    monkeypatch.setattr(W, "asyncio", fake_asyncio)

    out = W.RTCAudioOutput(playout_delay_ms=60)
    track = W.outbound_track(out)
    minutes = 12
    frames = minutes * 60 * 50
    out.begin("resp_1", "item_1", 0)
    out.push("item_1", np.full(minutes * 60 * S.OUT_SR, 0.1, np.float32))
    out.finish("item_1")
    emits = []
    lateness_at = []
    for n in range(frames):
        state["n"] = n
        f = await track.recv()
        assert f.pts == n * 960
        emits.append(clock["t"])
        if n % 3000 == 2999 and all(abs(n - s) > 300 for s in stalls):
            # model "played" vs an ideal receiver playing the RTP timeline with the same delay
            ideal = (clock["t"] - (emits[0] + 0.06)) * S.OUT_SR
            lateness_at.append(out.played_samples("item_1") - ideal)
    t0 = emits[0]
    late = np.array([e - (t0 + i * 0.02) for i, e in enumerate(emits)])
    assert late.min() >= -1e-9, "a frame went out before its slot (bunching ahead of the clock)"
    # no cumulative drift: frames are on their slot except right after a stall
    assert np.median(late[-3000:]) < 0.007, np.median(late[-3000:])
    assert late.max() < 0.25
    # after a stall the catch-up burst is bounded (<= ~stall / frame frames) and then back on time
    burst = max(sum(1 for x in late[s + 1:s + 20] if x > 0.03) for s in stalls)
    assert burst <= 9, burst
    # the "played" model stays within ~1.5 frames of the receiver timeline all along (no drift)
    assert lateness_at and max(abs(x) for x in lateness_at) < 1.5 * 480, lateness_at


async def test_played_clock_after_a_stall_burst_is_sequential(monkeypatch):
    """After a 150 ms loop stall the track sends ~7 frames back to back. The receiver plays them one
    after another, so 'played' must not jump ahead (that would over-count heard words on barge-in)."""
    import ort.session as S
    import ort.transport_webrtc as W
    clock = {"t": 50.0}
    fake_time = types.SimpleNamespace(monotonic=lambda: clock["t"], time=lambda: clock["t"])
    state = {"n": 0}

    async def fake_sleep(d):
        clock["t"] += max(0.0, d) + (0.15 if state["n"] == 100 else 0.0)
        await asyncio.sleep(0)

    fake_asyncio = types.SimpleNamespace(**{k: getattr(asyncio, k) for k in dir(asyncio) if not k.startswith("__")})
    fake_asyncio.sleep = fake_sleep
    monkeypatch.setattr(W, "time", fake_time)
    monkeypatch.setattr(S, "time", fake_time)
    monkeypatch.setattr(W, "asyncio", fake_asyncio)
    out = W.RTCAudioOutput(playout_delay_ms=60)
    track = W.outbound_track(out)
    out.begin("r", "i", 0)
    out.push("i", np.full(S.OUT_SR * 10, 0.1, np.float32))
    out.finish("i")
    sent_at = []
    worst = 0
    for n in range(115):
        state["n"] = n
        await track.recv()
        sent_at.append(clock["t"])
        # receiver: frame k plays at max(arrival + delay, end of frame k-1)
        play = []
        for a in sent_at:
            play.append(max(a + 0.06, play[-1] + 0.02) if play else a + 0.06)
        for probe in (0.0, 0.01, 0.03):
            t = clock["t"] + probe
            ideal = sum(min(480, max(0, int((t - p) * S.OUT_SR))) for p in play)
            it = out.items["i"]
            worst = max(worst, abs(it.played(t) - ideal))
    assert worst <= 480, worst
