#!/usr/bin/env node
// Keeps the public front end (Firebase Hosting) and the server in step with the Cloudflare tunnels.
//
// Every few seconds:
//   1. Read each tunnel's public hostname from cloudflared's metrics endpoint (/quicktunnel), or use
//      fixed URLs (API_URL / APPS_URL) when running behind a named tunnel.
//   2. Write data/deploy/runtime.env (PUBLIC_URL, APP_HOST_URL, APP_HOST_ROUTING, CORS_ORIGINS), which
//      thinkaloud.service loads. Restart the server only when its live APP_HOST_URL (/api/health)
//      differs: the API tunnel URL is not part of the server's config, so an API-only change needs no restart.
//   3. Once the API answers through its public URL, publish /config.json ({apiBase, appHostUrl}) to
//      Firebase Hosting (config-only release, a few seconds).
//
//   node scripts/deploy/tunnel-sync.mjs           # daemon (thinkaloud-sync.service)
//   node scripts/deploy/tunnel-sync.mjs --once    # one pass, then exit (status code 0 = in sync)
//
// Settings (env, or data/deploy/deploy.env via the unit): WEB_URL, EXTRA_CORS_ORIGINS, API_METRICS,
// APPS_METRICS, API_URL, APPS_URL, APP_HOST_ROUTING, SERVER_URL, SERVER_UNIT, SYNC_INTERVAL_MS.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const env = process.env;
const WEB_URL = (env.WEB_URL || 'https://thinkaloud-app.web.app').replace(/\/$/, '');
const CORS = [WEB_URL, WEB_URL.replace(/\.web\.app$/, '.firebaseapp.com'), ...(env.EXTRA_CORS_ORIGINS || '').split(',')]
  .map((s) => s.trim())
  .filter(Boolean);
const API_METRICS = env.API_METRICS || '127.0.0.1:20251';
const APPS_METRICS = env.APPS_METRICS || '127.0.0.1:20252';
// Optional third tunnel for a self-hosted OpenRealtime server (thinkaloud-tunnel-realtime.service).
const REALTIME = env.SYNC_REALTIME === '1';
const RT_METRICS = env.RT_METRICS || '127.0.0.1:20253';
const ROUTING = env.APP_HOST_ROUTING || (env.APPS_URL ? 'subdomain' : 'path'); // quick tunnels have no wildcard DNS
const SERVER_URL = env.SERVER_URL || `http://127.0.0.1:${env.PORT || 4000}`;
const SERVER_UNIT = env.SERVER_UNIT || 'thinkaloud.service';
const INTERVAL = Number(env.SYNC_INTERVAL_MS || 5000);
const dir = path.join(root, 'data/deploy');
const ENV_FILE = path.join(dir, 'runtime.env');
const CONFIG_FILE = path.join(dir, 'config.json');
const STATE_FILE = path.join(dir, 'sync-state.json');
const once = process.argv.includes('--once');

const log = (...a) => console.log(new Date().toISOString(), ...a);
const readJson = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return d;
  }
};
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

async function getJson(url, ms = 4000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

async function tunnelUrl(fixed, metrics) {
  if (fixed) return fixed.replace(/\/$/, '');
  try {
    const { hostname } = await getJson(`http://${metrics}/quicktunnel`, 2000);
    return hostname ? `https://${hostname}` : null;
  } catch {
    return null;
  }
}

let state = readJson(STATE_FILE, { published: null, lastRestart: 0 });
let pendingSince = 0;

async function pass() {
  const api = await tunnelUrl(env.API_URL, API_METRICS);
  const apps = await tunnelUrl(env.APPS_URL, APPS_METRICS);
  const rt = REALTIME ? await tunnelUrl(env.REALTIME_URL, RT_METRICS) : null;
  if (!api || !apps || (REALTIME && !rt)) {
    log(`waiting for tunnels (api=${api || '–'}, apps=${apps || '–'}${REALTIME ? `, realtime=${rt || '–'}` : ''})`);
    return false;
  }
  const rtPublic = rt ? `${rt}/v1` : null;

  // 1. Server env.
  const runtimeEnv =
    `# Written by scripts/deploy/tunnel-sync.mjs. Do not edit: it is rewritten whenever a tunnel URL changes.\n` +
    `PUBLIC_URL=${WEB_URL}\nAPP_HOST_URL=${apps}\nAPP_HOST_ROUTING=${ROUTING}\nCORS_ORIGINS=${CORS.join(',')}\n` +
    (rtPublic ? `REALTIME_PUBLIC_URL=${rtPublic}\n` : '') +
    `# Informational (not read by the server): the API's current public URL.\nAPI_PUBLIC_URL=${api}\n`;
  const current = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  if (current !== runtimeEnv) {
    writeAtomic(ENV_FILE, runtimeEnv);
    log(`wrote ${path.relative(root, ENV_FILE)}: APP_HOST_URL=${apps} (api ${api})`);
  }

  // 2. Restart the server only if it runs with a different APP_HOST_URL.
  let health = null;
  try {
    health = await getJson(`${SERVER_URL}/api/health`);
  } catch {
    log('server not answering yet');
    return false;
  }
  if (health.appHostUrl !== apps || (rtPublic && health.realtimeUrl !== rtPublic)) {
    if (Date.now() - state.lastRestart < 30_000) return false; // just restarted; give it time
    log(`server runs APP_HOST_URL=${health.appHostUrl} realtime=${health.realtimeUrl}; restarting ${SERVER_UNIT}`);
    state.lastRestart = Date.now();
    writeAtomic(STATE_FILE, JSON.stringify(state, null, 2));
    try {
      await run('systemctl', ['--user', 'restart', SERVER_UNIT]);
    } catch (e) {
      log(`restart failed: ${e.message}`);
    }
    return false;
  }

  // 3. Runtime config for the hosted front end.
  const want = { apiBase: api, appHostUrl: apps };
  if (state.published?.apiBase === want.apiBase && state.published?.appHostUrl === want.appHostUrl) return true;
  // Publish once the API answers on its public URL (new quick tunnel hostnames take a few seconds to
  // resolve). After 90 s publish anyway: the front end is broken until we do.
  if (!pendingSince) pendingSince = Date.now();
  let reachable = false;
  try {
    reachable = (await getJson(`${api}/api/health`, 8000)).appHostUrl === apps;
  } catch {
    /* not yet */
  }
  if (!reachable && Date.now() - pendingSince < 90_000) {
    log(`waiting for ${api} to answer publicly`);
    return false;
  }
  const cfg = { ...want, updatedAt: new Date().toISOString() };
  writeAtomic(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
  try {
    const { stdout } = await run(process.execPath, [path.join(root, 'scripts/deploy/firebase-hosting.mjs'), 'config', CONFIG_FILE], { cwd: root, timeout: 120_000 });
    log(stdout.trim());
    state.published = cfg;
    pendingSince = 0;
    writeAtomic(STATE_FILE, JSON.stringify(state, null, 2));
    log(`front end ${WEB_URL} now uses API ${api} and app host ${apps}${reachable ? '' : ' (API was not yet reachable publicly)'}`);
    return true;
  } catch (e) {
    log(`config.json publish failed (will retry): ${(e.stderr || e.message || '').toString().trim().slice(0, 400)}`);
    return false;
  }
}

if (once) {
  process.exit((await pass()) ? 0 : 1);
}
log(`tunnel-sync: web ${WEB_URL}, api metrics ${API_METRICS}, apps metrics ${APPS_METRICS}, routing ${ROUTING}`);
for (;;) {
  try {
    await pass();
  } catch (e) {
    log(`sync error: ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, INTERVAL));
}
