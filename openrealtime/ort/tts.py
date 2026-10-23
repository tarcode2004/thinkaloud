"""Text-to-speech: Kokoro-82M on GPU with clause streaming.

`TTS.stream(text_chunks, voice, speed)` consumes an async iterator of LLM text deltas, cuts it
into speakable segments, synthesises each in a dedicated thread and yields 24 kHz float32 audio
as soon as the first clause is complete.

Segmentation policy (latency first, then prosody):
  * segment 0: first clause boundary (, ; : -- ) after >= 4 words, or any sentence end.
  * segment 1: clause boundary after >= 8 words, or sentence end.
  * later:     sentence ends (. ! ? newline); a clause boundary only once > 25 words are
               buffered; a hard word-boundary cut beyond 40 words.
Abbreviations ("Dr.", "e.g."), decimals ("3.5") and initials don't end sentences.

Every yielded chunk is a `SpokenAudio` (an `np.ndarray` subclass, so it *is* the float32 audio)
carrying `.text` (display text of that segment, markdown stripped, numbers as written: use it
for transcripts), `.spoken` (normalised text actually synthesised), `.words` (word timings in
seconds within the chunk, English only, else None) and `.index`. `text_until(seconds)` gives the
display-text prefix heard after `seconds` of the chunk was played (for truncation).
Only read these attributes on the yielded object itself (slices inherit them).

Languages: Kokoro natively supports en-US, en-GB, es, fr, hi, it, pt-BR (+ ja / zh when
misaki[ja] / misaki[zh] are installed). Anything else (German, Turkish, Dutch, ...) falls back
to espeak-ng phonemes for that language driven through a Kokoro voice: intelligible but
accented. If espeak-ng lacks the language too, English is used.
"""
from __future__ import annotations

import asyncio
import logging
import re
import threading
import time
from dataclasses import dataclass
from typing import AsyncIterator, Iterable

import numpy as np

from .audio import GPU_GATE, PriorityExecutor
from .prosody import ProsodyModel, patch_g2p, question_rises
from .textnorm import SpeechNormalizer

log = logging.getLogger("ort.tts")

SAMPLE_RATE = 24000
REPO = "hexgrad/Kokoro-82M"

# OpenAI voice -> (Kokoro voice, gender). Picks favour Kokoro's highest-graded voices.
OPENAI_VOICES: dict[str, tuple[str, str]] = {
    "alloy": ("af_heart", "f"),
    "ash": ("am_michael", "m"),
    "ballad": ("bm_george", "m"),
    "coral": ("af_bella", "f"),
    "echo": ("am_fenrir", "m"),
    "fable": ("bm_fable", "m"),
    "nova": ("af_nova", "f"),
    "onyx": ("am_onyx", "m"),
    "sage": ("af_sarah", "f"),
    "shimmer": ("af_kore", "f"),
    "verse": ("am_puck", "m"),
    "marin": ("af_heart", "f"),
    "cedar": ("am_michael", "m"),
}
DEFAULT_VOICE = "af_heart"

# language -> (kokoro lang_code, female voice, male voice)
NATIVE_LANGS: dict[str, tuple[str, str, str]] = {
    "en": ("a", "af_heart", "am_michael"),
    "en-us": ("a", "af_heart", "am_michael"),
    "en-gb": ("b", "bf_emma", "bm_george"),
    "es": ("e", "ef_dora", "em_alex"),
    "fr": ("f", "ff_siwis", "ff_siwis"),
    "hi": ("h", "hf_alpha", "hm_omega"),
    "it": ("i", "if_sara", "im_nicola"),
    "pt": ("p", "pf_dora", "pm_alex"),
    "pt-br": ("p", "pf_dora", "pm_alex"),
    "ja": ("j", "jf_alpha", "jm_kumo"),
    "zh": ("z", "zf_xiaobei", "zm_yunjian"),
}
# espeak-ng language for fallback languages, plus which Kokoro voice reads them best
ESPEAK_FALLBACK: dict[str, str] = {
    "de": "de", "tr": "tr", "nl": "nl", "pl": "pl", "ru": "ru", "sv": "sv", "da": "da",
    "nb": "nb", "no": "nb", "fi": "fi", "cs": "cs", "el": "el", "ro": "ro", "hu": "hu",
    "uk": "uk", "ar": "ar", "he": "he", "id": "id", "vi": "vi", "ko": "ko", "ca": "ca",
}
FALLBACK_VOICES = ("ef_dora", "em_alex")   # see bench: best Whisper round-trip on German

_ABBREV = {"dr", "mr", "mrs", "ms", "st", "jr", "sr", "prof", "vs", "etc", "eg", "e.g", "i.e", "ie",
           "no", "approx", "fig", "inc", "ltd", "co", "mt", "u.s", "a.m", "p.m", "ca", "z.b", "bzw",
           "usw", "nr", "hr", "fr", "sra", "sr", "dra"}
_INTERJECTIONS = {"sure", "okay", "ok", "yes", "yeah", "no", "well", "hi", "hello", "hey", "great",
                  "alright", "all right", "right", "so", "absolutely", "of course", "got it", "thanks",
                  "thank you", "oh", "hmm", "certainly", "perfect", "exactly", "indeed", "sorry",
                  "good question", "i see", "understood", "wow", "cool", "nice", "ah", "um", "uh"}
# words before which a phrase boundary is natural (used only for the first, latency-critical cuts)
_CONJ = {"because", "and", "but", "so", "which", "that", "when", "while", "if", "or", "since",
         "although", "though", "where", "who", "then", "unless", "until", "after", "before"}
_CLAUSE = re.compile(r"[,;:]|\s[-–—]{1,2}\s|—")
_SENT_END = re.compile(r"[.!?…。！？]+[\"'”’)\]]*")


@dataclass
class Segment:
    text: str
    index: int


class ClauseSegmenter:
    def __init__(self, first_min_words: int = 4, second_min_words: int = 8,
                 clause_max_words: int = 25, hard_max_words: int = 40):
        self.buf = ""
        self.n = 0
        self.first_min = first_min_words
        self.second_min = second_min_words
        self.clause_max = clause_max_words
        self.hard_max = hard_max_words

    def _min_clause_words(self) -> int | None:
        if self.n == 0:
            return self.first_min
        if self.n == 1:
            return self.second_min
        return None

    def _find_cut(self, final: bool) -> int | None:
        b = self.buf
        # sentence end followed by whitespace (lookahead needed: '3.' might become '3.5')
        for m in _SENT_END.finditer(b):
            end = m.end()
            if end >= len(b):
                if not final:
                    break
                continue
            if not b[end].isspace():
                continue
            if m.group(0).startswith(".") and len(m.group(0).rstrip("\"'”’)]")) == 1:
                prev = re.search(r"(\S+)$", b[:m.start()])
                w = prev.group(1).lower().rstrip(".") if prev else ""
                if w in _ABBREV or (len(w) == 1 and w.isalpha()):
                    continue
                # "1. First item": a list marker at the start of a line is not a sentence
                if w.isdigit() and re.search(r"(^|\n)[ \t]*\d+$", b[:m.start()]):
                    continue
            if b[:end].strip():
                return end
        nl = b.find("\n")
        if nl > 0 and b[:nl].strip():
            return nl + 1
        words = len(b.split())
        mc = self._min_clause_words()
        if mc is not None or words > self.clause_max:
            last = None
            for m in _CLAUSE.finditer(b):
                end = m.end()
                if end >= len(b) and not final:
                    break
                before = b[:m.start()]
                if self.n == 0 and re.sub(r"[^\w\s']", "", before).strip().lower() in _INTERJECTIONS:
                    last = end
                    break
                if len(before.split()) >= (mc or 4):
                    last = end
                    if mc is not None:
                        break
            if last is not None:
                return last
        if mc is not None and words >= 7:
            # no punctuation yet: cut before a conjunction ("... would be the second one | because ...")
            toks = list(re.finditer(r"\S+", b))
            complete = toks if (final or (b and b[-1].isspace())) else toks[:-1]
            for k in range(len(complete) - 1, 4, -1):
                if re.sub(r"\W", "", complete[k].group(0)).lower() in _CONJ:
                    return complete[k].start()
            if len(complete) >= (12 if self.n == 0 else 16):
                return complete[-1].end()
        if words > self.hard_max:
            # cut at the last whitespace before the final (possibly incomplete) word
            i = b.rstrip().rfind(" ")
            if i > 0:
                return i + 1
        return None

    def feed(self, delta: str) -> list[str]:
        self.buf += delta
        out = []
        while True:
            cut = self._find_cut(final=False)
            if cut is None:
                break
            seg, self.buf = self.buf[:cut], self.buf[cut:]
            if seg.strip():
                out.append(seg)
                self.n += 1
        return out

    def flush(self) -> list[str]:
        out = []
        while self.buf.strip():
            cut = self._find_cut(final=True)
            if cut is None or cut >= len(self.buf):
                out.append(self.buf)
                self.buf = ""
                break
            seg, self.buf = self.buf[:cut], self.buf[cut:]
            if seg.strip():
                out.append(seg)
        self.n += len(out)
        self.buf = ""
        return out


class SpokenAudio(np.ndarray):
    """float32 audio @24 kHz with the text it speaks attached."""
    text: str
    spoken: str
    words: list | None
    index: int

    def __new__(cls, audio: np.ndarray, text: str = "", spoken: str = "", words=None, index: int = 0):
        obj = np.asarray(audio, dtype=np.float32).view(cls)
        obj.text, obj.spoken, obj.words, obj.index = text, spoken, words, index
        return obj

    def __array_finalize__(self, obj):
        if obj is None:
            return
        self.text = getattr(obj, "text", "")
        self.spoken = getattr(obj, "spoken", "")
        self.words = getattr(obj, "words", None)
        self.index = getattr(obj, "index", 0)

    @property
    def duration(self) -> float:
        return len(self) / SAMPLE_RATE

    def text_until(self, seconds: float) -> str:
        """Display-text prefix the listener heard after `seconds` of this chunk played."""
        d = self.duration
        if seconds >= d - 1e-3:
            return self.text
        if seconds <= 0:
            return ""
        frac = seconds / d
        if self.words:
            spoken_words = [w for w in self.words if w[0].strip()]
            heard = sum(1 for w in spoken_words if (w[1] + w[2]) / 2 <= seconds)
            frac = heard / max(1, len(spoken_words))
        disp = self.text.split(" ")
        lead = self.text[: len(self.text) - len(self.text.lstrip())]
        words = [w for w in disp if w]
        k = int(round(frac * len(words)))
        return (lead + " ".join(words[:k])) if k else ""

    def plain(self) -> np.ndarray:
        return self.view(np.ndarray)


def _phoneme_safe_chunks(text: str, max_chars: int = 200) -> list[str]:
    """Split text so each piece stays well below Kokoro's 510-phoneme limit (espeak output is
    roughly 1-1.3 phonemes per character): at sentence ends, else clause marks, else spaces."""
    text = text.strip()
    if len(text) <= max_chars:
        return [text] if text else []
    out = []
    while len(text) > max_chars:
        window = text[:max_chars]
        cut = -1
        for pat in (r"[.!?…](?=\s)", r"[,;:](?=\s)", r"\s"):
            ms = list(re.finditer(pat, window))
            if ms and ms[-1].end() > max_chars // 3:
                cut = ms[-1].end()
                break
        if cut <= 0:
            cut = max_chars                      # one giant 'word': hard cut
        out.append(text[:cut].strip())
        text = text[cut:].strip()
    if text:
        out.append(text)
    return [p for p in out if p]


def _trim(a: np.ndarray, lead_ms: int, trail_ms: int, thresh: float = 2e-3) -> tuple[np.ndarray, int]:
    """Trim leading/trailing near-silence, keeping some margin. Returns (audio, start_index)."""
    if not len(a):
        return a, 0
    idx = np.flatnonzero(np.abs(a) > thresh)
    if not len(idx):
        return a[:0], 0
    s = max(0, idx[0] - lead_ms * SAMPLE_RATE // 1000)
    e = min(len(a), idx[-1] + 1 + trail_ms * SAMPLE_RATE // 1000)
    return a[s:e], s


def _fade(a: np.ndarray, ms: int = 4) -> np.ndarray:
    n = min(len(a) // 2, ms * SAMPLE_RATE // 1000)
    if n > 0:
        a = a.copy()
        r = np.linspace(0, 1, n, dtype=np.float32)
        a[:n] *= r
        a[-n:] *= r[::-1]
    return a


class TTS:
    sample_rate = SAMPLE_RATE

    def __init__(self, device: str = "cuda", repo_id: str = REPO, default_language: str = "en",
                 question_rise_st: float = 5.0):
        self.device = device
        self.question_rise_st = question_rise_st
        self.repo_id = repo_id
        self.default_language = default_language
        # one GPU thread shared by all sessions; the first clause of any response jumps the
        # queue, later clauses go round-robin (clause k of every stream before clause k+1)
        self._executor = PriorityExecutor("ort-tts")
        self._model = None
        self._pipes: dict[str, object] = {}
        self._lock = threading.Lock()
        self.last_stats: dict = {}

    # ---------------- loading ----------------
    def _load(self):
        if self._model is not None:
            return self._model
        with GPU_GATE.exclusive(), self._lock:
            if self._model is None:
                import torch
                from kokoro import KModel
                self._torch = torch
                self._model = KModel(repo_id=self.repo_id).to(self.device).eval()
        return self._model

    def _pipeline(self, key: str):
        """key: kokoro lang code ('a','b','e',...) or 'x:<espeak-lang>' for fallback."""
        p = self._pipes.get(key)
        if p is not None:
            return p
        from kokoro import KPipeline
        model = self._load()
        with GPU_GATE.exclusive(), self._lock:
            p = self._pipes.get(key)
            if p is not None:
                return p
            if key.startswith("x:"):
                from misaki import espeak
                p = KPipeline(lang_code="e", repo_id=self.repo_id, model=model)
                p.g2p = espeak.EspeakG2P(language=key[2:])
            else:
                p = KPipeline(lang_code=key, repo_id=self.repo_id, model=model)
                if key in ("a", "b"):
                    patch_g2p(p.g2p)
            self._pipes[key] = p
        return p

    def resolve(self, voice: str | None, language: str | None = None) -> tuple[str, str]:
        """(kokoro_voice, pipeline_key) for an OpenAI or Kokoro voice name and a language."""
        v = (voice or "alloy").strip()
        vl = v.lower()
        if vl in OPENAI_VOICES:
            kv, gender = OPENAI_VOICES[vl]
        elif re.fullmatch(r"[a-z][fm]_\w+", vl):
            kv, gender = vl, vl[1]
        else:
            kv, gender = DEFAULT_VOICE, "f"
        lang = (language or self.default_language or "en").lower().replace("_", "-")
        base = lang.split("-")[0]
        if base == "en":
            if lang == "en-gb" or kv[0] == "b":
                return (kv if kv[0] == "b" else NATIVE_LANGS["en-gb"][1 if gender == "f" else 2]), "b"
            return (kv if kv[0] == "a" else NATIVE_LANGS["en"][1 if gender == "f" else 2]), "a"
        nat = NATIVE_LANGS.get(lang) or NATIVE_LANGS.get(base)
        if nat and self._lang_available(nat[0]):
            code = nat[0]
            if kv[0] == code:
                return kv, code
            return nat[1 if gender == "f" else 2], code
        esp = ESPEAK_FALLBACK.get(base)
        if esp and self._espeak_has(esp):
            return FALLBACK_VOICES[0 if gender == "f" else 1], "x:" + esp
        return (kv if kv[0] == "a" else DEFAULT_VOICE), "a"

    _avail_cache: dict = {}

    def _lang_available(self, code: str) -> bool:
        if code in self._avail_cache:
            return self._avail_cache[code]
        ok = True
        try:
            if code == "j":
                import misaki.ja  # noqa: F401
            elif code == "z":
                import misaki.zh  # noqa: F401
        except Exception:
            ok = False
        self._avail_cache[code] = ok
        return ok

    def _espeak_has(self, lang: str) -> bool:
        k = "esp:" + lang
        if k not in self._avail_cache:
            try:
                from misaki import espeak
                espeak.EspeakG2P(language=lang)("test")
                self._avail_cache[k] = True
            except Exception:
                self._avail_cache[k] = False
        return self._avail_cache[k]

    def warmup(self, languages: Iterable[str] = ("en",)) -> None:
        def w():
            for lang in languages:
                for v in ("alloy", "ash"):
                    kv, key = self.resolve(v, lang)
                    for t in ("Hello there.", "This is a warm-up sentence with a few more words in it."):
                        self._synth(t, kv, key, 1.0, None)
        self._executor.submit(w).result()

    # ---------------- synthesis ----------------
    def _synth(self, text: str, kvoice: str, key: str, speed: float, cancel: threading.Event | None):
        if cancel is not None and cancel.is_set():
            return None
        pipe = self._pipeline(key)
        with GPU_GATE.shared():
            return self._synth_locked(pipe, text, kvoice, key, speed, cancel)

    def _synth_locked(self, pipe, text, kvoice, key, speed, cancel):
        audios, words, off = [], [], 0.0
        # English G2P splits at Kokoro's 510-phoneme limit itself; the espeak path only cuts at
        # sentence ends and silently TRUNCATES longer phoneme strings, so pre-split those.
        parts = [text] if key in ("a", "b") else _phoneme_safe_chunks(text)
        def run(part):
            model = None
            if key in ("a", "b") and self.question_rise_st > 0 and "?" in part:
                model = ProsodyModel(self._model, question_rises(part), self.question_rise_st)
            return pipe(part, voice=kvoice, speed=speed, split_pattern=None, model=model)
        for r in (r for part in parts for r in run(part)):
            if cancel is not None and cancel.is_set():
                return None
            if r.audio is None:
                continue
            a = r.audio.detach().float().cpu().numpy()
            if r.tokens:
                for t in r.tokens:
                    if getattr(t, "start_ts", None) is not None and t.end_ts is not None:
                        words.append((t.text + (" " if t.whitespace else ""), off + t.start_ts, off + t.end_ts))
            audios.append(a)
            off += len(a) / SAMPLE_RATE
        if not audios:
            return np.zeros(0, np.float32), None
        a = np.concatenate(audios) if len(audios) > 1 else audios[0]
        return a.astype(np.float32, copy=False), (words or None)

    async def synthesize(self, text: str, voice: str = "alloy", speed: float = 1.0,
                         language: str | None = None) -> np.ndarray:
        """Whole utterance (normalised) -> audio."""
        async def one():
            yield text
        chunks = [c async for c in self.stream(one(), voice, speed, language=language)]
        return np.concatenate([c.plain() for c in chunks]) if chunks else np.zeros(0, np.float32)

    async def stream(self, text_chunks: AsyncIterator[str] | Iterable[str], voice: str = "alloy",
                     speed: float = 1.0, language: str | None = None,
                     lookahead: int = 2, priority: int | None = None) -> AsyncIterator[SpokenAudio]:
        """LLM text deltas -> SpokenAudio chunks (float32 @24 kHz). Cancel-safe.

        Scheduling across concurrent streams: segment 0 runs before any later segment of any
        stream; segment k>0 of every stream before segment k+1 (round-robin). `priority` (lower
        = sooner, default 1) shifts this stream's later segments, e.g. 0 for a short urgent
        prompt, 2 for background synthesis. A closed stream's queued work is dropped."""
        loop = asyncio.get_running_loop()
        kvoice, key = self.resolve(voice, language)
        lang = (language or self.default_language or "en").lower().split("-")[0]
        speed = float(min(1.5, max(0.25, speed or 1.0)))
        cancel = threading.Event()
        job_key = ("tts", id(cancel))
        seg_q: asyncio.Queue = asyncio.Queue()
        out_q: asyncio.Queue = asyncio.Queue(maxsize=max(1, lookahead))
        t0 = time.perf_counter()
        stats = {"segments": 0, "first_text_ms": None, "first_audio_ms": None, "synth_ms": []}
        self.last_stats = stats
        END = object()

        async def reader():
            seg = ClauseSegmenter()
            try:
                if hasattr(text_chunks, "__aiter__"):
                    async for d in text_chunks:
                        if d:
                            if stats["first_text_ms"] is None:
                                stats["first_text_ms"] = (time.perf_counter() - t0) * 1000
                            for s in seg.feed(d):
                                await seg_q.put(s)
                else:
                    for d in text_chunks:
                        for s in seg.feed(d or ""):
                            await seg_q.put(s)
                for s in seg.flush():
                    await seg_q.put(s)
                await seg_q.put(END)
            except asyncio.CancelledError:
                raise
            except BaseException as e:  # propagate LLM errors to the consumer
                await seg_q.put(e)

        async def synthesizer():
            norm = SpeechNormalizer(lang)
            idx = 0
            try:
                while True:
                    s = await seg_q.get()
                    if s is END or isinstance(s, BaseException):
                        await out_q.put(s)
                        return
                    display, spoken = norm(s)
                    if not spoken:
                        continue
                    ts = time.perf_counter()
                    prio = (0, 0, 0) if idx == 0 else (1, 1 if priority is None else int(priority), idx)
                    res = await asyncio.wrap_future(self._executor.submit_prio(
                        prio, self._synth, spoken, kvoice, key, speed, cancel, key=job_key))
                    if res is None:
                        return
                    audio, words = res
                    stats["synth_ms"].append((time.perf_counter() - ts) * 1000)
                    # first chunk: cut leading silence (time-to-first-audio); all chunks: cap the
                    # trailing silence so inter-segment pauses sound natural
                    audio, cut = _trim(audio, 15 if idx == 0 else 1000, 250)
                    if words and cut:
                        sh = cut / SAMPLE_RATE
                        words = [(w, max(0.0, a - sh), max(0.0, b - sh)) for w, a, b in words]
                    if not len(audio):
                        continue
                    chunk = SpokenAudio(_fade(audio, 3), display, spoken, words, idx)
                    idx += 1
                    await out_q.put(chunk)
            except asyncio.CancelledError:
                raise
            except BaseException as e:
                await out_q.put(e)

        rtask = asyncio.ensure_future(reader())
        stask = asyncio.ensure_future(synthesizer())
        try:
            while True:
                item = await out_q.get()
                if item is END:
                    break
                if isinstance(item, BaseException):
                    raise item
                if stats["first_audio_ms"] is None:
                    stats["first_audio_ms"] = (time.perf_counter() - t0) * 1000
                stats["segments"] += 1
                yield item
        finally:
            cancel.set()
            self._executor.drop(job_key)          # queued clauses of an abandoned stream: skip
            for t in (rtask, stask):
                t.cancel()
            for t in (rtask, stask):
                try:
                    await t
                except BaseException:
                    pass
