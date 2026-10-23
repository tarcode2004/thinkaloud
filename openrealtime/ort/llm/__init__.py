"""LLM layer for OpenRealtime.

Public contract (see DESIGN.md):

    ToolCall, LLMEvent, LLM (Protocol), make_llm(cfg)

``LLM.stream(...)`` is an async generator of ``LLMEvent``:

    text_delta*  (spoken text, already cleaned: no leaked tool-call syntax, no leading
                  whitespace / markdown emphasis; safe to feed straight to TTS)
    tool_call*   (arguments are a JSON string that validates against the tool schema)
    done         (exactly once on success; usage + meta {provider, ttft_ms, ...})
  | error        (terminal; nothing follows)

Cancellation: close the generator (``await agen.aclose()``) or cancel the task that is
iterating it.  Either aborts the underlying HTTP/2 stream(s) immediately (RST_STREAM).
Prefer ``async with contextlib.aclosing(llm.stream(...)) as s: async for ev in s: ...``
so that ``break`` also aborts immediately instead of waiting for GC.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, AsyncIterator, Literal, Protocol, runtime_checkable

__all__ = ["ToolCall", "LLMEvent", "LLM", "make_llm"]


@dataclass
class ToolCall:
    call_id: str
    name: str
    arguments: str  # JSON string, validated against the tool's parameters schema


@dataclass
class LLMEvent:
    type: Literal["text_delta", "tool_call", "done", "error"]
    text: str = ""
    tool_call: ToolCall | None = None
    usage: dict | None = None
    error: str | None = None
    meta: dict | None = None  # provider, ttft_ms, hedged, finish_reason, ...


@runtime_checkable
class LLM(Protocol):
    def stream(
        self,
        messages: list[dict],
        tools: list[dict],
        tool_choice: str | dict = "auto",
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> AsyncIterator[LLMEvent]: ...


def _as_dict(cfg: Any) -> dict:
    if cfg is None:
        return {}
    if isinstance(cfg, dict):
        return dict(cfg)
    if isinstance(cfg, str):
        return {"llm": cfg}
    return {k: getattr(cfg, k) for k in dir(cfg) if not k.startswith("_")}


def make_llm(cfg: Any = None) -> LLM:
    """Build the configured LLM.

    ``cfg`` may be None, a string ('openrouter' | 'mock') or a dict with optional keys:
      llm, model, providers (list or comma str), hedge (bool), hedge_delay_ms,
      preamble ('allow'|'suppress'), voice_prompt (bool|str), reasoning (bool),
      api_key, base_url, cache_path, temperature, max_tokens, mock_* (see mock.py).
    Env overrides: OPENREALTIME_LLM, ORT_LLM_MODEL, ORT_LLM_PROVIDERS, ORT_HEDGE,
      ORT_HEDGE_DELAY_MS, ORT_PREAMBLE.
    """
    c = _as_dict(cfg)
    kind = (os.environ.get("OPENREALTIME_LLM") or c.get("llm") or "openrouter").lower()
    if kind == "mock":
        from .mock import MockLLM

        return MockLLM(c)
    if kind in ("openrouter", "deepseek", "default"):
        from .openrouter import OpenRouterLLM

        return OpenRouterLLM(c)
    raise ValueError(f"unknown llm kind {kind!r} (expected 'openrouter' or 'mock')")
