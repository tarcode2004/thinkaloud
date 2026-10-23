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


# ---------------------------------------------------------------- hardening
from engine_common import at_level, babble  # noqa: E402

SENT = "I would like to book a table for two people tomorrow evening."


def _speech_case(x, cfg=None):
    return _types(feed_stream(TurnDetector(cfg or {"type": "server_vad"}), x))


@requires_gpu
def test_nan_input_does_not_kill_vad():
    """Regression: NaN samples made Silero's recurrent state NaN forever: no speech ever again."""
    td = TurnDetector({"type": "server_vad"})
    bad = np.zeros(SR, np.float32)
    bad[100:200] = np.nan
    bad[300] = np.inf
    feed_stream(td, bad)
    ev = feed_stream(td, pad(speech16k(SENT), 0.5, 1.5))
    assert _types(ev) == ["speech_started", "speech_stopped"]


@requires_gpu
@pytest.mark.parametrize("name,make", [
    ("quiet -45 dBFS", lambda s: at_level(s, -45)),
    ("quiet -50 dBFS + noise", lambda s: at_level(s, -50) + pink_noise(len(s), -75)),
    ("DC +0.3", lambda s: s + 0.3),
    ("DC -0.2 + pink", lambda s: s - 0.2 + pink_noise(len(s), -45)),
    ("clipped x30", lambda s: np.clip(s * 30, -1, 1)),
    ("fan SNR 6 dB", lambda s: s + pink_noise(len(s), -30, seed=2)),
])
def test_speech_detected_under_odd_levels(name, make):
    x = make(pad(speech16k(SENT), 1.0, 2.0)).astype(np.float32)
    assert _speech_case(x) == ["speech_started", "speech_stopped"], name


def _music(n, db):
    t = np.arange(n) / SR
    y = np.zeros(n)
    notes = [220, 277, 330, 440, 330, 277]
    for k in range(int(n / (0.4 * SR))):
        s0, s1 = int(k * 0.4 * SR), min(n, int((k + 1) * 0.4 * SR))
        env = np.exp(-np.arange(s1 - s0) / SR * 4)
        for h in (1, 2, 3, 4):
            y[s0:s1] += env * np.sin(2 * np.pi * notes[k % 6] * h * t[s0:s1]) / h
    return (y / np.sqrt(np.mean(y * y)) * 10 ** (db / 20)).astype(np.float32)


@requires_gpu
@pytest.mark.parametrize("name,make", [
    ("babble8 -35", lambda n: babble(n, -35)),
    ("babble8 -45", lambda n: babble(n, -45)),
    ("music -25", lambda n: _music(n, -25)),
    ("fan -25", lambda n: pink_noise(n, -25, seed=5)),
    ("DC 0.3 + pink -40", lambda n: np.full(n, 0.3, np.float32) + pink_noise(n, -40)),
])
def test_noise_only_never_starts_a_turn(name, make):
    assert _speech_case(make(SR * 10)) == [], name


@requires_gpu
@pytest.mark.parametrize("db", [-35, -45])
def test_user_over_babble_starts_and_ends(db):
    """Babble is 'speech' to Silero: the onset must stand out from the ambient level, and the
    turn must end when the user stops (it used to run forever while the babble went on)."""
    s = speech16k(SENT)
    n = SR * 10
    x = babble(n, db)
    x[3 * SR:3 * SR + len(s)] += s
    ev = feed_stream(TurnDetector({"type": "server_vad"}), x)
    assert _types(ev) == ["speech_started", "speech_stopped"], [(e.type, e.audio_ms) for e in ev]
    user_end = 3000 + np.flatnonzero(np.abs(s) > 0.02)[-1] * 1000 // SR
    assert ev[1].detected_ms - user_end <= 2000          # 500 ms silence_duration + babble tail


@requires_gpu
@pytest.mark.parametrize("word", ["Yes.", "No.", "Okay.", "Mhm.", "Five.", "Two."])
@pytest.mark.parametrize("voice", ["af_heart", "am_michael", "bf_emma"])
def test_one_word_answers_trigger_both_events(word, voice):
    x = pad(speech16k(word, voice), 1.0, 5.0)
    for cfg in ({"type": "server_vad"}, {"type": "semantic_vad", "eagerness": "auto"}):
        ev = feed_stream(TurnDetector(cfg), x)
        assert _types(ev) == ["speech_started", "speech_stopped"], (word, voice, cfg)
        assert ev[1].audio is not None and len(ev[1].audio) > 0.2 * SR


@requires_gpu
def test_long_monologue_memory_and_smart_turn_window_bounded():
    """90 s of speech without a stop: ring buffer stays at its capacity and smart-turn only ever
    sees <= 8 s (it used to copy the whole utterance each re-score)."""
    import ort.turn as T
    seen = []
    orig = T.SmartTurn.predict
    T.SmartTurn.predict = lambda self, a: (seen.append(len(a)), orig(self, a))[1]
    try:
        td = TurnDetector({"type": "semantic_vad", "eagerness": "low"}, history_s=120)
        one = pad(speech16k("So I was thinking that maybe we could go there, and then"), 0.0, 0.45)
        x = np.tile(one, int(np.ceil(90 * SR / len(one))))
        ev = feed_stream(td, x, chunk=1600)
        assert td.ring._buf.nbytes == 120 * SR * 4
        assert seen and max(seen) <= 8 * SR
        assert _types(ev)[:1] == ["speech_started"]
    finally:
        T.SmartTurn.predict = orig


def _paused(text, after_word, gap_s):
    """`text` spoken in one go (continuation prosody), with a pause inserted after `after_word`."""
    from engine_common import tts
    from ort.audio import resample
    t = tts()
    kv, key = t.resolve("af_heart", "en")

    def synth():
        import torch
        torch.manual_seed(0)
        return t._synth(text, kv, key, 1.0, None)
    a, words = t._executor.submit(synth).result()
    ws = [w for w in words if w[0].strip()]
    k = [i for i, w in enumerate(ws) if w[0].strip(" .,").lower() == after_word][0]
    cut = int((ws[k][2] + ws[k + 1][1]) / 2 * 24000)
    r = lambda y: resample(y, 24000, SR)  # noqa: E731
    return np.concatenate([np.zeros(SR, np.float32), r(a[:cut]), np.zeros(int(gap_s * SR), np.float32),
                           r(a[cut:]), np.zeros(9 * SR, np.float32)])


@requires_gpu
@pytest.mark.parametrize("gap", [0.8, 1.5])
@pytest.mark.parametrize("eagerness", ["low", "auto"])
def test_semantic_vad_waits_through_mid_sentence_pause(gap, eagerness):
    x = _paused("So I was thinking that maybe we could go to the beach tomorrow.", "could", gap)
    ev = feed_stream(TurnDetector({"type": "semantic_vad", "eagerness": eagerness}), x)
    assert _types(ev) == ["speech_started", "speech_stopped"]


@requires_gpu
@pytest.mark.parametrize("gap", [0.8, 1.5])
@pytest.mark.parametrize("eagerness", ["low", "auto"])
def test_transcript_hint_keeps_floor_when_prosody_sounds_final(gap, eagerness):
    """smart-turn scores "I'd like to <pause>" as complete (p~0.98). With the speculative
    transcript as a hint (the session has it ~100 ms into the pause) the turn is kept."""
    x = _paused("I'd like to book a table for two.", "to", gap)
    plain = feed_stream(TurnDetector({"type": "semantic_vad", "eagerness": eagerness}), x)
    assert _types(plain).count("speech_stopped") == 2          # the problem
    td = TurnDetector({"type": "semantic_vad", "eagerness": eagerness},
                      on_pause=lambda a, s, e: td.set_transcript_hint("I'd like to."))
    ev = feed_stream(td, x)
    assert _types(ev) == ["speech_started", "speech_stopped"]


@requires_gpu
def test_transcript_hint_short_answer_ends_fast():
    x = pad(speech16k("Five.", "am_onyx"), 1.0, 6.0)
    td = TurnDetector({"type": "semantic_vad", "eagerness": "auto"},
                      on_pause=lambda a, s, e: td.set_transcript_hint("5."))
    sp = [e for e in feed_stream(td, x) if e.type == "speech_stopped"][0]
    assert sp.detected_ms - sp.audio_ms <= 700


@requires_gpu
@pytest.mark.parametrize("sd,gap,stops", [(500, 0.8, 2), (2000, 0.8, 1), (2000, 1.5, 1), (2000, 2.5, 2)])
def test_server_vad_mid_sentence_pause_follows_silence_duration(sd, gap, stops):
    x = _paused("I'd like to book a table for two.", "to", gap)
    ev = feed_stream(TurnDetector({"type": "server_vad", "silence_duration_ms": sd}), x)
    assert _types(ev).count("speech_stopped") == stops


def test_transcript_hint_classification():
    td = TurnDetector({"type": "server_vad"})
    for text, inc in [("I'd like to", True), ("I'd like to.", True), ("I want to, um", True), ("and the", True),
                      ("Ich möchte einen Tisch für", True), ("So...", True), ("Book a table.", False),
                      ("Is it open?", False), ("I need it.", False), ("Yes, I can.", False), ("", False)]:
        td.set_transcript_hint(text)
        assert td._hint_incomplete is inc, text
