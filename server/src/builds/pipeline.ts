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
import { readMeta, uploadZipPath } from './meta.ts';

const CONCURRENCY = 2;
const BUILD_TIMEOUT_MS = Number(process.env.BUILD_TIMEOUT_MS || 15 * 60 * 1000);
const MAX_UNPACKED_BYTES = 500 * 1024 * 1024;
const MAX_ENTRIES = 200_000;
const BUILD_IMAGE = process.env.BUILD_IMAGE || 'node:22';
const BUILD_MEMORY = process.env.BUILD_MEMORY || '4g';
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
  if (entries.length > MAX_ENTRIES) throw new BuildError(`Zip has too many entries (${entries.length} > ${MAX_ENTRIES})`);
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
}

interface PkgJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
  workspaces?: unknown;
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

export function detect(root: string, top: string): Plan {
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
    return { framework: 'next-static', pm, script: build, outputs: ['out'], notes };
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
function pmBin(pm: PM, spec?: string): string {
  if (pm === 'npm') return 'npm';
  const versioned = spec && spec.startsWith(pm + '@') ? spec.split('+')[0] : pm;
  if (pm === 'bun') return `npx -y ${versioned}`;
  // corepack ships with node:22 (not with Node ≥25), fall back to npx.
  return `$(command -v corepack >/dev/null 2>&1 && echo "corepack ${pm}" || echo "npx -y ${versioned}")`;
}

function installCmd(pm: PM, root: string, top: string, spec?: string): string {
  const bin = pmBin(pm, spec);
  if (pm === 'npm') {
    const lock = findUp(root, top, ['package-lock.json', 'npm-shrinkwrap.json']);
    return lock ? 'npm ci --no-audit --no-fund || npm install --no-audit --no-fund' : 'npm install --no-audit --no-fund';
  }
  if (pm === 'pnpm') return `${bin} install --no-frozen-lockfile`;
  if (pm === 'yarn') return `${bin} install`;
  return `${bin} install`;
}

const runScript = (pm: PM, script: string, spec?: string) => (pm === 'npm' ? `npm run ${script}` : `${pmBin(pm, spec)} run ${script}`);

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

function buildScript(plan: Plan, root: string, top: string, onLog: (s: string) => void): string {
  const pkg = readPkg(root)!;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const pm = plan.pm!;
  const lines: string[] = ['set -e', 'echo "node $(node -v), npm $(npm -v)"'];
  const run = (label: string, cmd: string) => lines.push(`echo '$ ${label.replace(/'/g, '')}'`, cmd);
  run(installCmd(pm, root, top, pkg.packageManager), installCmd(pm, root, top, pkg.packageManager));

  switch (plan.framework) {
    case 'expo-web': {
      const missing = ['react-dom', 'react-native-web', '@expo/metro-runtime'].filter((d) => !deps[d]);
      if (missing.length) {
        onLog(`Expo web support needs ${missing.join(', ')} — not in package.json, running "npx expo install ${missing.join(' ')}"`);
        run(`npx expo install ${missing.join(' ')}`, `npx expo install ${missing.join(' ')} || { echo "!! Could not add Expo web dependencies (${missing.join(', ')}). Add them to package.json and re-upload."; exit 1; }`);
      }
      if (majorOf(deps.expo) && majorOf(deps.expo) < 49) run('npx expo export:web', 'npx expo export:web');
      else run('npx expo export --platform web --output-dir dist', 'npx expo export --platform web --output-dir dist');
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
      run(cmd, cmd);
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
  npm_config_update_notifier: 'false',
  npm_config_fund: 'false',
  npm_config_audit: 'false',
};

interface Running {
  cancel: () => void;
  cancelled: boolean;
}
const running = new Map<string, Running>();

function runShell(appId: string, top: string, root: string, script: string): Promise<void> {
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
        ...Object.entries(buildEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
        BUILD_IMAGE, 'bash', '-c', script,
      ];
      log(appId, `docker ${args.slice(0, -1).join(' ')} <script>`);
      child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } else {
      child = spawn('bash', ['-c', script], {
        cwd: root,
        env: { ...process.env, ...buildEnv, npm_config_cache: path.join(cacheDir, 'npm') },
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
    const timer = setTimeout(() => {
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
      else reject(new BuildError(`Build command failed (exit code ${code})`));
    });
  });
}

function findOutput(root: string, plan: Plan): string {
  const candidates = [...plan.outputs, ...OUTPUT_DIRS.filter((d) => !plan.outputs.includes(d))];
  for (const d of candidates) {
    const dir = path.resolve(root, d);
    if (!dir.startsWith(root)) continue;
    if (hasIndex(dir)) return dir;
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

function isSafeGitUrl(u: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(u) && !u.startsWith('-');
}

async function gitClone(appId: string, url: string, dest: string, branch?: string) {
  if (!isSafeGitUrl(url)) throw new BuildError('Only http(s) git URLs are supported');
  if (branch && !/^[\w./-]+$/.test(branch)) throw new BuildError('Invalid branch name');
  const args = ['-c', 'protocol.file.allow=never', '-c', 'core.symlinks=false', 'clone', '--depth', '1', '--single-branch', ...(branch ? ['--branch', branch] : []), '--', url, dest];
  log(appId, `$ git ${args.join(' ')}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', args, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const onData = (b: Buffer) => fs.appendFileSync(paths.appLog(appId), b);
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => child.kill('SIGKILL'), 5 * 60 * 1000);
    child.on('error', (e) => reject(new BuildError(`git failed: ${e.message}`)));
    child.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new BuildError(`git clone failed (exit code ${code}). Is the repository public and the branch correct?`));
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
  try {
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
    const root = findProjectRoot(source, meta.subdir);
    log(appId, `Project root: ${path.relative(source, root) || '.'}`);

    step(appId, 'Detecting framework');
    const plan = detect(root, source);
    log(appId, `Framework: ${plan.framework}${plan.pm ? `, package manager: ${plan.pm}` : ''}`);
    plan.notes.forEach((n) => log(appId, n));
    setApp(appId, { framework: plan.framework });

    let outDir: string;
    if (plan.staticDir) {
      outDir = plan.staticDir;
    } else {
      step(appId, `Installing dependencies and building (${config.buildMode === 'docker' ? `docker ${BUILD_IMAGE}` : 'local'})`);
      const script = buildScript(plan, root, source, (s) => log(appId, s));
      await runShell(appId, source, root, script);
      outDir = findOutput(root, plan);
    }

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
    const tail = logTail(appId);
    setApp(appId, { status: 'failed', error: `${msg}\n\n${tail}`.slice(0, 5000) });
  }
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
