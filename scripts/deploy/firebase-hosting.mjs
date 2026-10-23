#!/usr/bin/env node
// Firebase Hosting deployer over the REST API (no `firebase login` needed).
//
//   node scripts/deploy/firebase-hosting.mjs deploy            # web/dist + /config.json + /probe.js
//   node scripts/deploy/firebase-hosting.mjs config <file>     # replace only /config.json (fast)
//   node scripts/deploy/firebase-hosting.mjs status            # print the live release
//
// Site, public dir, headers and rewrites come from firebase.json; the project from .firebaserc.
// Auth: $FIREBASE_ACCESS_TOKEN, else `gcloud auth print-access-token` (cloud-platform scope).
// The "config" command clones the live release's file list (hashes only, nothing is re-uploaded)
// and swaps in the new config.json, so a tunnel URL change goes live in a few seconds.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fb = JSON.parse(fs.readFileSync(path.join(root, 'firebase.json'), 'utf8')).hosting;
const rc = JSON.parse(fs.readFileSync(path.join(root, '.firebaserc'), 'utf8'));
const SITE = process.env.FIREBASE_SITE || fb.site;
const PROJECT = process.env.FIREBASE_PROJECT || rc.projects.default;
const API = 'https://firebasehosting.googleapis.com/v1beta1';
const GCLOUD = process.env.GCLOUD || [path.join(process.env.HOME || '', 'google-cloud-sdk/bin/gcloud'), 'gcloud'].find((p) => p === 'gcloud' || fs.existsSync(p));

let token = process.env.FIREBASE_ACCESS_TOKEN || '';
function accessToken() {
  if (!token) token = execFileSync(GCLOUD, ['auth', 'print-access-token'], { encoding: 'utf8' }).trim();
  return token;
}

async function call(method, url, body, { raw = false, contentType } = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url.startsWith('http') ? url : `${API}/${url}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken()}`,
        'x-goog-user-project': PROJECT,
        ...(body !== undefined ? { 'Content-Type': contentType || 'application/json' } : {}),
      },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    const text = await res.text();
    if (res.ok) return text ? JSON.parse(text) : {};
    if (attempt < 4 && (res.status >= 500 || res.status === 429)) {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      continue;
    }
    throw new Error(`${method} ${url} → ${res.status}: ${text.slice(0, 500)}`);
  }
}

/** firebase.json "hosting" → REST ServingConfig. */
function servingConfig() {
  const glob = (r) => (r.regex ? { regex: r.regex } : { glob: r.source });
  return {
    headers: (fb.headers || []).map((h) => ({ ...glob(h), headers: Object.fromEntries(h.headers.map((x) => [x.key, x.value])) })),
    rewrites: (fb.rewrites || []).map((r) => ({ ...glob(r), ...(r.destination ? { path: r.destination } : {}) })),
    redirects: (fb.redirects || []).map((r) => ({ ...glob(r), location: r.destination, statusCode: r.type || 301 })),
    cleanUrls: Boolean(fb.cleanUrls),
    trailingSlashBehavior: fb.trailingSlash === true ? 'ADD' : fb.trailingSlash === false ? 'REMOVE' : undefined,
  };
}

/** Minimal glob → RegExp for firebase.json "ignore" (`**`, `*`, `?`), matched against "/path". */
function globRe(g) {
  let re = '';
  const src = g.replace(/^\/?/, '/');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '*' && src[i + 1] === '*') {
      if (src[i + 2] === '/') (re += '(?:.*/)?'), (i += 2);
      else (re += '.*'), (i += 1);
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function gz(buf) {
  const z = zlib.gzipSync(buf, { level: 9 });
  return { z, hash: crypto.createHash('sha256').update(z).digest('hex') };
}

function walk(dir, ignore) {
  const out = [];
  const rec = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = '/' + path.relative(dir, p).split(path.sep).join('/');
      if (e.name.startsWith('.') || ignore.some((re) => re.test(rel))) continue;
      if (e.isDirectory()) rec(p);
      else if (e.isFile()) out.push([rel, fs.readFileSync(p)]);
    }
  };
  rec(dir);
  return out;
}

/** Create a version with `files` ({path: hash}), upload what Firebase is missing (`blobs` by hash), release it. */
async function release(files, blobs, config, message) {
  const version = await call('POST', `sites/${SITE}/versions`, { config, labels: { deployer: 'thinkaloud-rest' } });
  const entries = Object.entries(files);
  let uploadUrl = '';
  const required = new Set();
  for (let i = 0; i < entries.length; i += 1000) {
    const r = await call('POST', `${version.name}:populateFiles`, { files: Object.fromEntries(entries.slice(i, i + 1000)) });
    uploadUrl = r.uploadUrl || uploadUrl;
    for (const h of r.uploadRequiredHashes || []) required.add(h);
  }
  const queue = [...required];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let h; (h = queue.shift()); ) {
        const blob = blobs.get(h);
        if (!blob) throw new Error(`Firebase asked for unknown hash ${h}`);
        await call('POST', `${uploadUrl}/${h}`, blob, { raw: true, contentType: 'application/octet-stream' });
      }
    }),
  );
  await call('PATCH', `${version.name}?update_mask=status`, { status: 'FINALIZED' });
  const rel = await call('POST', `sites/${SITE}/releases?versionName=${encodeURIComponent(version.name)}`, { message });
  return { version: version.name, uploaded: required.size, files: entries.length, release: rel.name };
}

async function liveVersion() {
  const ch = await call('GET', `sites/${SITE}/channels/live`);
  if (!ch.release?.version?.name) throw new Error('No live release yet: run a full deploy first.');
  return ch.release.version;
}

async function liveFiles(versionName) {
  const files = {};
  let pageToken = '';
  do {
    const r = await call('GET', `${versionName}/files?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
    for (const f of r.files || []) if (!f.path.startsWith('/__/')) files[f.path] = f.hash; // /__/ is Firebase-reserved
    pageToken = r.nextPageToken || '';
  } while (pageToken);
  return files;
}

function extraFile(rel, buf, files, blobs) {
  const { z, hash } = gz(buf);
  files[rel] = hash;
  blobs.set(hash, z);
}

const configFile = () => process.env.RUNTIME_CONFIG || path.join(root, 'data/deploy/config.json');

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'deploy') {
    const pub = path.resolve(root, process.env.HOSTING_PUBLIC || fb.public);
    if (!fs.existsSync(path.join(pub, 'index.html'))) throw new Error(`${pub}/index.html missing: run npm run build first`);
    const ignore = (fb.ignore || []).map(globRe);
    const files = {};
    const blobs = new Map();
    for (const [rel, buf] of walk(pub, ignore)) extraFile(rel, buf, files, blobs);
    // Runtime config (where the API is) and the probe bundle for snippet installs.
    const cfg = fs.existsSync(configFile()) ? fs.readFileSync(configFile()) : Buffer.from('{}\n');
    if (files['/config.json'] === undefined) extraFile('/config.json', cfg, files, blobs);
    const probe = path.join(root, 'probe/dist/probe.js');
    if (fs.existsSync(probe)) extraFile('/probe.js', fs.readFileSync(probe), files, blobs);
    const r = await release(files, blobs, servingConfig(), `web deploy ${new Date().toISOString()}`);
    console.log(`Deployed ${r.files} files (${r.uploaded} uploaded) to https://${SITE}.web.app  [${r.version}]`);
  } else if (cmd === 'config') {
    const buf = fs.readFileSync(arg || configFile());
    JSON.parse(buf.toString('utf8')); // refuse to publish broken JSON
    const live = await liveVersion();
    const files = await liveFiles(live.name);
    const blobs = new Map();
    const before = files['/config.json'];
    extraFile('/config.json', buf, files, blobs);
    if (before === files['/config.json'] && !process.env.FORCE) return console.log('config.json unchanged; nothing to deploy');
    const r = await release(files, blobs, live.config || servingConfig(), `config.json ${new Date().toISOString()}`);
    console.log(`Published config.json (${r.files} files, ${r.uploaded} uploaded) to https://${SITE}.web.app  [${r.version}]`);
  } else if (cmd === 'status') {
    const live = await liveVersion();
    console.log(JSON.stringify({ site: SITE, project: PROJECT, url: `https://${SITE}.web.app`, version: live.name, status: live.status, fileCount: live.fileCount, finalizeTime: live.finalizeTime }, null, 2));
  } else {
    console.error('usage: firebase-hosting.mjs deploy | config [file] | status');
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(String(e?.stack || e));
  process.exit(1);
});
