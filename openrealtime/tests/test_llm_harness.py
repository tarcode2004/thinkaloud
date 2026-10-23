"""Offline tests for the tool-call harness: conversion, repair, leak recovery, the
streaming speech filter, message sanitising and Harness.run with fake streams."""
import json
import os
import random
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ort.llm.harness import (Harness, HarnessOptions, SpeechFilter, apply_voice_prompt,  # noqa: E402
                             coerce_to_schema, convert_tool_choice, loads_loose,
                             parse_arguments, parse_special_block, realtime_tools_to_chat,
                             repair_arguments, sanitize_messages, schema_errors,
                             synthesize_from_schema, VOICE_PROMPT)
from ort.llm.openrouter import Raw  # noqa: E402
from ort.llm.providers import ProviderError  # noqa: E402

ADV = {"type": "function", "name": "advance_step", "description": "Advance to the next task.",
       "parameters": {"type": "object",
                      "properties": {"reason": {"type": "string"},
                                     "confidence": {"type": "number", "default": 1.0}},
                      "required": ["reason"], "additionalProperties": False}}
NOTE = {"type": "function", "name": "log_note", "description": "Log an observation",
        "parameters": {"type": "object",
                       "properties": {"severity": {"type": "string", "enum": ["low", "high"]},
                                      "count": {"type": "integer"},
                                      "flag": {"type": "boolean"}},
                       "required": ["severity"]}}
NAMES = ["advance_step", "log_note"]


# ------------------------------------------------------------------ conversion


def test_realtime_tools_to_chat():
    chat = realtime_tools_to_chat([ADV, {"type": "function", "name": "noparams"},
                                   {"type": "mcp", "server_label": "x"},
                                   {"type": "function", "function": {"name": "already"}}])
    assert [t["function"]["name"] for t in chat] == ["advance_step", "noparams", "already"]
    assert chat[0]["function"]["parameters"]["required"] == ["reason"]
    assert chat[1]["function"]["parameters"] == {"type": "object", "properties": {}}


@pytest.mark.parametrize("tc,exp", [
    ("auto", ("auto", "auto", None)),
    (None, ("auto", "auto", None)),
    ("none", ("none", "none", None)),
    ("required", ("required", "required", None)),
    ({"type": "function", "name": "log_note"},
     ({"type": "function", "function": {"name": "log_note"}}, "named", "log_note")),
    ({"type": "function", "function": {"name": "advance_step"}},
     ({"type": "function", "function": {"name": "advance_step"}}, "named", "advance_step")),
    ({"type": "function", "name": "missing"}, ("auto", "auto", None)),
])
def test_convert_tool_choice(tc, exp):
    assert convert_tool_choice(tc, NAMES) == exp


# ------------------------------------------------------------------ repair / schema


@pytest.mark.parametrize("raw,exp", [
    ('{"reason": "done"}', {"reason": "done"}),
    ("{'reason': 'done',}", {"reason": "done"}),
    ('{reason: "done"}', {"reason": "done"}),
    ('{"reason": "done"', {"reason": "done"}),
    ('{"reason": "do', {"reason": "do"}),
    ('```json\n{"reason": "x"}\n```', {"reason": "x"}),
    ('"{\\"reason\\": \\"x\\"}"', {"reason": "x"}),
    ("", {}),
    ('{"a": True, "b": None, "c": [1, 2,]}', {"a": True, "b": None, "c": [1, 2]}),
    ('Here you go: {"reason": "x"}', {"reason": "x"}),
])
def test_parse_arguments_repairs(raw, exp):
    assert parse_arguments(raw)[0] == exp


def test_coerce_types_enum_defaults_keys():
    schema = NOTE["parameters"]
    v = coerce_to_schema({"Severity": "HIGH", "count": "3", "flag": "yes"}, schema)
    assert v == {"severity": "high", "count": 3, "flag": True}
    v = coerce_to_schema({"reason": "x", "extra": 1}, ADV["parameters"])
    assert v == {"reason": "x", "confidence": 1.0}  # default filled, extra dropped


def test_repair_arguments_never_invalid_json():
    for raw in ["", "{", "not json at all", "{'reason': 5}", "[1,2]", "null", '{"reason": "ok"}']:
        s, errs, _ = repair_arguments(raw, ADV["parameters"])
        assert isinstance(json.loads(s), dict)
    s, errs, _ = repair_arguments("{'reason': 5}", ADV["parameters"])
    assert json.loads(s)["reason"] == "5" and not errs
    s, errs, _ = repair_arguments("{}", ADV["parameters"])
    assert errs  # missing required -> must be re-asked


def test_synthesize_valid():
    for t in (ADV, NOTE):
        v = synthesize_from_schema(t["parameters"])
        assert not schema_errors(v, t["parameters"])


def test_loose_parser_edge_cases():
    assert loads_loose("{a: 'it\\'s', b: [1, {c: 2}]}") == {"a": "it's", "b": [1, {"c": 2}]}
    assert loads_loose('{"x": "unterminated') == {"x": "unterminated"}


# ------------------------------------------------------------------ leak parsing

DSML = ('<｜DSML｜function_calls>\n<｜DSML｜invoke name="advance_step">\n'
        '<｜DSML｜parameter name="reason" string="true">participant is done</｜DSML｜parameter>\n'
        '<｜DSML｜parameter name="confidence" string="false">0.9</｜DSML｜parameter>\n'
        '</｜DSML｜invoke>\n</｜DSML｜function_calls>')
V31 = ('<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>advance_step<｜tool▁sep｜>{"reason": "done"}'
       '<｜tool▁call▁end｜><｜tool▁calls▁end｜>')
V3 = ('<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>log_note\n```json\n'
      '{"severity": "low"}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>')
HERMES = '<tool_call>\n{"name": "advance_step", "arguments": {"reason": "r"}}\n</tool_call>'
QWEN = '<function=log_note>\n<parameter=severity>\nhigh\n</parameter>\n</function>'


@pytest.mark.parametrize("block,name,args", [
    (DSML, "advance_step", {"reason": "participant is done", "confidence": 0.9}),
    (V31, "advance_step", {"reason": "done"}),
    (V3, "log_note", {"severity": "low"}),
    (HERMES, "advance_step", {"reason": "r"}),
    (QWEN, "log_note", {"severity": "high"}),
])
def test_parse_special_block(block, name, args):
    calls = parse_special_block(block, NAMES)
    assert calls == [{"name": name, "arguments": args}]


def run_filter(text, chunks=None, names=NAMES, seed=None):
    f = SpeechFilter(names)
    if chunks is None:
        rnd = random.Random(seed)
        chunks, i = [], 0
        while i < len(text):
            n = rnd.randint(1, 7)
            chunks.append(text[i:i + n])
            i += n
    out = "".join(f.feed(c) for c in chunks) + f.finish()
    return out, f.calls


LEAK_CASES = [
    ("Sure, moving on. " + DSML, "Sure, moving on.", "advance_step"),
    ("OK " + V31 + " bye", "OK bye", "advance_step"),
    ("Noted." + V3, "Noted.", "log_note"),
    ("Let me log that.\n" + HERMES, "Let me log that.", "advance_step"),
    ('Great! ```json\n{"name": "advance_step", "arguments": {"reason": "x"}}\n```',
     "Great!", "advance_step"),
    ('Okay {"name": "log_note", "arguments": {"severity": "low"}} next', "Okay next", "log_note"),
    ('[{"name": "advance_step", "parameters": {"reason": "y"}}]', "", "advance_step"),
    ("I'll go: functions.advance_step({\"reason\": \"z\"})", "I'll go:", "advance_step"),
    ("advance_step(reason='done')", "", "advance_step"),
    ("Sure. functions.log_note:0 {\"severity\": \"high\"}", "Sure.", "log_note"),
]


@pytest.mark.parametrize("text,spoken,name", LEAK_CASES)
@pytest.mark.parametrize("seed", [None, 1, 2, 3])
def test_filter_recovers_leaks_any_chunking(text, spoken, name, seed):
    if seed is None:
        out, calls = run_filter(text, chunks=list(text))  # char by char
    else:
        out, calls = run_filter(text, seed=seed)
    assert out == spoken
    assert [c["name"] for c in calls] == [name]


@pytest.mark.parametrize("text,spoken", [
    ("\n\nHello there.", "Hello there."),
    ("  Hi.\n\n\nHow are you?  ", "Hi.\nHow are you?"),
    ("This is **really** good and `fine`.", "This is really good and fine."),
    ("# Steps\n- one\n- two", "Steps\none\ntwo"),
    ("The value is <5 and a<b.", "The value is <5 and a<b."),
    ("A set {x, y} and {\"foo\": 1}.", "A set {x, y} and {\"foo\": 1}."),
    ("For the first form, fill functionality.", "For the first form, fill functionality."),
    ("Advance steps are fine; advance_step is a name.", "Advance steps are fine; advance_step is a name."),
    ("Stray token<｜end▁of▁sentence｜>", "Stray token"),
    ("-5 degrees", "-5 degrees"),
])
@pytest.mark.parametrize("seed", [None, 7])
def test_filter_hygiene_and_no_false_positives(text, spoken, seed):
    out, calls = run_filter(text, chunks=list(text) if seed is None else None, seed=seed)
    assert out == spoken and calls == []


def test_filter_streams_live_and_holds_only_suspicious():
    f = SpeechFilter(NAMES)
    assert f.feed("Hello there") == "Hello there"
    assert f.feed(" <") == ""  # held: maybe a special token
    assert f.feed("｜DSML") == ""
    assert f.feed("｜function_calls>") == ""
    rest = DSML[len("<｜DSML｜function_calls>"):]
    assert f.feed(rest) == ""
    assert f.feed(" Thanks.") == " Thanks."
    assert f.finish() == ""
    assert f.calls[0]["name"] == "advance_step"


def test_filter_truncated_leak_at_end_is_dropped():
    out, calls = run_filter('Done. <｜DSML｜function_calls>\n<｜DSML｜invoke name="advance_step">',
                            chunks=None, seed=3)
    assert out == "Done."
    assert calls and calls[0]["name"] == "advance_step"


def test_filter_unknown_tool_json_spoken_is_kept_but_fenced_dropped():
    out, calls = run_filter('Here {"name": "Alice"}', chunks=None, seed=1)
    assert out == 'Here {"name": "Alice"}' and calls == []
    out, calls = run_filter('Here ```json\n{"weird": 1}\n``` ok', chunks=None, seed=1)
    assert out == "Here ok"


# ------------------------------------------------------------------ messages / prompt


def test_sanitize_messages_reorders_and_fills():
    msgs = [
        {"role": "developer", "content": "be nice"},
        {"role": "user", "content": [{"type": "input_text", "text": "hi"}]},
        {"role": "assistant", "content": None, "tool_calls": [
            {"id": "c1", "type": "function", "function": {"name": "a", "arguments": {"x": 1}}},
            {"id": "c2", "type": "function", "function": {"name": "b", "arguments": "{}"}}]},
        {"role": "user", "content": "interleaved"},
        {"role": "tool", "tool_call_id": "c1", "content": "ok"},
        {"role": "tool", "tool_call_id": "zzz", "content": "orphan"},
        {"role": "assistant", "content": "  "},
    ]
    out = sanitize_messages(msgs)
    roles = [m["role"] for m in out]
    assert roles == ["system", "user", "assistant", "tool", "tool", "user", "user"]
    assert out[1]["content"] == "hi"
    assert out[2]["tool_calls"][0]["function"]["arguments"] == '{"x": 1}'
    assert out[3]["tool_call_id"] == "c1" and out[3]["content"] == "ok"
    assert out[4]["tool_call_id"] == "c2"  # dangling call gets a placeholder result
    assert "orphan" in out[6]["content"]


def test_voice_prompt_prepends_without_overriding():
    msgs = [{"role": "system", "content": "You are Ada, a moderator."}, {"role": "user", "content": "x"}]
    out = apply_voice_prompt(msgs, True, "allow", True)
    assert out[0]["content"].startswith(VOICE_PROMPT) and out[0]["content"].endswith("You are Ada, a moderator.")
    assert msgs[0]["content"] == "You are Ada, a moderator."  # not mutated
    assert apply_voice_prompt(msgs, False, "allow", True) == msgs
    sup = apply_voice_prompt([{"role": "user", "content": "x"}], True, "suppress", True)
    assert "without speaking first" in sup[0]["content"]
    custom = apply_voice_prompt(msgs, "SPEAK SHORT", "allow", True)
    assert custom[0]["content"].startswith("SPEAK SHORT\n\nYou are Ada")


# ------------------------------------------------------------------ Harness.run


class FakeLLMStream:
    """open_stream replacement: each call pops a script (list of Raw | Exception)."""

    def __init__(self, *scripts):
        self.scripts = list(scripts)
        self.requests = []

    def __call__(self, msgs, tools, tc, max_tokens=None):
        self.requests.append({"messages": msgs, "tools": tools, "tool_choice": tc,
                              "max_tokens": max_tokens})
        script = self.scripts.pop(0)

        async def gen():
            yield Raw("meta", data={"provider": "Fake", "ttft_ms": 10})
            for r in script:
                if isinstance(r, Exception):
                    raise r
                yield r
        return gen()


def text(*parts):
    return [Raw("text", text=p) for p in parts]


def tool(name, args, id="call_x", index=0):
    return [Raw("tool", index=index, id=id, name=name, args="")] + \
        [Raw("tool", index=index, args=args[i:i + 5]) for i in range(0, len(args), 5)]


async def collect(h, fake, msgs=None):
    return [e async for e in h.run(msgs or [{"role": "user", "content": "hi"}], fake)]


@pytest.mark.asyncio
async def test_run_text_and_tool_allow_mode():
    fake = FakeLLMStream(text("\n\nLet me", " move us on.") + tool("advance_step", '{"reason":"done"}')
                         + [Raw("finish", text="tool_calls"), Raw("usage", data={"total_tokens": 5})])
    evs = await collect(Harness([ADV, NOTE], options=HarnessOptions(preamble="allow")), fake)
    assert [e.type for e in evs] == ["text_delta", "text_delta", "tool_call", "done"]
    assert evs[0].text == "Let me"
    tc = evs[2].tool_call
    assert tc.call_id == "call_x" and json.loads(tc.arguments) == {"reason": "done"}  # valid args untouched
    assert evs[-1].usage == {"total_tokens": 5}
    req = fake.requests[0]
    assert req["tool_choice"] == "auto" and req["tools"][0]["function"]["name"] == "advance_step"
    assert req["messages"][0]["role"] == "system"


@pytest.mark.asyncio
async def test_run_preamble_suppress_drops_text_before_tool():
    fake = FakeLLMStream(text("Let me move us on.") + tool("advance_step", '{"reason":"d"}'))
    evs = await collect(Harness([ADV], options=HarnessOptions(preamble="suppress")), fake)
    assert [e.type for e in evs] == ["tool_call", "done"]
    assert evs[-1].meta["suppressed_text"] == "Let me move us on."


@pytest.mark.asyncio
async def test_run_preamble_suppress_keeps_text_without_tool():
    fake = FakeLLMStream(text("The search box is top right."))
    evs = await collect(Harness([ADV], options=HarnessOptions(preamble="suppress")), fake)
    assert [e.type for e in evs] == ["text_delta", "done"]


@pytest.mark.asyncio
async def test_run_leaked_dsml_becomes_tool_call():
    fake = FakeLLMStream(text("Great, next task. ", DSML[:30], DSML[30:]))
    evs = await collect(Harness([ADV]), fake)
    assert "".join(e.text for e in evs if e.type == "text_delta") == "Great, next task."
    calls = [e.tool_call for e in evs if e.type == "tool_call"]
    assert len(calls) == 1 and json.loads(calls[0].arguments)["reason"] == "participant is done"
    assert evs[-1].meta["leaks_recovered"] == 1


@pytest.mark.asyncio
async def test_run_native_and_leak_duplicate_deduped():
    fake = FakeLLMStream(text(V31) + tool("advance_step", '{"reason": "done"}'))
    evs = await collect(Harness([ADV]), fake)
    assert len([e for e in evs if e.type == "tool_call"]) == 1


@pytest.mark.asyncio
async def test_run_invalid_args_reask_fixes():
    fake = FakeLLMStream(tool("log_note", '{"severity": "catastrophic"}'),
                         tool("log_note", '{"severity": "high"}', id="call_y"))
    evs = await collect(Harness([NOTE]), fake)
    calls = [e.tool_call for e in evs if e.type == "tool_call"]
    assert json.loads(calls[0].arguments) == {"severity": "high"}
    assert evs[-1].meta["reasked"] == 1
    r = fake.requests[1]
    assert r["tool_choice"] == {"type": "function", "function": {"name": "log_note"}}
    assert r["max_tokens"] == 200 and "invalid arguments" in r["messages"][-1]["content"]


@pytest.mark.asyncio
async def test_run_invalid_args_reask_fails_synthesizes_valid():
    fake = FakeLLMStream(tool("advance_step", "{}"), text("no"))
    evs = await collect(Harness([ADV]), fake)
    calls = [e.tool_call for e in evs if e.type == "tool_call"]
    args = json.loads(calls[0].arguments)
    assert not schema_errors(args, ADV["parameters"])
    assert evs[-1].meta["synthesized"] == 1


@pytest.mark.asyncio
async def test_run_cheap_repair_no_reask():
    fake = FakeLLMStream(tool("log_note", "{'severity': 'HIGH', count: '2'"))
    evs = await collect(Harness([NOTE]), fake)
    calls = [e.tool_call for e in evs if e.type == "tool_call"]
    assert json.loads(calls[0].arguments) == {"severity": "high", "count": 2}
    assert len(fake.requests) == 1


@pytest.mark.asyncio
async def test_run_tool_choice_none_drops_calls_and_leaks():
    fake = FakeLLMStream(text("Okay. ", V31) + tool("advance_step", '{"reason":"x"}'))
    evs = await collect(Harness([ADV], tool_choice="none"), fake)
    assert [e.type for e in evs] == ["text_delta", "done"]
    assert evs[0].text == "Okay."
    # tool_choice:"none" is not sent (several providers 404 on it); without tool history, neither are tools
    assert fake.requests[0].get("tool_choice") is None and not fake.requests[0].get("tools")


@pytest.mark.asyncio
async def test_run_required_without_call_reasks():
    fake = FakeLLMStream(text("I think we should move on."),
                         tool("advance_step", '{"reason":"r"}'))
    evs = await collect(Harness([ADV, NOTE], tool_choice="required"), fake)
    assert [e.type for e in evs] == ["tool_call", "done"]  # text held & dropped
    assert fake.requests[1]["tool_choice"] == "required"


@pytest.mark.asyncio
async def test_run_named_downgrades_when_unsupported():
    fake = FakeLLMStream([ProviderError("HTTP 404: no endpoints support tool_choice", status=404)],
                         tool("log_note", '{"severity":"low"}'))
    evs = await collect(Harness([ADV, NOTE], tool_choice={"type": "function", "name": "log_note"}), fake)
    assert [e.type for e in evs] == ["tool_call", "done"]
    r = fake.requests[1]
    assert r["tool_choice"] == "auto" and [t["function"]["name"] for t in r["tools"]] == ["log_note"]


@pytest.mark.asyncio
async def test_run_provider_error_yields_error_event():
    fake = FakeLLMStream([ProviderError("all providers failed", status=503)])
    evs = await collect(Harness([ADV]), fake)
    assert [e.type for e in evs] == ["error"] and "all providers failed" in evs[0].error


@pytest.mark.asyncio
async def test_run_no_tools_plain_text():
    fake = FakeLLMStream(text("Hi ", "there!"))
    evs = await collect(Harness([]), fake)
    assert "".join(e.text for e in evs if e.type == "text_delta") == "Hi there!"
    assert fake.requests[0]["tools"] is None
    assert evs[-1].meta["text"] == "Hi there!"


@pytest.mark.asyncio
async def test_run_unknown_tool_dropped():
    fake = FakeLLMStream(tool("delete_everything", "{}"))
    evs = await collect(Harness([ADV]), fake)
    assert [e.type for e in evs] == ["done"]
    assert evs[-1].meta["dropped_tool_calls"] == ["delete_everything"]


@pytest.mark.asyncio
async def test_run_retries_an_empty_completion_once():
    # 200 OK with no content and no tool call: asked once more, the second answer is used.
    fake = FakeLLMStream([Raw("finish", text="stop")], text("Hello there."))
    evs = await collect(Harness([ADV], "none"), fake)
    assert [e.type for e in evs] == ["text_delta", "done"] and evs[0].text == "Hello there."
    assert len(fake.requests) == 2
    # Still empty the second time: finishes (empty) instead of looping.
    fake = FakeLLMStream([Raw("finish", text="stop")], [Raw("finish", text="stop")])
    evs = await collect(Harness([ADV]), fake)
    assert [e.type for e in evs] == ["done"] and len(fake.requests) == 2


@pytest.mark.asyncio
async def test_run_ends_a_system_only_history_with_a_user_turn():
    from ort.llm.harness import TURN_NUDGE
    fake = FakeLLMStream(text("Welcome."), text("Okay."), text("Hi."))
    await collect(Harness([ADV], "none"), fake, [{"role": "system", "content": "Say: Welcome."},
                                                 {"role": "system", "content": "[STEP] {}"}])
    assert fake.requests[0]["messages"][-1] == {"role": "user", "content": TURN_NUDGE}
    await collect(Harness([ADV]), fake, [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "Hello."}])
    assert fake.requests[1]["messages"][-1] == {"role": "user", "content": TURN_NUDGE}
    await collect(Harness([ADV]), fake, [{"role": "system", "content": "x"}, {"role": "user", "content": "hi"}])
    assert fake.requests[2]["messages"][-1] == {"role": "user", "content": "hi"}


@pytest.mark.asyncio
async def test_run_tool_choice_none_flattens_tool_history():
    from ort.llm.harness import flatten_tool_history
    hist = [
        {"role": "system", "content": "Moderate."},
        {"role": "user", "content": "I'm done."},
        {"role": "assistant", "content": "", "tool_calls": [{"id": "c1", "type": "function",
                                                             "function": {"name": "advance_step", "arguments": '{"reason":"done"}'}}]},
        {"role": "tool", "tool_call_id": "c1", "content": '{"ok":true}'},
        {"role": "system", "content": "Say exactly: Thank you so much."},
    ]
    flat = flatten_tool_history(hist)
    assert not any(m.get("tool_calls") or m.get("role") == "tool" for m in flat)
    assert "advance_step" in flat[2]["content"] and "[tool result]" in flat[3]["content"]
    fake = FakeLLMStream(text("Thank you so much."))
    await collect(Harness([ADV], tool_choice="none"), fake, hist)
    req = fake.requests[0]
    assert not req.get("tools") and req.get("tool_choice") is None
    assert not any(m.get("tool_calls") or m.get("role") == "tool" for m in req["messages"])
    assert req["messages"][-1]["role"] == "user"
