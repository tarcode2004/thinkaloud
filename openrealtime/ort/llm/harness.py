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

VOICE_PROMPT_V1 = (
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
VOICE_PROMPT = (
    "You are talking out loud in a live, real-time voice conversation; everything you "
    "write is spoken by a text-to-speech voice.\n"
    "- Speak naturally and briefly, like a person on a call: usually one or two short "
    "sentences.\n"
    "- Plain spoken words only: no markdown, lists, headings, emoji, code, or URLs. Say "
    "numbers, dates and symbols the way a person would say them.\n"
    "- Speak the language the instructions ask for; otherwise the user's language.\n"
    "- When you are given a text to say verbatim (word for word, exactly), say exactly that "
    "text, completely, and add nothing except an allowed short transition before it.\n"
    "- Use tools only through the tool-calling interface. Never say tool names, JSON or "
    "function syntax out loud.\n"
    "- When the situation calls for a tool, call it right away; do not ask the user to "
    "confirm something they already told you. No filler before a tool call ('Got it.', "
    "'Let me check.', 'One moment.').\n"
    "- If a tool's result decides what you should say, call the tool first and speak "
    "after you have the result. If a tool result tells you what to say, say that.\n"
    "- If the user stopped mid-sentence ('um, so I think...'), they are not finished: reply "
    "only 'Mm-hm.' and wait. Never speak for the user or continue their sentence.\n"
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
    if voice_prompt == "v1":
        text = VOICE_PROMPT_V1
    else:
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


# =========================================================================== cache layout

# Per-response instructions in realtime clients are usually the session instructions plus
# a short "what to do now" section (ThinkAloud: "...\n\n# NOW\n...").  Sent as one leading
# system message, that suffix sits *before* the whole history and breaks the provider's
# prompt-cache prefix on every turn.  The 'tail' layout keeps the stable part first and moves
# the suffix next to the end of the conversation.
_NOW_RE = re.compile(r"\n[ \t]*#{1,3}[ \t]*(?:NOW|Now|CURRENT TURN|This turn|Right now)\b[^\n]*\n")


class PrefixMemory:
    """Recently seen stable system prompts (by the same LLM object, across sessions), used to
    split ``stable + per-response suffix`` when there is no explicit '# NOW' marker."""

    def __init__(self, size: int = 8, min_chars: int = 800):
        self.size, self.min_chars = size, min_chars
        self.items: list[str] = []

    def remember(self, text: str) -> None:
        if not isinstance(text, str) or len(text) < self.min_chars:
            return
        if text in self.items:
            self.items.remove(text)
        self.items.insert(0, text)
        del self.items[self.size:]

    def longest_prefix_of(self, text: str) -> str | None:
        best = None
        for p in self.items:
            if len(p) < len(text) and text.startswith(p) and (best is None or len(p) > len(best)):
                best = p
        return best


def split_instructions(text: str, memory: PrefixMemory | None = None) -> tuple[str, str | None]:
    """(stable, per_response_suffix|None)."""
    if not isinstance(text, str):
        return text, None
    m = None
    for m in _NOW_RE.finditer(text):
        pass
    if m is not None and m.start() >= 200:
        return text[:m.start()].rstrip(), text[m.start():].strip()
    if memory is not None:
        p = memory.longest_prefix_of(text)
        if p is not None and len(text) - len(p) >= 1:
            return p, text[len(p):].strip() or None
    return text, None


def place_tail_instructions(msgs: list[dict], suffix: str) -> list[dict]:
    """Append the per-response suffix as a system message after the whole history
    (ensure_turn then adds a short user nudge, since DeepSeek continues a trailing system
    message instead of answering it).  Everything before it stays byte-identical across
    turns, and the instruction is the last thing the model reads (measured: placing it
    before the trailing user turn made the model answer the user and ignore a dictation)."""
    return msgs + [{"role": "system", "content": suffix}]


def apply_layout(msgs: list[dict], layout: str, memory: PrefixMemory | None) -> tuple[list[dict], bool]:
    """Returns (messages, split_done)."""
    if layout != "tail" or not msgs or msgs[0].get("role") != "system":
        return msgs, False
    stable, suffix = split_instructions(msgs[0].get("content"), memory)
    if memory is not None:
        memory.remember(stable)
    if not suffix:
        return msgs, False
    first = dict(msgs[0])
    first["content"] = stable
    return place_tail_instructions([first] + msgs[1:], suffix), True


def estimate_tokens(messages: list[dict], tools: list[dict] | None = None) -> int:
    n = 0
    for m in messages or []:
        c = m.get("content")
        n += len(c) if isinstance(c, str) else len(json.dumps(c or "", ensure_ascii=False))
        if m.get("tool_calls"):
            n += len(json.dumps(m["tool_calls"], ensure_ascii=False))
        n += 12
    if tools:
        n += len(json.dumps(tools, ensure_ascii=False))
    return int(n / 3.6)


def trim_history(msgs: list[dict], frac: float = 0.35, keep_last: int = 4) -> list[dict] | None:
    """Drop the oldest ~frac of the non-system conversation (never the leading system
    prompt, never the last ``keep_last`` messages, never orphaning tool results).
    Returns None when nothing can be dropped."""
    lead = 0
    while lead < len(msgs) and msgs[lead].get("role") == "system":
        lead += 1
    body = msgs[lead:]
    droppable = len(body) - keep_last
    if droppable <= 0:
        return None
    k = max(1, int(len(body) * frac))
    k = min(k, droppable)
    while k < len(body) and body[k].get("role") == "tool":
        k += 1
    if k >= len(body) - 1:
        return None
    rest = body[k:]
    note = {"role": "system", "content": OMITTED_NOTE}
    head = msgs[:lead]
    return head + ([] if any(m.get("content") == OMITTED_NOTE for m in head) else [note]) + rest


OMITTED_NOTE = "(Earlier parts of the conversation were omitted.)"


# =========================================================================== latest instruction

_STRONG = r"(?:verbatim|exactly|word for word|word-for-word|wörtlich|genau so|genau)"
_Q_OPEN, _Q_CLOSE = "\"“„«'", "\"”“»'"
_VERBATIM_RES = [
    # Say exactly: "X"  /  Read the following verbatim: "X"  /  Sag wörtlich: „X“
    re.compile(r"\b(?:say|read|ask|repeat|sag|sage|lies|frag)\b[^\"“„«\n]{0,80}?\b" + _STRONG
               + r"\b[^\"“„«\n]{0,40}?[:,]?\s*[\"“„«]([^\"”“»]{2,}?)[\"”“»]", re.I),
    # Say "X" verbatim / exactly
    re.compile(r"\b(?:say|read|ask|repeat|sag|sage)\b\s*[:,]?\s*[\"“„«]([^\"”“»]{2,}?)[\"”“»]\s*,?\s*"
               + _STRONG + r"\b", re.I),
    # Repeat after me: "X"
    re.compile(r"\brepeat after me\b\s*[:,]?\s*[\"“„«]?([^\"”“»\n]{2,}?)[\"”“»]?\s*$", re.I),
]
_COND_RE = re.compile(r"\b(?:if|unless|when|wenn|falls|otherwise)\b[^.!?\n]*$", re.I)
_SILENT_RE = re.compile(r"(?:without saying anything|do not say anything|don't say anything|"
                        r"say nothing|ohne etwas zu sagen|sag nichts)", re.I)


def _find_key(obj: Any, key: str, depth: int = 0) -> Any:
    if depth > 4:
        return None
    if isinstance(obj, dict):
        if key in obj:
            return obj
        for v in obj.values():
            r = _find_key(v, key, depth + 1)
            if r is not None:
                return r
    elif isinstance(obj, list):
        for v in obj:
            r = _find_key(v, key, depth + 1)
            if r is not None:
                return r
    return None


def _json_in(text: str) -> Any:
    if not isinstance(text, str):
        return None
    j = text.find("{")
    if j < 0:
        return None
    with contextlib.suppress(Exception):
        return json.loads(text[j:])
    end = _balanced_end(text, j)
    if end:
        with contextlib.suppress(Exception):
            return json.loads(text[j:end])
    return None


@dataclass
class VerbatimTarget:
    text: str
    strict: bool = True
    allow_transition: bool = True
    source: str = ""


def latest_region(msgs: list[dict]) -> list[dict]:
    """Messages after the model's last spoken (text) turn: what this reply responds to.
    The leading system prompt (session instructions) is never part of it."""
    j = len(msgs)
    while j > 0:
        m = msgs[j - 1]
        if m.get("role") == "assistant" and isinstance(m.get("content"), str) and \
                m["content"].strip() and not m.get("tool_calls"):
            break
        j -= 1
    lead = 1 if len(msgs) > 1 and msgs[0].get("role") == "system" else 0
    if lead and len(msgs) > lead:
        # with the 'inline' layout the per-response part lives in the first system message
        first = msgs[0].get("content")
        lead = 0 if isinstance(first, str) and _NOW_RE.search(first) else lead
    return msgs[max(j, lead):]


def find_verbatim_target(msgs: list[dict]) -> VerbatimTarget | None:
    for m in reversed(latest_region(msgs)):
        role, c = m.get("role"), m.get("content")
        if not isinstance(c, str) or not c.strip():
            continue
        if role in ("tool", "system"):
            obj = _json_in(c)
            hit = _find_key(obj, "say_verbatim") if obj is not None else None
            if hit is not None and isinstance(hit.get("say_verbatim"), str) and hit["say_verbatim"].strip():
                if hit.get("translate_to"):
                    return None
                return VerbatimTarget(hit["say_verbatim"].strip(), True, True, role + ":say_verbatim")
            if obj is not None:
                for key in ("say", "say_exactly", "speak"):
                    hit = _find_key(obj, key)
                    if hit is not None and isinstance(hit.get(key), str) and hit[key].strip():
                        return VerbatimTarget(hit[key].strip(), True, True, role + ":" + key)
        if role in ("system", "user", "tool"):
            for rx in _VERBATIM_RES:
                mm = None
                for mm in rx.finditer(c):
                    pass
                if mm is None:
                    continue
                before = c[max(0, mm.start() - 80):mm.start()]
                if _COND_RE.search(before):
                    continue
                t = mm.group(1).strip()
                if len(t) >= 2:
                    return VerbatimTarget(t, True, role != "user", role + ":quoted")
    return None


_CALL_NOW_RE = re.compile(r"\bcall\s+(?:the\s+tool\s+)?`?([A-Za-z_][\w\-]*)`?\b[^.\n]{0,120}?"
                          r"\b(?:now|right away|immediately|at once)\b", re.I)


def instructed_tool(msgs: list[dict], names: Iterable[str]) -> str | None:
    """Tool that the latest system instruction tells the model to call now, unconditionally
    ("Call set_task_outcome now ..."); None for conditional phrasing ("If ..., call X now")."""
    names = set(names)
    for m in reversed(latest_region(msgs)):
        if m.get("role") != "system" or not isinstance(m.get("content"), str):
            continue
        c = m["content"]
        for mm in _CALL_NOW_RE.finditer(c):
            if mm.group(1) not in names:
                continue
            sent_start = max(c.rfind(".", 0, mm.start()), c.rfind("\n", 0, mm.start())) + 1
            if _COND_RE.search(c[sent_start:mm.start()]) or \
                    re.search(r"\b(?:never|don't|do not|only)\b", c[sent_start:mm.start()], re.I):
                continue
            return mm.group(1)
    return None


def wants_silent_tool(msgs: list[dict]) -> bool:
    """The latest instruction says to call a tool without speaking first."""
    for m in latest_region(msgs):
        if m.get("role") == "system" and isinstance(m.get("content"), str) and \
                _SILENT_RE.search(m["content"]):
            return True
    return False


# =========================================================================== verbatim guard


def _norm_map(s: str) -> tuple[str, list[int]]:
    out, idx = [], []
    for i, ch in enumerate(s):
        if ch.isalnum():
            out.append(ch.casefold())
            idx.append(i)
    return "".join(out), idx


_TRANSITION_WORDS = {"okay", "ok", "thanks", "thank", "you", "alright", "all", "right", "so",
                     "now", "let's", "lets", "continue", "next", "great", "got", "it", "sure",
                     "mm-hm", "mhm", "good", "danke", "gut", "alles", "klar", "weiter", "also",
                     "jetzt", "vielen", "dank", "machen", "wir", "and", "then", "here's",
                     "the", "question", "first", "well"}


class VerbatimGuard:
    """Makes the spoken text match a dictated target exactly, while streaming.

    seek  : hold the (few) first characters until the model's text starts the target
            (optionally after a short transition like "Okay.") or clearly does something else
            (then pass everything through untouched: the model chose not to say it).
    track : while the model follows the target, emit the *target's* characters (exact
            punctuation); on deviation, or if the model stops early, emit the rest of the
            target and drop the model's divergent text (``repaired``).
    after : target complete; further model text is dropped when ``strict``."""

    SEEK_EXTRA = 40  # normalised chars of non-matching text after which we give up

    def __init__(self, target: VerbatimTarget, enforce: bool = False):
        self.t = target
        self.enforce = enforce  # replace a reply that never attempts the target
        self.T = target.text
        self.nT, self.mapT = _norm_map(self.T)
        self.raw = ""
        self.state = "seek" if self.nT else "off"
        self.off = 0  # normalised index in model text where the target starts
        self.emitted_T = 0
        self.emitted_raw = 0
        self.repaired = False
        self.dropped = 0
        self.transition = ""

    def feed(self, s: str) -> str:
        if not s:
            return ""
        self.raw += s
        return self._step(False)

    def finish(self) -> str:
        return self._step(True)

    def meta(self) -> dict:
        return {"source": self.t.source, "state": self.state, "repaired": self.repaired,
                "dropped_chars": self.dropped, "transition": self.transition or None}

    def _step(self, final: bool) -> str:
        nM, mapM = _norm_map(self.raw)
        out = ""
        if self.state == "off":
            out = self.raw[self.emitted_raw:]
            self.emitted_raw = len(self.raw)
            return out
        if self.state == "seek":
            K = min(len(self.nT), 12)
            pos = nM.find(self.nT[:K]) if len(nM) >= K else -1
            if pos < 0 and final and nM and self.nT.startswith(nM):
                pos = 0  # the model began the target and stopped early
            if pos < 0:
                # began the target but diverged early ("Question three" vs "Question 3"):
                # a shared prefix of >= 8 normalised chars, possibly after a transition
                P = min(8, len(self.nT))
                j = nM.find(self.nT[:P])
                if j >= 0 and (j == 0 or self._transition_ok(self.raw[:mapM[j]])):
                    pos = j
            if pos < 0:
                if not final and self._may_still_start(nM, mapM):
                    return ""
                if self.enforce:
                    self.repaired = True
                    self.dropped += len(self.raw)
                    self.emitted_raw = len(self.raw)
                    self.emitted_T = len(self.T)
                    self.state = "after"
                    return self.T
                self.state = "off"
                return self._step(final)
            self.off = pos
            if pos > 0:
                prefix = self.raw[:mapM[pos]].strip()
                words = re.findall(r"[\w'\-]+", prefix.lower())
                if self.t.allow_transition and len(words) <= 5 and \
                        all(w in _TRANSITION_WORDS for w in words):
                    self.transition = prefix
                    out = prefix
                else:
                    self.dropped += len(prefix)
                    self.repaired = True
            self.state = "track"
        if self.state == "track":
            seg = nM[self.off:]
            n = 0
            L = min(len(seg), len(self.nT))
            while n < L and seg[n] == self.nT[n]:
                n += 1
            if n == len(self.nT):
                out += self._sp(out) + self.T[self.emitted_T:]
                self.emitted_T = len(self.T)
                self.state = "after"
                end_raw = mapM[self.off + n - 1] + 1
                self.emitted_raw = end_raw
                return out + self._after(final)
            if n == len(seg) and not final:
                upto = self.mapT[n - 1] + 1 if n else 0
                piece = self.T[self.emitted_T:upto]
                if piece:
                    out += self._sp(out) + piece
                    self.emitted_T = upto
                return out
            # deviation, or the model stopped early: finish the target exactly
            self.repaired = True
            out += self._sp(out) + self.T[self.emitted_T:]
            self.emitted_T = len(self.T)
            self.state = "after"
            self.dropped += len(self.raw) - (mapM[self.off + n - 1] + 1 if n else 0)
            self.emitted_raw = len(self.raw)
            return out
        return self._after(final)

    def _sp(self, out: str) -> str:
        # space between an emitted transition and the first target characters
        return " " if self.emitted_T == 0 and self.transition else ""

    def _transition_ok(self, prefix: str) -> bool:
        words = re.findall(r"[\w'\-]+", prefix.lower())
        return len(words) <= 5 and all(w in _TRANSITION_WORDS for w in words)

    def _may_still_start(self, nM: str, mapM: list[int]) -> bool:
        """True while the model text so far can still turn into (transition +) target."""
        if self.nT.startswith(nM):
            return True
        # split off a possible partial start of the target at the end
        for L in range(min(len(nM), len(self.nT)), 0, -1):
            if nM.endswith(self.nT[:L]):
                head = self.raw[:mapM[len(nM) - L]]
                break
        else:
            head = self.raw
        words = re.findall(r"[\w'\-]+", head.lower())
        return len(words) <= 5 and all(w in _TRANSITION_WORDS for w in words)

    def _after(self, final: bool) -> str:
        rest = self.raw[self.emitted_raw:]
        self.emitted_raw = len(self.raw)
        if self.t.strict:
            if rest.strip(" \t\n.,!?"):
                self.dropped += len(rest.strip())
            return ""
        # the target's closing punctuation was already emitted
        return re.sub(r"^[^\w\s]+", "", rest) if self.T and not self.T[-1].isalnum() else rest


# =========================================================================== preamble gate

_FILLER_WORDS = {"okay", "ok", "alright", "all", "right", "got", "it", "sure", "great", "thanks",
                 "thank", "you", "perfect", "mm-hm", "mhm", "hmm", "let", "me", "check", "that",
                 "this", "one", "moment", "just", "a", "second", "sec", "so", "now", "i'll", "i",
                 "will", "note", "record", "noted", "understood", "of", "course", "certainly",
                 "gut", "danke", "alles", "klar", "verstanden", "einen", "augenblick", "moment",
                 "kurz", "ich", "schaue", "nach", "notiere", "das", "and", "well", "yes", "yeah",
                 "good", "nice", "cool", "fine", "awesome", "wonderful", "excellent",
                 "for", "look", "up", "see", "quick", "quickly", "give", "minute", "hold", "on",
                 "hang", "there", "check", "checking", "looking", "pull", "get", "right", "away",
                 "schnell", "mal", "sekunde", "gleich"}


class PreambleGate:
    """'smart' preamble policy: speech streams live, except that a reply which so far
    consists only of filler words ("Got it.", "Okay, let me check.") is held until either
    a real word follows (released immediately) or a tool call starts (dropped)."""

    MAX_WORDS = 6

    def __init__(self):
        self.buf = ""
        self.decided = False
        self.dropped = ""

    def _fillerish(self) -> bool:
        words = re.findall(r"[\w'\-]+", self.buf.lower())
        return len(words) <= self.MAX_WORDS and all(w in _FILLER_WORDS for w in words)

    def feed(self, s: str) -> str:
        if self.decided:
            return s
        self.buf += s
        if self._fillerish():
            return ""
        self.decided = True
        out, self.buf = self.buf, ""
        return out

    def on_tool(self) -> None:
        if not self.decided:
            self.dropped += self.buf
            self.buf = ""
            self.decided = True

    def finish(self) -> str:
        out, self.buf = self.buf, ""
        self.decided = True
        return out


# =========================================================================== harness


@dataclass
class HarnessOptions:
    preamble: str = "smart"  # 'allow' | 'smart' | 'suppress'
    voice_prompt: Any = True  # True | False | 'v1' | custom str
    validate: bool = True
    reask: bool = True
    recover_leaks: bool = True
    reask_max_tokens: int = 200
    instructions_layout: str = "tail"  # 'tail' (cache-friendly) | 'inline'
    verbatim_guard: str = "repair"  # 'repair' | 'enforce' | 'off'
    prefix_memory: Any = None  # PrefixMemory shared by one LLM object
    midstream_retry: bool = True  # retry once if a stream dies before anything was spoken
    instructed_tool_reask: bool = True  # "Call X now" ignored -> re-ask once with X forced
    max_trims: int = 3  # context-length errors: drop oldest history and retry

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
    def prepare(self, messages: list[dict]) -> tuple[list[dict], dict]:
        """Message pipeline (sanitise, cache-friendly layout, voice prompt, ensure a turn).
        Returns (messages, info)."""
        opt = self.opt
        msgs = sanitize_messages(messages)
        msgs, split = apply_layout(msgs, opt.instructions_layout, opt.prefix_memory)
        msgs = apply_voice_prompt(msgs, opt.voice_prompt, opt.preamble, bool(self.chat_tools)
                                  and self.mode != "none")
        if self.mode == "none" and self.chat_tools:
            msgs = flatten_tool_history(msgs)
        msgs = ensure_turn(msgs)
        return msgs, {"layout_split": split}

    async def run(self, messages: list[dict], open_stream: OpenStream) -> AsyncIterator[LLMEvent]:
        t0 = time.perf_counter()
        opt = self.opt
        msgs, info = self.prepare(messages)
        has_tools = bool(self.chat_tools) and self.mode != "none"
        preamble = opt.preamble
        if has_tools and preamble != "allow" and wants_silent_tool(msgs):
            preamble = "suppress"
        hold = has_tools and (preamble == "suppress" or self.mode in ("required", "named"))
        target = find_verbatim_target(msgs) if opt.verbatim_guard != "off" else None
        tools, tc = self.chat_tools or None, self.chat_tool_choice
        if self.mode == "none" and tools:
            # Several OpenRouter endpoints 404 on tool_choice:"none", and with tools attached DeepSeek
            # calls one anyway instead of speaking. Send no tools; tool history became plain text.
            tools, tc = None, None
        meta: dict = {}
        usage_total: dict = {}
        spoken: list[str] = []
        first_text = True
        text_ttft = None
        downgraded = False
        empty_retried = False
        midstream_retried = False
        trims = 0
        interrupted = None

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

        while True:  # one iteration per request attempt
            filt = SpeechFilter(self.names, recover=opt.recover_leaks)
            guard = VerbatimGuard(target, enforce=opt.verbatim_guard == "enforce" and
                                  target.source.startswith("system")) if target else None
            gate = PreambleGate() if (has_tools and preamble == "smart" and not hold) else None
            acc = _Acc()
            held: list[str] = []
            finish = None
            stream_error = None
            got_text = False
            n_calls_seen = 0

            def pipe(out: str, final: bool = False):
                """filter output -> verbatim guard -> preamble gate -> (held | spoken)."""
                if guard is not None:
                    out = guard.feed(out) + (guard.finish() if final else "")
                if gate is not None:
                    if len(filt.calls) > n_calls_seen:
                        gate.on_tool()
                    out = gate.feed(out) if out else ""
                    if final:
                        out += gate.finish()
                return out

            evs: list[LLMEvent] = []
            try:
                async with contextlib.aclosing(open_stream(msgs, tools, tc)) as raw:
                    async for r in raw:
                        k = r.kind
                        if k == "text":
                            got_text = got_text or bool(r.text and r.text.strip())
                            out = pipe(filt.feed(r.text))
                            n_calls_seen = len(filt.calls)
                            if out:
                                if hold:
                                    held.append(out)
                                else:
                                    yield text_event(out)
                        elif k == "tool":
                            if gate is not None:
                                gate.on_tool()
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
            except Exception as e:  # ProviderError / transport errors / timeouts
                status = getattr(e, "status", None)
                started = bool(got_text or acc.calls)
                if not started:
                    if (not downgraded and self.mode in ("required", "named") and
                            status in (400, 404, 422) and not getattr(e, "context_length", False)):
                        # no endpoint supports the forced tool_choice: emulate it
                        downgraded = True
                        if self.forced:
                            tools = [t for t in self.chat_tools
                                     if t["function"]["name"] == self.forced]
                        tc = "auto"
                        msgs = msgs + [{"role": "system", "content":
                                        f"Call the tool {self.forced or 'that fits best'} now."}]
                        msgs = ensure_turn(msgs)
                        continue
                    if getattr(e, "context_length", False) and trims < opt.max_trims:
                        t2 = trim_history(msgs, frac=(0.35, 0.6, 0.85)[min(trims, 2)])
                        if t2 is not None:
                            trims += 1
                            log.warning("context length exceeded; dropped oldest history (%d)", trims)
                            msgs = t2
                            continue
                    yield LLMEvent("error", error=_error_text(e),
                                   meta={"status": status, "code": _error_code(e), **_pub_meta(meta)})
                    return
                # failed after the first token
                if not spoken and not midstream_retried and opt.midstream_retry and \
                        not getattr(e, "account_level", False):
                    midstream_retried = True  # nothing reached the listener: start over
                    log.warning("stream died before anything was spoken (%s); retrying", e)
                    continue
                stream_error = f"{type(e).__name__}: {e}"
                interrupted = stream_error
            if (not empty_retried and stream_error is None and not got_text
                    and not acc.calls):
                # 200 OK but no content and no tool call at all (seen with DeepSeek V4 via
                # OpenRouter): such a response would leave a voice client waiting for audio
                # that never comes, so ask once more.
                empty_retried = True
                log.warning("empty completion from %s (finish=%s); retrying once",
                            meta.get("provider_slug") or meta.get("provider"), finish)
                continue
            break

        tail = pipe(filt.finish(), final=True)
        if tail:
            if hold:
                held.append(tail)
            else:
                yield text_event(tail)

        if stream_error is not None and not acc.calls and not spoken and not held and \
                not filt.calls:
            yield LLMEvent("error", error=f"stream error: {stream_error}",
                           meta=_pub_meta(meta))
            return

        # ---------------------------------------------------------- tool calls
        native = acc.result()
        if interrupted:
            # a call cut off mid-arguments is not trustworthy: keep only complete JSON
            native = [c for c in native if not parse_arguments(c["args"])[1]]
        raw_calls = [{"id": c["id"], "name": c["name"], "arguments": c["args"], "src": "native"}
                     for c in native]
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
        if not raw_calls and self.mode in ("required", "named") and opt.reask and not interrupted:
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

        # "Call X now" in the latest instruction, but the model called something else (or
        # nothing) and has not spoken: re-ask once with X forced; X replaces the other calls.
        must = instructed_tool(msgs, self.names) if (
            opt.instructed_tool_reask and has_tools and self.mode == "auto" and not interrupted
            and not spoken) else None
        if must and must not in [c["name"] for c in raw_calls]:
            reasked += 1
            try:
                _, calls3, u3, _m = await self._collect(
                    open_stream, msgs, [t for t in self.chat_tools if t["function"]["name"] == must],
                    {"type": "function", "function": {"name": must}}, opt.reask_max_tokens)
                _add_usage(usage_total, u3)
                got = [{"id": c["id"], "name": c["name"], "arguments": c["args"], "src": "instructed"}
                       for c in calls3 if c["name"] == must]
                if got:
                    dropped += [c["name"] for c in raw_calls]
                    raw_calls = got
                    if held or (gate is not None and gate.buf):
                        meta["suppressed_text"] = "".join(held)
                        held = []
                    meta["instructed_tool"] = must
            except Exception as e:
                log.info("instructed-tool re-ask failed: %s", e)

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
            if final_calls and (preamble == "suppress" or self.mode in ("required", "named")):
                meta["suppressed_text"] = "".join(held)
            else:
                for s in held:
                    yield text_event(s)
        for call in final_calls:
            yield LLMEvent("tool_call", tool_call=call)

        done_meta = _pub_meta(meta)
        done_meta.update({
            "finish_reason": "tool_calls" if final_calls else
            ("interrupted" if interrupted else (finish or "stop")),
            "text_ttft_ms": None if text_ttft is None else round(text_ttft, 1),
            "total_ms": round((time.perf_counter() - t0) * 1000, 1),
            "leaks_recovered": len([c for c in raw_calls if c.get("src") == "leak"]),
            "repaired": repaired, "reasked": reasked, "synthesized": synthesized,
            "dropped_tool_calls": dropped, "text": "".join(spoken),
            "layout_split": info["layout_split"], "preamble_policy": preamble,
        })
        if gate is not None and gate.dropped:
            done_meta["suppressed_text"] = gate.dropped
        if "suppressed_text" in meta:
            done_meta["suppressed_text"] = meta["suppressed_text"]
        if guard is not None:
            done_meta["verbatim"] = guard.meta()
        if trims:
            done_meta["history_trims"] = trims
        if meta.get("instructed_tool"):
            done_meta["instructed_tool"] = meta["instructed_tool"]
        if midstream_retried:
            done_meta["midstream_retried"] = True
        if stream_error is not None:
            done_meta["stream_error"] = stream_error
        cached = (usage_total.get("prompt_tokens_details") or {}).get("cached_tokens")
        if cached is not None:
            done_meta["cached_tokens"] = cached
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


def _error_code(e: BaseException) -> str:
    st = getattr(e, "status", None)
    if st == 402:
        return "insufficient_credits"
    if st == 401:
        return "invalid_api_key"
    if getattr(e, "context_length", False):
        return "context_length_exceeded"
    if st == 429:
        return "rate_limited"
    return "llm_error"


def _error_text(e: BaseException) -> str:
    st = getattr(e, "status", None)
    if st == 402:
        return ("OpenRouter: insufficient credits (HTTP 402). Add credits at "
                f"https://openrouter.ai/settings/credits or lower max_tokens. ({e})")
    if st == 401:
        return f"OpenRouter rejected the API key (HTTP 401): check OPENROUTER_API_KEY. ({e})"
    if st == 429:
        return f"All LLM providers are rate-limited right now (HTTP 429). ({e})"
    if getattr(e, "context_length", False):
        return f"The conversation is too long for the model's context window. ({e})"
    return f"{type(e).__name__}: {e}"


def _pub_meta(meta: dict) -> dict:
    keys = ("provider", "provider_slug", "model", "ttft_ms", "own_ttft_ms", "hedged", "hedge_won",
            "failovers", "attempts", "sticky", "prompt_tokens_est")
    return {k: meta[k] for k in keys if k in meta}
