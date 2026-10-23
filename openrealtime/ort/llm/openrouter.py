"""OpenRouter streaming chat-completions client + the OpenRouterLLM that ties together
provider hedging (providers.py) and the tool-call harness (harness.py).

Low level pieces (all unit-tested offline):
  SSEParser          incremental text/event-stream parser (comments, multi-line data)
  parse_chunk        one chat.completion.chunk JSON -> list[Raw]
  ToolCallAccumulator index/id-based accumulation of streamed tool_call deltas
  OpenRouterClient   persistent HTTP/2 httpx.AsyncClient, warmup + keepalive, stream_raw()
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, AsyncIterator

import httpx

from . import LLMEvent
from .harness import Harness, HarnessOptions
from .providers import DEFAULT_ORDER, ProviderError, Scoreboard, hedged_stream

log = logging.getLogger("ort.llm")

BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_MODEL = "deepseek/deepseek-v4-flash"


# --------------------------------------------------------------------------- key


def load_api_key(explicit: str | None = None) -> str | None:
    """OPENROUTER_API_KEY from the environment, falling back to ~/.hermes/.env.
    The key is never logged."""
    if explicit:
        return explicit
    k = os.environ.get("OPENROUTER_API_KEY")
    if k:
        return k.strip()
    p = Path(os.environ.get("ORT_ENV_FILE", "~/.hermes/.env")).expanduser()
    try:
        for line in p.read_text().splitlines():
            m = re.match(r"\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*(.*)$", line)
            if m:
                v = m.group(1).strip()
                if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                    v = v[1:-1]
                else:
                    v = v.split(" #", 1)[0].strip()
                if v:
                    return v
    except OSError:
        pass
    return None


# --------------------------------------------------------------------------- raw events


@dataclass
class Raw:
    """Normalised piece of a provider stream."""

    kind: str  # 'text' | 'tool' | 'usage' | 'meta' | 'finish' | 'error'
    text: str = ""
    index: int | None = None
    id: str | None = None
    name: str | None = None
    args: str | None = None
    data: dict | None = None

    @property
    def is_token(self) -> bool:
        return (self.kind == "text" and bool(self.text)) or self.kind == "tool"


# --------------------------------------------------------------------------- SSE


class SSEParser:
    """Incremental SSE parser. feed(line) per line (without newline); returns the
    completed event's data string when a blank line terminates an event, else None.
    Comment lines (':' prefix, e.g. ': OPENROUTER PROCESSING') are counted and ignored."""

    def __init__(self) -> None:
        self._data: list[str] = []
        self.comments = 0

    def feed(self, line: str) -> str | None:
        line = line.rstrip("\r")
        if line == "":
            if not self._data:
                return None
            d = "\n".join(self._data)
            self._data = []
            return d
        if line.startswith(":"):
            self.comments += 1
            return None
        field_, _, value = line.partition(":")
        if value.startswith(" "):
            value = value[1:]
        if field_ == "data":
            self._data.append(value)
        return None

    def flush(self) -> str | None:
        if self._data:
            d = "\n".join(self._data)
            self._data = []
            return d
        return None


def parse_chunk(obj: dict) -> list[Raw]:
    """Convert one chat.completion.chunk (OpenRouter flavour) into Raw events."""
    out: list[Raw] = []
    if not isinstance(obj, dict):
        return out
    if obj.get("error"):
        err = obj["error"]
        msg = err.get("message") if isinstance(err, dict) else str(err)
        code = err.get("code") if isinstance(err, dict) else None
        out.append(Raw("error", text=str(msg), data={"code": code, "error": err}))
        return out
    meta = {}
    if obj.get("provider"):
        meta["provider"] = obj["provider"]
    if obj.get("model"):
        meta["model"] = obj["model"]
    if meta:
        out.append(Raw("meta", data=meta))
    for ch in obj.get("choices") or []:
        delta = ch.get("delta") or ch.get("message") or {}
        c = delta.get("content")
        if isinstance(c, str) and c:
            out.append(Raw("text", text=c))
        elif isinstance(c, list):  # content parts
            for part in c:
                if isinstance(part, dict) and part.get("type") in ("text", "output_text"):
                    if part.get("text"):
                        out.append(Raw("text", text=part["text"]))
        for tc in delta.get("tool_calls") or []:
            fn = tc.get("function") or {}
            args = fn.get("arguments")
            if args is not None and not isinstance(args, str):
                args = json.dumps(args, ensure_ascii=False)
            out.append(Raw("tool", index=tc.get("index"), id=tc.get("id") or None,
                           name=fn.get("name") or None, args=args))
        # legacy function_call
        fc = delta.get("function_call")
        if fc:
            a = fc.get("arguments")
            if a is not None and not isinstance(a, str):
                a = json.dumps(a)
            out.append(Raw("tool", index=0, name=fc.get("name"), args=a))
        fr = ch.get("finish_reason")
        if fr:
            out.append(Raw("finish", text=str(fr), data={"native": ch.get("native_finish_reason")}))
            if fr == "error":
                out.append(Raw("error", text="provider finished with error"))
    if obj.get("usage"):
        out.append(Raw("usage", data=obj["usage"]))
    return out


class ToolCallAccumulator:
    """Accumulates streamed tool-call deltas.  Robust to providers that omit `index`,
    repeat the full name in every delta, or send cumulative argument strings."""

    def __init__(self) -> None:
        self.calls: dict[int, dict] = {}
        self._by_id: dict[str, int] = {}
        self._last: int | None = None

    def add(self, r: Raw) -> None:
        idx = r.index
        if idx is None:
            if r.id and r.id in self._by_id:
                idx = self._by_id[r.id]
            elif r.id or self._last is None:
                idx = (max(self.calls) + 1) if self.calls else 0
            else:
                idx = self._last
        c = self.calls.setdefault(idx, {"id": None, "name": "", "args": ""})
        if r.id and not c["id"]:
            c["id"] = r.id
            self._by_id[r.id] = idx
        if r.name:
            if not c["name"]:
                c["name"] = r.name
            elif r.name != c["name"] and not c["name"].endswith(r.name):
                c["name"] += r.name
        if r.args:
            cur = c["args"]
            if cur and len(r.args) > len(cur) and r.args.startswith(cur):
                c["args"] = r.args  # cumulative style
            else:
                c["args"] = cur + r.args
        self._last = idx

    def result(self) -> list[dict]:
        return [self.calls[i] for i in sorted(self.calls) if self.calls[i]["name"]]


# --------------------------------------------------------------------------- client


class OpenRouterClient:
    """Persistent HTTP/2 client.  Call ``await warmup()`` at startup; a background
    keepalive task re-touches the connection every ``keepalive_s`` while idle so the
    first user turn never pays DNS+TCP+TLS."""

    def __init__(self, api_key: str | None, base_url: str = BASE_URL, *,
                 keepalive_s: float = 20.0, connect_timeout: float = 5.0,
                 first_byte_timeout: float = 10.0, http2: bool = True,
                 transport: httpx.AsyncBaseTransport | None = None,
                 referer: str = "https://github.com/openrealtime", title: str = "OpenRealtime"):
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.keepalive_s = keepalive_s
        self.first_byte_timeout = first_byte_timeout
        try:
            import h2  # noqa: F401
        except ImportError:
            http2 = False
        self._client = httpx.AsyncClient(
            http2=http2 and transport is None,
            transport=transport,
            timeout=httpx.Timeout(connect=connect_timeout, read=first_byte_timeout,
                                  write=10.0, pool=5.0),
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=8,
                                keepalive_expiry=120.0),
            headers={"HTTP-Referer": referer, "X-Title": title},
        )
        self._last_use = 0.0
        self._ka_task: asyncio.Task | None = None

    def _headers(self) -> dict:
        if not self.api_key:
            raise ProviderError("OPENROUTER_API_KEY not configured", status=401)
        return {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}

    async def warmup(self) -> float | None:
        """Open + TLS-handshake the connection with a free endpoint. Returns ms or None."""
        t0 = time.perf_counter()
        try:
            r = await self._client.get(f"{self.base_url}/key", headers=self._headers(), timeout=8.0)
            await r.aread()
            self._last_use = time.monotonic()
            ms = (time.perf_counter() - t0) * 1000
            log.info("openrouter warm in %.0f ms (%s)", ms, r.http_version)
            return ms
        except Exception as e:  # warmup must never crash startup
            log.warning("openrouter warmup failed: %s", type(e).__name__)
            return None

    def start_keepalive(self) -> None:
        if self._ka_task is None or self._ka_task.done():
            self._ka_task = asyncio.get_running_loop().create_task(self._keepalive())

    async def _keepalive(self) -> None:
        while True:
            await asyncio.sleep(max(1.0, self.keepalive_s / 2))
            if time.monotonic() - self._last_use >= self.keepalive_s:
                await self.warmup()

    async def get_json(self, path: str) -> Any:
        r = await self._client.get(f"{self.base_url}{path}", headers=self._headers(), timeout=10.0)
        r.raise_for_status()
        return r.json()

    async def stream_raw(self, body: dict, provider: str | None = None) -> AsyncIterator[Raw]:
        """POST /chat/completions with stream=true; yields Raw events.  Raises
        ProviderError for HTTP errors and in-stream errors before any token.  Closing
        the generator aborts the HTTP stream immediately."""
        body = dict(body)
        body["stream"] = True
        if provider:
            body["provider"] = {**(body.get("provider") or {}), "order": [provider],
                                "allow_fallbacks": False}
        self._last_use = time.monotonic()
        req = self._client.build_request("POST", f"{self.base_url}/chat/completions",
                                         headers=self._headers(), json=body)
        resp = await self._client.send(req, stream=True)
        try:
            if resp.status_code != 200:
                raw = (await resp.aread())[:2000]
                try:
                    j = json.loads(raw)
                    err = j.get("error") or j
                    msg = err.get("message") if isinstance(err, dict) else str(err)
                    meta = err.get("metadata") if isinstance(err, dict) else None
                    if meta and meta.get("raw"):
                        msg = f"{msg}: {str(meta.get('raw'))[:300]}"
                except Exception:
                    msg, j = raw.decode("utf-8", "replace"), None
                ra = resp.headers.get("retry-after")
                raise ProviderError(f"HTTP {resp.status_code}: {msg}", status=resp.status_code,
                                    provider=provider,
                                    retry_after=float(ra) if ra and ra.replace('.', '', 1).isdigit() else None,
                                    body=j)
            sse = SSEParser()
            got_token = False
            async for line in resp.aiter_lines():
                data = sse.feed(line)
                if data is None:
                    continue
                if data.strip() == "[DONE]":
                    break
                try:
                    obj = json.loads(data)
                except json.JSONDecodeError:
                    log.debug("bad SSE json: %.200s", data)
                    continue
                for r in parse_chunk(obj):
                    if r.kind == "error":
                        code = (r.data or {}).get("code")
                        status = code if isinstance(code, int) else None
                        if not got_token:
                            raise ProviderError(f"stream error: {r.text}", status=status or 502,
                                                provider=provider)
                    if r.is_token:
                        got_token = True
                    yield r
            tail = sse.flush()
            if tail and tail.strip() != "[DONE]":
                try:
                    for r in parse_chunk(json.loads(tail)):
                        yield r
                except json.JSONDecodeError:
                    pass
        finally:
            await resp.aclose()
            self._last_use = time.monotonic()

    async def aclose(self) -> None:
        if self._ka_task:
            self._ka_task.cancel()
        await self._client.aclose()


# --------------------------------------------------------------------------- LLM


def _env_bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    if v is None or v == "":
        return default
    return v.strip().lower() not in ("0", "false", "no", "off")


class OpenRouterLLM:
    """DeepSeek V4 (or any OpenRouter model) with hedged provider routing and the
    tool-call harness.  Implements the `LLM` protocol."""

    def __init__(self, cfg: dict | None = None, *, client: OpenRouterClient | None = None,
                 scoreboard: Scoreboard | None = None):
        c = dict(cfg or {})
        self.model = os.environ.get("ORT_LLM_MODEL") or c.get("model") or DEFAULT_MODEL
        prov = os.environ.get("ORT_LLM_PROVIDERS") or c.get("providers") or DEFAULT_ORDER
        if isinstance(prov, str):
            prov = [p.strip() for p in prov.split(",") if p.strip()]
        self.providers: list[str] = list(prov)
        self.hedge = _env_bool("ORT_HEDGE", bool(c.get("hedge", True)))
        hd = os.environ.get("ORT_HEDGE_DELAY_MS") or c.get("hedge_delay_ms")
        self.hedge_delay_ms: float | None = float(hd) if hd else None
        self.reasoning = bool(c.get("reasoning", False))
        self.default_temperature = c.get("temperature")
        self.default_max_tokens = c.get("max_tokens", 1024)
        self.extra_body: dict = dict(c.get("extra_body") or {})
        self.options = HarnessOptions(
            preamble=os.environ.get("ORT_PREAMBLE") or c.get("preamble", "allow"),
            voice_prompt=c.get("voice_prompt", True),
            validate=c.get("validate", True),
            reask=c.get("reask", True),
            recover_leaks=c.get("recover_leaks", True),
        )
        self.client = client or OpenRouterClient(load_api_key(c.get("api_key")),
                                                 c.get("base_url") or BASE_URL)
        self.scoreboard = scoreboard or Scoreboard(
            self.providers, cache_path=c.get("cache_path"))
        self._warm = False

    # lifecycle ------------------------------------------------------------
    async def warmup(self) -> None:
        """Pre-connect (TLS) and start the keepalive loop. Safe to call repeatedly."""
        await self.client.warmup()
        self.client.start_keepalive()
        self._warm = True

    async def aclose(self) -> None:
        self.scoreboard.save(force=True)
        await self.client.aclose()

    # core -----------------------------------------------------------------
    def _body(self, messages, tools, tool_choice, temperature, max_tokens) -> dict:
        body: dict[str, Any] = {"model": self.model, "messages": messages,
                                "stream_options": {"include_usage": True}}
        if tools:
            body["tools"] = tools
            if tool_choice is not None:
                body["tool_choice"] = tool_choice
        t = temperature if temperature is not None else self.default_temperature
        if t is not None:
            body["temperature"] = t
        mt = max_tokens if max_tokens is not None else self.default_max_tokens
        if mt:
            body["max_tokens"] = int(mt)
        if not self.reasoning:
            body["reasoning"] = {"enabled": False}
        body.update(self.extra_body)
        return body

    def _raw_stream(self, body: dict) -> AsyncIterator[Raw]:
        """Hedged raw stream (first meta event carries hedge info)."""
        if not self.providers:
            return self.client.stream_raw(body, None)
        return hedged_stream(
            lambda p: self.client.stream_raw(body, p),
            self.scoreboard,
            hedge=self.hedge,
            hedge_delay_ms=self.hedge_delay_ms,
        )

    def stream(self, messages: list[dict], tools: list[dict], tool_choice: str | dict = "auto",
               temperature: float | None = None, max_tokens: int | None = None,
               **opts: Any) -> AsyncIterator[LLMEvent]:
        """See ort.llm docstring.  Extra keyword opts override HarnessOptions per call
        (preamble='suppress', voice_prompt=False, ...)."""
        if not self.client.api_key:
            return _error_stream("OPENROUTER_API_KEY is not configured (env or ~/.hermes/.env)")
        options = self.options.replace(**opts) if opts else self.options
        harness = Harness(tools or [], tool_choice, options)

        def open_stream(msgs, chat_tools, chat_tool_choice, mt=None):
            return self._raw_stream(self._body(msgs, chat_tools, chat_tool_choice,
                                               temperature, mt if mt is not None else max_tokens))

        return harness.run(messages, open_stream)


async def _error_stream(msg: str) -> AsyncIterator[LLMEvent]:
    yield LLMEvent("error", error=msg)
