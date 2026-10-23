"""Token and session lifecycle: ek_ expiry and reuse, ORT_MAX_SESSIONS, the WS heartbeat, WebRTC
calls that never connect / whose peer leaves without hangup, and turn_detection.idle_timeout_ms."""
import asyncio
import os
import sys
import time

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["OPENREALTIME_LLM"] = "mock"

from fakes import RT, FakeLLM, FakeTTS, make_engine, running_app, silence, tone  # noqa: E402
from ort.server import STATE  # noqa: E402

pytestmark = pytest.mark.asyncio


async def mint(client, **body):
    r = await client.post("/v1/realtime/client_secrets", json={"session": {"type": "realtime"}, **body})
    assert r.status == 200
    return await r.json()


from fakes import wait_until  # noqa: E402,F811


# ------------------------------------------------------------------ tokens

async def test_expired_token_rejected_but_open_session_continues():
    async with running_app() as client:
        tok = await mint(client, expires_after={"anchor": "created_at", "seconds": 10})
        rt = await RT.connect(client, headers={"Authorization": f"Bearer {tok['value']}"})
        await rt.wait_for("session.created")
        client.app[STATE].tokens[tok["value"]]["expires_at"] = time.time() - 1      # expire it
        bad = await client.get("/v1/realtime", headers={"Authorization": f"Bearer {tok['value']}"})
        assert bad.status == 401 and (await bad.json())["error"]["code"] == "invalid_api_key"
        r = await client.post("/v1/realtime/calls", data="v=0\r\n", headers={"Authorization": f"Bearer {tok['value']}",
                                                                              "Content-Type": "application/sdp"})
        assert r.status == 401
        assert tok["value"] not in client.app[STATE].tokens
        # "the session itself may continue after that time once started"
        await rt.send({"type": "session.update", "session": {"instructions": "still here"}})
        assert (await rt.wait_for("session.updated"))["session"]["instructions"] == "still here"
        await rt.close()


async def test_token_reuse_opens_independent_sessions():
    """OpenAI: "A secret can be used to create multiple sessions until it expires."""
    async with running_app() as client:
        tok = await mint(client, session={"type": "realtime", "instructions": "MINTED"})
        a = await RT.connect(client, headers={"Authorization": f"Bearer {tok['value']}"})
        b = await RT.connect(client, headers={"Authorization": f"Bearer {tok['value']}"})
        sa = (await a.wait_for("session.created"))["session"]
        sb = (await b.wait_for("session.created"))["session"]
        assert sa["id"] != sb["id"] and sa["instructions"] == sb["instructions"] == "MINTED"
        await a.send({"type": "session.update", "session": {"instructions": "A ONLY"}})
        await a.wait_for("session.updated")
        assert client.app[STATE].tokens[tok["value"]]["session"]["instructions"] == "MINTED"   # template untouched
        await b.send({"type": "session.update", "session": {"voice": "ash"}})
        assert (await b.wait_for("session.updated"))["session"]["instructions"] == "MINTED"
        await a.close()
        await b.close()


async def test_expires_after_is_clamped_like_openai():
    async with running_app() as client:
        now = time.time()
        lo = await mint(client, expires_after={"seconds": 1})
        hi = await mint(client, expires_after={"seconds": 10 ** 6})
        assert abs(lo["expires_at"] - (now + 10)) <= 2 and abs(hi["expires_at"] - (now + 7200)) <= 2
        assert lo["session"]["expires_at"] == lo["expires_at"]


# ------------------------------------------------------------------ ORT_MAX_SESSIONS

async def test_max_sessions_ws():
    async with running_app(max_sessions=2) as client:
        a = await RT.connect(client)
        b = await RT.connect(client)
        await a.wait_for("session.created")
        await b.wait_for("session.created")
        c = await RT.connect(client)
        err = await c.wait_for("error")
        assert err["error"]["code"] == "session_limit_reached"
        await wait_until(lambda: c.ws.closed)
        assert c.ws.closed and len(client.app[STATE].sessions) == 2
        await a.close()
        assert await wait_until(lambda: len(client.app[STATE].sessions) == 1)
        d = await RT.connect(client)
        await d.wait_for("session.created")
        await b.close()
        await d.close()


# ------------------------------------------------------------------ WS heartbeat

async def test_ws_heartbeat_drops_unresponsive_client():
    async with running_app(ws_heartbeat_s=0.4) as client:
        ws = await client.ws_connect("/v1/realtime?model=gpt-realtime", autoping=False, heartbeat=None)
        assert await wait_until(lambda: len(client.app[STATE].sessions) == 1)
        sess = next(iter(client.app[STATE].sessions))
        # never answer pings: the server gives up after heartbeat + heartbeat/2
        assert await wait_until(lambda: sess.closed and not client.app[STATE].sessions, timeout=4)
        await ws.close()


async def test_ws_heartbeat_keeps_responsive_client():
    async with running_app(ws_heartbeat_s=1.0) as client:
        rt = await RT.connect(client)
        await rt.wait_for("session.created")
        await asyncio.sleep(3.5)          # several ping rounds (pong deadline 0.5 s: robust to a busy loop)
        assert len(client.app[STATE].sessions) == 1 and not rt.ws.closed
        await rt.close()


# ------------------------------------------------------------------ WebRTC lifecycle

av = pytest.importorskip("av")
pytest.importorskip("aiortc")
from aiortc import RTCSessionDescription  # noqa: E402

from test_protocol_webrtc import Peer, _connect as rtc_connect  # noqa: E402


async def _offer(client, token=None):
    peer = Peer()
    offer = await peer.pc.createOffer()
    await peer.pc.setLocalDescription(offer)
    tok = token or (await mint(client))["value"]
    res = await client.post("/v1/realtime/calls", data=peer.pc.localDescription.sdp,
                            headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/sdp"})
    return peer, res


async def test_concurrent_offers_respect_max_sessions():
    async with running_app(max_sessions=2) as client:
        tok = (await mint(client))["value"]
        results = await asyncio.gather(*[_offer(client, tok) for _ in range(4)])
        codes = sorted(r.status for _, r in results)
        assert codes == [201, 201, 503, 503], codes
        assert len(client.app[STATE].sessions) == 2 and client.app[STATE]._reserved == 0
        body = await next(r for _, r in results if r.status == 503).json()
        assert body["error"]["code"] == "session_limit_reached"
        for p, _ in results:
            await p.close()


async def test_webrtc_call_that_never_connects_is_closed():
    async with running_app(webrtc_connect_timeout_s=0.8) as client:
        state = client.app[STATE]
        peer, res = await _offer(client)
        assert res.status == 201
        assert len(state.calls) == 1 and len(state.sessions) == 1
        # the client never applies the answer (tab closed / UDP blocked)
        assert await wait_until(lambda: not state.calls and not state.sessions, timeout=4)
        await peer.close()


async def test_webrtc_peer_close_without_hangup_cleans_up():
    async with running_app(make_engine(llm=FakeLLM(["A long reply that is still playing when the peer goes away."]),
                                       tts=FakeTTS(ms_per_char=30))) as client:
        state = client.app[STATE]
        peer, _ = await rtc_connect(client, False)
        await peer.wait("session.created")
        sess = next(iter(state.sessions))
        peer.send({"type": "conversation.item.create", "item": {"type": "message", "role": "user",
                                                               "content": [{"type": "input_text", "text": "hi"}]}})
        peer.send({"type": "response.create"})
        await peer.wait("output_audio_buffer.started")
        await peer.close()                       # no /hangup
        assert await wait_until(lambda: not state.calls and not state.sessions and sess.closed, timeout=6)
        await asyncio.sleep(0.1)
        assert not [t for t in sess._tasks if not t.done()]


async def test_webrtc_peer_that_vanishes_fails_consent_and_is_closed(monkeypatch):
    import aioice.ice as ice
    monkeypatch.setattr(ice, "CONSENT_INTERVAL", 0.25)
    monkeypatch.setattr(ice, "CONSENT_FAILURES", 3)
    async with running_app() as client:
        state = client.app[STATE]
        peer, _ = await rtc_connect(client, False)
        await peer.wait("session.created")
        # the laptop sleeps: the client stops answering anything (no DTLS close, no SCTP abort)
        for t in peer.pc.getTransceivers():
            conn = t.sender.transport.transport._connection
            conn.request_received = lambda *a, **k: None
            conn.data_received = lambda *a, **k: None
        for proto in list(conn._protocols):
            proto.datagram_received = lambda *a, **k: None
        assert await wait_until(lambda: not state.calls and not state.sessions, timeout=10)
        await peer.close()


# ------------------------------------------------------------------ idle_timeout_ms

IDLE = {"type": "session.update", "session": {"audio": {"input": {"turn_detection": {
    "type": "server_vad", "silence_duration_ms": 200, "idle_timeout_ms": 700, "create_response": True}}}}}


async def test_idle_timeout_triggers_commit_and_response():
    llm = FakeLLM(["Are you still there?", "Still with me?"])
    async with running_app(make_engine(llm=llm, tts=FakeTTS(ms_per_char=10))) as client:
        rt = await RT.connect(client)
        await rt.wait_for("session.created")
        t0 = time.monotonic()
        await rt.send(IDLE)
        await rt.wait_for("session.updated")
        # the client streams silence (like a mic) the whole time
        feeder = asyncio.ensure_future(rt.append(silence(6.0), realtime=True))
        to = await rt.wait_for("input_audio_buffer.timeout_triggered", timeout=3)
        dt = time.monotonic() - t0
        assert 0.6 <= dt <= 3.0, dt       # never early; late only by loop load
        assert to["item_id"].startswith("item_") and 0 <= to["audio_start_ms"] <= to["audio_end_ms"]
        assert 400 <= to["audio_end_ms"] - to["audio_start_ms"] <= 1000
        cm = await rt.wait_for("input_audio_buffer.committed")
        assert cm["item_id"] == to["item_id"]
        added = await rt.wait_for(lambda e: e["type"] == "conversation.item.added" and e["item"]["id"] == to["item_id"])
        assert added["item"]["content"][0]["type"] == "input_audio"
        rd = await rt.wait_for("response.done", timeout=5)
        t_done = time.monotonic()
        assert rd["response"]["status"] == "completed"
        assert any(m["role"] == "system" and "said nothing" in m["content"] for m in llm.calls[0]["messages"])
        # re-armed from the end of that response's playback
        to2 = await rt.wait_for("input_audio_buffer.timeout_triggered", timeout=3)
        assert time.monotonic() - t_done >= 0.6
        assert to2["item_id"] != to["item_id"]
        feeder.cancel()
        await rt.close()


async def test_speech_resets_idle_timer_and_semantic_vad_has_none():
    llm = FakeLLM()
    async with running_app(make_engine(llm=llm, tts=FakeTTS(ms_per_char=2))) as client:
        rt = await RT.connect(client)
        await rt.wait_for("session.created")
        await rt.send({"type": "session.update", "session": {"audio": {"input": {"turn_detection": {
            "type": "server_vad", "silence_duration_ms": 200, "idle_timeout_ms": 900, "create_response": False}}}}})
        await rt.wait_for("session.updated")
        for _ in range(4):              # talk every ~0.6 s: never idle for 0.9 s
            await rt.append(np.concatenate([tone(0.25), silence(0.35)]), realtime=True)
        assert not rt.of("input_audio_buffer.timeout_triggered")
        await rt.wait_for("input_audio_buffer.timeout_triggered", timeout=2.5)
        # semantic_vad: not supported by OpenAI → never fires
        await rt.send({"type": "session.update", "session": {"audio": {"input": {"turn_detection": {
            "type": "semantic_vad", "idle_timeout_ms": 500}}}}})
        await rt.wait_for("session.updated")
        n = len(rt.of("input_audio_buffer.timeout_triggered"))
        await asyncio.sleep(1.2)
        assert len(rt.of("input_audio_buffer.timeout_triggered")) == n
        assert not rt.of("response.created")
        await rt.close()
