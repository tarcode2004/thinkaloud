"""Voice-to-voice latency harness (in-process, WebSocket transport).

A synthesized user utterance (Kokoro) is streamed in real time (20 ms chunks) through
``/v1/realtime`` with the real engine (Silero + smart-turn, Whisper, Kokoro) and, by default,
the mock LLM. We measure from the wall-clock moment the last voiced sample was sent
(end of speech) to the first ``response.output_audio.delta``, plus a breakdown.

    .venv/bin/python bench/v2v_bench.py                       # 10 runs, server_vad, mock LLM
    .venv/bin/python bench/v2v_bench.py --vad semantic_vad --runs 20
    .venv/bin/python bench/v2v_bench.py --fake-engine          # protocol overhead only (no models)
    .venv/bin/python bench/v2v_bench.py --llm openrouter       # real LLM (never OpenAI)
    .venv/bin/python bench/v2v_bench.py --bargein ws,webrtc --runs 8   # barge-in: onset -> audio stopped,
                                                                         # truncated text vs what was heard

Never calls api.openai.com.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import statistics
import sys
import time

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)


def pct(xs: list[float], p: float) -> float:
    if not xs:
        return float("nan")
    xs = sorted(xs)
    k = (len(xs) - 1) * p / 100
    lo, hi = int(np.floor(k)), int(np.ceil(k))
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


async def synth_utterance(engine, text: str, voice: str) -> np.ndarray:
    tts = engine.tts
    if hasattr(tts, "synthesize"):
        a = await tts.synthesize(text, voice=voice)
    else:
        async def one():
            yield text
        a = np.concatenate([np.asarray(c, np.float32) async for c in tts.stream(one(), voice)])
    return np.asarray(a, np.float32)


def longest_pause_ms(x: np.ndarray, sr: int = 24000) -> int:
    f = sr // 50
    n = len(x) // f
    rms = np.sqrt(np.mean(x[: n * f].reshape(n, f) ** 2, axis=1))
    v = np.nonzero(rms > 0.01)[0]
    return int(np.max(np.diff(v)) * 20) if v.size > 1 else 0


def speech_end_sample(x: np.ndarray, sr: int = 24000) -> int:
    f = sr // 50
    n = len(x) // f
    rms = np.sqrt(np.mean(x[: n * f].reshape(n, f) ** 2, axis=1))
    voiced = np.nonzero(rms > 0.01)[0]
    return int((voiced[-1] + 1) * f) if voiced.size else len(x)


async def one_run(client, utter: np.ndarray, vad: dict, timeout: float = 20.0) -> dict:
    ws = await client.ws_connect("/v1/realtime?model=gpt-realtime")
    t = {}
    done = asyncio.Event()
    marks = {"input_audio_buffer.speech_stopped": "speech_stopped",
             "conversation.item.input_audio_transcription.completed": "transcribed",
             "response.created": "response_created",
             "response.output_audio_transcript.delta": "first_transcript",
             "response.output_audio.delta": "first_audio"}
    info = {}

    async def reader():
        async for msg in ws:
            if msg.type.name != "TEXT":
                continue
            ev = json.loads(msg.data)
            now = time.perf_counter()
            k = marks.get(ev["type"])
            if k and k not in t:
                t[k] = now
            if ev["type"] == "conversation.item.input_audio_transcription.completed":
                info["transcript"] = ev["transcript"]
            if ev["type"] == "response.done":
                info["status"] = ev["response"]["status"]
                done.set()
            if ev["type"] == "error":
                info.setdefault("errors", []).append(ev["error"].get("message"))

    rt = asyncio.ensure_future(reader())
    await ws.send_str(json.dumps({"type": "session.update", "session": {"type": "realtime", "audio": {"input": {
        "transcription": {"model": "whisper", "language": "en"}, "turn_detection": vad}}}}))
    lead = np.zeros(int(0.4 * 24000), np.float32)
    tail = np.zeros(int(4.0 * 24000), np.float32)
    x = np.concatenate([lead, utter, tail])
    eos = len(lead) + speech_end_sample(utter)
    step = 480
    t0 = time.perf_counter()
    for i in range(0, len(x), step):
        target = t0 + i / 24000
        d = target - time.perf_counter()
        if d > 0:
            await asyncio.sleep(d)
        c = np.clip(x[i:i + step] * 32767, -32768, 32767).astype("<i2").tobytes()
        await ws.send_str(json.dumps({"type": "input_audio_buffer.append", "audio": base64.b64encode(c).decode()}))
        if i <= eos < i + step:
            t["eos"] = t0 + eos / 24000   # wall-clock time of the speech end on the real-time feed
        if "first_audio" in t and "eos" in t and i > eos + 24000:
            break
    try:
        await asyncio.wait_for(done.wait(), timeout)
    except asyncio.TimeoutError:
        info["status"] = "timeout"
    await ws.close()
    rt.cancel()
    out = {k: (v - t["eos"]) * 1000 for k, v in t.items() if k != "eos"} if "eos" in t else {}
    out.update(info)
    return out


async def main_async(args) -> int:
    from aiohttp.test_utils import TestClient, TestServer

    from ort.config import Config
    from ort.server import create_app

    cfg = Config.from_env()
    cfg.llm = args.llm
    cfg.speculative = not args.no_speculative
    os.environ["OPENREALTIME_LLM"] = args.llm
    if args.mock_ttft is not None:
        os.environ["OPENREALTIME_MOCK_TTFT_MS"] = str(args.mock_ttft)
    if args.fake_engine:
        sys.path.insert(0, os.path.join(ROOT, "tests"))
        from fakes import make_engine
        from ort.llm import make_llm
        engine = make_engine(llm=make_llm({"llm": args.llm}))
    else:
        from ort.session import load_engine
        t = time.perf_counter()
        engine = load_engine(cfg)
        await asyncio.get_running_loop().run_in_executor(None, engine.warmup)
        w = getattr(engine.llm, "warmup", None)
        if callable(w):
            r = w()
            if asyncio.iscoroutine(r):
                await r
        print(f"engine warm in {time.perf_counter() - t:.1f}s", file=sys.stderr)

    utter = await synth_utterance(engine, args.text, args.voice)
    gap = longest_pause_ms(utter)
    print(f"utterance {len(utter) / 24000:.2f}s, longest internal pause {gap} ms", file=sys.stderr)
    if args.vad == "server_vad" and gap >= args.silence_ms - 100:
        print("warning: the utterance has a pause close to silence_duration_ms; VAD may split it", file=sys.stderr)
    vad = {"type": args.vad, "create_response": True, "interrupt_response": True}
    if args.vad == "server_vad":
        vad["silence_duration_ms"] = args.silence_ms
    else:
        vad["eagerness"] = args.eagerness
    app = create_app(cfg, engine)
    client = TestClient(TestServer(app))
    await client.start_server()
    rows = []
    try:
        if not args.no_warm_run:
            await one_run(client, utter, vad)
        for i in range(args.runs):
            r = await one_run(client, utter, vad)
            rows.append(r)
            print(f"run {i + 1:2d}: " + "  ".join(f"{k}={v:7.0f}ms" for k, v in r.items() if isinstance(v, float))
                  + f"  [{r.get('status')}] {r.get('transcript', '')!r}", file=sys.stderr)
    finally:
        await client.close()

    keys = ["speech_stopped", "transcribed", "response_created", "first_transcript", "first_audio"]
    print(f"\nv2v latency from end of speech (ms), n={len(rows)}, vad={args.vad}, llm={args.llm}"
          f"{' (fake engine)' if args.fake_engine else ''}, speculative={cfg.speculative}")
    print(f"{'stage':18s} {'p50':>8s} {'p95':>8s} {'min':>8s} {'max':>8s}")
    summary = {}
    for k in keys:
        xs = [r[k] for r in rows if isinstance(r.get(k), float)]
        if xs:
            summary[k] = {"p50": pct(xs, 50), "p95": pct(xs, 95)}
            print(f"{k:18s} {pct(xs, 50):8.0f} {pct(xs, 95):8.0f} {min(xs):8.0f} {max(xs):8.0f}")
    if args.json:
        with open(args.json, "w") as f:
            json.dump({"rows": rows, "summary": summary, "args": vars(args)}, f, indent=2)
    return 0 if rows and all("first_audio" in r for r in rows) else 1


# ===================================================================== barge-in quality

LONG_REPLY = ("Let me walk you through the whole checkout flow step by step. First you open the cart and check "
              "every item in it. Then you choose a shipping method that suits you and enter your address. After "
              "that you pick a payment option, review the order summary carefully, and finally confirm the purchase.")


def speech_start_sample(x: np.ndarray, sr: int = 24000) -> int:
    f = sr // 50
    n = len(x) // f
    rms = np.sqrt(np.mean(x[: n * f].reshape(n, f) ** 2, axis=1))
    v = np.nonzero(rms > 0.01)[0]
    return int(v[0] * f) if v.size else 0


def _norm_words(t: str) -> list[str]:
    import re
    return [w for w in re.sub(r"[^a-z0-9' ]", " ", (t or "").lower()).split() if w]


async def _heard_check(engine, played24: np.ndarray, truncated: str) -> dict:
    """Transcribe what the client actually played and compare with the server's truncated text."""
    from ort.audio import Resampler
    if played24.size < 2400:
        return {"heard_words": 0, "truncated_words": len(_norm_words(truncated)), "word_diff": len(_norm_words(truncated))}
    x16 = Resampler(24000, 16000).process(played24.astype(np.float32))
    asr = await engine.stt.transcribe(x16, language="en")
    hw, tw = _norm_words(asr), _norm_words(truncated)
    # the played audio ends mid-word; Whisper may drop or keep that word
    return {"heard_words": len(hw), "truncated_words": len(tw), "word_diff": len(tw) - len(hw),
            "asr": asr, "truncated": truncated}


async def bargein_ws(client, engine, utter: np.ndarray, play_s: float) -> dict:
    """WS: the client plays deltas in real time and flushes its player on speech_started (like the
    OpenAI Agents SDK). Measures onset -> speech_started (= audio stopped at the client) and
    onset -> response.done (server stopped generating)."""
    ws = await client.ws_connect("/v1/realtime?model=gpt-realtime")
    t: dict = {}
    recv: list[tuple[float, np.ndarray]] = []
    info: dict = {}
    done = asyncio.Event()

    async def reader():
        async for msg in ws:
            if msg.type.name != "TEXT":
                continue
            ev = json.loads(msg.data)
            now = time.perf_counter()
            if ev["type"] == "response.output_audio.delta":
                recv.append((now, np.frombuffer(base64.b64decode(ev["delta"]), "<i2").astype(np.float32) / 32768))
            elif ev["type"] == "input_audio_buffer.speech_started" and "speech_started" not in t:
                t["speech_started"] = now
            elif ev["type"] == "response.done" and ev["response"]["status"] == "cancelled":
                t["cancelled"] = now
                info["truncated"] = ev["response"]["output"][0]["content"][0]["transcript"]
                done.set()
            elif ev["type"] == "conversation.item.truncated":
                info["audio_end_ms"] = ev["audio_end_ms"]

    rt = asyncio.ensure_future(reader())
    await ws.send_str(json.dumps({"type": "session.update", "session": {"audio": {"input": {"turn_detection": {
        "type": "server_vad", "silence_duration_ms": 500, "create_response": False, "interrupt_response": True}},
        "output": {"voice": "alloy"}}}}))
    await ws.send_str(json.dumps({"type": "conversation.item.create", "item": {"type": "message", "role": "user",
                                  "content": [{"type": "input_text", "text": f"say: {LONG_REPLY}"}]}}))
    await ws.send_str(json.dumps({"type": "response.create"}))
    silence = np.zeros(480, np.float32)
    lead = speech_start_sample(utter)
    feed = utter[max(0, lead - 2400):]          # 100 ms of lead-in before the voice starts
    t0 = time.perf_counter()
    n = 0
    onset_sent = False
    sent_utt = 0
    while time.perf_counter() - t0 < 30:
        target = t0 + n * 0.02
        d = target - time.perf_counter()
        if d > 0:
            await asyncio.sleep(d)
        start_talk = recv and time.perf_counter() - recv[0][0] >= play_s
        if start_talk and sent_utt < feed.size:
            chunk = feed[sent_utt:sent_utt + 480]
            if not onset_sent and sent_utt + 480 > 2400:
                t["onset"] = time.perf_counter() + (2400 - sent_utt) / 24000
                onset_sent = True
            sent_utt += 480
            if chunk.size < 480:
                chunk = np.concatenate([chunk, silence[: 480 - chunk.size]])
        else:
            chunk = silence
        await ws.send_str(json.dumps({"type": "input_audio_buffer.append",
                                      "audio": base64.b64encode((np.clip(chunk, -1, 1) * 32767).astype("<i2").tobytes()).decode()}))
        n += 1
        if done.is_set() and sent_utt >= feed.size:
            break
    await ws.close()
    rt.cancel()
    # client player: real-time playback from the first delta, flushed at speech_started
    stop = t.get("speech_started", time.perf_counter())
    audio = np.concatenate([a for _, a in recv]) if recv else np.zeros(0, np.float32)
    played = audio[: max(0, int((stop - recv[0][0]) * 24000))] if recv else audio
    out = {"onset_to_stop_ms": (stop - t["onset"]) * 1000 if "onset" in t else float("nan"),
           "onset_to_done_ms": (t["cancelled"] - t["onset"]) * 1000 if "cancelled" in t and "onset" in t else float("nan"),
           "played_ms": played.size / 24, "audio_end_ms": info.get("audio_end_ms")}
    out.update(await _heard_check(engine, played, info.get("truncated", "")))
    return out


async def bargein_webrtc(client, engine, utter: np.ndarray, play_s: float) -> dict:
    """WebRTC loopback (aiortc client like a browser): onset -> received audio goes silent."""
    import fractions
    import av
    from aiortc import MediaStreamTrack, RTCPeerConnection, RTCSessionDescription
    from ort.audio import Resampler

    feed48 = Resampler(24000, 48000).process(utter)
    lead = speech_start_sample(utter) * 2

    class Mic(MediaStreamTrack):
        kind = "audio"

        def __init__(self):
            super().__init__()
            self.n, self.t0, self.talk_at, self.pos = 0, None, None, 0
            self.onset = None

        async def recv(self):
            if self.t0 is None:
                self.t0 = time.perf_counter()
            d = self.t0 + self.n * 0.02 - time.perf_counter()
            if d > 0:
                await asyncio.sleep(d)
            x = np.zeros(960, np.float32)
            if self.talk_at is not None and self.pos < feed48.size:
                c = feed48[self.pos:self.pos + 960]
                if self.onset is None and self.pos <= lead < self.pos + 960:
                    self.onset = time.perf_counter() + (lead - self.pos) / 48000
                x[: c.size] = c
                self.pos += 960
            f = av.AudioFrame(format="s16", layout="mono", samples=960)
            f.planes[0].update((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
            f.sample_rate, f.pts, f.time_base = 48000, self.n * 960, fractions.Fraction(1, 48000)
            self.n += 1
            return f

    r = await client.post("/v1/realtime/client_secrets", json={"session": {"type": "realtime", "audio": {
        "input": {"turn_detection": {"type": "server_vad", "silence_duration_ms": 500, "create_response": False,
                                     "interrupt_response": True}}, "output": {"voice": "alloy"}}}})
    token = (await r.json())["value"]
    pc = RTCPeerConnection()
    mic = Mic()
    pc.addTrack(mic)
    dc = pc.createDataChannel("oai-events")
    events: list[tuple[float, dict]] = []
    frames: list[tuple[float, np.ndarray]] = []
    opened = asyncio.Event()
    dc.on("open", opened.set)
    dc.on("message", lambda m: events.append((time.perf_counter(), json.loads(m))))
    tasks = []

    async def read(track):
        while True:
            fr = await track.recv()
            from ort.transport_webrtc import frame_to_mono_float
            a, _sr = frame_to_mono_float(fr)
            frames.append((time.perf_counter(), a))

    pc.on("track", lambda tr: tasks.append(asyncio.ensure_future(read(tr))))
    await pc.setLocalDescription(await pc.createOffer())
    res = await client.post("/v1/realtime/calls", data=pc.localDescription.sdp,
                            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/sdp"})
    await pc.setRemoteDescription(RTCSessionDescription(sdp=await res.text(), type="answer"))
    await asyncio.wait_for(opened.wait(), 10)
    dc.send(json.dumps({"type": "conversation.item.create", "item": {"type": "message", "role": "user",
                        "content": [{"type": "input_text", "text": f"say: {LONG_REPLY}"}]}}))
    dc.send(json.dumps({"type": "response.create"}))

    def first(typ):
        return next((t for t, e in events if e["type"] == typ), None)

    t_end = time.perf_counter() + 20
    while first("output_audio_buffer.started") is None and time.perf_counter() < t_end:
        await asyncio.sleep(0.01)
    t_loud = None
    while time.perf_counter() < t_end:
        loud = [t for t, a in frames if np.sqrt(np.mean(a * a)) > 0.01]
        if loud:
            t_loud = loud[0]
            if time.perf_counter() - t_loud >= play_s:
                break
        await asyncio.sleep(0.01)
    mic.talk_at = time.perf_counter()
    while first("response.done") is None and time.perf_counter() < t_end:
        await asyncio.sleep(0.01)
    await asyncio.sleep(0.6)
    done = next((e for t, e in events if e["type"] == "response.done"), None)
    trunc = done["response"]["output"][0]["content"][0]["transcript"] if done else ""
    # received audio (48 kHz): last audible frame after the onset = audio stopped
    rms = [(t, float(np.sqrt(np.mean(a * a)))) for t, a in frames]
    onset = mic.onset
    audible_after = [t for t, v in rms if v > 0.01 and onset and t >= onset]
    t_stop = audible_after[-1] if audible_after else None     # nothing audible after the onset: not measurable
    heard48 = np.concatenate([a for t, a in frames if t_loud and t >= t_loud - 0.02 and t <= (t_stop or onset or 0)]) \
        if frames else np.zeros(0, np.float32)
    heard24 = Resampler(48000, 24000).process(heard48)
    out = {"onset_to_stop_ms": ((t_stop - onset) * 1000) if onset and t_stop else float("nan"),
           "onset_to_done_ms": ((first("response.done") - onset) * 1000) if onset and first("response.done") else float("nan"),
           "played_ms": heard24.size / 24,
           "audio_end_ms": next((e["audio_end_ms"] for t, e in events if e["type"] == "conversation.item.truncated"), None)}
    out.update(await _heard_check(engine, heard24, trunc))
    for tk in tasks:
        tk.cancel()
    await pc.close()
    return out


async def bargein_main(args) -> int:
    from aiohttp.test_utils import TestClient, TestServer

    from ort.config import Config
    from ort.server import create_app
    from ort.session import load_engine
    os.environ["OPENREALTIME_LLM"] = "mock"
    os.environ.setdefault("OPENREALTIME_MOCK_TTFT_MS", "100")
    cfg = Config.from_env()
    cfg.llm = "mock"
    engine = load_engine(cfg)
    await asyncio.get_running_loop().run_in_executor(None, engine.warmup)
    utter = await synth_utterance(engine, "Wait, sorry, can I ask something about the shipping?", "echo")
    client = TestClient(TestServer(create_app(cfg, engine)))
    await client.start_server()
    rng = np.random.default_rng(5)
    summary = {}
    try:
        for kind in args.bargein.split(","):
            fn = bargein_ws if kind == "ws" else bargein_webrtc
            rows = []
            await fn(client, engine, utter, 1.0)   # warm
            for i in range(args.runs):
                r = await fn(client, engine, utter, float(rng.uniform(1.0, 3.5)))
                rows.append(r)
                print(f"{kind} run {i + 1}: onset->stop {r['onset_to_stop_ms']:6.0f}ms  onset->done {r['onset_to_done_ms']:6.0f}ms"
                      f"  played {r['played_ms']:6.0f}ms  truncated_ms={r['audio_end_ms']}  words heard(asr)={r['heard_words']}"
                      f" truncated={r['truncated_words']} diff={r['word_diff']:+d}", file=sys.stderr)
                if args.verbose:
                    print(f"    heard: {r.get('asr')!r}\n    trunc: {r.get('truncated')!r}", file=sys.stderr)
            stops = [r["onset_to_stop_ms"] for r in rows if r["onset_to_stop_ms"] == r["onset_to_stop_ms"]]
            diffs = [abs(r["word_diff"]) for r in rows]
            summary[kind] = {"onset_to_stop_p50": pct(stops, 50), "onset_to_stop_p95": pct(stops, 95),
                             "word_diff_abs_max": max(diffs), "within_1_word": sum(d <= 1 for d in diffs) / len(diffs)}
    finally:
        await client.close()
    print("\nbarge-in (real engine, mock LLM)")
    for k, v in summary.items():
        print(f"{k:7s} onset->audio stopped p50 {v['onset_to_stop_p50']:.0f} ms, p95 {v['onset_to_stop_p95']:.0f} ms; "
              f"truncated text vs heard: |diff| max {v['word_diff_abs_max']} words, within ±1 word {v['within_1_word']:.0%}")
    if args.json:
        with open(args.json, "w") as f:
            json.dump(summary, f, indent=2)
    return 0


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--runs", type=int, default=10)
    ap.add_argument("--llm", default=os.environ.get("OPENREALTIME_LLM", "mock"))
    ap.add_argument("--mock-ttft", type=int, default=None, help="OPENREALTIME_MOCK_TTFT_MS for the mock LLM")
    ap.add_argument("--vad", default="server_vad", choices=["server_vad", "semantic_vad"])
    ap.add_argument("--silence-ms", type=int, default=500)
    ap.add_argument("--eagerness", default="auto")
    ap.add_argument("--text", default="Could you tell me what the capital of France is?")
    ap.add_argument("--voice", default="echo")
    ap.add_argument("--fake-engine", action="store_true")
    ap.add_argument("--no-speculative", action="store_true")
    ap.add_argument("--no-warm-run", action="store_true")
    ap.add_argument("--json", default=None)
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--bargein", default=None, help="ws,webrtc: measure barge-in instead of voice-to-voice")
    args = ap.parse_args()
    if args.bargein:
        sys.exit(asyncio.run(bargein_main(args)))
    if args.llm.lower() not in ("mock", "openrouter"):
        sys.exit("--llm must be mock or openrouter")
    sys.exit(asyncio.run(main_async(args)))


if __name__ == "__main__":
    main()
