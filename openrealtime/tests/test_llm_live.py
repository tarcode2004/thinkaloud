"""Live OpenRouter smoke test. Opt-in only: ORT_LIVE_LLM=1 (costs a few cents at most).
Never touches api.openai.com."""
import contextlib
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

pytestmark = pytest.mark.skipif(os.environ.get("ORT_LIVE_LLM") != "1",
                                reason="live LLM test; set ORT_LIVE_LLM=1")

ADV = {"type": "function", "name": "advance_step",
       "description": "Advance the study to the next task. Call only when the participant "
                      "says they finished the current task or asks to move on.",
       "parameters": {"type": "object", "properties": {"reason": {"type": "string"}},
                      "required": ["reason"]}}
SYS = {"role": "system", "content": "You moderate a usability study. Current task: find the "
                                    "search box and search for running shoes."}


@pytest.mark.asyncio
async def test_live_text_and_tool(tmp_path):
    from ort.llm.openrouter import OpenRouterLLM

    llm = OpenRouterLLM({"cache_path": str(tmp_path / "p.json"), "max_tokens": 120})
    await llm.warmup()
    try:
        async with contextlib.aclosing(llm.stream(
                [SYS, {"role": "user", "content": "Hi! Can you hear me?"}], [ADV])) as s:
            evs = [e async for e in s]
        assert evs[-1].type == "done", evs[-1]
        assert any(e.type == "text_delta" for e in evs)
        assert evs[-1].meta["ttft_ms"] < 5000

        async with contextlib.aclosing(llm.stream(
                [SYS, {"role": "user", "content": "Okay I searched for running shoes, "
                                                  "I'm done with this task."}], [ADV])) as s:
            evs = [e async for e in s]
        calls = [e.tool_call for e in evs if e.type == "tool_call"]
        assert calls and calls[0].name == "advance_step"
        json.loads(calls[0].arguments)
    finally:
        await llm.aclose()
