// App build pipeline: extract/clone → find project root → detect framework →
// install + build (Docker or local) → copy output to DATA_DIR/apps/<id>/dist.
// Serial-ish queue (concurrency 2). Logs stream to DATA_DIR/apps/<id>/build.log.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import type { AppFramework } from '@thinkaloud/shared';
import { db } from '../db.ts';
import { config } from '../lib/config.ts';
import { paths } from '../lib/paths.ts';
import { hostedAppUrl } from '../apphost/urls.ts';
import { readMeta, uploadZipPath, writeMeta, type AppMeta } from './meta.ts';
import { diagnose, frameworkLabel, isWorkspaceRoot, monorepoApps, workspaceDepsToBuild, EXPO_SINGLE_SCRIPT, expoApiRoutes, expoWebOutput, missingEnvHints, nextServerReasons, nodeServerFramework, pickNode, type PkgJson } from './plan.ts';
import { ensureRuntime, startRuntimeAndWait, stopRuntime } from './runtime.ts';

const CONCURRENCY = Number(process.env.BUILD_CONCURRENCY || 2);
const BUILD_TIMEOUT_MS = Number(process.env.BUILD_TIMEOUT_MS || 15 * 60 * 1000);
const MAX_UNPACKED_BYTES = 500 * 1024 * 1024;
const MAX_ENTRIES = 200_000;
/** BUILD_IMAGE pins one image for every build; otherwise node:<major> from .nvmrc / engines.node (default 22). */
const BUILD_IMAGE = process.env.BUILD_IMAGE || '';
const BUILD_MEMORY = process.env.BUILD_MEMORY || '8g';
const BUILD_CPUS = process.env.BUILD_CPUS || '2';
const OUTPUT_DIRS = ['dist', 'build', 'out', 'web-build', '_site', 'public', 'www'];

class BuildError extends Error {}

// ── Logging ─────────────────────────────────────────────────────────────────
function log(appId: string, line: string) {
  fs.appendFileSync(paths.appLog(appId), line.endsWith('\n') ? line : line + '\n');
}
const step = (appId: string, msg: string) => log(appId, `\n▶ [${new Date().toISOString()}] ${msg}`);

function logTail(appId: string, lines = 30): string {
  try {
    const all = fs.readFileSync(paths.appLog(appId), 'utf8').split('\n').filter((l) => l.trim());
    return all.slice(-lines).join('\n').slice(-4000);
  } catch {
    return '';
  }
}

function setApp(appId: string, fields: Record<string, string | number | null>) {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE apps SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(
    ...keys.map((k) => fields[k]),
    Date.now(),
    appId,
  );
}

// ── Zip extraction (zip-slip / symlink / size safe) ─────────────────────────
const SKIP_SEGMENTS = new Set(['node_modules', '.git', '__MACOSX', '.next', '.expo', '.turbo', '.cache']);

export function safeExtractZip(zipFile: string, dest: string, onLog: (s: string) => void = () => {}) {
  let zip: AdmZip;
  try {
    zip = new AdmZip(zipFile);
  } catch (e) {
    throw new BuildError(`Not a valid .zip file (${(e as Error).message})`);
  }
  const entries = zip.getEntries();
  const kept = entries.filter((e) => !e.entryName.replace(/\\/g, '/').split('/').some((seg) => SKIP_SEGMENTS.has(seg))).length;
  if (kept > MAX_ENTRIES) throw new BuildError(`Zip has too many files (${kept} > ${MAX_ENTRIES}, not counting node_modules/.git)`);
  const root = path.resolve(dest);
  let total = 0;
  let skipped = 0;
  let written = 0;
  for (const entry of entries) {
    const raw = entry.entryName.replace(/\\/g, '/');
    if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw) || raw.includes('\0')) throw new BuildError(`Unsafe absolute path in zip: ${raw}`);
    const segs = raw.split('/').filter((s) => s && s !== '.');
    if (segs.some((s) => s === '..')) throw new BuildError(`Unsafe path in zip (zip-slip): ${raw}`);
    if (!segs.length) continue;
    if (segs.some((s) => SKIP_SEGMENTS.has(s)) || segs[segs.length - 1] === '.DS_Store') {
      skipped++;
      continue;
    }
    const mode = (entry.attr >>> 16) & 0o170000;
    if (mode === 0o120000) throw new BuildError(`Symlinks are not allowed in uploads: ${raw}`);
    const target = path.resolve(root, ...segs);
    if (target !== root && !target.startsWith(root + path.sep)) throw new BuildError(`Unsafe path in zip: ${raw}`);
    if (entry.isDirectory) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    total += entry.header.size;
    if (total > MAX_UNPACKED_BYTES) throw new BuildError(`Unpacked size exceeds ${MAX_UNPACKED_BYTES / 1024 / 1024} MB`);
    const data = entry.getData();
    if (data.length !== entry.header.size) {
      total += Math.max(0, data.length - entry.header.size);
      if (total > MAX_UNPACKED_BYTES) throw new BuildError(`Unpacked size exceeds ${MAX_UNPACKED_BYTES / 1024 / 1024} MB`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data, { mode: 0o644 });
    written++;
  }
  onLog(`Extracted ${written} files (${(total / 1024 / 1024).toFixed(1)} MB)${skipped ? `, skipped ${skipped} node_modules/.git/junk entries` : ''}`);
}

// ── Project root + framework detection ──────────────────────────────────────
const JUNK = new Set(['.DS_Store', '__MACOSX', 'Thumbs.db']);

/** Descend through single top-level folders (zip of a folder), then apply the monorepo subdir. */
export function findProjectRoot(dir: string, subdir?: string): string {
  let cur = dir;
  for (let i = 0; i < 4; i++) {
    const items = fs.readdirSync(cur).filter((n) => !JUNK.has(n));
    if (items.length === 1 && fs.statSync(path.join(cur, items[0])).isDirectory() && !fs.existsSync(path.join(cur, 'package.json'))) {
      cur = path.join(cur, items[0]);
    } else break;
  }
  if (subdir) {
    const clean = subdir.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.');
    if (clean.some((s) => s === '..')) throw new BuildError('Invalid subdir');
    let next = path.join(cur, ...clean);
    if (!fs.existsSync(next) && fs.existsSync(path.join(dir, ...clean))) next = path.join(dir, ...clean);
    if (!fs.existsSync(next) || !fs.statSync(next).isDirectory()) throw new BuildError(`Subdirectory "${subdir}" not found in the project`);
    cur = next;
  }
  return cur;
}

type PM = 'npm' | 'pnpm' | 'yarn' | 'bun';

interface Plan {
  framework: AppFramework;
  /** Directory already containing the static site (no build). */
  staticDir?: string;
  pm?: PM;
  script?: string;
  /** Preferred output dirs, relative to the project root, in priority order. */
  outputs: string[];
  notes: string[];
  /** Server app: command that starts it (listens on $PORT). */
  start?: string;
}

function readPkg(root: string): PkgJson | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as PkgJson;
  } catch {
    return null;
  }
}

function findUp(start: string, stop: string, names: string[]): string | undefined {
  let cur = start;
  for (;;) {
    for (const n of names) if (fs.existsSync(path.join(cur, n))) return n;
    if (cur === stop || !cur.startsWith(stop)) return undefined;
    const parent = path.dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
}

function detectPm(root: string, top: string, pkg: PkgJson): PM {
  const pmField = pkg.packageManager?.split('@')[0];
  if (pmField === 'pnpm' || pmField === 'yarn' || pmField === 'npm' || pmField === 'bun') return pmField;
  const lock = findUp(root, top, ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'package-lock.json', 'npm-shrinkwrap.json']);
  if (lock === 'pnpm-lock.yaml') return 'pnpm';
  if (lock === 'yarn.lock') return 'yarn';
  if (lock === 'bun.lockb' || lock === 'bun.lock') return 'bun';
  return 'npm';
}

const hasIndex = (dir: string) => fs.existsSync(path.join(dir, 'index.html'));
const majorOf = (v?: string) => Number((v || '').replace(/^[^\d]*/, '').split('.')[0]) || 0;

function viteOutDir(root: string): string | undefined {
  for (const f of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts', 'vite.config.cjs']) {
    try {
      const src = fs.readFileSync(path.join(root, f), 'utf8');
      const m = src.match(/outDir\s*:\s*['"`]([^'"`]+)['"`]/);
      if (m) return m[1];
    } catch {
      /* no file */
    }
  }
  return undefined;
}

export function detect(root: string, top: string, meta: AppMeta = {}): Plan {
  const pkg = readPkg(root);
  if (!pkg) {
    if (hasIndex(root)) return { framework: 'static', staticDir: root, outputs: [], notes: ['No package.json; serving index.html at the project root as a static site'] };
    for (const d of OUTPUT_DIRS) {
      if (hasIndex(path.join(root, d))) return { framework: 'static', staticDir: path.join(root, d), outputs: [], notes: [`No package.json; serving ${d}/ as a static site`] };
    }
    throw new BuildError('Could not find an index.html or a package.json. Upload a zip of your project folder or of a built dist/ folder.');
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const scripts = pkg.scripts || {};
  const pm = detectPm(root, top, pkg);
  const notes: string[] = [];
  const build = scripts.build ? 'build' : undefined;

  if (deps.expo) {
    return { framework: 'expo-web', pm, outputs: ['dist', 'web-build'], notes };
  }
  if (deps.next) {
    const reasons = meta.mode === 'static' ? [] : meta.mode === 'server' ? ['Hosting mode set to "server"'] : nextServerReasons(root);
    if (reasons.length) {
      notes.push(`Next.js needs a running server (${reasons.join('; ')}) — building with next build and hosting it with next start`);
      return { framework: 'next-server', pm, script: build, outputs: [], notes, start: meta.startCommand || 'exec ./node_modules/.bin/next start -p "$PORT" -H 0.0.0.0' };
    }
    return { framework: 'next-static', pm, script: build, outputs: ['out'], notes };
  }
  // React Router v7 / Remix (Vite) in SPA mode (ssr: false) build a static build/client/.
  const rrSpa = (deps['@react-router/dev'] || deps['@remix-run/dev']) && /\bssr\s*:\s*false/.test(['react-router.config.ts', 'react-router.config.js', 'vite.config.ts', 'vite.config.js'].map((f) => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return ''; } }).join('\n'));
  if (rrSpa && meta.mode !== 'server') {
    notes.push('React Router / Remix SPA mode (ssr: false) — serving build/client/ as a static site');
    return { framework: 'vite', pm, script: build, outputs: ['build/client', 'dist'], notes };
  }
  const serverFw = meta.mode === 'static' ? undefined : nodeServerFramework(pkg) || (meta.mode === 'server' ? 'Node server' : undefined);
  if (serverFw) {
    if (!scripts.start && !meta.startCommand) throw new BuildError(`${serverFw} app detected but package.json has no "start" script. Set a start command in Build settings (it must listen on $PORT).`);
    notes.push(`${serverFw} — hosting as a server app (${meta.startCommand || 'npm run start'})`);
    return { framework: 'node-server', pm, script: build, outputs: [], notes, start: meta.startCommand || 'exec npm run start' };
  }
  if (deps['react-scripts']) {
    return { framework: 'cra', pm, script: build, outputs: ['build'], notes };
  }
  if (deps.vite) {
    const out = viteOutDir(root);
    return { framework: 'vite', pm, script: build, outputs: out ? [out, 'dist'] : ['dist'], notes };
  }
  if (build) return { framework: 'unknown', pm, script: build, outputs: OUTPUT_DIRS, notes: ['Unknown framework; running the "build" script'] };
  // package.json without a build step: maybe an already-built site.
  for (const d of ['', ...OUTPUT_DIRS]) {
    const dir = path.join(root, d);
    if (hasIndex(dir)) return { framework: 'static', staticDir: dir, outputs: [], notes: [`No build script; serving ${d || '.'}/ as a static site`] };
  }
  throw new BuildError('package.json has no "build" script and no index.html was found.');
}

// ── Commands ────────────────────────────────────────────────────────────────
/** The package manager is put on PATH by pmSetup(), so tools that spawn it (expo install, turbo, scripts) find it too. */
function pmBin(pm: PM): string {
  return pm;
}

/** Shell prelude: make `pnpm` / `yarn` (corepack shims, honouring packageManager) or `bun` available on PATH. */
function pmSetup(pm: PM, spec?: string): string[] {
  if (pm === 'npm') return [];
  const versioned = spec && spec.startsWith(pm + '@') ? spec.split('+')[0] : pm;
  const lines = ['TA_BIN="$(mktemp -d)"; export PATH="$TA_BIN:$TA_BIN/g/bin:$PATH"'];
  if (pm === 'pnpm' || pm === 'yarn') lines.push('if command -v corepack >/dev/null 2>&1; then corepack enable --install-directory "$TA_BIN" pnpm yarn >/dev/null 2>&1 || true; fi');
  // No corepack (Node >= 25) or bun: install the tool into a throwaway prefix.
  lines.push(`command -v ${pm} >/dev/null 2>&1 || npm install -g --prefix "$TA_BIN/g" --no-audit --no-fund ${versioned} >/dev/null 2>&1 || { echo "!! Could not install ${versioned}"; exit 1; }`);
  lines.push(`echo "${pm} $(${pm} --version 2>/dev/null | tail -1)"`);
  return lines;
}

function installCmd(pm: PM, root: string, top: string, spec?: string): string {
  const bin = pmBin(pm);
  if (pm === 'npm') {
    const lock = findUp(root, top, ['package-lock.json', 'npm-shrinkwrap.json']);
    const legacy = `{ echo '!! npm install failed; retrying with --legacy-peer-deps'; npm install --no-audit --no-fund --legacy-peer-deps; }`;
    return lock ? `npm ci --no-audit --no-fund || npm install --no-audit --no-fund || ${legacy}` : `npm install --no-audit --no-fund || ${legacy}`;
  }
  if (pm === 'pnpm') return `${bin} install --no-frozen-lockfile`;
  if (pm === 'yarn') return `${bin} install`;
  return `${bin} install`;
}

const runScript = (pm: PM, script: string, _spec?: string) => (pm === 'npm' ? `npm run ${script}` : `${pmBin(pm)} run ${script}`);

/** Make `next build` produce a static export (out/) even if the config does not ask for it. */
function forceNextExport(root: string, onLog: (s: string) => void) {
  const configs = ['next.config.js', 'next.config.mjs', 'next.config.cjs', 'next.config.ts'].filter((f) => fs.existsSync(path.join(root, f)));
  if (!configs.length) {
    fs.writeFileSync(path.join(root, 'next.config.js'), "module.exports = { output: 'export', images: { unoptimized: true } };\n");
    onLog("Created next.config.js with output: 'export'");
    return;
  }
  const f = configs[0];
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  if (/output\s*:\s*['"]export['"]/.test(src)) return;
  const ext = path.extname(f);
  const orig = `next.config.ta-orig${ext}`;
  fs.renameSync(path.join(root, f), path.join(root, orig));
  const merge = `(c) => ({ ...c, output: 'export', images: { ...(c && c.images), unoptimized: true } })`;
  const wrapper =
    ext === '.js' || ext === '.cjs'
      ? `const orig = require('./${orig}');\nconst m = ${merge};\nmodule.exports = typeof orig === 'function' ? async (...a) => m(await orig(...a)) : m(orig);\n`
      : `import orig from './${orig.replace(/\.ts$/, '')}';\nconst m = ${merge};\nexport default typeof orig === 'function' ? async (...a${ext === '.ts' ? ': any[]' : ''}) => m(await (orig as any)(...a)) : m(orig${ext === '.ts' ? ' as any' : ''});\n`;
  fs.writeFileSync(path.join(root, ext === '.mjs' ? 'next.config.mjs' : f), ext === '.ts' ? wrapper : wrapper.replace(/ as any/g, ''));
  onLog(`Next.js config has no output: 'export' — wrapped ${f} to force a static export (server features like API routes/SSR will not work)`);
}

function buildScript(plan: Plan, root: string, top: string, onLog: (s: string) => void, meta: AppMeta = {}): string {
  const pkg = readPkg(root)!;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const pm = plan.pm!;
  const lines: string[] = ['set -e', 'echo "node $(node -v), npm $(npm -v)"', ...pmSetup(pm, pkg.packageManager)];
  const run = (label: string, cmd: string) => lines.push(`echo '$ ${label.replace(/'/g, '')}'`, cmd);
  run(`${pm} install`, installCmd(pm, root, top, pkg.packageManager));

  // Monorepo: build local workspace dependencies (dependencies first) so their dist/ exists.
  if (root !== top) {
    for (const d of workspaceDepsToBuild(top, root)) {
      const rel = path.relative(root, path.join(top, d.rel)).split(path.sep).join('/');
      const cmd = `(cd '${rel.replace(/'/g, '')}' && ${runScript(pm, 'build', pkg.packageManager)})`;
      onLog(`Workspace dependency ${d.name} (${d.rel}) has a build script; building it first`);
      run(`build workspace dependency ${d.name}`, cmd);
    }
  }
  if (meta.buildCommand) {
    onLog(`Using the build command from Build settings: ${meta.buildCommand}`);
    run(meta.buildCommand, meta.buildCommand);
    return lines.join('\n');
  }
  switch (plan.framework) {
    case 'next-server': {
      const cmd = plan.script ? runScript(pm, plan.script, pkg.packageManager) : './node_modules/.bin/next build';
      run(cmd, cmd);
      break;
    }
    case 'node-server': {
      if (plan.script) {
        const cmd = runScript(pm, plan.script, pkg.packageManager);
        run(cmd, cmd);
      } else onLog('No "build" script; the server is started as is');
      break;
    }
    case 'expo-web': {
      if (pm === 'yarn') lines.push('export YARN_NODE_LINKER=node-modules # Metro cannot resolve Yarn PnP');
      const missing = ['react-dom', 'react-native-web', '@expo/metro-runtime'].filter((d) => !deps[d]);
      if (missing.length) {
        onLog(`Expo web support needs ${missing.join(', ')} — not in package.json, running "npx expo install ${missing.join(' ')}"`);
        run(`npx expo install ${missing.join(' ')}`, `npx expo install ${missing.join(' ')} || { echo "!! Could not add Expo web dependencies (${missing.join(', ')}). Add them to package.json and re-upload."; exit 1; }`);
      }
      if (majorOf(deps.expo) && majorOf(deps.expo) < 49) {
        run('npx expo export:web', 'npx expo export:web');
        break;
      }
      const output = expoWebOutput(root);
      const exp = 'npx expo export --platform web --output-dir dist';
      fs.writeFileSync(path.join(root, '.ta-expo-single.cjs'), EXPO_SINGLE_SCRIPT);
      const api = expoApiRoutes(root);
      if (output === 'server') {
        onLog(`app.json sets web.output: "server" (needs an Expo server). Exporting as a single-page app (web.output: "single") instead${api.length ? `; API routes will NOT work: ${api.join(', ')}` : ''}`);
        run('switch web.output to "single"', 'node .ta-expo-single.cjs');
        run(exp, exp);
      } else if (output === 'static') {
        // Static rendering runs every screen in Node at build time; apps touching window/env at import time fail there.
        run(exp, `${exp} || { echo '!! Expo static rendering failed (see above). Retrying as a single-page app (web.output: "single"), which renders in the browser only.'; node .ta-expo-single.cjs; rm -rf dist; ${exp}; }`);
      } else run(exp, exp);
      break;
    }
    case 'next-static': {
      forceNextExport(root, onLog);
      const cmd = plan.script ? runScript(pm, plan.script, pkg.packageManager) : 'npx next build';
      run(cmd, cmd);
      if (majorOf(deps.next) && majorOf(deps.next) < 14) run('npx next export (if out/ missing)', '[ -d out ] || npx next export');
      break;
    }
    case 'vite': {
      const cmd = plan.script ? runScript(pm, plan.script, pkg.packageManager) : 'npx vite build';
      const typeChecks = plan.script && /\b(tsc|vue-tsc|svelte-check)\b/.test(pkg.scripts?.[plan.script] || '');
      const isRR = deps['@react-router/dev'] ? 'npx react-router build' : 'npx vite build';
      // Type errors should not block a usability study: retry the plain bundler build.
      if (typeChecks) run(cmd, `${cmd} || { echo '!! The build script failed (often TypeScript type errors from tsc). Retrying with "${isRR}" only, skipping the type check.'; ${isRR}; }`);
      else run(cmd, cmd);
      break;
    }
    default: {
      const cmd = runScript(pm, plan.script || 'build', pkg.packageManager);
      run(cmd, cmd);
    }
  }
  return lines.join('\n');
}

const buildEnv: Record<string, string> = {
  CI: 'false', // CRA turns warnings into errors with CI=true
  BROWSER: 'none',
  NO_COLOR: '1',
  FORCE_COLOR: '0',
  NEXT_TELEMETRY_DISABLED: '1',
  EXPO_NO_TELEMETRY: '1',
  EXPO_NO_INTERACTIVE: '1',
  GENERATE_SOURCEMAP: 'false',
  COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
  COREPACK_ENABLE_STRICT: '0',
  YARN_ENABLE_IMMUTABLE_INSTALLS: 'false',
  YARN_ENABLE_TELEMETRY: '0',
  npm_config_update_notifier: 'false',
  npm_config_fund: 'false',
  npm_config_audit: 'false',
};

interface Running {
  cancel: () => void;
  cancelled: boolean;
}
const running = new Map<string, Running>();

function runShell(appId: string, top: string, root: string, script: string, image: string, userEnv: Record<string, string> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const cacheDir = path.join(paths.root, 'build-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    let child;
    let containerName: string | undefined;
    if (config.buildMode === 'docker') {
      containerName = `ta-build-${appId.replace(/[^a-z0-9]/gi, '')}-${Date.now().toString(36)}`;
      const rel = path.relative(top, root).split(path.sep).join('/');
      const uid = typeof process.getuid === 'function' ? `${process.getuid()}:${process.getgid!()}` : '1000:1000';
      const args = [
        'run', '--rm', '--name', containerName,
        '--user', uid,
        '--memory', BUILD_MEMORY, '--memory-swap', BUILD_MEMORY, '--cpus', BUILD_CPUS, '--pids-limit', '4096',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '-v', `${top}:/workspace`, '-v', `${cacheDir}:/cache`,
        '-w', rel ? `/workspace/${rel}` : '/workspace',
        '-e', 'HOME=/cache/home', '-e', 'npm_config_cache=/cache/npm', '-e', 'COREPACK_HOME=/cache/corepack',
        '-e', 'npm_config_store_dir=/cache/pnpm-store', '-e', 'BUN_INSTALL_CACHE_DIR=/cache/bun',
        ...Object.entries(buildEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
        // Researcher env: names only in argv (values come from the docker client's env, never logged).
        ...Object.keys(userEnv).flatMap((k) => ['-e', k]),
        image, 'bash', '-c', script,
      ];
      log(appId, `docker ${args.slice(0, -1).join(' ')} <script>`);
      child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...userEnv } });
    } else {
      child = spawn('bash', ['-c', script], {
        cwd: root,
        env: { ...process.env, ...buildEnv, npm_config_cache: path.join(cacheDir, 'npm'), ...userEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    }
    const onData = (b: Buffer) => fs.appendFileSync(paths.appLog(appId), b);
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    const kill = () => {
      if (containerName) spawnSync('docker', ['kill', containerName], { stdio: 'ignore' });
      try {
        if (child.pid) process.kill(config.buildMode === 'docker' ? child.pid : -child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      log(appId, `!! Build timed out after ${Math.round(BUILD_TIMEOUT_MS / 60000)} minutes`);
      kill();
    }, BUILD_TIMEOUT_MS);
    const r = running.get(appId);
    if (r) r.cancel = kill;
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new BuildError(config.buildMode === 'docker' ? `Could not start docker: ${e.message}` : e.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (running.get(appId)?.cancelled) return reject(new BuildError('Build cancelled'));
      if (code === 0) resolve();
      else if (timedOut) reject(new BuildError(`Build timed out after ${Math.round(BUILD_TIMEOUT_MS / 60000)} minutes (BUILD_TIMEOUT_MS). Make the build lighter (see below) or ask the admin to raise the limit.`));
      else if (code === 137) reject(new BuildError('Build was killed (exit code 137): the build container ran out of memory'));
      else reject(new BuildError(`Build command failed (exit code ${code})`));
    });
  });
}

function findOutput(root: string, plan: Plan, override?: string): string {
  if (override) {
    const dir = path.resolve(root, override);
    if (dir !== root && !dir.startsWith(root + path.sep)) throw new BuildError('Output directory must be inside the project');
    if (!hasIndex(dir)) throw new BuildError(`Output directory "${override}" (from Build settings) has no index.html after the build`);
    return dir;
  }
  const candidates = [...plan.outputs, ...OUTPUT_DIRS.filter((d) => !plan.outputs.includes(d))];
  for (const d of candidates) {
    const dir = path.resolve(root, d);
    if (!dir.startsWith(root)) continue;
    if (hasIndex(dir)) return dir;
  }
  // Nested outputs: Angular (dist/<project>/browser), React Router (build/client), multi-target builds.
  for (const d of ['dist', 'build', 'out']) {
    const base = path.join(root, d);
    let subs: string[] = [];
    try {
      subs = fs.readdirSync(base).filter((n) => fs.statSync(path.join(base, n)).isDirectory());
    } catch {
      continue;
    }
    for (const n of subs) {
      for (const cand of [path.join(base, n, 'browser'), path.join(base, n, 'client'), path.join(base, n)]) if (hasIndex(cand)) return cand;
    }
  }
  if (plan.framework === 'next-static')
    throw new BuildError("Next.js build finished but no out/index.html was produced. Only static exports are supported (output: 'export'); SSR/API routes cannot be hosted.");
  throw new BuildError(`Build finished but no index.html was found in ${candidates.join(', ')}`);
}

/** Copy a directory, skipping symlinks (build output must not point outside). */
function copyDir(src: string, dest: string) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (s) => {
      try {
        return !fs.lstatSync(s).isSymbolicLink();
      } catch {
        return false;
      }
    },
  });
}

function dirSize(dir: string): number {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) n += fs.statSync(path.join(e.parentPath, e.name)).size;
  }
  return n;
}

/** SSH clones use the server's own SSH credentials: on by default outside production, GIT_ALLOW_SSH=1/0 overrides. */
export const gitSshAllowed = () => (process.env.GIT_ALLOW_SSH ? process.env.GIT_ALLOW_SSH === '1' : !config.isProd);
export const SSH_GIT_RE = /^(?:ssh:\/\/[\w.-]+@[\w.-]+(?::\d+)?\/[\w./~-]+|[\w.-]+@[\w.-]+:[\w./~-]+)$/;

export function isSafeGitUrl(u: string): boolean {
  if (u.startsWith('-') || /\s/.test(u)) return false;
  if (/^https?:\/\/[^\s]+$/i.test(u)) return true;
  return gitSshAllowed() && SSH_GIT_RE.test(u) && !u.includes('..');
}

async function gitClone(appId: string, url: string, dest: string, branch?: string) {
  if (!isSafeGitUrl(url)) throw new BuildError(gitSshAllowed() ? 'Unsupported git URL. Use https://… or git@host:owner/repo.git' : 'Only http(s) git URLs are supported (SSH clones are disabled on this server; set GIT_ALLOW_SSH=1)');
  if (branch && !/^[\w./-]+$/.test(branch)) throw new BuildError('Invalid branch name');
  const args = ['-c', 'protocol.file.allow=never', '-c', 'core.symlinks=false', 'clone', '--depth', '1', '--single-branch', ...(branch ? ['--branch', branch] : []), '--', url, dest];
  log(appId, `$ git ${args.join(' ')}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', args, {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onData = (b: Buffer) => fs.appendFileSync(paths.appLog(appId), b);
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => child.kill('SIGKILL'), 5 * 60 * 1000);
    child.on('error', (e) => reject(new BuildError(`git failed: ${e.message}`)));
    child.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new BuildError(`git clone failed (exit code ${code}). Is the repository public (or, for SSH URLs, does this server's SSH key have access) and is the branch correct?`));
    });
  });
  fs.rmSync(path.join(dest, '.git'), { recursive: true, force: true });
}

// ── The build ───────────────────────────────────────────────────────────────
async function runBuild(appId: string) {
  const row = db.prepare('SELECT * FROM apps WHERE id = ?').get(appId) as Record<string, unknown> | undefined;
  if (!row || row.source_kind === 'url') return;
  const meta = readMeta(appId);
  fs.mkdirSync(paths.app(appId), { recursive: true });
  fs.writeFileSync(paths.appLog(appId), `ThinkAloud build ${appId} — ${new Date().toISOString()} — mode: ${config.buildMode}\n`);
  setApp(appId, { status: 'building', error: null });
  const started = Date.now();
  const source = paths.appSource(appId);
  let plan: Plan | undefined;
  let envMissing: string[] = [];
  const userEnv = meta.env || {};
  try {
    await stopRuntime(appId); // a rebuild replaces the running server (and its source tree)
    step(appId, 'Preparing source');
    fs.rmSync(source, { recursive: true, force: true });
    fs.mkdirSync(source, { recursive: true });
    if (row.source_kind === 'upload') {
      const zip = uploadZipPath(appId);
      if (!fs.existsSync(zip)) throw new BuildError('Uploaded zip is missing — please upload again');
      safeExtractZip(zip, source, (s) => log(appId, s));
    } else if (row.source_kind === 'git') {
      await gitClone(appId, String(row.source_url || ''), source, meta.branch);
    }
    let root = findProjectRoot(source, meta.subdir);
    const rootPkg = readPkg(root);
    if (!meta.subdir && isWorkspaceRoot(root, rootPkg) && !frameworkLabel(rootPkg)) {
      const apps = monorepoApps(root);
      if (apps.length === 1) {
        log(appId, `Monorepo: using the only app package, ${apps[0].rel} (${apps[0].label}). Set "subdir" to pick another.`);
        root = path.join(root, apps[0].rel);
      } else if (apps.length > 1) {
        throw new BuildError(`This is a monorepo with several apps. Set the subdirectory (subdir) to one of: ${apps.map((a) => `${a.rel} (${a.label})`).join(', ')}`);
      }
    }
    log(appId, `Project root: ${path.relative(source, root) || '.'}`);

    step(appId, 'Detecting framework');
    plan = detect(root, source, meta);
    log(appId, `Framework: ${plan.framework}${plan.pm ? `, package manager: ${plan.pm}` : ''}`);
    plan.notes.forEach((n) => log(appId, n));
    setApp(appId, { framework: plan.framework });
    const envKeys = Object.keys(userEnv);
    if (envKeys.length) log(appId, `Environment variables from Build settings: ${envKeys.join(', ')}`);
    if (!plan.staticDir) {
      envMissing = missingEnvHints(root, userEnv);
      if (envMissing.length) log(appId, `Note: the project references ${envMissing.join(', ')} but they are not set (no .env in the upload and not in Build settings). If the app needs them, add them under Build settings → Environment variables.`);
    }

    let outDir: string;
    if (plan.staticDir) {
      outDir = plan.staticDir;
    } else {
      const node = pickNode(root, source, readPkg(root), meta.nodeVersion);
      const image = BUILD_IMAGE || `node:${node.major}`;
      log(appId, `Node.js ${node.major} (${node.source})${BUILD_IMAGE ? ` — BUILD_IMAGE=${BUILD_IMAGE} overrides it` : ''}`);
      step(appId, `Installing dependencies and building (${config.buildMode === 'docker' ? `docker ${image}` : 'local'})`);
      const script = buildScript(plan, root, source, (s) => log(appId, s), meta);
      await runShell(appId, source, root, script, image, userEnv);
      if (plan.start) {
        await publishServer(appId, plan, root, source, image, started);
        return;
      }
      outDir = findOutput(root, plan, meta.outputDir);
    }
    writeMeta(appId, { server: undefined });

    step(appId, `Publishing ${path.relative(source, outDir) || '.'}/`);
    const dist = paths.appDist(appId);
    copyDir(outDir, dist);
    if (!hasIndex(dist)) throw new BuildError('Output has no index.html');
    const size = dirSize(dist);
    log(appId, `Published ${(size / 1024 / 1024).toFixed(2)} MB`);
    // Free disk: dependencies are reinstalled from the zip/repo on rebuild.
    fs.rmSync(source, { recursive: true, force: true });

    const url = hostedAppUrl(appId);
    setApp(appId, { status: 'ready', error: null, url, instrumented: 1, framework: plan.framework });
    step(appId, `✓ Ready in ${Math.round((Date.now() - started) / 1000)}s → ${url}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(appId, `\n✗ Build failed: ${msg}`);
    if (!(e instanceof BuildError) && e instanceof Error && e.stack) log(appId, e.stack);
    let full = '';
    try {
      full = fs.readFileSync(paths.appLog(appId), 'utf8');
    } catch {
      /* none */
    }
    const hints = diagnose(full, { framework: plan?.framework, envMissing });
    if (hints.length) log(appId, `\nWhat to change:\n${hints.map((h) => `  • ${h}`).join('\n')}`);
    const tail = logTail(appId);
    setApp(appId, { status: 'failed', error: `${msg}${hints.length ? `\n\nWhat to change:\n${hints.map((h) => `• ${h}`).join('\n')}` : ''}\n\n${tail}`.slice(0, 5000) });
  }
}

/** Server app: keep the built tree (with node_modules) in place and run it in a container. */
async function publishServer(appId: string, plan: Plan, root: string, source: string, image: string, started: number) {
  if (plan.framework === 'next-server') {
    const distDir = (readMeta(appId).env || {}).NEXT_DIST_DIR || '.next';
    if (!fs.existsSync(path.join(root, distDir, 'BUILD_ID'))) throw new BuildError(`next build finished but ${distDir}/BUILD_ID is missing`);
  }
  const rel = path.relative(source, root).split(path.sep).join('/');
  writeMeta(appId, { server: { rel, start: plan.start!, image, framework: plan.framework } });
  fs.rmSync(paths.appDist(appId), { recursive: true, force: true });
  step(appId, `Starting the server (${plan.start})`);
  const rt = await startRuntimeAndWait(appId);
  if (rt.state !== 'running') throw new BuildError(`The app built, but its server did not start: ${rt.error || rt.state}`);
  const url = hostedAppUrl(appId);
  setApp(appId, { status: 'ready', error: null, url, instrumented: 1, framework: plan.framework });
  step(appId, `✓ Ready in ${Math.round((Date.now() - started) / 1000)}s → ${url} (server app; the app host proxies to its container)`);
}

// ── Queue ───────────────────────────────────────────────────────────────────
const pending: string[] = [];

function pump() {
  while (running.size < CONCURRENCY && pending.length) {
    const appId = pending.shift()!;
    const r: Running = { cancel: () => {}, cancelled: false };
    running.set(appId, r);
    runBuild(appId)
      .catch((e) => console.error('[builds] unexpected', e))
      .finally(() => {
        running.delete(appId);
        pump();
      });
  }
}

export function enqueueBuild(appId: string) {
  if (pending.includes(appId)) return;
  if (running.has(appId)) cancelBuild(appId);
  db.prepare("UPDATE apps SET status = 'queued', error = NULL, updated_at = ? WHERE id = ?").run(Date.now(), appId);
  pending.push(appId);
  setImmediate(pump);
}

export function cancelBuild(appId: string) {
  const i = pending.indexOf(appId);
  if (i >= 0) pending.splice(i, 1);
  const r = running.get(appId);
  if (r) {
    r.cancelled = true;
    r.cancel();
  }
}

export const buildQueueState = () => ({ running: [...running.keys()], pending: [...pending] });

// Resume builds interrupted by a server restart, and re-sync hosted URLs (APP_HOST_URL may have changed).
setImmediate(() => {
  try {
    const hosted = db.prepare("SELECT id, source_kind, source_url, url FROM apps WHERE status = 'ready'").all() as Record<string, string>[];
    for (const a of hosted) {
      const want = a.source_kind === 'url' ? (readMeta(a.id).proxy ? hostedAppUrl(a.id, a.source_url) : a.source_url) : hostedAppUrl(a.id);
      if (want && want !== a.url) db.prepare('UPDATE apps SET url = ? WHERE id = ?').run(want, a.id);
    }
    // Server apps: (re)start their containers in the background, staggered.
    const servers = hosted.filter((a) => a.source_kind !== 'url' && readMeta(a.id).server);
    servers.forEach((a, i) => setTimeout(() => ensureRuntime(a.id), 500 + i * 2000));
    const rows = db.prepare("SELECT id FROM apps WHERE status IN ('queued','building') AND source_kind != 'url'").all() as { id: string }[];
    for (const r of rows) enqueueBuild(r.id);
    if (rows.length) console.log(`[builds] resumed ${rows.length} interrupted build(s)`);
  } catch (e) {
    console.error('[builds] resume failed', e);
  }
});

export const tmpUploadDir = () => {
  const d = path.join(paths.root, 'tmp');
  fs.mkdirSync(d, { recursive: true });
  return d || os.tmpdir();
};
