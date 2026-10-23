# OpenRealtime

A self-hosted voice agent server that speaks the **OpenAI Realtime API** wire protocol: the same ephemeral tokens, WebRTC SDP exchange, `oai-events` data channel and WebSocket events. Clients built for `gpt-realtime` can switch by changing one base URL, and the conversation never touches OpenAI.

The server runs this pipeline:

```
mic ─WebRTC/WS─▶ Silero VAD ─▶ turn detector ──────────────────────────┐
                    │          (silence, or semantic: smart-turn v3)    │
                    └▶ Whisper large-v3-turbo (CUDA graphs, partials)   │
                                                                        ▼
speaker ◀─WebRTC/WS─ Kokoro-82M (clause streaming) ◀─ DeepSeek V4 Flash via OpenRouter
                                                      (provider hedging, tool-call harness)
```

Speech recognition and synthesis run locally on the GPU. Only the text of the conversation leaves the machine, and it goes to OpenRouter.

## Measured on an NVIDIA GB10 (DGX Spark)

| Stage | p50 |
|---|---|
| **Voice to voice, end of speech → first audio, DeepSeek V4 Flash, semantic VAD** | **835 ms** (best 712 ms, p95 1.9 s) |
| Voice to voice with an LLM that answers in 250 ms (protocol and engine overhead) | 600 ms |
| Whisper turbo final transcript, 1 s / 6 s / 10 s of audio | 98 / 142 / 171 ms |
| Kokoro time to first audio | 25–50 ms |
| smart-turn v3 end-of-turn inference | 13 ms |
| Silero VAD per 32 ms frame | 0.06 ms |
| Barge-in: speech onset → audio stopped (WS client flush / WebRTC received audio) | 81 ms / 250 ms |
| Barge-in: truncated assistant text vs what was actually heard (Whisper on the played audio) | ±1 word: WS 10/10, WebRTC 9/10 |
| Voice to voice with 1 / 2 / 4 / 8 concurrent sessions (mock LLM, 250 ms TTFT), p50 | 679 / 750 / 1117 / 1082 ms |

The biggest remaining cost is the LLM's time to first token. That depends far more on the OpenRouter provider than on the model: today Parasail answered in about 0.45 s and the default route in 6 s. The provider scoreboard and hedging below are there to absorb that variance.

## What makes it good

**Turn-taking**
- *Semantic end of turn.* After a short pause, smart-turn v3 decides whether the sentence is finished. A complete sentence ends the turn in about 380 ms. "I want to, um" keeps the floor for seconds instead of getting interrupted.
- *Speculative start.* At the first likely pause the server starts transcribing and calls the LLM. If the user keeps talking, both are thrown away. This saves about 250 ms per turn.
- *Barge-in that matches what was heard.* The outgoing audio clock is tracked precisely. When the user interrupts, the queue is flushed, and the assistant's item is truncated to the words actually played.

**Speech recognition**
- *Hallucination guard.* An energy gate, a blacklist of known Whisper filler phrases and a VAD cross-check stop silence and noise from turning into "Thank you." The same words still get through when someone actually says them.

**Speech output**
- *Captions follow the voice.* Transcript deltas are paced to audio playback, not to generation. You can switch back to OpenAI's eager behaviour with `ORT_TRANSCRIPT_PACING=eager`.
- *Speech normalisation.* Markdown, emoji and URLs are never read aloud, and numbers, currency, times and ordinals are spoken as words.

**DeepSeek over OpenRouter**
- *Provider hedging.* A live scoreboard tracks time to first token per provider, with cooldowns after 429 and 5xx errors. If the best provider hasn't sent a token by its own p90, a second request goes out, and the slower stream is cancelled.
- *Tool-calling harness.*
  - Every tool call is checked against its schema.
  - Broken arguments are repaired first; if that fails, the model is re-asked once, and as a last resort valid arguments are built from the schema.
  - Tool calls the model writes as plain text (DeepSeek DSML tokens, `<tool_call>`, JSON blocks, `fn(...)`) are recovered and kept out of the spoken stream.
  - `tool_choice` `auto`, `none`, `required` and named tools are all supported. Preambles before a tool call can optionally be suppressed.

## Run it

```bash
cd openrealtime
python3 -m venv .venv
.venv/bin/pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu130   # match your GPU
.venv/bin/pip install -r requirements.txt
hf download pipecat-ai/smart-turn-v3 --local-dir models/smart-turn-v3
export OPENROUTER_API_KEY=...            # or keep it in ~/.hermes/.env
.venv/bin/python -m ort                  # http://localhost:8787 (the playground is at /)
```

Whisper and Kokoro download from Hugging Face on first start. Warmup takes about 15 s while the Whisper CUDA graphs are captured. To run without any LLM key, use `OPENREALTIME_LLM=mock`.

**Use it from an OpenAI Realtime client.** Point the base URL at `http://localhost:8787/v1`. The server provides:
- `POST /v1/realtime/client_secrets`
- `POST /v1/realtime/calls` (WebRTC)
- `GET /v1/realtime` (WebSocket)

**Use it from ThinkAloud.** Set these in the repo's `.env`:

```bash
REALTIME_BASE_URL=http://localhost:8787/v1
REALTIME_PUBLIC_URL=https://<tunnel-to-8787>/v1   # what participants' browsers can reach
```

The settings are listed at the top of [`ort/config.py`](ort/config.py). The ones you'll most likely change:
- `ORT_LLM_MODEL`
- `ORT_LLM_PROVIDERS`
- `ORT_HEDGE`
- `ORT_SPECULATIVE`
- `ORT_TRANSCRIPT_PACING`
- `ORT_API_KEY`
- `ORT_STUN`

## Tests and benchmarks

```bash
.venv/bin/python -m pytest tests -q          # 257 offline tests (engine, LLM harness, protocol, WebRTC loopback)
.venv/bin/python bench/engine_bench.py       # VAD / smart-turn / STT / TTS latencies
.venv/bin/python bench/v2v_bench.py --vad semantic_vad            # voice to voice, mock LLM
.venv/bin/python bench/v2v_bench.py --vad semantic_vad --llm openrouter --runs 10   # real DeepSeek (costs a few cents)
ORT_LIVE_LLM=1 .venv/bin/python bench/llm_bench.py                # per-provider TTFT and tool-call precision
.venv/bin/python bench/load_bench.py --n 1,2,4,8                  # concurrent sessions: v2v p50/p95 per N
.venv/bin/python bench/v2v_bench.py --bargein ws,webrtc --runs 10 # barge-in latency and truncation accuracy
```

The tests never call OpenAI or OpenRouter. Live LLM checks only run when you opt in.

## Differences from OpenAI Realtime

- **Speech goes through text.** The model hears your words but not your tone, and it can't laugh or change its voice the way a native speech-to-speech model can.
- **Languages.** Kokoro voices cover English, Spanish, French, Hindi, Italian and Portuguese. Other languages, German for example, use espeak pronunciation with a Spanish voice, which is intelligible but accented. Japanese and Chinese need `misaki[ja]` and `misaki[zh]`.
- **Not implemented:**
  - image input
  - `noise_reduction` (accepted and ignored)
  - the WebRTC sideband `/accept` and `/reject` endpoints
  - per-model LLM routing (every model name maps to the configured LLM)
- **Context window.** `truncation` (`auto` | `disabled` | `retention_ratio` with `token_limits.post_instructions`) trims the oldest items from the LLM request only; the realtime conversation keeps every item. The window is `ORT_CONTEXT_TOKENS` (default 32768).
- **Event timing.** `response.done` arrives when playback ends, not when generation ends, because captions are paced to the audio.
