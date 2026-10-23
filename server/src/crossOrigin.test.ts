// Cross-origin front end (e.g. Firebase Hosting → API tunnel): CORS for configured origins only,
// bearer-token auth instead of third-party cookies, and the CSRF guard still holds for cookies.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-cors-test-'));
process.env.DATA_DIR = dataDir;
process.env.OPENAI_API_KEY = ''; // never call OpenAI from unit tests
const WEB = 'https://thinkaloud-test.web.app';
process.env.PUBLIC_URL = WEB;
process.env.CORS_ORIGINS = 'https://thinkaloud-test.firebaseapp.com';

let api: http.Server;
let base = '';

before(async () => {
  const { createApp } = await import('./app.ts');
  api = await new Promise((resolve) => {
    const s = http.createServer(createApp());
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});
after(() => {
  api?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const req = (method: string, url: string, headers: Record<string, string> = {}, body?: unknown) =>
  fetch(base + url, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

test('CORS preflight is answered for configured front-end origins only, without credentials', async () => {
  for (const origin of [WEB, 'https://thinkaloud-test.firebaseapp.com']) {
    const r = await req('OPTIONS', '/api/p/sessions/x/realtime-token', { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-session-secret,content-type' });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-allow-origin'), origin);
    assert.match(r.headers.get('access-control-allow-headers') || '', /Authorization/);
    assert.match(r.headers.get('access-control-allow-headers') || '', /X-Session-Secret/);
    assert.equal(r.headers.get('access-control-allow-credentials'), null);
  }
  const evil = await req('OPTIONS', '/api/studies', { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
});

test('login/signup return a bearer token that authenticates cross-origin requests', async () => {
  const s = await req('POST', '/api/auth/signup', { Origin: WEB }, { name: 'X', email: 'cors@example.com', password: 'password123' });
  assert.equal(s.status, 201);
  assert.equal(s.headers.get('access-control-allow-origin'), WEB);
  const { token } = (await s.json()) as { token: string };
  assert.match(token, /^[0-9a-f]{64}$/);
  const me = await req('GET', '/api/auth/me', { Origin: WEB, Authorization: `Bearer ${token}` });
  assert.equal(me.status, 200);
  const create = await req('POST', '/api/studies', { Origin: WEB, Authorization: `Bearer ${token}` }, { name: 'Cross-origin study' });
  assert.equal(create.status, 201, 'bearer request from the configured origin passes the CSRF guard');
  const login = await req('POST', '/api/auth/login', { Origin: WEB }, { email: 'cors@example.com', password: 'password123' });
  const t2 = ((await login.json()) as { token: string }).token;
  assert.ok(t2 && t2 !== token);
  await req('POST', '/api/auth/logout', { Origin: WEB, Authorization: `Bearer ${t2}` });
  assert.equal((await req('GET', '/api/auth/me', { Authorization: `Bearer ${t2}` })).status, 401, 'logout revokes the bearer token');
  assert.equal((await req('GET', '/api/auth/me', { Authorization: 'Bearer nope' })).status, 401);
});

test('cookie requests from unknown origins are still refused; the configured front end is allowed', async () => {
  const s = await req('POST', '/api/auth/signup', {}, { name: 'Y', email: 'cookie@example.com', password: 'password123' });
  const cookie = (s.headers.get('set-cookie') || '').split(';')[0];
  assert.equal((await req('POST', '/api/studies', { cookie, Origin: 'https://evil.example' }, { name: 'x' })).status, 403);
  assert.equal((await req('POST', '/api/studies', { cookie, Origin: WEB }, { name: 'x' })).status, 201);
});

test('cross-origin pagehide beacons (text/plain JSON) reach the participant API', async () => {
  const r = await fetch(`${base}/api/p/sessions/ses_missing/events?secret=x`, { method: 'POST', headers: { 'Content-Type': 'text/plain', Origin: WEB }, body: JSON.stringify({ events: [] }) });
  assert.equal(r.status, 403, 'parsed and rejected for the bad secret, not a 400/415');
});
