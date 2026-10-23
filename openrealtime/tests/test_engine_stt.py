import asyncio

import numpy as np
import pytest

from engine_common import SR, pad, pink_noise, requires_gpu, speech16k, stt, wer
from ort.stt import collapse_repeats

pytestmark = requires_gpu

SENTENCES = [
    "I would like to book a table for two people tomorrow evening.",
    "What time does the store close today?",
    "The quick brown fox jumps over the lazy dog, and then it runs away into the forest.",
    "Please send the report to my manager before Friday.",
    "Yes.",
    "Thank you.",   # a real 'Thank you.' must survive the hallucination filter
    "Okay.",
]


def test_collapse_repeats():
    assert collapse_repeats("yes yes yes yes")[0] == "yes"
    assert collapse_repeats("I see. I see. I see. I see.")[0] == "I see."
    assert collapse_repeats("one two three")[0] == "one two three"
    assert collapse_repeats("go go")[0] == "go go"


@pytest.mark.parametrize("text", SENTENCES)
def test_roundtrip_wer(text):
    s = stt()
    out = asyncio.run(s.transcribe(pad(speech16k(text), 0.3, 0.3), language="en"))
    assert wer(text, out) <= 0.15, (text, out)


def test_roundtrip_in_noise_and_auto_language():
    s = stt()
    text = SENTENCES[0]
    x = pad(speech16k(text), 0.3, 0.3)
    x = x + pink_noise(len(x), -32)
    r = asyncio.run(s.transcribe_full(x))
    assert r.language == "en"
    assert wer(text, r.text) <= 0.2, r.text


def test_long_audio_over_30s():
    s = stt()
    text = SENTENCES[2]
    one = pad(speech16k(text), 0.2, 0.2)
    x = np.concatenate([one] * int(np.ceil(34 * SR / len(one))))
    out = asyncio.run(s.transcribe(x, language="en"))
    assert out.lower().count("fox") >= 4


@pytest.mark.parametrize("name,x", [
    ("silence", np.zeros(SR * 2, np.float32)),
    ("near-silence", (np.random.default_rng(0).standard_normal(SR * 2) * 1e-4).astype(np.float32)),
    ("white", (np.random.default_rng(1).standard_normal(SR * 3) * 0.01).astype(np.float32)),
    ("pink", pink_noise(SR * 3, -35)),
    ("loud-white", (np.random.default_rng(2).standard_normal(SR * 3) * 0.1).astype(np.float32)),
])
def test_no_hallucination_on_silence_and_noise(name, x):
    assert asyncio.run(stt().transcribe(x, language="en")) == "", name


def test_prompt_and_spanish():
    s = stt()
    es = "Hola, me gustaría reservar una mesa para dos personas."
    x = pad(speech16k(es, "ef_dora", "es"), 0.3, 0.3)
    r = asyncio.run(s.transcribe_full(x))
    assert r.language == "es"
    assert wer(es, r.text) <= 0.3, r.text
    out = asyncio.run(s.transcribe(pad(speech16k(SENTENCES[1]), 0.3, 0.3), "en", prompt="Store hours."))
    assert wer(SENTENCES[1], out) <= 0.15


def test_latency_is_low():
    s = stt()
    x = pad(speech16k(SENTENCES[0]), 0.3, 0.3)
    asyncio.run(s.transcribe_full(x, "en", "warm"))
    r = asyncio.run(s.transcribe_full(x, "en", "latency"))
    assert r.ms < 250, r.ms


def test_cache_hit_for_identical_audio():
    s = stt()
    x = pad(speech16k(SENTENCES[1]), 0.3, 0.3)
    asyncio.run(s.transcribe(x, "en"))
    assert s.cached(x, "en") is not None


def test_streaming_transcriber_partials():
    from ort.stt import StreamingTranscriber
    s = stt()
    text = SENTENCES[2]
    x = pad(speech16k(text), 0.2, 0.3)

    async def go():
        st = StreamingTranscriber(s, language="en", interval_ms=600)
        deltas = []
        step = int(0.1 * SR)
        for i in range(0, len(x), step):
            st.feed(x[i:i + step])
            d = await st.partial()
            if d:
                deltas.append(d)
        final = await st.final()
        return deltas, final, st

    deltas, final, st = asyncio.run(go())
    assert len(deltas) >= 2, deltas
    joined = "".join(deltas)
    assert wer(text, final) <= 0.15
    # stable deltas are a prefix of the final transcript (word-wise)
    jw, fw = joined.lower().split(), final.lower().split()
    assert len(jw) >= 4 and jw[:-1] == fw[:len(jw) - 1]
    st.reset()
    assert st.duration_ms == 0
