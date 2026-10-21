// Reverse proxy from the app host to a server app's container (see builds/runtime.ts).
// - The probe is injected only into text/html document responses (streamed: the head is buffered
//   until the injection point, the rest streams through). RSC/flight responses (`RSC: 1` header,
//   `?_rsc=`), JSON, event streams, chunked bodies and static chunks pass through untouched.
// - X-Frame-Options and CSP frame-ancestors from the app are dropped (the host sets its own).
// - Location headers pointing at the internal address are rewritten to the public app URL.
// - WebSocket upgrades are tunnelled.
import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import zlib from 'node:zlib';
import type { Request, Response } from 'express';
import { ensureRuntime, markUnreachable } from '../builds/runtime.ts';
import { hostedAppBase } from './urls.ts';

const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'proxy-connection']);
const MAX_HEAD_BUFFER = 64 * 1024;

export interface ServerProxyOpts {
  inject: (html: string) => string;
  /** Path mode: the /a/<id> prefix stripped from the request, re-added to redirects; plus extra HTML (prefix stripper). */
  prefix?: string;
  extraHead?: (html: string) => string;
  statusPage: (title: string, body: string, opts?: { spinner?: boolean; refresh?: boolean }) => string;
}

const isDocumentRequest = (req: Request) => {
  const dest = req.get('sec-fetch-dest');
  if (dest) return dest === 'document' || dest === 'iframe' || dest === 'frame';
  return (req.get('accept') || '').includes('text/html');
};

const isFlightRequest = (req: Request, search: string) => req.get('rsc') === '1' || /[?&]_rsc=/.test(search) || req.get('next-router-prefetch') !== undefined || req.get('next-action') !== undefined;

/** Drop frame-ancestors from an upstream CSP (we set our own); undefined when nothing else is left. */
export function stripFrameAncestors(csp: string): string | undefined {
  const rest = csp
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d && !/^frame-ancestors\b/i.test(d));
  return rest.length ? rest.join('; ') : undefined;
}

export function rewriteLocation(loc: string, internalPort: number, publicBase: string, prefix = ''): string {
  try {
    const u = new URL(loc, 'http://internal.invalid');
    if (u.origin === 'http://internal.invalid') return loc.startsWith('/') && prefix ? prefix + loc : loc;
    const internal = ['127.0.0.1', 'localhost', '0.0.0.0', '[::]', '[::1]'].includes(u.hostname) && (u.port === String(internalPort) || u.port === '3000');
    if (internal) return publicBase.replace(/\/$/, '') + u.pathname + u.search + u.hash;
  } catch {
    /* keep */
  }
  return loc;
}

/**
 * The app runs in a (often cross-site) iframe: SameSite=Lax/unspecified cookies would be dropped there.
 * Make them SameSite=None; Secure; Partitioned (CHIPS) so sessions work inside the study frame.
 */
export function partitionCookie(c: string): string {
  if (/;\s*samesite\s*=\s*none/i.test(c) && /;\s*partitioned/i.test(c)) return c;
  let out = c.replace(/;\s*samesite\s*=\s*\w+/gi, '');
  out += '; SameSite=None';
  if (!/;\s*secure(\s*;|\s*$)/i.test(out)) out += '; Secure';
  if (!/;\s*partitioned/i.test(out)) out += '; Partitioned';
  return out;
}
const cookieSecureOk = (req: Request) => req.secure || req.get('x-forwarded-proto') === 'https' || /(^|\.)localhost$/.test(req.hostname || '');

/** Find where the probe goes once enough of the document has arrived. */
const headReady = (s: string) => /<head(\s[^>]*)?>|<script[\s>]|<body[\s>]/i.test(s);

export function proxyServerApp(appId: string, urlPath: string, search: string, req: Request, res: Response, opts: ServerProxyOpts) {
  const rt = ensureRuntime(appId);
  const doc = isDocumentRequest(req);
  if (rt.state !== 'running' || !rt.port) {
    if (rt.state === 'failed') {
      const body = opts.statusPage('The app server is not running', `It failed to start: ${escapeHtml(rt.error || 'unknown error')}. Open the build log in ThinkAloud for its output. Retrying shortly.`, { refresh: true });
      return doc ? void res.status(503).type('html').setHeader('Cache-Control', 'no-store').send(body) : void res.status(503).setHeader('Retry-After', '5').type('text/plain').send('App server failed to start');
    }
    if (doc) return void res.status(503).type('html').setHeader('Cache-Control', 'no-store').send(opts.statusPage('Starting the app…', 'The app server is starting. This page refreshes on its own.', { spinner: true, refresh: true }));
    return void res.status(503).setHeader('Retry-After', '3').type('text/plain').send('App server is starting');
  }
  const port = rt.port;
  const headers: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !HOP.has(k) && k !== 'accept-encoding') headers[k] = v;
  const fwdFor = req.socket.remoteAddress || '';
  headers['x-forwarded-for'] = req.headers['x-forwarded-for'] ? `${req.headers['x-forwarded-for']}, ${fwdFor}` : fwdFor;
  headers['x-forwarded-host'] = req.headers['x-forwarded-host'] || req.headers.host || '';
  headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
  const flight = isFlightRequest(req, search);
  // Documents: ask for an uncompressed body so the probe can be injected. Everything else keeps its encoding.
  if (!doc || flight) {
    const ae = req.headers['accept-encoding'];
    if (ae) headers['accept-encoding'] = ae;
  }
  const publicBase = hostedAppBase(appId);
  const upstream = http.request({ host: '127.0.0.1', port, method: req.method, path: urlPath + search, headers }, (up) => {
    const status = up.statusCode || 502;
    const ct = String(up.headers['content-type'] || '');
    const injectable = req.method === 'GET' && !flight && /^text\/html/i.test(ct) && status !== 204 && status !== 304;
    for (const [k, v] of Object.entries(up.headers)) {
      if (v === undefined || HOP.has(k) || k === 'x-frame-options') continue;
      if (k === 'content-security-policy' || k === 'content-security-policy-report-only') {
        const kept = (Array.isArray(v) ? v : [v]).map((c) => stripFrameAncestors(String(c))).filter(Boolean) as string[];
        if (k === 'content-security-policy') res.setHeader(k, [String(res.getHeader(k) || ''), ...kept].filter(Boolean));
        else if (kept.length) res.setHeader(k, kept);
        continue;
      }
      if (k === 'set-cookie' && cookieSecureOk(req)) {
        res.setHeader(k, (Array.isArray(v) ? v : [String(v)]).map(partitionCookie));
        continue;
      }
      if (k === 'location') {
        res.setHeader(k, rewriteLocation(String(v), port, publicBase, opts.prefix));
        continue;
      }
      if (injectable && (k === 'content-length' || k === 'content-encoding' || k === 'etag')) continue;
      res.setHeader(k, v as string | string[]);
    }
    res.status(status);
    if (!injectable) {
      up.pipe(res);
      return;
    }
    res.setHeader('Cache-Control', String(up.headers['cache-control'] || 'no-cache'));
    const enc = String(up.headers['content-encoding'] || '').toLowerCase();
    const body = enc === 'gzip' ? up.pipe(zlib.createGunzip()) : enc === 'br' ? up.pipe(zlib.createBrotliDecompress()) : enc === 'deflate' ? up.pipe(zlib.createInflate()) : up;
    let head = '';
    let done = false;
    const flushHead = () => {
      if (done) return;
      done = true;
      let html = opts.inject(head);
      if (opts.extraHead) html = opts.extraHead(html);
      res.write(html);
      res.flushHeaders();
    };
    body.setEncoding('utf8');
    body.on('data', (chunk: string) => {
      if (done) return void res.write(chunk);
      head += chunk;
      if (headReady(head) || head.length > MAX_HEAD_BUFFER) flushHead();
    });
    body.on('end', () => {
      flushHead();
      res.end();
    });
    body.on('error', () => res.destroy());
  });
  upstream.on('error', (e: NodeJS.ErrnoException) => {
    if (res.headersSent) return void res.destroy();
    if (e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET') markUnreachable(appId);
    if (doc) res.status(502).type('html').setHeader('Cache-Control', 'no-store').send(opts.statusPage('Starting the app…', 'The app server is not answering yet. This page refreshes on its own.', { spinner: true, refresh: true }));
    else res.status(502).type('text/plain').send(`App server unreachable (${e.code || e.message})`);
  });
  res.on('close', () => {
    if (!res.writableFinished) upstream.destroy();
  });
  if (req.method === 'GET' || req.method === 'HEAD') upstream.end();
  else req.pipe(upstream);
}

/** Tunnel a WebSocket (or other Upgrade) request to the app's server. */
export function upgradeServerApp(appId: string, req: http.IncomingMessage, socket: Duplex, head: Buffer, urlPath: string) {
  const rt = ensureRuntime(appId);
  if (rt.state !== 'running' || !rt.port) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    return;
  }
  const conn = net.connect(rt.port, '127.0.0.1', () => {
    const lines = [`${req.method} ${urlPath} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    conn.write(lines.join('\r\n') + '\r\n\r\n');
    if (head.length) conn.write(head);
    socket.pipe(conn).pipe(socket);
  });
  conn.on('error', () => socket.destroy());
  socket.on('error', () => conn.destroy());
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
