"""Concurrent-session load test: N WebSocket sessions, each a simulated participant that streams a
mic in real time (silence + synthesized utterances), against a real server process (Silero +
smart-turn, Whisper, Kokoro on the GPU) with the mock LLM. Reports voice-to-voice latency (end of
speech -> first response.output_audio.delta) p50/p95 per N, a stage breakdown, and the server's
scheduler counters from /health.

    .venv/bin/python bench/load_bench.py                      # N = 1,2,4,8, 6 turns each
    .venv/bin/python bench/load_bench.py --n 1,4,8 --turns 8 --vad semantic_vad
    .venv/bin/python bench/load_bench.py --url http://localhost:8787   # an already running server

Never calls api.openai.com (mock LLM). The utterances are synthesized by the server itself
(mock LLM rule 'say: X' on an out-of-band response), so no second TTS model is loaded here.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import random
import signal
import socket
import statistics
import subprocess
import sys
import time

import aiohttp
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "bench"))

from v2v_bench import pct, speech_end_sample  # noqa: E402

SENTENCES = [
    "Could you tell me what the capital of France is?",
    "I am looking at the checkout page and I cannot find the coupon field.",
    "Okay, I think I would click on the blue button at the top right.",
    "This menu is confusing, I expected the settings to be somewhere else.",
    "What should I do next after filling in the shipping address?",
    "I like the colors, but the text is a little bit too small for me.",
]
SR = 24000
STEP = 480   # 20 ms


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


async def start_server(args) -> tuple[subprocess.Popen | None, str]:
    if args.url:
        return None, args.url.rstrip("/")
    port = free_port()
    env = dict(os.environ, OPENREALTIME_LLM="mock", ORT_PORT=str(port), ORT_HOST="127.0.0.1",
               ORT_MAX_SESSIONS=str(max(args.ns) + 2), OPENREALTIME_MOCK_TTFT_MS=str(args.mock_ttft),
               ORT_LOG_LEVEL="WARNING")
    env.pop("OPENAI_API_KEY", None)
    for k, v in (args.env or []):
        env[k] = v
    p = subprocess.Popen([sys.executable, "-m", "ort"], cwd=ROOT, env=env)
    url = f"http://127.0.0.1:{port}"
    t0 = time.time()
    async with aiohttp.ClientSession() as http:
        while time.time() - t0 < 240:
            try:
                async with http.get(url + "/health") as r:
                    if r.status == 200 and (await r.json()).get("engine") not in (None, "not_loaded"):
                        print(f"server up (warm) in {time.time() - t0:.1f}s", file=sys.stderr)
                        return p, url
            except aiohttp.ClientError:
                pass
            if p.poll() is not None:
                sys.exit("server died during startup")
            await asyncio.sleep(0.5)
    p.kill()
    sys.exit("server did not come up")


async def synth(http: aiohttp.ClientSession, url: str, text: str, voice: str) -> np.ndarray:
    """Utterance audio from the server's own Kokoro (mock LLM: 'say: X' -> X)."""
    ws = await http.ws_connect(url.replace("http", "ws") + "/v1/realtime?model=gpt-realtime")
    await ws.send_str(json.dumps({"type": "session.update", "session": {"audio": {
        "input": {"turn_detection": None}, "output": {"voice": voice}}}}))
    await ws.send_str(json.dumps({"type": "response.create", "response": {"conversation": "none", "input": [
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": f"say: {text}"}]}]}}))
    pcm = []
    async for msg in ws:
        ev = json.loads(msg.data)
        if ev["type"] == "response.output_audio.delta":
            pcm.append(np.frombuffer(base64.b64decode(ev["delta"]), "<i2"))
        elif ev["type"] == "response.done":
            break
    await ws.close()
    return np.concatenate(pcm).astype(np.float32) / 32768.0


class Participant:
    """One WS session: a real-time mic (silence between turns) and per-turn latency marks."""

    def __init__(self, idx: int, url: str, http, utterances, vad: dict, turns: int, rng: random.Random):
        self.idx, self.url, self.http, self.utts, self.vad, self.turns, self.rng = idx, url, http, utterances, vad, turns, rng
        self.rows: list[dict] = []
        self.queue: list[np.ndarray] = []
        self.eos_at: float | None = None
        self.cur: dict = {}
        self.done = asyncio.Event()
        self.errors: list[str] = []

    async def run(self) -> None:
        ws = await self.http.ws_connect(self.url.replace("http", "ws") + "/v1/realtime?model=gpt-realtime")
        self.ws = ws
        await ws.send_str(json.dumps({"type": "session.update", "session": {"type": "realtime", "audio": {"input": {
            "transcription": {"model": "whisper", "language": "en"}, "turn_detection": self.vad}}}}))
        reader = asyncio.ensure_future(self._reader())
        mic = asyncio.ensure_future(self._mic())
        try:
            await asyncio.sleep(self.rng.uniform(0, 1.5))       # participants do not start in lockstep
            for _ in range(self.turns):
                await asyncio.sleep(self.rng.uniform(0.4, 1.2))
                self.cur = {}
                self.done.clear()
                self.queue.append(self.utts[self.rng.randrange(len(self.utts))])
                try:
                    await asyncio.wait_for(self.done.wait(), 30)
                except asyncio.TimeoutError:
                    self.cur["status"] = "timeout"
                if "eos" in self.cur:
                    row = {k: (v - self.cur["eos"]) * 1000 for k, v in self.cur.items() if isinstance(v, float) and k != "eos"}
                    row["status"] = self.cur.get("status")
                    self.rows.append(row)
        finally:
            mic.cancel()
            reader.cancel()
            await ws.close()

    async def _mic(self) -> None:
        t0 = time.perf_counter()
        n = 0
        silence = np.zeros(STEP, np.float32)
        cur, pos, eos = None, 0, 0
        while True:
            target = t0 + n * STEP / SR
            d = target - time.perf_counter()
            if d > 0:
                await asyncio.sleep(d)
            if cur is None and self.queue:
                cur, pos = self.queue.pop(0), 0
                eos = speech_end_sample(cur)
            if cur is not None:
                chunk = cur[pos:pos + STEP]
                if pos <= eos < pos + STEP:
                    self.cur["eos"] = t0 + (n * STEP + (eos - pos)) / SR
                pos += STEP
                if pos >= cur.size:
                    cur = None
                if chunk.size < STEP:
                    chunk = np.concatenate([chunk, silence[: STEP - chunk.size]])
            else:
                chunk = silence
            c = np.clip(chunk * 32767, -32768, 32767).astype("<i2").tobytes()
            await self.ws.send_str(json.dumps({"type": "input_audio_buffer.append", "audio": base64.b64encode(c).decode()}))
            n += 1

    async def _reader(self) -> None:
        marks = {"input_audio_buffer.speech_stopped": "speech_stopped",
                 "conversation.item.input_audio_transcription.completed": "transcribed",
                 "response.created": "response_created",
                 "response.output_audio.delta": "first_audio"}
        async for msg in self.ws:
            if msg.type != aiohttp.WSMsgType.TEXT:
                continue
            ev = json.loads(msg.data)
            now = time.perf_counter()
            k = marks.get(ev["type"])
            if k and k not in self.cur and "eos" in self.cur:
                self.cur[k] = now
            if ev["type"] == "response.done" and "eos" in self.cur:
                self.cur["status"] = ev["response"]["status"]
                self.done.set()
            elif ev["type"] == "error":
                self.errors.append(ev["error"].get("message", ""))


async def run_level(url: str, http, utts, n: int, args) -> dict:
    vad = {"type": args.vad, "create_response": True, "interrupt_response": True}
    if args.vad == "server_vad":
        vad["silence_duration_ms"] = args.silence_ms
    rng = random.Random(1000 + n)
    ps = [Participant(i, url, http, utts, vad, args.turns, random.Random(rng.random())) for i in range(n)]
    async with http.get(url + "/health") as r:
        before = await r.json()
    t0 = time.perf_counter()
    await asyncio.gather(*(p.run() for p in ps))
    wall = time.perf_counter() - t0
    async with http.get(url + "/health") as r:
        after = await r.json()
    rows = [r for p in ps for r in p.rows]
    ok = [r for r in rows if "first_audio" in r]
    res = {"n": n, "turns": len(rows), "ok": len(ok), "wall_s": round(wall, 1),
           "errors": sum(len(p.errors) for p in ps),
           "status": {s: sum(1 for r in rows if r.get("status") == s) for s in {r.get("status") for r in rows}}}
    for k in ("speech_stopped", "transcribed", "response_created", "first_audio"):
        xs = [r[k] for r in ok if k in r]
        if xs:
            res[k] = {"p50": round(pct(xs, 50)), "p95": round(pct(xs, 95)), "max": round(max(xs))}
    sch_b, sch_a = before.get("scheduler") or {}, after.get("scheduler") or {}
    res["scheduler"] = {k: (v - sch_b.get(k, 0)) if isinstance(v, (int, float)) and not k.endswith("_ms") else v
                        for k, v in sch_a.items()}
    return res


async def main_async(args) -> int:
    proc, url = await start_server(args)
    results = []
    try:
        async with aiohttp.ClientSession() as http:
            utts = [await synth(http, url, s, args.voice) for s in SENTENCES]
            print(f"{len(utts)} utterances, {min(u.size for u in utts) / SR:.1f}-{max(u.size for u in utts) / SR:.1f}s",
                  file=sys.stderr)
            await run_level(url, http, utts, 1, argparse.Namespace(**{**vars(args), "turns": 2}))   # warm run
            for n in args.ns:
                r = await run_level(url, http, utts, n, args)
                results.append(r)
                fa = r.get("first_audio", {})
                print(f"N={n:2d}  v2v p50={fa.get('p50')}ms p95={fa.get('p95')}ms  ok={r['ok']}/{r['turns']}  "
                      f"stopped p50={r.get('speech_stopped', {}).get('p50')} transcribed p50={r.get('transcribed', {}).get('p50')}"
                      f"  sched={r['scheduler']}", file=sys.stderr)
    finally:
        if proc is not None:
            proc.send_signal(signal.SIGINT)
            try:
                proc.wait(15)
            except subprocess.TimeoutExpired:
                proc.kill()
    print(f"\nvoice-to-voice under load (ms from end of speech), vad={args.vad}, mock LLM ttft={args.mock_ttft}ms")
    print(f"{'N':>3s} {'turns':>6s} {'stopped p50':>12s} {'stt p50':>8s} {'stt p95':>8s} {'v2v p50':>8s} {'v2v p95':>8s} {'v2v max':>8s}")
    for r in results:
        g = lambda k, q: r.get(k, {}).get(q, float("nan"))  # noqa: E731
        print(f"{r['n']:3d} {r['ok']:3d}/{r['turns']:<3d} {g('speech_stopped', 'p50'):12.0f} {g('transcribed', 'p50'):8.0f} "
              f"{g('transcribed', 'p95'):8.0f} {g('first_audio', 'p50'):8.0f} {g('first_audio', 'p95'):8.0f} {g('first_audio', 'max'):8.0f}")
    if args.json:
        with open(args.json, "w") as f:
            json.dump({"results": results, "args": {k: v for k, v in vars(args).items() if k != "env"}}, f, indent=2)
    return 0 if all(r["ok"] == r["turns"] for r in results) else 1


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--n", default="1,2,4,8", help="comma list of concurrent session counts")
    ap.add_argument("--turns", type=int, default=6, help="turns per participant")
    ap.add_argument("--vad", default="server_vad", choices=["server_vad", "semantic_vad"])
    ap.add_argument("--silence-ms", type=int, default=500)
    ap.add_argument("--mock-ttft", type=int, default=250)
    ap.add_argument("--voice", default="echo")
    ap.add_argument("--url", default=None, help="use a running server instead of starting one")
    ap.add_argument("--env", action="append", type=lambda s: tuple(s.split("=", 1)), help="extra server env K=V")
    ap.add_argument("--json", default=None)
    args = ap.parse_args()
    args.ns = [int(x) for x in args.n.split(",") if x.strip()]
    sys.exit(asyncio.run(main_async(args)))


if __name__ == "__main__":
    main()
