"""Homograph retagging ('read') and rising yes/no-question intonation."""
from __future__ import annotations

import asyncio
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(__file__))
from engine_common import has_cuda, tts  # noqa: E402

from ort.prosody import patch_g2p, question_rises  # noqa: E402


@pytest.mark.parametrize("text,want", [
    ("You ready?", [True]),
    ("Are you ready?", [True]),
    ("Does that make sense?", [True]),
    ("That was the cart, right?", [True]),
    ("What would you do first?", [False]),
    ("Okay, so where would you click?", [False]),
    ("How about the second one?", [True]),
    ("Can you tell me why?", [True]),
    ("Great. You ready? What do you see?", [True, False]),
])
def test_question_rises(text, want):
    assert question_rises(text) == want


@pytest.fixture(scope="module")
def g2p():
    from misaki import en
    g = en.G2P(trf=False, british=False, fallback=None)
    patch_g2p(g)
    return g


def _read(g2p, s):
    return [t.phonemes for t in g2p(s)[1] if t.text.lower() == "read"][0]


@pytest.mark.parametrize("s", [
    "First, read the task.", "Whenever you're ready, read the task aloud.", "Alright, read task two.",
    "If you read the task, tell me.", "Once you read it, go ahead.", "As you read, think aloud.",
    "Please read it out loud.", "Can you read it?", "Now read the next task.",
])
def test_read_present(g2p, s):
    assert _read(g2p, s) == "ɹˈid", s


@pytest.mark.parametrize("s", [
    "I read it yesterday.", "She read it.", "You've read it already.", "Was it read clearly?",
])
def test_read_past(g2p, s):
    assert _read(g2p, s) == "ɹˈɛd", s


def _end_slope_cents(a: np.ndarray, sr: int = 24000) -> float:
    """Pitch of the last voiced fifth vs the rest (autocorrelation F0)."""
    hop, win, out = 240, 1200, []
    for i in range(0, len(a) - win, hop):
        x = a[i:i + win] - a[i:i + win].mean()
        if np.sqrt((x ** 2).mean()) < 0.01:
            continue
        c = np.correlate(x, x, "full")[win - 1:]
        lo, hi = sr // 400, sr // 80
        k = lo + int(np.argmax(c[lo:hi]))
        if c[k] > 0.3 * c[0]:
            out.append(sr / k)
    v = np.array(out)
    n = max(3, len(v) // 5)
    return float(1200 * np.log2(np.median(v[-n:]) / np.median(v[:-n])))


@pytest.mark.skipif(not has_cuda(), reason="needs the GPU engine")
def test_yes_no_question_rises_wh_question_falls():
    t = tts()
    old = t.question_rise_st
    try:
        t.question_rise_st = 5.0
        rise = _end_slope_cents(np.asarray(asyncio.run(t.synthesize("You ready?"))))
        wh = _end_slope_cents(np.asarray(asyncio.run(t.synthesize("What would you do first?"))))
        t.question_rise_st = 0
        flat = _end_slope_cents(np.asarray(asyncio.run(t.synthesize("You ready?"))))
    finally:
        t.question_rise_st = old
    assert rise > 100, rise          # Kokoro alone falls by ~400 cents here
    assert flat < 0, flat
    assert wh < 0, wh
