"""aiohttp app: OpenAI-Realtime-compatible HTTP surface.

  POST /v1/realtime/client_secrets   mint an ephemeral key (ek_...) bound to a session config
  POST /v1/realtime/sessions         beta-shaped variant ({client_secret:{value, expires_at}, ...session})
  POST /v1/realtime/calls            WebRTC: SDP offer (application/sdp, or multipart sdp+session) → answer
  POST /v1/realtime/calls/{id}/hangup
  GET  /v1/realtime                  WebSocket (?model=, or ?call_id= sideband for a WebRTC call)
  GET  /health                       liveness + counters
  GET  /                             playground (ort/static)
"""
from __future__ import annotations

import asyncio
import copy
import json
import logging
import time
from pathlib import Path

from aiohttp import web

from . import events as E
from .config import Config
from .session import SCHED, Engine, NullOutput, Session

log = logging.getLogger("ort.server")

STATE: web.AppKey["ServerState"] = web.AppKey("ort_state")
CORS_HEADERS = "Authorization, Content-Type, OpenAI-Beta, OpenAI-Organization, OpenAI-Project, X-Requested-With"


class ServerState:
    def __init__(self, cfg: Config, engine: Engine | None):
        self.cfg = cfg
        self._engine = engine
        self.tokens: dict[str, dict] = {}
        self.calls: dict[str, object] = {}
        self.sessions: set[Session] = set()
        self._reserved = 0          # slots held by WebRTC offers still being negotiated
        self.started = time.time()
        self.counters = {"sessions_total": 0, "tokens_minted": 0, "calls_total": 0}

    @property
    def engine(self) -> Engine:
        if self._engine is None:
            from .session import load_engine
            self._engine = load_engine(self.cfg)
        return self._engine

    # --- auth
    @staticmethod
    def bearer(request: web.Request) -> str | None:
        h = request.headers.get("Authorization", "")
        if h.lower().startswith("bearer "):
            return h[7:].strip() or None
        return None

    def authorize(self, key: str | None, *, allow_ephemeral: bool = True) -> tuple[bool, dict | None, str]:
        """(ok, token record or None, error message)."""
        self._expire_tokens()
        if key and key.startswith("ek_") and allow_ephemeral:
            rec = self.tokens.get(key)
            if rec is None:
                return False, None, "Invalid or expired ephemeral key."
            return True, rec, ""
        if self.cfg.api_key:
            if key != self.cfg.api_key:
                return False, None, "Incorrect API key provided."
        return True, None, ""

    def _expire_tokens(self) -> None:
        now = time.time()
        for k in [k for k, v in self.tokens.items() if v["expires_at"] < now]:
            del self.tokens[k]

    # --- sessions
    def build_session_config(self, patch: dict | None, model: str | None) -> dict:
        req_model = model or (patch or {}).get("model")
        name, _ = self.cfg.resolve_model(req_model)
        p = dict(patch or {})
        p.pop("model", None)
        return E.new_session(name, p)

    def new_session(self, token: dict | None, model: str | None, *, transport: str, output_factory=None,
                    patch: dict | None = None) -> Session:
        if token is not None:
            cfg = copy.deepcopy(token["session"])
            cfg["id"] = E.new_id("sess")
            if patch:
                E.apply_session_patch(cfg, patch)
        else:
            cfg = self.build_session_config(patch, model)
        s = Session(self.engine, self.cfg, cfg, transport=transport)
        if output_factory is not None:
            s.attach_output(output_factory(s))
        self.counters["sessions_total"] += 1
        return s

    def at_capacity(self) -> bool:
        return len(self.sessions) + self._reserved >= self.cfg.max_sessions

    def reserve(self) -> bool:
        """Hold a session slot across the awaits of an SDP negotiation (no over-admission)."""
        if self.at_capacity():
            return False
        self._reserved += 1
        return True

    def release(self) -> None:
        self._reserved = max(0, self._reserved - 1)

    def track(self, s: Session) -> None:
        self.sessions.add(s)

    def untrack(self, s: Session) -> None:
        self.sessions.discard(s)


def _err(status: int, message: str, code: str | None = None, type_: str = "invalid_request_error", param=None):
    return web.json_response({"error": {"message": message, "type": type_, "code": code, "param": param}}, status=status)


@web.middleware
async def cors_mw(request: web.Request, handler):
    state: ServerState = request.app[STATE]
    origin = request.headers.get("Origin")
    allowed = "*" in state.cfg.cors_origins or (origin and origin in state.cfg.cors_origins)
    if request.method == "OPTIONS" and request.headers.get("Access-Control-Request-Method"):
        resp = web.Response(status=204)
    else:
        try:
            resp = await handler(request)
        except web.HTTPException as e:
            resp = e
    if allowed and origin and not getattr(resp, "prepared", False):
        resp.headers["Access-Control-Allow-Origin"] = origin if "*" not in state.cfg.cors_origins else "*"
        resp.headers["Access-Control-Allow-Headers"] = request.headers.get("Access-Control-Request-Headers", CORS_HEADERS)
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
        resp.headers["Access-Control-Expose-Headers"] = "Location"
        resp.headers["Access-Control-Max-Age"] = "600"
        if "*" not in state.cfg.cors_origins:
            resp.headers["Vary"] = "Origin"
    if isinstance(resp, web.HTTPException) and not getattr(resp, "prepared", False) and resp.status >= 400:
        raise resp
    return resp


async def _json_body(request: web.Request) -> dict:
    if not request.can_read_body:
        return {}
    try:
        b = await request.json()
    except (ValueError, json.JSONDecodeError):
        raise web.HTTPBadRequest(text=json.dumps({"error": {"message": "Invalid JSON body", "type": "invalid_request_error",
                                                            "code": "invalid_json", "param": None}}), content_type="application/json")
    return b if isinstance(b, dict) else {}


async def client_secrets(request: web.Request) -> web.Response:
    state: ServerState = request.app[STATE]
    ok, _, err = state.authorize(state.bearer(request), allow_ephemeral=False)
    if not ok:
        return _err(401, err, "invalid_api_key")
    body = await _json_body(request)
    patch = body.get("session") if isinstance(body.get("session"), dict) else {}
    try:
        cfg = state.build_session_config(patch, patch.get("model"))
    except E.SessionConfigError as e:
        return _err(400, str(e), e.code, param=e.param)
    ttl = state.cfg.token_ttl_s
    ea = body.get("expires_after")
    if isinstance(ea, dict) and isinstance(ea.get("seconds"), (int, float)):
        ttl = max(10, min(7200, int(ea["seconds"])))
    now = int(time.time())
    value = E.new_id("ek", 32)
    cfg["expires_at"] = now + ttl
    state.tokens[value] = {"session": cfg, "expires_at": now + ttl, "created_at": now}
    state.counters["tokens_minted"] += 1
    return web.json_response({"value": value, "expires_at": now + ttl, "session": cfg})


async def legacy_sessions(request: web.Request) -> web.Response:
    """Beta: POST /v1/realtime/sessions → session object + client_secret."""
    state: ServerState = request.app[STATE]
    ok, _, err = state.authorize(state.bearer(request), allow_ephemeral=False)
    if not ok:
        return _err(401, err, "invalid_api_key")
    body = await _json_body(request)
    try:
        cfg = state.build_session_config(body, body.get("model"))
    except E.SessionConfigError as e:
        return _err(400, str(e), e.code, param=e.param)
    now = int(time.time())
    value = E.new_id("ek", 32)
    exp = now + state.cfg.token_ttl_s
    cfg["expires_at"] = exp
    state.tokens[value] = {"session": cfg, "expires_at": exp, "created_at": now}
    return web.json_response({**cfg, "client_secret": {"value": value, "expires_at": exp}})


async def calls(request: web.Request) -> web.Response:
    from .transport_webrtc import create_call
    state: ServerState = request.app[STATE]
    ok, token, err = state.authorize(state.bearer(request))
    if not ok:
        return _err(401, err, "invalid_api_key")
    if not state.reserve():
        return _err(503, "Too many concurrent sessions", "session_limit_reached", "server_error")
    try:
        return await _calls(request, state, token)
    finally:
        state.release()


async def _calls(request: web.Request, state: ServerState, token) -> web.Response:
    from .transport_webrtc import create_call
    ctype = request.content_type or ""
    patch = None
    if ctype.startswith("multipart/"):
        form = await request.post()
        sdp = form.get("sdp")
        if hasattr(sdp, "file"):
            sdp = sdp.file.read().decode()
        sess = form.get("session")
        if hasattr(sess, "file"):
            sess = sess.file.read().decode()
        if sess:
            try:
                patch = json.loads(sess)
            except ValueError:
                return _err(400, "Invalid 'session' JSON", "invalid_json")
    else:
        sdp = await request.text()
    if not sdp or "v=0" not in sdp:
        return _err(400, "Expected an SDP offer body", "invalid_offer")
    try:
        call = await create_call(state, sdp, token, request.query.get("model") or (patch or {}).get("model"))
    except E.SessionConfigError as e:
        return _err(400, str(e), e.code, param=e.param)
    except Exception as e:
        log.exception("SDP negotiation failed")
        return _err(400, f"SDP negotiation failed: {e}", "invalid_offer")
    if patch and token is None:
        try:
            E.apply_session_patch(call.session.config, {k: v for k, v in patch.items() if k != "model"})
            call.session._apply_turn_detection()
        except E.SessionConfigError as e:
            await call.close()
            return _err(400, str(e), e.code, param=e.param)
    state.counters["calls_total"] += 1
    return web.Response(status=201, text=call.pc.localDescription.sdp, content_type="application/sdp",
                        headers={"Location": f"/v1/realtime/calls/{call.id}"})


async def hangup(request: web.Request) -> web.Response:
    state: ServerState = request.app[STATE]
    ok, _, err = state.authorize(state.bearer(request))
    if not ok:
        return _err(401, err, "invalid_api_key")
    call = state.calls.get(request.match_info["call_id"])
    if call is None:
        return _err(404, "Call not found", "call_not_found")
    await call.close()
    return web.Response(status=200)


async def health(request: web.Request) -> web.Response:
    state: ServerState = request.app[STATE]
    eng = state._engine
    return web.json_response({
        "ok": True, "uptime_s": round(time.time() - state.started, 1), "sessions": len(state.sessions),
        "calls": len(state.calls), "engine": getattr(eng, "name", None) if eng else "not_loaded",
        "llm": state.cfg.llm, **state.counters, "scheduler": SCHED.snapshot(),
    })


async def index(request: web.Request) -> web.StreamResponse:
    state: ServerState = request.app[STATE]
    p = Path(state.cfg.static_dir) / "index.html"
    if p.is_file():
        return web.FileResponse(p)
    return web.Response(text="OpenRealtime server. See /health.", content_type="text/plain")


def create_app(cfg: Config | None = None, engine: Engine | None = None, *, warmup: bool = False) -> web.Application:
    from .transport_ws import handle_ws
    cfg = cfg or Config.from_env()
    app = web.Application(middlewares=[cors_mw], client_max_size=32 * 1024 * 1024)
    state = ServerState(cfg, engine)
    app[STATE] = state
    app.router.add_post("/v1/realtime/client_secrets", client_secrets)
    app.router.add_post("/v1/realtime/sessions", legacy_sessions)
    app.router.add_post("/v1/realtime/calls", calls)
    app.router.add_post("/v1/realtime/calls/{call_id}/hangup", hangup)
    app.router.add_get("/v1/realtime", handle_ws)
    app.router.add_get("/health", health)
    app.router.add_get("/", index)
    sd = Path(cfg.static_dir)
    if sd.is_dir():
        app.router.add_static("/static/", sd, show_index=False)

    async def _startup(app):
        if warmup:
            loop = asyncio.get_running_loop()
            t0 = time.time()
            eng = state.engine
            await loop.run_in_executor(None, eng.warmup)
            log.info("engine warm in %.1fs", time.time() - t0)
            w = getattr(eng.llm, "warmup", None)
            if callable(w):
                try:
                    r = w()
                    if asyncio.iscoroutine(r):
                        await r
                except Exception:  # pragma: no cover
                    log.warning("LLM warmup failed", exc_info=True)

    async def _cleanup(app):
        for call in list(state.calls.values()):
            await call.close()
        for s in list(state.sessions):
            await s.close()
        close = getattr(state._engine.llm if state._engine else None, "aclose", None)
        if callable(close):
            try:
                await close()
            except Exception:  # pragma: no cover
                pass

    app.on_startup.append(_startup)
    app.on_cleanup.append(_cleanup)
    return app
