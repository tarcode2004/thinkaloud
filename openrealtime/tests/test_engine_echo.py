"""Echo gating: assistant audio leaking from the speaker into the mic must not barge in, a user
talking over it must. The detector is told what is played via `push_playback`."""
import numpy as np
import pytest

from engine_common import SR, feed_stream, pink_noise, requires_gpu, room_echo, speech16k
from ort.turn import TurnDetector

pytestmark = requires_gpu

ASSISTANT = ("Sure, I can help with that. Let me look up the opening hours of the restaurant for you, "
             "it should only take a second. They are open from noon until ten in the evening, every day "
             "except Monday.")
USER = "Wait, actually I wanted to ask about something else."
LEAD = 1.0          # s of mic audio before the assistant starts playing


def _run(td, atten_db, delay_s, rt60=0.4, user_at=None, user_db=0.0, push=True, stop_on_barge_in=True,
         ref_sr=16000, seed=0):
    """Simulate a session: playback starts at LEAD (reference pushed in 300 ms pieces as it is
    'sent'); the mic hears room echo of it plus, optionally, the user. On speech_started the
    session flushes playback, so the echo stops (after the room's own delay)."""
    ref = speech16k(ASSISTANT)
    user = speech16k(USER, "am_michael")
    echo = room_echo(ref, atten_db, delay_s, rt60, seed)
    n = int(LEAD * SR) + len(echo) + 2 * SR
    rng = np.random.default_rng(seed)
    mic_noise = (rng.standard_normal(n) * 10 ** (-65 / 20)).astype(np.float32)
    user_sig = np.zeros(n, np.float32)
    if user_at is not None:
        u0 = int((LEAD + user_at) * SR)
        user_sig[u0:u0 + len(user)] = user * 10 ** (user_db / 20)
    echo_sig = np.zeros(n, np.float32)
    echo_sig[int(LEAD * SR):int(LEAD * SR) + len(echo)] = echo
    events, stopped_at = [], None
    if ref_sr != 16000:
        from ort.audio import resample
        ref_send = resample(ref, 16000, ref_sr)
    else:
        ref_send = ref
    piece = int(0.3 * ref_sr)
    for i in range(0, n, 320):
        if push and i == int(LEAD * SR):
            t0 = td.position_ms
            for k in range(0, len(ref_send), piece):      # audio scheduled ahead, like a WS client buffer
                td.push_playback(ref_send[k:k + piece], at_ms=t0 + k * 1000 // ref_sr, sr=ref_sr)
        chunk = mic_noise[i:i + 320] + user_sig[i:i + 320]
        e = echo_sig[i:i + 320].copy()
        if stopped_at is not None:                        # playback flushed: echo dies out
            cut = stopped_at + int(delay_s * SR)
            e[max(0, cut - i):] *= 0.0
        evs = td.feed(chunk + e)
        for ev in evs:
            if ev.type == "speech_started" and stop_on_barge_in and stopped_at is None:
                td.clear_playback()
                stopped_at = i + 320
        events += evs
    return events, user


def _types(ev):
    return [e.type for e in ev]


@pytest.mark.parametrize("atten_db", [-10, -20, -30])
def test_echo_without_reference_barges_in(atten_db):
    """Baseline that motivates the gate: with no reference, echo alone starts a turn."""
    ev, _ = _run(TurnDetector({"type": "server_vad"}), atten_db, 0.1, push=False, stop_on_barge_in=False)
    assert "speech_started" in _types(ev)


@pytest.mark.parametrize("atten_db", [-10, -20, -30])
@pytest.mark.parametrize("delay_s", [0.05, 0.2])
@pytest.mark.parametrize("rt60", [0.2, 0.5])
def test_echo_only_never_barges_in(atten_db, delay_s, rt60):
    td = TurnDetector({"type": "server_vad"})
    ev, _ = _run(td, atten_db, delay_s, rt60)
    assert ev == [], [(e.type, e.audio_ms) for e in ev]
    assert td.echo.gated > 50
    assert td.echo.delay is not None and abs(td.echo.delay * 32 - delay_s * 1000) <= 80


@pytest.mark.parametrize("cfg", [{"type": "semantic_vad", "eagerness": "high"},
                                 {"type": "server_vad", "silence_duration_ms": 200, "threshold": 0.3}])
def test_echo_only_other_configs(cfg):
    ev, _ = _run(TurnDetector(cfg), -12, 0.12, 0.4)
    assert ev == []


def test_echo_reference_at_24k():
    ev, _ = _run(TurnDetector({"type": "server_vad"}), -15, 0.1, ref_sr=24000)
    assert ev == []


@pytest.mark.parametrize("atten_db,user_db", [(-10, 0), (-10, -6), (-20, 0), (-20, -10), (-30, 0), (-30, -10)])
def test_user_over_echo_still_barges_in(atten_db, user_db):
    td = TurnDetector({"type": "server_vad"})
    user_at = 4.0
    ev, user = _run(td, atten_db, 0.15, 0.4, user_at=user_at, user_db=user_db)
    onset_ms = int((LEAD + user_at) * 1000) + int(np.flatnonzero(np.abs(user) > 0.02)[0] * 1000 // SR)
    assert _types(ev) == ["speech_started", "speech_stopped"], [(e.type, e.audio_ms) for e in ev]
    st, sp = ev
    assert st.detected_ms - onset_ms <= 300          # baseline without echo: ~150 ms
    user_end = int((LEAD + user_at) * 1000) + int(np.flatnonzero(np.abs(user) > 0.02)[-1] * 1000 // SR)
    assert abs(sp.audio_ms - user_end) <= 300


@pytest.mark.parametrize("atten_db", [-60, -20])
def test_cold_start_user_talks_as_playback_begins(atten_db):
    """First response, nothing calibrated yet: the user talking 100 ms into playback is heard."""
    td = TurnDetector({"type": "server_vad"})
    ev, user = _run(td, atten_db, 0.1, 0.3, user_at=0.1)
    onset_ms = int((LEAD + 0.1) * 1000) + int(np.flatnonzero(np.abs(user) > 0.02)[0] * 1000 // SR)
    st = [e for e in ev if e.type == "speech_started"]
    assert st and st[0].detected_ms - onset_ms <= 400


def test_calibration_persists_and_reset_clears_reference():
    td = TurnDetector({"type": "server_vad"})
    _run(td, -20, 0.1)
    assert td.echo.calibrated
    h = td.echo.log_h.copy()
    td.reset()
    assert not td.echo.active(0)
    np.testing.assert_array_equal(td.echo.log_h, h)   # same room, same device
    # after reset, plain speech without playback behaves as before
    ev = feed_stream(td, np.concatenate([np.zeros(SR, np.float32), speech16k(USER), np.zeros(SR, np.float32)]))
    assert _types(ev) == ["speech_started", "speech_stopped"]


def test_clear_playback_drops_future_reference():
    td = TurnDetector({"type": "server_vad"})
    td.feed(np.zeros(SR, np.float32))
    td.push_playback(np.ones(5 * SR, np.float32) * 0.1, at_ms=1000)
    assert td.echo.active(SR // 512 + 10)
    td.clear_playback(at_ms=1500)
    # 2.5 s in: well past the cleared point + echo window -> inactive
    assert not td.echo.active(int(2.5 * SR) // 512)


def test_gate_is_cheap():
    import time
    td = TurnDetector({"type": "server_vad"})
    ref = speech16k(ASSISTANT)
    td.push_playback(ref, at_ms=0)
    x = room_echo(ref, -15, 0.1)[:len(ref)] + pink_noise(len(ref), -60)
    t = time.perf_counter()
    feed_stream(td, x)
    per_frame_ms = (time.perf_counter() - t) * 1000 / (len(x) / 512)
    assert per_frame_ms < 2.0, per_frame_ms


def test_set_playing_fallback_raises_onset_bar():
    s = speech16k("Hey.")
    voiced = np.flatnonzero(np.abs(s) > 0.02)
    blip = s[voiced[0]:voiced[0] + int(0.22 * SR)]          # ~220 ms: passes min_speech_ms (160)
    x = np.concatenate([np.zeros(SR, np.float32), blip, np.zeros(SR, np.float32)])
    assert "speech_started" in _types(feed_stream(TurnDetector({"type": "server_vad"}), x))
    td = TurnDetector({"type": "server_vad"})
    td.set_playing(True)
    assert feed_stream(td, x) == []
    td.set_playing(False)
    long = np.concatenate([np.zeros(SR, np.float32), speech16k(USER), np.zeros(SR, np.float32)])
    td.set_playing(True)
    assert _types(feed_stream(td, long))[:1] == ["speech_started"]   # real speech still barges in
