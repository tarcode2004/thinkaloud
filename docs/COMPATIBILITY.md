# Build and hosting compatibility

These are the results of uploading real projects through `POST /api/studies/:id/apps`. Each one was
built in Docker and loaded in headless Chromium inside a **cross-site iframe**: the parent was
`http://127.0.0.1:<port>` and the app was `http://app-<id>.localhost:4901`. Each run checked four
things:

- the page renders;
- there are no console errors caused by the hosting;
- deep links and client-side routing work;
- the probe posts `hello`, `app.navigate` (load, push, and host-driven `navigate`) and `app.click`.

Tested 2026-10-21 on aarch64 with Docker and `node:22` / `node:20`.

Status: **Works** = renders, routes and records with no hosting errors. **Works (needs env)** = works
once the app's own env vars are set in Build settings. **Partial** = hosted correctly, but part of
the app depends on something outside our control. **Unsupported** = the build log says what to
change.

| Project type | Example tested | Status | Notes |
|---|---|---|---|
| **Next.js 15 App Router, server features** (route handlers, redirects, pnpm 10, Node 22, webpack obfuscator) | Stacky / CrossWeave (`stacky-social/client`), zip upload and `git@github.com:` SSH clone | **Works** | Detected as `next-server`. The log lists why it needs a server: no `output:'export'`, `redirects()`, 4 route handlers. Built in ~100s with obfuscation on, then run by `next start` in a container.<br>Checked:<ul><li>`/ChineseEVs` and `/tag/AIWorkforce` deep links render posts and the related-posts aside.</li><li>The aside follows the focused post on scroll.</li><li>Client navigation to `/home` works without a reload.</li><li>Host-driven `navigate` works.</li><li>`/listy-injection` 307-redirects to `/ChineseEVs`.</li><li>`?flags=summaryCard:1` is honoured: the app logs effective `summaryCard: true`, and `:0` gives false.</li><li>RSC (`?_rsc=`) passes through untouched.</li></ul>`/user/<name>` calls the live Mastodon instance (app-level). Needed `BUILD_MEMORY` ≥ 8g: Next's type-check step was OOM-killed at 4g. |
| Next.js, default `create-next-app` (no export) | `create-next-app@latest` | **Works** | Hosted as `next-server`. Unknown routes show Next's own 404. |
| Next.js static export (`output: 'export'`) | `create-next-app` + `output:'export'`, `/about`, `/posts/[id]` with `generateStaticParams` | **Works** | `/about` → `about.html`; `/posts/2` → `posts/2.html`. |
| Next.js in a pnpm/turbo monorepo | `TimurBas/expo-nextjs-monorepo` via git, `subdir: apps/web` | **Works** | Workspace packages resolve; hosted as `next-server`. |
| Expo SDK 58, `create-expo-app` default (expo-router tabs, `web.output: "server"`) | `create-expo-app@latest` | **Works** | Failed before this work: `server` output has no `index.html`. Now switched to `"single"` with a log note. Deep link `/explore` and host navigate work. |
| Expo blank template | `create-expo-app --template blank` | **Works** | |
| Expo, `web.output: "static"`, with dynamic route | template + `app/post/[id].tsx` | **Works** | `/explore` → `explore.html`. `/post/42` → `post/[id].html` (new dynamic-segment fallback). The template's custom tab navigator then redirects non-tab routes to `/`; that is app behaviour. |
| Expo + expo-router + auth screens, static output, Twitter clone | `KarimmYasser/yapper-mobile` (SDK 54) | **Works (needs env)** | Static rendering failed at build time, so it was automatically retried as `"single"`. At runtime it threw `EXPO_PUBLIC_USER_STORAGE_KEY is not defined` until that was set in Build settings; the log had listed it. Then `/landing-screen`, `/login` and `/sign-up` render and routing works. `expo-secure-store` has no web implementation (the app logs errors; app-level). |
| Expo + Clerk + Convex, Instagram clone | `burakorkmez/spotlight` | **Partial (needs real keys)** | Static render failed with "No address provided to ConvexReactClient", and the export was retried as SPA. With `EXPO_PUBLIC_CONVEX_URL` and `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` set, the values reach the bundle. A fake Clerk key then fails inside Clerk (expected). Researchers need a real dev key. |
| Expo in a pnpm monorepo (SDK 53, `web.output: "server"` with `+api` routes) | `TimurBas/expo-nextjs-monorepo`, `subdir: apps/mobile` | **Works** | Failed before: `expo install` spawned `pnpm`, which was not on PATH. pnpm and yarn are now corepack shims on PATH. The log warns that `app/api/auth/[...auth]+api.ts` will not work in a static export. Without `subdir`, the build fails with "Set the subdirectory to one of: apps/mobile (Expo), apps/web (Next.js)". |
| Expo + native-only module | blank template + `react-native-maps` | **Unsupported (clear message)** | The log ends with: "react-native-maps uses the native-only module react-native/Libraries/Utilities/codegenNativeCommands and has no web support. Guard it with Platform.OS !== 'web', or add a `.web.tsx` file…" |
| React Native + react-native-web via Vite plugin (pnpm workspace, `workspace:*` plugin) | `Bram-dc/vite-plugin-react-native-web` via git, branch `master`, `subdir: apps/example` | **Works** | The local workspace plugin package is built first. |
| Vite react-ts | `create-vite --template react-ts` | **Works** | |
| Vite vue-ts / svelte-ts | `create-vite` templates | **Works** | |
| Vite + React social apps | `hakkuuuu/hakoverse` (Reddit clone, Supabase) | **Works (needs env)** | Blank page ("Supabase URL and Anon Key must be defined") until `VITE_API_URL` / `VITE_API_KEY` were set; the log listed exactly those names. Then it renders, with deep links `/popular` and `/explore`. |
| | `MkdirRaiden/twitter-clone-client` | **Partial** | Renders and routes (`/login`, `/profile/:u`). Its hard-coded backend only allows CORS from its own Vercel origin (app-level: the backend must allow `https://app-*.<apps domain>`). |
| Vite PWA (vite-plugin-pwa) + `@fontsource` fonts + relative `fetch('/api/me')` | template + plugins | **Works** | Service worker registration is neutralised, so there is no stale cache after a rebuild. `woff2` is served as `font/woff2`, `.webmanifest` as `application/manifest+json`. `fetch('/api/me')` gets a JSON 404 that says "hosted as static files", instead of `index.html`. |
| Zip that contains `node_modules` (77 MB) | vite-vue with installed deps | **Works** | 1546 `node_modules` entries are skipped and not counted towards the limits. Deps are reinstalled for linux/arm64. |
| Zip with a nested top-level folder / files at the zip root | most of the above / pm-pnpm | **Works** | |
| Create React App (react-scripts 5, react-router 6, eslint warnings) | hand-made CRA | **Works** | `CI=false`, so warnings do not fail the build. Deep link `/feed/42` works and localStorage persists. |
| React Router v7 framework mode (SSR, default) | `create-react-router@latest` | **Works** | Hosted as `node-server` (`react-router-serve`). |
| React Router v7 SPA mode (`ssr: false`) | same, `ssr: false` | **Works** | Served statically from `build/client`. Deep links to routes the app does not define hydrate the prerendered root and log React #418 (React Router SPA behaviour, also without ThinkAloud). |
| Angular 22 (`ng build`, application builder) | `@angular/cli new` | **Works** | Output found in nested `dist/ng-app/browser` (new). |
| pnpm (`pnpm-lock.yaml`, no `packageManager`) | vite react-ts | **Works** | |
| Yarn classic (`yarn.lock` v1) | vite react-ts | **Works** | |
| Yarn Berry 4 (PnP, `packageManager: yarn@4.9.2`) | vite react-ts | **Works** | Expo builds force `nodeLinker: node-modules` (Metro cannot use PnP). |
| Bun (`bun.lock`) | vite react-ts | **Works** | bun is installed into a temporary prefix. |
| `.nvmrc` 20 + `engines.node: ">=20 <21"`, build script asserts Node 20 | vite react-ts | **Works** | The log says "Node.js 20 (.nvmrc (20))" and builds in `node:20`. |
| Git source over https with branch + subdir | Bram-dc (above), TimurBas apps/web | **Works** | |
| Git source over SSH (`git@github.com:…`) | Stacky | **Works** | Allowed by default outside production (`GIT_ALLOW_SSH=1/0`). Uses the server's SSH key. |
| Next.js `output: 'export'` app using server-only features | (unit-tested diagnosis) | **Unsupported as static (clear message)** | The log suggests switching Hosting to "Server". With the default Auto mode, such apps are hosted as servers anyway. |

## Cross-site iframe behaviour

- **localStorage / sessionStorage** work: each app has its own origin, partitioned per top-level site.
- **Cookies:** in a cross-site iframe Chrome drops `SameSite=Lax` and unspecified cookies. For hosted
  apps in secure contexts (https, or `*.localhost` in development), the probe now rewrites
  `document.cookie` writes, and the server-app proxy rewrites `Set-Cookie`, to
  `SameSite=None; Secure; Partitioned` (CHIPS). Verified: before the change only an explicitly
  partitioned cookie survived; after it, plain `document.cookie = 'a=1'` works. Over plain http on a
  non-localhost host this cannot work. Host the platform and apps on https, or on the same site, for
  example `app.example.com` and `*.apps.example.com`.
- **Third-party backends** must allow the app origin in CORS (`https://app-<id>.<APP_HOST_URL host>`),
  and OAuth providers must allow it as a redirect URI.

## Known limitations

- Expo Router API routes (`+api.ts`), Next.js Middleware edge-only APIs and anything needing a
  platform runtime (Vercel/Netlify functions) do not run unless the app is hosted as a server app.
- React Native modules without web support must be guarded or given `.web.tsx` alternatives.
- Server apps keep their full source tree and `node_modules` on disk, and use 1 GB RAM / 1 CPU each
  by default (`RUN_MEMORY`, `RUN_CPUS`).
- Path routing mode (IP `APP_HOST_URL`) is best-effort for server apps: absolute URLs built by the
  server are not rewritten.

## How to re-run

The harness is plain Node + Playwright. It is not part of `npm test` because it needs Docker and the
network.

1. Start the server: `PORT=4900 APP_HOST_PORT=4901 APP_HOST_URL=http://localhost:4901 DATA_DIR=./data-compat npm start`.
2. Zip the project (or pass a git URL), then upload it with `POST /api/studies/:id/apps`.
3. Poll `GET /api/apps/:id` until it is ready.
4. Open a parent page served from `127.0.0.1` with `<iframe src="http://app-<id>.localhost:4901/...">`.
   Use Chromium at `~/.cache/ms-playwright/chromium-1234/chrome-linux/chrome`. Collect `message`
   events with `source === 'thinkaloud-probe'`, and post `{source:'thinkaloud-host', type:'navigate', path}`
   to the frame.

The parent must be a real local server, not a `page.route` fulfilment. Otherwise Chromium's Local
Network Access checks block the frame.
