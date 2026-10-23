# ThinkAloud

**AI-moderated, voice-first usability studies for any web app.**

Upload your app or point ThinkAloud at a repo, write a study protocol (or have AI draft one), and share a link. Each participant is guided through a think-aloud session by a realtime voice moderator that follows your protocol word for word, stays neutral, and asks open questions about what they actually did. You get a synced replay, audio, transcript, task metrics with proper statistics, heatmaps, and AI findings where every quote is checked against the transcript.

![ThinkAloud](docs/screenshots/01-landing.png)

The researcher keeps control. The AI moderator never improvises the study: it only sees the current step, reads tasks and questions verbatim, and can't move on until your protocol allows it. Hidden success criteria and automatic success rules decide outcomes, not the participant's say-so.

---

## How it works

| | |
|---|---|
| **1. Bring your app** | Upload a `.zip`, connect a git repo (public or private over SSH) or paste a URL. ThinkAloud detects the framework and builds it in Docker: Vite, CRA, Next.js (static export or a full `next start` server), Remix / React Router, Nuxt, SvelteKit, Angular, Expo / React Native for web, or plain static sites. Apps are hosted on their own isolated origin, with a recording probe injected automatically. No SDK needed. |
| **2. Write the protocol** | Steps can be tasks, questions, interviews or standard questionnaires (SUS, SEQ, UMUX-Lite, NASA-TLX, NPS, with exact published wording and scoring). Tasks have hidden success criteria and automatic success rules: URL match, element or text visible, click, or a custom event. You can generate a draft with AI, refine it, and run a methodology check that flags leading or double-barrelled questions and tasks that give away the answer. |
| **3. A/B test** | Variants pair a protocol with an app build and a weight. Participants are assigned between-subjects and kept balanced. **Launch parameters** (e.g. `?flags=newNav:1`) switch feature flags inside the same build. |
| **4. Share a link** | Links can auto-balance or pin a variant. They can cap participants, expire, redirect to Prolific or a panel, and capture URL parameters. Each has a QR code. `npm run share` gives you public HTTPS links in one command. |
| **5. Voice sessions** | Participants give consent with separate opt-ins, do a mic check, and can opt into webcam eye tracking. Then a gpt-realtime-2 moderator runs the session. It reads tasks verbatim and gives neutral think-aloud nudges, capped per task. It asks about rage clicks, dead clicks, errors and backtracking after the task, not during it. It handles crashes gracefully, and participants can type instead of talk at any point. |
| **6. Analyse** | Sessions come with a replay synced to audio and a clickable transcript, plus task success with adjusted-Wald CIs, time on task, SEQ, SUS, UMUX-Lite and NPS. A/B tests use the N−1 χ² test, Fisher's exact test and Welch's t-test on log times, with a Holm correction and plain-language verdicts. There are click, pointer and gaze heatmaps, first-click analysis, and AI findings with verified quotes. Everything exports as CSV or JSON. |

---

## Researcher workspace

### Protocol editor
Write each step the way a moderator would say it. Hidden success criteria and automatic success rules live alongside it. Checks run as you type, and the side panel previews the full moderator script.

![Protocol editor](docs/screenshots/03-protocol-task.png)

<table>
<tr>
<td width="50%"><b>Moderator script preview</b><br/>Exactly what the AI will say and do, step by step.<br/><br/><img src="docs/screenshots/04-moderator-script.png"/></td>
<td width="50%"><b>Generate with AI</b><br/>Describe your goal and get a complete, methodology-checked draft you can edit.<br/><br/><img src="docs/screenshots/05-ai-generate.png"/></td>
</tr>
</table>

### App builds
Drop in a zip or connect a repo. Apps that need a server, like the Next.js app here, run in a managed container. Static apps are served directly. Build logs end with a "What to change" section when something fails.

![App builds](docs/screenshots/06-app-builds.png)

<table>
<tr>
<td width="50%"><b>A/B variants</b><br/>Protocol × app × weight, plus launch parameters for flag-based conditions.<br/><br/><img src="docs/screenshots/07-variants.png"/></td>
<td width="50%"><b>Recruit</b><br/>Shareable links with QR codes, caps, expiry and panel redirects.<br/><br/><img src="docs/screenshots/08-recruit.png"/></td>
</tr>
</table>

---

## Participant experience

A calm screen with one voice. The tested app takes over the screen during tasks, with a small control bar. Recording is always visible, and **Stop & withdraw** deletes everything.

<table>
<tr>
<td width="50%"><b>Consent with separate opt-ins</b><br/><img src="docs/screenshots/20-participant-consent.png"/></td>
<td width="50%"><b>The AI moderator introduces itself</b><br/><img src="docs/screenshots/21-participant-intro.png"/></td>
</tr>
<tr>
<td width="50%"><b>Tasks run in the real app</b> (shown: the CrossWeave social reader as a hosted Next.js server, with a neutral think-aloud nudge)<br/><img src="docs/screenshots/22-participant-task.png"/></td>
<td width="50%"><b>Standard questionnaires</b>, answered by clicking or by voice<br/><img src="docs/screenshots/23-participant-questionnaire.png"/></td>
</tr>
<tr>
<td width="50%"><b>Optional eye tracking</b>, computed on device; no video is stored (synthetic test face shown)<br/><img src="docs/screenshots/24-participant-eyetracking.png"/></td>
<td width="50%"><b>Crash recovery</b>: freezes and white screens are detected, and the session continues<br/><img src="docs/screenshots/25-participant-crash.png"/></td>
</tr>
</table>

---

## Results

### Overview and A/B comparison
KPIs per variant, with confidence intervals, significance tests, effect sizes and underpowered warnings.

![Results](docs/screenshots/09-results.png)

<details><summary>Full results page</summary>

![Results full page](docs/screenshots/09-results-full.png)
</details>

### Session replay
A DOM replay synced to audio, transcript, gaze and a timeline of task, error and probe markers. Click any line of the transcript to jump to that moment.

![Session replay](docs/screenshots/10-session-replay.png)

<table>
<tr>
<td width="50%"><b>Heatmaps & first click</b><br/>Clicks, pointer and gaze over a real page snapshot.<br/><br/><img src="docs/screenshots/11-heatmaps.png"/></td>
<td width="50%"><b>AI insights</b><br/>Findings by severity. Each quote is checked against the transcript and links to the moment it was said.<br/><br/><img src="docs/screenshots/12-insights.png"/></td>
</tr>
</table>

---

## Built for research

- **Neutral moderation.** It doesn't lead, hint, praise or confirm correctness. Clarifying questions about the task get plain answers. Researcher probes come after the task, so time on task stays clean.
- **No hallucinated study.** A deterministic client-side runner owns the step order. The model gets only the current step, and every tool call is checked against it.
- **Honest outcomes.** Automatic rules win. AI judgements must cite observed app activity, and researchers can override any outcome.
- **Statistics per Sauro & Lewis.** Adjusted-Wald CIs for completion rates, geometric means of task times, the N−1 χ² test for proportions, and Welch's t-test on log times.
- **Ethics built in.** Separate opt-ins, an 18+ gate, disclosure that the moderator is an AI, masked inputs (no keystrokes from password, email or payment fields), and one-click withdrawal that deletes the data.
- **Security.** Uploaded apps run on a separate origin. There are ownership checks on every endpoint, a CSRF origin guard, an SSRF-guarded proxy, rate-limited auth, and build containers with resource limits.

---

## Quick start

```bash
git clone https://github.com/tarcode2004/thinkaloud && cd thinkaloud
cp .env.example .env   # add OPENAI_API_KEY
npm install
npm run build          # web + probe
npm run seed           # optional demo data: demo@thinkaloud.dev / demo12345
npm start              # http://localhost:4000 (app host on :4001)
```

- **Development:** `npm run dev` with hot reload, at http://localhost:5173.
- **Share with anyone over HTTPS** (required for the microphone): `npm run share` opens Cloudflare quick tunnels and prints public URLs.
- **Deploy:** [`docs/DEPLOY.md`](docs/DEPLOY.md) covers a static front end on Firebase Hosting with the API at home behind Cloudflare tunnels (systemd units, auto-synced tunnel URLs). Or `docker compose up -d`. Set `PUBLIC_URL`, and point `APP_HOST_URL` at a wildcard domain (`https://apps.example.com` → `https://app-<id>.apps.example.com`). See [`server/src/apphost/README.md`](server/src/apphost/README.md).

**Configuration** (`.env`): `OPENAI_API_KEY`, `OPENAI_REALTIME_MODEL` (default `gpt-realtime-2`), `OPENAI_TEXT_MODEL`, `BUILD_MODE=docker|local`, `DATA_DIR`, and `GIT_ALLOW_SSH=1` to build private repos with the server's SSH key.

Supported project types and their status are listed in [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md).

## Run without OpenAI: OpenRealtime

[`openrealtime/`](openrealtime/) is a self-hosted voice server that speaks the OpenAI Realtime protocol: ephemeral tokens, WebRTC and the same events. It uses local Whisper for speech recognition, Kokoro for speech and Silero plus smart-turn for turn-taking, all on your GPU. DeepSeek V4 provides the reasoning, via OpenRouter. ThinkAloud's moderator runs on it unchanged:

```bash
cd openrealtime && .venv/bin/python -m ort            # setup: openrealtime/README.md
# then in ThinkAloud's .env
REALTIME_BASE_URL=http://localhost:8787/v1
REALTIME_PUBLIC_URL=https://<public URL of :8787>/v1  # what participants' browsers reach
```

Measured on an NVIDIA GB10, voice-to-voice latency is about 0.8 s median. A full participant session (consent, intro, task, outcome, interview, closing) passes end to end over WebRTC. With these variables unset, ThinkAloud uses OpenAI as before.

## Example: the CrossWeave (Stacky Social) study

[`examples/stacky/protocol.json`](examples/stacky/protocol.json) turns a real formative study plan into a runnable protocol: warm-up, 8 tasks on related-post comprehension and AI-edit provenance, trust and speed ratings, UMUX-Lite, and a preference interview.

```bash
npx tsx scripts/setup-stacky-study.ts    # build from git, create A/B variants, go live, print the link
```

## Tests

```bash
npm test                                                    # unit + security tests
npx playwright test tests/e2e/participant-mock.spec.ts      # participant runtime against a local realtime mock
npx playwright test tests/e2e/openrealtime.spec.ts          # full voice session over WebRTC against OpenRealtime (no OpenAI)
npm run harness -- --scenario all                           # synthetic participants (novice, chatty, silent, German, …)
```

Tests never call OpenAI. Playwright blanks `OPENAI_API_KEY` unless `ALLOW_OPENAI_IN_TESTS=1`. The suites that drive real gpt-realtime sessions (`participant.spec.ts`, `participant-hardening.spec.ts`, `fullloop.spec.ts`) only run with that opt-in.

## Layout

| Path | What |
|---|---|
| `shared/` | Contracts, instruments (exact wording and scoring), moderator instructions and tools |
| `server/src/routes` | Auth, studies, protocols, variants, links, the participant API, AI protocol tools |
| `server/src/builds`, `server/src/apphost` | Build pipeline, server-app containers, isolated hosting with probe injection |
| `server/src/analytics` | Statistics, metrics, replay and audio, heatmaps, synthesis, export |
| `probe/` | Script injected into tested apps (rrweb, interaction capture, postMessage bridge) |
| `web/src/researcher`, `web/src/participant`, `web/src/analytics` | Dashboard, participant runtime, results |
| `examples/` | Demo shop app, the CrossWeave study protocol |
| `openrealtime/` | Self-hosted OpenAI-Realtime-compatible voice server (Python) |
| `docs/` | API contract, research brief, design language, compatibility, realtime notes |

## License

MIT, for both ThinkAloud and OpenRealtime. The models OpenRealtime downloads have their own licenses, listed in [`openrealtime/THIRD_PARTY.md`](openrealtime/THIRD_PARTY.md).
