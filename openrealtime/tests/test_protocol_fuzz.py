"""Protocol fuzzing: malformed / hostile client events must give an OpenAI-style `error` event
(type, code, message, param, event_id) and leave the session healthy, never crash or hang it."""
import asyncio
import base64
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["OPENREALTIME_LLM"] = "mock"

from fakes import RT, T, wait_until, FakeLLM, FakeTTS, make_engine, running_app, tool_call  # noqa: E402
from ort.server import STATE  # noqa: E402

pytestmark = pytest.mark.asyncio

MANUAL = {"type": "session.update", "session": {"type": "realtime", "audio": {"input": {"turn_detection": None}}}}


def user_text(text, **kw):
    return {"type": "conversation.item.create", "item": {"type": "message", "role": "user",
                                                         "content": [{"type": "input_text", "text": text}]}, **kw}


def assert_error_shape(ev, *, code=None, param="__any__", event_id="__any__"):
    assert ev["type"] == "error" and ev["event_id"].startswith("event_")
    e = ev["error"]
    assert set(e) >= {"type", "code", "message", "param", "event_id"}, e
    assert e["type"] == "invalid_request_error", e
    assert isinstance(e["message"], str) and e["message"]
    if code is not None:
        assert e["code"] == code, e
    if param != "__any__":
        assert e["param"] == param, e
    if event_id != "__any__":
        assert e["event_id"] == event_id, e


async def healthy(rt: RT, llm: FakeLLM):
    """The session still answers: a session.update and a text response go through."""
    await rt.send({"type": "session.update", "event_id": "ok_upd", "session": {"type": "realtime", "instructions": "still fine"}})
    up = await rt.wait_for("session.updated", timeout=3)
    assert up["session"]["instructions"] == "still fine"
    llm.push("Still alive.")
    await rt.send(user_text("ping"))
    await rt.send({"type": "response.create", "response": {"output_modalities": ["text"]}})
    rd = await rt.wait_for("response.done", timeout=5)
    assert rd["response"]["status"] == "completed", rd
    assert not [e for e in rt.events if e["type"] == "error" and e["error"]["type"] != "invalid_request_error"], \
        [e["error"] for e in rt.events if e["type"] == "error"]


async def _connect(client):
    rt = await RT.connect(client)
    await rt.wait_for("session.created")
    await rt.send(MANUAL)
    await rt.wait_for("session.updated")
    return rt


# Each case: list of raw frames/events (dict or raw str), then the expected (code, param).
CASES = [
    ("bad_json", ["{not json"], "invalid_json", None),
    ("json_array", ["[1,2]"], "invalid_type", None),
    ("json_number", ["42"], "invalid_type", None),
    ("json_null", ["null"], "invalid_type", None),
    ("nan_literal", ['{"type":"session.update","session":{"audio":{"output":{"speed":NaN}}}}'], "invalid_json", None),
    ("deep_nesting", ["[" * 200000 + "]" * 200000], "invalid_json", None),
    ("missing_type", [{"event_id": "e1"}], "missing_required_parameter", "type"),
    ("type_not_string", [{"type": 5, "event_id": "e1"}], "invalid_type", "type"),
    ("unknown_type", [{"type": "conversation.item.explode", "event_id": "e1"}], "invalid_value", "type"),
    # session.update
    ("session_not_object", [{"type": "session.update", "session": "x", "event_id": "e1"}], "invalid_type", "session"),
    ("instructions_int", [{"type": "session.update", "session": {"instructions": 123}, "event_id": "e1"}], "invalid_type", "session.instructions"),
    ("tool_choice_bogus", [{"type": "session.update", "session": {"tool_choice": "bogus"}, "event_id": "e1"}], "invalid_value", "session.tool_choice"),
    ("tools_object", [{"type": "session.update", "session": {"tools": {"a": 1}}, "event_id": "e1"}], "invalid_type", "session.tools"),
    ("tool_params_str", [{"type": "session.update", "session": {"tools": [{"type": "function", "name": "f", "parameters": "x"}]}, "event_id": "e1"}], "invalid_type", "session.tools[0].parameters"),
    ("audio_string", [{"type": "session.update", "session": {"audio": "loud"}, "event_id": "e1"}], "invalid_type", "session.audio"),
    ("audio_input_list", [{"type": "session.update", "session": {"audio": {"input": []}}, "event_id": "e1"}], "invalid_type", "session.audio.input"),
    ("speed_string", [{"type": "session.update", "session": {"audio": {"output": {"speed": "fast"}}}, "event_id": "e1"}], "invalid_type", "session.audio.output.speed"),
    ("voice_int", [{"type": "session.update", "session": {"audio": {"output": {"voice": 7}}}, "event_id": "e1"}], "invalid_type", "session.audio.output.voice"),
    ("format_bogus", [{"type": "session.update", "session": {"audio": {"input": {"format": {"type": "audio/flac"}}}}, "event_id": "e1"}], "invalid_value", "session.audio.input.format.type"),
    ("td_silence_str", [{"type": "session.update", "session": {"audio": {"input": {"turn_detection": {"type": "server_vad", "silence_duration_ms": "long"}}}}, "event_id": "e1"}], "invalid_type", "session.audio.input.turn_detection.silence_duration_ms"),
    ("td_threshold_range", [{"type": "session.update", "session": {"audio": {"input": {"turn_detection": {"type": "server_vad", "threshold": 3}}}}, "event_id": "e1"}], "invalid_value", "session.audio.input.turn_detection.threshold"),
    ("td_eagerness", [{"type": "session.update", "session": {"audio": {"input": {"turn_detection": {"type": "semantic_vad", "eagerness": "eager"}}}}, "event_id": "e1"}], "invalid_value", "session.audio.input.turn_detection.eagerness"),
    ("td_idle_str", [{"type": "session.update", "session": {"audio": {"input": {"turn_detection": {"type": "server_vad", "idle_timeout_ms": "soon"}}}}, "event_id": "e1"}], "invalid_type", "session.audio.input.turn_detection.idle_timeout_ms"),
    ("transcription_str", [{"type": "session.update", "session": {"audio": {"input": {"transcription": "whisper"}}}, "event_id": "e1"}], "invalid_type", "session.audio.input.transcription"),
    ("max_tokens_neg", [{"type": "session.update", "session": {"max_output_tokens": -5}, "event_id": "e1"}], "invalid_value", "session.max_output_tokens"),
    ("max_tokens_str", [{"type": "session.update", "session": {"max_output_tokens": "lots"}, "event_id": "e1"}], "invalid_value", "session.max_output_tokens"),
    ("truncation_bogus", [{"type": "session.update", "session": {"truncation": "sometimes"}, "event_id": "e1"}], "invalid_value", "session.truncation"),
    ("truncation_ratio_range", [{"type": "session.update", "session": {"truncation": {"type": "retention_ratio", "retention_ratio": 1.5}}, "event_id": "e1"}], "invalid_value", "session.truncation.retention_ratio"),
    ("modalities_bogus", [{"type": "session.update", "session": {"output_modalities": ["video"]}, "event_id": "e1"}], "invalid_value", "session.output_modalities"),
    # input audio buffer
    ("append_no_audio", [{"type": "input_audio_buffer.append", "event_id": "e1"}], "missing_required_parameter", "audio"),
    ("append_audio_int", [{"type": "input_audio_buffer.append", "audio": 12, "event_id": "e1"}], "invalid_type", "audio"),
    ("append_bad_b64", [{"type": "input_audio_buffer.append", "audio": "abc", "event_id": "e1"}], "invalid_value", "audio"),
    # items
    ("item_missing", [{"type": "conversation.item.create", "event_id": "e1"}], "missing_required_parameter", "item"),
    ("item_list", [{"type": "conversation.item.create", "item": [], "event_id": "e1"}], "invalid_type", "item"),
    ("item_type_bogus", [{"type": "conversation.item.create", "item": {"type": "image"}, "event_id": "e1"}], "invalid_value", "item.type"),
    ("item_role_tool", [{"type": "conversation.item.create", "item": {"type": "message", "role": "tool", "content": []}, "event_id": "e1"}], "invalid_value", "item.role"),
    ("item_text_int", [{"type": "conversation.item.create", "item": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": 5}]}, "event_id": "e1"}], "invalid_type", "item.content[0].text"),
    ("item_id_int", [{"type": "conversation.item.create", "item": {"id": 5, "type": "message", "role": "user", "content": []}, "event_id": "e1"}], "invalid_type", "item.id"),
    ("item_id_long", [{"type": "conversation.item.create", "item": {"id": "x" * 100, "type": "message", "role": "user", "content": []}, "event_id": "e1"}], "invalid_value", "item.id"),
    ("item_prev_list", [{"type": "conversation.item.create", "previous_item_id": ["a"], "item": {"type": "message", "role": "user", "content": []}, "event_id": "e1"}], "invalid_type", "previous_item_id"),
    ("item_audio_bad_b64", [{"type": "conversation.item.create", "item": {"type": "message", "role": "user", "content": [{"type": "input_audio", "audio": "abc"}]}, "event_id": "e1"}], "invalid_value", "item.content[0].audio"),
    ("fco_unknown_call", [{"type": "conversation.item.create", "item": {"type": "function_call_output", "call_id": "call_nope", "output": "{}"}, "event_id": "e1"}], "invalid_value", "item.call_id"),
    ("fco_no_call_id", [{"type": "conversation.item.create", "item": {"type": "function_call_output", "output": "{}"}, "event_id": "e1"}], "missing_required_parameter", "item.call_id"),
    ("fc_no_name", [{"type": "conversation.item.create", "item": {"type": "function_call", "call_id": "c1"}, "event_id": "e1"}], "missing_required_parameter", "item.name"),
    ("delete_no_id", [{"type": "conversation.item.delete", "event_id": "e1"}], "missing_required_parameter", "item_id"),
    ("delete_id_list", [{"type": "conversation.item.delete", "item_id": ["x"], "event_id": "e1"}], "invalid_type", "item_id"),
    ("delete_unknown", [{"type": "conversation.item.delete", "item_id": "item_nope", "event_id": "e1"}], "item_not_found", "item_id"),
    ("retrieve_unknown", [{"type": "conversation.item.retrieve", "item_id": "item_nope", "event_id": "e1"}], "item_not_found", "item_id"),
    ("truncate_unknown", [{"type": "conversation.item.truncate", "item_id": "item_nope", "content_index": 0, "audio_end_ms": 1, "event_id": "e1"}], "item_not_found", "item_id"),
    ("truncate_no_ms", [{"type": "conversation.item.truncate", "item_id": "@asst", "content_index": 0, "event_id": "e1"}], "missing_required_parameter", "audio_end_ms"),
    ("truncate_ci_str", [{"type": "conversation.item.truncate", "item_id": "@asst", "content_index": "zero", "audio_end_ms": 1, "event_id": "e1"}], "invalid_type", "content_index"),
    ("truncate_ci_range", [{"type": "conversation.item.truncate", "item_id": "@asst", "content_index": 3, "audio_end_ms": 1, "event_id": "e1"}], "invalid_value", "content_index"),
    ("truncate_beyond", [{"type": "conversation.item.truncate", "item_id": "@asst", "content_index": 0, "audio_end_ms": 10 ** 7, "event_id": "e1"}], "invalid_value", "audio_end_ms"),
    ("truncate_negative", [{"type": "conversation.item.truncate", "item_id": "@asst", "content_index": 0, "audio_end_ms": -1, "event_id": "e1"}], "invalid_value", "audio_end_ms"),
    ("truncate_user_item", [{"type": "conversation.item.truncate", "item_id": "@user", "content_index": 0, "audio_end_ms": 1, "event_id": "e1"}], "invalid_value", "item_id"),
    ("truncate_deleted", [{"type": "conversation.item.delete", "item_id": "@asst"},
                          {"type": "conversation.item.truncate", "item_id": "@asst", "content_index": 0, "audio_end_ms": 1, "event_id": "e1"}], "item_not_found", "item_id"),
    ("delete_twice", [{"type": "conversation.item.delete", "item_id": "@user"},
                      {"type": "conversation.item.delete", "item_id": "@user", "event_id": "e1"}], "item_not_found", "item_id"),
    ("truncate_twice_longer", [{"type": "conversation.item.truncate", "item_id": "@asst", "content_index": 0, "audio_end_ms": 100},
                               {"type": "conversation.item.truncate", "item_id": "@asst", "content_index": 0, "audio_end_ms": 400, "event_id": "e1"}], "invalid_value", "audio_end_ms"),
    # responses
    ("response_str", [{"type": "response.create", "response": "now", "event_id": "e1"}], "invalid_type", "response"),
    ("tool_choice_bad", [{"type": "response.create", "response": {"tool_choice": "maybe"}, "event_id": "e1"}], "invalid_value", "response.tool_choice"),
    ("tool_choice_unknown_fn", [{"type": "response.create", "response": {"tool_choice": {"type": "function", "name": "nope"}}, "event_id": "e1"}], "invalid_value", "response.tool_choice"),
    ("tool_choice_int", [{"type": "response.create", "response": {"tool_choice": 3}, "event_id": "e1"}], "invalid_value", "response.tool_choice"),
    ("response_tools_bad", [{"type": "response.create", "response": {"tools": [{"type": "function"}]}, "event_id": "e1"}], "missing_required_parameter", "response.tools[0].name"),
    ("response_modalities", [{"type": "response.create", "response": {"output_modalities": ["smell"]}, "event_id": "e1"}], "invalid_value", "response.output_modalities"),
    ("response_conversation", [{"type": "response.create", "response": {"conversation": "other"}, "event_id": "e1"}], "invalid_value", "response.conversation"),
    ("response_input_bad", [{"type": "response.create", "response": {"input": [123]}, "event_id": "e1"}], "invalid_type", "response.input[0]"),
    ("response_input_ref", [{"type": "response.create", "response": {"conversation": "none", "input": [{"type": "item_reference", "id": "item_nope"}]}, "event_id": "e1"}], "item_not_found", "response.input[0].id"),
    ("response_instr_int", [{"type": "response.create", "response": {"instructions": 5}, "event_id": "e1"}], "invalid_type", "response.instructions"),
    ("response_max_tokens", [{"type": "response.create", "response": {"max_output_tokens": 0}, "event_id": "e1"}], "invalid_value", "response.max_output_tokens"),
    ("response_metadata", [{"type": "response.create", "response": {"metadata": "x"}, "event_id": "e1"}], "invalid_type", "response.metadata"),
    ("response_voice", [{"type": "response.create", "response": {"audio": {"output": {"voice": 9}}}, "event_id": "e1"}], "invalid_type", "response.audio.output.voice"),
    ("cancel_rid_int", [{"type": "response.cancel", "response_id": 5, "event_id": "e1"}], "invalid_type", "response_id"),
    ("cancel_unknown", [{"type": "response.cancel", "response_id": "resp_nope", "event_id": "e1"}], "response_cancel_not_active", None),
]


@pytest.mark.parametrize("name,frames,code,param", CASES, ids=[c[0] for c in CASES])
async def test_fuzz_event(name, frames, code, param):
    llm = FakeLLM()
    async with running_app(make_engine(llm=llm, tts=FakeTTS(ms_per_char=5))) as client:
        rt = await _connect(client)
        # a user item and a finished (short) assistant audio item to point at
        llm.push("One two three four five six seven eight.")
        await rt.send(user_text("hi"))
        uid = (await rt.wait_for("conversation.item.added"))["item"]["id"]
        await rt.send({"type": "response.create"})
        rd = await rt.wait_for("response.done", timeout=5)
        aid = rd["response"]["output"][0]["id"]
        start = len(rt.events)
        for f in frames:
            if isinstance(f, dict):
                f = json.loads(json.dumps(f).replace('"@asst"', json.dumps(aid)).replace('"@user"', json.dumps(uid)))
                await rt.send(f)
            else:
                await rt.ws.send_str(f)
        err = await rt.wait_for("error", timeout=3)
        expected_eid = None if not isinstance(frames[-1], dict) or "event_id" not in frames[-1] else frames[-1]["event_id"]
        assert_error_shape(err, code=code, param=param, event_id=expected_eid)
        assert len([e for e in rt.events[start:] if e["type"] == "error"]) == 1, rt.types(start)
        # nothing in the session config was changed by the rejected event
        sess = next(iter(client.app[STATE].sessions))
        assert sess.config["instructions"] == "" and sess.config["tool_choice"] == "auto"
        assert isinstance(sess.config["audio"], dict) and sess.active is None
        await healthy(rt, llm)
        await rt.close()


async def test_rejected_session_update_is_atomic():
    """A session.update that fails validation must not apply any part of itself."""
    async with running_app() as client:
        rt = await _connect(client)
        await rt.send({"type": "session.update", "session": {"instructions": "NEW", "audio": {"output": {"voice": "ash", "speed": "x"}}}})
        await rt.wait_for("error")
        sess = next(iter(client.app[STATE].sessions))
        assert sess.config["instructions"] == "" and sess.config["audio"]["output"]["voice"] == "alloy"
        await rt.close()


async def test_oversized_event_rejected_but_session_survives():
    llm = FakeLLM()
    async with running_app(make_engine(llm=llm), max_event_bytes=1 << 20) as client:
        rt = await _connect(client)
        big = base64.b64encode(b"\0" * (2 << 20)).decode()
        await rt.send({"type": "input_audio_buffer.append", "audio": big, "event_id": "big1"})
        err = await rt.wait_for("error", timeout=5)
        assert_error_shape(err, code="event_too_large")
        await healthy(rt, llm)
        await rt.close()


async def test_large_append_is_chunked_for_the_detector():
    """A 60 s append in one event reaches the turn detector in small pieces (bounded per-call work)."""
    sizes = []

    class Probe:
        def __init__(self, cfg):
            pass

        def update(self, cfg):
            pass

        def feed(self, chunk):
            sizes.append(chunk.size)
            return []

    async with running_app(make_engine(turn_factory=lambda c: Probe(c))) as client:
        rt = await RT.connect(client)
        await rt.wait_for("session.created")
        pcm = b"\0\1" * (24000 * 60)
        await rt.send({"type": "input_audio_buffer.append", "audio": base64.b64encode(pcm).decode()})
        await wait_until(lambda: sum(sizes) >= 16000 * 59, timeout=10)
        assert sum(sizes) >= 16000 * 59 and max(sizes) <= 16000, (sum(sizes), max(sizes))
        await rt.close()


async def test_function_call_output_for_known_and_oob_calls_accepted():
    llm = FakeLLM([[tool_call("f", {}, "call_inband")], [tool_call("f", {}, "call_oob")]])
    tools = [{"type": "function", "name": "f", "parameters": {"type": "object", "properties": {}}}]
    async with running_app(make_engine(llm=llm)) as client:
        rt = await _connect(client)
        await rt.send({"type": "session.update", "session": {"tools": tools}})
        await rt.send({"type": "response.create"})
        await rt.wait_for("response.done")
        await rt.send({"type": "response.create", "response": {"conversation": "none"}})
        await rt.wait_for("response.done")
        for cid in ("call_inband", "call_oob"):
            await rt.send({"type": "conversation.item.create", "item": {"type": "function_call_output", "call_id": cid, "output": "{}"}})
            ad = await rt.wait_for("conversation.item.added")
            assert ad["item"]["call_id"] == cid
        assert not rt.of("error")
        await rt.close()


async def test_webrtc_style_event_worker_survives_hostile_frames():
    """The data-channel event worker must not die on hostile frames (it has no per-message try)."""
    from ort.transport_webrtc import Call

    class _State:
        calls = {}

        def untrack(self, s):
            pass

    class _PC:
        async def close(self):
            pass

    from ort.session import Session
    from ort.events import new_session
    from fakes import make_config
    s = Session(make_engine(), make_config(), new_session("gpt-realtime"), transport="webrtc")
    got = []
    s.add_listener(got.append)
    call = Call(_State(), s, _PC(), s.output)
    call.start()
    for m in ["[" * 100000 + "]" * 100000, "{bad", "7", json.dumps({"type": "session.update", "session": {"instructions": "ok"}})]:
        call.in_q.put_nowait(m)
    await wait_until(lambda: any(e["type"] == "session.updated" for e in call.pending_events()), timeout=10)
    evs = call.pending_events()
    assert [e["type"] for e in evs].count("error") == 3, [e["type"] for e in evs]
    assert any(e["type"] == "session.updated" for e in evs)
    await call.close()
