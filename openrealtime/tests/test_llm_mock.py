"""MockLLM + make_llm (offline)."""
import asyncio
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ort.llm import LLM, make_llm  # noqa: E402
from ort.llm.mock import MockLLM  # noqa: E402

ADV = {"type": "function", "name": "advance_step", "description": "next",
       "parameters": {"type": "object", "properties": {"reason": {"type": "string"}},
                      "required": ["reason"]}}
NOTE = {"type": "function", "name": "log_note", "parameters": {
    "type": "object", "properties": {"severity": {"type": "string", "enum": ["low", "high"]}},
    "required": ["severity"]}}

FAST = {"mock_ttft_ms": 0, "mock_word_ms": 0}


async def run(llm, msgs, tools=(), tc="auto", **kw):
    return [e async for e in llm.stream(msgs, list(tools), tc, **kw)]


def user(t):
    return [{"role": "user", "content": t}]


def test_make_llm_mock_env(monkeypatch):
    monkeypatch.setenv("OPENREALTIME_LLM", "mock")
    llm = make_llm({})
    assert isinstance(llm, MockLLM) and isinstance(llm, LLM)


def test_make_llm_unknown(monkeypatch):
    monkeypatch.delenv("OPENREALTIME_LLM", raising=False)
    with pytest.raises(ValueError):
        make_llm({"llm": "nope"})


@pytest.mark.asyncio
async def test_done_calls_advance_tool():
    evs = await run(MockLLM(FAST), user("Okay I'm done with this one"), [NOTE, ADV])
    assert [e.type for e in evs] == ["tool_call", "done"]
    tc = evs[0].tool_call
    assert tc.name == "advance_step" and json.loads(tc.arguments) == {"reason": ""}
    assert tc.call_id.startswith("call_")


@pytest.mark.asyncio
async def test_done_without_matching_tool_replies_text():
    evs = await run(MockLLM(FAST), user("done"), [NOTE])
    assert evs[0].type == "text_delta" and evs[-1].type == "done"


@pytest.mark.asyncio
async def test_say_rule_and_word_streaming():
    evs = await run(MockLLM(FAST), user('Say: "Hello there, welcome to the study."'))
    deltas = [e.text for e in evs if e.type == "text_delta"]
    assert "".join(deltas) == "Hello there, welcome to the study."
    assert len(deltas) == 6
    assert evs[0].meta["provider"] == "mock"
    assert evs[-1].meta["text"] == "Hello there, welcome to the study."


@pytest.mark.asyncio
async def test_tool_choice_rules():
    m = MockLLM(FAST)
    evs = await run(m, user("hello"), [ADV, NOTE], {"type": "function", "name": "log_note"})
    assert evs[0].tool_call.name == "log_note" and json.loads(evs[0].tool_call.arguments) == {"severity": "low"}
    evs = await run(m, user("hello"), [ADV, NOTE], "required")
    assert evs[0].tool_call.name == "advance_step"
    evs = await run(m, user("I'm done"), [ADV], "none")
    assert all(e.type != "tool_call" for e in evs)
    evs = await run(m, user("please call log_note"), [ADV, NOTE])
    assert evs[0].tool_call.name == "log_note"


@pytest.mark.asyncio
async def test_after_tool_result_and_determinism():
    m = MockLLM(FAST)
    msgs = user("done") + [{"role": "assistant", "content": None, "tool_calls": [
        {"id": "c1", "type": "function", "function": {"name": "advance_step", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "c1", "content": "ok"}]
    evs = await run(m, msgs, [ADV])
    assert "".join(e.text for e in evs if e.type == "text_delta") == "Okay, got it."
    a = await run(m, user("What do you think of the layout?"))
    b = await run(m, user("What do you think of the layout?"))
    assert [e.text for e in a] == [e.text for e in b]


@pytest.mark.asyncio
async def test_timing_and_cancellation():
    m = MockLLM({"mock_ttft_ms": 50, "mock_word_ms": 20})
    t0 = asyncio.get_running_loop().time()
    agen = m.stream(user("Say: one two three four five six"), [])
    first = await agen.__anext__()
    assert first.type == "text_delta"
    assert asyncio.get_running_loop().time() - t0 >= 0.045
    await agen.aclose()  # must not raise


REC = {"type": "function", "name": "record_answer", "parameters": {
    "type": "object", "properties": {"question_id": {"type": "string"}, "text": {"type": "string"}},
    "required": ["question_id"]}}


def text_of(evs):
    return "".join(e.text for e in evs if e.type == "text_delta")


@pytest.mark.asyncio
async def test_directive_dictation_and_call():
    m = MockLLM(FAST)
    base = "# Role\nNever call record_answer on your own. Say it like: \"Okay.\"\n"
    # The last section of the instructions dictates the reply (earlier sections are ignored).
    msgs = [{"role": "system", "content": base + '\n# NOW\nSay the following text verbatim:\n"Welcome, shall we begin?"'},
            {"role": "system", "content": "[STEP] {}"}]
    assert text_of(await run(m, msgs, [ADV, REC], "none")) == "Welcome, shall we begin?"
    msgs = [{"role": "system", "content": base + '\n# NOW\nAsk exactly this, neutrally: "How did it go?" Say nothing else.'}]
    assert text_of(await run(m, msgs, [ADV], "none")) == "How did it go?"
    # 'call <tool> now' with string args quoted in the text; empty text-like args echo the user.
    msgs = [{"role": "system", "content": base + '\n# NOW\nCall record_answer for question_id "q7" now.'},
            {"role": "user", "content": "It was fine."}]
    evs = await run(m, msgs, [ADV, REC])
    assert evs[0].tool_call.name == "record_answer"
    assert json.loads(evs[0].tool_call.arguments) == {"question_id": "q7", "text": "It was fine."}
    # A negated mention is not an instruction; base sections never drive calls.
    msgs = [{"role": "system", "content": base + "\n# Start\nDo not call record_answer yet."}, {"role": "user", "content": "hello"}]
    assert all(e.type != "tool_call" for e in await run(m, msgs, [REC]))


@pytest.mark.asyncio
async def test_tool_result_say_field_and_follow_up_call():
    m = MockLLM(FAST)
    call_msg = {"role": "assistant", "content": None, "tool_calls": [
        {"id": "c1", "type": "function", "function": {"name": "record_answer", "arguments": "{}"}}]}
    msgs = user("ready") + [call_msg, {"role": "tool", "tool_call_id": "c1",
                                       "content": json.dumps({"ok": True, "say_verbatim": "Next question?", "your_job": "call record_answer"})}]
    assert text_of(await run(m, msgs, [ADV, REC])) == "Next question?"
    msgs = user("ready") + [call_msg, {"role": "tool", "tool_call_id": "c1",
                                       "content": json.dumps({"ok": True, "your_job": "Recorded. Call advance_step now. Then call record_answer."})}]
    evs = await run(m, msgs, [ADV, REC])
    assert evs[0].tool_call.name == "advance_step"
