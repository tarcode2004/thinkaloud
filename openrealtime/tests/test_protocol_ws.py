"""End-to-end protocol tests over the WebSocket transport (fake engine, no network)."""
import asyncio
import base64
import json
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["OPENREALTIME_LLM"] = "mock"

from fakes import RT, FakeLLM, FakeSTT, FakeTTS, make_engine, running_app, silence, tone, tool_call  # noqa: E402
from ort.llm import LLMEvent  # noqa: E402
from ort.server import STATE  # noqa: E402

pytestmark = pytest.mark.asyncio

MANUAL = {"type": "session.update", "session": {"type": "realtime", "audio": {"input": {"turn_detection": None}}}}


def user_text(text, **kw):
    return {"type": "conversation.item.create", "item": {"type": "message", "role": "user",
                                                         "content": [{"type": "input_text", "text": text}]}, **kw}


async def _connect(client, **kw):
    rt = await RT.connect(client, **kw)
    created = await rt.wait_for("session.created")
    return rt, created


# ------------------------------------------------------------------ session

async def test_session_created_and_update_merges():
    async with running_app() as client:
        rt, created = await _connect(client)
        s = created["session"]
        assert s["type"] == "realtime" and s["object"] == "realtime.session" and s["id"].startswith("sess_")
        assert s["model"] == "gpt-realtime"
        assert s["audio"]["input"]["format"] == {"type": "audio/pcm", "rate": 24000}
        assert created["event_id"].startswith("event_")

        await rt.send({"type": "session.update", "session": {
            "type": "realtime", "instructions": "Be brief.",
            "tools": [{"type": "function", "name": "advance_step", "description": "x", "parameters": {"type": "object", "properties": {}}}],
            "audio": {"input": {"transcription": {"model": "whisper-1", "language": "de"},
                                "turn_detection": {"type": "semantic_vad", "eagerness": "low", "create_response": False}},
                      "output": {"voice": "marin"}}}})
        up = (await rt.wait_for("session.updated"))["session"]
        assert up["instructions"] == "Be brief." and up["tools"][0]["name"] == "advance_step"
        td = up["audio"]["input"]["turn_detection"]
        assert td["type"] == "semantic_vad" and td["eagerness"] == "low" and td["create_response"] is False
        assert td["interrupt_response"] is True
        assert up["audio"]["output"]["voice"] == "marin"
        assert up["audio"]["input"]["transcription"]["language"] == "de"

        # partial update keeps everything else; null disables VAD
        await rt.send({"type": "session.update", "session": {"type": "realtime", "audio": {"input": {"turn_detection": None}}}})
        up2 = (await rt.wait_for("session.updated"))["session"]
        assert up2["audio"]["input"]["turn_detection"] is None
        assert up2["instructions"] == "Be brief." and up2["audio"]["output"]["voice"] == "marin"

        # beta-shaped fields map onto GA
        await rt.send({"type": "session.update", "session": {"voice": "ash", "modalities": ["text"]}})
        up3 = (await rt.wait_for("session.updated"))["session"]
        assert up3["audio"]["output"]["voice"] == "ash" and up3["output_modalities"] == ["text"]

        await rt.send({"type": "session.update", "session": {"type": "transcription"}})
        err = await rt.wait_for("error")
        assert err["error"]["type"] == "invalid_request_error" and err["error"]["param"] == "session.type"
        await rt.send({"type": "nope.nope", "event_id": "evt_1"})
        err = await rt.wait_for("error")
        assert err["error"]["code"] == "invalid_value" and err["error"]["event_id"] == "evt_1"
        await rt.close()


# ------------------------------------------------------------------ text in → spoken response

async def test_text_item_response_full_sequence():
    llm = FakeLLM(["Hello there, nice to meet you. How are you today?"])
    tts = FakeTTS(ms_per_char=5)
    async with running_app(make_engine(llm=llm, tts=tts)) as client:
        rt, _ = await _connect(client)
        await rt.send(MANUAL)
        await rt.wait_for("session.updated")
        await rt.send(user_text("Hi!"))
        added = await rt.wait_for("conversation.item.added")
        uid = added["item"]["id"]
        assert added["item"]["role"] == "user" and added["previous_item_id"] is None
        assert (await rt.wait_for("conversation.item.done"))["item"]["id"] == uid
        start = len(rt.events)
        await rt.send({"type": "response.create"})
        done = await rt.wait_for("response.done", timeout=10)
        types = rt.types(start)
        resp = done["response"]
        assert resp["status"] == "completed" and resp["object"] == "realtime.response"
        rid = resp["id"]
        assert rid.startswith("resp_")
        order = ["response.created", "response.output_item.added", "conversation.item.added", "response.content_part.added",
                 "response.output_audio.delta", "response.output_audio_transcript.delta", "response.output_audio.done",
                 "response.output_audio_transcript.done", "response.content_part.done", "response.output_item.done",
                 "conversation.item.done", "response.done"]
        idx = [types.index(t) for t in order]
        assert idx == sorted(idx), types
        item = resp["output"][0]
        assert item["type"] == "message" and item["role"] == "assistant" and item["status"] == "completed"
        tr = item["content"][0]
        assert tr["type"] == "output_audio"
        assert tr["transcript"] == "Hello there, nice to meet you. How are you today?"
        deltas = [e for e in rt.events[start:] if e["type"] == "response.output_audio_transcript.delta"]
        assert "".join(d["delta"] for d in deltas) == tr["transcript"]
        for d in deltas:
            assert d["response_id"] == rid and d["item_id"] == item["id"] and d["output_index"] == 0 and d["content_index"] == 0
        tdone = rt.of("response.output_audio_transcript.done")[-1]
        assert tdone["transcript"] == tr["transcript"] and tdone["item_id"] == item["id"]
        audio = b"".join(base64.b64decode(e["delta"]) for e in rt.events[start:] if e["type"] == "response.output_audio.delta")
        assert len(audio) // 2 == sum(int(len(t) * 5 / 1000 * 24000) for t in tts.texts)
        conv_added = [e for e in rt.events[start:] if e["type"] == "conversation.item.added"][0]
        assert conv_added["previous_item_id"] == uid
        u = resp["usage"]
        assert u["input_tokens"] == 42 and u["total_tokens"] == u["input_tokens"] + u["output_tokens"]
        assert set(u["input_token_details"]) >= {"text_tokens", "audio_tokens", "cached_tokens"}
        part = rt.of("response.content_part.added")[-1]["part"]
        assert part == {"type": "audio", "transcript": ""}
        # the LLM got system-less chat messages with the user's text
        assert llm.calls[-1]["messages"][-1] == {"role": "user", "content": "Hi!"}
        await rt.close()


async def test_transcript_paced_to_audio_clock():
    """Captions follow the voice: the last transcript delta must not come long before the audio has played."""
    text = "One two three four five six seven eight nine ten eleven twelve."
    llm = FakeLLM([text])
    async with running_app(make_engine(llm=llm, tts=FakeTTS(ms_per_char=20)), ws_audio_lead_ms=100) as client:
        rt, _ = await _connect(client)
        await rt.send(MANUAL)
        await rt.send(user_text("count"))
        t0 = asyncio.get_running_loop().time()
        await rt.send({"type": "response.create"})
        first_audio = await rt.wait_for("response.output_audio.delta", timeout=5)
        ta = asyncio.get_running_loop().time()
        await rt.wait_for("response.done", timeout=10)
        tend = asyncio.get_running_loop().time()
        audio_s = len(text) * 0.020
        # response lasts about as long as the audio (paced), not instantly
        assert tend - ta >= audio_s * 0.75, (tend - ta, audio_s)
        await rt.close()


async def test_text_modality_and_out_of_band_response():
    llm = FakeLLM(["Spoken answer that takes a little while to play out fully.", "CLASS: yes"])
    async with running_app(make_engine(llm=llm, tts=FakeTTS(ms_per_char=20))) as client:
        rt, _ = await _connect(client)
        await rt.send(MANUAL)
        await rt.send(user_text("question"))
        await rt.send({"type": "response.create"})
        created = await rt.wait_for("response.created")
        # a second in-band response is rejected while one is active
        await rt.send({"type": "response.create", "event_id": "dup1"})
        err = await rt.wait_for("error")
        assert err["error"]["code"] == "conversation_already_has_active_response"
        assert err["error"]["event_id"] == "dup1"
        # an out-of-band text response runs concurrently and leaves the conversation alone
        n_items_before = len(rt.of("conversation.item.added"))
        await rt.send({"type": "response.create", "event_id": "ta_oob_1", "response": {
            "conversation": "none", "metadata": {"ta_oob": "ta_oob_1"}, "output_modalities": ["text"],
            "instructions": "Classify.", "tool_choice": "none", "max_output_tokens": 400}})
        oob_done = await rt.wait_for(lambda e: e["type"] == "response.done" and e["response"]["metadata"] == {"ta_oob": "ta_oob_1"}, timeout=10)
        r = oob_done["response"]
        assert r["status"] == "completed" and r["conversation_id"] is None and r["output_modalities"] == ["text"]
        assert r["output"][0]["content"][0] == {"type": "output_text", "text": "CLASS: yes"}
        tdeltas = [e for e in rt.events if e["type"] == "response.output_text.delta" and e["response_id"] == r["id"]]
        assert "".join(d["delta"] for d in tdeltas) == "CLASS: yes"
        assert rt.of("response.output_text.done")[-1]["text"] == "CLASS: yes"
        assert llm.calls[1]["messages"][0] == {"role": "system", "content": "Classify."}
        assert llm.calls[1]["tool_choice"] == "none" and llm.calls[1]["max_tokens"] == 400
        main = await rt.wait_for(lambda e: e["type"] == "response.done" and e["response"]["id"] == created["response"]["id"], timeout=10, from_start=True)
        assert main["response"]["status"] == "completed"
        added_after = [e for e in rt.of("conversation.item.added")][n_items_before:]
        assert all(e["item"]["id"] != r["output"][0]["id"] for e in added_after)
        await rt.close()


# ------------------------------------------------------------------ function calls

async def test_function_call_round_trip():
    llm = FakeLLM([[tool_call("advance_step", {"reason": "done"}, "call_abc")], "Great, moving on."])
    async with running_app(make_engine(llm=llm, tts=FakeTTS(ms_per_char=2))) as client:
        rt, _ = await _connect(client)
        tools = [{"type": "function", "name": "advance_step", "description": "next",
                  "parameters": {"type": "object", "properties": {"reason": {"type": "string"}}}}]
        await rt.send({"type": "session.update", "session": {"type": "realtime", "tools": tools, "tool_choice": "auto",
                                                             "audio": {"input": {"turn_detection": None}}}})
        await rt.send(user_text("I'm done"))
        await rt.send({"type": "response.create", "response": {"tool_choice": {"type": "function", "name": "advance_step"}}})
        added = await rt.wait_for(lambda e: e["type"] == "response.output_item.added" and e["item"]["type"] == "function_call")
        assert added["item"]["call_id"] == "call_abc" and added["item"]["name"] == "advance_step" and added["output_index"] == 0
        d = await rt.wait_for("response.function_call_arguments.delta")
        assert d["call_id"] == "call_abc" and d["item_id"] == added["item"]["id"]
        fdone = await rt.wait_for("response.function_call_arguments.done")
        assert fdone["name"] == "advance_step" and json.loads(fdone["arguments"]) == {"reason": "done"}
        assert fdone["call_id"] == "call_abc" and fdone["response_id"] and fdone["output_index"] == 0
        odone = await rt.wait_for("response.output_item.done")
        assert odone["item"]["type"] == "function_call" and odone["item"]["status"] == "completed"
        rd = await rt.wait_for("response.done")
        assert rd["response"]["output"][0]["type"] == "function_call"
        assert rd["response"]["output"][0]["arguments"] == fdone["arguments"]
        assert llm.calls[0]["tool_choice"] == {"type": "function", "name": "advance_step"}
        assert llm.calls[0]["tools"][0]["name"] == "advance_step"

        await rt.send({"type": "conversation.item.create", "item": {"type": "function_call_output", "call_id": "call_abc",
                                                                     "output": json.dumps({"ok": True})}})
        await rt.wait_for(lambda e: e["type"] == "conversation.item.added" and e["item"]["type"] == "function_call_output")
        await rt.send({"type": "response.create"})
        rd2 = await rt.wait_for("response.done", timeout=10)
        assert rd2["response"]["output"][0]["content"][0]["transcript"] == "Great, moving on."
        msgs = llm.calls[1]["messages"]
        asst = [m for m in msgs if m["role"] == "assistant"][0]
        assert asst["tool_calls"][0]["id"] == "call_abc" and asst["tool_calls"][0]["function"]["name"] == "advance_step"
        tool = [m for m in msgs if m["role"] == "tool"][0]
        assert tool == {"role": "tool", "tool_call_id": "call_abc", "content": '{"ok": true}'}
        assert msgs.index(tool) == msgs.index(asst) + 1
        await rt.close()


# ------------------------------------------------------------------ cancel

async def test_response_cancel():
    llm = FakeLLM(["This is a long answer " * 10], token_delay=0.03)
    async with running_app(make_engine(llm=llm, tts=FakeTTS(ms_per_char=10))) as client:
        rt, _ = await _connect(client)
        await rt.send(MANUAL)
        await rt.send({"type": "response.cancel", "event_id": "c0"})
        err = await rt.wait_for("error")
        assert err["error"]["code"] == "response_cancel_not_active"
        await rt.send(user_text("talk"))
        await rt.send({"type": "response.create"})
        await rt.wait_for("response.output_audio_transcript.delta", timeout=5)
        await rt.send({"type": "response.cancel"})
        done = await rt.wait_for("response.done")
        r = done["response"]
        assert r["status"] == "cancelled"
        assert r["status_details"] == {"type": "cancelled", "reason": "client_cancelled"}
        assert r["output"][0]["status"] == "incomplete"
        n = len(rt.events)
        await asyncio.sleep(0.3)
        assert not [e for e in rt.events[n:] if e["type"].startswith("response.output_audio")], "audio after cancel"
        assert llm.cancelled >= 1
        # a new response can start right away
        await rt.send({"type": "response.create"})
        await rt.wait_for("response.created")
        await rt.close()


# ------------------------------------------------------------------ audio in, VAD, transcription

async def test_server_vad_commit_transcription_and_auto_response():
    stt = FakeSTT(["What is the weather like?"])
    llm = FakeLLM(["Sunny."])
    async with running_app(make_engine(llm=llm, stt=stt, tts=FakeTTS(ms_per_char=2))) as client:
        rt, _ = await _connect(client)
        await rt.send({"type": "session.update", "session": {"type": "realtime", "audio": {"input": {
            "transcription": {"model": "gpt-4o-transcribe", "language": "en", "prompt": "ctx"},
            "turn_detection": {"type": "server_vad", "silence_duration_ms": 200, "create_response": True}}}}})
        await rt.wait_for("session.updated")
        await rt.append(np.concatenate([silence(0.3), tone(0.8), silence(0.6)]))
        st = await rt.wait_for("input_audio_buffer.speech_started")
        assert 0 <= st["audio_start_ms"] <= 60 and st["item_id"].startswith("item_")
        sp = await rt.wait_for("input_audio_buffer.speech_stopped")
        assert sp["item_id"] == st["item_id"] and 1050 <= sp["audio_end_ms"] <= 1150
        cm = await rt.wait_for("input_audio_buffer.committed")
        assert cm["item_id"] == st["item_id"] and "previous_item_id" in cm
        added = await rt.wait_for("conversation.item.added")
        assert added["item"]["content"][0] == {"type": "input_audio", "transcript": None}
        comp = await rt.wait_for("conversation.item.input_audio_transcription.completed", timeout=5, from_start=True)
        assert comp["item_id"] == st["item_id"] and comp["transcript"] == "What is the weather like?" and comp["content_index"] == 0
        delta = rt.of("conversation.item.input_audio_transcription.delta")[0]
        assert delta["item_id"] == st["item_id"]
        rd = await rt.wait_for("response.done", timeout=5, from_start=True)
        assert rd["response"]["status"] == "completed"
        assert {"role": "user", "content": "What is the weather like?"} in llm.calls[-1]["messages"]
        assert stt.calls[-1]["language"] == "en" and stt.calls[-1]["prompt"] == "ctx"
        # committed audio = prefix padding + speech + short tail
        assert 0.9 * 16000 <= stt.calls[-1]["samples"] <= 1.6 * 16000
        await rt.close()


async def test_create_response_false_and_manual_commit():
    stt = FakeSTT(["first", "second"])
    llm = FakeLLM()
    async with running_app(make_engine(llm=llm, stt=stt)) as client:
        rt, _ = await _connect(client)
        await rt.send({"type": "session.update", "session": {"type": "realtime", "audio": {"input": {
            "transcription": {"model": "whisper-1"},
            "turn_detection": {"type": "semantic_vad", "eagerness": "low", "create_response": False, "interrupt_response": True}}}}})
        await rt.wait_for("session.updated")
        await rt.append(np.concatenate([tone(0.5), silence(0.6)]))
        await rt.wait_for("conversation.item.input_audio_transcription.completed", timeout=5)
        await asyncio.sleep(0.2)
        assert not rt.of("response.created") and not llm.calls

        # manual mode: commit too-small buffer → error, then a real commit
        await rt.send(MANUAL)
        await rt.wait_for("session.updated")
        await rt.send({"type": "input_audio_buffer.clear"})
        await rt.wait_for("input_audio_buffer.cleared")
        await rt.send({"type": "input_audio_buffer.commit", "event_id": "cm1"})
        err = await rt.wait_for("error")
        assert err["error"]["code"] == "input_audio_buffer_commit_empty"
        await rt.append(tone(0.4))
        await rt.send({"type": "input_audio_buffer.commit"})
        cm = await rt.wait_for("input_audio_buffer.committed")
        comp = await rt.wait_for("conversation.item.input_audio_transcription.completed")
        assert comp["item_id"] == cm["item_id"] and comp["transcript"] == "second"
        assert abs(stt.calls[-1]["samples"] - 0.4 * 16000) < 400
        await rt.append(tone(0.2))
        await rt.send({"type": "input_audio_buffer.clear"})
        await rt.wait_for("input_audio_buffer.cleared")
        await rt.close()


# ------------------------------------------------------------------ barge-in

async def test_barge_in_cancels_and_truncates_to_heard_audio():
    long = "This is the first sentence of a long answer. Here is a second sentence that keeps going. And a third one for good measure."
    llm = FakeLLM([long])
    async with running_app(make_engine(llm=llm, tts=FakeTTS(ms_per_char=25)), ws_audio_lead_ms=100) as client:
        rt, _ = await _connect(client)
        await rt.send({"type": "session.update", "session": {"type": "realtime", "audio": {"input": {
            "turn_detection": {"type": "server_vad", "silence_duration_ms": 300, "create_response": False, "interrupt_response": True}}}}})
        await rt.wait_for("session.updated")
        await rt.send(user_text("tell me"))
        await rt.send({"type": "response.create"})
        first = await rt.wait_for("response.output_audio.delta")
        t_first = asyncio.get_running_loop().time()
        await asyncio.sleep(1.0)
        await rt.append(tone(0.3), realtime=False)
        st = await rt.wait_for("input_audio_buffer.speech_started", timeout=3)
        t_barge = asyncio.get_running_loop().time()
        done = await rt.wait_for("response.done", timeout=2)
        t_done = asyncio.get_running_loop().time()
        assert t_done - t_barge < 0.15, "cancel must be immediate"
        r = done["response"]
        assert r["status"] == "cancelled" and r["status_details"]["reason"] == "turn_detected"
        heard = r["output"][0]["content"][0]["transcript"]
        assert heard and long.startswith(heard) and len(heard) < len(long) * 0.6, heard
        tr = rt.of("conversation.item.truncated")[-1]
        assert tr["item_id"] == r["output"][0]["id"] and tr["content_index"] == 0
        played_ms = (t_barge - t_first) * 1000
        assert abs(tr["audio_end_ms"] - played_ms) < 300, (tr["audio_end_ms"], played_ms)
        deltas = "".join(e["delta"] for e in rt.events if e["type"] == "response.output_audio_transcript.delta")
        assert deltas == heard  # captions == what was heard
        assert rt.of("response.output_audio_transcript.done")[-1]["transcript"] == heard
        # audio stops right away
        n = len(rt.events)
        await asyncio.sleep(0.3)
        assert not [e for e in rt.events[n:] if e["type"] == "response.output_audio.delta"]
        # the conversation keeps the truncated transcript (and so does the next prompt)
        await rt.send({"type": "conversation.item.retrieve", "item_id": tr["item_id"]})
        got = await rt.wait_for("conversation.item.retrieved")
        assert got["item"]["content"][0]["transcript"] == heard
        await rt.close()


async def test_client_truncate_and_history():
    text = "Alpha beta gamma delta. Epsilon zeta eta theta."
    llm = FakeLLM([text, "ok"])
    async with running_app(make_engine(llm=llm, tts=FakeTTS(ms_per_char=10))) as client:
        rt, _ = await _connect(client)
        await rt.send(MANUAL)
        await rt.send(user_text("go"))
        await rt.send({"type": "response.create"})
        rd = await rt.wait_for("response.done", timeout=10)
        iid = rd["response"]["output"][0]["id"]
        total_ms = int(len("Alpha beta gamma delta.") * 10)
        await rt.send({"type": "conversation.item.truncate", "item_id": iid, "content_index": 0, "audio_end_ms": total_ms})
        tr = await rt.wait_for("conversation.item.truncated")
        assert tr["audio_end_ms"] == total_ms and tr["item_id"] == iid
        await rt.send({"type": "conversation.item.truncate", "event_id": "ta_trunc_9", "item_id": iid, "content_index": 0, "audio_end_ms": 999999})
        err = await rt.wait_for("error")
        assert err["error"]["event_id"] == "ta_trunc_9"
        await rt.send({"type": "conversation.item.truncate", "item_id": "item_nope", "content_index": 0, "audio_end_ms": 10})
        assert (await rt.wait_for("error"))["error"]["code"] == "item_not_found"
        await rt.send({"type": "response.create"})
        await rt.wait_for("response.done", timeout=10)
        asst = [m for m in llm.calls[1]["messages"] if m["role"] == "assistant"][0]
        assert asst["content"] == "Alpha beta gamma delta."
        await rt.close()


# ------------------------------------------------------------------ conversation ops / message building

async def test_items_ordering_delete_system_and_instructions():
    llm = FakeLLM(["a", "b"])
    async with running_app(make_engine(llm=llm, tts=FakeTTS(ms_per_char=1))) as client:
        rt, _ = await _connect(client)
        await rt.send({"type": "session.update", "session": {"type": "realtime", "instructions": "SESSION",
                                                             "audio": {"input": {"turn_detection": None}}}})
        await rt.send(user_text("one", ))
        a = (await rt.wait_for("conversation.item.added"))["item"]["id"]
        await rt.send({"type": "conversation.item.create", "item": {"id": "item_custom", "type": "message", "role": "system",
                                                                     "content": [{"type": "input_text", "text": "SYS NOTE"}]}})
        b = await rt.wait_for("conversation.item.added")
        assert b["item"]["id"] == "item_custom" and b["previous_item_id"] == a
        await rt.send(user_text("zero", previous_item_id="root"))
        z = await rt.wait_for("conversation.item.added")
        assert z["previous_item_id"] is None
        await rt.send(user_text("one-and-half", previous_item_id=a))
        h = await rt.wait_for("conversation.item.added")
        assert h["previous_item_id"] == a
        await rt.send(user_text("bad", previous_item_id="item_missing"))
        assert (await rt.wait_for("error"))["error"]["code"] == "item_not_found"
        await rt.send({"type": "conversation.item.delete", "item_id": h["item"]["id"]})
        assert (await rt.wait_for("conversation.item.deleted"))["item_id"] == h["item"]["id"]
        await rt.send({"type": "response.create", "response": {"instructions": "PER RESPONSE"}})
        await rt.wait_for("response.done", timeout=5)
        msgs = llm.calls[0]["messages"]
        assert msgs == [{"role": "system", "content": "PER RESPONSE"}, {"role": "user", "content": "zero"},
                        {"role": "user", "content": "one"}, {"role": "system", "content": "SYS NOTE"}]
        await rt.send({"type": "response.create", "response": {"conversation": "none", "input": [
            {"type": "item_reference", "id": "item_custom"},
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "only this"}]}],
            "output_modalities": ["text"]}})
        await rt.wait_for(lambda e: e["type"] == "response.done" and e["response"]["conversation_id"] is None, timeout=5)
        assert llm.calls[1]["messages"] == [{"role": "system", "content": "SESSION"}, {"role": "system", "content": "SYS NOTE"},
                                            {"role": "user", "content": "only this"}]
        await rt.close()


async def test_llm_error_gives_failed_response():
    llm = FakeLLM([[LLMEvent("error", error="provider exploded")]])
    async with running_app(make_engine(llm=llm)) as client:
        rt, _ = await _connect(client)
        await rt.send(MANUAL)
        await rt.send({"type": "response.create"})
        rd = await rt.wait_for("response.done")
        assert rd["response"]["status"] == "failed"
        assert rd["response"]["status_details"]["type"] == "failed"
        assert "provider exploded" in rd["response"]["status_details"]["error"]["message"]
        await rt.close()


# ------------------------------------------------------------------ speculative start

async def test_speculative_llm_start_on_likely_end():
    stt = FakeSTT(["Speculate please"])
    started_at = {}

    def plan(messages, tools):
        started_at["t"] = asyncio.get_running_loop().time()
        return "Done."

    llm = FakeLLM([plan])
    async with running_app(make_engine(llm=llm, stt=stt, tts=FakeTTS(ms_per_char=2))) as client:
        rt, _ = await _connect(client)
        await rt.send({"type": "session.update", "session": {"type": "realtime", "audio": {"input": {
            "turn_detection": {"type": "server_vad", "silence_duration_ms": 500, "create_response": True}}}}})
        await rt.wait_for("session.updated")
        await rt.append(tone(0.5), realtime=True)
        await rt.append(silence(0.7), realtime=True)
        sp = await rt.wait_for("input_audio_buffer.speech_stopped", timeout=3, from_start=True)
        rd = await rt.wait_for("response.done", timeout=5, from_start=True)
        assert rd["response"]["status"] == "completed"
        assert len(llm.calls) == 1 and len(stt.calls) == 1   # one STT, reused for the item
        assert {"role": "user", "content": "Speculate please"} in llm.calls[0]["messages"]
        comp = rt.of("conversation.item.input_audio_transcription.completed")
        assert not comp  # transcription not configured → no events, but the LLM still got the text
        sess = next(iter(client.app[STATE].sessions))
        assert sess.stats.get("speculative_hits") == 1
        # the LLM was started during the trailing silence, before speech_stopped was decided
        sp_index = rt.events.index(sp)
        assert started_at["t"] < asyncio.get_running_loop().time()
        assert rt.types().index("response.created") > sp_index
        await rt.close()


async def test_speculation_discarded_when_user_resumes():
    stt = FakeSTT(["partial thought", "partial thought and the rest"])
    llm = FakeLLM()
    async with running_app(make_engine(llm=llm, stt=stt, tts=FakeTTS(ms_per_char=2))) as client:
        rt, _ = await _connect(client)
        await rt.send({"type": "session.update", "session": {"type": "realtime", "audio": {"input": {
            "turn_detection": {"type": "server_vad", "silence_duration_ms": 500, "create_response": True}}}}})
        await rt.wait_for("session.updated")
        await rt.append(np.concatenate([tone(0.4), silence(0.25), tone(0.4), silence(0.7)]), realtime=True)
        await rt.wait_for("response.done", timeout=5)
        assert len(rt.of("input_audio_buffer.speech_started")) == 1
        # the response used the final transcript, not the discarded speculative one
        assert llm.calls[-1]["messages"][-1] == {"role": "user", "content": "partial thought and the rest"}
        assert len(rt.of("response.created")) == 1
        sess = next(iter(client.app[STATE].sessions))
        assert sess.stats.get("speculative_discards", 0) >= 1
        await rt.close()


# ------------------------------------------------------------------ real MockLLM (ort.llm.mock) wired in

async def test_with_mock_llm_layer(monkeypatch):
    monkeypatch.setenv("OPENREALTIME_MOCK_TTFT_MS", "0")
    monkeypatch.setenv("OPENREALTIME_MOCK_WORD_MS", "0")
    from ort.llm import make_llm
    llm = make_llm("mock")
    async with running_app(make_engine(llm=llm, tts=FakeTTS(ms_per_char=1))) as client:
        rt, _ = await _connect(client)
        tools = [{"type": "function", "name": "advance_step", "description": "next",
                  "parameters": {"type": "object", "properties": {"reason": {"type": "string"}}, "required": ["reason"]}}]
        await rt.send({"type": "session.update", "session": {"type": "realtime", "instructions": "You moderate.", "tools": tools,
                                                             "audio": {"input": {"turn_detection": None}}}})
        await rt.send(user_text("Say: Welcome to the study."))
        await rt.send({"type": "response.create"})
        rd = await rt.wait_for("response.done", timeout=10)
        assert rd["response"]["output"][0]["content"][0]["transcript"] == "Welcome to the study."
        await rt.send(user_text("I am done, next please"))
        await rt.send({"type": "response.create"})
        fd = await rt.wait_for("response.function_call_arguments.done", timeout=10)
        assert fd["name"] == "advance_step" and isinstance(json.loads(fd["arguments"]), dict)
        rd = await rt.wait_for("response.done", timeout=10)
        assert any(o["type"] == "function_call" for o in rd["response"]["output"])
        await rt.close()


# ------------------------------------------------------------------ HTTP surface: tokens, auth, CORS

async def test_client_secrets_token_and_auth():
    async with running_app(api_key="sk-local") as client:
        body = {"session": {"type": "realtime", "model": "gpt-realtime-2", "instructions": "TOKEN INSTR",
                            "tools": [], "tool_choice": "auto",
                            "audio": {"input": {"noise_reduction": {"type": "near_field"},
                                                "transcription": {"model": "gpt-4o-transcribe", "language": "de"},
                                                "turn_detection": {"type": "semantic_vad", "eagerness": "low",
                                                                   "create_response": False, "interrupt_response": True}},
                                      "output": {"voice": "marin", "speed": 1.1}}}}
        r = await client.post("/v1/realtime/client_secrets", json=body)
        assert r.status == 401
        r = await client.post("/v1/realtime/client_secrets", json=body, headers={"Authorization": "Bearer sk-local"})
        assert r.status == 200
        j = await r.json()
        assert j["value"].startswith("ek_") and j["expires_at"] > 0
        assert j["session"]["model"] == "gpt-realtime-2" and j["session"]["audio"]["output"]["voice"] == "marin"
        # the ek_ token opens a WS session with the minted config
        rt, created = await _connect(client, headers={"Authorization": f"Bearer {j['value']}"})
        s = created["session"]
        assert s["instructions"] == "TOKEN INSTR" and s["audio"]["input"]["turn_detection"]["eagerness"] == "low"
        assert s["audio"]["input"]["transcription"]["language"] == "de"
        await rt.close()
        # subprotocol-style key (browser WS)
        rt, created = await _connect(client, protocols=("realtime", "openai-insecure-api-key.sk-local"))
        assert created["session"]["model"] == "gpt-realtime"
        await rt.close()
        bad = await client.get("/v1/realtime", headers={"Authorization": "Bearer ek_bogus"})
        assert bad.status == 401
        r = await client.post("/v1/realtime/calls", data="v=0\r\n", headers={"Authorization": "Bearer ek_bogus",
                                                                              "Content-Type": "application/sdp"})
        assert r.status == 401
        h = await (await client.get("/health")).json()
        assert h["ok"] is True and h["tokens_minted"] == 1


async def test_cors_preflight_and_headers():
    async with running_app() as client:
        r = await client.options("/v1/realtime/calls", headers={"Origin": "http://localhost:5173",
                                                                 "Access-Control-Request-Method": "POST",
                                                                 "Access-Control-Request-Headers": "authorization,content-type"})
        assert r.status == 204
        assert r.headers["Access-Control-Allow-Origin"] == "*"
        assert "authorization" in r.headers["Access-Control-Allow-Headers"].lower()
        r = await client.post("/v1/realtime/client_secrets", json={"session": {"type": "realtime"}},
                              headers={"Origin": "http://localhost:5173"})
        assert r.status == 200 and r.headers["Access-Control-Allow-Origin"] == "*"
        r = await client.post("/v1/realtime/client_secrets", json={"session": {"type": "realtime", "tool_choice": "bogus"}})
        assert r.status == 400 and (await r.json())["error"]["param"] == "session.tool_choice"
