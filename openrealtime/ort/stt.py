"""Speech-to-text: Whisper large-v3-turbo on GPU, fp16, tuned for realtime latency.

Speed tricks (all transparent to callers):
  * log-mel computed on GPU with torch.stft (no CPU feature extractor).
  * Encoder context bucketing (partials only by default): Whisper is trained on 30 s windows;
    shorter encoder windows (15/20 s) are ~35% faster and fine for provisional partials, but on
    a 32-utterance multilingual round-trip they changed 5-8 outputs (mostly punctuation) and
    a 10 s window produced loops/duplications, so FINAL transcripts use the exact 30 s window
    unless ORT_STT_FINAL_BUCKETS (e.g. "15,20,30") says otherwise. Loops fall back to 30 s.
  * Custom greedy decoder with a static KV cache, captured in a CUDA graph per bucket
    (one graph replay per token, ~2 ms; on GB10 that is the LPDDR5x bandwidth floor for the
    4 decoder layers + 66M-param vocab projection). Steps are replayed in short chunks without
    host syncs; EOT is checked between chunks. HF generate() for the same: 215 ms -> ~140 ms (6 s).
  * Encoder (+ cross-attention K/V projection) also captured as a CUDA graph per bucket.
  * Everything runs in one dedicated thread so GPU calls serialize and the event loop never blocks.

Hallucination guards: energy gate (near-silence never reaches the GPU); text with no words
('...', music notes) dropped; stock phrases ("Thanks for watching!") always dropped; and when the
output looks suspicious (blacklisted short phrase like "Thank you." / "you", low avg logprob,
loops, implausible token rate) a Silero pass over the audio must find >= 120 ms of voiced
speech or the result is ''. (large-v3-turbo's no_speech_prob is ~1e-10 on everything, so it is
kept only as a secondary signal.) Repeated n-gram loops are collapsed.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field

import numpy as np

from .audio import GPU_GATE, PriorityExecutor, sanitize

log = logging.getLogger("ort.stt")

SR = 16000
def _env_buckets(name: str, default: tuple[int, ...]) -> tuple[int, ...]:
    v = os.environ.get(name, "").strip()
    if not v:
        return default
    b = tuple(sorted({min(30, max(10, int(x))) for x in v.split(",") if x.strip().isdigit()} | {30}))
    return b


FINAL_BUCKETS = _env_buckets("ORT_STT_FINAL_BUCKETS", (30,))
PARTIAL_BUCKETS = _env_buckets("ORT_STT_PARTIAL_BUCKETS", (15, 20, 30))
BUCKETS_S = tuple(sorted(set(FINAL_BUCKETS) | set(PARTIAL_BUCKETS)))
MIN_TAIL_S = 3.0          # trailing context a truncated encoder window needs to terminate cleanly
MAX_AUDIO_S = 28.0        # per window; longer audio is transcribed in consecutive windows
MIN_WINDOW_S = 18.0       # long audio is cut at the quietest point between 18 and 28 s of a window
MAX_TOKENS = 448

# Classic Whisper silence/noise hallucinations (normalised: lowercase, no punctuation)
HALLUCINATIONS = {
    "you", "thank you", "thank you very much", "thanks", "thanks for watching",
    "thank you for watching", "thanks for watching and see you next time", "bye", "bye bye",
    "goodbye", "so", "okay", "oh", "uh", "um", "hmm", "mm", "ah", "the", "i", "a", "and",
    "please subscribe", "subscribe", "like and subscribe", "see you next time",
    "see you in the next video", "subtitles by the amaraorg community", "amaraorg",
    "transcribed by", "music", "applause", "silence", "laughter", "", "you you",
    "thank you so much", "thanks for listening", "thank you for listening", "1", "2",
    "vielen dank", "danke", "untertitel im auftrag des zdf", "merci", "gracias",
    "sous-titres réalisés par la communauté d'amaraorg", "продолжение следует",
}

LANG_ALIASES = {"iw": "he", "jw": "jv"}

# STT queue priorities (lower runs first). Finals / speculative finals are latency-critical;
# partial transcripts are optional and give the GPU up as soon as anything more urgent is queued.
PRIO_FINAL = 0
PRIO_NORMAL = 1
PRIO_PARTIAL = 2
_PRIO_NAMES = {"final": PRIO_FINAL, "urgent": PRIO_FINAL, "speculative": PRIO_FINAL,
               "normal": PRIO_NORMAL, "partial": PRIO_PARTIAL, "background": PRIO_PARTIAL}


def _prio(priority, partial: bool) -> int:
    if priority is None:
        return PRIO_PARTIAL if partial else PRIO_FINAL
    if isinstance(priority, str):
        return _PRIO_NAMES.get(priority.lower(), PRIO_NORMAL)
    return int(priority)


@dataclass
class Transcript:
    text: str
    language: str | None = None
    no_speech_prob: float = 0.0
    avg_logprob: float = 0.0
    tokens: int = 0
    bucket_s: int = 30
    ms: float = 0.0
    filtered: str | None = None   # reason the text was suppressed, if it was
    raw: str = ""
    timings: dict = field(default_factory=dict)


def _norm(s: str) -> str:
    s = s.lower().strip()
    s = re.sub(r"[^\w\s']", "", s)
    return re.sub(r"\s+", " ", s).strip()


def split_points(x: np.ndarray, max_s: float = MAX_AUDIO_S, min_s: float = MIN_WINDOW_S,
                 min_last_s: float = 1.0) -> list[tuple[int, int]]:
    """Cut long audio into <= max_s windows at the quietest 100 ms between min_s and max_s of each
    window (a pause between words), never mid-word at a fixed offset, and never leaving a tail
    shorter than min_last_s. Returns [(start, end), ...] covering all of x."""
    n, win = len(x), int(max_s * SR)
    out, s = [], 0
    while n - s > win:
        cut = quietest_point(x, s + int(min_s * SR), min(s + win, n - int(min_last_s * SR)))
        out.append((s, cut))
        s = cut
    out.append((s, n))
    return out


def quietest_point(x: np.ndarray, lo: int, hi: int) -> int:
    """Sample index in [lo, hi) at the centre of the quietest 100 ms (latest one on ties)."""
    hop = SR // 50                                             # 20 ms
    lo, hi = max(0, lo), min(len(x), hi)
    if hi - lo < 5 * hop:
        return max(lo, hi)
    seg = x[lo:hi]
    k = len(seg) // hop
    e = (seg[:k * hop].reshape(k, hop) ** 2).mean(1)
    e = np.convolve(e, np.ones(5) / 5, mode="same")
    j = int(np.flatnonzero(e <= e.min() * 1.05 + 1e-12)[-1])
    return lo + j * hop + hop // 2


def has_duplicate_phrase(text: str, min_n: int = 3) -> bool:
    """True if some phrase of >= min_n words is immediately repeated (a truncation artefact)."""
    w = [_norm(x) for x in text.split()]
    for n in range(min_n, min(12, len(w) // 2) + 1):
        for i in range(0, len(w) - 2 * n + 1):
            if w[i:i + n] == w[i + n:i + 2 * n] and any(w[i:i + n]):
                return True
    return False


def collapse_repeats(text: str, min_reps: int = 3) -> tuple[str, bool]:
    """Collapse n-gram loops ('yes yes yes yes', 'I see. I see. I see.') to one occurrence."""
    words = text.split()
    if len(words) < min_reps:
        return text, False
    changed = False
    for n in range(1, min(12, len(words) // min_reps) + 1):
        out, i = [], 0
        while i < len(words):
            unit = [_norm(w) for w in words[i:i + n]]
            reps = 1
            while i + (reps + 1) * n <= len(words) and \
                    [_norm(w) for w in words[i + reps * n:i + (reps + 1) * n]] == unit:
                reps += 1
            if reps >= min_reps and len(unit) == n and any(unit):
                out.extend(words[i:i + n])
                i += reps * n
                changed = True
            else:
                out.append(words[i])
                i += 1
        words = out
    return " ".join(words), changed


class _FastWhisper:
    """Static-shape Whisper encoder/decoder with CUDA graphs. Must be used from a single thread."""

    def __init__(self, model, device, dtype, use_graphs: bool = True):
        import torch
        self.torch = torch
        self.m = model
        self.dev = device
        self.dtype = dtype
        self.enc = model.model.encoder
        self.dec = model.model.decoder
        cfg = model.config
        self.L = cfg.decoder_layers
        self.H = cfg.decoder_attention_heads
        self.D = cfg.d_model
        self.Dh = self.D // self.H
        self.V = cfg.vocab_size
        self.MAX = cfg.max_target_positions
        self.use_graphs = use_graphs and device.startswith("cuda")
        kv = (self.L, 1, self.H, self.MAX, self.Dh)
        self.kc = torch.zeros(kv, device=device, dtype=dtype)
        self.vc = torch.zeros(kv, device=device, dtype=dtype)
        self.ar = torch.arange(self.MAX, device=device)
        # mel filters (librosa slaney, same as HF WhisperFeatureExtractor)
        from transformers import WhisperFeatureExtractor
        fe = WhisperFeatureExtractor.from_pretrained(model.name_or_path)
        self.n_mels = fe.feature_size
        self.mel = torch.tensor(fe.mel_filters, device=device, dtype=torch.float32).T  # [n_mels, 201]
        self.window = torch.hann_window(400, device=device)
        self.buckets: dict[int, dict] = {}
        # sampling bias (suppress tokens + timestamps) in fp32
        gc = model.generation_config
        bias = torch.zeros(self.V, device=device, dtype=torch.float32)
        sup = [t for t in (gc.suppress_tokens or []) if t < self.V]
        bias[sup] = -float("inf")
        self.ts_begin = gc.no_timestamps_token_id + 1
        bias[self.ts_begin:] = -float("inf")
        self.eot = gc.eos_token_id if isinstance(gc.eos_token_id, int) else gc.eos_token_id[0]
        for tid in (gc.decoder_start_token_id, gc.no_timestamps_token_id,
                    getattr(gc, "prev_sot_token_id", None) or 50362):
            if tid is not None and tid < self.V:
                bias[tid] = -float("inf")
        self.bias = bias
        self.begin_bias = bias.clone()
        for t in (gc.begin_suppress_tokens or []):
            self.begin_bias[t] = -float("inf")

    # ---------------- features / encoder ----------------
    def logmel(self, audio_t, n_samples):
        torch = self.torch
        x = torch.zeros(n_samples, device=self.dev, dtype=torch.float32)
        n = min(len(audio_t), n_samples)
        x[:n] = audio_t[:n]
        st = torch.stft(x, 400, 160, window=self.window, return_complex=True)
        mag = st[..., :-1].abs() ** 2
        mel = self.mel @ mag
        ls = torch.clamp(mel, min=1e-10).log10()
        ls = torch.maximum(ls, ls.max() - 8.0)
        return ((ls + 4.0) / 4.0)[None].to(self.dtype)  # [1, n_mels, frames]

    def _encode(self, feats):
        F = self.torch.nn.functional
        enc = self.enc
        x = F.gelu(enc.conv1(feats))
        x = F.gelu(enc.conv2(x)).permute(0, 2, 1)
        x = x + enc.embed_positions.weight[: x.shape[1]]
        for layer in enc.layers:
            x = layer(x, None)
            if isinstance(x, tuple):
                x = x[0]
        return enc.layer_norm(x)

    def _cross_kv(self, h, ck, cv):
        n = h.shape[1]
        for i, layer in enumerate(self.dec.layers):
            a = layer.encoder_attn
            ck[i].copy_(a.k_proj(h).view(1, n, self.H, self.Dh).transpose(1, 2))
            cv[i].copy_(a.v_proj(h).view(1, n, self.H, self.Dh).transpose(1, 2))

    # ---------------- decoder ----------------
    def _decode(self, ids, pos, ck, cv):
        """ids [1,T] long, pos [T] long -> logits [1,T,V] (fp32). Writes self-attn KV at `pos`."""
        torch = self.torch
        F = torch.nn.functional
        dec = self.dec
        T = ids.shape[1]
        x = dec.embed_tokens(ids) + dec.embed_positions.weight[pos][None]
        mask = (self.ar[None, :] <= pos[:, None])[None, None]  # [1,1,T,MAX]
        for i, layer in enumerate(dec.layers):
            sa = layer.self_attn
            r = x
            h = layer.self_attn_layer_norm(x)
            q = (sa.q_proj(h) * sa.scaling).view(1, T, self.H, self.Dh).transpose(1, 2)
            k = sa.k_proj(h).view(1, T, self.H, self.Dh).transpose(1, 2)
            v = sa.v_proj(h).view(1, T, self.H, self.Dh).transpose(1, 2)
            self.kc[i].index_copy_(2, pos, k)
            self.vc[i].index_copy_(2, pos, v)
            a = F.scaled_dot_product_attention(q, self.kc[i], self.vc[i], attn_mask=mask, scale=1.0)
            x = r + sa.out_proj(a.transpose(1, 2).reshape(1, T, self.D))
            ca = layer.encoder_attn
            r = x
            h = layer.encoder_attn_layer_norm(x)
            q = (ca.q_proj(h) * ca.scaling).view(1, T, self.H, self.Dh).transpose(1, 2)
            a = F.scaled_dot_product_attention(q, ck[i], cv[i], scale=1.0)
            x = r + ca.out_proj(a.transpose(1, 2).reshape(1, T, self.D))
            r = x
            h = layer.final_layer_norm(x)
            x = r + layer.fc2(F.gelu(layer.fc1(h)))
        x = dec.layer_norm(x)
        return self.m.proj_out(x).float()

    def _step(self, b):
        """One greedy step on bucket b's static buffers (graph-capturable)."""
        torch = self.torch
        logits = self._decode(b["tok"], b["pos"], b["ck"], b["cv"])[0, -1] + self.bias
        lsm = torch.log_softmax(logits, -1)
        lp, nxt = lsm.max(-1)
        b["pos"].add_(1)
        b["hist"].index_copy_(0, b["pos"], nxt.view(1))
        b["lph"].index_copy_(0, b["pos"], lp.view(1))
        b["tok"].copy_(nxt.view(1, 1))

    def bucket(self, sec: int) -> dict:
        b = self.buckets.get(sec)
        if b is not None:
            return b
        with GPU_GATE.exclusive():      # no other GPU work may run while a graph is captured
            return self._make_bucket(sec)

    def _make_bucket(self, sec: int) -> dict:
        torch = self.torch
        n_frames = sec * 50
        b = {
            "sec": sec,
            "n_samples": sec * SR,
            "audio": torch.zeros(sec * SR, device=self.dev, dtype=torch.float32),
            "ck": torch.zeros((self.L, 1, self.H, n_frames, self.Dh), device=self.dev, dtype=self.dtype),
            "cv": torch.zeros((self.L, 1, self.H, n_frames, self.Dh), device=self.dev, dtype=self.dtype),
            "tok": torch.zeros((1, 1), device=self.dev, dtype=torch.long),
            "pos": torch.zeros(1, device=self.dev, dtype=torch.long),
            "hist": torch.zeros(self.MAX + 1, device=self.dev, dtype=torch.long),
            "lph": torch.zeros(self.MAX + 1, device=self.dev, dtype=torch.float32),
            "enc_graph": None, "step_graph": None,
        }
        self.buckets[sec] = b

        def enc_fn():
            feats = self.logmel(b["audio"], b["n_samples"])
            h = self._encode(feats)
            self._cross_kv(h, b["ck"], b["cv"])

        b["enc_fn"] = enc_fn
        if self.use_graphs:
            try:
                with torch.inference_mode():
                    s = torch.cuda.Stream()
                    s.wait_stream(torch.cuda.current_stream())
                    with torch.cuda.stream(s):
                        for _ in range(2):
                            enc_fn()
                            b["pos"].fill_(5)
                            self._step(b)
                    torch.cuda.current_stream().wait_stream(s)
                    g = torch.cuda.CUDAGraph()
                    with torch.cuda.graph(g):
                        enc_fn()
                    b["enc_graph"] = g
                    b["pos"].fill_(5)
                    g2 = torch.cuda.CUDAGraph()
                    with torch.cuda.graph(g2):
                        self._step(b)
                    b["step_graph"] = g2
                    torch.cuda.synchronize()
            except Exception as e:  # pragma: no cover - depends on driver
                log.warning("CUDA graph capture failed (%s); using eager decoding", e)
                b["enc_graph"] = b["step_graph"] = None
                self.use_graphs = False
        return b

    def run(self, audio: np.ndarray, sec: int, prefix_ids: list[int], sot_index: int,
            lang_ids: dict[str, int] | None, max_new: int, first_chunk: int = 4, abort=None):
        """Encode `audio` in bucket `sec`, decode greedily.

        prefix_ids: [<|startofprev|> prompt...] <|sot|> [lang] <|transcribe|> <|notimestamps|>;
        if `lang_ids` is given the language token is detected (inserted after sot).
        Returns (token_ids, logprobs, no_speech_prob, language, timings).
        """
        torch = self.torch
        t0 = time.perf_counter()
        b = self.bucket(sec)
        tm = {}
        with GPU_GATE.shared(), torch.inference_mode():
            # stale self-attention K/V beyond the current length is masked, but 0 * NaN = NaN in
            # the attention product: one bad decode would poison every later one. Start clean.
            self.kc.zero_()
            self.vc.zero_()
            a = torch.from_numpy(np.ascontiguousarray(audio[: b["n_samples"]], dtype=np.float32))
            b["audio"].zero_()
            b["audio"][: len(a)].copy_(a, non_blocking=False)
            if b["enc_graph"] is not None:
                b["enc_graph"].replay()
            else:
                b["enc_fn"]()
            # prefill up to and including SOT -> no_speech prob (+ language detection)
            pre = prefix_ids[: sot_index + 1]
            ids = torch.tensor([pre], device=self.dev)
            pos = torch.arange(len(pre), device=self.dev)
            logits = self._decode(ids, pos, b["ck"], b["cv"])[0, -1]
            probs = torch.softmax(logits, -1)
            no_speech = probs[50363 if self.V > 50363 else 0]
            lang = None
            rest = prefix_ids[sot_index + 1:]
            if lang_ids:
                codes = list(lang_ids)
                lid = torch.tensor([lang_ids[c] for c in codes], device=self.dev)
                li = int(torch.argmax(logits[lid]).item())
                lang = codes[li]
                rest = [lang_ids[lang]] + rest
            ids = torch.tensor([rest], device=self.dev)
            p0 = len(pre)
            pos = torch.arange(p0, p0 + len(rest), device=self.dev)
            logits = self._decode(ids, pos, b["ck"], b["cv"])[0, -1] + self.begin_bias
            lsm = torch.log_softmax(logits, -1)
            lp0, first = lsm.max(-1)
            P = p0 + len(rest)          # position of the first generated token
            b["tok"].copy_(first.view(1, 1))
            b["pos"].fill_(P)
            b["hist"][P] = first
            b["lph"][P] = lp0
            nsp = float(no_speech.item())
            tm["enc+prefill_ms"] = (time.perf_counter() - t0) * 1000
            limit = min(self.MAX - 1, P + max_new)
            out_tokens: list[int] = []
            done = int(first.item()) == self.eot
            cur = P
            n = max(1, first_chunk)
            while not done and cur < limit:
                if abort is not None and abort():
                    tm["aborted"] = True
                    break
                steps = min(n, limit - cur)
                for _ in range(steps):
                    if b["step_graph"] is not None:
                        b["step_graph"].replay()
                    else:
                        self._step(b)
                cur += steps
                seg = b["hist"][P: cur + 1].tolist()
                if self.eot in seg:
                    done = True
                n = 3
            seg = b["hist"][P: cur + 1].tolist()
            lps = b["lph"][P: cur + 1].tolist()
        if self.eot in seg:
            k = seg.index(self.eot)
            seg, lps = seg[:k], lps[:k + 1]
        tm["total_ms"] = (time.perf_counter() - t0) * 1000
        return seg, lps, nsp, lang, (not done), tm


class STT:
    """Whisper STT. `await transcribe(pcm16k)` -> text. Thread-safe, GPU calls serialized."""

    def __init__(self, model: str = "openai/whisper-large-v3-turbo", device: str = "cuda",
                 dtype: str = "float16", fast: bool | None = None):
        self.model_id = model
        self.device = device
        self.dtype_name = dtype
        self.fast = (os.environ.get("ORT_STT_FAST", "1") != "0") if fast is None else fast
        self._executor = PriorityExecutor("ort-stt")   # one GPU thread; finals before partials
        self._loaded = False
        self._load_lock = threading.Lock()
        self._cache: OrderedDict[str, Transcript] = OrderedDict()
        self._cache_lock = threading.Lock()
        self.last: Transcript | None = None

    # ---------------- loading ----------------
    def _load(self):
        if self._loaded:
            return
        with self._load_lock, GPU_GATE.exclusive():
            if self._loaded:
                return
            import torch
            from transformers import WhisperForConditionalGeneration, WhisperTokenizerFast
            dtype = getattr(torch, self.dtype_name) if self.device.startswith("cuda") else torch.float32
            self.torch = torch
            self.dtype = dtype
            t = time.perf_counter()
            self.model = WhisperForConditionalGeneration.from_pretrained(
                self.model_id, dtype=dtype, attn_implementation="sdpa").to(self.device).eval()
            self.tok = WhisperTokenizerFast.from_pretrained(self.model_id)
            gc = self.model.generation_config
            self.lang_ids = {k.strip("<|>"): v for k, v in (gc.lang_to_id or {}).items()}
            self.sot = gc.decoder_start_token_id
            self.transcribe_id = gc.task_to_id["transcribe"]
            self.notimestamps = gc.no_timestamps_token_id
            self.sot_prev = self.tok.convert_tokens_to_ids("<|startofprev|>")
            self.eot = gc.eos_token_id if isinstance(gc.eos_token_id, int) else gc.eos_token_id[0]
            self.fw = _FastWhisper(self.model, self.device, dtype, use_graphs=self.fast)
            self._loaded = True
            log.info("Whisper loaded in %.1fs", time.perf_counter() - t)

    def warmup(self) -> None:
        """Load the model and capture CUDA graphs for all buckets (blocks; ~5-15 s)."""
        self._executor.submit(self._warmup_sync).result()

    def _warmup_sync(self):
        self._load()
        rng = np.random.default_rng(0)
        for sec in BUCKETS_S:
            self.fw.bucket(sec)                      # capture CUDA graphs up front
            x = (rng.standard_normal(int((sec - MIN_TAIL_S) * SR)) * 0.01).astype(np.float32)
            for partial in (False, True):
                self._transcribe_sync(x, "en", None, use_cache=False, partial=partial)
                self._transcribe_sync(x, None, "warm up", use_cache=False, partial=partial)

    # ---------------- public API ----------------
    async def transcribe(self, pcm16k: np.ndarray, language: str | None = None,
                         prompt: str | None = None, priority=None, stream=None) -> str:
        r = await self.transcribe_full(pcm16k, language, prompt, priority=priority, stream=stream)
        return r.text

    async def transcribe_full(self, pcm16k: np.ndarray, language: str | None = None,
                              prompt: str | None = None, partial: bool = False, priority=None,
                              stream=None) -> Transcript:
        """Like transcribe() but returns the Transcript with language, confidences and timings.
        partial=True uses the faster (slightly less exact) encoder windows.

        Scheduling (one GPU thread, shared by all sessions): finals run before partials
        (`priority`: "final" (default) | "normal" | "partial" or an int, lower first). `stream`
        (any hashable, e.g. StreamingTranscriber.stream_key) groups a session's requests: a
        queued partial of that stream is dropped when a newer partial or a final for it is
        queued, and a running partial stops decoding as soon as a final from anyone is queued.
        A dropped / pre-empted partial returns Transcript('', filtered='superseded')."""
        prio = _prio(priority, partial)
        x = np.asarray(pcm16k, dtype=np.float32)
        key = ("partial", stream) if stream is not None else None
        if stream is not None and prio < PRIO_PARTIAL:
            self._executor.drop(key)                  # its partials are moot now
        fut = self._executor.submit_prio(
            prio, self._transcribe_sync, x, language, prompt, True, partial,
            key=key if prio >= PRIO_PARTIAL else None, supersede=prio >= PRIO_PARTIAL and key is not None,
            dropped_result=Transcript("", language, filtered="superseded"))
        return await asyncio.wrap_future(fut)

    def transcribe_sync(self, pcm16k, language=None, prompt=None) -> str:
        return self._executor.submit_prio(PRIO_FINAL, self._transcribe_sync, np.asarray(pcm16k, np.float32),
                                          language, prompt).result().text

    def cached(self, pcm16k: np.ndarray, language=None, prompt=None) -> Transcript | None:
        """Return a previous result for exactly this audio (e.g. from a speculative call)."""
        with self._cache_lock:
            return self._cache.get(self._key(np.asarray(pcm16k, np.float32), language, prompt))

    # ---------------- internals ----------------
    @staticmethod
    def _key(x, language, prompt):
        h = hashlib.blake2b(x.tobytes(), digest_size=16)
        h.update(f"|{language}|{prompt}".encode())
        return h.hexdigest()

    def _prefix(self, language: str | None, prompt: str | None):
        ids = []
        if prompt:
            p = self.tok.encode(" " + prompt.strip(), add_special_tokens=False)
            ids = [self.sot_prev] + p[-(MAX_TOKENS // 2 - 1):]
        sot_index = len(ids)
        ids.append(self.sot)
        detect = None
        if language:
            lang = LANG_ALIASES.get(language.lower().split("-")[0], language.lower().split("-")[0])
            if lang in self.lang_ids:
                ids.append(self.lang_ids[lang])
            else:
                detect = self.lang_ids
        else:
            detect = self.lang_ids
        ids += [self.transcribe_id, self.notimestamps]
        return ids, sot_index, detect

    def _transcribe_sync(self, x: np.ndarray, language, prompt, use_cache=True,
                         partial: bool = False) -> Transcript:
        self._load()
        t0 = time.perf_counter()
        x = np.asarray(x, dtype=np.float32).ravel()
        key = self._key(x, language, prompt) if use_cache else None
        x = sanitize(x)                       # NaN / inf would turn the whole decode into garbage
        if key and partial:
            key = "p:" + key
        if key and partial:
            with self._cache_lock:          # a final result is at least as good as a partial
                hit = self._cache.get(key[2:])
            if hit is not None:
                return hit
        if key:
            with self._cache_lock:
                hit = self._cache.get(key)
            if hit is not None:
                return hit
        if len(x) < SR * 0.1:
            r = Transcript("", language, filtered="too_short")
            return self._remember(key, r)
        if abs(float(x.mean())) > 1e-3:       # DC offset: inflates the energy / peak gates
            from scipy.signal import lfilter
            x = lfilter([1.0, -1.0], [1.0, -0.995], x - x[:SR // 10].mean()).astype(np.float32)
        peak = float(np.max(np.abs(x))) if len(x) else 0.0
        energy = float(np.sqrt(np.mean(x * x)))
        if peak < 1e-3 or energy < 3e-4:          # < ~ -70 dBFS: nothing there
            return self._remember(key, Transcript("", language, filtered="silence"))
        # loudness normalisation for very quiet input (Whisper is fairly level-robust anyway)
        if peak < 0.1:
            x = x * (0.3 / peak)
        texts, metas = [], []
        windows = split_points(x)
        for s, e in windows:
            seg = x[s:e]
            ptxt = prompt if s == 0 else " ".join(t for t in texts if t)[-400:] or prompt
            seg_energy = float(np.sqrt(np.mean(seg * seg))) if len(seg) else 0.0
            if len(windows) > 1 and (len(seg) < SR * 0.1 or seg_energy < 3e-4):
                metas.append(Transcript("", language, filtered="silence"))   # silent window
            else:
                abort = (lambda: self._executor.urgent_waiting(PRIO_PARTIAL)) if partial else None
                m = self._decode_window(seg, language, ptxt, partial, abort)
                if m.filtered == "superseded":      # gave the GPU up for a final: not cached
                    return m
                if not partial:
                    m = self._check_coverage(m, seg, language, ptxt)
                if len(windows) > 1:          # a silent / noisy window must not add "Thank you."
                    m = self._guard(m, seg_energy, len(seg) / SR, seg)
                metas.append(m)
            texts.append(metas[-1].text)
            if language is None and metas[-1].language:
                language = metas[-1].language
        r = metas[0] if len(metas) == 1 else Transcript(
            " ".join(t for t in texts if t).strip(), language,
            max(m.no_speech_prob for m in metas), float(np.mean([m.avg_logprob for m in metas])),
            sum(m.tokens for m in metas), 30, raw=" ".join(m.raw for m in metas))
        r = self._guard(r, energy, len(x) / SR, x)
        r.ms = (time.perf_counter() - t0) * 1000
        self.last = r
        return self._remember(key, r)

    def _remember(self, key, r):
        if key:
            with self._cache_lock:
                self._cache[key] = r
                while len(self._cache) > 64:
                    self._cache.popitem(last=False)
        return r

    def _decode_window(self, seg: np.ndarray, language, prompt, partial: bool = False, abort=None) -> Transcript:
        dur = len(seg) / SR
        ids, sot_index, detect = self._prefix(language, prompt)
        # token budget: generous for finals; tight for partials so a looping truncated window
        # is detected (and retried on 30 s) quickly
        rate, base = (7, 12) if partial else (12, 16)
        max_new = int(min(MAX_TOKENS - len(ids) - 2, rate * dur + base))
        buckets = PARTIAL_BUCKETS if partial else FINAL_BUCKETS
        sec = next((b for b in buckets if b >= dur + max(MIN_TAIL_S, dur)), 30)
        if not self.fast:
            sec = 30
        first = max(2, int(dur * 2.2))      # ~expected token count: avoid wasted steps after EOT
        toks, lps, nsp, lang, overflow, tm = self.fw.run(seg, sec, ids, sot_index, detect, max_new, first, abort)
        if tm.get("aborted"):
            return Transcript("", lang or language, filtered="superseded", timings=tm)
        text = self.tok.decode(toks, skip_special_tokens=True).strip()
        _, looped = collapse_repeats(text)
        if (overflow or looped or has_duplicate_phrase(text)) and sec != 30:
            # truncated context can loop: retry on the full 30 s window
            toks, lps, nsp, lang, overflow, tm2 = self.fw.run(seg, 30, ids, sot_index, detect, max_new, first, abort)
            if tm2.get("aborted"):
                return Transcript("", lang or language, filtered="superseded", timings=tm)
            text = self.tok.decode(toks, skip_special_tokens=True).strip()
            tm["retry_ms"] = tm2["total_ms"]
            sec = 30
        avg = float(np.mean(lps)) if lps else 0.0
        return Transcript(text, lang or language, nsp, avg, len(toks), sec, raw=text, timings=tm)

    def _check_coverage(self, m: Transcript, seg: np.ndarray, language, prompt) -> Transcript:
        """Whisper sometimes stops early on a long window (EOT after the first of several similar
        sentences) and silently drops speech. If a long window yields far fewer words than its
        voiced duration implies (< 1 word per voiced second), decode it again in two halves cut at
        a pause and keep that if it covers more."""
        dur = len(seg) / SR
        if dur < 8 or len(m.text.split()) >= dur:
            return m
        voiced = self.speech_ms(seg) / 1000
        if len(m.text.split()) >= voiced:
            return m
        cut = quietest_point(seg, len(seg) // 2 - 3 * SR, len(seg) // 2 + 3 * SR)
        a = self._decode_window(seg[:cut], language, prompt)
        b = self._decode_window(seg[cut:], language, (a.text[-400:] or prompt))
        text = _join_seam(a.text, b.text)
        if len(text.split()) > len(m.text.split()):
            m.text = m.raw = text
            m.tokens = a.tokens + b.tokens
            m.avg_logprob = (a.avg_logprob + b.avg_logprob) / 2
            m.timings["coverage_retry"] = 1
        return m

    @staticmethod
    def speech_ms(x: np.ndarray, threshold: float = 0.5) -> int:
        """Milliseconds of Silero-voiced audio in x (CPU, ~0.07 ms per 32 ms frame)."""
        from .vad import VAD, FRAME_MS
        p = VAD().feed(x)
        return int(sum(1 for q in p if q >= threshold) * FRAME_MS)

    _ALWAYS_BAD = {"thanks for watching", "thank you for watching", "please subscribe",
                   "subtitles by the amaraorg community", "like and subscribe", "amaraorg",
                   "untertitel im auftrag des zdf", "transcribed by", "thanks for watching and see you next time",
                   "see you in the next video", "sous-titres réalisés par la communauté d'amaraorg"}

    # silence hallucinations proper; other blacklisted short words ("Two.", "Okay.", "Bye.") are
    # also real one-word answers and only need 200 ms of voiced audio to survive a low logprob
    _CLASSIC = {"you", "you you", "thank you", "thank you very much", "thank you so much", "the", "and",
                "a", "i", "thanks for listening", "thank you for listening", "see you next time", "music",
                "applause", "silence", "laughter", "subscribe", "please subscribe", "thanks for watching"}

    def _guard(self, r: Transcript, energy: float, dur: float, x: np.ndarray | None = None) -> Transcript:
        """Suppress Whisper's classic hallucinations on silence / noise.

        (Note: large-v3-turbo's no_speech_prob is ~0 on everything, so the decisive signal is a
        Silero check that only runs when the text looks suspicious.)"""
        text, looped = collapse_repeats(r.text)
        n = _norm(text)
        reason = None
        if not n:
            reason = "empty"                                   # '...', '♪', '' etc.
        elif n in self._ALWAYS_BAD:
            reason = "hallucination_phrase"
        elif r.no_speech_prob > 0.6 and r.avg_logprob < -1.0:
            reason = "no_speech"
        else:
            suspicious = (n in HALLUCINATIONS or r.avg_logprob < -0.8 or looped
                          or len(n.split()) > 6 * dur + 6)
            if suspicious and x is not None:
                sp = self.speech_ms(x)
                r.timings["vad_speech_ms"] = sp
                if sp < 120:
                    reason = "no_voiced_audio"
                elif n in HALLUCINATIONS and r.avg_logprob < -0.6 and \
                        sp < (400 if n in self._CLASSIC else 200):
                    reason = "hallucination_phrase"
        if reason:
            r.filtered, r.text = reason, ""
        else:
            r.text = text
        return r


def _join_seam(a: str, b: str) -> str:
    """Concatenate two transcripts of adjacent audio, dropping a word (or up to 3) that both sides
    transcribed because the cut fell inside it."""
    aw, bw = a.split(), b.split()
    for n in (3, 2, 1):
        if len(aw) >= n and len(bw) >= n and [_norm(w) for w in aw[-n:]] == [_norm(w) for w in bw[:n]]:
            bw = bw[n:]
            break
    return " ".join(aw + bw).strip()


class StreamingTranscriber:
    """Partial transcripts while the user is talking.

    feed() audio as it arrives (16 kHz float32). `await partial()` re-transcribes the utterance
    so far when >= interval_ms of new audio arrived and returns the *delta*: newly stable text
    to append (words confirmed by two consecutive hypotheses: "local agreement"), or None.
    `await final()` returns the full final transcript (the text OpenAI puts in
    ...input_audio_transcription.completed). `self.hypothesis` is the latest unstable full text.

    Long monologues: once the utterance exceeds `max_partial_s`, the audio before a pause about
    `keep_s` before the end is transcribed once (final quality) and frozen; later partials only
    re-transcribe the audio after it (prompted with the frozen text), so partial latency stays
    flat and partials keep flowing past Whisper's 30 s window.
    """

    def __init__(self, stt: STT, language: str | None = None, interval_ms: int = 600,
                 prompt: str | None = None, max_partial_s: float = 12.0, keep_s: float = 5.0):
        self.stt = stt
        self.language = language
        self.prompt = prompt
        self.interval = int(interval_ms * SR / 1000)
        self.max_partial = int(max_partial_s * SR)
        self.keep = int(keep_s * SR)
        # scheduling kwargs only for STT objects that take them (test doubles may not)
        import inspect
        try:
            ps = inspect.signature(stt.transcribe_full).parameters
            self._sched = "stream" in ps or any(p.kind is p.VAR_KEYWORD for p in ps.values())
        except (TypeError, ValueError, AttributeError):
            self._sched = False
        self.reset()

    def _kw(self, **kw) -> dict:
        return kw if self._sched else {}

    def reset(self) -> None:
        self._chunks: list[np.ndarray] = []
        self._n = 0
        self._last_n = 0
        self._prev_words: list[str] = []
        self.committed = ""         # text already emitted as deltas
        self._committed_words = 0
        self.hypothesis = ""
        self._busy = False
        self._base = 0              # audio before this sample is frozen into _frozen
        self._frozen = ""

    @property
    def stream_key(self):
        """Pass as `stream=` to STT.transcribe() for this utterance's final transcript: queued
        partials of this stream are then dropped instead of delaying it."""
        return ("st", id(self))

    def _prompt_for_window(self) -> str | None:
        if not self._frozen:
            return self.prompt
        return ((self.prompt + " ") if self.prompt else "") + self._frozen[-400:]

    def feed(self, pcm16k_chunk: np.ndarray) -> None:
        x = np.asarray(pcm16k_chunk, dtype=np.float32).ravel()
        if len(x):
            self._chunks.append(x)
            self._n += len(x)

    @property
    def audio(self) -> np.ndarray:
        if len(self._chunks) > 1:
            self._chunks = [np.concatenate(self._chunks)]
        return self._chunks[0] if self._chunks else np.zeros(0, np.float32)

    @property
    def duration_ms(self) -> int:
        return self._n * 1000 // SR

    def due(self) -> bool:
        return not self._busy and self._n - self._last_n >= self.interval and self._n >= SR // 2

    async def partial(self) -> str | None:
        if not self.due():
            return None
        self._busy = True
        prev_n = self._last_n
        try:
            self._last_n = self._n
            x = self.audio
            if len(x) - self._base > self.max_partial:
                # freeze everything up to a pause ~keep_s before the end
                hi = len(x) - self.keep
                cut = quietest_point(x, max(self._base + SR, hi - 8 * SR), hi)
                fr = await self.stt.transcribe_full(x[self._base:cut], self.language,
                                                    self._prompt_for_window(), **self._kw(priority="partial"))
                if self.language is None and fr.language:
                    self.language = fr.language
                self._frozen = (self._frozen + " " + fr.text).strip()
                self._base = cut
            r = await self.stt.transcribe_full(x[self._base:], self.language, self._prompt_for_window(),
                                               partial=True, **self._kw(stream=self.stream_key))
            if getattr(r, "filtered", None) == "superseded":   # yielded the GPU to a final: retry later
                self._last_n = prev_n
                return None
            if self.language is None and r.language:
                self.language = r.language
            full = _join_seam(self._frozen, r.text)
            words = full.split()
            self.hypothesis = full
            if self._committed_words:
                self._reanchor(words)
            # local agreement: longest common prefix of the last two hypotheses
            k = 0
            for a, b in zip(self._prev_words, words):
                if _norm(a) != _norm(b) or not _norm(a):
                    break
                k += 1
            self._prev_words = words
            # never emit the last word of a hypothesis (it may still be growing)
            k = min(k, max(0, len(words) - 1))
            if k <= self._committed_words:
                return None
            new = words[self._committed_words:k]
            self._committed_words = k
            delta = (" " if self.committed else "") + " ".join(new)
            self.committed += delta
            return delta
        finally:
            self._busy = False

    def _reanchor(self, words: list[str]) -> None:
        """Re-transcriptions can re-split words ("slow-cooked" -> "slow cooked") or shift them at a
        freeze seam; keep `_committed_words` pointing just past the already emitted text so a
        word is never emitted twice or skipped."""
        def chars(ws):
            return re.sub(r"[\W_]+", "", " ".join(ws).lower())
        target = chars([self.committed])
        if chars(words[:self._committed_words]) == target:
            return
        acc = ""
        for j, w in enumerate(words):
            acc += chars([w])
            if acc == target:
                self._committed_words = j + 1
                return
            if not target.startswith(acc):
                break
        cw = [_norm(w) for w in self.committed.split()[-3:]]
        nw = [_norm(w) for w in words]
        cands = [j for j in range(max(len(cw), self._committed_words - 6),
                                  min(len(nw), self._committed_words + 6) + 1) if nw[j - len(cw):j] == cw]
        if cands:
            self._committed_words = min(cands, key=lambda j: abs(j - self._committed_words))

    async def final(self) -> str:
        x = self.audio
        if not len(x):
            return ""
        if self._sched:
            return await self.stt.transcribe(x, self.language, self.prompt, stream=self.stream_key)
        return await self.stt.transcribe(x, self.language, self.prompt)

    def remaining_delta(self, final_text: str) -> str:
        """Delta to send after final() so the concatenated deltas equal the final text when possible."""
        if final_text.startswith(self.committed):
            return final_text[len(self.committed):]
        return ""
