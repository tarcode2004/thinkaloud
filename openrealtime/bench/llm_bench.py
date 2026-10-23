"""Live LLM benchmark (opt-in, costs real OpenRouter money -- keep it small).

    ORT_LIVE_LLM=1 .venv/bin/python bench/llm_bench.py \
        --providers parasail,baidu,azure,digitalocean --hedged 8 --max-calls 60

Per provider (hedging off, provider pinned): runs ~10 labeled utterances from a
usability-moderator scenario through the full harness and records TTFT (time to first
token from the provider) and tool-call precision/recall for `advance_step`.
Then runs N turns with the default hedged configuration.
Writes bench/llm_bench_results.json and prints a table.  Never calls api.openai.com.

Prompt-cache / long-prompt TTFT mode (``--cache``): for each provider and prompt size
(default 1k,4k,8k,16k tokens) sends a cold request (fresh random prefix) and then a warm
request (same prefix, new last user turn, as in a conversation), max_tokens=8, and records
TTFT plus usage.prompt_tokens_details.cached_tokens.  Results -> bench/llm_cache_results.json.

    ORT_LIVE_LLM=1 .venv/bin/python bench/llm_bench.py --cache \
        --providers parasail,digitalocean,azure --sizes 1000,4000,8000,16000
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


FILLER = (
    "Rule {i}. When the participant is working on task {t}, observe silently unless they stop "
    "talking for a while; then prompt them gently with an open question such as what they are "
    "looking for or what they expected to happen. Never reveal the hidden success criteria "
    "({c}), never click or type for them, and keep every reply to one or two short sentences. "
    "If they ask about the procedure, answer briefly; if they ask about the product, say you "
    "cannot help with that but are curious what they would try. ")


def long_system(tokens: int, nonce: str) -> str:
    """~``tokens`` tokens (≈4.2 chars/token) of moderator-like instructions, made unique by
    ``nonce`` at the very start so the first request is a guaranteed cache miss."""
    parts = [f"Session {nonce}. You are Ada, a friendly moderator of a think-aloud study."]
    i = 0
    while sum(len(x) for x in parts) < tokens * 4.2:
        parts.append(FILLER.format(i=i, t=i % 7 + 1, c=f"criterion-{(i * 37) % 101}"))
        i += 1
    return "\n".join(parts)


async def cache_probe(client, provider, size, budget, model):
    import secrets as _s
    nonce = _s.token_hex(6)
    sysm = {"role": "system", "content": long_system(size, nonce)}
    hist = [sysm, {"role": "assistant", "content": "Welcome! Let's start with task one."},
            {"role": "user", "content": "Okay, I'm on the home page now."}]
    out = []
    for phase, msgs in (("cold", hist),
                        ("warm", hist + [{"role": "assistant", "content": "Great, go ahead."},
                                         {"role": "user", "content": "Hmm, where is the search?"}])):
        budget.take()
        body = {"model": model, "messages": msgs, "max_tokens": 8,
                "stream_options": {"include_usage": True}, "reasoning": {"enabled": False}}
        t0 = time.perf_counter()
        ttft, usage, err, prov = None, None, None, None
        try:
            async for r in client.stream_raw(body, provider):
                if r.is_token and ttft is None:
                    ttft = (time.perf_counter() - t0) * 1000
                if r.kind == "usage":
                    usage = r.data
                if r.kind == "meta":
                    prov = (r.data or {}).get("provider") or prov
        except Exception as e:  # noqa: BLE001
            err = str(e)[:160]
        det = (usage or {}).get("prompt_tokens_details") or {}
        row = {"provider": provider, "size": size, "phase": phase,
               "ttft_ms": None if ttft is None else round(ttft),
               "total_ms": round((time.perf_counter() - t0) * 1000),
               "prompt_tokens": (usage or {}).get("prompt_tokens"),
               "cached_tokens": det.get("cached_tokens"),
               "cache_write_tokens": det.get("cache_write_tokens"),
               "cost": (usage or {}).get("cost"), "served_by": prov, "error": err}
        print(f"  {provider:13s} {size:>6d} {phase:4s} ttft={row['ttft_ms']} "
              f"prompt={row['prompt_tokens']} cached={row['cached_tokens']} err={err}", flush=True)
        out.append(row)
        if err:
            break
    return out


async def cache_main(a, budget):
    from ort.llm.openrouter import OpenRouterClient, load_api_key
    client = OpenRouterClient(load_api_key(), first_byte_timeout=30.0)
    await client.warmup()
    rows = []
    sizes = [int(x) for x in a.sizes.split(",")]
    for p in [x.strip() for x in a.providers.split(",") if x.strip()]:
        for size in sizes:
            rows += await cache_probe(client, p, size, budget, a.model)
    await client.aclose()
    out = Path(a.out).with_name("llm_cache_results.json")
    old = json.loads(out.read_text()) if out.exists() else {"runs": []}
    old["runs"].append({"when": time.strftime("%Y-%m-%d %H:%M"), "model": a.model, "rows": rows})
    out.write_text(json.dumps(old, indent=1))
    print("\nprovider       size  cold_ttft warm_ttft cached/prompt")
    by = {}
    for r in rows:
        by.setdefault((r["provider"], r["size"]), {})[r["phase"]] = r
    for (p, size), d in by.items():
        c, w = d.get("cold", {}), d.get("warm", {})
        print(f"{p:13s} {size:>6d} {str(c.get('ttft_ms')):>9s} {str(w.get('ttft_ms')):>9s} "
              f"{w.get('cached_tokens')}/{w.get('prompt_tokens')}")
    print(f"\ncalls left in budget: {budget.left}")


def layout_sim(turns: int = 20) -> None:
    """Offline: reusable prompt prefix between consecutive requests of a growing moderator
    conversation whose every response carries per-response '# NOW' instructions, for the
    'inline' (old) and 'tail' (new) layouts.  Providers cache in 128..512-token blocks, so
    only the byte-identical prefix of the rendered prompt can be a cache hit."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from llm_eval import MOD_SYS, MOD_TOOLS  # noqa: E402
    from ort.llm.harness import Harness, HarnessOptions, PrefixMemory, estimate_tokens

    def render(msgs):  # stand-in for the chat template: concatenation in order
        return "".join(f"<{m['role']}>{m.get('content') or json.dumps(m.get('tool_calls'))}" for m in msgs)

    base = MOD_SYS.format(lang="English")
    for layout in ("inline", "tail"):
        mem = PrefixMemory()
        hist, prev, shared, total = [], None, 0, 0
        for t in range(turns):
            hist += [{"role": "user", "content": f"Participant turn {t}: " + "I am looking at the page. " * 6}]
            sysm = {"role": "system", "content": base + f"\n\n# NOW\nThe participant finished turn {t}. "
                                                       "Reply briefly and neutrally."}
            h = Harness(MOD_TOOLS, "auto", HarnessOptions(instructions_layout=layout, prefix_memory=mem))
            msgs, _ = h.prepare([sysm] + hist)
            r = render(msgs)
            if prev is not None:
                n = 0
                L = min(len(r), len(prev))
                while n < L and r[n] == prev[n]:
                    n += 1
                shared += n
                total += len(r)
            prev = r
            hist += [{"role": "assistant", "content": f"Okay. Reply {t}."}]
        toks = estimate_tokens([{"role": "user", "content": prev}])
        print(f"{layout:6s}: reusable prefix {shared / total:.0%} of prompt chars over {turns} turns "
              f"(final prompt ~{toks} tokens)")


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", action="store_true", help="prompt-cache / long-prompt TTFT mode")
    ap.add_argument("--layout-sim", action="store_true", help="offline prefix-reuse simulation")
    ap.add_argument("--sizes", default="1000,4000,8000,16000")
    ap.add_argument("--model", default="deepseek/deepseek-v4-flash")
    ap.add_argument("--providers", default=",".join(DEFAULT_ORDER))
    ap.add_argument("--n", type=int, default=len(LABELED), help="utterances per provider")
    ap.add_argument("--hedged", type=int, default=8)
    ap.add_argument("--max-calls", type=int, default=60)
    ap.add_argument("--out", default=str(Path(__file__).with_name("llm_bench_results.json")))
    a = ap.parse_args()
    if a.layout_sim:
        return layout_sim()
    if os.environ.get("ORT_LIVE_LLM") != "1":
        raise SystemExit("set ORT_LIVE_LLM=1 to run (real OpenRouter calls)")
    budget = Budget(a.max_calls)
    if a.cache:
        return await cache_main(a, budget)
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
