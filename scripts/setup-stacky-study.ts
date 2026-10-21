// Creates the Stacky Social formative study (examples/stacky/protocol.json) on a
// running ThinkAloud server: account → study → app build from git → protocol →
// A/B variants → link → live.
//
//   npx tsx scripts/setup-stacky-study.ts \
//     [--url http://localhost:4000] [--email you@x.dev --password ...] \
//     [--git git@github.com:stacky-social/client.git] [--zip path/to/client.zip] \
//     [--b-params "flags=replyContributions:0"]
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce<[string, string][]>((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] ?? '']] : acc), []),
);
const BASE = (args.url || 'http://localhost:4000').replace(/\/$/, '');
const EMAIL = args.email || 'demo@thinkaloud.dev';
const PASSWORD = args.password || 'demo12345';
const GIT = args.git || 'git@github.com:stacky-social/client.git';
const B_PARAMS = args['b-params'] ?? 'flags=replyContributions:0';

let cookie = '';
async function call<T>(method: string, url: string, body?: unknown, raw?: BodyInit): Promise<T> {
  const res = await fetch(BASE + url, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${data.error ?? text} ${data.details ? JSON.stringify(data.details) : ''}`);
  return data as T;
}

async function main() {
  try {
    await call('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
  } catch {
    await call('POST', '/api/auth/signup', { email: EMAIL, password: PASSWORD, name: 'Stacky researcher' });
  }
  const { study } = await call<{ study: { id: string } }>('POST', '/api/studies', {
    name: 'Stacky Social — related posts & AI provenance',
    description: 'Formative usability study from BACKEND_INTEGRATION_AND_STUDY_PLAN.md (stacky-social/client).',
    template: 'blank',
  });
  console.log('study', study.id);

  // App build: zip upload if given, else git (SSH works when the host has a key with access).
  let app: { id: string; status: string; error?: string; url?: string };
  if (args.zip) {
    const form = new FormData();
    form.append('name', 'Stacky Social client');
    form.append('file', new Blob([fs.readFileSync(args.zip)]), path.basename(args.zip));
    app = (await call<{ app: typeof app }>('POST', `/api/studies/${study.id}/apps`, undefined, form)).app;
  } else {
    app = (await call<{ app: typeof app }>('POST', `/api/studies/${study.id}/apps`, { name: 'Stacky Social client', gitUrl: GIT })).app;
  }
  process.stdout.write(`building ${app.id} `);
  for (let i = 0; i < 180 && app.status !== 'ready' && app.status !== 'failed'; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    app = (await call<{ app: typeof app }>('GET', `/api/apps/${app.id}`)).app;
    process.stdout.write('.');
  }
  console.log(` ${app.status} ${app.url ?? app.error ?? ''}`);
  if (app.status !== 'ready') throw new Error(`Build did not finish: see ${BASE}/api/apps/${app.id}/log`);

  const detail = await call<{ protocols: { id: string }[]; variants: { id: string }[]; links: { id: string; url: string }[] }>('GET', `/api/studies/${study.id}`);
  const protocol = JSON.parse(fs.readFileSync(path.resolve('examples/stacky/protocol.json'), 'utf8'));
  const pid = detail.protocols[0].id;
  await call('PUT', `/api/protocols/${pid}`, { name: 'Stacky formative v1', protocol });

  const [a] = detail.variants;
  await call('PATCH', `/api/variants/${a.id}`, { name: 'A — default condition', appId: app.id, appParams: '' });
  await call('POST', `/api/studies/${study.id}/variants`, { name: 'B — alternate condition', protocolId: pid, appId: app.id, weight: 1, appParams: B_PARAMS });

  await call('PATCH', `/api/studies/${study.id}`, { status: 'live' });
  const link = (await call<{ links: { url: string }[] }>('GET', `/api/studies/${study.id}`)).links[0];
  console.log(`\nLive. Participant link: ${link.url}\nDashboard: ${BASE}/studies/${study.id}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
