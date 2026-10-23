# OpenRealtime — a self-hosted, OpenAI-Realtime-compatible voice agent server

Goal: a drop-in replacement for the OpenAI Realtime API (`gpt-realtime-*`) built from open parts,
fast enough to feel native. Same wire protocol, so existing clients (ThinkAloud's
`web/src/participant/realtime.ts`, the OpenAI Agents SDK, etc.) work by changing a base URL.

```
mic ─WebRTC/WS─▶ resample 16k ─▶ Silero VAD ─▶ turn detector (silence + smart-turn v3) ─┐
                                   │                                                    │
                                   └▶ streaming Whisper large-v3-turbo (partials, final)│
                                                                                        ▼
speaker ◀─WebRTC/WS─ 48k/24k ◀─ Kokoro-82M (clause streaming) ◀─ DeepSeek V4 via OpenRouter
                                                                  (hedged, tool-call harness)
```

Hardware target: NVIDIA GB10 (DGX Spark, sm_121, aarch64). torch 2.14 cu130.
Measured: Kokoro ≈70 ms for 6 s of speech (warm); Whisper turbo ≈215 ms for 6 s (warm, fp16);
DeepSeek-V4-Flash TTFT ≈0.5 s (Parasail) .. 6 s (Relace) — provider choice matters most.

## Package layout (`openrealtime/` python package `ort`)

| module | owner | what |
|---|---|---|
| `ort/audio.py` | engine | PCM helpers: float32/int16, resample (soxr-like via scipy.signal.resample_poly), frames |
| `ort/vad.py` | engine | `VAD` Silero streaming (512-sample 16k frames) → speech prob |
| `ort/turn.py` | engine | `TurnDetector`: server_vad (threshold, prefix_padding_ms, silence_duration_ms) and semantic_vad (eagerness low/medium/high/auto; smart-turn v3 ONNX on the last ≤8 s) |
| `ort/stt.py` | engine | `STT`: Whisper turbo on GPU, `transcribe(pcm16k, language, prompt) -> str`, plus `StreamingTranscriber` for deltas |
| `ort/tts.py` | engine | `TTS`: Kokoro, `async stream(text_iter, voice, speed) -> AsyncIterator[np.float32 @24k]`; clause chunking; speech text normalisation |
| `ort/llm/` | llm | OpenRouter client, provider hedging, tool-call harness, mock LLM |
| `ort/session.py` | protocol | Realtime session state machine (items, responses, events), owns engine + llm |
| `ort/transport_ws.py` | protocol | `GET /v1/realtime?model=` WebSocket (base64 pcm16 24k audio, OpenAI WS events) |
| `ort/transport_webrtc.py` | protocol | `POST /v1/realtime/calls` SDP offer→answer (aiortc), `oai-events` data channel, audio tracks |
| `ort/server.py` | protocol | aiohttp app: `/v1/realtime/client_secrets`, `/calls`, WS, `/health`, playground static |

## Interfaces (the contract between owners)

```python
# ort/llm/__init__.py
@dataclass
class ToolCall: call_id: str; name: str; arguments: str  # JSON string, validated
@dataclass
class LLMEvent:  # yielded by LLM.stream
    type: Literal['text_delta','tool_call','done','error']
    text: str = ''; tool_call: ToolCall|None = None
    usage: dict|None = None; error: str|None = None; meta: dict|None = None  # provider, ttft_ms
class LLM(Protocol):
    def stream(self, messages: list[dict], tools: list[dict], tool_choice: str|dict = 'auto',
               temperature: float|None = None, max_tokens: int|None = None) -> AsyncIterator[LLMEvent]: ...
# messages are OpenAI chat-completions format (system/user/assistant(+tool_calls)/tool).
# tools are REALTIME format [{type:'function', name, description, parameters}] — the llm layer converts.
def make_llm(cfg) -> LLM  # 'openrouter' | 'mock' (OPENREALTIME_LLM=mock)

# ort/stt.py
class STT:
    def __init__(self, model='openai/whisper-large-v3-turbo', device='cuda'): ...
    def warmup(self): ...
    async def transcribe(self, pcm16k: np.ndarray, language: str|None=None, prompt: str|None=None) -> str
class StreamingTranscriber:  # partial transcripts while the user is talking
    def __init__(self, stt, language=None, interval_ms=600): ...
    def feed(self, pcm16k_chunk) -> None; async def partial(self) -> str|None; async def final(self) -> str; def reset(self)

# ort/turn.py
@dataclass
class TurnEvent: type: Literal['speech_started','speech_stopped']; audio_ms: int  # position in the input stream
class TurnDetector:
    def __init__(self, cfg: dict): ...  # realtime turn_detection object or None (manual)
    def update(self, cfg: dict|None): ...
    def feed(self, pcm16k_chunk: np.ndarray) -> list[TurnEvent]  # sync, cheap, call per 20-32 ms chunk
    # speech_stopped audio_ms = end of speech (before trailing silence), like OpenAI.

# ort/tts.py
class TTS:
    sample_rate = 24000
    def warmup(self): ...
    async def stream(self, text_chunks: AsyncIterator[str], voice: str, speed: float=1.0) -> AsyncIterator[np.ndarray]
    # consumes LLM deltas, emits audio as soon as the first clause is complete; voices: OpenAI names map to Kokoro
```

## Wire protocol (match OpenAI GA Realtime; event names used by ThinkAloud in bold)

Client→server: **session.update**, input_audio_buffer.append/commit/clear, **conversation.item.create**
(message user/system/assistant input_text, **function_call_output**), **conversation.item.delete**,
**conversation.item.truncate**, **response.create** (optional `response.instructions`, `tool_choice`,
`conversation:'none'`, `output_modalities`), **response.cancel**, **output_audio_buffer.clear**.

Server→client: session.created, session.updated, **input_audio_buffer.speech_started/speech_stopped**,
input_audio_buffer.committed, conversation.item.added/done (+ legacy conversation.item.created),
**conversation.item.input_audio_transcription.delta/completed**, **response.created**,
**response.output_item.added/done**, response.content_part.added/done,
**response.output_audio_transcript.delta/done**, response.output_audio.delta/done (WS only),
response.output_text.delta/done (text modality), response.function_call_arguments.delta/**done**,
**response.done** (status completed|cancelled|failed, output, usage), **output_audio_buffer.started/stopped/cleared** (WebRTC),
rate_limits.updated, **error**.

## Quality bars ("as good as possible")
- Voice-to-voice latency (end of user speech → first audio): target p50 < 900 ms with Parasail.
- No talking over the user: barge-in stops audio within 150 ms; assistant item truncated to what was heard.
- Transcript of assistant speech == what was actually spoken (truncate on interrupt).
- Tool calls: always schema-valid JSON; textual/DSML tool-call leaks recovered; never spoken aloud.
- No markdown / emoji / URLs read out loud; numbers spoken naturally.
- Zero-OpenAI: nothing here calls api.openai.com.
