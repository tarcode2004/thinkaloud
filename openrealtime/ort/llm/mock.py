"""Deterministic offline LLM for protocol / end-to-end tests (OPENREALTIME_LLM=mock).

Rules, applied to the last user (or trailing system) message:
  * tool_choice 'none'                       -> text reply
  * tool_choice {'type':'function',name}     -> call that tool
  * tool_choice 'required'                   -> call the first tool
  * text contains done/finished/next/complete/move on (whole word) and a tool whose
    name matches /advance|next|done|complete|finish/ exists -> call it
  * text 'call <tool_name>' with that tool present -> call it
  * the last section (after the last markdown heading) of the leading system instructions
    -- e.g. per-response `instructions` ending in '# NOW ...' -- is obeyed: 'call <tool> [now]'
    calls it (string args such as `question_id "q1"` are taken from the text; empty text/answer/
    message-like args echo the last user message), and a dictation
    'Say|Read|Ask ...: "X"' replies exactly X
  * last message is a tool result whose JSON has a top-level string field named say* (e.g.
    "say", "say_verbatim") -> reply exactly that text; else if it says 'call <other tool>' -> call it
  * text starting 'say: X' / 'say "X"' / 'repeat after me: X' -> reply exactly X
  * last message is a tool result            -> "Okay, got it."
  * otherwise a scripted reply (cfg mock_replies, cycled deterministically by hash)

Arguments are synthesised from the tool schema (defaults / required fields).
Timing: first token after mock_ttft_ms (default 250, env OPENREALTIME_MOCK_TTFT_MS),
then one word per mock_word_ms (default 35, env OPENREALTIME_MOCK_WORD_MS).
Set both to 0 for instant tests.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import secrets
from typing import Any, AsyncIterator

from . import LLMEvent, ToolCall
from .harness import (SpeechFilter, convert_tool_choice, realtime_tools_to_chat,
                      synthesize_from_schema, tool_schemas, _content_text)

DEFAULT_REPLIES = [
    "Thanks, that's helpful. What are you looking at right now?",
    "Got it. Could you tell me a bit more about what you expected to happen?",
    "Okay. Please keep thinking out loud as you go.",
    "I see. What would you try next?",
]
_ADV = re.compile(r"advance|next|done|complete|finish", re.I)
_DONE = re.compile(r"\b(done|finished|next|complete(?:d)?|move on|i'?m through)\b", re.I)
_DICTATE = re.compile(r"\b(?:say|read|ask|repeat)\b[^\"“\n]*:\s*[\"“]([^\"”]+)[\"”]", re.I)
_CALL = re.compile(r"\bcall\s+([A-Za-z_][\w\-]*)", re.I)
_NEG = re.compile(r"(?:\bnot|\bnever|n't)\s+$", re.I)
_ECHO = re.compile(r"^(?:text|answer|content|message|input|query|transcript)$", re.I)
_SAY = re.compile(r"^\s*(?:please\s+)?(?:say|repeat after me)\s*[:,]?\s*[\"“']?(.+?)[\"”']?\s*$", re.I | re.S)


def _f(cfg: dict, key: str, env: str, default: float) -> float:
    v = os.environ.get(env)
    if v not in (None, ""):
        return float(v)
    return float(cfg.get(key, default))


class MockLLM:
    def __init__(self, cfg: dict | None = None):
        c = dict(cfg or {})
        self.ttft_ms = _f(c, "mock_ttft_ms", "OPENREALTIME_MOCK_TTFT_MS", 250)
        self.word_ms = _f(c, "mock_word_ms", "OPENREALTIME_MOCK_WORD_MS", 35)
        self.replies = list(c.get("mock_replies") or DEFAULT_REPLIES)
        self.calls = 0  # number of stream() invocations (handy in tests)
        self.last_request: dict | None = None

    async def warmup(self) -> None:
        return None

    async def aclose(self) -> None:
        return None

    # ------------------------------------------------------------------ decide
    def decide(self, messages: list[dict], tools: list[dict], tool_choice: Any = "auto"
               ) -> tuple[str, str | None, dict | None]:
        """Returns (text, tool_name, args)."""
        chat_tools = realtime_tools_to_chat(tools)
        schemas = tool_schemas(chat_tools)
        names = list(schemas)
        _, mode, forced = convert_tool_choice(tool_choice, names)
        if not names:
            mode = "none"

        last = messages[-1] if messages else {}
        last_text = ""
        for m in reversed(messages):
            if m.get("role") in ("user", "system", "developer"):
                last_text = _content_text(m.get("content"))
                if m.get("role") == "user" or m is last:
                    break

        # The directive: last section of the leading system message (session or response instructions).
        directive = ""
        if messages and messages[0].get("role") in ("system", "developer"):
            sys_text = _content_text(messages[0].get("content"))
            heads = list(re.finditer(r"(?m)^#{1,6} .*$", sys_text))
            directive = sys_text[heads[-1].end():] if heads else sys_text

        last_user = next((_content_text(m.get("content")) for m in reversed(messages) if m.get("role") == "user"), "")

        def call(name: str, hint: str = ""):
            args = synthesize_from_schema(schemas.get(name) or {})
            props = (schemas.get(name) or {}).get("properties") or {}
            for k, spec in props.items():
                if isinstance(spec, dict) and spec.get("type") == "string":
                    mm = re.search(rf"\b{re.escape(k)}\s+[\"“]([^\"”]*)[\"”]", hint)
                    if mm:
                        args[k] = mm.group(1)
                    elif not args.get(k) and _ECHO.match(k) and last_user:
                        args[k] = last_user  # e.g. record_answer(text=...) echoes what the user said
            return "", name, args

        if mode == "named" and forced:
            return call(forced)
        if mode == "required":
            return call(names[0])
        if mode != "none" and directive:
            for m in _CALL.finditer(directive):
                if m.group(1) in names and not _NEG.search(directive[max(0, m.start() - 12):m.start()]):
                    return call(m.group(1), directive)
        if mode != "none" and last.get("role") != "tool":
            m = re.search(r"\bcall\s+([A-Za-z_][\w\-]*)", last_text)
            if m and m.group(1) in names:
                return call(m.group(1))
            if _DONE.search(last_text):
                for n in names:
                    if _ADV.search(n):
                        return call(n)
        dictated = _DICTATE.findall(directive)
        if dictated:
            return dictated[-1].strip(), None, None
        m = _SAY.search(last_text) if last.get("role") != "tool" else None
        if m:
            return m.group(1).strip(), None, None
        if last.get("role") == "tool":
            try:
                res = json.loads(_content_text(last.get("content")) or "{}")
            except ValueError:
                res = None
            if isinstance(res, dict):
                for k, v in res.items():
                    if k.lower().startswith("say") and isinstance(v, str) and v.strip():
                        return v.strip(), None, None
            if mode != "none":
                # The result asks for a follow-up call ("... Call complete_step.") of another tool.
                prev = {c.get("id"): (c.get("function") or {}).get("name") for m in messages
                        for c in (m.get("tool_calls") or [])}.get(last.get("tool_call_id"))
                body = _content_text(last.get("content"))
                for m in _CALL.finditer(body):
                    n = m.group(1)
                    if n in names and n != prev and not _NEG.search(body[max(0, m.start() - 12):m.start()]):
                        return call(n, body)
            return "Okay, got it.", None, None
        h = int(hashlib.sha1(last_text.encode()).hexdigest(), 16)
        return self.replies[h % len(self.replies)], None, None

    # ------------------------------------------------------------------ stream
    async def stream(self, messages: list[dict], tools: list[dict],
                     tool_choice: str | dict = "auto", temperature: float | None = None,
                     max_tokens: int | None = None, **opts: Any) -> AsyncIterator[LLMEvent]:
        self.calls += 1
        self.last_request = {"messages": messages, "tools": tools, "tool_choice": tool_choice,
                             "temperature": temperature, "max_tokens": max_tokens, **opts}
        text, name, args = self.decide(messages, tools or [], tool_choice)
        if self.ttft_ms:
            await asyncio.sleep(self.ttft_ms / 1000)
        words = re.findall(r"\S+\s*", text)
        if max_tokens:
            words = words[: max(1, int(max_tokens))]
        filt = SpeechFilter()
        first = True
        out_text = []
        for i, w in enumerate(words):
            if i and self.word_ms:
                await asyncio.sleep(self.word_ms / 1000)
            s = filt.feed(w)
            if s:
                ev = LLMEvent("text_delta", text=s)
                if first:
                    ev.meta = {"provider": "mock", "ttft_ms": self.ttft_ms}
                    first = False
                out_text.append(s)
                yield ev
        tail = filt.finish()
        if tail:
            out_text.append(tail)
            yield LLMEvent("text_delta", text=tail)
        if name:
            yield LLMEvent("tool_call", tool_call=ToolCall(
                "call_" + secrets.token_hex(12), name, json.dumps(args or {})))
        n_out = len(words) + (8 if name else 0)
        n_in = sum(len(_content_text(m.get("content")).split()) for m in messages)
        yield LLMEvent("done", usage={"prompt_tokens": n_in, "completion_tokens": n_out,
                                      "total_tokens": n_in + n_out},
                       meta={"provider": "mock", "ttft_ms": self.ttft_ms,
                             "finish_reason": "tool_calls" if name else "stop",
                             "text": "".join(out_text)})
