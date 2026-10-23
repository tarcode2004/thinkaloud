"""Offline error-handling tests for the OpenRouter LLM: fake HTTP streams per provider
(httpx.MockTransport), no network.  Covers 429/5xx everywhere, mid-stream disconnects,
stalls, total timeouts, malformed SSE, tool-compat 404s, context-length errors, 402, and
cancellation during hedging (no HTTP stream or task may leak)."""
import asyncio
import contextlib
import json
import os
import sys
import time

import httpx
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ort.llm.openrouter import OpenRouterClient, OpenRouterLLM  # noqa: E402

ADV = {"type": "function", "name": "advance_step", "description": "next task",
       "parameters": {"type": "object", "properties": {"reason": {"type": "string"}},
                      "required": ["reason"]}}


def chunk(delta=None, finish=None, provider="P", usage=None):
    obj = {"id": "g", "provider": provider, "object": "chat.completion.chunk",
           "choices": [{"index": 0, "delta": delta or {}, "finish_reason": finish}]}
    if usage:
        obj["usage"] = usage
    return "data: " + json.dumps(obj) + "\n\n"


def words(*ws, provider="P", done=True, usage=None):
    parts = [chunk({"content": w}, provider=provider) for w in ws]
    if done:
        parts += [chunk({}, finish="stop", provider=provider),
                  chunk({}, usage=usage or {"prompt_tokens": 100, "completion_tokens": 5},
                        provider=provider), "data: [DONE]\n\n"]
    return parts


class Body(httpx.AsyncByteStream):
    """Scripted body: items are str (sent), float (sleep seconds) or Exception (raised)."""

    def __init__(self, items, registry=None):
        self.items = items
        self.closed = False
        if registry is not None:
            registry.append(self)

    async def __aiter__(self):
        for it in self.items:
            if isinstance(it, (int, float)):
                await asyncio.sleep(it)
            elif isinstance(it, Exception):
                raise it
            else:
                yield it.encode()

    async def aclose(self):
        self.closed = True


class Router:
    """MockTransport handler: behaviour per pinned provider (body.provider.order[0])."""

    def __init__(self, spec):
        self.spec = spec  # provider -> callable(body) -> httpx.Response | list of such (per call)
        self.calls = []
        self.bodies = []

    def __call__(self, req):
        body = json.loads(req.content)
        p = (body.get("provider") or {}).get("order", [None])[0]
        self.calls.append((p, body))
        r = self.spec[p]
        if isinstance(r, list):
            r = r.pop(0) if len(r) > 1 else r[0]
        return r(body, self) if callable(r) else r


def ok(*ws, delay=0.0, provider="P"):
    return lambda body, rt: httpx.Response(200, stream=Body(([delay] if delay else [])
                                                             + words(*ws, provider=provider),
                                                             rt.bodies))


def status(code, msg, retry_after=None):
    def f(body, rt):
        h = {"retry-after": str(retry_after)} if retry_after else {}
        return httpx.Response(code, headers=h, json={"error": {"message": msg, "code": code}})
    return f


def stream(items):
    return lambda body, rt: httpx.Response(200, stream=Body(list(items), rt.bodies))


def make(tmp_path, spec, providers=None, **cfg):
    rt = Router(spec)
    client = OpenRouterClient("test-key", transport=httpx.MockTransport(rt))
    llm = OpenRouterLLM({"providers": providers or list(spec), "cache_path": str(tmp_path / "p.json"),
                         "hedge_delay_ms": cfg.pop("hedge_delay_ms", 5000), **cfg}, client=client)
    return llm, rt


async def run(llm, msgs=None, tools=(), tool_choice="auto", **kw):
    msgs = msgs or [{"role": "user", "content": "hello"}]
    async with contextlib.aclosing(llm.stream(msgs, list(tools), tool_choice, **kw)) as s:
        return [e async for e in s]


def spoken(evs):
    return "".join(e.text for e in evs if e.type == "text_delta")


# ------------------------------------------------------------------ provider errors


@pytest.mark.asyncio
async def test_all_providers_429_gives_clear_error_and_cools_down(tmp_path):
    llm, rt = make(tmp_path, {"a": status(429, "rate-limited upstream", 30),
                              "b": status(429, "rate-limited upstream"),
                              "c": status(429, "rate-limited upstream")})
    evs = await run(llm)
    await llm.aclose()
    assert [e.type for e in evs] == ["error"]
    assert "rate-limited" in evs[0].error and evs[0].meta["code"] == "rate_limited"
    assert sorted(p for p, _ in rt.calls) == ["a", "b", "c"]
    assert not any(llm.scoreboard.available(p) for p in "abc")


@pytest.mark.asyncio
async def test_all_providers_5xx(tmp_path):
    llm, rt = make(tmp_path, {"a": status(502, "bad gateway"), "b": status(503, "unavailable")})
    evs = await run(llm)
    await llm.aclose()
    assert evs[-1].type == "error" and "503" in evs[-1].error or "502" in evs[-1].error
    assert len(rt.calls) == 2


@pytest.mark.asyncio
async def test_5xx_then_success_fails_over(tmp_path):
    llm, rt = make(tmp_path, {"a": status(500, "oops"), "b": ok("Hello", " there.")})
    evs = await run(llm)
    await llm.aclose()
    assert spoken(evs) == "Hello there."
    assert evs[-1].meta["provider_slug"] == "b" and evs[-1].meta["failovers"] == 1


@pytest.mark.asyncio
async def test_402_is_account_level_clear_message_no_failover(tmp_path):
    llm, rt = make(tmp_path, {"a": status(402, "Insufficient credits"), "b": ok("never")})
    evs = await run(llm)
    await llm.aclose()
    assert [e.type for e in evs] == ["error"]
    assert evs[0].meta["code"] == "insufficient_credits"
    assert "credits" in evs[0].error and "openrouter.ai/settings/credits" in evs[0].error
    assert [p for p, _ in rt.calls] == ["a"]  # no point trying other providers
    assert llm.scoreboard.available("a")  # not the provider's fault: no cooldown


# ------------------------------------------------------------------ mid-stream failures


@pytest.mark.asyncio
async def test_midstream_disconnect_after_text_stops_cleanly_without_repeat(tmp_path):
    items = words("Hello there, ", "this is a long ", done=False) + \
        [httpx.ReadError("connection reset")]
    llm, rt = make(tmp_path, {"a": stream(items), "b": ok("SHOULD NOT BE SPOKEN")})
    evs = await run(llm)
    await llm.aclose()
    assert evs[-1].type == "done"
    assert evs[-1].meta["finish_reason"] == "interrupted"
    assert "ReadError" in evs[-1].meta["stream_error"]
    assert spoken(evs) == "Hello there, this is a long"
    assert len(rt.calls) == 1  # never re-requested: nothing is spoken twice
    assert llm.scoreboard.stats["a"].errors == 1


@pytest.mark.asyncio
async def test_midstream_disconnect_before_anything_spoken_retries(tmp_path):
    # "Got it." is a filler that the smart preamble gate holds while tools are available;
    # the stream dies before anything reached the listener -> one clean retry.
    items = words("Got it.", done=False) + [httpx.RemoteProtocolError("peer closed")]
    llm, rt = make(tmp_path, {"a": [stream(items), ok("Sure, the next task is ready.")],
                              "b": ok("Sure, the next task is ready.")})
    evs = await run(llm, tools=[ADV])
    await llm.aclose()
    assert spoken(evs) == "Sure, the next task is ready."
    assert evs[-1].meta.get("midstream_retried") is True
    assert len(rt.calls) == 2


@pytest.mark.asyncio
async def test_stall_after_first_token_times_out(tmp_path):
    items = words("Hello", done=False) + [30.0] + words(" late", done=True)
    llm, rt = make(tmp_path, {"a": stream(items)}, idle_timeout_s=0.2)
    t0 = time.perf_counter()
    evs = await run(llm)
    dt = time.perf_counter() - t0
    await llm.aclose()
    assert dt < 2.0
    assert spoken(evs) == "Hello"
    assert evs[-1].type == "done" and evs[-1].meta["finish_reason"] == "interrupted"
    assert "stalled" in evs[-1].meta["stream_error"]
    assert rt.bodies[0].closed
    assert "stalled" in (llm.scoreboard.stats["a"].last_error or "")


@pytest.mark.asyncio
async def test_total_timeout(tmp_path):
    items = []
    for i in range(400):
        items += [0.02, chunk({"content": f"w{i} "})]
    llm, rt = make(tmp_path, {"a": stream(items)}, total_timeout_s=0.4, idle_timeout_s=5)
    t0 = time.perf_counter()
    evs = await run(llm)
    dt = time.perf_counter() - t0
    await llm.aclose()
    assert 0.3 < dt < 1.5
    assert evs[-1].type == "done" and "total timeout" in evs[-1].meta["stream_error"]
    assert spoken(evs).startswith("w0 w1")
    assert rt.bodies[0].closed


@pytest.mark.asyncio
async def test_total_timeout_before_first_token_is_error(tmp_path):
    llm, rt = make(tmp_path, {"a": stream([30.0] + words("x"))}, total_timeout_s=0.3)
    evs = await run(llm)
    await llm.aclose()
    assert [e.type for e in evs] == ["error"] and "timeout" in evs[0].error


# ------------------------------------------------------------------ malformed SSE


@pytest.mark.asyncio
async def test_malformed_html_200_fails_over(tmp_path):
    html = ["<html>\n", "<body>Bad gateway</body>\n", "</html>\n", "more\n"]
    llm, rt = make(tmp_path, {"a": stream(html), "b": ok("Fine.")})
    evs = await run(llm)
    await llm.aclose()
    assert spoken(evs) == "Fine." and evs[-1].meta["provider_slug"] == "b"


@pytest.mark.asyncio
async def test_bad_json_events_before_token_fail_over(tmp_path):
    bad = ["data: {not json\n\n", "data: {\"choices\": [\n\n", "data: ]]]\n\n", "data: [DONE]\n\n"]
    llm, rt = make(tmp_path, {"a": stream(bad), "b": ok("Recovered.")})
    evs = await run(llm)
    await llm.aclose()
    assert spoken(evs) == "Recovered."


@pytest.mark.asyncio
async def test_empty_200_stream_fails_over(tmp_path):
    llm, rt = make(tmp_path, {"a": stream([]), "b": ok("Here.")})
    evs = await run(llm)
    await llm.aclose()
    assert spoken(evs) == "Here."


@pytest.mark.asyncio
async def test_garbage_after_first_token_is_ignored(tmp_path):
    items = words("One ", done=False) + ["data: {broken\n\n", "event: ping\n\n"] + words("two.")
    llm, rt = make(tmp_path, {"a": stream(items)})
    evs = await run(llm)
    await llm.aclose()
    assert spoken(evs) == "One two." and evs[-1].meta["finish_reason"] == "stop"


# ------------------------------------------------------------------ tool-compat 404


COMPAT = "No endpoints found for deepseek/deepseek-v4-flash. Every candidate endpoint was " \
         "removed during routing: Filter by Tool Compatibility removed x"


def tool_ok(body, rt):
    parts = [chunk({"tool_calls": [{"index": 0, "id": "c1", "type": "function",
                                    "function": {"name": "advance_step",
                                                 "arguments": "{\"reason\": \"done\"}"}}]}),
             chunk({}, finish="tool_calls"), "data: [DONE]\n\n"]
    return httpx.Response(200, stream=Body(parts, rt.bodies))


@pytest.mark.asyncio
async def test_tool_compat_404_excludes_provider_for_that_feature_and_remembers(tmp_path):
    def a(body, rt):
        if body.get("tool_choice") not in (None, "auto"):
            return status(404, COMPAT)(body, rt)
        return tool_ok(body, rt)
    # 'z' is unknown to KNOWN_UNSUPPORTED, so the exclusion must be learned
    llm, rt = make(tmp_path, {"z": a, "y": tool_ok}, providers=["z", "y"], sticky=False)
    llm.scoreboard.stats["z"].ewma_ms = 100.0  # z is the fastest
    evs = await run(llm, tools=[ADV], tool_choice="required")
    assert [e.type for e in evs][-2:] == ["tool_call", "done"]
    assert [p for p, _ in rt.calls] == ["z", "y"]
    assert not llm.scoreboard.supports("z", "tool_choice:required")
    assert llm.scoreboard.stats["z"].cooldown_until == 0  # not a health problem
    rt.calls.clear()
    await run(llm, tools=[ADV], tool_choice="required")
    assert [p for p, _ in rt.calls] == ["y"]  # remembered: z skipped
    rt.calls.clear()
    llm.scoreboard.stats["y"].ewma_ms = 5000.0  # (the fake y answered instantly)
    await run(llm, tools=[ADV], tool_choice="auto")
    assert [p for p, _ in rt.calls] == ["z"]  # z still serves auto
    await llm.aclose()
    # persisted
    data = json.loads((tmp_path / "p.json").read_text())
    assert "tool_choice:required" in data["providers"]["z"]["unsupported"]


@pytest.mark.asyncio
async def test_known_unsupported_seed_skips_parasail_for_named_tool_choice(tmp_path):
    llm, rt = make(tmp_path, {"parasail": tool_ok, "azure": tool_ok})
    await run(llm, tools=[ADV], tool_choice={"type": "function", "name": "advance_step"})
    await llm.aclose()
    assert [p for p, _ in rt.calls] == ["azure"]


# ------------------------------------------------------------------ context length


@pytest.mark.asyncio
async def test_context_length_trims_oldest_history_and_retries(tmp_path):
    def a(body, rt):
        if len(body["messages"]) > 8:
            return status(400, "This model's maximum context length is 1048576 tokens. "
                               "However, you requested 1200000 tokens.")(body, rt)
        return ok("Trimmed answer.")(body, rt)

    llm, rt = make(tmp_path, {"a": a, "b": a})
    msgs = [{"role": "system", "content": "You are helpful."}]
    for i in range(10):
        msgs += [{"role": "user", "content": f"question {i}"},
                 {"role": "assistant", "content": f"answer {i}"}]
    msgs.append({"role": "user", "content": "latest question"})
    evs = await run(llm, msgs)
    await llm.aclose()
    assert spoken(evs) == "Trimmed answer."
    assert evs[-1].meta["history_trims"] >= 1
    last = rt.calls[-1][1]["messages"]
    assert last[0]["role"] == "system" and "You are helpful." in last[0]["content"]
    assert last[-1]["content"] == "latest question"
    assert "question 0" not in json.dumps(last)
    # a context error is not failed over to every provider
    first_round = [p for p, b in rt.calls if len(b["messages"]) > 8]
    assert len(first_round) <= 3


@pytest.mark.asyncio
async def test_context_length_untrimmable_reports_clear_error(tmp_path):
    llm, rt = make(tmp_path, {"a": status(400, "maximum context length exceeded")})
    evs = await run(llm)
    await llm.aclose()
    assert evs[-1].type == "error" and evs[-1].meta["code"] == "context_length_exceeded"
    assert "too long" in evs[-1].error


# ------------------------------------------------------------------ cancellation / leaks


def _tasks():
    return {t for t in asyncio.all_tasks() if not t.done()}


async def _settle():
    # httpx leaves its nested body generators to the loop's asyncgen finalizer, which
    # closes them in short-lived tasks; anything still pending after this is a real leak.
    for _ in range(5):
        await asyncio.sleep(0.01)


@pytest.mark.asyncio
async def test_cancel_during_hedging_closes_both_streams_and_leaks_no_tasks(tmp_path):
    slow = stream([5.0] + words("late"))
    llm, rt = make(tmp_path, {"a": slow, "b": stream([5.0] + words("late"))},
                   hedge_delay_ms=30)
    before = _tasks()

    async def consume():
        async for _ in llm.stream([{"role": "user", "content": "hi"}], []):
            pass

    t = asyncio.create_task(consume())
    await asyncio.sleep(0.25)
    assert len(rt.bodies) == 2  # both requests in flight (hedge fired)
    t.cancel()
    with pytest.raises(asyncio.CancelledError):
        await t
    assert all(b.closed for b in rt.bodies)
    await _settle()
    leaked = _tasks() - before - {asyncio.current_task()}
    assert not leaked, leaked
    await llm.aclose()


@pytest.mark.asyncio
async def test_aclose_mid_stream_after_hedge_closes_everything(tmp_path):
    many = []
    for i in range(500):
        many += [0.01, chunk({"content": f"w{i} "})]
    llm, rt = make(tmp_path, {"a": stream([5.0] + words("late")), "b": stream(many)},
                   hedge_delay_ms=30)
    before = _tasks()
    got = []
    async with contextlib.aclosing(llm.stream([{"role": "user", "content": "hi"}], [])) as s:
        async for e in s:
            got.append(e)
            if len(got) == 3:
                break
    assert all(b.closed for b in rt.bodies)
    await _settle()
    assert not (_tasks() - before - {asyncio.current_task()})
    await llm.aclose()


@pytest.mark.asyncio
async def test_double_cancel_still_cleans_up(tmp_path):
    llm, rt = make(tmp_path, {"a": stream([5.0] + words("x")), "b": stream([5.0] + words("y"))},
                   hedge_delay_ms=20)
    before = _tasks()

    async def consume():
        async for _ in llm.stream([{"role": "user", "content": "hi"}], []):
            pass

    t = asyncio.create_task(consume())
    await asyncio.sleep(0.15)
    t.cancel()
    await asyncio.sleep(0)
    t.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await t
    await _settle()
    assert all(b.closed for b in rt.bodies)
    assert not (_tasks() - before - {asyncio.current_task()})
    await llm.aclose()


# ------------------------------------------------------------------ stickiness + layout


@pytest.mark.asyncio
async def test_sticky_provider_for_same_conversation(tmp_path):
    llm, rt = make(tmp_path, {"a": ok("A."), "b": ok("B.")})
    sb = llm.scoreboard
    for _ in range(4):
        sb.record_success("a", 500)
        sb.record_success("b", 600)
    conv = [{"role": "system", "content": "S" * 5000}, {"role": "user", "content": "first"}]
    llm.note_provider(llm.conv_key(conv), "b", 3000)
    await run(llm, conv + [{"role": "assistant", "content": "x"}, {"role": "user", "content": "next"}])
    assert rt.calls[-1][0] == "b"  # warm cache wins over a 100 ms better score
    other = [{"role": "system", "content": "T" * 5000}, {"role": "user", "content": "first"}]
    await run(llm, other)
    assert rt.calls[-1][0] == "a"  # a different conversation is not sticky
    await llm.aclose()


@pytest.mark.asyncio
async def test_sticky_not_used_when_provider_is_much_slower(tmp_path):
    llm, rt = make(tmp_path, {"a": ok("A."), "b": ok("B.")})
    for _ in range(4):
        llm.scoreboard.record_success("a", 400)
        llm.scoreboard.record_success("b", 4000)
    conv = [{"role": "system", "content": "short"}, {"role": "user", "content": "first"}]
    llm.note_provider(llm.conv_key(conv), "b", 50)
    await run(llm, conv)
    await llm.aclose()
    assert rt.calls[-1][0] == "a"


@pytest.mark.asyncio
async def test_tail_layout_keeps_request_prefix_stable_across_turns(tmp_path):
    llm, rt = make(tmp_path, {"a": ok("Okay.")})
    base = "# Role\nYou moderate a study.\n" + "Rule. " * 200
    hist = [{"role": "assistant", "content": "Welcome."}, {"role": "user", "content": "Hi."}]
    await run(llm, [{"role": "system", "content": base + "\n\n# NOW\nAsk question one."}] + hist)
    hist2 = hist + [{"role": "assistant", "content": "Okay."}, {"role": "user", "content": "Sure."}]
    await run(llm, [{"role": "system", "content": base + "\n\n# NOW\nAsk question two."}] + hist2)
    await llm.aclose()
    m1, m2 = rt.calls[0][1]["messages"], rt.calls[1][1]["messages"]
    assert "# NOW" not in m1[0]["content"] and m1[0] == m2[0]
    # the NOW section comes after the history, followed by the turn nudge
    assert m1[-2]["role"] == "system" and "question one" in m1[-2]["content"]
    assert m1[-1]["role"] == "user" and m1[-3] == {"role": "user", "content": "Hi."}
    # everything before turn 1's NOW section is byte-identical in turn 2
    assert m2[:len(m1) - 2] == m1[:-2]
    assert "question two" in m2[-2]["content"]


@pytest.mark.asyncio
async def test_inline_layout_option(tmp_path):
    llm, rt = make(tmp_path, {"a": ok("Okay.")}, instructions_layout="inline")
    base = "# Role\n" + "Rule. " * 200
    await run(llm, [{"role": "system", "content": base + "\n\n# NOW\nAsk."},
                    {"role": "user", "content": "Hi."}])
    await llm.aclose()
    assert "# NOW" in rt.calls[0][1]["messages"][0]["content"]


@pytest.mark.asyncio
async def test_cached_tokens_reported_and_scoreboard_uses_prompt_size(tmp_path):
    usage = {"prompt_tokens": 9000, "completion_tokens": 3,
             "prompt_tokens_details": {"cached_tokens": 8704}}
    llm, rt = make(tmp_path, {"a": lambda b, r: httpx.Response(
        200, stream=Body(words("Hi.", done=False) + [chunk({}, finish="stop"),
                                                    chunk({}, usage=usage), "data: [DONE]\n\n"]))})
    evs = await run(llm)
    await llm.aclose()
    assert evs[-1].meta["cached_tokens"] == 8704
    assert llm.scoreboard.stats["a"].cache_hits == 1
