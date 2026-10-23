# Deploying ThinkAloud: Firebase Hosting front end, API at home behind Cloudflare

This is the production setup on the GB10 box: the public site is static on Firebase Hosting, and
everything stateful (API, app host, Docker builds, SQLite, recordings) runs on this machine and is
reached through Cloudflare tunnels. Self-hosting on one origin (`npm start`, `docker compose`) still
works exactly as before. Nothing here is required for that.

## Architecture

```
 Participant / researcher browser
   │
   │ 1. https://thinkaloud-app.web.app/…           (SPA, static; participant links live here)
   ▼
 ┌─────────────────────────────────────┐
 │ Firebase Hosting  site thinkaloud-app│  index.html, /assets/* (immutable), /probe.js
 │                                      │  /config.json  (no-store) ── { apiBase, appHostUrl }
 └─────────────────────────────────────┘
   │
   │ 2. API calls: fetch(apiBase + "/api/…")        researcher: Authorization: Bearer <token>
   │    (CORS, no cookies)                          participant: X-Session-Secret
   ▼
 https://<random>.trycloudflare.com ─┐   Cloudflare quick tunnel  (thinkaloud-tunnel-api.service)
                                     ▼
 ┌──────────────────────── this machine (GB10, systemd --user) ─────────────────────────┐
 │  thinkaloud.service   node/tsx server/src/index.ts                                     │
 │    :4000  API + SPA (same-origin fallback)      :4001  app host (hosted test apps)     │
 │    DATA_DIR=./data  (SQLite, sessions, builds)  Docker: builds + ta-app-* containers   │
 │                                                                                        │
 │  thinkaloud-sync.service   scripts/deploy/tunnel-sync.mjs                              │
 │    reads tunnel hostnames from cloudflared metrics (127.0.0.1:20251 / :20252)          │
 │    → data/deploy/runtime.env (PUBLIC_URL, APP_HOST_URL, CORS_ORIGINS)                  │
 │    → restarts thinkaloud.service only if APP_HOST_URL changed                          │
 │    → publishes /config.json to Firebase (REST API, config-only release, ~3 s)          │
 └────────────────────────────────────────────────────────────────────────────────────────┘
                                     ▲
 https://<random>.trycloudflare.com ─┘   Cloudflare quick tunnel  (thinkaloud-tunnel-apps.service)
   ▲
   │ 3. <iframe src="https://<apps-tunnel>/a/app_xxx/">  the app under test (path routing)
 Participant browser
```

- **Participant links always use `https://thinkaloud-app.web.app/s/<token>`** (`PUBLIC_URL`). They never
  contain a tunnel URL, so a tunnel restart doesn't break links already handed out.
- The front end loads `/config.json` before rendering. With no config (self-hosted, or `npm run dev`)
  the API is same-origin and cookie auth is used, as before.
- HizmetSearch's named tunnel (root's `cloudflared tunnel run`, `api.hizmetsearch.com`) is separate and
  untouched. Hermes and grader are unaffected.

## What is where

| Thing | Location |
|---|---|
| Firebase project / site | `testrepoapp-d6122` / `thinkaloud-app` → https://thinkaloud-app.web.app (see "Project" below) |
| Hosting config | `firebase.json` (headers, SPA rewrite), `.firebaserc` |
| Web deploy | `scripts/deploy-web.sh` → `scripts/deploy/firebase-hosting.mjs` (REST, gcloud token) |
| Tunnel → config sync | `scripts/deploy/tunnel-sync.mjs` |
| Unit templates | `deploy/systemd/*.service`, installed by `scripts/deploy/install-units.sh` into `~/.config/systemd/user/` |
| Server env from the sync | `data/deploy/runtime.env` (generated; overrides `.env`) |
| Published runtime config | `data/deploy/config.json` (generated), sync state in `data/deploy/sync-state.json` |
| Optional sync overrides | `data/deploy/deploy.env` (`WEB_URL`, `API_URL`, `APPS_URL`, `EXTRA_CORS_ORIGINS`, …) |
| Secrets | `.env` only (`OPENAI_API_KEY`, `SESSION_SECRET`, Stripe). Never committed |

Units (all `systemctl --user`, `Restart=always`, logs in the journal):

| Unit | What | Enabled |
|---|---|---|
| `thinkaloud.service` | production server, `NODE_ENV=production`, `DATA_DIR=./data`, env from `.env` + `runtime.env` | yes |
| `thinkaloud-tunnel-api.service` | `cloudflared tunnel --url http://127.0.0.1:4000 --metrics 127.0.0.1:20251` | yes |
| `thinkaloud-tunnel-apps.service` | `cloudflared tunnel --url http://127.0.0.1:4001 --metrics 127.0.0.1:20252` | yes |
| `thinkaloud-sync.service` | `tunnel-sync.mjs` daemon (every 5 s) | yes |
| `openrealtime.service` | `openrealtime/.venv/bin/python -m ort` on :8787 (self-hosted voice) | no (installed, disabled) |

Linger is on for `tarmus`, so the units start at boot without a login.

## Cross-origin details

- **Auth.** `POST /api/auth/login`, `/signup` and `/google` return `{ token, user }`. The web client stores the token
  (`localStorage.ta_auth_token`) and sends `Authorization: Bearer <token>` only when the API is
  cross-origin. The server accepts the bearer header or the `ta_auth` cookie (bearer wins), and logout
  revokes whichever was used. Cookies would be third-party here (web.app → trycloudflare.com), which
  Safari blocks, so they are not relied on.
- **CORS** (`corsMiddleware`, `server/src/lib/guards.ts`). Only origins in `PUBLIC_URL` + `CORS_ORIGINS`
  get `Access-Control-Allow-Origin`, never with `Allow-Credentials`. Allowed headers: `Authorization`,
  `Content-Type`, `X-Session-Secret`, `Range`. Same-origin requests are untouched.
- **CSRF guard.** It allows the configured front-end origins. Bearer requests skip it: a browser only
  sends that header from script, and cross-origin script needs a preflight that only configured
  origins pass. Cookie requests from any other origin are still refused.
- **Participant API.** It uses `X-Session-Secret` as before. Pagehide beacons are sent as `text/plain`
  cross-origin (no preflight is possible for `sendBeacon`); `/api/p` parses `text/plain` bodies as JSON.
- **Media.** Audio chunks are uploaded with `fetch` (CORS). Researcher audio playback and CSV/JSON
  exports are fetched with the bearer token into blob URLs when cross-origin. Same-origin they stay
  plain links (streaming/range).
- **Hosted apps.** These load in an iframe from the apps tunnel (`APP_HOST_ROUTING=path`: quick tunnels
  have no wildcard DNS). After a restart the server rewrites every app's stored URL to the new
  `APP_HOST_URL` (`pipeline.ts` startup sync).
- **No SSE.** Nothing in ThinkAloud uses server-sent events (quick tunnels can't carry them). WebSocket
  upgrades for server-type test apps go through the app host and work through cloudflared.

## Limits through Cloudflare quick tunnels

- **Request bodies are capped at 100 MB by Cloudflare.** Zip uploads larger than that fail through the
  tunnel even though the server allows `MAX_UPLOAD_MB=1024`. For bigger apps, use a git URL (cloned
  server-side), or upload from the LAN at `http://<box>:4000`. Recording uploads are small chunks and
  well under the cap.
- Quick tunnels have no uptime guarantee and allow about 200 concurrent requests. Their URLs change on every
  restart of the tunnel unit or the machine. The sync makes that invisible to new page loads. A
  participant mid-session when a tunnel restarts loses the hosted app iframe (the old apps URL dies)
  and should reload the page. API calls retry once against the new `config.json` automatically.
- For an always-on study, use the named tunnel below.

## Operations

```bash
# Status and logs
systemctl --user status thinkaloud thinkaloud-tunnel-api thinkaloud-tunnel-apps thinkaloud-sync
journalctl --user -u thinkaloud -f            # server
journalctl --user -u thinkaloud-sync -f       # URL changes, restarts, config publishes
curl -s https://thinkaloud-app.web.app/config.json     # what the front end uses now
curl -s 127.0.0.1:20251/quicktunnel; curl -s 127.0.0.1:20252/quicktunnel
node scripts/deploy/firebase-hosting.mjs status

# Ship a new front end (build + full deploy; only changed files are uploaded)
bash scripts/deploy-web.sh
# Ship server changes
systemctl --user restart thinkaloud
# Re-publish config.json by hand (normally the sync does this)
bash scripts/deploy-web.sh --config
# Force new tunnel URLs (simulates a reboot); the sync catches up in ~15 s
systemctl --user restart thinkaloud-tunnel-api thinkaloud-tunnel-apps
# Self-hosted voice instead of OpenAI (see openrealtime/README.md)
systemctl --user enable --now openrealtime
```

The server also still serves the SPA itself, so `https://<api-tunnel>/` works as a same-origin fallback,
and so do links from older `npm run share` tunnels as long as those cloudflared processes are alive.

## Setup from scratch

1. `npm install && npm run build`, `.env` with `OPENAI_API_KEY` and a real `SESSION_SECRET`.
2. Firebase: no `firebase login` needed. The deployer uses `gcloud auth print-access-token` (or
   `$FIREBASE_ACCESS_TOKEN`) with the Firebase Hosting REST API and `x-goog-user-project`. To create a
   site in a project you own:
   ```bash
   T=$(gcloud auth print-access-token); P=<project-id>
   curl -X POST -H "Authorization: Bearer $T" -H "x-goog-user-project: $P" -H 'Content-Type: application/json' \
        -d '{}' "https://firebasehosting.googleapis.com/v1beta1/projects/$P/sites?siteId=<site-id>"
   ```
   Then put the site in `firebase.json` (`hosting.site`) and the project in `.firebaserc`. Spark (free)
   plan is enough. The firebase CLI also works with this `firebase.json` once logged in
   (`firebase login --no-localhost`), but it does not inject `/config.json` and `/probe.js`, so prefer
   `scripts/deploy-web.sh`.
3. `bash scripts/deploy/install-units.sh --enable`, then
   `systemctl --user start thinkaloud-tunnel-api thinkaloud-tunnel-apps thinkaloud thinkaloud-sync`.
4. `bash scripts/deploy-web.sh`. Within ~15 s `config.json` points at the tunnels.
5. `loginctl show-user $USER -p Linger` must say `yes` (`sudo loginctl enable-linger $USER`).

**Cutover from a manually started server** (as done on 2026-10-23). Start the tunnel units, then run
`SERVER_URL=http://127.0.0.1:9 node scripts/deploy/tunnel-sync.mjs --once` to write `runtime.env` without
touching anything. Then `kill <pid from ss -ltnp | grep :4000>` and immediately
`systemctl --user start thinkaloud`, then start the sync (about 2 s of API downtime). Old manual quick
tunnels keep pointing at :4000/:4001, so their links keep working until they die. Don't kill
them.

## Google sign-in

"Sign in with Google" is optional. Without `GOOGLE_CLIENT_ID` the sign-in and sign-up pages show only
the email form and `POST /api/auth/google` answers 404.

**How it works.** The pages load Google Identity Services (`https://accounts.google.com/gsi/client`)
only when `GET /api/auth/providers` returns a client ID. Google's own button is rendered above the email
form (popup mode, no redirect URI). It gives the page an ID token (JWT), which is posted to
`POST /api/auth/google`. The server verifies it with `google-auth-library` (`OAuth2Client.verifyIdToken`):
signature, `aud` = `GOOGLE_CLIENT_ID`, `iss` = accounts.google.com, and expiry. It also requires
`email_verified: true`. Then:

- If an account is already linked to that Google ID (`users.google_sub`), that account signs in.
- If an account has the same email, it is linked and signed in, and sessions opened before the link are
  ended. An account already linked to a different Google ID is never re-linked (409).
- Otherwise a new account is created from the Google profile, with no usable password.

The `?plan=` sign-up flow continues to Stripe Checkout exactly as it does for email sign-up. The route
shares the login/signup rate limit and sits behind the CSRF origin guard. There is no account settings page
yet, so a Google-only account cannot set a password. One Tap is off by default; `GOOGLE_ONE_TAP=1`
shows it on the sign-in page.

**Creating the OAuth client.** This can't be done from the CLI. Google offers no public API or gcloud
command for OAuth clients of type "Web application" or for their JavaScript origins. `gcloud iap
oauth-brands` / `oauth-clients` only create *Internal* brands, which need a Google Workspace organization
(`testrepoapp-d6122` has none), and IAP-only clients. `gcloud iam oauth-clients` is for Workforce Identity
Federation. Firebase Auth is not initialized in this project (Identity Toolkit config returns
`CONFIGURATION_NOT_FOUND`), so there is no auto-created web client to reuse either. Sign in to the Google Cloud console as the
project owner (`tarmus1291@gmail.com`) and follow these steps:

1. Open https://console.cloud.google.com/auth/overview?project=testrepoapp-d6122
   (left menu: **APIs & Services → OAuth consent screen**, which now opens the *Google Auth Platform*).
2. If it says *Google Auth Platform not configured yet*, click **Get started**:
   - **App information.** App name `ThinkAloud`, user support email = your address → **Next**.
   - **Audience.** **External** → **Next**.
   - **Contact information.** Your email address → **Next**.
   - **Finish.** Tick the user data policy box → **Continue** → **Create**.
3. **Audience** (left menu). The app starts in **Testing**, where only listed test users can sign in. Under
   **Test users**, click **+ Add users**, add each Google address that should be able to sign in → **Save**.
   To open sign-in to everyone, click **Publish app** → **Confirm**. ThinkAloud asks only for `openid email profile`,
   which are non-sensitive scopes, so there is no Google review.
4. **Clients** (left menu) → **+ Create client** (older UI: **APIs & Services → Credentials → + Create
   credentials → OAuth client ID**):
   - **Application type.** **Web application**. Name `ThinkAloud web`.
   - **Authorized JavaScript origins.** Click **+ Add URI** once for each:
     `https://thinkaloud-app.web.app`, `https://thinkaloud-app.firebaseapp.com`, `http://localhost:5173`,
     `http://localhost` (Google requires the port-less one too for local testing). Add any other origin the SPA is
     served from: a custom domain, or for single-origin self-hosting the `PUBLIC_URL` origin, e.g.
     `http://localhost:4000`.
   - **Authorized redirect URIs.** Leave empty (popup mode).
   - Click **Create**, then copy the **Client ID** (`…apps.googleusercontent.com`). The client secret is not used.
     Don't store it anywhere.
5. Origin changes can take a few minutes (up to hours) to take effect.

**Turning it on.** Put the ID in `.env` (it is public, but `.env` is where the server reads config):

```bash
echo 'GOOGLE_CLIENT_ID=<client id>' >> .env
systemctl --user restart thinkaloud       # server picks it up
bash scripts/deploy-web.sh                # ship the front end with the button
curl -s "$(curl -s https://thinkaloud-app.web.app/config.json | jq -r .apiBase)/api/auth/providers"
```

Nothing has to change in Firebase Hosting or `config.json`. The front end asks the API for the client ID at
runtime. The page must not be served with `Referrer-Policy: no-referrer` (GIS needs the origin) or
`Cross-Origin-Opener-Policy: same-origin` (it would break the popup). `firebase.json` sets neither.

## Project

The Google account had reached its Cloud project quota (27 projects), so `gcloud projects create`
failed with *"exceeded your allotted project quota"*. The site `thinkaloud-app` was therefore created as
an extra Hosting site in the existing sandbox project `testrepoapp-d6122` (Spark). That gives the same
free `thinkaloud-app.web.app` domain. To move to a dedicated project later: free a slot (delete an
unused project, or request more quota), create the project, add Firebase
(`POST https://firebase.googleapis.com/v1beta1/projects/<id>:addFirebase`), create a site, update
`firebase.json`/`.firebaserc`, run `bash scripts/deploy-web.sh`, and set `WEB_URL` in
`data/deploy/deploy.env` if the site name changes. Site names are global: deleting `thinkaloud-app`
from the sandbox project first lets the new project reuse it.

## Troubleshooting

| Symptom | Check / fix |
|---|---|
| Site loads but says it cannot reach the server, or login spins | `curl https://thinkaloud-app.web.app/config.json`, then `curl <apiBase>/api/health`. If stale, `journalctl --user -u thinkaloud-sync`. A publish failure retries every 5 s. Check the token with `gcloud auth print-access-token` |
| `config.json` publish fails with 401/403 | gcloud credentials expired: `gcloud auth login` (interactive), then `systemctl --user restart thinkaloud-sync` |
| Sync logs "waiting for tunnels" | `systemctl --user status thinkaloud-tunnel-api`. Cloudflare may rate-limit quick tunnel creation, and the unit retries every 5 s |
| Server restarts in a loop | `journalctl --user -u thinkaloud`. `EADDRINUSE` means another process holds :4000/:4001 (`ss -ltnp \| grep -E ':400[01]'`) |
| Hosted app shows "Preparing…" or 404 in the iframe | The app URL is rewritten at server start. Make sure the server restarted after the last apps-tunnel change (`curl 127.0.0.1:4000/api/health` → `appHostUrl`) |
| 403 "Cross-origin request refused" | The front-end origin is missing from `CORS_ORIGINS` (`data/deploy/runtime.env`). For a custom domain, add `EXTRA_CORS_ORIGINS` in `data/deploy/deploy.env` and restart the sync and server |
| Upload of a large zip fails | Cloudflare's 100 MB body cap; see Limits |
| Google button missing | `curl <apiBase>/api/auth/providers` must show a `clientId`. Set `GOOGLE_CLIENT_ID` in `.env` and restart `thinkaloud` |
| Google popup says *Error 400: origin_mismatch* / "not a valid origin" | Add the exact page origin (scheme + host + port) to the client's Authorized JavaScript origins and wait a few minutes |
| Google popup says *Access blocked: … has not completed the Google verification process* | The app is in Testing and that address isn't a test user. Add it under Audience → Test users, or publish the app |
| "Google sign-in didn't work" after the popup | Server rejected the token: usually `GOOGLE_CLIENT_ID` on the server differs from the client the page used, or the server clock is off |
| Old `*.web.app` assets 404 after a deploy | Expected for removed hashes. `index.html` is `no-cache`, so a reload picks up the new build |

## Upgrade: a named tunnel on your own domain (stable URLs)

Not done yet. It needs a Cloudflare credential for the `hizmetsearch.com` zone. It runs as a separate
user-level tunnel and does not touch root's HizmetSearch tunnel or `/etc/cloudflared`.

1. **Credential.** Either an API token with *Account › Cloudflare Tunnel › Edit* and *Zone › DNS › Edit*
   (for hizmetsearch.com), or run `cloudflared tunnel login` as `tarmus`. That writes
   `~/.cloudflared/cert.pem`, which is separate from root's `/etc/cloudflared`.
2. **Create the tunnel and DNS** (one level below the zone, so Cloudflare's free Universal SSL covers it):
   ```bash
   cloudflared tunnel create thinkaloud            # → ~/.cloudflared/<TUNNEL_ID>.json
   cloudflared tunnel route dns thinkaloud ta-api.hizmetsearch.com
   cloudflared tunnel route dns thinkaloud ta-apps.hizmetsearch.com
   ```
   Per-app subdomains (`app-x.ta-apps.hizmetsearch.com`, `APP_HOST_ROUTING=subdomain`, which gives
   stronger isolation between hosted apps) need a wildcard two levels deep. That requires Cloudflare
   Advanced Certificate Manager. Without it, keep path routing.
3. **Config** `~/.cloudflared/thinkaloud.yml`:
   ```yaml
   tunnel: <TUNNEL_ID>
   credentials-file: /home/tarmus/.cloudflared/<TUNNEL_ID>.json
   ingress:
     - hostname: ta-api.hizmetsearch.com
       service: http://127.0.0.1:4000
     - hostname: ta-apps.hizmetsearch.com
       service: http://127.0.0.1:4001
     - service: http_status:404
   ```
4. **Swap the units.** Disable the quick tunnels and run the named one:
   ```bash
   systemctl --user disable --now thinkaloud-tunnel-api thinkaloud-tunnel-apps
   # ~/.config/systemd/user/thinkaloud-tunnel.service, ExecStart:
   #   /usr/local/bin/cloudflared tunnel --no-autoupdate --config %h/.cloudflared/thinkaloud.yml run thinkaloud
   systemctl --user daemon-reload && systemctl --user enable --now thinkaloud-tunnel
   ```
5. **Point the sync at the fixed URLs** in `data/deploy/deploy.env`:
   ```
   API_URL=https://ta-api.hizmetsearch.com
   APPS_URL=https://ta-apps.hizmetsearch.com
   APP_HOST_ROUTING=path
   ```
   Then `systemctl --user restart thinkaloud-sync`. It writes `runtime.env`, restarts the server once and
   publishes `config.json` once. From then on nothing changes on reboot. Also edit the sync unit's
   `Wants=`/`After=` to `thinkaloud-tunnel.service`.
6. **Optional:** serve the front end at `thinkaloud.hizmetsearch.com` (Firebase console → Hosting →
   Add custom domain → a CNAME in Cloudflare, DNS only). Then set `WEB_URL=https://thinkaloud.hizmetsearch.com`
   in `deploy.env`, so links use it, and add the web.app origin to `EXTRA_CORS_ORIGINS` so both keep working.
   Then run `systemctl --user restart thinkaloud-sync thinkaloud`: the sync restarts the server by itself only for
   `APP_HOST_URL` changes.
   With the front end and API on the same site, cookies would work again too, but bearer auth stays in place.
