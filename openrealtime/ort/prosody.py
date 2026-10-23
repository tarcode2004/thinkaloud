"""English prosody fixes on top of misaki + Kokoro.

* Homographs: misaki picks "read" /rɛd/ for the VBP tag ("you read the task", present tense) and
  spaCy tags clause-initial imperatives after a comma as VBD ("First, read the task."). Both are
  retagged before the lexicon runs.
* Question intonation: Kokoro's own F0 falls at the end of almost every sentence, "?" included,
  so "You ready?" sounds like a statement. For yes/no and tag questions the predicted F0 of the
  final word is ramped up before decoding (model-native, no DSP on the audio). Wh-questions
  ("What would you do first?") keep the falling contour English uses for them.
"""
from __future__ import annotations

import re

_WH = {"what", "what's", "whats", "where", "where's", "when", "why", "who", "who's", "whom",
       "whose", "which", "how", "how's"}
# a wh-word after one of these still asks yes/no: "Do you know what it does?", "Can you tell me why?"
_AUX = {"do", "does", "did", "can", "could", "will", "would", "is", "are", "was", "were", "have",
        "has", "had", "should", "shall", "may", "might", "must", "am", "isn't", "aren't", "don't",
        "doesn't", "didn't", "can't", "won't", "wouldn't", "couldn't", "shouldn't"}
_LEAD = {"so", "and", "but", "okay", "ok", "alright", "then", "now", "well", "um", "uh"}
_PAST_HINT = re.compile(r"(?i)\b(yesterday|ago|last|earlier|already|before|previously)\b")


def question_rises(text: str) -> list[bool]:
    """One flag per '?' in text, in order: True when the question should end rising."""
    out = []
    for m in re.finditer(r"[^.!?\n]*\?", text):
        words = re.findall(r"[a-z']+", m.group(0).lower())
        while len(words) > 1 and words[0] in _LEAD:
            words = words[1:]
        if not words:
            out.append(True)
            continue
        if words[0] in _WH:
            # "What about the second one?" / "How about now?" are offers, they rise
            out.append(len(words) > 1 and words[1] == "about")
            continue
        # "Okay, so what did you notice?": a wh-word opening the last clause
        clause = re.split(r"[,;:]", m.group(0))[-1]
        cw = re.findall(r"[a-z']+", clause.lower())
        while len(cw) > 1 and cw[0] in _LEAD:
            cw = cw[1:]
        out.append(not (cw and cw[0] in _WH and cw[0] not in _AUX))
    return out


def fix_homograph_tags(tokens) -> None:
    """Retag 'read'/'reread' in misaki MTokens (in place) where spaCy's tag is wrong."""
    for i, t in enumerate(tokens):
        if t.text.lower() not in ("read", "reread"):
            continue
        if t.tag == "VBP":
            # present tense unless the sentence points to the past ("I read it yesterday")
            sent = " ".join(x.text for x in tokens)
            if not _PAST_HINT.search(sent):
                t.tag = "VB"
        elif t.tag == "VBD":
            j = i - 1
            while j >= 0 and tokens[j].tag in ("RB", "UH", "``", "''"):
                j -= 1
            # nothing (or only punctuation / "then" / "and" / "please") before it: imperative
            if j < 0 or tokens[j].tag in (",", ":", ".", "-LRB-", "HYPH", "CC") or \
                    tokens[j].text.lower() in ("please", "then", "now", "so"):
                t.tag = "VB"


def patch_g2p(g2p) -> None:
    """Wrap a misaki en.G2P instance so homograph tags are fixed before lexicon lookup."""
    if getattr(g2p, "_ort_patched", False) or not hasattr(g2p, "tokenize"):
        return
    orig = g2p.tokenize

    def tokenize(text, tokens, features):
        toks = orig(text, tokens, features)
        fix_homograph_tags(toks)
        return toks

    g2p.tokenize = tokenize
    g2p._ort_patched = True


class ProsodyModel:
    """Callable stand-in for KModel (as KPipeline.infer uses it) that shapes question F0."""

    def __init__(self, model, rises: list[bool], semitones: float = 5.0):
        self.model = model
        self.device = model.device
        self.rises = list(rises)
        self.semitones = semitones

    def _final_word_spans(self, ps: str) -> list[tuple[int, int]]:
        """(start, end) phoneme-char spans of the final word before each rising '?' in ps."""
        spans = []
        for m in re.finditer(r"\?", ps):
            rise = self.rises.pop(0) if self.rises else False
            if not rise:
                continue
            end = m.start()
            while end > 0 and not ps[end - 1].isalpha() and ps[end - 1] not in "ˈˌːᵊ":
                end -= 1
            start = ps.rfind(" ", 0, end) + 1
            if end > start:
                spans.append((start, end))
        return spans

    def __call__(self, ps: str, ref_s, speed: float = 1, return_output: bool = False):
        import torch
        m = self.model
        spans = self._final_word_spans(ps)
        if not spans:
            return m(ps, ref_s, speed, return_output=return_output)
        with torch.no_grad():
            return self._shaped(torch, m, ps, spans, ref_s, speed, return_output)

    def _shaped(self, torch, m, ps, spans, ref_s, speed, return_output):
        ids, pos = [], []                       # token id and the ps char index it came from
        for k, ch in enumerate(ps):
            v = m.vocab.get(ch)
            if v is not None:
                ids.append(v)
                pos.append(k)
        input_ids = torch.LongTensor([[0, *ids, 0]]).to(m.device)
        ref_s = ref_s.to(m.device)
        n = input_ids.shape[-1]
        input_lengths = torch.full((1,), n, device=m.device, dtype=torch.long)
        text_mask = torch.gt(torch.arange(n, device=m.device).unsqueeze(0) + 1, input_lengths.unsqueeze(1))
        bert_dur = m.bert(input_ids, attention_mask=(~text_mask).int())
        d_en = m.bert_encoder(bert_dur).transpose(-1, -2)
        s = ref_s[:, 128:]
        d = m.predictor.text_encoder(d_en, s, input_lengths, text_mask)
        x, _ = m.predictor.lstm(d)
        duration = torch.sigmoid(m.predictor.duration_proj(x)).sum(axis=-1) / speed
        pred_dur = torch.round(duration).clamp(min=1).long().squeeze()
        indices = torch.repeat_interleave(torch.arange(n, device=m.device), pred_dur)
        aln = torch.zeros((n, indices.shape[0]), device=m.device)
        aln[indices, torch.arange(indices.shape[0])] = 1
        aln = aln.unsqueeze(0)
        en = d.transpose(-1, -2) @ aln
        F0, N = m.predictor.F0Ntrain(en, s)
        # frame boundaries per input token, scaled to the F0 resolution
        bounds = torch.cat([torch.zeros(1, device=m.device, dtype=torch.long), pred_dur.cumsum(0)])
        scale = F0.shape[-1] / float(bounds[-1])
        top = 2 ** (self.semitones / 12)
        F0 = F0.clone()
        med = F0[F0 > 60].median() if bool((F0 > 60).any()) else F0.new_tensor(200.0)
        for a, b in spans:
            toks = [i + 1 for i, p in enumerate(pos) if a <= p < b]   # +1 for the leading pad
            if not toks:
                continue
            f0a, f0b = int(bounds[toks[0]] * scale), int(bounds[toks[-1] + 1] * scale)
            seg = F0[0, f0a:f0b]
            voiced = torch.nonzero(seg > 60).squeeze(-1)
            if voiced.numel() < 4:
                continue
            v0, v1 = int(voiced[0]), int(voiced[-1]) + 1
            start = seg[v0:v0 + 4].median()
            # end above the speaker's own median, not just above a word that already fell
            end = torch.maximum(start, med) * top
            # replace Kokoro's falling contour with a rise from where the word starts; the
            # unvoiced frames (consonants, the pause after '?') are left as predicted
            t = torch.linspace(0, 1, v1 - v0, device=m.device)
            target = start + (end - start) * t ** 1.4
            vs = seg[v0:v1]
            seg[v0:v1] = torch.where(vs > 60, target, vs)
        asr = m.text_encoder(input_ids, input_lengths, text_mask) @ aln
        audio = m.decoder(asr, F0, N, ref_s[:, :128]).squeeze().cpu()
        pred_dur = pred_dur.cpu()
        return m.Output(audio=audio, pred_dur=pred_dur) if return_output else audio
