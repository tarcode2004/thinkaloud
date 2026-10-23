"""Voice-to-voice latency harness (in-process, WebSocket transport).

A synthesized user utterance (Kokoro) is streamed in real time (20 ms chunks) through
``/v1/realtime`` with the real engine (Silero + smart-turn, Whisper, Kokoro) and, by default,
the mock LLM. We measure from the wall-clock moment the last voiced sample was sent
(end of speech) to the first ``response.output_audio.delta``, plus a breakdown.

    .venv/bin/python bench/v2v_bench.py                       # 10 runs, server_vad, mock LLM
    .venv/bin/python bench/v2v_bench.py --vad semantic_vad --runs 20
    .venv/bin/python bench/v2v_bench.py --fake-engine          # protocol overhead only (no models)
    .venv/bin/python bench/v2v_bench.py --llm openrouter       # real LLM (never OpenAI)

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
    args = ap.parse_args()
    if args.llm.lower() not in ("mock", "openrouter"):
        sys.exit("--llm must be mock or openrouter")
    sys.exit(asyncio.run(main_async(args)))


if __name__ == "__main__":
    main()
