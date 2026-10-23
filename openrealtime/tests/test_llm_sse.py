"""Offline tests: SSE parsing, chunk parsing, tool-delta accumulation, client streaming
over httpx.MockTransport (no network)."""
import asyncio
import contextlib
import json
import os
import sys

import httpx
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ort.llm.openrouter import (OpenRouterClient, OpenRouterLLM, Raw, SSEParser,  # noqa: E402
                                ToolCallAccumulator, load_api_key, parse_chunk)
from ort.llm.providers import ProviderError  # noqa: E402


def chunk(delta=None, finish=None, provider="Parasail", usage=None, **extra):
    obj = {"id": "gen-1", "provider": provider, "model": "deepseek/deepseek-v4-flash",
           "object": "chat.completion.chunk",
           "choices": [{"index": 0, "delta": delta or {}, "finish_reason": finish}]}
    if usage:
        obj["usage"] = usage
    obj.update(extra)
    return "data: " + json.dumps(obj) + "\n\n"


def sse_body(*events, comments=2):
    head = "".join(": OPENROUTER PROCESSING\n\n" for _ in range(comments))
    return head + "".join(events) + "data: [DONE]\n\n"


TOOL_STREAM = sse_body(
    chunk({"role": "assistant", "content": ""}),
    chunk({"content": "\n\nLet me move"}),
    chunk({"content": " us on."}),
    chunk({"tool_calls": [{"index": 0, "id": "call_a", "type": "function",
                           "function": {"name": "advance_step", "arguments": ""}}]}),
    chunk({"tool_calls": [{"index": 0, "function": {"arguments": "{\"rea"}}]}),
    chunk({"tool_calls": [{"index": 0, "function": {"arguments": "son\": \"done\"}"}}]}),
    chunk({}, finish="tool_calls"),
    chunk({}, usage={"prompt_tokens": 150, "completion_tokens": 12, "total_tokens": 162}),
)


# ------------------------------------------------------------------ SSEParser


def test_sse_parser_comments_and_multiline():
    p = SSEParser()
    lines = [": OPENROUTER PROCESSING", "", "event: message", "data: {\"a\":", "data: 1}", "",
             "data: [DONE]", ""]
    out = [d for d in (p.feed(l) for l in lines) if d is not None]
    assert out == ['{"a":\n1}', "[DONE]"]
    assert p.comments == 1


def test_sse_parser_crlf_and_flush():
    p = SSEParser()
    assert p.feed("data: x\r") is None
    assert p.flush() == "x"


# ------------------------------------------------------------------ parse_chunk


def test_parse_chunk_text_provider_usage():
    obj = json.loads(chunk({"content": "hi"}, usage={"prompt_tokens": 3})[6:])
    kinds = [r.kind for r in parse_chunk(obj)]
    assert kinds == ["meta", "text", "usage"]
    assert parse_chunk(obj)[0].data["provider"] == "Parasail"


def test_parse_chunk_error_object():
    rs = parse_chunk({"error": {"message": "Rate limit", "code": 429}})
    assert rs[0].kind == "error" and rs[0].data["code"] == 429


def test_parse_chunk_finish_error():
    obj = json.loads(chunk({}, finish="error")[6:])
    assert [r.kind for r in parse_chunk(obj)][-2:] == ["finish", "error"]


def test_parse_chunk_object_arguments_and_reasoning_ignored():
    obj = json.loads(chunk({"reasoning": "think", "tool_calls": [
        {"index": 0, "id": "c", "function": {"name": "f", "arguments": {"x": 1}}}]})[6:])
    rs = [r for r in parse_chunk(obj) if r.kind == "tool"]
    assert rs[0].args == '{"x": 1}'
    assert not [r for r in parse_chunk(obj) if r.kind == "text"]


# ------------------------------------------------------------------ accumulator


def test_accumulator_index_based_parallel():
    a = ToolCallAccumulator()
    a.add(Raw("tool", index=0, id="c1", name="a", args=""))
    a.add(Raw("tool", index=1, id="c2", name="b", args="{\"y\""))
    a.add(Raw("tool", index=0, args="{\"x\": 1}"))
    a.add(Raw("tool", index=1, args=": 2}"))
    res = a.result()
    assert [(c["id"], c["name"], json.loads(c["args"])) for c in res] == \
        [("c1", "a", {"x": 1}), ("c2", "b", {"y": 2})]


def test_accumulator_missing_index_repeated_name_cumulative_args():
    a = ToolCallAccumulator()
    a.add(Raw("tool", id="c1", name="adv", args="{\"a\""))
    a.add(Raw("tool", name="adv", args="{\"a\": 1}"))  # cumulative + repeated name
    a.add(Raw("tool", id="c2", name="other", args="{}"))
    res = a.result()
    assert res[0]["name"] == "adv" and json.loads(res[0]["args"]) == {"a": 1}
    assert res[1]["id"] == "c2"


# ------------------------------------------------------------------ client over MockTransport


class _Body(httpx.AsyncByteStream):
    def __init__(self, parts, delay=0.0):
        self.parts = parts
        self.delay = delay
        self.closed = False

    async def __aiter__(self):
        for p in self.parts:
            if self.delay:
                await asyncio.sleep(self.delay)
            yield p.encode()

    async def aclose(self):
        self.closed = True


def make_client(handler):
    return OpenRouterClient("test-key", transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_client_stream_raw_tool_stream():
    seen = {}

    def handler(req: httpx.Request):
        seen["body"] = json.loads(req.content)
        seen["auth"] = req.headers["authorization"]
        return httpx.Response(200, stream=_Body([TOOL_STREAM[i:i + 37]
                                                 for i in range(0, len(TOOL_STREAM), 37)]))

    c = make_client(handler)
    out = [r async for r in c.stream_raw({"model": "m", "messages": []}, "parasail")]
    await c.aclose()
    assert seen["body"]["provider"] == {"order": ["parasail"], "allow_fallbacks": False}
    assert seen["body"]["stream"] is True and seen["auth"] == "Bearer test-key"
    text = "".join(r.text for r in out if r.kind == "text")
    assert text == "\n\nLet me move us on."
    acc = ToolCallAccumulator()
    for r in out:
        if r.kind == "tool":
            acc.add(r)
    assert json.loads(acc.result()[0]["args"]) == {"reason": "done"}
    assert any(r.kind == "usage" for r in out)


@pytest.mark.asyncio
async def test_client_http_429_raises_with_retry_after():
    def handler(req):
        return httpx.Response(429, headers={"retry-after": "7"},
                              json={"error": {"message": "Rate limited", "code": 429}})

    c = make_client(handler)
    with pytest.raises(ProviderError) as ei:
        async for _ in c.stream_raw({"model": "m"}, "deepinfra"):
            pass
    await c.aclose()
    assert ei.value.status == 429 and ei.value.retry_after == 7.0 and ei.value.rate_limited


@pytest.mark.asyncio
async def test_client_midstream_error_before_token_raises():
    body = sse_body('data: {"error": {"message": "upstream overloaded", "code": 502}}\n\n')

    c = make_client(lambda req: httpx.Response(200, stream=_Body([body])))
    with pytest.raises(ProviderError) as ei:
        async for _ in c.stream_raw({"model": "m"}, "x"):
            pass
    await c.aclose()
    assert ei.value.status == 502


@pytest.mark.asyncio
async def test_client_midstream_error_after_token_is_event():
    body = sse_body(chunk({"content": "Hel"}),
                    'data: {"error": {"message": "boom", "code": 500}}\n\n')
    c = make_client(lambda req: httpx.Response(200, stream=_Body([body])))
    out = [r async for r in c.stream_raw({"model": "m"}, "x")]
    await c.aclose()
    assert [r.kind for r in out if r.kind in ("text", "error")] == ["text", "error"]


@pytest.mark.asyncio
async def test_client_close_aborts_stream():
    bodies = []

    def handler(req):
        b = _Body([chunk({"content": f"w{i} "}) for i in range(1000)], delay=0.01)
        bodies.append(b)
        return httpx.Response(200, stream=b)

    c = make_client(handler)
    agen = c.stream_raw({"model": "m"}, "x")
    n = 0
    async for r in agen:
        if r.kind == "text":
            n += 1
            if n == 3:
                break
    await agen.aclose()
    assert bodies[0].closed
    await c.aclose()


@pytest.mark.asyncio
async def test_openrouter_llm_end_to_end_offline(tmp_path):
    def handler(req):
        body = json.loads(req.content)
        assert body["reasoning"] == {"enabled": False}
        assert body["tools"][0]["function"]["name"] == "advance_step"
        assert body["messages"][0]["role"] == "system"
        return httpx.Response(200, stream=_Body([TOOL_STREAM]))

    llm = OpenRouterLLM({"providers": ["parasail", "azure"], "cache_path": str(tmp_path / "p.json")},
                        client=make_client(handler))
    tools = [{"type": "function", "name": "advance_step", "description": "next task",
              "parameters": {"type": "object", "properties": {"reason": {"type": "string"}},
                             "required": ["reason"]}}]
    evs = [e async for e in llm.stream([{"role": "user", "content": "I'm done"}], tools)]
    await llm.aclose()
    assert [e.type for e in evs] == ["text_delta", "text_delta", "tool_call", "done"]
    assert evs[0].text == "Let me move"  # leading "\n\n" stripped
    assert evs[0].meta["provider"] == "Parasail"
    assert json.loads(evs[2].tool_call.arguments) == {"reason": "done"}
    assert evs[2].tool_call.call_id == "call_a"
    d = evs[-1]
    assert d.usage["prompt_tokens"] == 150 and d.meta["provider_slug"] == "parasail"
    assert d.meta["finish_reason"] == "tool_calls"
    assert (tmp_path / "p.json").exists()


@pytest.mark.asyncio
async def test_openrouter_llm_close_mid_stream_aborts_http(tmp_path):
    bodies = []

    def handler(req):
        b = _Body([chunk({"content": f"word{i} "}) for i in range(2000)], delay=0.005)
        bodies.append(b)
        return httpx.Response(200, stream=b)

    llm = OpenRouterLLM({"providers": ["parasail"], "cache_path": str(tmp_path / "p.json")},
                        client=make_client(handler))
    got = []
    async with contextlib.aclosing(llm.stream([{"role": "user", "content": "talk"}], [])) as s:
        async for e in s:
            got.append(e)
            if len(got) == 3:
                break
    assert bodies[0].closed  # aborted immediately, not after 2000 chunks
    await llm.aclose()


@pytest.mark.asyncio
async def test_openrouter_llm_task_cancel_aborts_http(tmp_path):
    bodies = []

    def handler(req):
        b = _Body([chunk({"content": f"w{i} "}) for i in range(2000)], delay=0.005)
        bodies.append(b)
        return httpx.Response(200, stream=b)

    llm = OpenRouterLLM({"providers": ["parasail"], "cache_path": str(tmp_path / "p.json")},
                        client=make_client(handler))

    async def consume():
        async for _ in llm.stream([{"role": "user", "content": "talk"}], []):
            pass

    t = asyncio.create_task(consume())
    await asyncio.sleep(0.1)
    t.cancel()
    with pytest.raises(asyncio.CancelledError):
        await t
    assert bodies[0].closed
    await llm.aclose()


@pytest.mark.asyncio
async def test_openrouter_llm_without_key_yields_error(tmp_path):
    llm = OpenRouterLLM({"providers": ["parasail"], "cache_path": str(tmp_path / "p.json")},
                        client=OpenRouterClient(None, transport=httpx.MockTransport(lambda r: 1 / 0)))
    evs = [e async for e in llm.stream([{"role": "user", "content": "x"}], [])]
    assert evs[0].type == "error" and "OPENROUTER_API_KEY" in evs[0].error
    await llm.aclose()


def test_load_api_key_from_env_file(tmp_path, monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    f = tmp_path / ".env"
    f.write_text("FOO=1\nexport OPENROUTER_API_KEY=\"sk-or-test\"\n")
    monkeypatch.setenv("ORT_ENV_FILE", str(f))
    assert load_api_key() == "sk-or-test"
    monkeypatch.setenv("OPENROUTER_API_KEY", "envkey")
    assert load_api_key() == "envkey"
