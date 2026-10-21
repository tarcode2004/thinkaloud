// App host: a separate Express app on its own origin (APP_HOST_PORT) that serves
// ready builds with the ThinkAloud probe injected into every HTML response.
// See ./README.md for URL schemes and deployment.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import express, { type Request, type Response } from 'express';
import { db } from '../db.ts';
import { config } from '../lib/config.ts';
import { paths } from '../lib/paths.ts';
import { readMeta } from '../builds/meta.ts';
import { guardedLookup, isPrivateAddress, privateProxyAllowed, SsrfError } from '../lib/ssrf.ts';
import { appHostBaseHostname, appHostRouting, appIdFromLabel, hostedAppBase } from './urls.ts';
import { proxyServerApp, upgradeServerApp } from './serverProxy.ts';

const PROBE_PATH = '/__thinkaloud/probe.js';
// data-ta-hosted: the probe also disables service workers (they would serve stale builds after a rebuild).
const PROBE_TAG = `<script src="${PROBE_PATH}" data-ta-hosted></script>`;
const FRAME_ANCESTORS = process.env.APP_FRAME_ANCESTORS || '*';
const APP_COOKIE = 'ta_app';
const APP_ID_RE = /^[a-z]+_[a-z0-9]+$/;

type AppRow = Record<string, unknown>;

// ── HTML injection ──────────────────────────────────────────────────────────
/** Insert the probe as the first script in <head> (after <meta charset> when it precedes scripts). */
export function injectProbe(html: string): string {
  if (html.includes(PROBE_PATH)) return html;
  const firstScript = html.search(/<script[\s>]/i);
  const charset = html.match(/<meta[^>]+charset[^>]*>/i);
  if (charset?.index !== undefined && (firstScript < 0 || charset.index < firstScript)) {
    const at = charset.index + charset[0].length;
    return html.slice(0, at) + PROBE_TAG + html.slice(at);
  }
  const head = html.match(/<head(\s[^>]*)?>/i);
  if (head?.index !== undefined) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + PROBE_TAG + html.slice(at);
  }
  const htmlTag = html.match(/<html(\s[^>]*)?>/i);
  if (htmlTag?.index !== undefined) {
    const at = htmlTag.index + htmlTag[0].length;
    return html.slice(0, at) + `<head>${PROBE_TAG}</head>` + html.slice(at);
  }
  const doctype = html.match(/<!doctype[^>]*>/i);
  if (doctype?.index !== undefined) {
    const at = doctype.index + doctype[0].length;
    return html.slice(0, at) + PROBE_TAG + html.slice(at);
  }
  return PROBE_TAG + html;
}

const htmlCache = new Map<string, { mtime: number; html: string }>();
function readInjected(file: string): string {
  const st = fs.statSync(file);
  const hit = htmlCache.get(file);
  if (hit && hit.mtime === st.mtimeMs) return hit.html;
  const html = injectProbe(fs.readFileSync(file, 'utf8'));
  if (htmlCache.size > 500) htmlCache.clear();
  htmlCache.set(file, { mtime: st.mtimeMs, html });
  return html;
}

function sendHtml(res: Response, html: string, status = 200) {
  res.status(status);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(html);
}

// ── App resolution ──────────────────────────────────────────────────────────
function loadApp(appId: string): AppRow | undefined {
  if (!APP_ID_RE.test(appId)) return undefined;
  return db.prepare('SELECT * FROM apps WHERE id = ?').get(appId) as AppRow | undefined;
}

function appIdFromHost(req: Request): string | undefined {
  const host = (req.hostname || '').toLowerCase();
  if (!host || host === appHostBaseHostname) return undefined;
  const first = host.split('.')[0];
  return /^[a-z]+-[a-z0-9]+$/.test(first) && host.includes('.') ? appIdFromLabel(first) : undefined;
}

const PATH_PREFIX_RE = /^\/a\/([a-z]+_[a-z0-9]+)(\/.*)?$/;

function appIdFromReferer(req: Request): string | undefined {
  const ref = req.get('referer');
  if (!ref) return undefined;
  try {
    const u = new URL(ref);
    if (u.host !== req.get('host')) return undefined;
    return PATH_PREFIX_RE.exec(u.pathname)?.[1];
  } catch {
    return undefined;
  }
}

function setAppCookie(req: Request, res: Response, appId: string) {
  // The app host is usually cross-site to the platform (iframe = third-party context), so use a
  // partitioned (CHIPS) SameSite=None cookie where Secure is possible (https, or http://localhost).
  const secureOk = req.secure || req.hostname === 'localhost' || req.hostname.endsWith('.localhost');
  res.cookie(APP_COOKIE, appId, secureOk ? { path: '/', httpOnly: true, sameSite: 'none', secure: true, partitioned: true } : { path: '/', httpOnly: true, sameSite: 'lax' });
}

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

// ── Static serving ──────────────────────────────────────────────────────────
const HASHED_RE = /(^|\/)(assets|_next\/static|_expo\/static|static)\/|[.-][A-Za-z0-9_-]{8,}\.(js|mjs|css|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|avif|ico|wasm|map|json)$/;

function safeJoin(root: string, urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0')) return undefined;
  const p = path.resolve(root, '.' + path.posix.normalize('/' + decoded));
  return p === root || p.startsWith(root + path.sep) ? p : undefined;
}

function statFile(p: string): fs.Stats | undefined {
  try {
    const st = fs.lstatSync(p);
    return st.isSymbolicLink() ? undefined : st;
  } catch {
    return undefined;
  }
}

/** The file must really live inside dist: a symlinked *directory* on the way (dist/x → /) is not followed. */
function insideDist(dist: string, p: string): string | undefined {
  try {
    const realDist = fs.realpathSync(dist);
    const real = fs.realpathSync(p);
    return real === realDist || real.startsWith(realDist + path.sep) ? p : undefined;
  } catch {
    return undefined;
  }
}

function resolveFile(dist: string, urlPath: string): string | undefined {
  const p = safeJoin(dist, urlPath);
  if (!p) return undefined;
  const st = statFile(p);
  if (st?.isFile()) return insideDist(dist, p);
  if (st?.isDirectory()) {
    const idx = path.join(p, 'index.html');
    if (statFile(idx)?.isFile()) return insideDist(dist, idx);
  }
  if (!path.extname(p)) {
    const html = p.replace(/\/$/, '') + '.html'; // Next static export: /about → about.html
    if (statFile(html)?.isFile()) return insideDist(dist, html);
    const dyn = resolveDynamic(dist, urlPath);
    if (dyn) return insideDist(dist, dyn);
  }
  return undefined;
}

/**
 * Pre-rendered dynamic routes (Expo Router static export, some SSGs): /post/123 → post/[id].html,
 * /docs/a/b → docs/[...slug].html. Literal names win over [param] names at every level.
 */
export function resolveDynamic(dist: string, urlPath: string): string | undefined {
  let segs: string[];
  try {
    segs = decodeURIComponent(urlPath).split('/').filter(Boolean);
  } catch {
    return undefined;
  }
  if (!segs.length || segs.some((x) => x === '..' || x.includes('\0'))) return undefined;
  const walk = (dir: string, i: number): string | undefined => {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return undefined;
    }
    const seg = segs[i];
    const last = i === segs.length - 1;
    const tryHtml = (n: string) => {
      const f = path.join(dir, n);
      return statFile(f)?.isFile() ? f : undefined;
    };
    if (last && names.includes(seg + '.html')) return tryHtml(seg + '.html');
    if (names.includes(seg) && statFile(path.join(dir, seg))?.isDirectory()) {
      const r = last ? tryHtml(path.join(seg, 'index.html')) : walk(path.join(dir, seg), i + 1);
      if (r) return r;
    }
    for (const n of names) {
      const m = /^\[([^\]]+)\](\.html)?$/.exec(n);
      if (!m || m[1].startsWith('...') || m[1].startsWith('[')) continue;
      if (m[2] && last) return tryHtml(n);
      if (!m[2] && statFile(path.join(dir, n))?.isDirectory()) {
        const r = last ? tryHtml(path.join(n, 'index.html')) : walk(path.join(dir, n), i + 1);
        if (r) return r;
      }
    }
    const catchAll = names.find((n) => /^\[\[?\.\.\.[^\]]+\]\]?\.html$/.test(n));
    return catchAll ? tryHtml(catchAll) : undefined;
  };
  return walk(dist, 0);
}

const MIME_OVERRIDES: Record<string, string> = {
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.avif': 'image/avif',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.hbc': 'application/octet-stream',
};

/** fetch()/XHR (not a page load): never answer with the SPA's index.html. */
const isDataRequest = (req: Request) => {
  const dest = req.get('sec-fetch-dest');
  if (dest) return dest === 'empty';
  const accept = req.get('accept') || '';
  return accept.includes('application/json') && !accept.includes('text/html');
};

const PAGE_STYLE =
  "body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f5f7;color:#1d1d1f;font:15px/1.5 -apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',system-ui,sans-serif;-webkit-font-smoothing:antialiased}" +
  'main{text-align:center;max-width:420px;padding:24px}h1{font-size:21px;font-weight:600;letter-spacing:-.01em;margin:0 0 6px}p{margin:0;color:#6e6e73}' +
  '.dot{width:22px;height:22px;margin:0 auto 18px;border-radius:50%;border:2px solid #d2d2d7;border-top-color:#0071e3;animation:s 1s linear infinite}@keyframes s{to{transform:rotate(360deg)}}';

function statusPage(title: string, body: string, opts: { spinner?: boolean; refresh?: boolean } = {}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>${opts.refresh ? '<meta http-equiv="refresh" content="3">' : ''}<style>${PAGE_STYLE}</style></head><body><main>${opts.spinner ? '<div class="dot"></div>' : ''}<h1>${title}</h1><p>${body}</p></main></body></html>`;
}

function buildingPage(app: AppRow): string {
  return app.status === 'failed'
    ? statusPage('This app could not be built', 'Open the build log in ThinkAloud for details.')
    : statusPage('Preparing the app', 'This takes a moment. The page will refresh on its own.', { spinner: true, refresh: true });
}

/**
 * Path mode: strip the /a/<id> prefix from the URL before the app boots, so SPA routers
 * see '/'. Later requests (assets, reloads) resolve via the ta_app cookie / Referer.
 */
const prefixStripper = (appId: string) =>
  `<script>try{var p=location.pathname.replace(/^\\/a\\/${appId}(?=\\/|$)/,'')||'/';history.replaceState(history.state,'',p+location.search+location.hash)}catch(e){}</script>`;

function withPrefixStrip(html: string, appId?: string): string {
  if (!appId) return html;
  return html.replace(PROBE_TAG, prefixStripper(appId) + PROBE_TAG);
}

function serveBuild(app: AppRow, urlPath: string, req: Request, res: Response, stripPrefixOf?: string) {
  if (app.status !== 'ready') return sendHtml(res, buildingPage(app), 503);
  const dist = path.resolve(paths.appDist(app.id as string));
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).json({ error: 'Method not allowed', thinkaloud: `This app is hosted as static files, so ${req.method} ${urlPath} has no backend. Point the app at a reachable API (env var), or host it as a server app.` });
    return;
  }
  let file = resolveFile(dist, urlPath);
  if (!file) {
    const ext = path.extname(urlPath.split('?')[0]);
    const wantsHtml = !ext || ext === '.html' || ext === '.htm';
    if (wantsHtml && !ext && isDataRequest(req)) {
      res.status(404).json({ error: 'Not found', thinkaloud: `No file at ${urlPath}. This app is hosted as static files; relative API calls have no backend.` });
      return;
    }
    if (!wantsHtml) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    // SPA fallback.
    const index = path.join(dist, 'index.html');
    if (statFile(index)?.isFile()) file = index;
    else {
      const nf = path.join(dist, '404.html');
      if (statFile(nf)?.isFile()) return sendHtml(res, withPrefixStrip(readInjected(nf), stripPrefixOf), 404);
      res.status(404).type('text/plain').send('Not found');
      return;
    }
  }
  if (/\.html?$/i.test(file)) return sendHtml(res, withPrefixStrip(readInjected(file), stripPrefixOf));
  const rel = path.relative(dist, file).split(path.sep).join('/');
  res.setHeader('Cache-Control', HASHED_RE.test(rel) ? 'public, max-age=31536000, immutable' : 'no-cache');
  const mime = MIME_OVERRIDES[path.extname(file).toLowerCase()];
  if (mime) res.setHeader('Content-Type', mime);
  res.sendFile(file, { dotfiles: 'allow', cacheControl: false, lastModified: true, etag: true });
}

// ── External URL reverse proxy (best effort) ────────────────────────────────
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'content-encoding', 'content-length', 'x-frame-options', 'content-security-policy', 'content-security-policy-report-only',
  'strict-transport-security', 'set-cookie', 'alt-svc', 'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy',
]);

async function proxyExternal(app: AppRow, urlPath: string, search: string, req: Request, res: Response) {
  const target = new URL(String(app.source_url));
  const upstream = new URL(urlPath + search, target.origin);
  const selfBase = hostedAppBase(app.id as string).replace(/\/$/, '');
  // SSRF: IP-literal hosts never hit DNS, so check them here; hostnames are checked at connect time by guardedLookup.
  const bareHost = upstream.hostname.replace(/^\[|\]$/g, '');
  if (!privateProxyAllowed() && (net.isIP(bareHost) ? isPrivateAddress(bareHost) : /(^|\.)(localhost|internal|local)$/.test(bareHost))) {
    res.status(403).type('text/plain').send(`Refusing to proxy ${upstream.host}: private or internal address (set ALLOW_PRIVATE_PROXY=1 for local development)`);
    return;
  }
  const headers: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || ['host', 'connection', 'accept-encoding', 'content-length', 'cookie', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-authorization', 'proxy-connection'].includes(k)) continue;
    headers[k] = v;
  }
  headers.host = upstream.host;
  headers['accept-encoding'] = 'identity';
  const cookie = req.headers.cookie
    ?.split(';')
    .filter((c) => c.trim().split('=')[0] !== APP_COOKIE)
    .join(';');
  if (cookie) headers.cookie = cookie;
  if (headers.origin) headers.origin = target.origin;
  if (headers.referer) headers.referer = target.origin + '/';
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  if (hasBody && req.headers['content-length']) headers['content-length'] = req.headers['content-length'];
  else if (hasBody && req.headers['transfer-encoding']) headers['transfer-encoding'] = req.headers['transfer-encoding'];
  const mod = upstream.protocol === 'https:' ? https : http;
  // Redirects are never followed here: Location is rewritten and the browser re-requests through this proxy (re-checked).
  const r = await new Promise<http.IncomingMessage | Error>((resolve) => {
    const up = mod.request(upstream, { method: req.method, headers, lookup: guardedLookup, timeout: 30_000 }, resolve);
    up.on('timeout', () => up.destroy(new Error('timed out')));
    up.on('error', resolve);
    if (hasBody) req.pipe(up);
    else up.end();
  });
  if (r instanceof Error) {
    const blocked = r instanceof SsrfError;
    res.status(blocked ? 403 : 502).type('text/plain').send(blocked ? `Refusing to proxy: ${r.message}` : `Could not reach ${target.origin}: ${r.message}`);
    return;
  }
  res.status(r.statusCode || 502);
  for (const [k, v] of Object.entries(r.headers)) {
    if (v !== undefined && !HOP_HEADERS.has(k)) res.setHeader(k, v as string | string[]);
  }
  const loc = r.headers.location;
  if (loc) {
    try {
      const l = new URL(loc, upstream);
      if (l.origin === target.origin) res.setHeader('location', selfBase + l.pathname + l.search + l.hash);
    } catch {
      /* keep */
    }
  }
  const cookies = r.headers['set-cookie'] ?? [];
  if (cookies.length) {
    res.setHeader(
      'set-cookie',
      cookies.map((c) => {
        let out = c.replace(/;\s*domain=[^;]*/gi, '');
        if (!req.secure) out = out.replace(/;\s*secure/gi, '').replace(/;\s*samesite=none/gi, '; SameSite=Lax');
        return out;
      }),
    );
  }
  const ct = String(r.headers['content-type'] || '');
  if (ct.includes('text/html') && req.method !== 'HEAD') {
    const chunks: Buffer[] = [];
    for await (const c of r) chunks.push(c as Buffer);
    let html = Buffer.concat(chunks).toString('utf8');
    const originRe = new RegExp(target.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    const protoRelRe = new RegExp(`(["'(])//${target.host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g');
    html = html.replace(originRe, selfBase).replace(protoRelRe, `$1${selfBase}`);
    html = html.replace(/<meta[^>]+http-equiv=["']?(content-security-policy|x-frame-options)["']?[^>]*>/gi, '');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Content-Type', ct);
    res.send(injectProbe(html));
    return;
  }
  if (req.method === 'HEAD') {
    r.resume();
    res.end();
    return;
  }
  r.pipe(res);
}

// ── Server ──────────────────────────────────────────────────────────────────
function notHosted(res: Response, msg = 'There is no app at this address.') {
  res.status(404).type('text/html').send(statusPage('App not found', msg));
}

function serveApp(app: AppRow, urlPath: string, search: string, req: Request, res: Response, stripPrefixOf?: string) {
  if (app.source_kind === 'url') {
    if (!readMeta(app.id as string).proxy) return notHosted(res, 'This app is an external URL and is not proxied.');
    return proxyExternal(app, urlPath, search, req, res);
  }
  if (app.status === 'ready' && readMeta(app.id as string).server) {
    return proxyServerApp(app.id as string, urlPath, search, req, res, {
      inject: injectProbe,
      statusPage,
      prefix: stripPrefixOf ? `/a/${stripPrefixOf}` : undefined,
      extraHead: stripPrefixOf ? (html) => withPrefixStrip(html, stripPrefixOf) : undefined,
    });
  }
  return serveBuild(app, urlPath, req, res, stripPrefixOf);
}

export function createAppHost() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.set('etag', false);

  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', `frame-ancestors ${FRAME_ANCESTORS}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.removeHeader('X-Frame-Options');
    next();
  });

  app.get(PROBE_PATH, (_req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    res.type('application/javascript');
    if (!fs.existsSync(paths.probeBundle)) {
      res.send('/* ThinkAloud probe not built: run `npm run build -w probe` */');
      return;
    }
    res.sendFile(paths.probeBundle, { cacheControl: false });
  });
  app.get('/__thinkaloud/health', (_req, res) => {
    res.json({ ok: true, routing: appHostRouting });
  });

  app.use(async (req, res) => {
    const qIndex = req.originalUrl.indexOf('?');
    const search = qIndex >= 0 ? req.originalUrl.slice(qIndex) : '';
    const fullPath = qIndex >= 0 ? req.originalUrl.slice(0, qIndex) : req.originalUrl;

    // 1. Subdomain routing: app-<id>.<APP_HOST_URL host>
    const hostId = appIdFromHost(req);
    if (hostId) {
      const row = loadApp(hostId);
      if (!row) return notHosted(res, 'Unknown app.');
      return serveApp(row, fullPath, search, req, res);
    }

    // 2. Path routing: /a/<appId>/...
    const m = PATH_PREFIX_RE.exec(fullPath);
    if (m) {
      const row = loadApp(m[1]);
      if (!row) return notHosted(res, 'Unknown app.');
      if (!m[2]) return res.redirect(302, `/a/${m[1]}/${search}`);
      setAppCookie(req, res, m[1]);
      return serveApp(row, m[2], search, req, res, m[1]);
    }

    // 3. Absolute asset / API path requested by a path-routed app (/assets/x.js): Referer, then cookie.
    const fallbackId = appIdFromReferer(req) || readCookie(req, APP_COOKIE);
    if (fallbackId) {
      const row = loadApp(fallbackId);
      if (row) return serveApp(row, fullPath, search, req, res);
    }
    return notHosted(res);
  });

  return app;
}

export function startAppHost() {
  const app = createAppHost();
  const server = app.listen(config.appHostPort, () => {
    console.log(`ThinkAloud app host on ${config.appHostUrl} (port ${config.appHostPort}, ${appHostRouting} routing, e.g. ${hostedAppBase('app_example')})`);
  });
  server.on('error', (e) => console.error('[apphost] failed to start:', e));
  // WebSocket upgrades for server apps (subdomain routing).
  server.on('upgrade', (req, socket, head) => {
    try {
      const host = String(req.headers.host || '').split(':')[0].toLowerCase();
      const label = host !== appHostBaseHostname && host.includes('.') ? host.split('.')[0] : '';
      const row = /^[a-z]+-[a-z0-9]+$/.test(label) ? loadApp(appIdFromLabel(label)) : undefined;
      if (!row || row.status !== 'ready' || !readMeta(row.id as string).server) return void socket.destroy();
      upgradeServerApp(row.id as string, req, socket, head, req.url || '/');
    } catch {
      socket.destroy();
    }
  });
  return server;
}
