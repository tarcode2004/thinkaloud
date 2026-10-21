// Server-app runtime: apps that need a running server (Next.js SSR / route handlers, Remix, Nuxt,
// any `npm start` app) run in a long-lived container (BUILD_MODE=docker) or a child process
// (BUILD_MODE=local) on an internal port; the app host reverse-proxies app-<id>.<host> to it.
// Containers are started lazily (on API boot and on the first request), restarted by Docker
// (`--restart unless-stopped`), and removed when the app is rebuilt or deleted.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { config } from '../lib/config.ts';
import { paths } from '../lib/paths.ts';
import { readMeta } from './meta.ts';

export const INTERNAL_PORT = 3000;
const RUN_MEMORY = process.env.RUN_MEMORY || '1g';
const RUN_CPUS = process.env.RUN_CPUS || '1';
const START_TIMEOUT_MS = Number(process.env.RUN_START_TIMEOUT_MS || 180_000);

export type RuntimeState = 'stopped' | 'starting' | 'running' | 'failed';
interface Runtime {
  state: RuntimeState;
  port?: number;
  error?: string;
  since: number;
  starting?: Promise<void>;
  child?: ChildProcess;
}
const runtimes = new Map<string, Runtime>();

export const containerName = (appId: string) => `ta-app-${appId.replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
const logFile = (appId: string) => paths.appLog(appId);
const runtimeLog = (appId: string) => path.join(paths.app(appId), 'runtime.log');

function rlog(appId: string, msg: string) {
  try {
    fs.appendFileSync(logFile(appId), `\n▶ [${new Date().toISOString()}] Runtime: ${msg}\n`);
  } catch {
    /* app deleted */
  }
}

const docker = (args: string[], timeout = 30_000) => spawnSync('docker', args, { encoding: 'utf8', timeout });

/** The runtime env for a server app: researcher env + PORT/HOSTNAME. Values travel via the process env, never argv. */
function runtimeEnv(appId: string, port: number): Record<string, string> {
  const meta = readMeta(appId);
  return {
    ...(meta.env || {}),
    PORT: String(port),
    HOSTNAME: '0.0.0.0',
    HOST: '0.0.0.0',
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    NO_COLOR: '1',
  };
}

function probeHttp(port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/', method: 'HEAD', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

function containerStatus(appId: string): string | undefined {
  const r = docker(['inspect', '-f', '{{.State.Status}}', containerName(appId)]);
  return r.status === 0 ? r.stdout.trim() : undefined;
}

function containerPort(appId: string): number | undefined {
  const r = docker(['port', containerName(appId), `${INTERNAL_PORT}/tcp`]);
  const m = r.stdout?.match(/:(\d+)\s*$/m);
  return m ? Number(m[1]) : undefined;
}

export function containerLogs(appId: string, tail = 200): string {
  if (config.buildMode !== 'docker') {
    try {
      const all = fs.readFileSync(runtimeLog(appId), 'utf8').split('\n');
      return all.slice(-tail).join('\n');
    } catch {
      return '';
    }
  }
  const r = docker(['logs', '--tail', String(tail), containerName(appId)]);
  return ((r.stdout || '') + (r.stderr || '')).trim();
}

async function startDocker(appId: string, rt: Runtime) {
  const meta = readMeta(appId);
  if (!meta.server) throw new Error('This app has no server build. Rebuild it.');
  const name = containerName(appId);
  let status = containerStatus(appId);
  if (status && status !== 'running') {
    rlog(appId, `container ${name} is ${status}, starting it`);
    const r = docker(['start', name]);
    if (r.status !== 0) {
      rlog(appId, `docker start failed (${r.stderr.trim()}), recreating`);
      docker(['rm', '-f', name]);
      status = undefined;
    }
  }
  if (!status) {
    const uid = typeof process.getuid === 'function' ? `${process.getuid()}:${process.getgid!()}` : '1000:1000';
    const env = runtimeEnv(appId, INTERNAL_PORT);
    const args = [
      'run', '-d', '--name', name, '--label', `thinkaloud.app=${appId}`,
      '--restart', 'unless-stopped',
      '--user', uid,
      '--memory', RUN_MEMORY, '--memory-swap', RUN_MEMORY, '--cpus', RUN_CPUS, '--pids-limit', '1024',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '-p', `127.0.0.1::${INTERNAL_PORT}`,
      '-v', `${paths.appSource(appId)}:/workspace`,
      '-w', meta.server.rel ? `/workspace/${meta.server.rel}` : '/workspace',
      '-e', 'HOME=/tmp',
      ...Object.keys(env).flatMap((k) => ['-e', k]),
      meta.server.image, 'bash', '-c', meta.server.start,
    ];
    rlog(appId, `docker run ${meta.server.image} (${RUN_MEMORY} RAM, ${RUN_CPUS} CPU, restart unless-stopped): ${meta.server.start}`);
    const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000, env: { ...process.env, ...env } });
    if (r.status !== 0) throw new Error(`docker run failed: ${(r.stderr || r.stdout || '').trim().slice(0, 500)}`);
  }
  const port = containerPort(appId);
  if (!port) throw new Error('Could not read the container port');
  rt.port = port;
  await waitHealthy(appId, port, () => {
    const s = containerStatus(appId);
    return s === 'running' || s === 'restarting' ? undefined : `container ${s || 'is gone'}`;
  });
}

async function startLocal(appId: string, rt: Runtime) {
  const meta = readMeta(appId);
  if (!meta.server) throw new Error('This app has no server build. Rebuild it.');
  const port = await freePort();
  const cwd = path.join(paths.appSource(appId), meta.server.rel || '');
  const out = fs.openSync(runtimeLog(appId), 'a');
  rlog(appId, `starting local process on port ${port}: ${meta.server.start}`);
  const child = spawn('bash', ['-c', meta.server.start], { cwd, env: { ...process.env, ...runtimeEnv(appId, port) }, stdio: ['ignore', out, out], detached: true });
  fs.closeSync(out);
  rt.child = child;
  rt.port = port;
  let exited: string | undefined;
  child.on('exit', (code, sig) => {
    exited = `process exited (${sig || code})`;
    if (runtimes.get(appId) === rt && rt.state === 'running') {
      rt.state = 'stopped';
      rlog(appId, exited);
    }
  });
  await waitHealthy(appId, port, () => exited);
}

async function waitHealthy(appId: string, port: number, dead: () => string | undefined) {
  const t0 = Date.now();
  while (Date.now() - t0 < START_TIMEOUT_MS) {
    if (await probeHttp(port)) {
      rlog(appId, `listening (internal port ${port}) after ${Math.round((Date.now() - t0) / 1000)}s`);
      return;
    }
    const d = dead();
    if (d) throw new Error(`The server stopped: ${d}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`The server did not answer on port ${INTERNAL_PORT} within ${Math.round(START_TIMEOUT_MS / 1000)}s. Make sure the start command listens on $PORT and 0.0.0.0.`);
}

/** Make sure the app's server is running. Returns immediately with the current state (starts in the background). */
export function ensureRuntime(appId: string): Runtime {
  let rt = runtimes.get(appId);
  if (rt && (rt.state === 'running' || rt.state === 'starting')) return rt;
  if (rt && rt.state === 'failed' && Date.now() - rt.since < 15_000) return rt; // don't hammer a crashing app
  rt = { state: 'starting', since: Date.now() };
  runtimes.set(appId, rt);
  const cur = rt;
  cur.starting = (async () => {
    try {
      if (config.buildMode === 'docker') await startDocker(appId, cur);
      else await startLocal(appId, cur);
      if (runtimes.get(appId) === cur) Object.assign(cur, { state: 'running', since: Date.now(), error: undefined });
    } catch (e) {
      const msg = (e as Error).message;
      const tail = containerLogs(appId, 40);
      rlog(appId, `failed: ${msg}${tail ? `\n--- server output ---\n${tail}` : ''}`);
      if (runtimes.get(appId) === cur) Object.assign(cur, { state: 'failed', since: Date.now(), error: msg });
    }
  })();
  return rt;
}

/** Start and wait (used right after a build, so the build only turns ready once the server answers). */
export async function startRuntimeAndWait(appId: string): Promise<Runtime> {
  await stopRuntime(appId);
  const rt = ensureRuntime(appId);
  await rt.starting;
  return rt;
}

/** The proxy could not connect: forget the port so the next request re-checks the container. */
export function markUnreachable(appId: string) {
  const rt = runtimes.get(appId);
  if (rt?.state === 'running') {
    rt.state = 'stopped';
    rt.since = Date.now();
  }
}

export async function stopRuntime(appId: string) {
  const rt = runtimes.get(appId);
  runtimes.delete(appId);
  if (rt?.child?.pid) {
    try {
      process.kill(-rt.child.pid, 'SIGTERM');
    } catch {
      /* gone */
    }
  }
  if (config.buildMode === 'docker' && containerStatus(appId)) {
    docker(['rm', '-f', containerName(appId)]);
    rlog(appId, `container ${containerName(appId)} removed`);
  }
}

export function runtimeInfo(appId: string): { state: RuntimeState; error?: string; container?: string } {
  const rt = runtimes.get(appId);
  const container = config.buildMode === 'docker' ? containerStatus(appId) : undefined;
  return { state: rt?.state ?? 'stopped', error: rt?.error, ...(container ? { container } : {}) };
}
