import asyncio
import time

import numpy as np
import pytest

from engine_common import requires_gpu, stt, tts, wer
from ort.audio import resample
from ort.tts import OPENAI_VOICES, ClauseSegmenter, SpokenAudio, TTS


def _segments(text, step=3):
    s = ClauseSegmenter()
    out = []
    for i in range(0, len(text), step):
        out += s.feed(text[i:i + step])
    return out + s.flush()


def test_segmenter_first_clause_early_then_sentences():
    t = ("Well, I think that we should go now, before it rains. Dr. Smith said it costs $3.50, "
         "e.g. for apples. Then we can talk.")
    segs = _segments(t)
    assert segs[0] == "Well,"                      # interjection: earliest possible first audio
    assert "".join(segs) == t                      # nothing lost, whitespace preserved
    assert any(s.strip().startswith("Dr. Smith") for s in segs)   # no split after 'Dr.'
    assert not any(s.strip() == "e.g." for s in segs)


def test_segmenter_min_words_for_first_clause():
    segs = _segments("I can help you with that, of course. Let me check the calendar for you.")
    assert segs[0] == "I can help you with that,"
    assert segs[1].strip() == "of course."


def test_segmenter_decimal_not_split_and_hard_cut():
    assert _segments("Pi is 3.14159 roughly.") == ["Pi is 3.14159 roughly."]
    long = " ".join(["word"] * 60)
    segs = _segments(long)
    assert len(segs) >= 2 and "".join(segs) == long


def test_voice_mapping():
    t = TTS.__new__(TTS)
    t.default_language = "en"
    t._avail_cache = {}
    for v, (kv, g) in OPENAI_VOICES.items():
        assert t.resolve(v, "en")[0] == kv
    assert t.resolve("af_bella")[0] == "af_bella"
    assert t.resolve("unknown-voice")[0] == "af_heart"
    assert t.resolve("ash", "es") == ("em_alex", "e")
    assert t.resolve("alloy", "fr") == ("ff_siwis", "f")
    assert t.resolve("ballad", "en") == ("bm_george", "b")
    v, key = t.resolve("alloy", "de")
    assert key == "x:de"


async def _llm(text, delay=0.01):
    for w in text.split(" "):
        await asyncio.sleep(delay)
        yield w + " "


@requires_gpu
def test_stream_first_audio_before_llm_finishes():
    t = tts()
    text = ("Sure, I can help you with that. The restaurant opens at 5:30 pm and a table for two "
            "costs about $40. Would you like me to book it for tomorrow evening?")

    async def go():
        t0 = time.perf_counter()
        first, chunks = None, []
        async for c in t.stream(_llm(text, 0.02), "alloy"):
            if first is None:
                first = time.perf_counter() - t0
            chunks.append(c)
        return first, time.perf_counter() - t0, chunks

    first, total, chunks = asyncio.run(go())
    assert first < 0.25, first                         # 'Sure,' is spoken almost immediately
    assert total > 0.5 and first < total / 3
    assert all(isinstance(c, SpokenAudio) and isinstance(c, np.ndarray) for c in chunks)
    assert all(c.dtype == np.float32 and c.ndim == 1 for c in chunks)
    transcript = "".join(c.text for c in chunks)
    assert transcript.split() == text.split()           # display text == what the LLM wrote
    spoken = " ".join(c.spoken for c in chunks)
    assert "forty dollars" in spoken and "five thirty P M" in spoken
    assert chunks[0].words and chunks[0].words[0][0].strip()


@requires_gpu
def test_markdown_and_emoji_not_spoken():
    t = tts()

    async def go():
        return [c async for c in t.stream(_llm("**Great** news 🎉! Check https://example.com/x for details."), "coral")]

    chunks = asyncio.run(go())
    spoken = " ".join(c.spoken for c in chunks)
    assert "*" not in spoken and "🎉" not in spoken and "https" not in spoken
    assert "example dot com" in spoken


@requires_gpu
def test_cancellation_is_prompt():
    t = tts()

    async def go():
        async def endless():
            while True:
                await asyncio.sleep(0.001)
                yield "This sentence goes on and on. "
        agen = t.stream(endless(), "ash")
        n = 0
        async for _ in agen:
            n += 1
            if n == 2:
                break
        t0 = time.perf_counter()
        await agen.aclose()
        dt = time.perf_counter() - t0
        # task cancellation path
        async def consume():
            async for _ in t.stream(endless(), "ash"):
                pass
        task = asyncio.ensure_future(consume())
        await asyncio.sleep(0.3)
        t1 = time.perf_counter()
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        return dt, time.perf_counter() - t1

    dt_close, dt_cancel = asyncio.run(go())
    assert dt_close < 0.15 and dt_cancel < 0.15


@requires_gpu
def test_llm_error_propagates():
    t = tts()

    async def bad():
        yield "Hello there, my friend. "
        raise RuntimeError("llm died")

    async def go():
        got = []
        with pytest.raises(RuntimeError):
            async for c in t.stream(bad(), "alloy"):
                got.append(c)
        return got

    asyncio.run(go())


@requires_gpu
def test_truncation_text_until():
    t = tts()

    async def go():
        return [c async for c in t.stream(_llm("One two three four five six seven eight."), "alloy")]

    c = asyncio.run(go())[0]
    assert c.text_until(0) == ""
    assert c.text_until(c.duration) == c.text
    half = c.text_until(c.duration / 2)
    assert 0 < len(half.split()) < len(c.text.split())


@requires_gpu
@pytest.mark.parametrize("lang,text,max_wer", [
    ("en", "The weather is lovely today, so let's go for a walk in the park.", 0.1),
    ("es", "Hola, ¿cómo estás? Me alegro de verte.", 0.35),
    ("fr", "Bonjour, je voudrais un café, s'il vous plaît.", 0.35),
    ("de", "Guten Tag, wie geht es Ihnen heute?", 0.5),   # espeak fallback: accented
])
def test_tts_stt_roundtrip_languages(lang, text, max_wer):
    t, s = tts(), stt()
    a = asyncio.run(t.synthesize(text, "alloy", language=lang))
    assert len(a) > 24000 * 0.5
    out = asyncio.run(s.transcribe(resample(a, 24000, 16000), language=lang))
    assert wer(text, out) <= max_wer, (lang, out)


# ---------------------------------------------------------------- hardening
def test_segmenter_numbered_list_markers_stay_with_item():
    # '1.' used to become its own segment, spoken as "one." before each list item
    assert _segments("1. First item\n2. Second item\n3. Third") == ["1. First item\n", "2. Second item\n", "3. Third"]
    assert _segments("I have 3. You have 4.") == ["I have 3.", " You have 4."]


def test_segmenter_huge_unpunctuated_sentence_is_cut_not_lost():
    words = ("we keep talking about the plan for the new office and the people who will move there " * 20).split()[:300]
    segs = _segments(" ".join(words), step=5)
    assert " ".join(segs).split() == words
    assert max(len(s.split()) for s in segs) <= 41


def test_phoneme_safe_chunks():
    from ort.tts import _phoneme_safe_chunks
    text = " ".join(["Donaudampfschifffahrtsgesellschaftskapitän"] * 30)
    parts = _phoneme_safe_chunks(text)
    assert " ".join(parts).split() == text.split()
    assert all(len(p) <= 200 for p in parts)
    assert _phoneme_safe_chunks("") == [] and _phoneme_safe_chunks("Kurz.") == ["Kurz."]
    assert all(len(p) <= 200 for p in _phoneme_safe_chunks("x" * 1000))


@requires_gpu
@pytest.mark.parametrize("lang", ["de", "es", "en"])
def test_long_text_is_not_truncated_at_510_phonemes(lang):
    """Kokoro's espeak path truncated anything over 510 phonemes: 300 German words came out as
    23 s of audio (13 words/s) instead of ~100 s."""
    t = tts()
    base = {"de": "der schnelle braune Fuchs springt über den faulen Hund während der Bauer zuschaut",
            "es": "el rápido zorro marrón salta sobre el perro perezoso mientras el granjero mira",
            "en": "the quick brown fox jumps over the lazy dog while the farmer watches from his porch"}[lang]
    text = " ".join((base.split() * 30)[:300])
    kv, key = t.resolve("alloy", lang)
    a, _ = t._executor.submit(t._synth, text, kv, key, 1.0, None).result()
    wps = 300 / (len(a) / 24000)
    assert 1.8 < wps < 4.5, wps


async def _deltas(parts, delay=0.0):
    for p in parts:
        if delay:
            await asyncio.sleep(delay)
        yield p


@requires_gpu
@pytest.mark.parametrize("parts", [[], [""], ["", "  ", "\n", " \t "], ["**", "", "🎉", "```", "\n```"]])
def test_empty_and_unspeakable_deltas_yield_nothing(parts):
    t = tts()

    async def go():
        return [c async for c in t.stream(_deltas(parts), "alloy")]
    t0 = time.perf_counter()
    assert asyncio.run(go()) == []
    assert time.perf_counter() - t0 < 0.5


@requires_gpu
def test_tokens_split_across_deltas():
    t = tts()
    parts = ["Th", "ank", " you", " for", " wait", "ing", ",", " Dr", ".", " Sm", "ith", ". It", "'s 3", ".", "5", "%", " now", "."]

    async def go():
        return [c async for c in t.stream(_deltas(parts, 0.005), "alloy")]
    chunks = asyncio.run(go())
    assert "".join(c.text for c in chunks).split() == "".join(parts).split()
    spoken = " ".join(c.spoken for c in chunks)
    assert "Thank you" in spoken and "Doctor Smith" in spoken and "three point five percent" in spoken
    out = asyncio.run(stt().transcribe(resample(np.concatenate([c.plain() for c in chunks]), 24000, 16000), "en"))
    assert wer("Thank you for waiting, Doctor Smith. It's 3.5% now.", out) <= 0.3, out


@requires_gpu
def test_edge_text_battery_speaks_cleanly():
    t = tts()
    text = ("Here's the summary:\n\n| Item | Cost |\n|---|---|\n| Coffee | €3.50 |\n| Cake | £4 |\n\n"
            "- Call **555-123-4567** or email help@example.com\n- Visit https://example.com/menu\n"
            "```python\nprint('never spoken')\n```\n"
            "Prices rose 12% on 2024-03-15 at 9:30 a.m., e.g. from -5 to v2.1 levels. 🎉")

    async def go():
        return [c async for c in t.stream(_deltas([text[i:i + 4] for i in range(0, len(text), 4)]), "alloy")]
    chunks = asyncio.run(go())
    spoken = " ".join(c.spoken for c in chunks)
    for bad in ("never spoken", "print", "|", "**", "https", "🎉", "```"):
        assert bad not in spoken, (bad, spoken)
    for good in ("three euros and fifty cents", "four pounds", "twelve percent", "March fifteenth",
                 "nine thirty", "for example", "minus five", "version two point one", "example dot com"):
        assert good in spoken, (good, spoken)
    assert all(len(c) > 0 and np.isfinite(c).all() for c in chunks)


@requires_gpu
def test_cancel_mid_synthesis_frees_the_gpu_quickly():
    t = tts()
    long_de = " ".join(("der schnelle braune Fuchs springt über den faulen Hund, " * 40).split())

    async def go():
        agen = t.stream(_deltas([long_de]), "alloy", language="de")
        async for _ in agen:
            break
        await agen.aclose()
        t0 = time.perf_counter()
        a = await t.synthesize("Hello again.", "alloy")
        return time.perf_counter() - t0, a
    dt, a = asyncio.run(go())
    assert len(a) > 0
    assert dt < 0.4, dt          # did not wait for the abandoned 400-word stream
