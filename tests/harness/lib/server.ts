// Starts (or reuses) an isolated ThinkAloud stack for the harness:
//   API :4820, app host :4821, Vite :5820 (VITE_NO_HMR=1), DATA_DIR=./data-harness, BUILD_MODE=local.
// Never touches the live server on :4000/:4001. Only processes started here are stopped.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CACHE_DIR, REPORTS_DIR, ROOT, keylessEnv, sleep } from './env.ts';

export const HARNESS_PORTS = { api: 4820, appHost: 4821, web: 5820 } as const;
const FORBIDDEN_PORTS = new Set(['4000', '4001']);

async function up(url: string) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(3000) })).status < 500;
  } catch {
    return false;
  }
}
async function waitUp(url: string, ms = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await up(url)) return;
    await sleep(500);
  }
  throw new Error(`${url} did not come up within ${ms / 1000}s`);
}

export interface Stack {
  /** Participant SPA + API base (Vite proxies /api). */
  base: string;
  /** Direct API base (for researcher calls). */
  api: string;
  started: boolean;
  stop(): Promise<void>;
}

export function assertNotProduction(url: string) {
  const u = new URL(url);
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  if (FORBIDDEN_PORTS.has(port) && /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/.test(u.hostname))
    throw new Error(`Refusing to run the harness against ${url}: ports 4000/4001 are the live production server.`);
  if (/trycloudflare\.com$/.test(u.hostname)) throw new Error(`Refusing to run the harness against a public tunnel (${url}).`);
}

/**
 * Export a git ref (e.g. HEAD = the committed code, before uncommitted fixes) into the harness cache
 * with `git archive` (read-only for the repo) and wire up node_modules so the workspace packages
 * (@thinkaloud/*) resolve to the exported tree. Returns the tree root.
 */
export function exportRef(ref: string): string {
  const sha = execFileSync('git', ['rev-parse', ref], { cwd: ROOT }).toString().trim();
  const dir = path.join(CACHE_DIR, 'trees', sha.slice(0, 12));
  if (!fs.existsSync(path.join(dir, '.ready'))) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('bash', ['-c', `git archive ${sha} | tar -x -C "${dir}"`], { cwd: ROOT });
    const nm = path.join(dir, 'node_modules');
    fs.mkdirSync(nm, { recursive: true });
    for (const e of fs.readdirSync(path.join(ROOT, 'node_modules'))) {
      if (e === '@thinkaloud' || e === '.vite') continue;
      fs.symlinkSync(path.join(ROOT, 'node_modules', e), path.join(nm, e));
    }
    fs.mkdirSync(path.join(nm, '@thinkaloud'));
    for (const w of ['shared', 'server', 'web', 'probe']) fs.symlinkSync(`../../${w}`, path.join(nm, '@thinkaloud', w));
    // Built probe (gitignored) is served by the API server.
    const probeDist = path.join(ROOT, 'probe/dist');
    if (fs.existsSync(probeDist)) fs.cpSync(probeDist, path.join(dir, 'probe/dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.ready'), `${ref} ${sha}\n`);
  }
  return dir;
}

export async function ensureStack(base?: string, root = ROOT): Promise<Stack> {
  if (base) {
    assertNotProduction(base);
    const b = base.replace(/\/$/, '');
    if (!(await up(`${b}/api/health`))) throw new Error(`${b}/api/health is not reachable. Start the server or omit --base to let the harness start one.`);
    return { base: b, api: b, started: false, stop: async () => {} };
  }
  const api = `http://localhost:${HARNESS_PORTS.api}`;
  const web = `http://localhost:${HARNESS_PORTS.web}`;
  const foreign = root !== ROOT;
  if (foreign && ((await up(`${api}/api/health`)) || (await up(`${web}/`))))
    throw new Error(`--ref needs a fresh stack, but :${HARNESS_PORTS.api} or :${HARNESS_PORTS.web} is already serving (stop that harness stack first).`);
  const dataDir = path.join(ROOT, foreign ? `data-harness-${path.basename(root)}` : 'data-harness');
  const procs: ChildProcess[] = [];
  fs.mkdirSync(path.join(REPORTS_DIR, 'logs'), { recursive: true });
  const logOf = (name: string) => fs.openSync(path.join(REPORTS_DIR, 'logs', `${name}.log`), 'a');
  let started = false;
  if (!(await up(`${api}/api/health`))) {
    started = true;
    const out = logOf('server');
    procs.push(
      // No --env-file: .env holds the real key. The server runs keyless (OPENAI_API_KEY='').
      spawn('npx', ['tsx', 'src/index.ts'], {
        cwd: path.join(root, 'server'),
        env: keylessEnv({
          PORT: String(HARNESS_PORTS.api),
          APP_HOST_PORT: String(HARNESS_PORTS.appHost),
          APP_HOST_URL: `http://localhost:${HARNESS_PORTS.appHost}`,
          PUBLIC_URL: web,
          DATA_DIR: dataDir,
          BUILD_MODE: 'local',
          GIT_ALLOW_SSH: '1',
          NODE_ENV: 'development',
          SESSION_SECRET: 'harness-only-secret',
        }),
        stdio: ['ignore', out, out],
        detached: true,
      }),
    );
    await waitUp(`${api}/api/health`);
  }
  if (!(await up(`${web}/`))) {
    started = true;
    const out = logOf('vite');
    procs.push(
      spawn('npx', ['vite', '--port', String(HARNESS_PORTS.web), '--strictPort'], {
        cwd: path.join(root, 'web'),
        env: keylessEnv({ PORT: String(HARNESS_PORTS.api), VITE_NO_HMR: '1' }),
        stdio: ['ignore', out, out],
        detached: true,
      }),
    );
    await waitUp(`${web}/`);
  }
  return {
    base: web,
    api,
    started,
    stop: async () => {
      for (const p of procs) {
        try {
          if (p.pid) process.kill(-p.pid, 'SIGTERM');
        } catch {
          /* already gone */
        }
      }
      await sleep(500);
    },
  };
}
