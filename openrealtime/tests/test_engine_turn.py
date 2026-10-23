import numpy as np
import pytest

from engine_common import SR, clicks, feed_stream, pad, pink_noise, requires_gpu, speech16k
from ort.turn import TurnDetector

COMPLETE = "I would like to book a table for two people tomorrow evening."
INCOMPLETE = "I want to, um"


def _types(ev):
    return [e.type for e in ev]


@pytest.mark.parametrize("cfg", [{"type": "server_vad"}, {"type": "semantic_vad", "eagerness": "high"}])
def test_silence_never_starts_speech(cfg):
    td = TurnDetector(cfg)
    assert feed_stream(td, np.zeros(SR * 5, np.float32)) == []


@pytest.mark.parametrize("name,noise", [
    ("white-30dB", lambda: (np.random.default_rng(0).standard_normal(SR * 6) * 0.03).astype(np.float32)),
    ("pink-25dB", lambda: pink_noise(SR * 6, -25)),
    ("clicks", lambda: clicks(SR * 6)),
    ("hum", lambda: (0.1 * np.sin(2 * np.pi * 60 * np.arange(SR * 6) / SR)).astype(np.float32)),
])
def test_noise_does_not_trigger(name, noise):
    td = TurnDetector({"type": "server_vad"})
    ev = feed_stream(td, noise())
    assert "speech_started" not in _types(ev), name


def test_manual_mode_emits_nothing():
    td = TurnDetector(None)
    assert feed_stream(td, pink_noise(SR * 2, -10)) == []
    assert td.position_ms == 2000


@requires_gpu
def test_server_vad_events_and_timing():
    s = speech16k(COMPLETE)
    td = TurnDetector({"type": "server_vad", "silence_duration_ms": 500, "prefix_padding_ms": 300})
    ev = feed_stream(td, pad(s, 1.0, 2.0))
    assert _types(ev) == ["speech_started", "speech_stopped"]
    st, sp = ev
    voiced = np.flatnonzero(np.abs(s) > 0.02)
    onset = 1000 + voiced[0] * 1000 // SR
    true_end = 1000 + voiced[-1] * 1000 // SR
    assert abs((st.audio_ms + 300) - onset) <= 100       # audio_ms = onset - prefix_padding_ms
    assert st.detected_ms - onset <= 260                  # min_speech_ms gate, not much more
    assert abs(sp.audio_ms - true_end) < 200              # speech end, before the trailing silence
    assert 480 <= sp.detected_ms - sp.audio_ms <= 560
    assert sp.audio is not None and abs(len(sp.audio) / SR - (sp.audio_ms - st.audio_ms) / 1000) < 0.2
    np.testing.assert_array_equal(td.utterance_audio(), sp.audio)


@requires_gpu
def test_server_vad_silence_duration_respected():
    s = speech16k(COMPLETE)
    for sd in (200, 800):
        td = TurnDetector({"type": "server_vad", "silence_duration_ms": sd})
        sp = [e for e in feed_stream(td, pad(s, 0.5, 2.0)) if e.type == "speech_stopped"][0]
        assert sd - 40 <= sp.detected_ms - sp.audio_ms <= sd + 40


@requires_gpu
def test_speech_in_noise_still_detected():
    s = speech16k(COMPLETE)
    x = pad(s, 1.0, 2.0) + pink_noise(len(s) + 3 * SR, -35)
    ev = feed_stream(TurnDetector({"type": "server_vad"}), x)
    assert _types(ev) == ["speech_started", "speech_stopped"]


@requires_gpu
def test_short_blip_does_not_barge_in():
    s = speech16k("Hey.")
    # keep only ~100 ms of the voiced part: shorter than min_speech_ms
    voiced = np.flatnonzero(np.abs(s) > 0.02)
    blip = s[voiced[0]:voiced[0] + int(0.1 * SR)]
    ev = feed_stream(TurnDetector({"type": "server_vad"}), pad(blip, 0.5, 1.0))
    assert ev == []


@requires_gpu
def test_semantic_vad_complete_ends_faster_than_incomplete():
    res = {}
    for name, text in (("complete", COMPLETE), ("incomplete", INCOMPLETE)):
        td = TurnDetector({"type": "semantic_vad", "eagerness": "auto"})
        ev = feed_stream(td, pad(speech16k(text), 1.0, 9.0))
        assert _types(ev) == ["speech_started", "speech_stopped"], name
        sp = ev[1]
        res[name] = (sp.detected_ms - sp.audio_ms, sp.p_complete)
    wait_c, p_c = res["complete"]
    wait_i, p_i = res["incomplete"]
    assert p_c > 0.5 > p_i
    assert wait_c < 600
    assert wait_i > 1500
    assert wait_i <= 4000 + 100     # medium/auto max timeout


@requires_gpu
def test_semantic_vad_eagerness_ordering():
    x = pad(speech16k(INCOMPLETE), 1.0, 9.0)
    waits = {}
    for e in ("high", "medium", "low"):
        sp = [ev for ev in feed_stream(TurnDetector({"type": "semantic_vad", "eagerness": e}), x)
              if ev.type == "speech_stopped"][0]
        waits[e] = sp.detected_ms - sp.audio_ms
    assert waits["high"] < waits["medium"] < waits["low"]
    assert waits["high"] <= 2100 and waits["low"] <= 8100


@requires_gpu
def test_on_pause_hint_and_utterance_audio():
    calls = []
    td = TurnDetector({"type": "server_vad", "silence_duration_ms": 700},
                      on_pause=lambda a, s, e: calls.append((a.copy(), s, e)))
    ev = feed_stream(td, pad(speech16k(COMPLETE), 1.0, 2.0))
    sp = [e for e in ev if e.type == "speech_stopped"][0]
    assert len(calls) >= 1
    a, s, e = calls[-1]
    assert e == sp.audio_ms
    # the speculative audio is identical to the final utterance audio -> STT cache hit
    np.testing.assert_array_equal(a, sp.audio)


@requires_gpu
def test_two_turns_and_update():
    s = speech16k("Yes, please.")
    td = TurnDetector({"type": "server_vad"})
    x = np.concatenate([pad(s, 0.5, 1.5), pad(s, 0.0, 1.5)])
    assert _types(feed_stream(td, x)) == ["speech_started", "speech_stopped"] * 2
    td.update(None)
    assert feed_stream(td, x) == []
    td.update({"type": "semantic_vad", "eagerness": "high"})
    td.reset()
    assert _types(feed_stream(td, pad(s, 0.5, 3.0))) == ["speech_started", "speech_stopped"]


@requires_gpu
def test_force_stop():
    td = TurnDetector({"type": "server_vad"})
    feed_stream(td, pad(speech16k(COMPLETE), 0.5, 0.0))
    assert td.in_speech
    ev = td.force_stop()
    assert ev.type == "speech_stopped" and len(ev.audio) > SR
    assert not td.in_speech
