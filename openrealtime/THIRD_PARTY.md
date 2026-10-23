# Third-party models and libraries

OpenRealtime's own code is MIT-licensed. It downloads and runs these models, each under its own license:

| Component | Use | License |
|---|---|---|
| [openai/whisper-large-v3-turbo](https://huggingface.co/openai/whisper-large-v3-turbo) | speech recognition | MIT |
| [hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) | speech synthesis | Apache-2.0 |
| [pipecat-ai/smart-turn-v3](https://huggingface.co/pipecat-ai/smart-turn-v3) | end-of-turn detection | BSD-2-Clause |
| [snakers4/silero-vad](https://github.com/snakers4/silero-vad) | voice activity detection | MIT |
| [DeepSeek V4](https://huggingface.co/deepseek-ai) via [OpenRouter](https://openrouter.ai) | language model (remote API) | model: MIT; API use under OpenRouter and provider terms |
| espeak-ng (via misaki, for non-Kokoro languages) | phonemisation | GPL-3.0 (system library, not bundled) |

Python dependencies (aiortc, aiohttp, torch, transformers, kokoro, misaki, httpx, numpy, scipy, …) keep their own licenses; see `requirements.txt`.
