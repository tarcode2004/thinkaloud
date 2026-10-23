"""Provider scoreboard + hedged (speculative) request racing.

Scoreboard: per-provider EWMA of time-to-first-token, EWMA absolute deviation (for a
p90-ish hedge delay), EWMA error rate and an exponential cooldown after 429/5xx.
Persisted to ~/.cache/openrealtime/providers.json (override ORT_PROVIDER_CACHE).

hedged_stream: send the request to the best provider; if no first token arrives within
the hedge delay, send the same request to the next provider and keep whichever streams
a token first, cancelling the loser (its HTTP/2 stream is reset).  Errors before the
first token fail over to the next provider immediately.

TTFT is modelled as a function of prompt size: ``ttft ≈ base + slope · uncached_k``
(uncached_k = uncached prompt tokens / 1000; cache hits count 10 %).  ``base`` is an EWMA
of size-normalised observations and ``slope`` is learned per provider with an
exponentially-forgetting least-squares fit (prior below until there is enough spread in
prompt sizes).  Hedge delays and first-token timeouts scale with the same model.

Request features (``tool_choice:required|named|none``) that an endpoint rejects with
"404 Filter by Tool Compatibility" are remembered per provider (persisted) and such
providers are skipped for requests that need the feature.
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
# bench/llm_bench.py results (TTFT, tool-call precision, --cache probe 2026-10-23).
# The scoreboard re-ranks by prompt-size-aware TTFT; the order is the tie-breaker/candidate
# set.  parasail: fastest on short prompts, caches, but only tool_choice=auto and slow
# prefill (16k tokens: 2.6 s).  azure: every tool_choice, caches, 16k in ~1.0 s.
# digitalocean: 16k in ~0.7 s, named tool_choice, cache hits intermittent.  siliconflow:
# caches, auto/none.  baidu: frequent upstream 429s, last.
DEFAULT_ORDER = ["parasail", "azure", "digitalocean", "siliconflow", "baidu"]

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

# Prefill cost prior (ms per 1000 *uncached* prompt tokens), measured 2026-10-23 with
# bench/llm_bench.py --cache (1k..16k tokens): digitalocean/azure ~15-25, parasail ~130.
DEFAULT_SLOPE_MS_PER_1K = 40.0
PRIOR_SLOPE_MS_PER_1K = {"parasail": 120.0, "azure": 25.0, "digitalocean": 20.0}
MIN_SLOPE, MAX_SLOPE = 5.0, 300.0
CACHED_TOKEN_WEIGHT = 0.1  # a cache hit still costs ~10 % of a prefill token
# hedge delay ceiling grows with the prompt: MAX_HEDGE_MS + slope * uncached_k
FIRST_TOKEN_TIMEOUT_MS = 8000.0
FIRST_TOKEN_TIMEOUT_PER_1K = 250.0
FIRST_TOKEN_TIMEOUT_CAP_MS = 30000.0

# tool_choice values each endpoint rejects with 404 "Filter by Tool Compatibility"
# (probed 2026-10-23 for deepseek-v4-flash).  Learned at runtime as well.
KNOWN_UNSUPPORTED = {
    "parasail": {"tool_choice:required", "tool_choice:named", "tool_choice:none"},
    "digitalocean": {"tool_choice:required", "tool_choice:none"},
    "siliconflow": {"tool_choice:required", "tool_choice:named"},
}
FEATURE_EXCLUDE_S = 24 * 3600.0

# Providers that reported cached_tokens > 0 in the probe (parasail, azure, siliconflow,
# gmicloud, streamlake, digitalocean intermittently).  Caches are per provider (and per
# replica), so staying on the provider of the previous turn is worth a little TTFT.
NO_CACHE = {"mancer"}


def is_context_error(msg: str) -> bool:
    m = (msg or "").lower()
    return any(k in m for k in ("context length", "context_length", "maximum context",
                                "context window", "too many tokens", "prompt is too long",
                                "reduce the length", "input is too long"))


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

    @property
    def tool_compat(self) -> bool:
        """OpenRouter removed the endpoint because it lacks a tool feature."""
        m = str(self).lower()
        return self.status == 404 and ("tool" in m or "no endpoints found" in m)

    @property
    def account_level(self) -> bool:
        """Key/credit problems: no other provider can succeed, so do not fail over."""
        return self.status in (401, 402)

    @property
    def context_length(self) -> bool:
        return self.status in (400, 413, 422, None) and is_context_error(str(self))


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
    # TTFT-vs-prompt-size model: ewma_ms is the size-normalised base (ms at 0 tokens);
    # reg = exponentially-forgotten sums [S0, Sx, Sy, Sxx, Sxy] over (k_tokens, ttft)
    slope_ms_per_1k: float | None = None
    reg: list = field(default_factory=lambda: [0.0, 0.0, 0.0, 0.0, 0.0])
    unsupported: dict = field(default_factory=dict)  # feature -> excluded until (wall)
    cache_hits: int = 0


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
    def slope(self, p: str) -> float:
        st = self.stats.get(p)
        if st and st.slope_ms_per_1k is not None:
            return st.slope_ms_per_1k
        return PRIOR_SLOPE_MS_PER_1K.get(p, DEFAULT_SLOPE_MS_PER_1K)

    @staticmethod
    def eff_k(tokens: float = 0, cached: float = 0) -> float:
        cached = min(max(cached, 0), max(tokens, 0))
        return (max(tokens, 0) - cached + CACHED_TOKEN_WEIGHT * cached) / 1000.0

    def expected_ms(self, p: str, tokens: float = 0, cached: float = 0) -> float:
        st = self.stats.get(p)
        if st and st.ewma_ms is not None:
            base = st.ewma_ms
        else:
            # priors were measured on ~250-token prompts
            base = float(PRIOR_TTFT_MS.get(p, UNKNOWN_PRIOR_MS)) - self.slope(p) * 0.25
        return max(50.0, base) + self.slope(p) * self.eff_k(tokens, cached)

    def score(self, p: str, tokens: float = 0, cached: float = 0) -> float:
        """Lower is better: expected TTFT at this prompt size + half its spread (prefer
        consistent providers) + error-rate penalty."""
        st = self.stats.get(p) or ProviderStat()
        spread = st.dev_ms if st.ewma_ms is not None else 0.0
        return self.expected_ms(p, tokens, cached) + 0.5 * spread + st.err_rate * self.err_penalty_ms

    def available(self, p: str) -> bool:
        return self.stats.get(p, ProviderStat()).cooldown_until <= self.clock()

    def supports(self, p: str, feature: str | None) -> bool:
        if not feature:
            return True
        st = self.stats.get(p)
        if st and st.unsupported.get(feature, 0) > self.clock():
            return False
        if st and feature in st.unsupported:  # learned entry expired: try again
            return True
        return feature not in KNOWN_UNSUPPORTED.get(p, ())

    def mark_unsupported(self, p: str, feature: str, ttl_s: float = FEATURE_EXCLUDE_S) -> None:
        st = self._st(p)
        st.unsupported[feature] = self.clock() + ttl_s
        st.updated = self.clock()
        self._dirty = True
        self.save()

    def ranked(self, tokens: float = 0, feature: str | None = None,
               prefer: str | None = None, prefer_bonus_ms: float = 0.0,
               prefer_cached: float = 0.0) -> list[str]:
        """Providers best-first.  Unsupported-for-``feature`` providers are dropped (unless
        nothing else is left); cooling ones go last.  ``prefer`` (the provider that served
        the previous turn, whose cache is warm) is moved to the front while it is healthy
        and its score (with ``prefer_cached`` tokens counted as cache hits) is within
        ``prefer_bonus_ms`` of the best."""
        idx = {p: i for i, p in enumerate(self.providers)}
        cands = [p for p in self.providers if self.supports(p, feature)] or list(self.providers)
        ok = [p for p in cands if self.available(p)]
        cool = [p for p in cands if not self.available(p)]
        # configured order is the tie-breaker (+ a tiny bias so equal scores keep it)
        ok.sort(key=lambda p: (self.score(p, tokens) + idx[p] * 1.0))
        cool.sort(key=lambda p: self.stats[p].cooldown_until)
        if prefer and prefer in ok and ok[0] != prefer:
            st = self.stats.get(prefer) or ProviderStat()
            if st.consecutive_errors == 0 and \
                    self.score(prefer, tokens, prefer_cached) <= self.score(ok[0], tokens) + prefer_bonus_ms:
                ok.remove(prefer)
                ok.insert(0, prefer)
        return ok + cool

    def hedge_delay_ms(self, p: str, tokens: float = 0, cached: float = 0) -> float:
        k = self.eff_k(tokens, cached)
        extra = self.slope(p) * k
        hi = MAX_HEDGE_MS + extra
        st = self.stats.get(p)
        if not st or st.ewma_ms is None or st.n < 2:
            prior = PRIOR_TTFT_MS.get(p)
            if prior is None:
                return DEFAULT_HEDGE_MS + extra
            return min(DEFAULT_HEDGE_MS + extra, max(MIN_HEDGE_MS, self.expected_ms(p, tokens, cached) * 1.6))
        # ~p90 for a roughly normal/lognormal: mean + 1.6 * mean-abs-deviation
        return min(hi, max(MIN_HEDGE_MS, self.expected_ms(p, tokens, cached) + 1.6 * st.dev_ms + 100))

    @staticmethod
    def first_token_timeout_ms(tokens: float = 0) -> float:
        return min(FIRST_TOKEN_TIMEOUT_CAP_MS,
                   FIRST_TOKEN_TIMEOUT_MS + FIRST_TOKEN_TIMEOUT_PER_1K * max(tokens, 0) / 1000)

    # ------------------------------------------------------------ updates
    def _st(self, p: str) -> ProviderStat:
        if p not in self.stats:
            self.stats[p] = ProviderStat()
        return self.stats[p]

    def record_success(self, p: str, ttft_ms: float, tokens: float = 0, cached: float = 0) -> None:
        st = self._st(p)
        k = self.eff_k(tokens, cached)
        self._fit(st, k, ttft_ms)
        base = ttft_ms - self.slope(p) * k
        a = self.alpha if st.n >= 3 else 0.5
        if st.ewma_ms is None:
            st.ewma_ms = base
            st.dev_ms = ttft_ms * 0.25
        else:
            err = base - st.ewma_ms
            st.ewma_ms += a * err
            st.dev_ms += a * (abs(err) - st.dev_ms)
        st.n += 1
        if cached:
            st.cache_hits += 1
        st.err_rate *= (1 - self.alpha)
        st.consecutive_errors = 0
        st.last_ms = ttft_ms
        st.updated = self.clock()
        self._dirty = True
        self.save()

    def _fit(self, st: ProviderStat, k: float, y: float, forget: float = 0.92) -> None:
        """Online least squares of ttft on k (forgetting factor); updates the slope only
        once the observed prompt sizes are spread enough to identify it."""
        if not isinstance(st.reg, list) or len(st.reg) != 5:
            st.reg = [0.0] * 5
        r = [v * forget for v in st.reg]
        r[0] += 1
        r[1] += k
        r[2] += y
        r[3] += k * k
        r[4] += k * y
        st.reg = r
        s0, sx, sy, sxx, sxy = r
        var = s0 * sxx - sx * sx
        if s0 >= 4 and var / (s0 * s0) >= 4.0:  # std(k) >= 2k tokens
            slope = min(MAX_SLOPE, max(MIN_SLOPE, (s0 * sxy - sx * sy) / var))
            if st.slope_ms_per_1k is None:
                # first identification: restart the base from the fit's intercept, since
                # earlier bases were normalised with the prior slope
                st.ewma_ms = max(50.0, (sy - slope * sx) / s0)
                st.dev_ms = min(st.dev_ms, 0.25 * st.ewma_ms)
            st.slope_ms_per_1k = slope

    def record_censored(self, p: str, elapsed_ms: float, tokens: float = 0, cached: float = 0) -> None:
        """Provider lost a hedge race: we only know its TTFT > elapsed_ms."""
        st = self._st(p)
        base = elapsed_ms - self.slope(p) * self.eff_k(tokens, cached)
        if st.ewma_ms is None:
            st.ewma_ms = max(base, self.expected_ms(p))
        elif base > st.ewma_ms:
            st.ewma_ms += self.alpha * (base - st.ewma_ms)
            st.dev_ms += self.alpha * (abs(base - st.ewma_ms) - st.dev_ms)
        st.updated = self.clock()
        self._dirty = True

    def record_error(self, p: str, status: int | None = None, retry_after: float | None = None,
                     message: str | None = None) -> None:
        st = self._st(p)
        st.errors += 1
        st.last_error = (message or "")[:200] or (f"HTTP {status}" if status else "error")
        st.updated = self.clock()
        self._dirty = True
        if status in (401, 402):  # account-level (key / credits): not the provider's fault
            self.save()
            return
        if status in (400, 404, 413, 422):  # request-shape problem, not provider health
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
                    "slope_ms_per_1k": round(self.slope(p), 1),
                    "dev_ms": round(s.dev_ms), "n": s.n, "err_rate": round(s.err_rate, 3),
                    "cache_hits": s.cache_hits,
                    "unsupported": sorted(f for f, t in s.unsupported.items() if t > self.clock()),
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


async def _kill_all(attempts: list["_Attempt"]) -> None:
    """Cancel every attempt *synchronously first* (so a second cancellation of the caller
    while we await cannot leave a pump task running), then wait for them and close."""
    for a in attempts:
        if not a.task.done():
            a.task.cancel()
    pending = [a.task for a in attempts if not a.task.done()]
    if pending:
        await asyncio.wait(pending, timeout=2.0)
    for a in attempts:
        if a.task.done() and not a.task.cancelled():
            a.task.exception()
        await _close(a.agen)


async def hedged_stream(open_fn: Callable[[str], Any], sb: Scoreboard, *, hedge: bool = True,
                        hedge_delay_ms: float | None = None, max_concurrent: int = 2,
                        max_attempts: int = 4, first_token_timeout_ms: float | None = None,
                        meta_factory: Callable[[dict], Any] | None = None,
                        tokens: float = 0, feature: str | None = None,
                        prefer: str | None = None, prefer_bonus_ms: float = 0.0,
                        prefer_cached: float = 0.0) -> AsyncIterator[Any]:
    """Race providers for the first token (see module doc).  ``open_fn(provider)`` must
    return an async iterator of events having an ``is_token`` attribute.  The first event
    yielded is a meta event {provider, ttft_ms, hedged, attempts}.

    ``tokens``: estimated prompt tokens (scales hedge delay / first-token timeout and the
    scoreboard's TTFT model).  ``feature``: request feature that some endpoints reject
    (``tool_choice:required`` ...); a 404 tool-compat error marks it unsupported.
    ``prefer``: sticky provider (warm prompt cache), see Scoreboard.ranked.
    Account-level errors (401/402) and context-length errors are raised at once."""
    order = sb.ranked(tokens=tokens, feature=feature, prefer=prefer,
                      prefer_bonus_ms=prefer_bonus_ms, prefer_cached=prefer_cached)
    ftt_ms = first_token_timeout_ms if first_token_timeout_ms is not None \
        else sb.first_token_timeout_ms(tokens)
    mk_meta = meta_factory or _meta_event
    loop = asyncio.get_running_loop()
    t_start = loop.time()
    attempts: list[_Attempt] = []
    nxt = 0
    last_err: BaseException | None = None

    def cached_for(p: str) -> float:
        return prefer_cached if p == prefer else 0.0

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
            deadlines = [a.t0 + ftt_ms / 1000 for a in pending]
            hedge_at = None
            if hedge and can_launch():
                lead = pending[-1]
                d = hedge_delay_ms if hedge_delay_ms is not None else \
                    sb.hedge_delay_ms(lead.provider, tokens, cached_for(lead.provider))
                hedge_at = lead.t0 + d / 1000
                deadlines.append(hedge_at)
            timeout = max(0.0, min(deadlines) - now)
            done, _ = await asyncio.wait([a.task for a in pending], timeout=timeout,
                                         return_when=asyncio.FIRST_COMPLETED)
            now = loop.time()
            if not done:
                for a in pending:
                    if now - a.t0 >= ftt_ms / 1000:
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
            fatal: BaseException | None = None
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
                a.info.update(result="error", status=status)
                if getattr(exc, "account_level", False) or getattr(exc, "context_length", False):
                    fatal = exc  # every provider would fail the same way
                elif feature and getattr(exc, "tool_compat", False):
                    sb.mark_unsupported(a.provider, feature)
                    a.info["unsupported"] = feature
                else:
                    sb.record_error(a.provider, status, getattr(exc, "retry_after", None),
                                    message=str(exc))
                log.info("provider %s failed before first token: %s", a.provider, exc)
                last_err = exc
                await _close(a.agen)
            if fatal is not None and winner is None:
                raise fatal
            if winner is None and not live() and can_launch():
                launch(False)  # immediate failover
        # winner chosen: cancel losers
        t_win = loop.time()
        for a in attempts:
            if a is not winner and not a.finished:
                a.finished = True
                await _kill(a)
                sb.record_censored(a.provider, (t_win - a.t0) * 1000, tokens, cached_for(a.provider))
                a.info["result"] = "lost"
        ttft_own = (t_win - winner.t0) * 1000
        winner.info.update(result="won", ttft_ms=round(ttft_own))
        log_attempts = [a.info for a in attempts]
        yield mk_meta({"provider_slug": winner.provider,
                       "ttft_ms": round((t_win - t_start) * 1000, 1),
                       "own_ttft_ms": round(ttft_own, 1),
                       "hedged": any(a.hedge for a in attempts), "hedge_won": winner.hedge,
                       "failovers": sum(1 for x in log_attempts if x["result"] in ("error", "timeout")),
                       "prompt_tokens_est": int(tokens),
                       "sticky": bool(prefer) and winner.provider == prefer,
                       "attempts": log_attempts})
        for r in buf:
            yield r
        if not ended:
            # success is recorded once usage (and cached_tokens) is known, if it arrives
            cached = None
            try:
                async for r in winner.agen:
                    if getattr(r, "kind", None) == "usage" and isinstance(getattr(r, "data", None), dict):
                        det = r.data.get("prompt_tokens_details") or {}
                        cached = det.get("cached_tokens") or 0
                        pt = r.data.get("prompt_tokens") or tokens
                        sb.record_success(winner.provider, ttft_own, pt, cached)
                    yield r
            except Exception as e:  # mid-stream disconnect / provider error after first token
                sb.record_error(winner.provider, getattr(e, "status", None) or 502,
                                message=f"mid-stream: {e}")
                raise
            finally:
                if cached is None:
                    sb.record_success(winner.provider, ttft_own, tokens, cached_for(winner.provider))
    finally:
        await _kill_all(attempts)
        sb.save()
