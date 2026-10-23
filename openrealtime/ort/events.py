"""Event builders, ids and session-config helpers for the OpenAI GA Realtime wire protocol.

Field names here are the contract with clients (ThinkAloud's realtime.ts, the OpenAI Agents SDK):
keep them exactly as OpenAI spells them.
"""
from __future__ import annotations

import copy
import json
import math
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


def _bad_type(param: str, expected: str, got: Any) -> SessionConfigError:
    return SessionConfigError(f"Invalid type for '{param}': expected {expected}, but got {_type_name(got)} instead.",
                              param, "invalid_type")


def _type_name(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "a boolean"
    if isinstance(v, (int, float)):
        return "a number"
    if isinstance(v, str):
        return "a string"
    if isinstance(v, list):
        return "an array"
    if isinstance(v, dict):
        return "an object"
    return type(v).__name__


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _bad_value(param: str, message: str) -> SessionConfigError:
    return SessionConfigError(message, param, "invalid_value")


_MISSING = object()
_EAGERNESS = ("low", "medium", "high", "auto")
_FORMATS = ("audio/pcm", "audio/pcmu", "audio/pcma")
MAX_OUTPUT_TOKENS = 4096


def validate_tools(tools: Any, param: str) -> None:
    if not isinstance(tools, list):
        raise _bad_type(param, "an array", tools)
    for i, t in enumerate(tools):
        p = f"{param}[{i}]"
        if not isinstance(t, dict):
            raise _bad_type(p, "an object", t)
        if t.get("type", "function") != "function":
            raise _bad_value(f"{p}.type", f"Invalid value: '{t.get('type')}'. Supported values are: 'function'.")
        if "name" not in t or t["name"] in (None, ""):
            raise SessionConfigError(f"Missing required parameter: '{p}.name'.", f"{p}.name", "missing_required_parameter")
        if not isinstance(t["name"], str):
            raise _bad_type(f"{p}.name", "a string", t["name"])
        if t.get("description") is not None and not isinstance(t["description"], str):
            raise _bad_type(f"{p}.description", "a string", t["description"])
        if t.get("parameters") is not None and not isinstance(t["parameters"], dict):
            raise _bad_type(f"{p}.parameters", "an object", t["parameters"])


def validate_tool_choice(tc: Any, param: str, tools: list | None = None) -> None:
    ok = tc in ("auto", "none", "required") if isinstance(tc, str) else \
        isinstance(tc, dict) and tc.get("type") == "function" and isinstance(tc.get("name"), str) and bool(tc["name"])
    if not ok:
        raise _bad_value(param, "Invalid tool_choice: expected 'auto', 'none', 'required' or {type: 'function', name}.")
    if isinstance(tc, dict) and tools is not None and not any(t.get("name") == tc["name"] for t in tools):
        raise _bad_value(param, f"Tool choice '{tc['name']}' is not one of the provided tools.")


def validate_max_tokens(v: Any, param: str) -> None:
    if v == "inf":
        return
    if not (_is_num(v) and float(v).is_integer() and 1 <= v <= MAX_OUTPUT_TOKENS):
        raise _bad_value(param, f"Invalid value for '{param}': expected an integer between 1 and {MAX_OUTPUT_TOKENS}, or 'inf'.")


def validate_modalities(om: Any, param: str) -> None:
    if not isinstance(om, list):
        raise _bad_type(param, "an array", om)
    if not om or any(m not in ("audio", "text") for m in om):
        raise _bad_value(param, f"Invalid value for '{param}': supported values are ['audio'] and ['text'].")


def validate_voice(v: Any, param: str) -> None:
    if isinstance(v, dict) and isinstance(v.get("id"), str):
        return
    if not isinstance(v, str) or not v:
        raise _bad_type(param, "a string", v)


def _validate_turn_detection(td: Any, param: str) -> None:
    if td is None:
        return
    if not isinstance(td, dict):
        raise _bad_type(param, "an object or null", td)
    if td.get("type") not in ("server_vad", "semantic_vad"):
        raise _bad_value(f"{param}.type", f"Invalid value: '{td.get('type')}'. Supported values are: 'server_vad' and 'semantic_vad'.")
    if "threshold" in td and td["threshold"] is not None:
        if not _is_num(td["threshold"]):
            raise _bad_type(f"{param}.threshold", "a number", td["threshold"])
        if not 0.0 <= td["threshold"] <= 1.0:
            raise _bad_value(f"{param}.threshold", "threshold must be between 0.0 and 1.0.")
    for k in ("prefix_padding_ms", "silence_duration_ms", "idle_timeout_ms"):
        if td.get(k) is None:
            continue
        if not _is_num(td[k]):
            raise _bad_type(f"{param}.{k}", "an integer", td[k])
        if not 0 <= td[k] <= 600_000:
            raise _bad_value(f"{param}.{k}", f"{k} must be between 0 and 600000.")
    if td.get("eagerness") is not None and td["eagerness"] not in _EAGERNESS:
        raise _bad_value(f"{param}.eagerness", f"Invalid value: '{td['eagerness']}'. Supported values are: 'low', 'medium', 'high' and 'auto'.")
    for k in ("create_response", "interrupt_response"):
        if k in td and not isinstance(td[k], bool):
            raise _bad_type(f"{param}.{k}", "a boolean", td[k])


def _validate_format(f: Any, param: str) -> None:
    if not isinstance(f, dict):
        raise _bad_type(param, "an object", f)
    if f.get("type", "audio/pcm") not in _FORMATS:
        raise _bad_value(f"{param}.type", f"Invalid value: '{f.get('type')}'. Supported values are: 'audio/pcm', 'audio/pcmu' and 'audio/pcma'.")
    if f.get("type", "audio/pcm") == "audio/pcm" and f.get("rate", 24000) != 24000:
        raise _bad_value(f"{param}.rate", "Only 24000 Hz is supported for audio/pcm.")


def validate_truncation(t: Any, param: str = "session.truncation") -> None:
    if t in ("auto", "disabled"):
        return
    if isinstance(t, dict) and t.get("type") == "retention_ratio":
        r = t.get("retention_ratio")
        if not _is_num(r) or not 0.0 <= r <= 1.0:
            raise _bad_value(f"{param}.retention_ratio", "retention_ratio must be a number between 0.0 and 1.0.")
        tl = t.get("token_limits")
        if tl is not None:
            if not isinstance(tl, dict):
                raise _bad_type(f"{param}.token_limits", "an object", tl)
            pi = tl.get("post_instructions")
            if pi is not None and not (_is_num(pi) and pi >= 1):
                raise _bad_value(f"{param}.token_limits.post_instructions", "post_instructions must be a positive integer.")
        return
    raise _bad_value(param, "Invalid truncation: expected 'auto', 'disabled' or {type: 'retention_ratio', retention_ratio}.")


def validate_session(s: dict) -> None:
    """Type/range checks of a complete (merged) session object. Raises SessionConfigError."""
    if not isinstance(s.get("instructions"), str):
        raise _bad_type("session.instructions", "a string", s.get("instructions"))
    validate_modalities(s.get("output_modalities"), "session.output_modalities")
    validate_tools(s.get("tools"), "session.tools")
    validate_tool_choice(s.get("tool_choice"), "session.tool_choice")
    validate_max_tokens(s.get("max_output_tokens"), "session.max_output_tokens")
    validate_truncation(s.get("truncation"))
    if s.get("temperature") is not None and not _is_num(s["temperature"]):
        raise _bad_type("session.temperature", "a number", s["temperature"])
    if s.get("include") is not None and not (isinstance(s["include"], list) and all(isinstance(x, str) for x in s["include"])):
        raise _bad_type("session.include", "an array of strings", s["include"])
    a = s.get("audio")
    if not isinstance(a, dict):
        raise _bad_type("session.audio", "an object", a)
    for k in ("input", "output"):
        if not isinstance(a.get(k), dict):
            raise _bad_type(f"session.audio.{k}", "an object", a.get(k))
    ai, ao = a["input"], a["output"]
    _validate_format(ai.get("format"), "session.audio.input.format")
    _validate_format(ao.get("format"), "session.audio.output.format")
    tr = ai.get("transcription")
    if tr is not None:
        if not isinstance(tr, dict):
            raise _bad_type("session.audio.input.transcription", "an object or null", tr)
        for k in ("model", "language", "prompt"):
            if tr.get(k) is not None and not isinstance(tr[k], str):
                raise _bad_type(f"session.audio.input.transcription.{k}", "a string", tr[k])
    if ai.get("noise_reduction") is not None and not isinstance(ai["noise_reduction"], dict):
        raise _bad_type("session.audio.input.noise_reduction", "an object or null", ai["noise_reduction"])
    _validate_turn_detection(ai.get("turn_detection"), "session.audio.input.turn_detection")
    validate_voice(ao.get("voice"), "session.audio.output.voice")
    if not _is_num(ao.get("speed", 1.0)):
        raise _bad_type("session.audio.output.speed", "a number", ao.get("speed"))


def apply_session_patch(session: dict, patch: dict) -> dict:
    """Merge a (GA or beta-shaped) session patch into ``session`` and validate it.
    Objects merge recursively, arrays/scalars replace; ``turn_detection: null`` disables VAD.
    Atomic: on any validation error ``session`` is left exactly as it was."""
    if not isinstance(patch, dict):
        raise _bad_type("session", "an object", patch)
    if "audio" in patch:
        if not isinstance(patch["audio"], dict):
            raise _bad_type("session.audio", "an object", patch["audio"])
        for k in ("input", "output"):
            if k in patch["audio"] and not isinstance(patch["audio"][k], dict):
                raise _bad_type(f"session.audio.{k}", "an object", patch["audio"][k])
    p = normalize_session_patch(patch)
    if p.get("type") not in (None, "realtime"):
        raise SessionConfigError(f"Unsupported session type '{p.get('type')}' (only 'realtime' is supported).", "session.type")
    for ro in ("id", "object", "expires_at", "type"):
        p.pop(ro, None)
    work = copy.deepcopy(session)
    a_in = p.get("audio", {}).get("input", {}) if isinstance(p.get("audio"), dict) else {}
    td = a_in.pop("turn_detection", _MISSING) if isinstance(a_in, dict) else _MISSING
    if td is not _MISSING and td is not None:
        if not isinstance(td, dict):
            raise _bad_type("session.audio.input.turn_detection", "an object or null", td)
        if td.get("type") not in (None, "server_vad", "semantic_vad"):
            raise SessionConfigError(f"Invalid turn_detection type '{td.get('type')}'", "session.audio.input.turn_detection.type")
        cur = work["audio"]["input"].get("turn_detection")
        if cur and td.get("type", cur.get("type")) == cur.get("type"):
            td = {**cur, **td}  # same type: merge
        td = fill_turn_detection(td)
    _deep_merge(work, p)
    if td is not _MISSING:
        work["audio"]["input"]["turn_detection"] = td
    if work.get("output_modalities") in (None, []):
        work["output_modalities"] = ["audio"]
    validate_session(work)
    work["output_modalities"] = ["audio"] if "audio" in work["output_modalities"] else ["text"]
    work["audio"]["output"]["speed"] = max(0.25, min(4.0, float(work["audio"]["output"].get("speed", 1.0))))
    session.clear()
    session.update(work)
    return session


def validate_response_spec(spec: Any, session: dict) -> None:
    """response.create `response` object (OpenAI GA). Raises SessionConfigError."""
    if not isinstance(spec, dict):
        raise _bad_type("response", "an object", spec)
    if spec.get("instructions") is not None and not isinstance(spec["instructions"], str):
        raise _bad_type("response.instructions", "a string", spec["instructions"])
    if "conversation" in spec and spec["conversation"] not in ("auto", "none", None):
        raise _bad_value("response.conversation", f"Invalid value: '{spec['conversation']}'. Supported values are: 'auto' and 'none'.")
    if spec.get("tools") is not None:
        validate_tools(spec["tools"], "response.tools")
    if spec.get("tool_choice") is not None:
        tools = spec["tools"] if spec.get("tools") is not None else session.get("tools") or []
        validate_tool_choice(spec["tool_choice"], "response.tool_choice", tools)
    for k in ("output_modalities", "modalities"):
        if spec.get(k) is not None:
            validate_modalities(spec[k], f"response.{k}")
    for k in ("max_output_tokens", "max_response_output_tokens"):
        if k in spec and spec[k] is not None:
            validate_max_tokens(spec[k], f"response.{k}")
    if spec.get("metadata") is not None and not isinstance(spec["metadata"], dict):
        raise _bad_type("response.metadata", "an object", spec["metadata"])
    if spec.get("temperature") is not None and not _is_num(spec["temperature"]):
        raise _bad_type("response.temperature", "a number", spec["temperature"])
    if spec.get("voice") is not None:
        validate_voice(spec["voice"], "response.voice")
    au = spec.get("audio")
    if au is not None:
        if not isinstance(au, dict):
            raise _bad_type("response.audio", "an object", au)
        out = au.get("output")
        if out is not None:
            if not isinstance(out, dict):
                raise _bad_type("response.audio.output", "an object", out)
            if out.get("voice") is not None:
                validate_voice(out["voice"], "response.audio.output.voice")
    if spec.get("input") is not None:
        if not isinstance(spec["input"], list):
            raise _bad_type("response.input", "an array", spec["input"])
        for i, it in enumerate(spec["input"]):
            if not isinstance(it, dict):
                raise _bad_type(f"response.input[{i}]", "an object", it)


def estimate_tokens(obj: Any) -> int:
    """Cheap, slightly pessimistic token estimate (~4 chars per token + per-message overhead)."""
    if isinstance(obj, list):
        return sum(estimate_tokens(m) for m in obj)
    if isinstance(obj, dict):
        c = obj.get("content")
        n = len(c) if isinstance(c, str) else 0
        if obj.get("tool_calls"):
            n += len(json.dumps(obj["tool_calls"]))
        if "role" not in obj:      # a tool definition
            n = len(json.dumps(obj))
        return n // 4 + 4
    return len(str(obj)) // 4


# ---------------------------------------------------------------- client event parsing

def _no_constants(name: str):
    raise ValueError(f"invalid JSON constant {name}")


def parse_client_event(data: str | bytes, max_bytes: int | None = None) -> tuple[Any, dict | None]:
    """(event, None) or (None, error event). Never raises: rejects oversized frames, invalid JSON,
    NaN/Infinity literals and pathological nesting (RecursionError) the way OpenAI does."""
    n = len(data)
    if max_bytes and n > max_bytes:
        return None, error_event("event_too_large", f"Event of {n} bytes exceeds the maximum of {max_bytes} bytes.")
    try:
        return json.loads(data, parse_constant=_no_constants), None
    except (ValueError, RecursionError, UnicodeDecodeError):
        return None, error_event("invalid_json", "Invalid event: failed to parse JSON value. Please check the value to "
                                 "ensure it is valid JSON. (Common errors include trailing commas, missing closing "
                                 "brackets, missing quotation marks, etc.)")


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
