# App host and build pipeline

The app host is a separate Express server (`APP_HOST_PORT`, default 4001). It serves uploaded builds
on a different origin from the platform, so uploaded code can never read platform cookies or call
the API as the researcher. Every HTML response gets `<script src="/__thinkaloud/probe.js"></script>`
as the first script in `<head>`.

## URL schemes

`apps.url`, which is the URL the participant iframe loads, is built by `hostedAppBase()` in `urls.ts`.
App ids look like `app_xxxx`. DNS labels cannot contain `_`, so the host label is `app-xxxx`.

| Mode | `APP_HOST_URL` | App URL |
|---|---|---|
| subdomain (default) | `http://localhost:4001` | `http://app-xxxx.localhost:4001/` (browsers resolve `*.localhost` to 127.0.0.1) |
| subdomain | `https://apps.example.com` | `https://app-xxxx.apps.example.com/` (needs wildcard DNS and TLS for `*.apps.example.com`) |
| path (fallback) | `http://10.0.0.5:4001`, or `APP_HOST_ROUTING=path` | `http://10.0.0.5:4001/a/app_xxxx/` |

- **Subdomain mode** is the recommended mode. Each app owns `/` on its own origin, so absolute
  asset paths (`/assets/index-abc.js`, `/_expo/static/...`) and SPA routers work without changes.
  Each app also gets its own storage origin.
- **Path mode** is chosen automatically when `APP_HOST_URL` is an IP address, or forced with
  `APP_HOST_ROUTING=path`. It works like this:
  - The HTML for `/a/<id>/...` gets a small inline script that removes the `/a/<id>` prefix with
    `history.replaceState` before the app starts, so the router sees `/`.
  - The response sets a `ta_app=<id>` cookie. On https or localhost this is a partitioned
    `SameSite=None; Secure` cookie (CHIPS); otherwise it is `Lax`.
  - Later requests with absolute paths are mapped back to the app by `Referer` (`/a/<id>/...`),
    falling back to the cookie.
  - Limitations: only one path-routed app works per browser at a time, because the cookie holds a
    single id. All apps share one origin, so they share localStorage and are not isolated from
    each other.

Environment:

- `APP_HOST_URL`: public base URL of the app host.
- `APP_HOST_ROUTING=subdomain|path`: overrides the automatic choice.
- `APP_FRAME_ANCESTORS`: value of `Content-Security-Policy: frame-ancestors`, default `*`. Set it to
  your `PUBLIC_URL` origin in production. `X-Frame-Options` is never sent.

Deploying behind a reverse proxy: point `*.apps.example.com` (and `apps.example.com`) at the app host
port, preserve the `Host` header, and set `APP_HOST_URL=https://apps.example.com`.

## Serving rules

- **Resolving the app:** the app is found from the Host label, then the `/a/<id>/` prefix, then the
  Referer, then the cookie. Unknown apps get a 404 page. Apps that are not ready yet get a
  "Preparing" page that refreshes itself, with status 503.
- **Files:**
  - Existing files are served with the correct MIME type.
  - A directory serves its `index.html`.
  - Extensionless paths are tried as `<path>.html` (for Next.js static export).
  - Missing paths with no extension (or with `.html`) fall back to the root `index.html` (SPA fallback).
  - Missing files that have another extension return a real 404, so you never get a MIME error from
    HTML served as JS.
- **Dynamic pre-rendered routes:** `/post/123` falls back to `post/[id].html` (and `[...slug].html`)
  before the SPA fallback (Expo Router static export).
- **Data requests:** a `fetch()`/XHR (`Sec-Fetch-Dest: empty`) for a missing extensionless path gets a
  JSON 404, and non-GET requests get a JSON 405, instead of the SPA's `index.html` (which apps would
  try to parse as JSON). The message says the app is hosted as static files.
- **MIME:** explicit types for `.mjs/.cjs` (JavaScript), `.wasm`, `.webmanifest`, fonts, `.map`, `.avif`, glTF.
- **Service workers** are disabled in hosted apps: the injected tag carries `data-ta-hosted`, and the
  probe unregisters existing workers and makes `navigator.serviceWorker.register()` return a promise
  that never settles. Otherwise a worker from an old build keeps serving stale files after a rebuild.
- **Cookies in the frame:** the study wrapper is often a different site, where `SameSite=Lax` cookies
  are dropped. In hosted, framed pages (secure contexts: https or `*.localhost`) the probe rewrites
  `document.cookie` writes to `SameSite=None; Secure; Partitioned`, and the server-app proxy does the
  same for `Set-Cookie`. localStorage works (partitioned per top-level site).
- **Caching:** HTML is sent with `no-cache`. Hashed and `assets/` files are sent with
  `public, max-age=31536000, immutable`. Everything else is sent with `no-cache`.
- **Probe:** served at `/__thinkaloud/probe.js` from `probe/dist/probe.js`. Build it with
  `npm run build -w probe`.
- **External URL proxy:** for a URL app with `PATCH {proxy:true}`, the app host acts as a
  best-effort reverse proxy on the app's own subdomain:
  - It removes `X-Frame-Options`, the upstream CSP headers and `<meta>` CSP tags.
  - It rewrites absolute links to the upstream origin, `Location` headers, and the cookie `Domain`.
  - It injects the probe.
  - It will not work for sites that check `Origin` strictly, use absolute URLs built in JS, or
    depend on OAuth redirects.

- **SSRF guard:** a proxied URL must resolve to a public address. It is checked when the URL is saved
  (create/PATCH) and again at connect time on every request (a guarded DNS lookup, so DNS rebinding
  cannot swap in a private address). Redirects are never followed server-side; the rewritten
  `Location` comes back through the proxy and is checked again. Refused: loopback, RFC 1918,
  CGNAT, link-local (incl. 169.254.169.254), `::1`, `fc00::/7`, `fe80::/10`, multicast, `*.localhost`,
  `*.internal`, `*.local`. `ALLOW_PRIVATE_PROXY=1` disables the guard for local development.

## Server apps (`builds/runtime.ts`, `apphost/serverProxy.ts`)

Apps that cannot be a static export run as a long-lived server:

- **Detected as `next-server`:** Next.js without `output: 'export'` (the log lists why: route handlers,
  server actions, `redirects/rewrites/headers`, middleware, `getServerSideProps`, API routes). Started
  with `next start -p $PORT -H 0.0.0.0`.
- **Detected as `node-server`:** Remix (`@remix-run/serve`), React Router v7 SSR (`@react-router/serve`),
  Nuxt (not `nuxt generate`), SvelteKit `adapter-node`, Astro node adapter, or an Express/Fastify/Koa/Hono
  app with a `node …` start script. Started with `npm run start` (`PORT` is set). React Router / Remix
  with `ssr: false` is served statically from `build/client/`.
- Build settings can force it: `mode: 'server'` (with `startCommand`) or `mode: 'static'`.
- **Runtime:** after the build, the source tree (with `node_modules`) stays in `DATA_DIR/apps/<id>/source`.
  A container `ta-app-<id>` runs it (`docker run -d --restart unless-stopped`, host uid, `--cap-drop ALL`,
  `no-new-privileges`, `RUN_MEMORY` (1g), `RUN_CPUS` (1), `--pids-limit 1024`) with the port published only on
  `127.0.0.1:<random>`. The researcher's env vars are passed at runtime too. With `BUILD_MODE=local`
  it is a detached child process on a free port.
- The build turns `ready` only once the server answers HTTP (`RUN_START_TIMEOUT_MS`, 180 s).
- **Lifecycle:** containers are (re)started lazily when the API server boots (staggered) and on the
  first request. Until then the app host answers page loads with a self-refreshing "Starting the app…"
  page (503). A rebuild or delete removes the container. Runtime events are appended to the build
  log, and `GET /api/apps/:id/log` adds the container's latest output.
- **Proxy:** the app host forwards to the container with the original `Host` and `X-Forwarded-*`
  headers. The probe is injected only into `text/html` document responses: the head is buffered
  until `<head>`/first `<script>` and the rest streams through. RSC/flight requests (`RSC: 1`,
  `?_rsc=`, prefetch, `Next-Action`), JSON, event streams and static chunks pass through untouched
  (with their encoding). `X-Frame-Options` and CSP `frame-ancestors` from the app are dropped, other
  CSP directives are kept. `Location` headers pointing at the internal address are rewritten.
  WebSocket upgrades are tunnelled.
- The probe's host-driven `navigate` uses `window.next.router.push()` when present. A synthetic
  `popstate` would make the Next app router restore the previous page.

## Build pipeline (`server/src/builds`)

`POST /api/studies/:id/apps` stores the zip in `DATA_DIR/apps/<id>/upload.zip` and queues a build.
At most 2 builds run at once. Builds that were interrupted are resumed when the server restarts.

1. **Extract** with safety checks:
   - Rejected: absolute paths, `..` segments (zip-slip), symlinks, and uploads over 500 MB unpacked
     or 200k entries.
   - Skipped (and not counted towards the limits): `node_modules`, `.git`, `.next`, `.expo`, `.turbo`,
     `.cache` and `__MACOSX` entries. Uploads up to `MAX_UPLOAD_MB` (1024).
   - Git sources: `git clone --depth 1 --single-branch [--branch]`. Only http(s) URLs are accepted,
     the `file:` protocol is disabled, and symlinks are disabled.
2. **Find the project root:** descend through a single top-level folder, then apply the optional
   `subdir` for monorepos. `subdir` can be sent as a multipart field or a JSON field. Without
   `subdir`, a workspace root (workspaces / `pnpm-workspace.yaml`) with no framework of its own picks
   its only app package, or fails listing the candidates ("Set the subdirectory to one of: apps/mobile
   (Expo), apps/web (Next.js)"). Local workspace dependencies with a `build` script are built first.
3. **Detect the framework:**

   | Framework | Detected by | Build | Output |
   |---|---|---|---|
   | `expo-web` | `expo` dependency | Installs any missing `react-dom`, `react-native-web` or `@expo/metro-runtime` with `npx expo install` (logged), then runs `expo export --platform web` (`export:web` for SDK < 49). `web.output: "server"` (the create-expo-app default) is switched to `"single"`; `"static"` is kept, but if static rendering fails (env vars or `window` at import time) the export is retried as `"single"` | `dist/` or `web-build/` |
   | `next-static` | `next` with `output: 'export'` (or `mode: 'static'`) | `next build` (the config is wrapped to set `images.unoptimized` if needed; plus `next export` for Next < 14) | `out/` |
   | `next-server` | `next` without `output: 'export'` | `build` script, then `next start` in a container (see Server apps) | — |
   | `node-server` | Remix / React Router SSR / Nuxt / SvelteKit node / Node server | `build` script, then `npm run start` | — |
   | `cra` | `react-scripts` dependency | `build` script | `build/` |
   | `vite` | `vite` dependency | `build` script, or `vite build` if there is none. If a script with `tsc`/`vue-tsc`/`svelte-check` fails, it is retried as plain `vite build` (type errors do not block a study) | `outDir` from the vite config, else `dist/` |
   | `unknown` | `build` script but no known framework (e.g. Angular) | `build` script | first of `dist, build, out, web-build, _site, public, www` with `index.html`, then nested `dist/<x>/browser`, `build/client`, `dist/<x>` |
   | `static` | No `package.json`, or no build script | none | `index.html` at the root or in one of those folders |

   Vite apps are built with their own `base` (usually `/`). Subdomain hosting serves them at `/`
   unchanged.
4. **Build settings** (`meta.json`, `PATCH /api/apps/:id`): `env` (build-time, and runtime for
   server apps), `buildCommand` (replaces the framework build step), `outputDir`, `startCommand`, `mode`,
   `nodeVersion`. The log names the env keys (never values) and lists public env keys the project
   references (`VITE_*`, `EXPO_PUBLIC_*`, `NEXT_PUBLIC_*`, `REACT_APP_*` in source and `.env.example`)
   that are not set anywhere. `.env` files in the upload are used as is.
5. **Node version:** `nodeVersion` setting, else `.nvmrc` / `.node-version` / `.tool-versions` (walking up
   to the upload root), else `volta.node`, else `engines.node`, mapped to one of 18/20/22/24 (ranges pick
   22 if allowed, else the highest allowed). The image is `node:<major>`; `BUILD_IMAGE` pins one image.
6. **Install:**
   - The package manager comes from the `packageManager` field or the lockfile:
     `pnpm-lock.yaml`, `yarn.lock`, `bun.lock(b)`, or npm by default.
   - npm uses `npm ci`, falling back to `npm install`.
   - npm falls back to `npm install`, then `npm install --legacy-peer-deps`.
   - pnpm and yarn are put on `PATH` as corepack shims (honouring `packageManager`), so tools that
     spawn them (`expo install`, turbo, scripts) work; without corepack they are installed into a
     temporary prefix. bun is installed the same way. Yarn Berry works with PnP; Expo builds force
     `YARN_NODE_LINKER=node-modules` (Metro cannot resolve PnP).
7. **Build:**
   - With `BUILD_MODE=docker` (the default), the build runs in a `docker run --rm` container from
     `BUILD_IMAGE` (default `node:22`):
     - It runs as the host uid/gid, with the source mounted at `/workspace`.
     - It has a shared npm/corepack cache in `DATA_DIR/build-cache`.
     - Limits: `--memory 8g --cpus 2 --pids-limit 4096`, `--cap-drop ALL`, `no-new-privileges`.
       (Next.js 15 type checking was OOM-killed at 4g.)
       `BUILD_MEMORY` and `BUILD_CPUS` override the limits.
     - Network access is on, for package installs.
   - With `BUILD_MODE=local`, the same script runs in a local `bash` child process.
   - Builds time out after 15 minutes (`BUILD_TIMEOUT_MS`). `BUILD_CONCURRENCY` (2) builds run at once.
   - On failure the log ends with **What to change**: concrete hints for native-only React Native
     modules, missing modules, peer-dependency conflicts, out-of-memory, wrong Node version, type
     errors, missing env vars, SSR-only Next features, `window` used during pre-rendering, timeouts.
8. **Publish:** the output is copied to `DATA_DIR/apps/<id>/dist` with symlinks dropped. The source
   folder is then deleted, and `apps` is updated with `status=ready`, `framework`, `url` and
   `instrumented=1`. On failure, `status=failed` and `error` holds the reason plus the last 30
   log lines. The full log is in `DATA_DIR/apps/<id>/build.log` (`GET /api/apps/:id/log`).

`POST /api/apps/:id/rebuild` re-extracts the original zip, or re-clones the repo, and rebuilds from
a clean tree.
