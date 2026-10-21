# ThinkAloud

AI-moderated, voice-first usability and user studies for any web app.

1. **Upload a build.** Upload a `.zip` (Vite, CRA, Next.js (static export or a running `next start` server), Remix / React Router / Nuxt / Node servers, Angular, Expo / React Native for web, or a prebuilt static site), connect a git repo, or paste a URL. ThinkAloud builds the app in Docker and hosts it on its own isolated origin, with the recording probe injected automatically.
2. **Write a protocol.** Add tasks with hidden success criteria and automatic success rules, questions, interviews, and standard questionnaires (SUS, SEQ, UMUX-Lite, NASA-TLX, NPS). Write it yourself or have AI draft and refine it, then run the methodology check. The researcher stays in control: the AI moderator only ever sees the current step and reads tasks verbatim.
3. **A/B test.** Variants pair a protocol with an app build and have weights. Participants are assigned between-subjects, balanced by weight.
4. **Share links.** Each link can be auto-balanced or pinned to one variant, with a participant cap, an expiry, a redirect (e.g. Prolific completion) and URL-parameter capture. Each link also has a QR code.
5. **Participant session.** The participant gives consent with separate opt-ins, then does a mic check and optional webcam eye-tracking calibration (WebGazer). A gpt-realtime-2 voice moderator then runs the think-aloud session:
   - neutral, open-ended probes;
   - silence nudges;
   - questions about behaviour such as rage clicks, errors and backtracking, asked after the task;
   - the tested app shown in a wrapper.

   Everything is logged: rrweb replay, clicks, dead and rage clicks, navigation, errors and crashes, mouse, gaze, mixed audio, and transcripts.
6. **Analyse.** The results pages show:
   - task success with adjusted-Wald confidence intervals, time on task as a geometric mean, SEQ, SUS, NPS and lostness;
   - A/B tests (N−1 χ², Fisher, Welch on log times, Holm correction);
   - session replay synced with audio and transcript;
   - click, gaze and mouse heatmaps;
   - AI synthesis whose quotes are checked against the transcripts;
   - CSV and JSON export.

## Run it

```bash
npm install
npm run build          # web + probe
npm run seed           # optional demo account: demo@thinkaloud.dev / demo12345
npm start              # http://localhost:4000 (app host on :4001)
```

Development, with hot reload: `npm run dev`, then open http://localhost:5173.

**Share with anyone (HTTPS, required for the microphone):** `npm run share`. This opens two Cloudflare quick tunnels and prints public URLs. Links created in the Recruit tab will then use them.

**Deploy:** `docker compose up -d`. Set `PUBLIC_URL` and point `APP_HOST_URL` at a wildcard domain (e.g. `https://apps.example.com` → apps are served at `https://app-<id>.apps.example.com`). See `server/src/apphost/README.md`.

Configuration lives in `.env` (see `.env.example`): `OPENAI_API_KEY`, `OPENAI_REALTIME_MODEL=gpt-realtime-2`, `OPENAI_TEXT_MODEL`, `BUILD_MODE=docker|local`, `DATA_DIR`.

## Example: the Stacky Social study

`examples/stacky/protocol.json` turns the formative study plan in `stacky-social/client` (`BACKEND_INTEGRATION_AND_STUDY_PLAN.md`) into a runnable protocol: warm-up, 8 tasks, comprehension and trust questions, UMUX-Lite and a preference interview.

```bash
npm start                                    # with GIT_ALLOW_SSH=1 in .env for the private repo
npx tsx scripts/setup-stacky-study.ts        # build the app from git, create A/B variants, go live
STACKY_LINK=<printed link> npx playwright test tests/e2e/stacky.spec.ts   # optional voice dry-run
```

Stacky needs a running Next.js server (it has route handlers), so ThinkAloud runs it in a managed container behind the app host. The variants differ by **launch parameters**. Stacky reads `?flags=key:0|1`, so variant B defaults to `flags=replyContributions:0`. Change it in the Variants tab to whichever condition you want to compare. The plan's "AI disclosure on/off" condition has no flag in Stacky yet.

## Tests

```bash
npm test                                          # unit tests: schema, balancing, ingestion, stats, quote verification
npx playwright test tests/e2e/participant.spec.ts # real voice sessions with synthetic speech (uses the OpenAI API)
RESEARCHER_URL=http://localhost:4000 npx playwright test tests/e2e/researcher.spec.ts
```

## Layout

| Path | What |
|---|---|
| `shared/` | Contracts (`types.ts`), instruments with exact wording and scoring, moderator instructions and tools |
| `server/src/routes` | Auth, studies/protocols/variants/links, participant API, AI protocol tools |
| `server/src/builds`, `server/src/apphost` | Build pipeline (Docker) and isolated app hosting with probe injection |
| `server/src/analytics` | Statistics, metrics, replay/audio, heatmaps, synthesis, export |
| `probe/` | Script injected into tested apps (rrweb, interaction capture, postMessage bridge) |
| `web/src/researcher`, `web/src/participant`, `web/src/analytics` | Dashboard, participant runtime, results |
| `examples/demo-shop` | Demo app to upload (`examples/demo-shop.zip`) |
| `docs/` | API contract, research brief, design language, realtime notes |
