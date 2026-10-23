"""Races between client events, VAD and the response pipeline. Every test ends with the same
final-state invariants: no stuck active response, consistent items, exactly one response.done per
response.created, no events for a response after its response.done, no leaked tasks."""
import asyncio
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["OPENREALTIME_LLM"] = "mock"

from fakes import RT, T, wait_until, FakeLLM, FakeSTT, FakeTTS, make_engine, running_app, silence, tone, tool_call  # noqa: E402
from ort.server import STATE  # noqa: E402

pytestmark = pytest.mark.asyncio

MANUAL = {"type": "session.update", "session": {"type": "realtime", "audio": {"input": {"turn_detection": None}}}}
VAD = {"type": "session.update", "session": {"type": "realtime", "audio": {"input": {
    "turn_detection": {"type": "server_vad", "silence_duration_ms": 200, "create_response": True, "interrupt_response": True}}}}}
LONG = "This is a fairly long answer. It has several sentences in it. Each one takes a while to say. And here is one more."


def user_text(text, **kw):
    return {"type": "conversation.item.create", "item": {"type": "message", "role": "user",
                                                         "content": [{"type": "input_text", "text": text}]}, **kw}


async def connect(client, setup=MANUAL):
    rt = await RT.connect(client)
    await rt.wait_for("session.created")
    await rt.send(setup)
    await rt.wait_for("session.updated")
    sess = next(s for s in client.app[STATE].sessions if s.id == rt.events[0]["session"]["id"])
    return rt, sess


async def settle(rt: RT, sess, timeout=8.0):
    """Wait until nothing is running, then check the invariants."""
    end = asyncio.get_running_loop().time() + timeout * T
    while asyncio.get_running_loop().time() < end:
        busy = (sess.active is not None or any(not r.finalized for r in sess.responses.values())
                or sess.output.busy() or sess._pending_auto)
        if not busy and len(rt.of("response.created")) == len(rt.of("response.done")):
            break
        await asyncio.sleep(0.05)
    await asyncio.sleep(0.25)   # let stray late events (if any) arrive
    check_invariants(rt, sess)


def check_invariants(rt: RT, sess):
    created = [e["response"]["id"] for e in rt.of("response.created")]
    done = [e["response"]["id"] for e in rt.of("response.done")]
    assert len(done) == len(set(done)), f"duplicate response.done: {done}"
    assert sorted(created) == sorted(done), (created, done, rt.types()[-30:])
    assert sess.active is None and not sess._pending_auto
    assert all(r.finalized for r in sess.responses.values())
    # no response events after that response's done
    done_at = {e["response"]["id"]: i for i, e in enumerate(rt.events) if e["type"] == "response.done"}
    for i, e in enumerate(rt.events):
        rid = e.get("response_id")
        if rid and e["type"].startswith("response.") and rid in done_at:
            assert i < done_at[rid], f"{e['type']} after response.done of {rid}"
    # every output_item.added has its .done; every in_progress item ended
    added = {(e["response_id"], e["item"]["id"]) for e in rt.of("response.output_item.added")}
    fin = {(e["response_id"], e["item"]["id"]) for e in rt.of("response.output_item.done")}
    assert added == fin, (added - fin)
    for e in rt.of("response.done"):
        for it in e["response"]["output"]:
            assert it["status"] in ("completed", "incomplete"), it
    # conversation: unique ids, index consistent, nothing left in progress
    ids = [i["id"] for i in sess.items]
    assert len(ids) == len(set(ids)) and set(ids) == set(sess.index)
    assert all(i.get("status") != "in_progress" for i in sess.items), [i for i in sess.items if i.get("status") == "in_progress"]
    # tasks: only the input worker is left running
    live = [t for t in sess._tasks if not t.done() and t is not sess._in_task]
    assert not live, live
    assert not sess.output.busy()


# ------------------------------------------------------------------ response.cancel at each stage

@pytest.mark.parametrize("stage", ["before_first_token", "during_tts", "audio_sent_not_done"])
async def test_cancel_at_each_stage(stage):
    llm = FakeLLM([LONG, "Second."], ttft=0.6 if stage == "before_first_token" else 0.0)
    tts = FakeTTS(ms_per_char=8, delay=0.15 if stage == "during_tts" else 0.0)
    lead = 20000 if stage == "audio_sent_not_done" else 200
    async with running_app(make_engine(llm=llm, tts=tts), ws_audio_lead_ms=lead) as client:
        rt, sess = await connect(client)
        await rt.send(user_text("talk"))
        await rt.send({"type": "response.create"})
        await rt.wait_for("response.created")
        if stage == "during_tts":
            await rt.wait_for("response.output_audio.delta", timeout=5)
        elif stage == "audio_sent_not_done":
            # all audio already left (huge lead) but playback is not over → response still active
            def all_sent():
                m = sess.active.msg if sess.active else None
                return bool(m and m.tts_task and m.tts_task.done() and m.item["id"] in sess.output.items
                            and sess.output.items[m.item["id"]].pending() == 0)
            assert await wait_until(all_sent)
            assert sess.active is not None
        await rt.send({"type": "response.cancel"})
        rd = await rt.wait_for("response.done", timeout=3)
        assert rd["response"]["status"] == "cancelled"
        if stage == "before_first_token":
            assert rd["response"]["output"] == [] and llm.cancelled == 1
        else:
            heard = rd["response"]["output"][0]["content"][0]["transcript"]
            assert LONG.startswith(heard) and len(heard) < len(LONG)
        await settle(rt, sess)
        # the session is usable right away
        await rt.send({"type": "response.create"})
        rd2 = await rt.wait_for("response.done", timeout=8)
        assert rd2["response"]["status"] == "completed"
        await settle(rt, sess)
        await rt.close()


# ------------------------------------------------------------------ speech_started at each stage

@pytest.mark.parametrize("stage", ["before_first_token", "during_tts", "audio_sent_not_done", "between_responses"])
async def test_barge_in_at_each_stage(stage):
    llm = FakeLLM([LONG, "Okay, go on."], ttft=0.8 if stage == "before_first_token" else 0.0)
    tts = FakeTTS(ms_per_char=8, delay=0.15 if stage == "during_tts" else 0.0)
    lead = 20000 if stage == "audio_sent_not_done" else 200
    stt = FakeSTT(["interrupting you"])
    async with running_app(make_engine(llm=llm, tts=tts, stt=stt), ws_audio_lead_ms=lead) as client:
        rt, sess = await connect(client, VAD)
        await rt.send(user_text("talk"))
        await rt.send({"type": "response.create"})
        await rt.wait_for("response.created")
        if stage == "during_tts":
            await rt.wait_for("response.output_audio.delta", timeout=5)
        elif stage == "audio_sent_not_done":
            await asyncio.sleep(0.5)
        elif stage == "between_responses":
            await rt.wait_for("response.done", timeout=10)
        await rt.append(np.concatenate([tone(0.4), silence(0.5)]))
        await rt.wait_for("input_audio_buffer.speech_started", timeout=3)
        await rt.wait_for("input_audio_buffer.committed", timeout=3)
        first_done = rt.of("response.done")[0]
        if stage != "between_responses":
            assert first_done["response"]["status"] == "cancelled"
            assert first_done["response"]["status_details"]["reason"] == "turn_detected"
        # the user's turn gets its own (auto) response that completes
        last = await rt.wait_for(lambda e: e["type"] == "response.done" and e["response"]["id"] != first_done["response"]["id"],
                                 timeout=8, from_start=True)
        assert last["response"]["status"] == "completed"
        assert {"role": "user", "content": "interrupting you"} in llm.calls[-1]["messages"]
        await settle(rt, sess)
        await rt.close()


async def test_speech_without_interrupt_queues_one_auto_response():
    llm = FakeLLM([LONG, "Queued answer."])
    td = {"type": "session.update", "session": {"audio": {"input": {"turn_detection": {
        "type": "server_vad", "silence_duration_ms": 200, "create_response": True, "interrupt_response": False}}}}}
    async with running_app(make_engine(llm=llm, tts=FakeTTS(ms_per_char=6))) as client:
        rt, sess = await connect(client, td)
        await rt.send(user_text("talk"))
        await rt.send({"type": "response.create"})
        await rt.wait_for("response.output_audio.delta")
        await rt.append(np.concatenate([tone(0.3), silence(0.4), tone(0.3), silence(0.4)]))
        await rt.wait_for(lambda e: e["type"] == "response.done" and e["response"]["status"] == "completed", timeout=10)
        await settle(rt, sess, timeout=15)
        # first response completed, then exactly one queued auto response (two committed turns, one response)
        assert [e["response"]["status"] for e in rt.of("response.done")] == ["completed", "completed"]
        await rt.close()


# ------------------------------------------------------------------ back-to-back creates

async def test_two_response_creates_back_to_back():
    llm = FakeLLM(["First answer here.", "Second answer here."])
    async with running_app(make_engine(llm=llm, tts=FakeTTS(ms_per_char=4))) as client:
        rt, sess = await connect(client)
        await rt.send(user_text("hi"))
        await rt.send({"type": "response.create", "event_id": "c1"})
        await rt.send({"type": "response.create", "event_id": "c2"})
        err = await rt.wait_for("error")
        assert err["error"]["code"] == "conversation_already_has_active_response" and err["error"]["event_id"] == "c2"
        await settle(rt, sess)
        assert len(rt.of("response.created")) == 1
        # after done, a create immediately works (no stale active)
        await rt.send({"type": "response.create"})
        await rt.wait_for(lambda e: e["type"] == "response.done" and len(rt.of("response.done")) == 2, timeout=8)
        await settle(rt, sess)
        await rt.close()


async def test_create_right_after_cancel_and_cancel_twice():
    llm = FakeLLM([LONG, LONG], token_delay=0.02)
    async with running_app(make_engine(llm=llm, tts=FakeTTS(ms_per_char=6))) as client:
        rt, sess = await connect(client)
        await rt.send(user_text("hi"))
        await rt.send({"type": "response.create"})
        await rt.send({"type": "response.cancel"})
        await rt.send({"type": "response.cancel", "event_id": "again"})
        await rt.send({"type": "response.create"})
        await rt.send({"type": "response.cancel"})
        await settle(rt, sess)
        assert [e["response"]["status"] for e in rt.of("response.done")] == ["cancelled", "cancelled"]
        assert [e["error"]["code"] for e in rt.of("error")] == ["response_cancel_not_active"]
        await rt.close()


# ------------------------------------------------------------------ session.update mid-response

async def test_session_update_mid_response():
    llm = FakeLLM([LONG, "After."])
    tools = [{"type": "function", "name": "f", "parameters": {"type": "object", "properties": {}}}]
    async with running_app(make_engine(llm=llm, tts=FakeTTS(ms_per_char=6))) as client:
        rt, sess = await connect(client)
        await rt.send(user_text("hi"))
        await rt.send({"type": "response.create"})
        await rt.wait_for("response.output_audio.delta")
        for patch in ({"audio": {"output": {"voice": "ash"}}}, {"instructions": "NEW RULES"}, {"tools": tools},
                      {"audio": {"input": {"turn_detection": {"type": "semantic_vad"}}}},
                      {"audio": {"input": {"turn_detection": None}}}):
            await rt.send({"type": "session.update", "session": patch})
            await rt.wait_for("session.updated")
        rd = await rt.wait_for("response.done", timeout=10)
        assert rd["response"]["status"] == "completed"
        assert rd["response"]["audio"]["output"]["voice"] == "alloy"   # a running response keeps its voice
        await rt.send({"type": "response.create"})
        rd2 = await rt.wait_for("response.done", timeout=10)
        assert rd2["response"]["audio"]["output"]["voice"] == "ash"
        assert llm.calls[-1]["messages"][0] == {"role": "system", "content": "NEW RULES"}
        assert llm.calls[-1]["tools"][0]["name"] == "f"
        await settle(rt, sess)
        await rt.close()


async def test_disable_vad_mid_speech_leaves_no_dangling_turn():
    stt = FakeSTT(["manual words"])
    async with running_app(make_engine(stt=stt)) as client:
        rt, sess = await connect(client, VAD)
        await rt.append(tone(0.4))
        await rt.wait_for("input_audio_buffer.speech_started")
        await rt.send(MANUAL)
        await rt.wait_for("session.updated")
        assert sess._speech_item is None
        await rt.append(silence(0.6))
        await rt.send({"type": "input_audio_buffer.commit"})
        cm = await rt.wait_for("input_audio_buffer.committed")
        await asyncio.sleep(0.3)
        assert not rt.of("input_audio_buffer.speech_stopped")
        assert not rt.of("response.created")
        assert cm["item_id"]
        await settle(rt, sess)
        await rt.close()


# ------------------------------------------------------------------ items while generating

async def test_item_create_while_generating():
    llm = FakeLLM([LONG, "Next."], token_delay=0.01)
    async with running_app(make_engine(llm=llm, tts=FakeTTS(ms_per_char=4))) as client:
        rt, sess = await connect(client)
        await rt.send(user_text("first"))
        await rt.send({"type": "response.create"})
        await rt.wait_for("response.output_item.added")
        await rt.send(user_text("typed while you talk"))
        await rt.send({"type": "conversation.item.create", "item": {"type": "message", "role": "system",
                                                                     "content": [{"type": "input_text", "text": "note"}]}})
        rd = await rt.wait_for("response.done", timeout=10)
        assert rd["response"]["status"] == "completed"
        roles = [(i["role"], i["type"]) for i in sess.items]
        assert roles == [("user", "message"), ("assistant", "message"), ("user", "message"), ("system", "message")]
        await rt.send({"type": "response.create"})
        await rt.wait_for(lambda e: e["type"] == "response.done" and len(rt.of("response.done")) == 2, timeout=10)
        msgs = llm.calls[-1]["messages"]
        assert [m["role"] for m in msgs] == ["user", "assistant", "user", "system"]
        await settle(rt, sess)
        await rt.close()


async def test_delete_in_progress_assistant_item():
    llm = FakeLLM([LONG])
    async with running_app(make_engine(llm=llm, tts=FakeTTS(ms_per_char=4))) as client:
        rt, sess = await connect(client)
        await rt.send(user_text("first"))
        await rt.send({"type": "response.create"})
        added = await rt.wait_for("response.output_item.added")
        await rt.send({"type": "conversation.item.delete", "item_id": added["item"]["id"]})
        await rt.wait_for("conversation.item.deleted")
        rd = await rt.wait_for("response.done", timeout=10)
        assert rd["response"]["status"] == "completed"
        assert [i["role"] for i in sess.items] == ["user"]
        await settle(rt, sess)
        await rt.close()


# ------------------------------------------------------------------ input / output buffer clears

async def test_input_clear_drops_audio_appended_just_before():
    async with running_app() as client:
        rt, sess = await connect(client)
        await rt.append(tone(0.5))           # no await between these and the clear
        await rt.send({"type": "input_audio_buffer.clear"})
        await rt.wait_for("input_audio_buffer.cleared")
        await rt.send({"type": "input_audio_buffer.commit", "event_id": "cm"})
        err = await rt.wait_for("error")
        assert err["error"]["code"] == "input_audio_buffer_commit_empty"
        await rt.close()


async def test_input_clear_during_speech():
    stt = FakeSTT(["after clear"])
    async with running_app(make_engine(stt=stt)) as client:
        rt, sess = await connect(client, VAD)
        await rt.append(tone(0.5))
        st = await rt.wait_for("input_audio_buffer.speech_started")
        await rt.send({"type": "input_audio_buffer.clear"})
        await rt.wait_for("input_audio_buffer.cleared")
        await rt.append(silence(0.6))
        await asyncio.sleep(0.4)
        # the cleared turn never ends in a speech_stopped / commit
        assert not [e for e in rt.of("input_audio_buffer.speech_stopped") if e["item_id"] == st["item_id"]]
        assert not rt.of("input_audio_buffer.committed")
        # and the next real turn works normally
        await rt.append(np.concatenate([tone(0.4), silence(0.5)]))
        st2 = await rt.wait_for("input_audio_buffer.speech_started", timeout=3)
        sp2 = await rt.wait_for("input_audio_buffer.speech_stopped", timeout=3)
        assert sp2["item_id"] == st2["item_id"] != st["item_id"]
        assert st2["audio_start_ms"] >= 700           # session audio timeline keeps counting (1.1 s - 300 ms padding)
        await settle(rt, sess)
        await rt.close()


async def test_output_audio_buffer_clear_mid_response_and_idle():
    llm = FakeLLM([LONG])
    async with running_app(make_engine(llm=llm, tts=FakeTTS(ms_per_char=8))) as client:
        rt, sess = await connect(client)
        await rt.send({"type": "output_audio_buffer.clear"})      # nothing playing: harmless
        await rt.send(user_text("hi"))
        await rt.send({"type": "response.create"})
        await rt.wait_for("response.output_audio_transcript.delta")
        await rt.send({"type": "output_audio_buffer.clear"})
        rd = await rt.wait_for("response.done", timeout=3)
        assert rd["response"]["status"] == "cancelled"
        n = len(rt.events)
        await asyncio.sleep(0.4)
        assert not [e for e in rt.events[n:] if e["type"] == "response.output_audio.delta"]
        assert not rt.of("error")
        await settle(rt, sess)
        await rt.close()


# ------------------------------------------------------------------ out-of-band audio next to in-band audio

async def test_cancel_oob_audio_leaves_inband_audio_alone():
    llm = FakeLLM([LONG, "Out of band words that are spoken as well, at some length."])
    async with running_app(make_engine(llm=llm, tts=FakeTTS(ms_per_char=5))) as client:
        rt, sess = await connect(client)
        await rt.send(user_text("hi"))
        await rt.send({"type": "response.create"})
        main = (await rt.wait_for("response.created"))["response"]["id"]
        await rt.send({"type": "response.create", "response": {"conversation": "none", "metadata": {"k": "oob"}}})
        oob = (await rt.wait_for("response.created"))["response"]["id"]
        await rt.wait_for(lambda e: e["type"] == "response.output_audio.delta" and e["response_id"] == main)
        await rt.send({"type": "response.cancel", "response_id": oob})
        od = await rt.wait_for(lambda e: e["type"] == "response.done" and e["response"]["id"] == oob, timeout=3)
        assert od["response"]["status"] == "cancelled"
        md = await rt.wait_for(lambda e: e["type"] == "response.done" and e["response"]["id"] == main, timeout=10, from_start=True)
        assert md["response"]["status"] == "completed"
        assert md["response"]["output"][0]["content"][0]["transcript"] == LONG
        await settle(rt, sess)
        await rt.close()


async def test_barge_in_does_not_hang_oob_audio_response():
    llm = FakeLLM(["Out of band words that are spoken as well, at some length and then some more."])
    async with running_app(make_engine(llm=llm, tts=FakeTTS(ms_per_char=8))) as client:
        rt, sess = await connect(client, VAD)
        await rt.send({"type": "response.create", "response": {"conversation": "none"}})
        oob = (await rt.wait_for("response.created"))["response"]["id"]
        await rt.wait_for("response.output_audio.delta")
        await rt.append(np.concatenate([tone(0.3), silence(0.4)]))   # clears the output buffer
        await rt.wait_for("input_audio_buffer.speech_started")
        od = await rt.wait_for(lambda e: e["type"] == "response.done" and e["response"]["id"] == oob, timeout=5, from_start=True)
        assert od["response"]["status"] in ("completed", "cancelled")
        await settle(rt, sess)
        await rt.close()


# ------------------------------------------------------------------ parallel calls + cancel

async def test_cancel_response_with_function_calls_keeps_items_consistent():
    llm = FakeLLM([["Let me check.", tool_call("f", {"a": 1}, "call_1"), tool_call("f", {"a": 2}, "call_2")]], token_delay=0.01)
    tools = [{"type": "function", "name": "f", "parameters": {"type": "object", "properties": {"a": {"type": "integer"}}}}]
    async with running_app(make_engine(llm=llm, tts=FakeTTS(ms_per_char=30))) as client:
        rt, sess = await connect(client)
        await rt.send({"type": "session.update", "session": {"tools": tools}})
        await rt.send(user_text("go"))
        await rt.send({"type": "response.create"})
        await rt.wait_for(lambda e: e["type"] == "response.function_call_arguments.done" and e["call_id"] == "call_2", timeout=5)
        await rt.send({"type": "response.cancel"})
        rd = await rt.wait_for("response.done", timeout=3)
        assert rd["response"]["status"] == "cancelled"
        assert [o["type"] for o in rd["response"]["output"]] == ["message", "function_call", "function_call"]
        await settle(rt, sess)
        await rt.close()


# ------------------------------------------------------------------ disconnect mid-response

class GateTTS(FakeTTS):
    """Counts open/closed TTS streams."""

    def __init__(self, **kw):
        super().__init__(**kw)
        self.open = 0

    async def stream(self, text_chunks, voice="alloy", speed=1.0, language=None):
        self.open += 1
        try:
            async for a in super().stream(text_chunks, voice, speed, language):
                yield a
        finally:
            self.open -= 1


@pytest.mark.parametrize("stage", ["llm_wait", "tts", "playing", "stt"])
async def test_disconnect_mid_response_cleans_up(stage):
    llm = FakeLLM([LONG], ttft=5.0 if stage == "llm_wait" else 0.0, token_delay=0.05 if stage == "tts" else 0.0)
    tts = GateTTS(ms_per_char=10, delay=0.2 if stage == "tts" else 0.0)
    stt = FakeSTT(["hello"], delay=5.0 if stage == "stt" else 0.0)
    async with running_app(make_engine(llm=llm, tts=tts, stt=stt)) as client:
        state = client.app[STATE]
        rt, sess = await connect(client, VAD if stage == "stt" else MANUAL)
        if stage == "stt":
            await rt.append(np.concatenate([tone(0.4), silence(0.5)]))
            await rt.wait_for("input_audio_buffer.committed", timeout=3)
            await rt.wait_for("response.created", timeout=3)
        else:
            await rt.send(user_text("hi"))
            await rt.send({"type": "response.create"})
            await rt.wait_for("response.created")
            if stage != "llm_wait":
                await rt.wait_for("response.output_audio.delta", timeout=5)
        await rt.close()
        assert await wait_until(lambda: sess.closed and sess not in state.sessions)
        await asyncio.sleep(0.1)
        assert not [t for t in sess._tasks if not t.done()]
        assert sess._in_task.done()
        if stage in ("llm_wait", "tts"):
            assert llm.cancelled == 1
        assert tts.open == 0, "TTS stream left open"
        assert sess._exec._shutdown
        out_task = getattr(sess.output, "_task", None)
        assert out_task is None or out_task.done()
        # nothing of this session is still scheduled on the loop
        mine = [t for t in asyncio.all_tasks() if sess.id[-6:] in repr(t.get_coro()) or "Session" in repr(t.get_coro())]
        assert not [t for t in mine if not t.done()]
