// Security regression tests: researcher endpoints check ownership, participant endpoints need the
// session secret, and the app host never serves files outside an app's dist/.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-security-test-'));
process.env.DATA_DIR = dataDir;
process.env.OPENAI_API_KEY = ''; // never call OpenAI from unit tests

let api: http.Server;
let appHost: http.Server;
let base = '';
let hostPort = 0;
let db: typeof import('./db.ts').db;
let paths: typeof import('./lib/paths.ts').paths;

function listen(app: http.RequestListener): Promise<http.Server> {
  return new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

before(async () => {
  const { createApp } = await import('./app.ts');
  const { createAppHost } = await import('./apphost/server.ts');
  ({ db } = await import('./db.ts'));
  ({ paths } = await import('./lib/paths.ts'));
  api = await listen(createApp());
  appHost = await listen(createAppHost());
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  hostPort = (appHost.address() as AddressInfo).port;
});
after(() => {
  api?.close();
  appHost?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Minimal client with its own cookie jar. */
function client() {
  let cookie = '';
  return async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json };
  };
}

function rawGet(port: number, host: string, rawPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET', headers: { host } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

let owner: ReturnType<typeof client>;
let studyId = '';
let sessionId = '';
let secret = '';
let appId = '';
let detail: any;

test('setup: owner creates a live study and a participant session', async () => {
  owner = client();
  assert.ok((await owner('POST', '/api/auth/signup', { email: 'owner@example.com', password: 'password123', name: 'Owner' })).status < 300);
  const s = await owner('POST', '/api/studies', { name: 'Private study', template: 'starter' });
  studyId = s.json.study.id;
  // A hosted app with a ready build (created directly; building is covered elsewhere).
  appId = 'app_sectest1';
  const now = Date.now();
  db.prepare(
    `INSERT INTO apps (id, study_id, name, source_kind, source_url, framework, status, error, url, instrumented, created_at, updated_at)
     VALUES (?, ?, 'Shop', 'upload', NULL, 'static', 'ready', NULL, ?, 1, ?, ?)`,
  ).run(appId, studyId, 'http://app-sectest1.localhost/', now, now);
  const dist = paths.appDist(appId);
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body>shop</body></html>');
  fs.writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.log(1)');
  fs.writeFileSync(paths.appLog(appId), 'BUILD LOG SECRET');
  fs.mkdirSync(paths.appSource(appId), { recursive: true });
  fs.writeFileSync(path.join(paths.appSource(appId), 'secret.txt'), 'SOURCE SECRET');
  fs.symlinkSync(paths.appSource(appId), path.join(dist, 'linked'));
  fs.symlinkSync(path.join(paths.appSource(appId), 'secret.txt'), path.join(dist, 'leak.txt'));

  detail = (await owner('GET', `/api/studies/${studyId}`)).json;
  assert.equal((await owner('PATCH', `/api/variants/${detail.variants[0].id}`, { appId })).status, 200);
  const live = await owner('PATCH', `/api/studies/${studyId}`, { status: 'live' });
  assert.equal(live.status, 200, JSON.stringify(live.json));
  const anon = client();
  const start = await anon('POST', `/api/p/links/${detail.links[0].token}/sessions`, {
    urlParams: {},
    device: { userAgent: 'test', viewportW: 1, viewportH: 1, screenW: 1, screenH: 1, dpr: 1, timezone: 'UTC', language: 'en' },
    consent: { version: '1', acceptedAt: Date.now(), audio: true, screen: true, eyeTracking: false, ageConfirmed: true },
  });
  assert.equal(start.status, 201, JSON.stringify(start.json));
  sessionId = start.json.session.id;
  secret = start.json.secret;
  assert.equal(start.json.session.secret, undefined, 'session secret must not be echoed inside the session object');
  const begin = await anon('POST', `/api/p/sessions/${sessionId}/begin`, {}, { 'X-Session-Secret': secret });
  assert.equal(begin.status, 200);
  const rr = await anon('POST', `/api/p/sessions/${sessionId}/rrweb?seq=1`, { events: [{ type: 4, timestamp: 1, data: {} }] }, { 'X-Session-Secret': secret });
  assert.equal(rr.status, 200);
});

test('a second account gets 403/404 on every researcher endpoint of another account', async () => {
  const intruder = client();
  assert.ok((await intruder('POST', '/api/auth/signup', { email: 'intruder@example.com', password: 'password123', name: 'Intruder' })).status < 300);
  const pid = detail.protocols[0].id;
  const vid = detail.variants[0].id;
  const lid = detail.links[0].id;
  const note = await owner('POST', `/api/sessions/${sessionId}/notes`, { t: 0, text: 'mine', tags: [] });
  assert.equal(note.status, 200);
  const nid = note.json.note.id;
  const checks: [string, string, unknown?][] = [
    ['GET', `/api/studies/${studyId}`],
    ['PATCH', `/api/studies/${studyId}`, { name: 'pwned' }],
    ['POST', `/api/studies/${studyId}/protocols`, { name: 'x' }],
    ['PUT', `/api/protocols/${pid}`, { protocol: detail.protocols[0].protocol }],
    ['POST', `/api/protocols/${pid}/duplicate`],
    ['POST', `/api/studies/${studyId}/variants`, { name: 'X', protocolId: pid }],
    ['PATCH', `/api/variants/${vid}`, { weight: 9 }],
    ['POST', `/api/studies/${studyId}/links`, { name: 'x' }],
    ['PATCH', `/api/links/${lid}`, { name: 'x' }],
    ['GET', `/api/studies/${studyId}/preview-url`],
    ['GET', `/api/studies/${studyId}/apps`],
    ['POST', `/api/studies/${studyId}/apps`, { name: 'x', url: 'https://example.com' }],
    ['GET', `/api/apps/${appId}`],
    ['GET', `/api/apps/${appId}/log`],
    ['POST', `/api/apps/${appId}/rebuild`],
    ['PATCH', `/api/apps/${appId}`, { name: 'x' }],
    ['GET', `/api/apps/${appId}/snippet`],
    ['GET', `/api/studies/${studyId}/analytics`],
    ['GET', `/api/studies/${studyId}/sessions`],
    ['GET', `/api/studies/${studyId}/heatmap?kind=click`],
    ['GET', `/api/studies/${studyId}/synthesis`],
    ['POST', `/api/studies/${studyId}/synthesis`],
    ['GET', `/api/studies/${studyId}/export?format=csv&table=sessions`],
    ['GET', `/api/studies/${studyId}/export?format=json&table=events`],
    ['GET', `/api/studies/${studyId}/consent`],
    ['PUT', `/api/studies/${studyId}/consent`, { text: 'pwned' }],
    ['GET', `/api/studies/${studyId}/consent/document`],
    ['DELETE', `/api/studies/${studyId}/consent/document`],
    ['POST', `/api/studies/${studyId}/consent/check`, {}],
    ['POST', `/api/studies/${studyId}/consent/rewrite`, { text: 'x'.repeat(40) }],
    ['GET', `/api/studies/${studyId}/demographics`],
    ['GET', `/api/sessions/${sessionId}`],
    ['GET', `/api/sessions/${sessionId}/replay`],
    ['GET', `/api/sessions/${sessionId}/audio?track=mixed`],
    ['GET', `/api/sessions/${sessionId}/points?kind=mouse`],
    ['PUT', `/api/sessions/${sessionId}/tasks/x`, { outcome: 'failure' }],
    ['POST', `/api/sessions/${sessionId}/notes`, { t: 0, text: 'x', tags: [] }],
    ['PATCH', `/api/notes/${nid}`, { text: 'changed' }],
    ['DELETE', `/api/notes/${nid}`],
    ['DELETE', `/api/sessions/${sessionId}`],
    ['DELETE', `/api/links/${lid}`],
    ['DELETE', `/api/variants/${vid}`],
    ['DELETE', `/api/protocols/${pid}`],
    ['DELETE', `/api/apps/${appId}`],
    ['DELETE', `/api/studies/${studyId}`],
  ];
  const anon = client();
  const leaks: string[] = [];
  for (const [method, url, body] of checks) {
    const r = await intruder(method, url, body);
    if (r.status !== 403 && r.status !== 404) leaks.push(`${method} ${url} → ${r.status}`);
    const a = await anon(method, url, body);
    if (![401, 403, 404].includes(a.status)) leaks.push(`anonymous ${method} ${url} → ${a.status}`);
  }
  assert.deepEqual(leaks, []);
  // Preview of someone else's draft/live study is refused.
  const pv = await intruder('POST', `/api/p/links/${detail.links[0].token}/sessions`, {
    preview: true,
    variantId: vid,
    device: { userAgent: 'x', viewportW: 1, viewportH: 1, screenW: 1, screenH: 1, dpr: 1, timezone: 'UTC', language: 'en' },
    consent: { version: '1', acceptedAt: Date.now(), audio: true, screen: true, eyeTracking: false, ageConfirmed: true },
  });
  assert.equal(pv.status, 403);
  assert.deepEqual((await intruder('GET', '/api/studies')).json.studies, []);
  // Nothing changed for the owner.
  const after = (await owner('GET', `/api/studies/${studyId}`)).json;
  assert.equal(after.study.name, 'Private study');
  assert.equal(after.variants[0].weight, detail.variants[0].weight);
  assert.equal((await owner('GET', `/api/sessions/${sessionId}`)).json.notes[0].text, 'mine');
});

test('participant endpoints require the matching session secret', async () => {
  const anon = client();
  const calls: [string, unknown][] = [
    [`/api/p/sessions/${sessionId}/begin`, {}],
    [`/api/p/sessions/${sessionId}/events`, { events: [] }],
    [`/api/p/sessions/${sessionId}/rrweb?seq=2`, { events: [] }],
    [`/api/p/sessions/${sessionId}/audio?seq=2&track=mixed`, {}],
    [`/api/p/sessions/${sessionId}/realtime-token`, {}],
    [`/api/p/sessions/${sessionId}/complete`, { status: 'abandoned' }],
    [`/api/p/sessions/${sessionId}/withdraw`, {}],
  ];
  // Another session's secret must not work either.
  const other = await anon('POST', `/api/p/links/${detail.links[0].token}/sessions`, {
    device: { userAgent: 'x', viewportW: 1, viewportH: 1, screenW: 1, screenH: 1, dpr: 1, timezone: 'UTC', language: 'en' },
    consent: { version: '1', acceptedAt: Date.now(), audio: true, screen: true, eyeTracking: false, ageConfirmed: true },
  });
  assert.equal(other.status, 201);
  for (const [url, body] of calls) {
    for (const headers of [{}, { 'X-Session-Secret': 'wrong' }, { 'X-Session-Secret': other.json.secret }, { 'X-Session-Secret': secret + 'x' }] as Record<string, string>[]) {
      const r = await anon('POST', url, body, headers);
      assert.equal(r.status, 403, `${url} ${JSON.stringify(headers)} → ${r.status}`);
    }
    const q = await anon('POST', `${url}${url.includes('?') ? '&' : '?'}secret=wrong`, body);
    assert.equal(q.status, 403, `${url} ?secret=wrong → ${q.status}`);
  }
  const row = db.prepare('SELECT status FROM sessions WHERE id = ?').get(sessionId) as { status: string };
  assert.equal(row.status, 'in_progress');
});

test('the app host only serves files inside dist/', async () => {
  const host = `app-sectest1.localhost:${hostPort}`;
  const ok = await rawGet(hostPort, host, '/assets/app.js');
  assert.equal(ok.status, 200);
  assert.match(ok.body, /console\.log/);
  const index = await rawGet(hostPort, host, '/some/spa/route');
  assert.equal(index.status, 200);
  assert.match(index.body, /__thinkaloud\/probe\.js/);
  const attempts = [
    '/../build.log',
    '/..%2fbuild.log',
    '/%2e%2e/build.log',
    '/%2e%2e%2fbuild.log',
    '/..%5cbuild.log',
    '/%252e%252e%252fbuild.log',
    '/..%2f..%2f..%2fthinkaloud.db',
    '/..%2fsource%2fsecret.txt',
    '/assets/..%2f..%2fsource%2fsecret.txt',
    '/linked/secret.txt',
    '/leak.txt',
    '/%00../build.log',
    '/..%2f..%2f..%2f..%2f..%2f..%2f..%2f..%2fetc%2fpasswd',
  ];
  const leaks: string[] = [];
  for (const p of attempts) {
    for (const [h, prefix] of [
      [host, ''],
      [`localhost:${hostPort}`, `/a/${appId}`],
    ] as const) {
      const r = await rawGet(hostPort, h, prefix + p);
      if (/SECRET|SQLite format|root:x:0:0/.test(r.body)) leaks.push(`${h}${prefix}${p} → ${r.status}`);
    }
  }
  assert.deepEqual(leaks, []);
  // Unknown app ids and ids that are not valid labels are not served.
  assert.equal((await rawGet(hostPort, `app-nope.localhost:${hostPort}`, '/')).status, 404);
  assert.equal((await rawGet(hostPort, `localhost:${hostPort}`, '/a/..%2f/')).status, 404);
});

test('CSRF guard refuses cross-origin state-changing researcher requests', async () => {
  const { sameOriginGuard } = await import('./lib/guards.ts');
  const run = (method: string, path: string, origin?: string) =>
    new Promise<unknown>((resolve) =>
      sameOriginGuard(
        { method, path, headers: origin ? { origin } : {}, protocol: 'http', get: () => 'localhost:4000' } as never,
        {} as never,
        (err?: unknown) => resolve(err),
      ),
    );
  assert.ok(await run('POST', '/studies', 'http://app-x.localhost:4001'), 'hosted app origin must be refused');
  assert.equal(await run('POST', '/studies', 'http://localhost:4000'), undefined);
  assert.equal(await run('GET', '/studies', 'http://evil.example'), undefined);
  assert.equal(await run('POST', '/p/sessions/x/events', 'http://app-x.localhost:4001'), undefined);
  assert.equal(await run('POST', '/studies'), undefined);
});

// ── Billing (SaaS mode) ──────────────────────────────────────────────────────

/** Run fn with billing switched on (config is read from env at call time). */
async function withBilling(fn: () => Promise<void>) {
  const saved = { ...process.env };
  process.env.STRIPE_SECRET_KEY = 'sk_test_security_never_sent';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_security';
  process.env.BILLING_PLANS = JSON.stringify({
    plans: [{ id: 'pro', name: 'Pro', monthlyPriceCents: 100, includedMinutes: 1, overageCentsPerMinute: 1, stripeBasePriceId: 'price_secret_base', stripeMeteredPriceId: 'price_secret_meter' }],
  });
  try {
    await fn();
  } finally {
    for (const k of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'BILLING_PLANS']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('billing endpoints require sign-in and refuse cross-origin writes', async () => {
  const anon = client();
  for (const [m, u, b] of [['GET', '/api/billing'], ['POST', '/api/billing/checkout', { planId: 'pro' }], ['POST', '/api/billing/portal'], ['POST', '/api/billing/end-trial'], ['PATCH', '/api/billing/settings', { spendCapCents: null }]] as [string, string, unknown?][]) {
    assert.equal((await anon(m, u, b)).status, 401, `${m} ${u}`);
  }
  await withBilling(async () => {
    for (const [m, u, b] of [['POST', '/api/billing/checkout', { planId: 'pro' }], ['POST', '/api/billing/portal'], ['PATCH', '/api/billing/settings', { spendCapCents: 500 }]] as [string, string, unknown?][]) {
      const r = await owner(m, u, b, { Origin: 'http://app-x.localhost:4001' });
      assert.equal(r.status, 403, `cross-origin ${m} ${u} → ${r.status}`);
    }
    const ov = await owner('GET', '/api/billing');
    assert.equal(ov.status, 200);
    assert.equal(ov.json.spendCapCents, null, 'the cross-origin write did not apply');
  });
});

test('the Stripe webhook is exempt from the origin guard but needs a valid signature', async () => {
  const { sameOriginGuard } = await import('./lib/guards.ts');
  const err = await new Promise<unknown>((resolve) =>
    sameOriginGuard({ method: 'POST', path: '/billing/webhook', headers: { origin: 'https://evil.example' }, protocol: 'http', get: () => 'localhost:4000' } as never, {} as never, (e?: unknown) => resolve(e)),
  );
  assert.equal(err, undefined);
  const post = (headers: Record<string, string>, body: string) => fetch(`${base}/api/billing/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  // Billing off: the endpoint doesn't exist.
  assert.equal((await post({}, '{}')).status, 404);
  await withBilling(async () => {
    const evt = JSON.stringify({ id: 'evt_forged', type: 'customer.subscription.updated', created: 1, data: { object: { id: 'sub_x', customer: 'cus_x', status: 'active', metadata: { user_id: 'x' }, items: { data: [] } } } });
    for (const sig of [undefined, 't=1,v1=00', `t=${Math.floor(Date.now() / 1000)},v1=${'a'.repeat(64)}`]) {
      const r = await post(sig ? { 'Stripe-Signature': sig, Origin: 'https://evil.example' } : {}, evt);
      assert.equal(r.status, 400, `signature ${sig}`);
    }
    // Signed with the wrong secret.
    const { default: Stripe } = await import('stripe');
    const wrong = Stripe.webhooks.generateTestHeaderString({ payload: evt, secret: 'whsec_attacker' });
    assert.equal((await post({ 'Stripe-Signature': wrong }, evt)).status, 400);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM stripe_events").get()!.n, 0);
  });
});

test('public billing data never includes secrets or Stripe price IDs', async () => {
  await withBilling(async () => {
    const r = await client()('GET', '/api/billing/plans');
    assert.equal(r.status, 200);
    assert.equal(r.json.enabled, true);
    const text = JSON.stringify(r.json);
    assert.doesNotMatch(text, /sk_test|whsec|price_secret/);
    const mine = JSON.stringify((await owner('GET', '/api/billing')).json);
    assert.doesNotMatch(mine, /sk_test|whsec|price_secret|cus_/);
  });
  // The web client never references the secret key.
  const webSrc = path.resolve(import.meta.dirname, '../../web/src');
  const files = fs.readdirSync(webSrc, { recursive: true, withFileTypes: true }).filter((f) => f.isFile() && /\.(tsx?|css)$/.test(f.name));
  for (const f of files) {
    const body = fs.readFileSync(path.join(f.parentPath, f.name), 'utf8');
    assert.doesNotMatch(body, /STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|sk_live_|sk_test_/, f.name);
  }
});

test('billing off (self-hosted): publishing and sessions are unlimited', async () => {
  const { entitlement } = await import('./billing/account.ts');
  assert.deepEqual(entitlement('anyone'), { canRunSessions: true, blockReason: null });
  assert.equal((await client()('GET', `/api/p/links/${detail.links[0].token}`)).json.unavailableReason, undefined);
});
