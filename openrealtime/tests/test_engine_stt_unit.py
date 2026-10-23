"""StreamingTranscriber bookkeeping with a scripted (fake) STT: no GPU needed."""
import asyncio

import numpy as np

import engine_common  # noqa: F401  (sys.path)
from ort.stt import SR, StreamingTranscriber, Transcript, _join_seam


class ScriptedSTT:
    def __init__(self, texts):
        self.texts, self.calls = list(texts), []

    async def transcribe_full(self, x, language=None, prompt=None, partial=False, **kw):
        self.calls.append((len(x), prompt, partial))
        return Transcript(self.texts.pop(0) if len(self.texts) > 1 else self.texts[0], "en")


def _drive(st, seconds, step_s=0.1):
    out = []

    async def go():
        for _ in range(int(seconds / step_s)):
            st.feed(np.full(int(step_s * SR), 0.1, np.float32))
            d = await st.partial()
            if d:
                out.append(d)
    asyncio.run(go())
    return out


def test_resplit_word_is_not_emitted_twice():
    # 'slow-cooked' re-transcribed as 'slow cooked' used to shift the committed index by one
    texts = ["we had a slow-cooked", "we had a slow-cooked stew with", "we had a slow-cooked stew with smoked",
             "we had a slow cooked stew with smoked paprika", "we had a slow cooked stew with smoked paprika today",
             "we had a slow cooked stew with smoked paprika today ok"]
    st = StreamingTranscriber(ScriptedSTT(texts), language="en", interval_ms=600)
    joined = "".join(_drive(st, 4.0))
    assert joined.split() == "we had a slow-cooked stew with smoked paprika today".split(), joined


def test_long_utterance_freezes_prefix_and_keeps_partials():
    stt = ScriptedSTT(["one two three four five six"])
    st = StreamingTranscriber(stt, language="en", interval_ms=600, max_partial_s=20, keep_s=8)
    _drive(st, 45.0)
    longest = max(n for n, _, partial in stt.calls if partial)
    assert longest <= 21 * SR                     # partial windows stay bounded
    assert st._base > 0 and st._frozen
    assert any(p and "one two" in p for _, p, partial in stt.calls if partial)   # prompted with frozen text


def test_join_seam_drops_word_cut_in_half():
    assert _join_seam("with smoked", "smoked paprika") == "with smoked paprika"
    assert _join_seam("a b c", "d e") == "a b c d e"
    assert _join_seam("", "x") == "x"


def test_backward_compatible_with_minimal_stt_doubles():
    """STT objects without the scheduling kwargs (priority= / stream=) and results without
    `.filtered` keep working."""
    from types import SimpleNamespace

    class Minimal:
        async def transcribe(self, x, language=None, prompt=None):
            return "final"

        async def transcribe_full(self, x, language=None, prompt=None, partial=False):
            return SimpleNamespace(text="hello there my friend", language="en")
    st = StreamingTranscriber(Minimal(), language="en", interval_ms=600)
    assert "".join(_drive(st, 3.0)).split() == ["hello", "there", "my"]
    assert asyncio.run(st.final()) == "final"


def test_superseded_partial_is_retried():
    class Preempted(ScriptedSTT):
        async def transcribe_full(self, x, language=None, prompt=None, partial=False, **kw):
            self.calls.append(len(x))
            if len(self.calls) == 2:
                return Transcript("", "en", filtered="superseded")
            return Transcript("alpha beta gamma delta", "en")
    st = StreamingTranscriber(Preempted(["x"]), language="en", interval_ms=600)
    _drive(st, 0.7)
    n_before = st._last_n
    asyncio.run(st.partial()) if st.due() else None
    st.feed(np.full(int(0.6 * SR), 0.1, np.float32))
    assert asyncio.run(st.partial()) is None          # superseded: no delta, no state change
    assert st._last_n == n_before and st.due()         # ... and due again right away
