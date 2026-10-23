"""Provider scoreboard + hedged (speculative) request racing.

Scoreboard: per-provider EWMA of time-to-first-token, EWMA absolute deviation (for a
p90-ish hedge delay), EWMA error rate and an exponential cooldown after 429/5xx.
Persisted to ~/.cache/openrealtime/providers.json (override ORT_PROVIDER_CACHE).

hedged_stream: send the request to the best provider; if no first token arrives within
the hedge delay, send the same request to the next provider and keep whichever streams
a token first, cancelling the loser (its HTTP/2 stream is reset).  Errors before the
first token fail over to the next provider immediately.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator, Callable

log = logging.getLogger("ort.llm.providers")

# Default provider order for deepseek/deepseek-v4-flash (OpenRouter slugs); chosen from
# bench/llm_bench.py results (TTFT and tool-call precision).  See report in that file.
DEFAULT_ORDER = ["parasail", "baidu", "digitalocean", "azure"]

# Prior TTFT (ms) used before any live observation (measured 2026-10-22, ~250-token
# moderator prompt with one tool, reasoning disabled; see bench/llm_bench.py).
PRIOR_TTFT_MS = {
    "parasail": 450, "baidu": 690, "digitalocean": 750, "azure": 750, "wafer": 900,
    "alibaba": 1300, "siliconflow": 1000, "cloudflare": 1300, "streamlake": 1300,
    "gmicloud": 2000, "deepinfra": 2900, "venice": 1800, "atlas-cloud": 1800,
    "relace": 6200, "mancer": 5000,
}
UNKNOWN_PRIOR_MS = 1500.0
DEFAULT_HEDGE_MS = 900.0
MIN_HEDGE_MS, MAX_HEDGE_MS = 350.0, 1200.0


class ProviderError(Exception):
    def __init__(self, message: str, status: int | None = None, provider: str | None = None,
                 retry_after: float | None = None, body: Any = None):
        super().__init__(message)
        self.status = status
        self.provider = provider
        self.retry_after = retry_after
        self.body = body

    @property
    def rate_limited(self) -> bool:
        return self.status == 429

    @property
    def unsupported(self) -> bool:
        """Request shape not supported by this endpoint (e.g. tool_choice)."""
        return self.status in (400, 404, 422)


def default_cache_path() -> Path:
    p = os.environ.get("ORT_PROVIDER_CACHE")
    if p:
        return Path(p).expanduser()
    base = os.environ.get("XDG_CACHE_HOME") or "~/.cache"
    return Path(base).expanduser() / "openrealtime" / "providers.json"


@dataclass
class ProviderStat:
    ewma_ms: float | None = None
    dev_ms: float = 0.0
    n: int = 0
    err_rate: float = 0.0
    errors: int = 0
    consecutive_errors: int = 0
    cooldown_until: float = 0.0  # wall clock (time.time())
    last_ms: float | None = None
    last_error: str | None = None
    updated: float = 0.0


class Scoreboard:
    def __init__(self, providers: list[str], cache_path: str | Path | None | bool = None,
                 alpha: float = 0.3, err_penalty_ms: float = 3000.0,
                 clock: Callable[[], float] = time.time):
        self.providers = list(providers)
        self.alpha = alpha
        self.err_penalty_ms = err_penalty_ms
        self.clock = clock
        self.stats: dict[str, ProviderStat] = {p: ProviderStat() for p in self.providers}
        if cache_path is False:
            self.cache_path: Path | None = None
        else:
            self.cache_path = Path(cache_path).expanduser() if cache_path else default_cache_path()
        self._dirty = False
        self._last_save = 0.0
        self.load()

    # ------------------------------------------------------------ persistence
    def load(self) -> None:
        if not self.cache_path or not self.cache_path.exists():
            return
        try:
            data = json.loads(self.cache_path.read_text())
            for p, d in (data.get("providers") or {}).items():
                if isinstance(d, dict):  # keep every provider (other configs share the file)
                    st = ProviderStat(**{k: v for k, v in d.items()
                                         if k in ProviderStat.__dataclass_fields__})
                    # stale data: keep the estimate but let new samples move it fast
                    if self.clock() - st.updated > 6 * 3600:
                        st.n = min(st.n, 2)
                        st.err_rate *= 0.5
                    self.stats[p] = st
        except Exception as e:
            log.warning("provider cache unreadable (%s); ignoring", e)

    def save(self, force: bool = False) -> None:
        if not self.cache_path or not (self._dirty or force):
            return
        now = self.clock()
        if not force and now - self._last_save < 2.0:
            return
        try:
            self.cache_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.cache_path.with_suffix(".tmp")
            tmp.write_text(json.dumps({"version": 1, "updated": now,
                                       "providers": {p: asdict(s) for p, s in self.stats.items()}},
                                      indent=1))
            tmp.replace(self.cache_path)
            self._dirty = False
            self._last_save = now
        except OSError as e:
            log.debug("provider cache save failed: %s", e)

    # ------------------------------------------------------------ scoring
    def expected_ms(self, p: str) -> float:
        st = self.stats.get(p)
        if st and st.ewma_ms is not None:
            return st.ewma_ms
        return float(PRIOR_TTFT_MS.get(p, UNKNOWN_PRIOR_MS))

    def score(self, p: str) -> float:
        """Lower is better: expected TTFT + half its spread (prefer consistent providers)
        + error-rate penalty."""
        st = self.stats.get(p) or ProviderStat()
        spread = st.dev_ms if st.ewma_ms is not None else 0.0
        return self.expected_ms(p) + 0.5 * spread + st.err_rate * self.err_penalty_ms

    def available(self, p: str) -> bool:
        return self.stats.get(p, ProviderStat()).cooldown_until <= self.clock()

    def ranked(self) -> list[str]:
        idx = {p: i for i, p in enumerate(self.providers)}
        ok = [p for p in self.providers if self.available(p)]
        cool = [p for p in self.providers if not self.available(p)]
        # configured order is the tie-breaker (+ a tiny bias so equal scores keep it)
        ok.sort(key=lambda p: (self.score(p) + idx[p] * 1.0))
        cool.sort(key=lambda p: self.stats[p].cooldown_until)
        return ok + cool

    def hedge_delay_ms(self, p: str) -> float:
        st = self.stats.get(p)
        if not st or st.ewma_ms is None or st.n < 2:
            prior = PRIOR_TTFT_MS.get(p)
            if prior is None:
                return DEFAULT_HEDGE_MS
            return min(DEFAULT_HEDGE_MS, max(MIN_HEDGE_MS, prior * 1.6))
        # ~p90 for a roughly normal/lognormal: mean + 1.6 * mean-abs-deviation
        return min(MAX_HEDGE_MS, max(MIN_HEDGE_MS, st.ewma_ms + 1.6 * st.dev_ms + 100))

    # ------------------------------------------------------------ updates
    def _st(self, p: str) -> ProviderStat:
        if p not in self.stats:
            self.stats[p] = ProviderStat()
        return self.stats[p]

    def record_success(self, p: str, ttft_ms: float) -> None:
        st = self._st(p)
        a = self.alpha if st.n >= 3 else 0.5
        if st.ewma_ms is None:
            st.ewma_ms = ttft_ms
            st.dev_ms = ttft_ms * 0.25
        else:
            err = ttft_ms - st.ewma_ms
            st.ewma_ms += a * err
            st.dev_ms += a * (abs(err) - st.dev_ms)
        st.n += 1
        st.err_rate *= (1 - self.alpha)
        st.consecutive_errors = 0
        st.last_ms = ttft_ms
        st.updated = self.clock()
        self._dirty = True
        self.save()

    def record_censored(self, p: str, elapsed_ms: float) -> None:
        """Provider lost a hedge race: we only know its TTFT > elapsed_ms."""
        st = self._st(p)
        if st.ewma_ms is None:
            st.ewma_ms = max(elapsed_ms, self.expected_ms(p))
        elif elapsed_ms > st.ewma_ms:
            st.ewma_ms += self.alpha * (elapsed_ms - st.ewma_ms)
            st.dev_ms += self.alpha * (abs(elapsed_ms - st.ewma_ms) - st.dev_ms)
        st.updated = self.clock()
        self._dirty = True

    def record_error(self, p: str, status: int | None = None, retry_after: float | None = None,
                     message: str | None = None) -> None:
        st = self._st(p)
        st.errors += 1
        st.last_error = (message or "")[:200] or (f"HTTP {status}" if status else "error")
        st.updated = self.clock()
        self._dirty = True
        if status in (400, 404, 422):  # request-shape problem, not provider health
            st.err_rate = st.err_rate * (1 - self.alpha) + self.alpha * 0.3
            self.save()
            return
        st.consecutive_errors += 1
        st.err_rate = st.err_rate * (1 - self.alpha) + self.alpha
        k = st.consecutive_errors - 1
        if status == 429:
            cd = retry_after if retry_after else min(300.0, 20.0 * (2 ** k))
        elif status in (401, 402, 403):
            cd = 60.0
        else:  # 5xx, timeouts, connection errors
            cd = min(120.0, 5.0 * (2 ** k))
        st.cooldown_until = self.clock() + cd
        self.save()

    def snapshot(self) -> dict:
        return {p: {"ewma_ms": None if s.ewma_ms is None else round(s.ewma_ms),
                    "dev_ms": round(s.dev_ms), "n": s.n, "err_rate": round(s.err_rate, 3),
                    "cooling": not self.available(p)} for p, s in self.stats.items()}


# =========================================================================== hedging


@dataclass
class _Attempt:
    provider: str
    agen: Any
    t0: float
    task: asyncio.Task
    hedge: bool
    finished: bool = False
    info: dict = field(default_factory=dict)


async def _pump_first(agen) -> tuple[list, bool]:
    """Read until the first token (or end). Returns (buffered events, ended)."""
    buf = []
    async for r in agen:
        buf.append(r)
        if getattr(r, "is_token", False):
            return buf, False
    return buf, True


def _meta_event(data: dict):
    # late import to avoid a cycle (openrouter imports this module)
    from .openrouter import Raw

    return Raw("meta", data=data)


async def _close(agen) -> None:
    with contextlib.suppress(BaseException):
        await agen.aclose()


async def _kill(a: "_Attempt") -> None:
    """Cancel an attempt and make sure its HTTP stream is closed."""
    if not a.task.done():
        a.task.cancel()
        await asyncio.wait([a.task], timeout=2.0)  # outer cancellation still propagates
    if a.task.done() and not a.task.cancelled():
        a.task.exception()  # mark retrieved
    await _close(a.agen)


async def hedged_stream(open_fn: Callable[[str], Any], sb: Scoreboard, *, hedge: bool = True,
                        hedge_delay_ms: float | None = None, max_concurrent: int = 2,
                        max_attempts: int = 4, first_token_timeout_ms: float = 8000.0,
                        meta_factory: Callable[[dict], Any] | None = None) -> AsyncIterator[Any]:
    """Race providers for the first token (see module doc).  ``open_fn(provider)`` must
    return an async iterator of events having an ``is_token`` attribute.  The first event
    yielded is a meta event {provider, ttft_ms, hedged, attempts}."""
    order = sb.ranked()
    mk_meta = meta_factory or _meta_event
    loop = asyncio.get_running_loop()
    t_start = loop.time()
    attempts: list[_Attempt] = []
    nxt = 0
    last_err: BaseException | None = None

    def launch(is_hedge: bool) -> None:
        nonlocal nxt
        p = order[nxt]
        nxt += 1
        agen = open_fn(p)
        if not hasattr(agen, "__anext__"):
            agen = agen.__aiter__()
        a = _Attempt(p, agen, loop.time(), loop.create_task(_pump_first(agen)), is_hedge)
        a.info = {"provider": p, "start_ms": round((a.t0 - t_start) * 1000), "hedge": is_hedge}
        attempts.append(a)

    def live() -> list[_Attempt]:
        return [a for a in attempts if not a.finished]

    def can_launch() -> bool:
        return nxt < len(order) and len(attempts) < max_attempts and len(live()) < max_concurrent

    winner: _Attempt | None = None
    buf: list = []
    ended = False
    try:
        launch(False)
        while winner is None:
            pending = live()
            if not pending:
                if nxt < len(order) and len(attempts) < max_attempts:
                    launch(False)
                    continue
                raise last_err or ProviderError("all providers failed")
            now = loop.time()
            deadlines = [a.t0 + first_token_timeout_ms / 1000 for a in pending]
            hedge_at = None
            if hedge and can_launch():
                lead = pending[-1]
                d = hedge_delay_ms if hedge_delay_ms is not None else sb.hedge_delay_ms(lead.provider)
                hedge_at = lead.t0 + d / 1000
                deadlines.append(hedge_at)
            timeout = max(0.0, min(deadlines) - now)
            done, _ = await asyncio.wait([a.task for a in pending], timeout=timeout,
                                         return_when=asyncio.FIRST_COMPLETED)
            now = loop.time()
            if not done:
                for a in pending:
                    if now - a.t0 >= first_token_timeout_ms / 1000:
                        a.finished = True
                        await _kill(a)
                        sb.record_error(a.provider, None, message="first-token timeout")
                        last_err = ProviderError("first-token timeout", status=504,
                                                 provider=a.provider)
                        a.info["result"] = "timeout"
                if hedge_at is not None and now >= hedge_at and can_launch():
                    log.info("hedging: %s silent for %.0f ms -> also trying %s",
                             pending[-1].provider, (now - pending[-1].t0) * 1000, order[nxt])
                    launch(True)
                continue
            # earliest-started successful attempt wins ties
            for a in sorted((a for a in pending if a.task in done), key=lambda a: a.t0):
                a.finished = True
                exc = a.task.exception() if not a.task.cancelled() else asyncio.CancelledError()
                if exc is None:
                    if winner is None:
                        winner = a
                        buf, ended = a.task.result()
                    else:  # simultaneous second finisher: discard
                        a.info["result"] = "lost"
                        await _close(a.agen)
                    continue
                status = getattr(exc, "status", None)
                sb.record_error(a.provider, status, getattr(exc, "retry_after", None),
                                message=str(exc))
                a.info.update(result="error", status=status)
                log.info("provider %s failed before first token: %s", a.provider, exc)
                last_err = exc
                await _close(a.agen)
            if winner is None and not live() and can_launch():
                launch(False)  # immediate failover
        # winner chosen: cancel losers
        t_win = loop.time()
        for a in attempts:
            if a is not winner and not a.finished:
                a.finished = True
                await _kill(a)
                sb.record_censored(a.provider, (t_win - a.t0) * 1000)
                a.info["result"] = "lost"
        ttft_own = (t_win - winner.t0) * 1000
        if not ended:
            sb.record_success(winner.provider, ttft_own)
        winner.info.update(result="won", ttft_ms=round(ttft_own))
        log_attempts = [a.info for a in attempts]
        yield mk_meta({"provider_slug": winner.provider,
                       "ttft_ms": round((t_win - t_start) * 1000, 1),
                       "hedged": any(a.hedge for a in attempts), "hedge_won": winner.hedge,
                       "failovers": sum(1 for x in log_attempts if x["result"] in ("error", "timeout")),
                       "attempts": log_attempts})
        for r in buf:
            yield r
        if not ended:
            async for r in winner.agen:
                yield r
    finally:
        for a in attempts:
            await _kill(a)
        sb.save()
