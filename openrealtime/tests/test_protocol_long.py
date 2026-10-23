"""Long sessions: hundreds of items, hours of (simulated) input audio, context-window truncation
for the LLM request (session `truncation`: 'auto' | 'disabled' | retention_ratio) while the realtime
conversation stays intact, and bounded memory (audio buffers, word marks, output clocks)."""
import asyncio
import json
import os
import sys
import time

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["OPENREALTIME_LLM"] = "mock"

from fakes import RT, FakeLLM, FakeSTT, FakeTTS, FakeTurnDetector, make_config, make_engine, running_app  # noqa: E402
from ort import events as E  # noqa: E402
from ort.session import IN_SR, Session  # noqa: E402

pytestmark = pytest.mark.asyncio


def tokens(msgs):
    return sum(len(json.dumps(m)) for m in msgs) // 4


async def run_turns(n, truncation, context_tokens=3000, instructions="You are a helpful moderator. " * 5):
    llm = FakeLLM()
    async with running_app(make_engine(llm=llm, tts=FakeTTS(ms_per_char=0.2)), context_tokens=context_tokens,
                           ws_audio_lead_ms=100000) as client:
        rt = await RT.connect(client)
        await rt.wait_for("session.created")
        await rt.send({"type": "session.update", "session": {"instructions": instructions, "truncation": truncation,
                                                             "audio": {"input": {"turn_detection": None}}}})
        await rt.wait_for("session.updated")
        sess = next(iter(client.app[STATE].sessions))
        statuses = []
        for i in range(n):
            await rt.send({"type": "conversation.item.create", "item": {"type": "message", "role": "user", "content": [
                {"type": "input_text", "text": f"Turn {i}: here is what I see on the screen right now, and my thoughts."}]}})
            await rt.send({"type": "response.create"})
            rd = await rt.wait_for("response.done", timeout=10)
            statuses.append(rd["response"]["status"])
        await rt.close()
        return llm, sess, statuses, rt


from ort.server import STATE  # noqa: E402


async def test_200_turns_auto_truncation_keeps_conversation_intact():
    llm, sess, statuses, rt = await run_turns(210, "auto")
    assert statuses == ["completed"] * 210
    assert len(sess.items) == 420                                      # realtime conversation: everything
    assert sess.items[0]["content"][0]["text"].startswith("Turn 0:")
    for c in llm.calls:
        msgs = c["messages"]
        assert msgs[0]["role"] == "system" and msgs[0]["content"].startswith("You are a helpful")
        assert E.estimate_tokens(msgs) <= 3000, E.estimate_tokens(msgs)
        assert msgs[-1]["role"] == "user"                              # the current turn is never dropped
        assert msgs[1]["role"] != "tool"
    last = llm.calls[-1]["messages"]
    assert last[-1]["content"].startswith("Turn 209:")
    assert not any(m["content"].startswith("Turn 0:") for m in last if m["role"] == "user")
    # usage reflects the truncated prompt, not the whole conversation
    assert len(llm.calls[-1]["messages"]) < 120


async def test_retention_ratio_truncates_rarely_and_stably():
    llm_a, _, _, _ = await run_turns(120, "auto")
    llm_r, _, _, _ = await run_turns(120, {"type": "retention_ratio", "retention_ratio": 0.5})

    def first_kept(llm):
        return [next(m["content"] for m in c["messages"] if m["role"] == "user") for c in llm.calls]

    def cut_changes(llm):
        fk = first_kept(llm)
        return sum(1 for a, b in zip(fk, fk[1:]) if a != b)

    # auto drops a little on (almost) every turn once full; retention_ratio drops a lot, rarely
    assert cut_changes(llm_r) * 4 < cut_changes(llm_a), (cut_changes(llm_r), cut_changes(llm_a))
    # a retention_ratio cut leaves about ratio * budget of conversation
    for c in llm_r.calls:
        assert E.estimate_tokens(c["messages"]) <= 3000


async def test_token_limits_post_instructions():
    llm, _, _, _ = await run_turns(60, {"type": "retention_ratio", "retention_ratio": 0.8,
                                        "token_limits": {"post_instructions": 800}}, context_tokens=32000)
    for c in llm.calls:
        conv = c["messages"][1:]
        assert E.estimate_tokens(conv) <= 800 + 40


async def test_truncation_disabled_fails_when_over_the_window():
    llm, sess, statuses, rt = await run_turns(80, "disabled", context_tokens=3000)
    assert statuses[0] == "completed"
    assert "failed" in statuses
    fail = next(e for e in rt.of("response.done") if e["response"]["status"] == "failed")
    err = fail["response"]["status_details"]["error"]
    assert err["code"] == "context_length_exceeded" and err["type"] == "invalid_request_error"


async def test_truncation_never_splits_tool_calls():
    from fakes import tool_call
    script = []
    for i in range(40):
        script += [[f"Checking item {i} now.", tool_call("lookup", {"x": i}, f"call_{i}")], f"Done with {i}."]
    llm = FakeLLM(script)
    tools = [{"type": "function", "name": "lookup", "parameters": {"type": "object", "properties": {"x": {"type": "integer"}}}}]
    async with running_app(make_engine(llm=llm, tts=FakeTTS(ms_per_char=0.2)), context_tokens=1200,
                           ws_audio_lead_ms=100000) as client:
        rt = await RT.connect(client)
        await rt.wait_for("session.created")
        await rt.send({"type": "session.update", "session": {"tools": tools, "audio": {"input": {"turn_detection": None}}}})
        for i in range(40):
            await rt.send({"type": "conversation.item.create", "item": {"type": "message", "role": "user", "content": [
                {"type": "input_text", "text": f"Please look up item number {i} for me."}]}})
            await rt.send({"type": "response.create"})
            await rt.wait_for("response.done", timeout=5)
            await rt.send({"type": "conversation.item.create", "item": {"type": "function_call_output", "call_id": f"call_{i}",
                                                                         "output": json.dumps({"value": i})}})
            await rt.send({"type": "response.create"})
            await rt.wait_for("response.done", timeout=5)
        for c in llm.calls:
            msgs = c["messages"]
            for j, m in enumerate(msgs):
                if m["role"] == "tool":
                    k = j - 1
                    while msgs[k]["role"] == "tool":
                        k -= 1
                    assert msgs[k]["role"] == "assistant" and any(tc["id"] == m["tool_call_id"] for tc in msgs[k]["tool_calls"])
        await rt.close()


# ------------------------------------------------------------------ memory bounds

async def test_memory_bounded_over_many_spoken_responses():
    llm = FakeLLM()
    async with running_app(make_engine(llm=llm, tts=FakeTTS(ms_per_char=0.2)), ws_audio_lead_ms=100000) as client:
        for pacing in ("audio",):
            rt = await RT.connect(client)
            await rt.wait_for("session.created")
            await rt.send({"type": "session.update", "session": {"audio": {"input": {"turn_detection": None}}}})
            sess = next(iter(client.app[STATE].sessions))
            for i in range(150):
                await rt.send({"type": "conversation.item.create", "item": {"type": "message", "role": "user", "content": [
                    {"type": "input_text", "text": f"Turn {i} with a few more words to say back."}]}})
                await rt.send({"type": "response.create"})
                await rt.wait_for("response.done", timeout=10)
            await asyncio.sleep(0.2)
            with_marks = [i for i in sess.items if i.get("_marks")]
            assert len(with_marks) <= 16, len(with_marks)              # word timings kept only for recent items
            assert len(sess.output.items) <= 4, len(sess.output.items)  # per-item playout clocks are dropped
            assert len(sess.responses) <= 64
            # an old item can still be truncated (proportional fallback), a recent one exactly
            old = sess.items[1]
            await rt.send({"type": "conversation.item.truncate", "item_id": old["id"], "content_index": 0, "audio_end_ms": 0})
            tr = await rt.wait_for("conversation.item.truncated")
            assert tr["item_id"] == old["id"] and old["content"][0]["transcript"] == ""
            await rt.close()


async def test_eager_pacing_does_not_leak_output_clocks():
    llm = FakeLLM()
    async with running_app(make_engine(llm=llm, tts=FakeTTS(ms_per_char=0.2)), ws_audio_lead_ms=100000,
                           transcript_pacing="eager") as client:
        rt = await RT.connect(client)
        await rt.wait_for("session.created")
        await rt.send({"type": "session.update", "session": {"audio": {"input": {"turn_detection": None}}}})
        sess = next(iter(client.app[STATE].sessions))
        for i in range(40):
            await rt.send({"type": "conversation.item.create", "item": {"type": "message", "role": "user", "content": [
                {"type": "input_text", "text": f"Turn {i}."}]}})
            await rt.send({"type": "response.create"})
            await rt.wait_for("response.done", timeout=10)
        await asyncio.sleep(0.5)
        assert len(sess.output.items) <= 2, len(sess.output.items)
        await rt.close()


class CheapDetector(FakeTurnDetector):
    """FakeTurnDetector that skips long all-zero chunks quickly (hours of silence in seconds)."""

    def feed(self, chunk):
        if not self.in_speech and not np.any(chunk) and self._buf.size == 0 and chunk.size % self.FRAME == 0:
            self.pos += chunk.size
            self.run = 0
            return []
        return super().feed(chunk)


async def test_hours_of_input_audio_stay_bounded():
    """3 h of mic audio with a short utterance every 10 minutes: the input buffer stays small and
    the audio timeline (audio_start_ms) stays exact."""
    stt = FakeSTT(default="hello")
    eng = make_engine(llm=FakeLLM(), stt=stt, tts=FakeTTS(ms_per_char=0.2), turn_factory=lambda c: CheapDetector(c))
    s = Session(eng, make_config(), E.new_session("gpt-realtime", {"audio": {"input": {"turn_detection": {
        "type": "server_vad", "silence_duration_ms": 200, "create_response": False}}}}))
    got = []
    s.add_listener(got.append)
    s.start()
    t0 = time.monotonic()
    sil = np.zeros(IN_SR * 60, np.float32)          # one minute
    burst = (0.3 * np.sin(2 * np.pi * 300 * np.arange(int(IN_SR * 0.6)) / IN_SR)).astype(np.float32)
    peak = 0
    for minute in range(180):
        if minute % 10 == 5:
            s.feed_input_16k(burst)
        s.feed_input_16k(sil)
        await s._drain_input()
        peak = max(peak, s._buf_len)
    await asyncio.sleep(0.1)
    starts = [e["audio_start_ms"] for e in got if e["type"] == "input_audio_buffer.speech_started"]
    assert len(starts) == 18
    # utterance k starts after 5 + 10k minutes of silence plus k earlier bursts (minus 300 ms padding)
    for k, ms in enumerate(starts):
        expect = (5 + 10 * k) * 60_000 + k * 600 - 300
        assert abs(ms - expect) <= 80, (k, ms, expect)
    assert peak <= IN_SR * 62, peak / IN_SR                        # never more than ~1 minute buffered
    assert len(s._transcripts) <= 32
    assert time.monotonic() - t0 < 60
    await s.close()


async def test_manual_mode_input_buffer_is_capped():
    """Manual turn detection + a mic that never commits: the buffer stays at the cap (oldest dropped)."""
    s = Session(make_engine(), make_config(max_input_buffer_s=120), E.new_session("gpt-realtime", {
        "audio": {"input": {"turn_detection": None}}}))
    s.start()
    sil = np.zeros(IN_SR * 60, np.float32)
    for _ in range(10):
        s.feed_input_16k(sil)
    await s._drain_input()
    assert s._buf_len <= IN_SR * 121
    assert s._in_total == IN_SR * 600
    await s.close()
