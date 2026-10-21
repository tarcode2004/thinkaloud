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

## Build pipeline (`server/src/builds`)

`POST /api/studies/:id/apps` stores the zip in `DATA_DIR/apps/<id>/upload.zip` and queues a build.
At most 2 builds run at once. Builds that were interrupted are resumed when the server restarts.

1. **Extract** with safety checks:
   - Rejected: absolute paths, `..` segments (zip-slip), symlinks, and uploads over 500 MB unpacked
     or 200k entries.
   - Skipped: `node_modules`, `.git`, `.next`, and `__MACOSX` entries.
   - Git sources: `git clone --depth 1 --single-branch [--branch]`. Only http(s) URLs are accepted,
     the `file:` protocol is disabled, and symlinks are disabled.
2. **Find the project root:** descend through a single top-level folder, then apply the optional
   `subdir` for monorepos. `subdir` can be sent as a multipart field or a JSON field.
3. **Detect the framework:**

   | Framework | Detected by | Build | Output |
   |---|---|---|---|
   | `expo-web` | `expo` dependency | Installs any missing `react-dom`, `react-native-web` or `@expo/metro-runtime` with `npx expo install` (logged), then runs `expo export --platform web` (`export:web` for SDK < 49) | `dist/` or `web-build/` |
   | `next-static` | `next` dependency | If the config does not ask for `output: 'export'`, wraps it to force a static export (and sets `images.unoptimized`), then runs `next build` (plus `next export` for Next < 14) | `out/` |
   | `cra` | `react-scripts` dependency | `build` script | `build/` |
   | `vite` | `vite` dependency | `build` script, or `vite build` if there is none | `outDir` from the vite config, else `dist/` |
   | `unknown` | `build` script but no known framework | `build` script | first of `dist, build, out, web-build, _site, public, www` that contains `index.html` |
   | `static` | No `package.json`, or no build script | none | `index.html` at the root or in one of those folders |

   Vite apps are built with their own `base` (usually `/`). Subdomain hosting serves them at `/`
   unchanged.
4. **Install:**
   - The package manager comes from the `packageManager` field or the lockfile:
     `pnpm-lock.yaml`, `yarn.lock`, `bun.lock(b)`, or npm by default.
   - npm uses `npm ci`, falling back to `npm install`.
   - pnpm and yarn run via `corepack` when it is available, otherwise via `npx`.
   - bun runs via `npx bun`.
5. **Build:**
   - With `BUILD_MODE=docker` (the default), the build runs in a `docker run --rm` container from
     `BUILD_IMAGE` (default `node:22`):
     - It runs as the host uid/gid, with the source mounted at `/workspace`.
     - It has a shared npm/corepack cache in `DATA_DIR/build-cache`.
     - Limits: `--memory 4g --cpus 2 --pids-limit 4096`, `--cap-drop ALL`, `no-new-privileges`.
       `BUILD_MEMORY` and `BUILD_CPUS` override the limits.
     - Network access is on, for package installs.
   - With `BUILD_MODE=local`, the same script runs in a local `bash` child process.
   - Builds time out after 15 minutes (`BUILD_TIMEOUT_MS`).
6. **Publish:** the output is copied to `DATA_DIR/apps/<id>/dist` with symlinks dropped. The source
   folder is then deleted, and `apps` is updated with `status=ready`, `framework`, `url` and
   `instrumented=1`. On failure, `status=failed` and `error` holds the reason plus the last 30
   log lines. The full log is in `DATA_DIR/apps/<id>/build.log` (`GET /api/apps/:id/log`).

`POST /api/apps/:id/rebuild` re-extracts the original zip, or re-clones the repo, and rebuilds from
a clean tree.
