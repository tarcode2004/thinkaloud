"""Offline tests: verbatim guard, smart preamble gate, latest-instruction detection,
cache-friendly layout and the prompt-size-aware scoreboard."""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ort.llm.harness import (Harness, HarnessOptions, PreambleGate, PrefixMemory,  # noqa: E402
                             VerbatimGuard, VerbatimTarget, apply_layout, find_verbatim_target,
                             split_instructions, trim_history, wants_silent_tool)
from ort.llm.openrouter import Raw  # noqa: E402
from ort.llm.providers import Scoreboard  # noqa: E402

Q = "How easy or difficult was this task, on a scale from 1 to 7?"


def guard(chunks, target=Q, strict=True, allow=True):
    g = VerbatimGuard(VerbatimTarget(target, strict, allow))
    out = "".join(g.feed(c) for c in chunks) + g.finish()
    return out, g


# ------------------------------------------------------------------ verbatim guard


def test_guard_passes_exact_text_streaming():
    pieces = [Q[i:i + 7] for i in range(0, len(Q), 7)]
    g = VerbatimGuard(VerbatimTarget(Q))
    outs = [g.feed(p) for p in pieces]
    assert sum(1 for o in outs if o) >= len(pieces) - 3  # streams, does not wait for the end
    assert "".join(outs) + g.finish() == Q and not g.repaired


def test_guard_repairs_paraphrased_tail():
    out, g = guard(["How easy or difficult was ", "it for you?"])
    assert out == Q and g.repaired


def test_guard_keeps_short_transition():
    out, g = guard(["Okay.", " How easy or difficult was this task, on a scale from 1 to 7?"])
    assert out == "Okay. " + Q and g.transition == "Okay."


def test_guard_drops_non_transition_preamble_in_same_chunk():
    out, g = guard(["Here we go. " + Q])
    assert out == Q and g.repaired


def test_guard_gives_up_quickly_on_non_transition_start():
    # low latency: a reply that starts with non-transition words is not held back
    g = VerbatimGuard(VerbatimTarget(Q))
    assert g.feed("Sure thing! Here we go. ") == "Sure thing! Here we go. " and g.state == "off"


def test_guard_completes_truncated_target():
    out, g = guard(["How easy or"])
    assert out == Q and g.repaired


def test_guard_drops_additions_after_target_when_strict():
    out, _ = guard([Q + " Take your time, there is no wrong answer."])
    assert out == Q
    out, _ = guard([Q + " Take your time."], strict=False)
    assert out == Q + " Take your time."


def test_guard_leaves_unrelated_reply_alone():
    out, g = guard(["Sorry, could you say that again? ", "I did not catch it."])
    assert out == "Sorry, could you say that again? I did not catch it." and g.state == "off"


def test_guard_numbers_written_out_are_restored():
    out, _ = guard(["How easy or difficult was this task, on a scale from one to seven?"])
    assert out == Q


def test_guard_unicode_german():
    t = "Wie einfach oder schwierig war diese Aufgabe auf einer Skala von 1 bis 7?"
    out, _ = guard(["Okay. Wie einfach oder schwierig war diese Aufgabe für Sie?"], target=t)
    assert out == "Okay. " + t


# ------------------------------------------------------------------ target detection


def test_target_from_tool_result_brief():
    brief = {"ok": True, "brief": {"say_verbatim": "Please open the settings page.",
                                   "your_job": "Read it."}}
    msgs = [{"role": "user", "content": "ready"},
            {"role": "assistant", "content": None,
             "tool_calls": [{"id": "c", "type": "function",
                             "function": {"name": "complete_step", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "c", "content": json.dumps(brief)}]
    t = find_verbatim_target(msgs)
    assert t and t.text == "Please open the settings page." and t.allow_transition


def test_target_translation_disables_guard():
    brief = {"say_verbatim": "Rate it.", "translate_to": "German"}
    assert find_verbatim_target([{"role": "tool", "content": json.dumps(brief)}]) is None


def test_target_from_now_instruction_and_quotes():
    msgs = [{"role": "system", "content": '# NOW\nSay exactly: "Thanks, that is all for today."'}]
    assert find_verbatim_target(msgs).text == "Thanks, that is all for today."
    msgs = [{"role": "system", "content": 'Read this verbatim: “Bitte öffnen Sie die App.”'}]
    assert find_verbatim_target(msgs).text == "Bitte öffnen Sie die App."


def test_conditional_dictation_is_not_enforced():
    msgs = [{"role": "system", "content":
             'If they ask about the purpose, say exactly: "I can tell you more at the end."'}]
    assert find_verbatim_target(msgs) is None


def test_target_is_stale_after_model_spoke():
    msgs = [{"role": "system", "content": 'Say exactly: "Hello."'},
            {"role": "assistant", "content": "Hello."},
            {"role": "user", "content": "Hi, what now?"}]
    assert find_verbatim_target(msgs) is None


def test_silent_tool_detection():
    assert wants_silent_tool([{"role": "system", "content":
                               "Call record_answer now, without saying anything first."}])
    assert not wants_silent_tool([{"role": "system", "content": "Reply briefly."}])


# ------------------------------------------------------------------ preamble gate


def test_gate_releases_filler_followed_by_content():
    g = PreambleGate()
    assert g.feed("Okay.") == ""
    assert g.feed(" The next task is about search.") == "Okay. The next task is about search."


def test_gate_drops_filler_before_tool():
    g = PreambleGate()
    assert g.feed("Got it, let me check.") == ""
    g.on_tool()
    assert g.finish() == "" and g.dropped == "Got it, let me check."


def test_gate_releases_lone_filler_at_end():
    g = PreambleGate()
    assert g.feed("Mm-hm.") == "" and g.finish() == "Mm-hm."


def test_gate_does_not_hold_real_sentences():
    g = PreambleGate()
    assert g.feed("That's completely fine") == "That's completely fine"


def fake_open(*scripts):
    scripts = list(scripts)
    reqs = []

    def open_stream(msgs, tools, tc, max_tokens=None):
        reqs.append(msgs)
        script = scripts.pop(0)

        async def gen():
            yield Raw("meta", data={"provider": "Fake"})
            for r in script:
                yield r
        return gen()
    open_stream.reqs = reqs
    return open_stream


def T(*parts):
    return [Raw("text", text=p) for p in parts]


def CALL(name, args='{"reason": "done"}'):
    return [Raw("tool", index=0, id="c1", name=name, args=args), Raw("finish", text="tool_calls")]


ADV = {"type": "function", "name": "advance_step", "description": "next",
       "parameters": {"type": "object", "properties": {"reason": {"type": "string"}},
                      "required": ["reason"]}}


async def _run(h, op, msgs=None):
    return [e async for e in h.run(msgs or [{"role": "user", "content": "I'm done."}], op)]


@pytest.mark.asyncio
async def test_smart_preamble_end_to_end_drops_filler_keeps_real_speech():
    evs = await _run(Harness([ADV]), fake_open(T("Got it.") + CALL("advance_step")))
    assert [e.type for e in evs] == ["tool_call", "done"]
    assert evs[-1].meta["suppressed_text"] == "Got it."
    evs = await _run(Harness([ADV]), fake_open(T("That's completely fine, ", "let's skip it.")
                                               + CALL("advance_step")))
    assert "".join(e.text for e in evs if e.type == "text_delta") == \
        "That's completely fine, let's skip it."


@pytest.mark.asyncio
async def test_silent_instruction_forces_suppress_for_that_turn():
    msgs = [{"role": "system", "content": "Moderate.\n" * 50 + "\n# NOW\nCall advance_step now, "
             "without saying anything first."}, {"role": "user", "content": "done"}]
    evs = await _run(Harness([ADV]), fake_open(T("Thanks for sharing that with me.")
                                               + CALL("advance_step")), msgs)
    assert [e.type for e in evs] == ["tool_call", "done"]
    assert evs[-1].meta["preamble_policy"] == "suppress"


@pytest.mark.asyncio
async def test_verbatim_guard_end_to_end_from_tool_result():
    brief = json.dumps({"brief": {"say_verbatim": Q}})
    msgs = [{"role": "user", "content": "ok"},
            {"role": "assistant", "content": None, "tool_calls": [
                {"id": "c", "type": "function", "function": {"name": "advance_step",
                                                             "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "c", "content": brief}]
    evs = await _run(Harness([ADV]), fake_open(T("Thanks. How easy or difficult ",
                                                 "did you find it?")), msgs)
    assert "".join(e.text for e in evs if e.type == "text_delta") == "Thanks. " + Q
    assert evs[-1].meta["verbatim"]["repaired"] is True
    evs = await _run(Harness([ADV], options=HarnessOptions(verbatim_guard="off")),
                     fake_open(T("How easy or difficult did you find it?")), msgs)
    assert "".join(e.text for e in evs if e.type == "text_delta") == \
        "How easy or difficult did you find it?"


# ------------------------------------------------------------------ layout


BASE = "# Role\nYou are a moderator.\n" + "Be neutral. " * 100


def test_split_now_marker():
    stable, suf = split_instructions(BASE + "\n\n# NOW\nAsk question two.")
    assert stable == BASE.rstrip() and suf == "# NOW\nAsk question two."


def test_split_by_prefix_memory():
    mem = PrefixMemory()
    mem.remember(BASE)
    stable, suf = split_instructions(BASE + "\nExtra for this reply only.", mem)
    assert stable == BASE and suf == "Extra for this reply only."


def test_apply_layout_places_suffix_after_history():
    msgs = [{"role": "system", "content": BASE + "\n\n# NOW\nDo X."},
            {"role": "assistant", "content": "Hi"}, {"role": "user", "content": "a"},
            {"role": "user", "content": "b"}]
    out, split = apply_layout(msgs, "tail", None)
    assert split and [m["role"] for m in out] == ["system", "assistant", "user", "user", "system"]
    assert out[-1]["content"] == "# NOW\nDo X."


def test_apply_layout_after_tool_result_appends_and_harness_nudges():
    h = Harness([{"type": "function", "name": "f", "parameters": {}}])
    msgs = [{"role": "system", "content": BASE + "\n\n# NOW\nSay the brief."},
            {"role": "user", "content": "go"},
            {"role": "assistant", "content": None, "tool_calls": [
                {"id": "c", "type": "function", "function": {"name": "f", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "c", "content": "{}"}]
    out, info = h.prepare(msgs)
    assert [m["role"] for m in out][-3:] == ["tool", "system", "user"]
    assert info["layout_split"]


def test_trim_history_never_orphans_tool_results():
    msgs = [{"role": "system", "content": "s"}, {"role": "user", "content": "u0"},
            {"role": "assistant", "content": None, "tool_calls": [{"id": "c"}]},
            {"role": "tool", "tool_call_id": "c", "content": "r"}]
    msgs += [{"role": "user", "content": f"u{i}"} for i in range(1, 8)]
    out = trim_history(msgs, frac=0.2)
    assert out[1]["role"] == "system" and out[2]["role"] != "tool"


# ------------------------------------------------------------------ scoreboard vs prompt size


def test_scoreboard_learns_slope_and_scales_hedge_delay():
    sb = Scoreboard(["p"], cache_path=False)
    for _ in range(4):
        for k in (1, 8, 16):
            sb.record_success("p", 400 + 60 * k, tokens=k * 1000)
    assert 50 < sb.slope("p") < 70
    assert abs(sb.expected_ms("p", 16000) - (400 + 960)) < 120
    assert sb.hedge_delay_ms("p", 16000) > sb.hedge_delay_ms("p", 1000) + 600


def test_cached_tokens_lower_expected_ttft():
    sb = Scoreboard(["p"], cache_path=False)
    assert sb.expected_ms("p", 16000, cached=15000) < sb.expected_ms("p", 16000) - 400


def test_first_token_timeout_grows_with_prompt():
    assert Scoreboard.first_token_timeout_ms(0) == 8000
    assert Scoreboard.first_token_timeout_ms(16000) == 12000


def test_ranking_depends_on_prompt_size():
    sb = Scoreboard(["fast_prefill", "fast_short"], cache_path=False)
    for _ in range(4):
        for k in (1, 16):
            sb.record_success("fast_prefill", 600 + 15 * k, tokens=k * 1000)
            sb.record_success("fast_short", 400 + 130 * k, tokens=k * 1000)
    assert sb.ranked(tokens=500)[0] == "fast_short"
    assert sb.ranked(tokens=16000)[0] == "fast_prefill"


def test_old_cache_file_without_new_fields_loads(tmp_path):
    p = tmp_path / "providers.json"
    p.write_text(json.dumps({"version": 1, "providers": {"a": {"ewma_ms": 700, "n": 5}}}))
    sb = Scoreboard(["a"], cache_path=p)
    assert sb.expected_ms("a", 4000) > 700


def test_guard_enforce_replaces_reply_that_ignores_dictation():
    g = VerbatimGuard(VerbatimTarget("Thanks. How did that go for you?"), enforce=True)
    out = g.feed("Mm-hm, take your time.") + g.finish()
    assert out == "Thanks. How did that go for you?" and g.repaired


@pytest.mark.asyncio
async def test_enforce_only_for_system_dictations():
    msgs = [{"role": "system", "content": "You moderate."}, {"role": "assistant", "content": "Hi."},
            {"role": "user", "content": "So I'm on the page."},
            {"role": "system", "content": 'Say exactly: "Thanks. How did that go for you?"'}]
    evs = await _run(Harness([ADV], options=HarnessOptions(verbatim_guard="enforce")),
                     fake_open(T("Mm-hm.")), msgs)
    assert "".join(e.text for e in evs if e.type == "text_delta") == "Thanks. How did that go for you?"
    evs = await _run(Harness([ADV], options=HarnessOptions(verbatim_guard="repair")),
                     fake_open(T("Mm-hm.")), msgs)
    assert "".join(e.text for e in evs if e.type == "text_delta") == "Mm-hm."


def test_instructed_tool_detection():
    from ort.llm.harness import instructed_tool
    names = ["set_task_outcome", "record_answer", "get_current_step"]
    base = [{"role": "system", "content": "You moderate."}, {"role": "user", "content": "done"}]
    m = base + [{"role": "system", "content": "# NOW\nCall set_task_outcome now with your judgement."}]
    assert instructed_tool(m, names) == "set_task_outcome"
    m = base + [{"role": "system", "content": '# NOW\nIf it answers the question, call record_answer '
                                              'for question_id "q1" now. Otherwise reply.'}]
    assert instructed_tool(m, names) is None
    m = base + [{"role": "system", "content": "Never call set_task_outcome now."}]
    assert instructed_tool(m, names) is None


@pytest.mark.asyncio
async def test_instructed_tool_reask_replaces_wrong_call():
    OUT = {"type": "function", "name": "set_task_outcome", "description": "",
           "parameters": {"type": "object", "properties": {"outcome": {"type": "string"}},
                          "required": ["outcome"]}}
    GET = {"type": "function", "name": "get_current_step", "description": "",
           "parameters": {"type": "object", "properties": {}}}
    msgs = [{"role": "system", "content": "You moderate."}, {"role": "user", "content": "done"},
            {"role": "system", "content": "Call set_task_outcome now. Do not say anything."}]
    op = fake_open([Raw("tool", index=0, id="a", name="get_current_step", args="{}")],
                   [Raw("tool", index=0, id="b", name="set_task_outcome", args='{"outcome":"success"}')])
    evs = await _run(Harness([OUT, GET]), op, msgs)
    calls = [e.tool_call.name for e in evs if e.type == "tool_call"]
    assert calls == ["set_task_outcome"]
    assert evs[-1].meta["instructed_tool"] == "set_task_outcome"
    assert evs[-1].meta["dropped_tool_calls"] == ["get_current_step"]


def test_guard_repairs_early_divergence_numbers_as_words():
    t = "Question 3 of 10: In the last 30 days, how many times did you buy shoes online?"
    out, g = guard(["Question three of ten: In the last thirty days, how many times did you buy shoes online?"],
                   target=t)
    assert out == t and g.repaired
    out, g = guard(["Okay. Question three of ten: In the last thirty days, how many"], target=t)
    assert out == "Okay. " + t
