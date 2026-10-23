"""Offline tests for the provider scoreboard and hedged racing (fake providers)."""
import asyncio
import contextlib
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ort.llm.openrouter import Raw  # noqa: E402
from ort.llm.providers import ProviderError, Scoreboard, hedged_stream  # noqa: E402


class Clock:
    def __init__(self):
        self.t = 1_000_000.0

    def __call__(self):
        return self.t


def sb(providers=("a", "b", "c"), **kw):
    return Scoreboard(list(providers), cache_path=False, **kw)


# ------------------------------------------------------------------ scoreboard


def test_ranked_uses_priors_then_observations():
    s = sb(["azure", "parasail", "deepinfra"])
    assert s.ranked() == ["parasail", "azure", "deepinfra"]
    for _ in range(5):
        s.record_success("azure", 300)
    assert s.ranked()[0] == "azure"


def test_unknown_providers_keep_configured_order():
    assert sb(["x", "y", "z"]).ranked() == ["x", "y", "z"]


def test_429_cooldown_and_recovery():
    c = Clock()
    s = sb(["a", "b"], clock=c)
    s.record_error("a", 429)
    assert s.ranked() == ["b", "a"]
    c.t += 25
    assert s.ranked()[0] == "a" or s.score("a") > s.score("b")  # cooldown over
    s.record_error("a", 429, retry_after=100)
    c.t += 50
    assert not s.available("a")


def test_consecutive_errors_back_off_exponentially():
    c = Clock()
    s = sb(["a"], clock=c)
    s.record_error("a", 503)
    first = s.stats["a"].cooldown_until - c.t
    s.record_error("a", 503)
    second = s.stats["a"].cooldown_until - c.t
    assert second == 2 * first


def test_bad_request_does_not_cool_down():
    s = sb(["a"])
    s.record_error("a", 400)
    assert s.available("a")


def test_hedge_delay_bounds():
    s = sb(["a"])
    assert s.hedge_delay_ms("a") == 900  # unknown provider, no data
    for v in (500, 520, 480, 510):
        s.record_success("a", v)
    d = s.hedge_delay_ms("a")
    assert 500 < d < 900
    for v in (5000,) * 6:
        s.record_success("a", v)
    assert s.hedge_delay_ms("a") == 1200


def test_censored_only_raises():
    s = sb(["a"])
    s.record_success("a", 500)
    s.record_censored("a", 300)
    assert s.stats["a"].ewma_ms == 500
    s.record_censored("a", 1500)
    assert s.stats["a"].ewma_ms > 500


def test_persistence_roundtrip(tmp_path):
    p = tmp_path / "sub" / "providers.json"
    s = Scoreboard(["a", "b"], cache_path=p)
    s.record_success("b", 222)
    s.save(force=True)
    data = json.loads(p.read_text())
    assert data["providers"]["b"]["ewma_ms"] == 222
    s2 = Scoreboard(["a", "b"], cache_path=p)
    assert s2.stats["b"].ewma_ms == 222 and s2.ranked()[0] == "b"


def test_shared_cache_keeps_other_providers(tmp_path):
    p = tmp_path / "providers.json"
    s1 = Scoreboard(["a"], cache_path=p)
    s1.record_success("a", 100)
    s1.save(force=True)
    s2 = Scoreboard(["b"], cache_path=p)
    s2.record_success("b", 200)
    s2.save(force=True)
    s3 = Scoreboard(["a", "b"], cache_path=p)
    assert s3.stats["a"].ewma_ms == 100 and s3.stats["b"].ewma_ms == 200
    assert s3.ranked() == ["a", "b"]


def test_consistent_provider_preferred_over_spiky():
    s = sb(["spiky", "steady"])
    for v in (300, 1300, 300, 1300, 300, 1300):
        s.record_success("spiky", v)
    for v in (750,) * 6:
        s.record_success("steady", v)
    assert s.ranked()[0] == "steady"


def test_corrupt_cache_ignored(tmp_path):
    p = tmp_path / "providers.json"
    p.write_text("{not json")
    assert Scoreboard(["a"], cache_path=p).ranked() == ["a"]


# ------------------------------------------------------------------ fake providers


class Fake:
    """Fake provider stream factory with per-provider behaviour."""

    def __init__(self, spec):
        self.spec = spec  # provider -> dict(ttft=s, error=Exception|None, words=int, gap=s)
        self.started = []
        self.closed = []
        self.cancelled = []

    def __call__(self, p):
        self.started.append(p)
        sp = self.spec[p]

        async def gen():
            try:
                yield Raw("meta", data={"provider": p.upper()})
                await asyncio.sleep(sp.get("ttft", 0.0))
                if sp.get("error"):
                    raise sp["error"]
                for i in range(sp.get("words", 3)):
                    yield Raw("text", text=f"{p}{i} ")
                    await asyncio.sleep(sp.get("gap", 0.0))
                yield Raw("finish", text="stop")
            except asyncio.CancelledError:
                self.cancelled.append(p)
                raise
            finally:
                self.closed.append(p)
        return gen()


async def drain(agen):
    out = []
    async for r in agen:
        out.append(r)
    return out


def texts(evs):
    return "".join(r.text for r in evs if r.kind == "text")


@pytest.mark.asyncio
async def test_fast_primary_no_hedge():
    f = Fake({"a": {"ttft": 0.01}, "b": {"ttft": 0.0}})
    s = sb(["a", "b"])
    evs = await drain(hedged_stream(f, s, hedge_delay_ms=200))
    assert f.started == ["a"]
    assert evs[0].kind == "meta" and evs[0].data["provider_slug"] == "a"
    assert evs[0].data["hedged"] is False
    assert texts(evs) == "a0 a1 a2 "
    assert s.stats["a"].n == 1


@pytest.mark.asyncio
async def test_slow_primary_hedge_wins_and_loser_cancelled():
    f = Fake({"a": {"ttft": 2.0}, "b": {"ttft": 0.02}})
    s = sb(["a", "b"])
    t0 = asyncio.get_running_loop().time()
    evs = await drain(hedged_stream(f, s, hedge_delay_ms=50))
    dt = asyncio.get_running_loop().time() - t0
    assert f.started == ["a", "b"]
    assert texts(evs) == "b0 b1 b2 "
    assert evs[0].data["hedged"] and evs[0].data["hedge_won"]
    assert "a" in f.cancelled and "a" in f.closed
    assert dt < 0.5
    assert s.stats["a"].ewma_ms is not None  # censored observation recorded


@pytest.mark.asyncio
async def test_hedge_fired_but_primary_still_wins():
    f = Fake({"a": {"ttft": 0.08}, "b": {"ttft": 1.0}})
    s = sb(["a", "b"])
    evs = await drain(hedged_stream(f, s, hedge_delay_ms=30))
    assert f.started == ["a", "b"] and texts(evs).startswith("a0")
    assert "b" in f.cancelled
    assert not evs[0].data["hedge_won"]


@pytest.mark.asyncio
async def test_hedge_disabled():
    f = Fake({"a": {"ttft": 0.15}, "b": {"ttft": 0.0}})
    evs = await drain(hedged_stream(f, sb(["a", "b"]), hedge=False, hedge_delay_ms=10))
    assert f.started == ["a"] and texts(evs).startswith("a0")


@pytest.mark.asyncio
async def test_error_fails_over_immediately_even_without_hedge():
    f = Fake({"a": {"error": ProviderError("rate", status=429, retry_after=30)},
              "b": {"ttft": 0.0}})
    s = sb(["a", "b"])
    evs = await drain(hedged_stream(f, s, hedge=False))
    assert f.started == ["a", "b"] and texts(evs).startswith("b0")
    assert not s.available("a")
    attempts = evs[0].data["attempts"]
    assert attempts[0]["result"] == "error" and attempts[0]["status"] == 429


@pytest.mark.asyncio
async def test_all_fail_raises_last_error():
    f = Fake({p: {"error": ProviderError(f"{p} down", status=503)} for p in "abc"})
    with pytest.raises(ProviderError):
        await drain(hedged_stream(f, sb(["a", "b", "c"])))
    assert f.started == ["a", "b", "c"]


@pytest.mark.asyncio
async def test_cooling_provider_skipped_first():
    c = Clock()
    s = sb(["a", "b"], clock=c)
    s.record_error("a", 429)
    f = Fake({"a": {"ttft": 0.0}, "b": {"ttft": 0.0}})
    await drain(hedged_stream(f, s))
    assert f.started == ["b"]


@pytest.mark.asyncio
async def test_first_token_timeout():
    f = Fake({"a": {"ttft": 5}, "b": {"ttft": 5}, "c": {"ttft": 0.0}})
    s = sb(["a", "b", "c"])
    evs = await drain(hedged_stream(f, s, hedge=False, first_token_timeout_ms=40))
    assert texts(evs).startswith("c0")
    assert "a" in f.cancelled and "b" in f.cancelled


@pytest.mark.asyncio
async def test_consumer_close_cancels_everything():
    f = Fake({"a": {"ttft": 0.0, "words": 1000, "gap": 0.01}, "b": {"ttft": 3}})
    agen = hedged_stream(f, sb(["a", "b"]), hedge_delay_ms=1000)
    n = 0
    async for r in agen:
        if r.kind == "text":
            n += 1
            if n == 2:
                break
    await agen.aclose()
    assert "a" in f.closed


@pytest.mark.asyncio
async def test_consumer_task_cancel_while_waiting_first_token():
    f = Fake({"a": {"ttft": 5}, "b": {"ttft": 5}})

    async def consume():
        async with contextlib.aclosing(hedged_stream(f, sb(["a", "b"]), hedge_delay_ms=10)) as g:
            async for _ in g:
                pass

    t = asyncio.create_task(consume())
    await asyncio.sleep(0.08)
    t.cancel()
    with pytest.raises(asyncio.CancelledError):
        await t
    assert set(f.closed) == {"a", "b"}
