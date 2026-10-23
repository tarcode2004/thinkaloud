"""Tool-calling harness for realtime voice on top of native chat-completions tools.

  * realtime <-> chat tool / tool_choice conversion
  * argument validation (jsonschema) + cheap repair + one fast re-ask; never emits
    invalid JSON
  * recovery of tool calls leaked into the text channel (DeepSeek DSML / special
    tokens, Hermes <tool_call>, ```json blocks, bare JSON, functions.name(...),
    name(...)) with a *streaming* filter that only holds back suspicious prefixes
  * spoken-text hygiene (leading whitespace, blank lines, markdown emphasis/headings)
  * realtime voice system-prompt wrapper, message sanitising
  * preamble policy: 'allow' (stream text live, like OpenAI realtime) or 'suppress'
    (speak-or-call: text in a turn that ends up calling a tool is dropped)
"""
from __future__ import annotations

import ast
import contextlib
import copy
import dataclasses
import json
import logging
import re
import secrets
import time
from dataclasses import dataclass
from typing import Any, AsyncIterator, Callable, Iterable

from . import LLMEvent, ToolCall

log = logging.getLogger("ort.llm.harness")

# =========================================================================== tools


def realtime_tools_to_chat(tools: Iterable[dict] | None) -> list[dict]:
    """[{type:'function', name, description, parameters}] -> chat-completions tools.
    Already-chat-format tools are passed through."""
    out = []
    for t in tools or []:
        if not isinstance(t, dict):
            continue
        if t.get("type", "function") != "function":
            continue  # mcp etc. are not supported by chat completions
        if isinstance(t.get("function"), dict):
            fn = dict(t["function"])
        else:
            fn = {"name": t.get("name"), "description": t.get("description") or "",
                  "parameters": t.get("parameters")}
        if not fn.get("name"):
            continue
        params = fn.get("parameters")
        if not isinstance(params, dict) or not params:
            params = {"type": "object", "properties": {}}
        elif "type" not in params:
            params = {"type": "object", **params}
        fn["parameters"] = params
        if fn.get("description") is None:
            fn["description"] = ""
        out.append({"type": "function", "function": fn})
    return out


def tool_schemas(chat_tools: list[dict]) -> dict[str, dict]:
    return {t["function"]["name"]: t["function"].get("parameters") or {} for t in chat_tools}


def convert_tool_choice(tc: Any, names: Iterable[str]) -> tuple[Any, str, str | None]:
    """Returns (chat_tool_choice, mode, forced_name); mode in auto|none|required|named."""
    names = list(names)
    if tc is None or tc == "" or tc == "auto":
        return "auto", "auto", None
    if isinstance(tc, str):
        t = tc.lower()
        if t == "none":
            return "none", "none", None
        if t in ("required", "any"):
            return "required", "required", None
        if t in names:  # bare tool name
            return {"type": "function", "function": {"name": t}}, "named", t
        return "auto", "auto", None
    if isinstance(tc, dict):
        name = None
        if isinstance(tc.get("function"), dict):
            name = tc["function"].get("name")
        name = name or tc.get("name")
        if tc.get("type") in ("function", None) and name:
            if names and name not in names:
                log.warning("tool_choice names unknown tool %r; using auto", name)
                return "auto", "auto", None
            return {"type": "function", "function": {"name": name}}, "named", name
        if tc.get("type") in ("none", "auto", "required"):
            return convert_tool_choice(tc["type"], names)
    return "auto", "auto", None


# =========================================================================== loose JSON


class _Loose:
    """Tolerant JSON-ish parser: single quotes, bare keys, trailing/missing commas,
    Python literals, comments, unterminated strings/containers (closed at EOF)."""

    def __init__(self, s: str):
        self.s = s
        self.i = 0
        self.n = len(s)

    def eof(self) -> bool:
        return self.i >= self.n

    def ws(self) -> None:
        s = self.s
        while self.i < self.n:
            c = s[self.i]
            if c.isspace():
                self.i += 1
            elif s.startswith("//", self.i):
                j = s.find("\n", self.i)
                self.i = self.n if j < 0 else j + 1
            elif s.startswith("/*", self.i):
                j = s.find("*/", self.i + 2)
                self.i = self.n if j < 0 else j + 2
            else:
                break

    def value(self) -> Any:
        self.ws()
        if self.eof():
            return None
        c = self.s[self.i]
        if c == "{":
            return self.obj()
        if c == "[":
            return self.arr()
        if c in "\"'":
            return self.string(c)
        if c in "-+.0123456789":
            return self.number()
        return self.word()

    def obj(self) -> dict:
        self.i += 1
        d: dict = {}
        while True:
            self.ws()
            if self.eof():
                return d
            c = self.s[self.i]
            if c == "}":
                self.i += 1
                return d
            if c in ",;":
                self.i += 1
                continue
            if c in "\"'":
                key = self.string(c)
            else:
                m = re.compile(r"[A-Za-z0-9_$\-]+").match(self.s, self.i)
                if not m:
                    self.i += 1
                    continue
                key = m.group(0)
                self.i = m.end()
            self.ws()
            if not self.eof() and self.s[self.i] in ":=":
                self.i += 1
            self.ws()
            if self.eof():
                d[str(key)] = None
                return d
            if self.s[self.i] in ",}":
                d[str(key)] = None
                continue
            d[str(key)] = self.value()

    def arr(self) -> list:
        self.i += 1
        a: list = []
        while True:
            self.ws()
            if self.eof():
                return a
            c = self.s[self.i]
            if c == "]":
                self.i += 1
                return a
            if c == ",":
                self.i += 1
                continue
            start = self.i
            a.append(self.value())
            if self.i == start:
                self.i += 1

    _ESC = {"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f", "/": "/", "\\": "\\",
            '"': '"', "'": "'"}

    def string(self, q: str) -> str:
        self.i += 1
        out = []
        s = self.s
        while self.i < self.n:
            c = s[self.i]
            if c == "\\" and self.i + 1 < self.n:
                e = s[self.i + 1]
                if e == "u" and self.i + 6 <= self.n:
                    try:
                        out.append(chr(int(s[self.i + 2:self.i + 6], 16)))
                        self.i += 6
                        continue
                    except ValueError:
                        pass
                out.append(self._ESC.get(e, e))
                self.i += 2
                continue
            if c == q:
                self.i += 1
                return "".join(out)
            out.append(c)
            self.i += 1
        return "".join(out)

    def number(self) -> Any:
        m = re.compile(r"[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?").match(self.s, self.i)
        if not m:
            self.i += 1
            return None
        self.i = m.end()
        t = m.group(0)
        try:
            if re.fullmatch(r"[-+]?\d+", t):
                return int(t)
            return float(t)
        except ValueError:
            return t

    _WORDS = {"true": True, "false": False, "null": None, "none": None, "undefined": None,
              "nan": None, "yes": True, "no": False}

    def word(self) -> Any:
        m = re.compile(r"[^,}\]\n]+").match(self.s, self.i)
        if not m:
            self.i += 1
            return None
        self.i = m.end()
        w = m.group(0).strip()
        lw = w.lower()
        if lw in self._WORDS:
            return self._WORDS[lw]
        return w


def loads_loose(s: str) -> Any:
    p = _Loose(s)
    p.ws()
    return p.value()


_FENCE_RE = re.compile(r"^\s*```[A-Za-z0-9_\-]*\s*\n?(.*?)\n?```\s*$", re.S)


def parse_arguments(text: Any) -> tuple[Any, bool]:
    """Parse model-produced tool arguments. Returns (value, repaired)."""
    if isinstance(text, (dict, list)):
        return text, False
    if text is None:
        return {}, True
    s = str(text).strip()
    if not s:
        return {}, True
    try:
        v = json.loads(s)
        if isinstance(v, str):  # double-encoded
            with contextlib.suppress(Exception):
                v2 = json.loads(v)
                if isinstance(v2, (dict, list)):
                    return v2, True
        return v, False
    except (json.JSONDecodeError, ValueError):
        pass
    m = _FENCE_RE.match(s)
    if m:
        s = m.group(1).strip()
        with contextlib.suppress(Exception):
            return json.loads(s), True
    j = min([x for x in (s.find("{"), s.find("[")) if x >= 0], default=-1)
    if j > 0:
        s = s[j:]
    try:
        return loads_loose(s), True
    except Exception:
        return {}, True


# =========================================================================== schema


def _types(schema: dict) -> list[str]:
    t = schema.get("type")
    if isinstance(t, list):
        return t
    if t:
        return [t]
    if "properties" in schema:
        return ["object"]
    return []


def _norm_key(k: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(k).lower())


def coerce_to_schema(v: Any, schema: dict | None) -> Any:
    """Best-effort, semantics-preserving coercion of a value toward a JSON schema."""
    if not isinstance(schema, dict) or not schema:
        return v
    for key in ("anyOf", "oneOf"):
        if key in schema and isinstance(schema[key], list) and schema[key]:
            for sub in schema[key]:
                if not schema_errors(v, sub):
                    return v
            return coerce_to_schema(v, schema[key][0])
    types = _types(schema)
    if v is None and "null" in types:
        return v
    if "enum" in schema and v not in schema["enum"]:
        enum = schema["enum"]
        sv = str(v).strip().lower() if v is not None else ""
        for e in enum:
            if str(e).strip().lower() == sv:
                return e
        for e in enum:
            if sv and (sv in str(e).lower() or str(e).lower() in sv):
                return e
        return v
    t = types[0] if types else None
    if t == "object" or (t is None and isinstance(v, dict)):
        props = schema.get("properties") or {}
        if not isinstance(v, dict):
            if v is None or v == "" or v == []:
                v = {}
            else:
                req = schema.get("required") or list(props)
                if len(req) == 1 or len(props) == 1:
                    v = {(req or list(props))[0]: v}
                else:
                    return v
        out = {}
        normmap = {_norm_key(k): k for k in props}
        for k, val in v.items():
            if k in props:
                out[k] = val
            elif _norm_key(k) in normmap and normmap[_norm_key(k)] not in v:
                out[normmap[_norm_key(k)]] = val
            elif schema.get("additionalProperties", True) is not False:
                out[k] = val
        for k, ps in props.items():
            if k in out:
                if out[k] is None and isinstance(ps, dict) and "null" not in _types(ps) \
                        and "default" in ps:
                    out[k] = copy.deepcopy(ps["default"])
                else:
                    out[k] = coerce_to_schema(out[k], ps)
            elif isinstance(ps, dict) and "default" in ps:
                out[k] = copy.deepcopy(ps["default"])
        # drop optional nulls that would fail validation
        req = set(schema.get("required") or [])
        for k in list(out):
            ps = props.get(k)
            if out[k] is None and k not in req and isinstance(ps, dict) and \
                    "null" not in _types(ps):
                del out[k]
        return out
    if t == "array":
        if not isinstance(v, list):
            v = [] if v is None or v == "" else [v]
        items = schema.get("items")
        return [coerce_to_schema(x, items) for x in v] if isinstance(items, dict) else v
    if t == "integer":
        if isinstance(v, bool):
            return int(v)
        if isinstance(v, float) and v.is_integer():
            return int(v)
        if isinstance(v, str):
            with contextlib.suppress(ValueError):
                f = float(v.strip())
                if f.is_integer():
                    return int(f)
        return v
    if t == "number":
        if isinstance(v, str):
            with contextlib.suppress(ValueError):
                return float(v.strip()) if "." in v or "e" in v.lower() else int(v.strip())
        return v
    if t == "boolean":
        if isinstance(v, str):
            lv = v.strip().lower()
            if lv in ("true", "yes", "1", "y", "on"):
                return True
            if lv in ("false", "no", "0", "n", "off", ""):
                return False
        if isinstance(v, (int, float)) and not isinstance(v, bool) and v in (0, 1):
            return bool(v)
        return v
    if t == "string":
        if isinstance(v, bool):
            return "true" if v else "false"
        if isinstance(v, (int, float)):
            return str(v)
        if isinstance(v, (dict, list)):
            return json.dumps(v, ensure_ascii=False)
        return v
    return v


_VALIDATORS: dict[str, Any] = {}


def schema_errors(v: Any, schema: dict | None) -> list[str]:
    if not isinstance(schema, dict) or not schema:
        return []
    try:
        import jsonschema
    except ImportError:  # pragma: no cover
        return []
    key = json.dumps(schema, sort_keys=True, default=str)
    val = _VALIDATORS.get(key)
    if val is None:
        try:
            cls = jsonschema.validators.validator_for(schema, default=jsonschema.Draft202012Validator)
            cls.check_schema(schema)
            val = cls(schema)
        except Exception:
            val = False  # broken schema: do not validate
        _VALIDATORS[key] = val
    if val is False:
        return []
    errs = sorted(val.iter_errors(v), key=lambda e: list(e.path))
    out = []
    for e in errs[:5]:
        path = "/".join(str(p) for p in e.path)
        out.append(f"{path or '(root)'}: {e.message}")
    return out


def synthesize_from_schema(schema: dict | None) -> Any:
    """Minimal instance satisfying the schema's required structure."""
    if not isinstance(schema, dict):
        return {}
    if "default" in schema:
        return copy.deepcopy(schema["default"])
    if "const" in schema:
        return schema["const"]
    if schema.get("enum"):
        return schema["enum"][0]
    for key in ("anyOf", "oneOf"):
        if schema.get(key):
            return synthesize_from_schema(schema[key][0])
    types = _types(schema)
    t = types[0] if types else "object"
    if t == "object":
        props = schema.get("properties") or {}
        out = {}
        for k in schema.get("required") or []:
            out[k] = synthesize_from_schema(props.get(k, {}))
        for k, ps in props.items():
            if k not in out and isinstance(ps, dict) and "default" in ps:
                out[k] = copy.deepcopy(ps["default"])
        return out
    if t == "array":
        n = int(schema.get("minItems", 0))
        return [synthesize_from_schema(schema.get("items") or {}) for _ in range(n)]
    if t == "string":
        return "x" * int(schema.get("minLength", 0))
    if t in ("integer", "number"):
        lo = schema.get("minimum", schema.get("exclusiveMinimum"))
        if lo is None:
            return 0
        return lo + (1 if "exclusiveMinimum" in schema and "minimum" not in schema else 0)
    if t == "boolean":
        return False
    return None


def repair_arguments(raw: Any, schema: dict | None) -> tuple[str, list[str], bool]:
    """Returns (json_string, remaining_errors, repaired). The string always parses."""
    v, repaired = parse_arguments(raw)
    errs = schema_errors(v, schema)
    if errs:
        v2 = coerce_to_schema(copy.deepcopy(v), schema)
        errs2 = schema_errors(v2, schema)
        if len(errs2) < len(errs) or not errs2:
            v, errs, repaired = v2, errs2, True
    if not isinstance(v, dict) and (not schema or "object" in _types(schema or {})):
        v = coerce_to_schema(v, schema) if schema else {}
        if not isinstance(v, dict):
            v = {}
        errs = schema_errors(v, schema)
        repaired = True
    return json.dumps(v, ensure_ascii=False), errs, repaired


# =========================================================================== leak parsing

_TOOL_KEYS = ("name", "function", "tool", "tool_name", "function_name", "tool_calls",
              "type", "action", "recipient_name")


def _new_call_id() -> str:
    return "call_" + secrets.token_hex(12)


def extract_calls(obj: Any, names: Iterable[str]) -> list[dict]:
    """Find {name, arguments} tool-call shaped data in a parsed JSON value."""
    names = set(names)
    out: list[dict] = []
    if isinstance(obj, list):
        for x in obj:
            out += extract_calls(x, names)
        return out
    if not isinstance(obj, dict):
        return out
    if isinstance(obj.get("tool_calls"), list):
        return extract_calls(obj["tool_calls"], names)
    if isinstance(obj.get("function"), dict):
        fn = obj["function"]
        name, args = fn.get("name"), fn.get("arguments", fn.get("parameters", {}))
    else:
        name = None
        for k in ("name", "tool", "tool_name", "function_name", "function", "recipient_name",
                  "action"):
            if isinstance(obj.get(k), str):
                name = obj[k]
                break
        args = None
        for k in ("arguments", "parameters", "args", "input", "params", "action_input"):
            if k in obj:
                args = obj[k]
                break
        if args is None:
            args = {k: v for k, v in obj.items() if k not in _TOOL_KEYS}
    if not isinstance(name, str):
        return out
    name = name.strip()
    if name.startswith("functions."):
        name = name[len("functions."):]
    if name in names:
        if isinstance(args, str):
            args, _ = parse_arguments(args)
        out.append({"name": name, "arguments": args if args is not None else {}})
    return out


def _parse_call_args(inner: str) -> Any:
    """Arguments inside name(...): JSON object or python kwargs."""
    inner = inner.strip()
    if not inner:
        return {}
    if inner[0] in "{[":
        return parse_arguments(inner)[0]
    try:
        node = ast.parse(f"f({inner})", mode="eval").body
        out = {}
        for kw in node.keywords:  # type: ignore[attr-defined]
            if kw.arg:
                try:
                    out[kw.arg] = ast.literal_eval(kw.value)
                except Exception:
                    out[kw.arg] = ast.unparse(kw.value)
        if not out and node.args:  # type: ignore[attr-defined]
            with contextlib.suppress(Exception):
                v = ast.literal_eval(node.args[0])  # type: ignore[attr-defined]
                return v if isinstance(v, dict) else {"value": v}
        return out
    except SyntaxError:
        return parse_arguments("{" + inner + "}")[0]


def _norm_special(s: str) -> str:
    """Map DeepSeek full-width special-token chars to ASCII (1:1, keeps indices)."""
    return s.replace("｜", "|").replace("▁", "_")


_DSML_INVOKE = re.compile(r"<(?:\|DSML\|)?invoke\s+name\s*=\s*[\"']([^\"']+)[\"']\s*>(.*?)"
                          r"(?:</(?:\|DSML\|)?invoke>|$)", re.S)
_DSML_PARAM = re.compile(r"<(?:\|DSML\|)?parameter\s+name\s*=\s*[\"']([^\"']+)[\"']"
                         r"(?:\s+string\s*=\s*[\"'](true|false)[\"'])?\s*>(.*?)"
                         r"(?:</(?:\|DSML\|)?parameter>|$)", re.S)
_QWEN_FN = re.compile(r"<function=([^>\s]+)\s*>(.*?)(?:</function>|$)", re.S)
_QWEN_PARAM = re.compile(r"<parameter=([^>\s]+)\s*>(.*?)(?:</parameter>|$)", re.S)


def _param_value(raw: str, string_flag: str | None) -> Any:
    raw = raw.strip("\n")
    if string_flag == "true":
        return raw
    s = raw.strip()
    try:
        return json.loads(s)
    except Exception:
        return raw if string_flag is None else loads_loose(s)


def parse_special_block(block: str, names: Iterable[str]) -> list[dict]:
    """Parse a leaked tool-call block in any of the supported textual formats."""
    names = list(names)
    b = _norm_special(block)
    calls: list[dict] = []
    # DSML / generic invoke
    for m in _DSML_INVOKE.finditer(b):
        args = {pm.group(1): _param_value(pm.group(3), pm.group(2))
                for pm in _DSML_PARAM.finditer(m.group(2))}
        if not args and m.group(2).strip().startswith(("{", "[")):
            args = parse_arguments(m.group(2).strip())[0]
        calls.append({"name": m.group(1).strip(), "arguments": args})
    if calls:
        return [c for c in calls if c["name"] in names]
    # qwen3-coder style
    for m in _QWEN_FN.finditer(b):
        body = m.group(2)
        args = {pm.group(1): _param_value(pm.group(2), None) for pm in _QWEN_PARAM.finditer(body)}
        if not args and body.strip():
            args = parse_arguments(body.strip())[0]
        calls.append({"name": m.group(1).strip(), "arguments": args})
    if calls:
        return [c for c in calls if c["name"] in names]
    # DeepSeek V3 / V3.1 special tokens
    if "<|tool_call_begin|>" in b or "<|tool_sep|>" in b:
        parts = re.split(r"<\|tool_call_begin\|>", b)
        for p in parts:
            p = re.split(r"<\|tool_call_end\|>|<\|tool_calls_end\|>", p)[0]
            if "<|tool_sep|>" not in p:
                continue
            head, _, rest = p.partition("<|tool_sep|>")
            head = re.sub(r"<\|[^|]*\|>", "", head).strip()
            if head == "function" or head == "":
                line, _, rest = rest.partition("\n")
                name = line.strip()
            else:
                name = head
            rest = rest.strip()
            m = _FENCE_RE.match(rest)
            if m:
                rest = m.group(1)
            calls.append({"name": name, "arguments": parse_arguments(rest)[0] if rest else {}})
        return [c for c in calls if c["name"] in names]
    # Hermes <tool_call>{json}</tool_call>, Kimi sections, etc.
    inner = re.sub(r"<\|?/?[A-Za-z_|]+\|?>", " ", b)
    j = inner.find("{")
    if j >= 0:
        calls = extract_calls(parse_arguments(inner[j:].strip())[0], names)
    return calls


# =========================================================================== stream filter

_OPENERS = ["<|DSML|function_calls>", "<|DSML|invoke", "<|tool_calls_begin|>",
            "<|tool_call_begin|>", "<|tool_calls_section_begin|>", "<tool_call>",
            "<tool_calls>", "<function_calls>", "<function=", "<invoke "]
_CLOSERS = {
    "<|DSML|function_calls>": ["</|DSML|function_calls>"],
    "<|DSML|invoke": ["</|DSML|function_calls>", "</|DSML|invoke>"],
    "<|tool_calls_begin|>": ["<|tool_calls_end|>"],
    "<|tool_call_begin|>": ["<|tool_calls_end|>", "<|tool_call_end|>"],
    "<|tool_calls_section_begin|>": ["<|tool_calls_section_end|>"],
    "<tool_call>": ["</tool_call>"],
    "<tool_calls>": ["</tool_calls>"],
    "<function_calls>": ["</function_calls>"],
    "<function=": ["</function>"],
    "<invoke ": ["</invoke>"],
}
_NEED = object()
_MAX_CAPTURE = 12000


def _balanced_end(s: str, start: int) -> int | None:
    """Index just past the bracket matching s[start] ('{' / '[' / '('), string-aware."""
    pairs = {"{": "}", "[": "]", "(": ")"}
    stack = []
    q = None
    i = start
    n = len(s)
    while i < n:
        c = s[i]
        if q:
            if c == "\\":
                i += 2
                continue
            if c == q:
                q = None
        elif c in "\"'":
            # apostrophes inside bare text are rare in JSON; treat ' as quote only after
            # a structural char
            if c == '"' or (i > 0 and s[i - 1] in "{[,:( "):
                q = c
        elif c in pairs:
            stack.append(pairs[c])
        elif stack and c == stack[-1]:
            stack.pop()
            if not stack:
                return i + 1
        i += 1
    return None


class SpeechFilter:
    """Streaming text filter. ``feed(delta) -> str`` returns text safe to speak now;
    ``finish() -> str`` flushes.  Recovered tool calls accumulate in ``self.calls``.

    Holds back only: a possible special token / tag ('<'), backtick runs, JSON that
    might be a tool call ('{' / '[' followed by a tool-ish key), a word that might
    start ``functions.`` or ``<tool_name>(``, and trailing whitespace."""

    def __init__(self, tool_names: Iterable[str] = (), recover: bool = True,
                 strip_markdown: bool = True):
        self.names = [n for n in tool_names if n]
        self.recover = recover
        self.strip_markdown = strip_markdown
        self.buf = ""
        self.started = False
        self.ws_hold = ""
        self.last_char = ""  # last char of raw text consumed (for boundaries)
        self.calls: list[dict] = []
        self.leaks = 0
        self.unknown_leaks = 0
        self._words = ["functions."] + [f"{n}(" for n in self.names]
        self._word_first = {w[0] for w in self._words}
        self._maxword = max(len(w) for w in self._words)

    # ----------------------------------------------------------------- public
    def feed(self, delta: str) -> str:
        if not delta:
            return ""
        self.buf += delta
        return self._drain(False)

    def finish(self) -> str:
        out = self._drain(True)
        self.ws_hold = ""
        return out

    # ----------------------------------------------------------------- core
    def _drain(self, final: bool) -> str:
        buf = self.buf
        out: list[str] = []
        start = 0
        k = 0
        n = len(buf)
        while k < n:
            r = self._match(buf, k, final, out, start)
            if r is None:
                k += 1
                continue
            if r is _NEED:
                out.append(buf[start:k])
                self.buf = buf[k:]
                return self._emit("".join(out))
            end, repl, calls = r
            out.append(buf[start:k])
            out.append(repl)
            if calls is not None:
                self.leaks += 1
                if calls:
                    self.calls.extend(calls)
                else:
                    self.unknown_leaks += 1
            start = k = end
        out.append(buf[start:])
        self.buf = ""
        return self._emit("".join(out))

    def _emit(self, s: str) -> str:
        if not s:
            return ""
        if not self.started:
            s = s.lstrip()
            if not s:
                return ""
        s = self.ws_hold + s
        s = re.sub(r"[ \t]*\n[ \t]*(\n[ \t]*)+", "\n", s)  # blank lines -> one newline
        s = re.sub(r"[ \t]{2,}", " ", s)
        if self.leaks:
            s = re.sub(r" +([,.!?;:])", r"\1", s)
        stripped = s.rstrip()
        self.ws_hold = s[len(stripped):]
        if stripped:
            self.started = True
            self.last_char = stripped[-1]
        return stripped

    def _boundary(self, buf: str, k: int, out: list[str], start: int) -> bool:
        if k > 0:
            p = buf[k - 1]
        else:
            p = self.last_char if not self.ws_hold else " "
        return not (p.isalnum() or p == "_")

    def _line_start(self, buf: str, k: int) -> bool:
        if k > 0:
            return buf[k - 1] == "\n"
        return not self.started or "\n" in self.ws_hold

    # returns None (not special) | _NEED | (end, replacement, calls|None)
    def _match(self, buf: str, k: int, final: bool, out, start):
        c = buf[k]
        if c == "<" and self.recover:
            return self._match_tag(buf, k, final)
        if c == "`":
            return self._match_backtick(buf, k, final)
        if c in "{[" and self.recover:
            return self._match_json(buf, k, final)
        if self.strip_markdown:
            if c == "*":
                j = k
                while j < len(buf) and buf[j] == "*":
                    j += 1
                if j == len(buf) and not final:
                    return _NEED  # might be '**' split across deltas; harmless either way
                # bullet "* " at line start -> drop marker and space
                if self._line_start(buf, k) and j < len(buf) and buf[j] == " " and j - k == 1:
                    j += 1
                return (j, "", None)
            if c == "#" and self._line_start(buf, k):
                j = k
                while j < len(buf) and buf[j] == "#":
                    j += 1
                if j == len(buf) and not final:
                    return _NEED
                if j < len(buf) and buf[j] == " ":
                    return (j + 1, "", None)
                return None
            if c in "-•" and self._line_start(buf, k):
                if k + 1 >= len(buf):
                    return None if final else _NEED
                if buf[k + 1] == " ":
                    return (k + 2, "", None)
                return None
        if self.recover and c in self._word_first and self._boundary(buf, k, out, start):
            return self._match_word(buf, k, final)
        return None

    def _match_tag(self, buf: str, k: int, final: bool):
        rest = buf[k:]
        norm = _norm_special(rest)
        low = norm.lower()
        for op in _OPENERS:
            if len(low) < len(op):
                if op.lower().startswith(low):
                    if final:
                        return (len(buf), "", [])  # truncated junk token
                    return _NEED
                continue
            if low.startswith(op.lower()):
                ends = [low.find(cl.lower(), len(op)) for cl in _CLOSERS[op]]
                ends = [(e, cl) for e, cl in zip(ends, _CLOSERS[op]) if e >= 0]
                if not ends:
                    if not final and len(rest) < _MAX_CAPTURE:
                        return _NEED
                    return (len(buf), "", parse_special_block(rest, self.names))
                e, cl = min(ends)
                end = e + len(cl)
                # swallow a trailing outer closer (e.g. tool_calls_end after tool_call_end)
                after = buf[k + end:]
                stripped = after.lstrip()
                na = _norm_special(stripped)
                for extra in ("<|tool_calls_end|>", "</|DSML|function_calls>",
                              "<|end_of_sentence|>"):
                    if na.startswith(extra):
                        end += (len(after) - len(stripped)) + len(extra)
                        break
                return (k + end, "", parse_special_block(rest[:end], self.names))
        if norm.startswith("<|"):
            j = norm.find("|>", 2)
            if j >= 0 and j < 80:
                return (k + j + 2, "", None)  # stray special token (e.g. end_of_sentence)
            if not final and len(norm) < 80:
                return _NEED
            return None
        if len(rest) == 1 and not final:
            return _NEED
        return None

    def _match_backtick(self, buf: str, k: int, final: bool):
        rest = buf[k:]
        if rest.startswith("```"):
            e = rest.find("```", 3)
            if e < 0:
                if not final and len(rest) < _MAX_CAPTURE:
                    return _NEED
                e = len(rest)
                end = len(rest)
            else:
                end = e + 3
            content = rest[3:e]
            first, nl, body = content.partition("\n")
            if nl and re.fullmatch(r"[A-Za-z0-9_\-]*", first.strip()):
                content = body
            content = content.strip()
            calls = self._calls_from_text(content)
            if calls:
                return (k + end, "", calls)
            if content[:1] in "{[" or "<|" in _norm_special(content):
                return (k + end, "", [])  # JSON/code that is not a known tool: never speak
            return (k + end, content, None)
        j = k
        while j < len(buf) and buf[j] == "`":
            j += 1
        if j == len(buf) and not final:
            return _NEED
        return (j, "", None)

    def _calls_from_text(self, content: str) -> list[dict]:
        if not content:
            return []
        if content[0] in "{[":
            return extract_calls(parse_arguments(content)[0], self.names)
        if "<" in content:
            calls = parse_special_block(content, self.names)
            if calls:
                return calls
        m = re.match(r"(?:functions\.)?([A-Za-z_][\w\-]*)\s*\((.*)\)\s*$", content, re.S)
        if m and m.group(1) in self.names:
            return [{"name": m.group(1), "arguments": _parse_call_args(m.group(2))}]
        return []

    def _match_json(self, buf: str, k: int, final: bool):
        n = len(buf)
        j = k + 1
        if buf[k] == "[":
            while j < n and buf[j].isspace():
                j += 1
            if j >= n:
                return None if final else _NEED
            if buf[j] != "{":
                return None
            j += 1
        while j < n and buf[j].isspace():
            j += 1
        if j >= n:
            return None if final else _NEED
        q = buf[j]
        if q not in "\"'":
            return None
        e = buf.find(q, j + 1)
        if e < 0:
            if final or n - j > 40:
                return None
            return _NEED
        key = buf[j + 1:e]
        if key not in _TOOL_KEYS:
            return None
        end = _balanced_end(buf, k)
        if end is None:
            if not final and n - k < _MAX_CAPTURE:
                return _NEED
            end = n
        calls = extract_calls(parse_arguments(buf[k:end])[0], self.names)
        if calls:
            return (end, "", calls)
        if final and end == n:
            return None
        return None

    def _match_word(self, buf: str, k: int, final: bool):
        n = len(buf)
        window = buf[k:k + self._maxword]
        cand = None
        for w in self._words:
            if len(window) < len(w):
                if w.startswith(window) and k + len(window) == n:
                    if final:
                        return None
                    return _NEED
                continue
            if window.startswith(w):
                cand = w
                break
        if cand is None:
            return None
        p = k + len(cand)
        if cand == "functions.":
            m = re.compile(r"[A-Za-z_][\w\-]*").match(buf, p)
            if not m:
                return None if (final or p < n) else _NEED
            name = m.group(0)
            p = m.end()
            if not final and re.fullmatch(r"(:\d*)?[ \t]*", buf[p:]):
                return _NEED
            # optional ":0" index (harmony-ish)
            mm = re.compile(r":\d+").match(buf, p)
            if mm:
                p = mm.end()
            while p < n and buf[p] in " \t":
                p += 1
            if p >= n:
                if not final:
                    return _NEED
                return (n, "", [{"name": name, "arguments": {}}] if name in self.names else [])
            if buf[p] not in "({":
                # "functions.foo" mentioned without args: drop the identifier
                return (p, "", [])
            opener = p
        else:
            name = cand[:-1]
            opener = p - 1
        end = _balanced_end(buf, opener)
        if end is None:
            if not final and n - k < _MAX_CAPTURE:
                return _NEED
            end = n
        inner = buf[opener + 1:end - 1] if buf[opener] == "(" else buf[opener:end]
        args = _parse_call_args(inner)
        calls = [{"name": name, "arguments": args}] if name in self.names else []
        return (end, "", calls)


# =========================================================================== prompt

VOICE_PROMPT = (
    "You are talking out loud in a live, real-time voice conversation; everything you "
    "write is spoken by a text-to-speech voice.\n"
    "- Speak naturally and briefly, like a person on a call: usually one to three short "
    "sentences.\n"
    "- Plain spoken words only: no markdown, lists, headings, emoji, code, or URLs. Say "
    "numbers, dates and symbols the way a person would say them.\n"
    "- Use tools only through the tool-calling interface. Never say tool names, JSON or "
    "function syntax out loud.\n"
    "- If a tool's result decides what you should say, call the tool first and speak "
    "after you have the result.\n"
    "- Follow the instructions below; they take priority over these style notes."
)
SUPPRESS_PROMPT = (
    "- When you call a tool, call it without speaking first: either speak, or call the "
    "tool, never a filler like 'let me check' before it."
)


def apply_voice_prompt(messages: list[dict], voice_prompt: Any, preamble: str,
                       has_tools: bool) -> list[dict]:
    if voice_prompt is False or voice_prompt is None:
        if preamble == "suppress" and has_tools:
            voice_prompt = SUPPRESS_PROMPT.lstrip("- ")
        else:
            return messages
    text = voice_prompt if isinstance(voice_prompt, str) else VOICE_PROMPT
    if voice_prompt is True and preamble == "suppress" and has_tools:
        text = text.replace("\n- Follow the instructions below",
                            "\n" + SUPPRESS_PROMPT + "\n- Follow the instructions below")
    msgs = list(messages)
    if msgs and msgs[0].get("role") in ("system", "developer") and \
            isinstance(msgs[0].get("content"), str):
        first = dict(msgs[0])
        first["role"] = "system"
        first["content"] = text + "\n\n" + first["content"]
        msgs[0] = first
    else:
        msgs.insert(0, {"role": "system", "content": text})
    return msgs


# =========================================================================== messages


def _content_text(c: Any) -> str:
    if c is None:
        return ""
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        parts = []
        for p in c:
            if isinstance(p, str):
                parts.append(p)
            elif isinstance(p, dict):
                t = p.get("text") or p.get("transcript") or ""
                if t:
                    parts.append(t)
        return "\n".join(parts)
    return str(c)


def sanitize_messages(messages: list[dict]) -> list[dict]:
    """Make a realtime-derived history acceptable to strict chat-completions providers:
    text content, tool results directly after their call, no orphan results, no
    dangling calls, no empty assistant turns, developer->system."""
    msgs: list[dict] = []
    for m in messages or []:
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        if role == "developer":
            role = "system"
        if role not in ("system", "user", "assistant", "tool"):
            continue
        mm = {"role": role}
        if role == "assistant" and m.get("tool_calls"):
            tcs = []
            for tc in m["tool_calls"]:
                fn = tc.get("function") or {}
                args = fn.get("arguments", "{}")
                if not isinstance(args, str):
                    args = json.dumps(args, ensure_ascii=False)
                tcs.append({"id": tc.get("id") or _new_call_id(), "type": "function",
                            "function": {"name": fn.get("name", ""), "arguments": args or "{}"}})
            mm["tool_calls"] = tcs
            txt = _content_text(m.get("content"))
            mm["content"] = txt if txt else None
        elif role == "tool":
            mm["tool_call_id"] = m.get("tool_call_id") or ""
            mm["content"] = _content_text(m.get("content"))
        else:
            mm["content"] = _content_text(m.get("content"))
            if role == "assistant" and not mm["content"].strip():
                continue
        if m.get("name") and role in ("user", "system"):
            mm["name"] = m["name"]
        msgs.append(mm)

    results: dict[str, dict] = {}
    for m in msgs:
        if m["role"] == "tool" and m["tool_call_id"] not in results:
            results[m["tool_call_id"]] = m
    call_ids = {tc["id"] for m in msgs if m["role"] == "assistant" for tc in m.get("tool_calls", [])}
    out: list[dict] = []
    for m in msgs:
        if m["role"] == "tool":
            if m["tool_call_id"] in call_ids:
                continue  # re-inserted after its call below
            out.append({"role": "user", "content": f"(tool result) {m['content']}"})
            continue
        out.append(m)
        for tc in m.get("tool_calls", []) if m["role"] == "assistant" else []:
            r = results.get(tc["id"])
            out.append(r if r is not None else
                       {"role": "tool", "tool_call_id": tc["id"],
                        "content": '{"status":"no result"}'})
    return out


TURN_NUDGE = "[Respond now, following the instructions above.]"


def ensure_turn(messages: list[dict]) -> list[dict]:
    """Realtime clients often request a response right after a system item (or after the
    model's own turn), e.g. the opening turn of a session.  Chat models then see no user turn
    to answer (DeepSeek V4 returns an empty completion) or treat a trailing assistant message
    as a prefill to continue.  End such histories with a short neutral user turn."""
    if messages and messages[-1].get("role") in ("system", "assistant") and not messages[-1].get("tool_calls"):
        return messages + [{"role": "user", "content": TURN_NUDGE}]
    return messages


def flatten_tool_history(messages: list[dict]) -> list[dict]:
    """Rewrite tool calls/results as plain text so a request can be sent without any tools.

    Used for tool_choice "none": providers either reject tool_choice:"none" or, when the tools are
    still attached, the model calls one anyway and barely speaks.  Without tools it simply talks."""
    out: list[dict] = []
    for m in messages:
        if m.get("role") == "tool":
            out.append({"role": "user", "content": f"[tool result] {m.get('content') or ''}"})
        elif m.get("tool_calls"):
            calls = "; ".join(f"{(c.get('function') or {}).get('name')}({(c.get('function') or {}).get('arguments') or ''})"
                              for c in m["tool_calls"])
            text = (m.get("content") or "").strip()
            out.append({"role": "assistant", "content": (text + " " if text else "") + f"[called {calls}]"})
        else:
            out.append(m)
    # Merge consecutive same-role user/assistant messages produced by the rewrite.
    merged: list[dict] = []
    for m in out:
        if merged and m.get("role") in ("user", "assistant") and merged[-1].get("role") == m.get("role") \
                and isinstance(m.get("content"), str) and isinstance(merged[-1].get("content"), str):
            merged[-1] = {**merged[-1], "content": merged[-1]["content"] + "\n" + m["content"]}
        else:
            merged.append(m)
    return merged


# =========================================================================== harness


@dataclass
class HarnessOptions:
    preamble: str = "allow"  # 'allow' | 'suppress'
    voice_prompt: Any = True  # True | False | custom str
    validate: bool = True
    reask: bool = True
    recover_leaks: bool = True
    reask_max_tokens: int = 200

    def replace(self, **kw) -> "HarnessOptions":
        known = {f.name for f in dataclasses.fields(self)}
        return dataclasses.replace(self, **{k: v for k, v in kw.items() if k in known})


OpenStream = Callable[..., Any]  # (messages, chat_tools, chat_tool_choice, max_tokens=None)


class Harness:
    def __init__(self, tools: list[dict], tool_choice: Any = "auto",
                 options: HarnessOptions | None = None):
        self.chat_tools = realtime_tools_to_chat(tools)
        self.schemas = tool_schemas(self.chat_tools)
        self.names = list(self.schemas)
        self.chat_tool_choice, self.mode, self.forced = convert_tool_choice(tool_choice, self.names)
        if not self.chat_tools:
            self.mode, self.chat_tool_choice = "none", None
        self.opt = options or HarnessOptions()

    # ------------------------------------------------------------------ helpers
    async def _collect(self, open_stream: OpenStream, msgs, tools, tc, max_tokens):
        """Non-streamed helper for re-asks: returns (text, calls, usage, meta)."""
        acc = _Acc()
        text, usage, meta = [], None, {}
        async with contextlib.aclosing(open_stream(msgs, tools, tc, max_tokens)) as raw:
            async for r in raw:
                if r.kind == "text":
                    text.append(r.text)
                elif r.kind == "tool":
                    acc.add(r)
                elif r.kind == "usage":
                    usage = r.data
                elif r.kind == "meta":
                    meta.update(r.data or {})
        return "".join(text), acc.result(), usage, meta

    def _finalize_args(self, name: str, raw: Any) -> tuple[str, list[str], bool]:
        schema = self.schemas.get(name) or {}
        if not self.opt.validate:
            v, rep = parse_arguments(raw)
            if not isinstance(v, dict):
                v, rep = {}, True
            return json.dumps(v, ensure_ascii=False), [], rep
        return repair_arguments(raw, schema)

    # ------------------------------------------------------------------ run
    async def run(self, messages: list[dict], open_stream: OpenStream) -> AsyncIterator[LLMEvent]:
        t0 = time.perf_counter()
        opt = self.opt
        msgs = sanitize_messages(messages)
        msgs = apply_voice_prompt(msgs, opt.voice_prompt, opt.preamble, bool(self.chat_tools)
                                  and self.mode != "none")
        msgs = ensure_turn(msgs)
        hold = bool(self.chat_tools) and self.mode != "none" and (
            opt.preamble == "suppress" or self.mode in ("required", "named"))
        filt = SpeechFilter(self.names, recover=opt.recover_leaks)
        acc = _Acc()
        held: list[str] = []
        spoken: list[str] = []
        meta: dict = {}
        usage_total: dict = {}
        finish = None
        stream_error = None
        text_ttft = None
        first_text = True
        tools, tc = self.chat_tools or None, self.chat_tool_choice
        if self.mode == "none" and tools:
            # Several OpenRouter endpoints 404 on tool_choice:"none", and with tools attached DeepSeek
            # calls one anyway instead of speaking. Send no tools; tool history becomes plain text.
            tools, tc = None, None
            msgs = ensure_turn(flatten_tool_history(msgs))
        downgraded = False
        empty_retried = False
        got_text = False

        def text_event(s: str) -> LLMEvent:
            nonlocal first_text, text_ttft
            ev = LLMEvent("text_delta", text=s)
            if first_text:
                first_text = False
                text_ttft = (time.perf_counter() - t0) * 1000
                ev.meta = {"provider": meta.get("provider"), "ttft_ms": meta.get("ttft_ms"),
                           "text_ttft_ms": round(text_ttft, 1)}
            spoken.append(s)
            return ev

        while True:
            try:
                async with contextlib.aclosing(open_stream(msgs, tools, tc)) as raw:
                    async for r in raw:
                        k = r.kind
                        if k == "text":
                            got_text = got_text or bool(r.text and r.text.strip())
                            out = filt.feed(r.text)
                            if out:
                                if hold:
                                    held.append(out)
                                else:
                                    yield text_event(out)
                        elif k == "tool":
                            acc.add(r)
                        elif k == "meta":
                            meta.update(r.data or {})
                        elif k == "usage":
                            _add_usage(usage_total, r.data)
                        elif k == "finish":
                            finish = r.text
                        elif k == "error":
                            stream_error = r.text
                            break
                if (not empty_retried and stream_error is None and not got_text
                        and not acc.calls):
                    # 200 OK but no content and no tool call at all (seen with DeepSeek V4 via
                    # OpenRouter): such a response would leave a voice client waiting for audio
                    # that never comes, so ask once more.
                    empty_retried = True
                    log.warning("empty completion from %s (finish=%s); retrying once",
                                meta.get("provider_slug") or meta.get("provider"), finish)
                    finish = None
                    continue
                break
            except Exception as e:  # ProviderError or transport errors before any token
                status = getattr(e, "status", None)
                if (not downgraded and self.mode in ("required", "named") and
                        status in (400, 404, 422)):
                    # endpoint does not support forced tool_choice: emulate it
                    downgraded = True
                    if self.forced:
                        tools = [t for t in self.chat_tools
                                 if t["function"]["name"] == self.forced]
                    tc = "auto"
                    msgs = msgs + [{"role": "system", "content":
                                    f"Call the tool {self.forced or 'that fits best'} now."}]
                    continue
                yield LLMEvent("error", error=f"{type(e).__name__}: {e}",
                               meta={"status": status, **_pub_meta(meta)})
                return

        tail = filt.finish()
        if tail:
            if hold:
                held.append(tail)
            else:
                yield text_event(tail)

        if stream_error is not None and not acc.calls:
            yield LLMEvent("error", error=f"stream error: {stream_error}",
                           meta=_pub_meta(meta))
            return

        # ---------------------------------------------------------- tool calls
        raw_calls = [{"id": c["id"], "name": c["name"], "arguments": c["args"], "src": "native"}
                     for c in acc.result()]
        seen = {(c["name"], _canon(c["arguments"])) for c in raw_calls}
        for c in filt.calls:
            key = (c["name"], _canon(c["arguments"]))
            if key not in seen:
                seen.add(key)
                raw_calls.append({"id": None, "name": c["name"], "arguments": c["arguments"],
                                  "src": "leak"})
        dropped = []
        if self.mode == "none":
            dropped = [c["name"] for c in raw_calls]
            raw_calls = []
        if self.mode == "named":
            dropped += [c["name"] for c in raw_calls if c["name"] != self.forced]
            raw_calls = [c for c in raw_calls if c["name"] == self.forced]
        unknown = [c for c in raw_calls if c["name"] not in self.schemas]
        dropped += [c["name"] for c in unknown]
        raw_calls = [c for c in raw_calls if c["name"] in self.schemas]

        reasked = 0
        if not raw_calls and self.mode in ("required", "named") and opt.reask:
            reasked += 1
            nudge_tools = [t for t in self.chat_tools
                           if not self.forced or t["function"]["name"] == self.forced]
            m2 = msgs + ([{"role": "assistant", "content": "".join(held)}] if held else []) + \
                [{"role": "user", "content": "(system) You must call "
                  + (f"the tool {self.forced}" if self.forced else "one of the tools")
                  + " now, with valid arguments."}]
            try:
                _, calls2, u2, _m = await self._collect(
                    open_stream, m2, nudge_tools,
                    {"type": "function", "function": {"name": self.forced}} if self.forced
                    else "required", opt.reask_max_tokens)
                _add_usage(usage_total, u2)
                raw_calls = [{"id": c["id"], "name": c["name"], "arguments": c["args"],
                              "src": "reask"} for c in calls2 if c["name"] in self.schemas]
            except Exception as e:
                log.info("tool re-ask failed: %s", e)

        final_calls: list[ToolCall] = []
        repaired = 0
        synthesized = 0
        used_ids = set()
        for c in raw_calls:
            args, errs, rep = self._finalize_args(c["name"], c["arguments"])
            if errs and opt.reask and opt.validate:
                reasked += 1
                fix = await self._reask_args(open_stream, msgs, c, args, errs)
                if fix is not None:
                    _add_usage(usage_total, fix[1])
                    args2, errs2, _ = self._finalize_args(c["name"], fix[0])
                    if not errs2:
                        args, errs, rep = args2, [], True
            if errs:
                synth = coerce_to_schema(json.loads(args), self.schemas[c["name"]])
                base = synthesize_from_schema(self.schemas[c["name"]])
                if isinstance(base, dict) and isinstance(synth, dict):
                    base.update({k: v for k, v in synth.items()})
                    if schema_errors(base, self.schemas[c["name"]]):
                        base = synthesize_from_schema(self.schemas[c["name"]])
                if schema_errors(base, self.schemas[c["name"]]):
                    log.warning("dropping tool call %s: cannot produce valid args (%s)",
                                c["name"], errs)
                    dropped.append(c["name"])
                    continue
                args, synthesized = json.dumps(base, ensure_ascii=False), synthesized + 1
            repaired += int(rep)
            cid = c["id"] if c["id"] and c["id"] not in used_ids else _new_call_id()
            used_ids.add(cid)
            final_calls.append(ToolCall(cid, c["name"], args))

        if held:
            if final_calls and (opt.preamble == "suppress" or self.mode in ("required", "named")):
                meta["suppressed_text"] = "".join(held)
            else:
                for s in held:
                    yield text_event(s)
        for call in final_calls:
            yield LLMEvent("tool_call", tool_call=call)

        done_meta = _pub_meta(meta)
        done_meta.update({
            "finish_reason": "tool_calls" if final_calls else (finish or "stop"),
            "text_ttft_ms": None if text_ttft is None else round(text_ttft, 1),
            "total_ms": round((time.perf_counter() - t0) * 1000, 1),
            "leaks_recovered": len([c for c in raw_calls if c.get("src") == "leak"]),
            "repaired": repaired, "reasked": reasked, "synthesized": synthesized,
            "dropped_tool_calls": dropped, "text": "".join(spoken),
        })
        if "suppressed_text" in meta:
            done_meta["suppressed_text"] = meta["suppressed_text"]
        if stream_error is not None:
            done_meta["stream_error"] = stream_error
        yield LLMEvent("done", usage=usage_total or None, meta=done_meta)

    async def _reask_args(self, open_stream, msgs, call, args_json, errs):
        name = call["name"]
        tool = [t for t in self.chat_tools if t["function"]["name"] == name]
        m2 = msgs + [{"role": "user", "content":
                      f"(system) Your call to {name} had invalid arguments {args_json}: "
                      f"{'; '.join(errs)}. Call {name} again with corrected arguments."}]
        try:
            _, calls, usage, _ = await self._collect(
                open_stream, m2, tool, {"type": "function", "function": {"name": name}},
                self.opt.reask_max_tokens)
        except Exception as e:
            log.info("argument re-ask failed: %s", e)
            return None
        for c in calls:
            if c["name"] == name:
                return c["args"], usage
        return None


class _Acc:
    """Thin wrapper so harness does not import openrouter (avoids a cycle)."""

    def __init__(self):
        from .openrouter import ToolCallAccumulator

        self._a = ToolCallAccumulator()

    @property
    def calls(self):
        return self._a.calls

    def add(self, r):
        self._a.add(r)

    def result(self):
        return self._a.result()


def _canon(args: Any) -> str:
    v, _ = parse_arguments(args)
    try:
        return json.dumps(v, sort_keys=True)
    except TypeError:
        return str(v)


def _add_usage(total: dict, u: dict | None) -> None:
    if not u:
        return
    for k, v in u.items():
        if isinstance(v, bool):
            continue
        if isinstance(v, (int, float)):
            total[k] = total.get(k, 0) + v
        elif isinstance(v, dict):
            sub = total.setdefault(k, {})
            if isinstance(sub, dict):
                _add_usage(sub, v)


def _pub_meta(meta: dict) -> dict:
    keys = ("provider", "provider_slug", "model", "ttft_ms", "hedged", "hedge_won", "failovers",
            "attempts")
    return {k: meta[k] for k in keys if k in meta}
