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


# ---------------------------------------------------------------- hardening: long / short / odd input
MONOLOGUE = [
    "My name is Alice and I have been working as a software engineer for about seven years.",
    "Before that I studied physics at a small university in the north of the country.",
    "Most of my work these days involves building data pipelines for a logistics company.",
    "We move millions of packages every week and every one of them produces events.",
    "The hardest part is not the volume but the messy and inconsistent data from partners.",
    "Last year we rewrote the entire ingestion layer and it took almost nine months.",
    "I learned a lot about patience during that project and about writing good tests.",
    "On weekends I like hiking in the mountains with my two dogs and my brother.",
    "Sometimes we camp near a lake where the water is so clear you can see the fish.",
    "In the winter I mostly stay inside, read novels, and try to cook something new.",
    "My favorite recipe right now is a slow cooked bean stew with smoked paprika.",
    "I am also trying to learn the piano although progress has been rather slow.",
    "Honestly I think the most important skill in my job is clear communication.",
    "If people do not understand what you built, it does not matter how good it is.",
]


def _monologue(gap_s=0.0):
    parts = []
    for t in MONOLOGUE:
        parts += [speech16k(t), np.zeros(int(gap_s * SR), np.float32)]
    return np.concatenate(parts)


def test_split_points_cover_everything_and_cut_in_pauses():
    from ort.stt import split_points
    x = _monologue(0.0)
    w = split_points(x)
    assert w[0][0] == 0 and w[-1][1] == len(x)
    assert all(a[1] == b[0] for a, b in zip(w, w[1:]))
    assert all(e - s <= 28 * SR for s, e in w)
    assert all(e - s >= SR for s, e in w)                 # no tiny tail window
    for s, _ in w[1:]:                                     # cut where it is quiet
        assert np.sqrt(np.mean(x[s - 400:s + 400] ** 2)) < 0.3 * np.sqrt(np.mean(x ** 2))


@pytest.mark.parametrize("offset_s", [0.0, 0.9, 1.5, 2.7])
def test_long_monologue_no_truncation_or_duplication_at_seams(offset_s):
    """72 s with no pauses between sentences: three Whisper windows. The seams used to be fixed
    28 s offsets (mid-word), which produced seam hallucinations ('partners' -> 'part of the
    country')."""
    x = np.concatenate([np.zeros(int(offset_s * SR), np.float32), _monologue(0.0)])
    ref = " ".join(MONOLOGUE)
    out = asyncio.run(stt().transcribe(x, "en"))
    from ort.stt import has_duplicate_phrase
    assert wer(ref, out) <= 0.03, out
    assert not has_duplicate_phrase(out)
    assert out.rstrip(". ").lower().endswith("how good it is")


def test_word_straddling_the_28s_boundary_is_kept():
    """A tail of < 0.2 s past a 28 s window used to be dropped (cutting the last word)."""
    head = speech16k(MONOLOGUE[0])
    five = speech16k("Five.")
    voiced = np.flatnonzero(np.abs(five) > 0.01)
    five = five[:voiced[-1] + 1]
    n_sil = int(28.15 * SR) - len(head) - len(five)
    x = np.concatenate([head, np.zeros(n_sil, np.float32), five])
    assert 28 * SR < len(x) < 28.2 * SR
    out = asyncio.run(stt().transcribe(x, "en")).lower()
    assert "five" in out or "5" in out, out


def test_noise_window_in_long_audio_adds_no_hallucination():
    x = np.concatenate([pad(speech16k(SENTENCES[0]), 0.3, 0.3), pink_noise(SR * 32, -50, seed=3)])
    out = asyncio.run(stt().transcribe(x, "en"))
    assert wer(SENTENCES[0], out) <= 0.15, out


@pytest.mark.parametrize("word", ["Yes.", "No.", "Okay.", "Two.", "Five.", "One.", "Sure.", "Nope."])
@pytest.mark.parametrize("voice", ["af_heart", "am_michael", "bf_emma"])
def test_one_word_answers_survive_hallucination_filter(word, voice):
    x = pad(speech16k(word, voice), 0.3, 0.5)
    r = asyncio.run(stt().transcribe_full(x, "en"))
    assert r.text and r.filtered is None, (word, voice, r)


def test_nan_and_dc_offset_input():
    x = pad(speech16k(SENTENCES[1]), 0.3, 0.3)
    bad = x.copy()
    bad[1000:1010] = np.nan
    bad[5000] = np.inf
    assert wer(SENTENCES[1], asyncio.run(stt().transcribe(bad, "en"))) <= 0.15
    assert wer(SENTENCES[1], asyncio.run(stt().transcribe(x + 0.25, "en"))) <= 0.15
    assert asyncio.run(stt().transcribe(np.full(SR * 2, 0.2, np.float32), "en")) == ""   # DC only


def test_very_quiet_and_clipped_input():
    from engine_common import at_level
    x = pad(speech16k(SENTENCES[0]), 0.3, 0.3)
    assert wer(SENTENCES[0], asyncio.run(stt().transcribe(at_level(x, -45), "en"))) <= 0.15
    assert wer(SENTENCES[0], asyncio.run(stt().transcribe(np.clip(x * 20, -1, 1), "en"))) <= 0.2


@pytest.mark.parametrize("lang,voice,text", [
    ("de", "ef_dora", "Ich möchte gerne einen Tisch für zwei Personen reservieren."),
    ("es", "ef_dora", "Me gustaría reservar una mesa para dos personas mañana."),
    ("fr", "ff_siwis", "Je voudrais réserver une table pour deux personnes demain soir."),
])
def test_non_english_hint_and_auto(lang, voice, text):
    x = pad(speech16k(text, voice, lang), 0.3, 0.3)
    auto = asyncio.run(stt().transcribe_full(x))
    hinted = asyncio.run(stt().transcribe_full(x, lang))
    assert auto.language == lang
    assert wer(text, hinted.text) <= 0.35, hinted.text
    assert wer(text, auto.text) <= 0.35, auto.text
    # region-tagged hints ('de-DE') work too
    assert asyncio.run(stt().transcribe(x, lang + "-XX")) == hinted.text


def test_streaming_partials_keep_flowing_past_30s():
    from ort.stt import StreamingTranscriber, has_duplicate_phrase
    x = np.concatenate([np.concatenate([speech16k(t), np.zeros(int(0.2 * SR), np.float32)]) for t in MONOLOGUE])
    ref = " ".join(MONOLOGUE)

    async def go():
        st = StreamingTranscriber(stt(), language="en")
        out, step = [], int(0.1 * SR)
        for i in range(0, len(x), step):
            st.feed(x[i:i + step])
            d = await st.partial()
            if d:
                out.append((i / SR, d))
        return out

    out = asyncio.run(go())
    assert len(x) > 70 * SR
    assert out[-1][0] > len(x) / SR - 3                 # partials until the very end
    assert sum(1 for t, _ in out if t > 30) >= 20
    joined = "".join(d for _, d in out)
    assert wer(ref, joined) <= 0.05, joined
    assert not has_duplicate_phrase(joined)


def test_nan_never_poisons_later_transcripts():
    """Regression: one chunk containing NaN made every later transcript '' (server-wide) because
    NaN K/V stayed in the static decoder cache (masked, but 0 * NaN = NaN)."""
    s = stt()
    x = pad(speech16k(SENTENCES[3]), 0.3, 0.3)
    bad = x.copy()
    bad[2000:2100] = np.nan
    asyncio.run(s.transcribe(bad, "en", prompt="poison"))
    # even if NaN reaches the GPU directly (bypassing input sanitising), the next decode is clean
    ids, sot, _ = s._prefix("en", None)
    s._executor.submit(s.fw.run, bad, 30, ids, sot, None, 20).result()
    out = asyncio.run(s.transcribe(pad(speech16k(SENTENCES[1]), 0.3, 0.3), "en", prompt="after"))
    assert wer(SENTENCES[1], out) <= 0.15, out
