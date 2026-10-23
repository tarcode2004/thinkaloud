"""WebRTC loopback: an in-process aiortc client does what ThinkAloud's browser does
(mint ek_ → POST /v1/realtime/calls with the SDP offer → 'oai-events' data channel + mic track)."""
import asyncio
import contextlib
import fractions
import json
import os
import re
import sys
import time

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["OPENREALTIME_LLM"] = "mock"

av = pytest.importorskip("av")
aiortc = pytest.importorskip("aiortc")
from aiortc import MediaStreamTrack, RTCConfiguration, RTCPeerConnection, RTCSessionDescription  # noqa: E402

from fakes import FakeLLM, FakeSTT, FakeTTS, make_engine, running_app  # noqa: E402

pytestmark = pytest.mark.asyncio


class MicTrack(MediaStreamTrack):
    """48 kHz mono 20 ms frames: silence, or a tone while `talking` is set."""
    kind = "audio"

    def __init__(self):
        super().__init__()
        self.talking = False
        self.n = 0
        self.t0 = None

    async def recv(self):
        if self.t0 is None:
            self.t0 = time.monotonic()
        wait = self.t0 + self.n * 0.02 - time.monotonic()
        if wait > 0:
            await asyncio.sleep(wait)
        t = (np.arange(960) + self.n * 960) / 48000
        x = (0.3 * np.sin(2 * np.pi * 300 * t)) if self.talking else np.zeros(960)
        f = av.AudioFrame(format="s16", layout="mono", samples=960)
        f.planes[0].update((x * 32767).astype("<i2").tobytes())
        f.sample_rate = 48000
        f.pts = self.n * 960
        f.time_base = fractions.Fraction(1, 48000)
        self.n += 1
        return f


class Peer:
    def __init__(self):
        self.pc = RTCPeerConnection(RTCConfiguration(iceServers=[]))
        self.mic = MicTrack()
        self.pc.addTrack(self.mic)
        self.dc = self.pc.createDataChannel("oai-events")
        self.events: list[dict] = []
        self.event_times: list[float] = []
        self.audio_rms: list[tuple[float, float]] = []   # (time, rms) of received frames
        self.opened = asyncio.Event()
        self._tasks = []
        self.dc.on("open", self.opened.set)

        @self.dc.on("message")
        def _m(m):
            self.events.append(json.loads(m))
            self.event_times.append(time.monotonic())

        @self.pc.on("track")
        def _t(track):
            self._tasks.append(asyncio.ensure_future(self._read(track)))

    async def _read(self, track):
        with contextlib.suppress(Exception):
            while True:
                fr = await track.recv()
                a = fr.to_ndarray().astype(np.float32) / 32768
                self.audio_rms.append((time.monotonic(), float(np.sqrt(np.mean(a * a)))))

    def send(self, ev):
        self.dc.send(json.dumps(ev))

    async def wait(self, pred, timeout=8.0):
        if isinstance(pred, str):
            t = pred
            pred = lambda e: e["type"] == t  # noqa: E731
        from fakes import T
        end = time.monotonic() + timeout * T
        while time.monotonic() < end:
            for e in self.events:
                if pred(e):
                    return e
            await asyncio.sleep(0.01)
        raise AssertionError(f"timeout; got {[e['type'] for e in self.events][-30:]}")

    async def close(self):
        for t in self._tasks:
            t.cancel()
        await self.pc.close()


async def _connect(client, strip_candidates: bool, session=None):
    r = await client.post("/v1/realtime/client_secrets", json={"session": session or {
        "type": "realtime", "model": "gpt-realtime-2",
        "audio": {"input": {"transcription": {"model": "gpt-4o-transcribe", "language": "en"},
                            "turn_detection": {"type": "semantic_vad", "eagerness": "low", "create_response": False,
                                               "interrupt_response": True}},
                  "output": {"voice": "marin"}}}})
    token = (await r.json())["value"]
    peer = Peer()
    offer = await peer.pc.createOffer()
    await peer.pc.setLocalDescription(offer)
    sdp = peer.pc.localDescription.sdp
    if strip_candidates:   # like a browser that posts its offer before ICE gathering finished
        sdp = "\r\n".join(l for l in sdp.split("\r\n") if not l.startswith("a=candidate") and l != "a=end-of-candidates")
    res = await client.post("/v1/realtime/calls", data=sdp,
                            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/sdp"})
    assert res.status == 201, await res.text()
    assert res.headers["Location"].startswith("/v1/realtime/calls/rtc_")
    answer = await res.text()
    assert "a=candidate" in answer
    await peer.pc.setRemoteDescription(RTCSessionDescription(sdp=answer, type="answer"))
    await asyncio.wait_for(peer.opened.wait(), 10)
    return peer, res.headers["Location"].rsplit("/", 1)[1]


@pytest.mark.parametrize("strip", [False, True])
async def test_webrtc_loopback_events_and_audio(strip):
    llm = FakeLLM(["Hello from the server. This sentence is spoken over WebRTC."])
    async with running_app(make_engine(llm=llm, tts=FakeTTS(ms_per_char=15))) as client:
        peer, call_id = await _connect(client, strip)
        created = await peer.wait("session.created")
        assert created["session"]["model"] == "gpt-realtime-2"
        assert created["session"]["audio"]["output"]["voice"] == "marin"
        peer.send({"type": "conversation.item.create", "item": {"type": "message", "role": "user",
                                                               "content": [{"type": "input_text", "text": "hi"}]}})
        peer.send({"type": "response.create"})
        st = await peer.wait("output_audio_buffer.started")
        rc = await peer.wait("response.created")
        assert st["response_id"] == rc["response"]["id"]
        rd = await peer.wait("response.done", timeout=10)
        assert rd["response"]["status"] == "completed"
        sp = await peer.wait("output_audio_buffer.stopped", timeout=5)
        assert sp["response_id"] == rc["response"]["id"]
        # no audio deltas over WebRTC; transcript deltas joined == transcript
        types = [e["type"] for e in peer.events]
        assert "response.output_audio.delta" not in types
        tr = "".join(e["delta"] for e in peer.events if e["type"] == "response.output_audio_transcript.delta")
        assert tr == rd["response"]["output"][0]["content"][0]["transcript"]
        # remote audio actually arrived with energy, for roughly the TTS duration
        loud = [t for t, r in peer.audio_rms if r > 0.05]
        assert loud, "no audible audio received"
        dur = loud[-1] - loud[0]
        expect = len("Hello from the server. This sentence is spoken over WebRTC.") * 0.015
        assert expect * 0.6 < dur < expect * 1.6, (dur, expect)
        # captions not ahead of the voice: each transcript delta arrives after audio began
        first_delta_t = next(t for e, t in zip(peer.events, peer.event_times) if e["type"] == "response.output_audio_transcript.delta")
        assert first_delta_t >= loud[0] - 0.15
        r = await client.post(f"/v1/realtime/calls/{call_id}/hangup")
        assert r.status == 200
        await peer.close()


async def test_webrtc_mic_vad_transcription_and_barge_in():
    llm = FakeLLM(["This is a long reply that keeps talking for quite a while so that the user can interrupt it midway through."])
    stt = FakeSTT(["hello there"])
    async with running_app(make_engine(llm=llm, stt=stt, tts=FakeTTS(ms_per_char=30))) as client:
        peer, _ = await _connect(client, False)
        await peer.wait("session.created")
        # mic → VAD → committed item + transcription (create_response false: no response)
        peer.mic.talking = True
        await asyncio.sleep(0.6)
        peer.mic.talking = False
        st = await peer.wait("input_audio_buffer.speech_started")
        comp = await peer.wait("conversation.item.input_audio_transcription.completed")
        assert comp["item_id"] == st["item_id"] and comp["transcript"] == "hello there"
        await asyncio.sleep(0.3)
        assert not [e for e in peer.events if e["type"] == "response.created"]
        # spoken response, then barge in while it plays
        peer.send({"type": "response.create"})
        await peer.wait("output_audio_buffer.started")
        await asyncio.sleep(1.0)
        n_before = len(peer.events)
        peer.mic.talking = True
        t_talk = time.monotonic()
        cl = await peer.wait(lambda e: e["type"] == "output_audio_buffer.cleared")
        rd = await peer.wait(lambda e: e["type"] == "response.done")
        assert rd["response"]["status"] == "cancelled" and rd["response"]["status_details"]["reason"] == "turn_detected"
        heard = rd["response"]["output"][0]["content"][0]["transcript"]
        assert heard and len(heard) < 60
        trunc = await peer.wait("conversation.item.truncated")
        assert 700 < trunc["audio_end_ms"] < 1600
        # outgoing audio stops quickly after the clear (allow VAD onset + jitter)
        t_clear = next(t for e, t in zip(peer.events, peer.event_times) if e["type"] == "output_audio_buffer.cleared")
        await asyncio.sleep(0.4)
        after = [r for t, r in peer.audio_rms if t > t_clear + 0.15]
        assert after and max(after) < 0.01, "audio kept playing after barge-in"
        peer.mic.talking = False
        await peer.close()
