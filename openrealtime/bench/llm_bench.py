"""Live LLM benchmark (opt-in, costs real OpenRouter money -- keep it small).

    ORT_LIVE_LLM=1 .venv/bin/python bench/llm_bench.py \
        --providers parasail,baidu,azure,digitalocean --hedged 8 --max-calls 60

Per provider (hedging off, provider pinned): runs ~10 labeled utterances from a
usability-moderator scenario through the full harness and records TTFT (time to first
token from the provider) and tool-call precision/recall for `advance_step`.
Then runs N turns with the default hedged configuration.
Writes bench/llm_bench_results.json and prints a table.  Never calls api.openai.com.
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ort.llm.openrouter import OpenRouterLLM  # noqa: E402
from ort.llm.providers import DEFAULT_ORDER  # noqa: E402

SYSTEM = (
    "You are Ada, a friendly moderator running a think-aloud usability study of an online "
    "shoe store. The participant shares their screen and talks out loud. Encourage them to "
    "keep thinking aloud, answer only questions about the study procedure, and never solve "
    "the task for them.\n"
    "Current task (2 of 4): \"Find the search box and search for running shoes.\"\n"
    "Call advance_step only when the participant clearly says they have finished the current "
    "task, gives up, or explicitly asks to move on. Otherwise just reply briefly."
)
TOOLS = [
    {"type": "function", "name": "advance_step",
     "description": "Move the study to the next task.",
     "parameters": {"type": "object",
                    "properties": {"reason": {"type": "string",
                                              "enum": ["completed", "gave_up", "asked_to_skip"]}},
                    "required": ["reason"]}},
]
# (utterance, should_call_advance_step)
LABELED = [
    ("Where is the search box?", False),
    ("Okay, I found it and searched for running shoes. I'm done with this task.", True),
    ("Hmm, this menu is confusing, I don't know what to click.", False),
    ("Can we move on to the next task please?", True),
    ("I think I'm done... wait, no, let me check the filters first.", False),
    ("Alright, that's finished. What's next?", True),
    ("Is it okay if I use the search bar instead of the menu?", False),
    ("I give up on this one, can we skip it?", True),
    ("So I'd expect the cart icon to be up here, but it isn't.", False),
    ("Done.", True),
]


class Budget:
    def __init__(self, n):
        self.left = n

    def take(self):
        if self.left <= 0:
            raise SystemExit("call budget exhausted")
        self.left -= 1


async def one(llm, utt, budget):
    budget.take()
    msgs = [{"role": "system", "content": SYSTEM},
            {"role": "assistant", "content": "Great, task two: find the search box and "
                                             "search for running shoes. Go ahead whenever you're ready."},
            {"role": "user", "content": utt}]
    t0 = time.perf_counter()
    text, calls, done, err = [], [], None, None
    async with contextlib.aclosing(llm.stream(msgs, TOOLS, max_tokens=150)) as s:
        async for e in s:
            if e.type == "text_delta":
                text.append(e.text)
            elif e.type == "tool_call":
                calls.append((e.tool_call.name, e.tool_call.arguments))
            elif e.type == "done":
                done = e
            elif e.type == "error":
                err = e.error
    m = done.meta if done else {}
    return {"utt": utt, "text": "".join(text), "calls": calls, "error": err,
            "ttft_ms": m.get("ttft_ms"), "provider": m.get("provider"),
            "attempts": m.get("attempts"), "leaks": m.get("leaks_recovered"),
            "repaired": m.get("repaired"), "total_ms": round((time.perf_counter() - t0) * 1000),
            "cost": (done.usage or {}).get("cost") if done else None}


def pct(xs, q):
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    k = (len(xs) - 1) * q
    lo, hi = int(k), min(int(k) + 1, len(xs) - 1)
    return round(xs[lo] + (xs[hi] - xs[lo]) * (k - lo))


def score(rows):
    tp = fp = fn = tn = 0
    preamble = 0
    for (utt, label), r in zip(LABELED, rows):
        called = any(n == "advance_step" for n, _ in r["calls"])
        tp += called and label
        fp += called and not label
        fn += (not called) and label
        tn += (not called) and not label
        preamble += bool(called and r["text"].strip())
    return {"tp": tp, "fp": fp, "fn": fn, "tn": tn,
            "precision": round(tp / (tp + fp), 2) if tp + fp else None,
            "recall": round(tp / (tp + fn), 2) if tp + fn else None,
            "accuracy": round((tp + tn) / len(rows), 2), "text_with_call": preamble}


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--providers", default=",".join(DEFAULT_ORDER))
    ap.add_argument("--n", type=int, default=len(LABELED), help="utterances per provider")
    ap.add_argument("--hedged", type=int, default=8)
    ap.add_argument("--max-calls", type=int, default=60)
    ap.add_argument("--out", default=str(Path(__file__).with_name("llm_bench_results.json")))
    a = ap.parse_args()
    if os.environ.get("ORT_LIVE_LLM") != "1":
        raise SystemExit("set ORT_LIVE_LLM=1 to run (real OpenRouter calls)")
    budget = Budget(a.max_calls)
    cache = Path(a.out).with_suffix(".scoreboard.json")
    results = {"when": time.strftime("%Y-%m-%d %H:%M"), "per_provider": {}, "hedged": None}

    for p in [x.strip() for x in a.providers.split(",") if x.strip()]:
        llm = OpenRouterLLM({"providers": [p], "hedge": False, "cache_path": str(cache)})
        await llm.warmup()
        rows = []
        for utt, _ in LABELED[: a.n]:
            r = await one(llm, utt, budget)
            rows.append(r)
            print(f"  {p:13s} {str(r['ttft_ms']):>7s} ms  calls={[c[0] for c in r['calls']]} "
                  f"err={bool(r['error'])} text={r['text'][:60]!r}", flush=True)
        await llm.aclose()
        ok = [r for r in rows if not r["error"]]
        results["per_provider"][p] = {
            "ttft_p50": pct([r["ttft_ms"] for r in ok], 0.5),
            "ttft_p90": pct([r["ttft_ms"] for r in ok], 0.9),
            "errors": len(rows) - len(ok), **score(rows[: len(LABELED)]), "rows": rows}

    if a.hedged:
        llm = OpenRouterLLM({"cache_path": str(cache)})
        await llm.warmup()
        rows = []
        for i in range(a.hedged):
            utt = LABELED[i % len(LABELED)][0]
            rows.append(await one(llm, utt, budget))
            r = rows[-1]
            print(f"  hedged        {str(r['ttft_ms']):>7s} ms  via {r['provider']} "
                  f"attempts={[(x['provider'], x['result']) for x in r['attempts'] or []]}",
                  flush=True)
        await llm.aclose()
        ok = [r for r in rows if not r["error"]]
        results["hedged"] = {"order": llm.providers,
                             "ttft_p50": pct([r["ttft_ms"] for r in ok], 0.5),
                             "ttft_p90": pct([r["ttft_ms"] for r in ok], 0.9),
                             "ttft_max": pct([r["ttft_ms"] for r in ok], 1.0),
                             "errors": len(rows) - len(ok), "rows": rows}

    Path(a.out).write_text(json.dumps(results, indent=1, ensure_ascii=False))
    print("\nprovider       ttft_p50  ttft_p90  err  prec  recall  acc  text+call")
    for p, r in results["per_provider"].items():
        print(f"{p:13s} {str(r['ttft_p50']):>9s} {str(r['ttft_p90']):>9s} {r['errors']:>4d} "
              f"{str(r['precision']):>5s} {str(r['recall']):>7s} {r['accuracy']:>4} "
              f"{r['text_with_call']:>6d}")
    if results["hedged"]:
        h = results["hedged"]
        print(f"{'HEDGED':13s} {str(h['ttft_p50']):>9s} {str(h['ttft_p90']):>9s} "
              f"{h['errors']:>4d}   (max {h['ttft_max']} ms, order {h['order']})")
    print(f"\ncalls left in budget: {budget.left}")


if __name__ == "__main__":
    asyncio.run(main())
