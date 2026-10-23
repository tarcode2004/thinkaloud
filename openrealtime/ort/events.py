"""Event builders, ids and session-config helpers for the OpenAI GA Realtime wire protocol.

Field names here are the contract with clients (ThinkAloud's realtime.ts, the OpenAI Agents SDK):
keep them exactly as OpenAI spells them.
"""
from __future__ import annotations

import copy
import secrets
import string
import time
from typing import Any

_ALNUM = string.ascii_letters + string.digits


def new_id(prefix: str, n: int = 22) -> str:
    """OpenAI-style id: ``prefix_`` + random base62 (e.g. ``item_Cq7...``, ``resp_...``, ``event_...``)."""
    return f"{prefix}_{''.join(secrets.choice(_ALNUM) for _ in range(n))}"


def server_event(type_: str, **fields: Any) -> dict:
    ev = {"event_id": new_id("event"), "type": type_}
    ev.update(fields)
    return ev


def error_event(code: str | None, message: str, *, type_: str = "invalid_request_error",
                param: str | None = None, event_id: str | None = None) -> dict:
    return server_event("error", error={
        "type": type_, "code": code, "message": message, "param": param, "event_id": event_id,
    })


# ---------------------------------------------------------------- session config

DEFAULT_SERVER_VAD = {
    "type": "server_vad", "threshold": 0.5, "prefix_padding_ms": 300, "silence_duration_ms": 500,
    "idle_timeout_ms": None, "create_response": True, "interrupt_response": True,
}
DEFAULT_SEMANTIC_VAD = {"type": "semantic_vad", "eagerness": "auto", "create_response": True, "interrupt_response": True}

PCM24 = {"type": "audio/pcm", "rate": 24000}


def default_session(model: str = "gpt-realtime") -> dict:
    return {
        "type": "realtime",
        "object": "realtime.session",
        "id": new_id("sess"),
        "model": model,
        "output_modalities": ["audio"],
        "instructions": "",
        "tools": [],
        "tool_choice": "auto",
        "max_output_tokens": "inf",
        "tracing": None,
        "truncation": "auto",
        "prompt": None,
        "expires_at": 0,
        "include": None,
        "audio": {
            "input": {
                "format": dict(PCM24),
                "transcription": None,
                "noise_reduction": None,
                "turn_detection": dict(DEFAULT_SERVER_VAD),
            },
            "output": {"format": dict(PCM24), "voice": "alloy", "speed": 1.0},
        },
    }


def _deep_merge(dst: dict, src: dict) -> dict:
    for k, v in src.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            _deep_merge(dst[k], v)
        else:
            dst[k] = copy.deepcopy(v)
    return dst


def normalize_session_patch(patch: dict) -> dict:
    """Map beta-shaped fields (top-level voice / turn_detection / input_audio_transcription /
    modalities / *_audio_format) onto the GA layout, so either client generation works."""
    p = copy.deepcopy(patch or {})

    def inp() -> dict:
        return p.setdefault("audio", {}).setdefault("input", {})

    def out() -> dict:
        return p.setdefault("audio", {}).setdefault("output", {})

    def fmt(f: Any) -> Any:
        return {"pcm16": dict(PCM24), "g711_ulaw": {"type": "audio/pcmu"}, "g711_alaw": {"type": "audio/pcma"}}.get(f, f) \
            if isinstance(f, str) else f

    for key, target, dst in (("voice", out, "voice"), ("speed", out, "speed"),
                             ("turn_detection", inp, "turn_detection"),
                             ("input_audio_transcription", inp, "transcription"),
                             ("input_audio_noise_reduction", inp, "noise_reduction")):
        if key in p:
            target()[dst] = p.pop(key)
    if "input_audio_format" in p:
        inp()["format"] = fmt(p.pop("input_audio_format"))
    if "output_audio_format" in p:
        out()["format"] = fmt(p.pop("output_audio_format"))
    if "modalities" in p:
        mods = p.pop("modalities")
        p.setdefault("output_modalities", ["audio"] if "audio" in (mods or []) else ["text"])
    if "max_response_output_tokens" in p:
        p["max_output_tokens"] = p.pop("max_response_output_tokens")
    return p


def fill_turn_detection(td: dict | None) -> dict | None:
    if td is None:
        return None
    base = dict(DEFAULT_SEMANTIC_VAD if td.get("type") == "semantic_vad" else DEFAULT_SERVER_VAD)
    base.update(td)
    return base


class SessionConfigError(ValueError):
    def __init__(self, message: str, param: str | None = None, code: str = "invalid_value"):
        super().__init__(message)
        self.param = param
        self.code = code


_MISSING = object()


def apply_session_patch(session: dict, patch: dict) -> dict:
    """Merge a (GA or beta-shaped) session patch into ``session`` in place and validate it.
    Objects merge recursively, arrays/scalars replace; ``turn_detection: null`` disables VAD."""
    p = normalize_session_patch(patch)
    if p.get("type") not in (None, "realtime"):
        raise SessionConfigError(f"Unsupported session type '{p.get('type')}' (only 'realtime' is supported).", "session.type")
    for ro in ("id", "object", "expires_at", "type"):
        p.pop(ro, None)
    a_in = p.get("audio", {}).get("input", {}) if isinstance(p.get("audio"), dict) else {}
    td = a_in.pop("turn_detection", _MISSING) if isinstance(a_in, dict) else _MISSING
    if td is not _MISSING and td is not None:
        if not isinstance(td, dict):
            raise SessionConfigError("turn_detection must be an object or null", "session.audio.input.turn_detection")
        if td.get("type") not in (None, "server_vad", "semantic_vad"):
            raise SessionConfigError(f"Invalid turn_detection type '{td.get('type')}'", "session.audio.input.turn_detection.type")
        cur = session["audio"]["input"].get("turn_detection")
        if cur and td.get("type", cur.get("type")) == cur.get("type"):
            td = {**cur, **td}  # same type: merge
        td = fill_turn_detection(td)
    _deep_merge(session, p)
    if td is not _MISSING:
        session["audio"]["input"]["turn_detection"] = td
    om = session.get("output_modalities")
    if om is None or om == []:
        session["output_modalities"] = ["audio"]
    elif not isinstance(om, list):
        raise SessionConfigError("output_modalities must be ['audio'] or ['text']", "session.output_modalities")
    else:
        session["output_modalities"] = ["audio"] if "audio" in om else ["text"]
    tc = session.get("tool_choice")
    if not (tc in ("auto", "none", "required") or (isinstance(tc, dict) and tc.get("type") == "function" and tc.get("name"))):
        raise SessionConfigError("tool_choice must be 'auto' | 'none' | 'required' | {type:'function', name}", "session.tool_choice")
    if not isinstance(session.get("tools"), list):
        raise SessionConfigError("tools must be an array", "session.tools")
    for i, t in enumerate(session["tools"]):
        if not isinstance(t, dict) or t.get("type", "function") != "function" or not t.get("name"):
            raise SessionConfigError("each tool must be {type:'function', name, description?, parameters?}", f"session.tools[{i}]")
    try:
        session["audio"]["output"]["speed"] = max(0.25, min(4.0, float(session["audio"]["output"].get("speed", 1.0))))
    except (TypeError, ValueError):
        raise SessionConfigError("speed must be a number", "session.audio.output.speed")
    return session


def new_session(model: str, patch: dict | None = None) -> dict:
    s = default_session(model)
    if patch:
        apply_session_patch(s, patch)
    s["model"] = model
    return s


# ---------------------------------------------------------------- items / responses

def public_item(item: dict) -> dict:
    """Copy of an item as sent on the wire (strip private ``_`` keys)."""
    return {k: copy.deepcopy(v) for k, v in item.items() if not k.startswith("_")}


def response_object(r_id: str, *, status: str, conversation_id: str | None, modalities: list[str],
                    voice: str, max_output_tokens: Any, metadata: Any, output: list | None = None,
                    usage: dict | None = None, status_details: dict | None = None) -> dict:
    return {
        "object": "realtime.response",
        "id": r_id,
        "status": status,
        "status_details": status_details,
        "output": output or [],
        "conversation_id": conversation_id,
        "output_modalities": modalities,
        "max_output_tokens": max_output_tokens,
        "audio": {"output": {"format": dict(PCM24), "voice": voice}},
        "usage": usage,
        "metadata": metadata,
    }


def usage_object(input_text_tokens: int, input_audio_tokens: int, output_text_tokens: int,
                 output_audio_tokens: int, cached: int = 0) -> dict:
    inp = input_text_tokens + input_audio_tokens
    out = output_text_tokens + output_audio_tokens
    return {
        "total_tokens": inp + out,
        "input_tokens": inp,
        "output_tokens": out,
        "input_token_details": {
            "text_tokens": input_text_tokens, "audio_tokens": input_audio_tokens, "image_tokens": 0,
            "cached_tokens": cached,
            "cached_tokens_details": {"text_tokens": cached, "audio_tokens": 0, "image_tokens": 0},
        },
        "output_token_details": {"text_tokens": output_text_tokens, "audio_tokens": output_audio_tokens},
    }


def rate_limits_event() -> dict:
    return server_event("rate_limits.updated", rate_limits=[
        {"name": "requests", "limit": 100000, "remaining": 99999, "reset_seconds": 1.0},
        {"name": "tokens", "limit": 10000000, "remaining": 9999000, "reset_seconds": 1.0},
    ])


def now() -> int:
    return int(time.time())
