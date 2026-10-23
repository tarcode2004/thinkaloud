"""Server configuration (environment variables).

ORT_HOST / ORT_PORT            bind address (default 0.0.0.0:8787)
ORT_API_KEY                    optional; when set, minting tokens / opening sessions with a raw key
                               requires `Authorization: Bearer $ORT_API_KEY` (ek_ tokens always work)
OPENREALTIME_LLM               'openrouter' (default) | 'mock'
ORT_DEFAULT_MODEL              model echoed when the client names none (default gpt-realtime)
ORT_MODEL_ALIASES              optional 'gpt-realtime=deepseek/deepseek-v4-flash,foo=bar' or JSON;
                               any requested model maps to the configured LLM (alias → ORT_LLM_MODEL override)
ORT_TOKEN_TTL_S                ephemeral key lifetime (default 600, max 7200)
ORT_STUN                       optional comma list of STUN/TURN urls for WebRTC (default: host candidates only)
ORT_CORS_ORIGINS               '*' (default) or comma list
ORT_STATIC_DIR                 playground directory (default ort/static)
ORT_TRANSCRIPT_PACING          'audio' (default: captions follow playback) | 'eager' (OpenAI-like, as generated)
ORT_WS_AUDIO_LEAD_MS           WebSocket: how far ahead of real time audio is sent (default 600)
ORT_WEBRTC_PLAYOUT_DELAY_MS    estimated network+jitter-buffer delay subtracted from "played" (default 60)
ORT_SPECULATIVE                1 (default): start STT/LLM on a likely end of turn, discard if the user resumes
ORT_PARTIAL_TRANSCRIPTS        1 (default): live input transcription deltas while the user talks
ORT_LEGACY_ITEM_CREATED        0 (default): also emit beta `conversation.item.created`
ORT_DEVICE                     cuda (default) | cpu for STT/TTS
ORT_MAX_SESSIONS               concurrent session cap (default 16)
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path


def _bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    if v is None or v == "":
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


def _aliases(raw: str | None) -> dict[str, str]:
    if not raw:
        return {}
    raw = raw.strip()
    if raw.startswith("{"):
        try:
            return {str(k): str(v) for k, v in json.loads(raw).items()}
        except (ValueError, AttributeError):
            return {}
    out = {}
    for part in raw.split(","):
        if "=" in part:
            k, v = part.split("=", 1)
            out[k.strip()] = v.strip()
    return out


@dataclass
class Config:
    host: str = "0.0.0.0"
    port: int = 8787
    api_key: str | None = None
    llm: str = "openrouter"
    default_model: str = "gpt-realtime"
    model_aliases: dict[str, str] = field(default_factory=dict)
    token_ttl_s: int = 600
    stun: list[str] = field(default_factory=list)
    cors_origins: list[str] = field(default_factory=lambda: ["*"])
    static_dir: str = str(Path(__file__).parent / "static")
    transcript_pacing: str = "audio"
    ws_audio_lead_ms: int = 600
    webrtc_playout_delay_ms: int = 60
    speculative: bool = True
    partial_transcripts: bool = True
    legacy_item_created: bool = False
    device: str = "cuda"
    max_sessions: int = 16

    @classmethod
    def from_env(cls) -> "Config":
        e = os.environ.get
        return cls(
            host=e("ORT_HOST", "0.0.0.0"),
            port=_int("ORT_PORT", 8787),
            api_key=e("ORT_API_KEY") or None,
            llm=(e("OPENREALTIME_LLM") or "openrouter").lower(),
            default_model=e("ORT_DEFAULT_MODEL", "gpt-realtime"),
            model_aliases=_aliases(e("ORT_MODEL_ALIASES")),
            token_ttl_s=max(10, min(7200, _int("ORT_TOKEN_TTL_S", 600))),
            stun=[u.strip() for u in (e("ORT_STUN") or "").split(",") if u.strip()],
            cors_origins=[o.strip() for o in (e("ORT_CORS_ORIGINS") or "*").split(",") if o.strip()],
            static_dir=e("ORT_STATIC_DIR") or str(Path(__file__).parent / "static"),
            transcript_pacing=(e("ORT_TRANSCRIPT_PACING") or "audio").lower(),
            ws_audio_lead_ms=max(0, _int("ORT_WS_AUDIO_LEAD_MS", 600)),
            webrtc_playout_delay_ms=max(0, _int("ORT_WEBRTC_PLAYOUT_DELAY_MS", 60)),
            speculative=_bool("ORT_SPECULATIVE", True),
            partial_transcripts=_bool("ORT_PARTIAL_TRANSCRIPTS", True),
            legacy_item_created=_bool("ORT_LEGACY_ITEM_CREATED", False),
            device=e("ORT_DEVICE", "cuda"),
            max_sessions=max(1, _int("ORT_MAX_SESSIONS", 16)),
        )

    def resolve_model(self, requested: str | None) -> tuple[str, str | None]:
        """(model name echoed to the client, LLM model override or None). Any model string is accepted."""
        name = (requested or "").strip() or self.default_model
        return name, self.model_aliases.get(name)
