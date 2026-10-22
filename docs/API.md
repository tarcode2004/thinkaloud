# ThinkAloud — architecture & API contract

All shapes referenced here are defined in `shared/src/types.ts` (import from `@thinkaloud/shared`).
Standard questionnaires (SUS, SEQ, UMUX-Lite, NASA-TLX, NPS) with exact wording + scoring live in `shared/src/instruments.ts`.
Research notes that drive product decisions: `docs/RESEARCH.md`.

## Processes & origins

| Process | Default | Purpose |
|---|---|---|
| API server (`server/`) | `PORT=4000` | REST API under `/api`, serves `web/dist` SPA in production, `/probe.js` |
| App host (`server/src/apphost`) | `APP_HOST_PORT=4001` | **Separate origin** serving uploaded app builds with the probe injected. Separate origin = uploaded code can never touch platform cookies. |
| Web SPA (`web/`) | Vite `5173` in dev (proxies `/api` → `PORT`) | Researcher dashboard + participant runtime (`/s/:token`) |
| Probe (`probe/`) | built to `probe/dist/probe.js` | IIFE injected into tested apps; talks to the wrapper via `postMessage` |

Env: see `.env` / `.env.example` (`OPENAI_API_KEY`, `OPENAI_REALTIME_MODEL=gpt-realtime-2`, `OPENAI_TEXT_MODEL`, `PUBLIC_URL`, `APP_HOST_URL`, `BUILD_MODE=docker|local`, `DATA_DIR`).
Storage: SQLite at `DATA_DIR/thinkaloud.db` (schema in `server/src/db.ts`), files under `DATA_DIR` (see `server/src/lib/paths.ts`).

Server helpers you must use: `server/src/lib/http.ts` (`HttpError`, `parse(zodSchema, body)`), `server/src/lib/auth.ts` (`requireUser`, `assertStudyAccess`, `assertChildAccess`, `assertParticipant`), `db`/`tx`/`json` from `server/src/db.ts`, `config` from `server/src/lib/config.ts`. IDs: `newId('prefix')` from shared. Express 5 (async handlers may throw).
Web helpers: `web/src/lib/api.ts` (`api.get/post/patch/put/del`, throws `ApiError`), `web/src/lib/hooks.ts` (`useAsync`, `useInterval`, `formatMs`, `timeAgo`), UI kit `web/src/ui/index.tsx` (+ `ui/toast.tsx` `useToast`). Icons: `lucide-react`. Styling: Tailwind v4, brand color `brand-*`.

Row → API object mapping: snake_case columns → camelCase fields; JSON TEXT columns parsed; INTEGER booleans → boolean.

## Auth (done) — `server/src/routes/auth.ts`
- `POST /api/auth/signup {email,password(min 8),name}` → `{user}` (sets `ta_auth` httpOnly cookie)
- `POST /api/auth/login {email,password}` → `{user}`
- `POST /api/auth/logout` → `{ok}`
- `GET /api/auth/me` → `{user}` | 401

## Studies / protocols / variants / links — `server/src/routes/studies.ts` (core)
All require auth + ownership.
- `GET /api/studies` → `{studies: (Study & {sessionCount, completedCount, variantCount, lastSessionAt})[]}`
- `POST /api/studies {name, description?, template?: 'starter'|'blank'}` → `{study}`. Creates: protocol "Protocol A" (`starterProtocol(name)` or `emptyProtocol`), variant "A" (protocol, no app), one auto-assign link "Main link".
- `GET /api/studies/:id` → `{study, protocols: ProtocolRecord[], apps: AppBuild[], variants: Variant[], links: (StudyLink & {url, sessionCount})[]}` — link `url` = `${PUBLIC_URL}/s/${token}`.
- `PATCH /api/studies/:id {name?, description?, status?}` → `{study}`. Setting `status:'live'` validates (≥1 active variant, every active variant's protocol has ≥1 step, every variant app is `ready` if set) else 400 with `details: string[]`.
- `DELETE /api/studies/:id`
- `POST /api/studies/:id/protocols {name, protocol?}` → `{protocol: ProtocolRecord}`
- `PUT /api/protocols/:pid {name?, protocol}` → `{protocol: ProtocolRecord}` (validated with zod `ProtocolSchema` in `server/src/lib/protocolSchema.ts`)
- `POST /api/protocols/:pid/duplicate` → `{protocol}` ; `DELETE /api/protocols/:pid` (400 if used by a variant)
- `POST /api/studies/:id/variants {name, protocolId, appId?, weight?}` → `{variant}` ; `PATCH /api/variants/:vid {name?, protocolId?, appId?, weight?, active?}` ; `DELETE /api/variants/:vid`
- `POST /api/studies/:id/links {name, variantId?, maxParticipants?, expiresAt?, redirectUrl?}` → `{link}` ; `PATCH /api/links/:lid {...same, active?}` ; `DELETE /api/links/:lid`
- `GET /api/studies/:id/preview-url?variantId=` → `{url}` = `${PUBLIC_URL}/s/<main link token>?preview=1&variant=<vid>`

## AI helpers — `server/src/routes/ai.ts` (core)
Auth required. OpenAI Responses API with JSON-schema structured output (`config.textModel`). Graceful 503 if no key.
- `POST /api/ai/generate-protocol {goal, productName, productContext?, audience?, durationMinutes?, taskCount?, includeSUS?, style?: ModerationStyle, appUrl?}` → `{protocol: Protocol}` (always valid against ProtocolSchema; neutral, non-leading task wording; never reveals the solution path)
- `POST /api/ai/refine-protocol {protocol, instruction}` → `{protocol, changes: string[]}`
- `POST /api/ai/review-protocol {protocol}` → `{issues: {stepId?, severity:'high'|'medium'|'low', message, suggestion}[]}` — methodology lint (leading questions, double-barreled, task reveals answer, missing success criteria…)

## Participant API — `server/src/routes/participant.ts` (core). Public.
Session calls authenticate with header `X-Session-Secret: <secret>` (or `?secret=` for `sendBeacon`).
- `GET /api/p/links/:token` → `PublicLinkInfo` (404 unknown token)
- `POST /api/p/links/:token/sessions StartSessionRequest` → `StartSessionResponse`. Assigns variant: link.variantId, else balanced by `count/weight` (non-preview, non-withdrawn sessions) across active variants. Applies `randomizeTasks` (shuffle task steps; each task keeps its position *slots*, non-task steps fixed). Snapshots protocol + steps into the session. `appUrl` = app.url (ready) or null. Status `consented`. Preview sessions (`preview:true`) allowed when study is draft only if caller owns the study.
- `POST /api/p/sessions/:sid/begin` → `{startedAt}` (status `in_progress`, idempotent)
- `POST /api/p/sessions/:sid/events {events: SessionEvent[]}` → `{ok, accepted}`. Idempotent on `(sessionId, seq)` (INSERT OR IGNORE). Side effects: `task.end` (data: `{outcome, source, startedAt, endedAt, durationMs, evidence?}`) upserts `task_results`; `answer` (data: `Answer` fields minus sessionId) upserts `answers`; `eyetracking.calibrated` (`{errorPx}`) sets `sessions.gaze_error_px`.
- `POST /api/p/sessions/:sid/rrweb?seq=N` body `{events: unknown[]}` → stored `DATA_DIR/sessions/<sid>/rrweb-<seq padded 6>.json`
- `POST /api/p/sessions/:sid/audio?seq=N&track=mixed|mic` raw body (`Content-Type: audio/webm`), up to 20MB → `audio-<track>-<seq padded 6>.webm`
- `POST /api/p/sessions/:sid/realtime-token` → `RealtimeTokenResponse`. Mints an OpenAI ephemeral key (`POST https://api.openai.com/v1/realtime/client_secrets`) with `session: {type:'realtime', model, audio:{input:{transcription:{model: transcribeModel, language}, noise_reduction:{type:'near_field'}, turn_detection:{type:'semantic_vad', eagerness:'low', create_response:false, interrupt_response:true}}, output:{voice: protocol.moderation.voice}}}` (the participant runner decides when a turn has ended and requests every response itself). Instructions + tools are sent by the client via `session.update` (see `shared/src/moderator.ts`).
- `POST /api/p/sessions/:sid/complete {status: 'completed'|'abandoned'}` → `{ok, redirectUrl}`
- `POST /api/p/sessions/:sid/withdraw` → deletes events/answers/results/files, status `withdrawn`.

Client → OpenAI realtime: WebRTC `POST https://api.openai.com/v1/realtime/calls` with SDP offer, `Authorization: Bearer <ephemeral value>`, data channel `oai-events` (see reference implementation notes in `docs/REALTIME.md`).

## Builds & app host — `server/src/builds/*`, `server/src/apphost/*` (builds agent)
- `POST /api/studies/:id/apps` — multipart (`file`: .zip of a project or of a built `dist/`, `name`, optional `subdir`, `env` (JSON object string), `buildCommand`, `outputDir`, `startCommand`, `mode`, `nodeVersion`) **or** JSON `{name, url, proxy?}` (external site; with `proxy:true` the URL must resolve to a public address unless `ALLOW_PRIVATE_PROXY=1`) **or** JSON `{name, gitUrl, branch?, subdir?, env?, buildCommand?, outputDir?, startCommand?, mode?, nodeVersion?}` → `{app: AppBuild}`; build runs async. `gitUrl` is https, or `git@host:owner/repo.git` / `ssh://…` when SSH clones are enabled (`GIT_ALLOW_SSH`, default on outside production; uses the server's SSH key).
- `GET /api/apps/:id` → `{app}` (uploads/git also carry `buildSettings`; server apps carry `runtime: {state, error?, container?}`) ; `GET /api/apps/:id/log` → text/plain (server apps: build log + `── Server: <state> ──` + the container's last 200 output lines) ; `POST /api/apps/:id/rebuild` ; `DELETE /api/apps/:id` (also removes a server app's container)
- `PATCH /api/apps/:id {name?, url?, proxy?, env?, buildCommand?, outputDir?, startCommand?, mode?, nodeVersion?}` — build settings are stored in `meta.json` and apply to the next build (call rebuild). `null` or `""` clears a setting; `env` replaces the whole map (`{}` / `null` clears). `mode`: `auto` | `static` | `server`. Env names must match `[A-Za-z_][A-Za-z0-9_]*` (max 100). Values are passed to Docker via the process environment and never written to the log.
- `GET /api/apps/:id/snippet` → `{html}` script tag for externally hosted apps: `<script src="${PUBLIC_URL}/probe.js" async></script>`
- App host (separate origin) serves ready builds at `app.url` with `probe.js` injected into every HTML response, SPA fallback (page loads only; `fetch()` of a missing path gets a JSON 404), correct MIME, no-cache for HTML. Server apps (`next-server`, `node-server`) are reverse-proxied to their container, with the probe injected only into HTML documents. See `server/src/apphost/README.md` and `docs/COMPATIBILITY.md`.

## Probe ↔ wrapper bridge
`ProbeToHost` / `HostToProbe` in shared types. Probe posts to `window.parent` (target `*`), host validates `event.source === iframe.contentWindow` and `data.source === 'thinkaloud-probe'`. Probe sends `hello` on load, `heartbeat` every 1s, batched `events` every ~500ms, batched `rrweb` every ~2s (only after `config.recordScreen`), answers `dom_query`. Apps may call `window.ThinkAloud.track(name, data)` → `app.custom`.

## Analytics — `server/src/analytics/*` (analytics agent)
- `GET /api/studies/:id/analytics?includePreview=0&level=0.9` → `StudyAnalytics`
- `GET /api/studies/:id/sessions` → `{sessions: (Session & {variantName, durationMs, tasksSucceeded, tasksTotal, sus?})[]}`
- `GET /api/sessions/:sid` → `{session, steps, protocol, events: SessionEvent[] (excluding mouse/gaze), taskResults: TaskResult[], answers: Answer[], notes, hasReplay, audioTracks: string[]}`
- `GET /api/sessions/:sid/replay` → rrweb events array (merged chunks) ; `GET /api/sessions/:sid/audio?track=mixed` → concatenated webm ; `GET /api/sessions/:sid/points?kind=mouse|gaze`
- `PUT /api/sessions/:sid/tasks/:stepId {outcome}` → researcher override (source `researcher`)
- `POST /api/sessions/:sid/notes {t, text, tags}` ; `DELETE /api/notes/:nid` ; `DELETE /api/sessions/:sid`
- `GET /api/studies/:id/heatmap?stepId&path&kind=click|gaze|mouse` → points + representative rrweb snapshot reference
- `POST /api/studies/:id/synthesis` → `Synthesis` (AI, evidence-cited, quotes verified against transcripts) ; `GET /api/studies/:id/synthesis` → latest | null
- `GET /api/studies/:id/export?format=csv|json&table=sessions|tasks|answers|events`

## Web routes
- `/` landing (logged-out) or redirect `/studies`; `/login`; `/signup`
- `/studies` list; `/studies/:studyId` workspace with tabs: overview, protocol(s) `/studies/:studyId/protocols/:protocolId`, app builds, variants (A/B), recruit (links), results `/studies/:studyId/results/*` (rendered by `web/src/analytics/ResultsRoutes.tsx`, which owns nested routes incl. `/studies/:studyId/results/sessions/:sessionId`)
- `/s/:token` participant runtime (`?preview=1&variant=…` for researcher preview). Any extra query params are captured as `urlParams` (Prolific `PROLIFIC_PID`, etc.).
