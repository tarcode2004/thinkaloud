"""Parallel tool calls in one response, and text + calls together (output_index ordering, per-item
added/done, arguments.done, history rebuilt correctly for the next LLM request)."""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["OPENREALTIME_LLM"] = "mock"

from fakes import RT, FakeLLM, FakeTTS, make_engine, running_app, tool_call  # noqa: E402
from test_protocol_races import check_invariants, settle  # noqa: E402
from ort.server import STATE  # noqa: E402

pytestmark = pytest.mark.asyncio

TOOLS = [{"type": "function", "name": n, "parameters": {"type": "object", "properties": {"x": {"type": "integer"}}}}
         for n in ("lookup", "save", "advance_step")]


async def connect(client):
    rt = await RT.connect(client)
    await rt.wait_for("session.created")
    await rt.send({"type": "session.update", "session": {"tools": TOOLS, "audio": {"input": {"turn_detection": None}}}})
    await rt.wait_for("session.updated")
    return rt, next(iter(client.app[STATE].sessions))


def user_text(t):
    return {"type": "conversation.item.create", "item": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": t}]}}


def per_item_sequence(rt, rid):
    """{output_index: [event types]} for one response."""
    seq: dict[int, list[str]] = {}
    for e in rt.events:
        if e.get("response_id") == rid and "output_index" in e:
            seq.setdefault(e["output_index"], []).append(e["type"])
    return seq


async def test_parallel_calls_in_one_response():
    calls = [tool_call("lookup", {"x": 1}, "call_a"), tool_call("save", {"x": 2}, "call_b"), tool_call("advance_step", {"x": 3}, "call_c")]
    llm = FakeLLM([calls, "All three done."])
    async with running_app(make_engine(llm=llm, tts=FakeTTS(ms_per_char=2))) as client:
        rt, sess = await connect(client)
        await rt.send(user_text("do three things"))
        await rt.send({"type": "response.create"})
        rd = await rt.wait_for("response.done", timeout=5)
        rid = rd["response"]["id"]
        out = rd["response"]["output"]
        assert [o["call_id"] for o in out] == ["call_a", "call_b", "call_c"]
        assert [o["name"] for o in out] == ["lookup", "save", "advance_step"]
        assert all(o["status"] == "completed" and o["type"] == "function_call" for o in out)
        assert [json.loads(o["arguments"]) for o in out] == [{"x": 1}, {"x": 2}, {"x": 3}]
        seq = per_item_sequence(rt, rid)
        assert sorted(seq) == [0, 1, 2]
        for oi in range(3):
            assert seq[oi] == ["response.output_item.added", "response.function_call_arguments.delta",
                               "response.function_call_arguments.done", "response.output_item.done"], seq[oi]
        added = [e["output_index"] for e in rt.of("response.output_item.added")]
        assert added == sorted(added) == [0, 1, 2]
        ad = {e["call_id"]: e for e in rt.of("response.function_call_arguments.done")}
        for o in out:
            assert ad[o["call_id"]]["item_id"] == o["id"] and ad[o["call_id"]]["name"] == o["name"]
        # conversation got the 3 calls, chained by previous_item_id
        conv = [e for e in rt.of("conversation.item.added") if e["item"]["type"] == "function_call"]
        assert [e["item"]["call_id"] for e in conv] == ["call_a", "call_b", "call_c"]
        assert conv[1]["previous_item_id"] == conv[0]["item"]["id"] and conv[2]["previous_item_id"] == conv[1]["item"]["id"]
        # outputs arrive out of order; the next request still pairs them with the calls, in call order
        for cid in ("call_c", "call_a", "call_b"):
            await rt.send({"type": "conversation.item.create", "item": {"type": "function_call_output", "call_id": cid,
                                                                         "output": json.dumps({"id": cid})}})
        await rt.send({"type": "response.create"})
        await rt.wait_for(lambda e: e["type"] == "response.done" and e["response"]["id"] != rid, timeout=5)
        msgs = llm.calls[1]["messages"]
        roles = [m["role"] for m in msgs]
        assert roles == ["user", "assistant", "tool", "tool", "tool"], roles
        assert [c["id"] for c in msgs[1]["tool_calls"]] == ["call_a", "call_b", "call_c"]
        assert [m["tool_call_id"] for m in msgs[2:]] == ["call_a", "call_b", "call_c"]
        assert json.loads(msgs[2]["content"]) == {"id": "call_a"}
        await settle(rt, sess)
        await rt.close()


async def test_text_and_calls_in_one_response():
    llm = FakeLLM([["Let me look that up for you.", tool_call("lookup", {"x": 1}, "call_1"), tool_call("save", {"x": 2}, "call_2")]])
    async with running_app(make_engine(llm=llm, tts=FakeTTS(ms_per_char=4))) as client:
        rt, sess = await connect(client)
        await rt.send(user_text("look it up"))
        await rt.send({"type": "response.create"})
        rd = await rt.wait_for("response.done", timeout=8)
        out = rd["response"]["output"]
        assert [o["type"] for o in out] == ["message", "function_call", "function_call"]
        assert out[0]["content"][0]["transcript"] == "Let me look that up for you."
        seq = per_item_sequence(rt, rd["response"]["id"])
        assert seq[0][0] == "response.output_item.added" and seq[0][-1] == "response.output_item.done"
        for oi in (1, 2):
            assert seq[oi] == ["response.output_item.added", "response.function_call_arguments.delta",
                               "response.function_call_arguments.done", "response.output_item.done"]
        added = [e["output_index"] for e in rt.of("response.output_item.added")]
        assert added == [0, 1, 2]
        # conversation order: user, assistant message, call_1, call_2
        assert [(i["type"], i.get("call_id")) for i in sess.items] == [("message", None), ("message", None),
                                                                      ("function_call", "call_1"), ("function_call", "call_2")]
        # history: one assistant message carrying the text and both tool calls, then placeholders
        await rt.send({"type": "response.create"})
        await rt.wait_for(lambda e: e["type"] == "response.done" and len(rt.of("response.done")) == 2, timeout=8)
        msgs = llm.calls[1]["messages"]
        asst = msgs[1]
        assert asst["role"] == "assistant" and asst["content"] == "Let me look that up for you."
        assert [c["id"] for c in asst["tool_calls"]] == ["call_1", "call_2"]
        assert [m["role"] for m in msgs[2:4]] == ["tool", "tool"]
        await settle(rt, sess)
        await rt.close()


async def test_call_then_text_and_duplicate_call_ids():
    llm = FakeLLM([[tool_call("lookup", {"x": 1}, "dup"), "Okay, one moment.", tool_call("save", {"x": 2}, "dup")]])
    async with running_app(make_engine(llm=llm, tts=FakeTTS(ms_per_char=2))) as client:
        rt, sess = await connect(client)
        await rt.send(user_text("go"))
        await rt.send({"type": "response.create"})
        rd = await rt.wait_for("response.done", timeout=8)
        out = rd["response"]["output"]
        assert [o["type"] for o in out] == ["function_call", "message", "function_call"]
        ids = [o["call_id"] for o in out if o["type"] == "function_call"]
        assert ids[0] == "dup" and len(set(ids)) == 2, ids          # a reused id is made unique
        args_done = [e["call_id"] for e in rt.of("response.function_call_arguments.done")]
        assert args_done == ids
        check_invariants(rt, sess)
        await rt.close()


async def test_text_only_response_with_parallel_calls_text_modality():
    llm = FakeLLM([["Checking.", tool_call("lookup", {}, "c1"), tool_call("save", {}, "c2")]])
    async with running_app(make_engine(llm=llm)) as client:
        rt, sess = await connect(client)
        await rt.send(user_text("go"))
        await rt.send({"type": "response.create", "response": {"output_modalities": ["text"]}})
        rd = await rt.wait_for("response.done", timeout=5)
        out = rd["response"]["output"]
        assert [o["type"] for o in out] == ["message", "function_call", "function_call"]
        assert out[0]["content"][0] == {"type": "output_text", "text": "Checking."}
        await settle(rt, sess)
        await rt.close()
