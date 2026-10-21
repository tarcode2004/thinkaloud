// Pure helpers for the build pipeline (no DB / docker): Node version selection, server-mode
// detection, env var hints and build-failure diagnosis. Unit-tested in plan.test.ts.
import fs from 'node:fs';
import path from 'node:path';

export interface PkgJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
  workspaces?: unknown;
  engines?: { node?: string };
  volta?: { node?: string };
}

const read = (f: string) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return undefined;
  }
};

// ── Node version ────────────────────────────────────────────────────────────
export const NODE_MAJORS = [18, 20, 22, 24];
export const DEFAULT_NODE = 22;
const LTS_NAMES: Record<string, number> = { hydrogen: 18, iron: 20, jod: 22, krypton: 24 };

/**
 * Pick a supported Node major for a version spec (.nvmrc content or engines.node range).
 * Exact-ish specs ("20", "v20.11.1", "20.x", "^20", "~20.3", "lts/iron") → that major.
 * Ranges (">=18", ">=18 <21", "18 || 20") → the default (22) if allowed, else the highest allowed.
 */
export function nodeMajorFromSpec(spec: string | undefined): number | undefined {
  if (!spec) return undefined;
  const s = spec.trim().toLowerCase();
  if (!s || s === 'node' || s === 'stable' || s === 'latest' || s === 'current' || s === '*') return undefined;
  const lts = s.match(/^lts\/(\w+)/);
  if (lts) return LTS_NAMES[lts[1]] ?? (lts[1] === '*' ? undefined : undefined);
  const allowed = (m: number) =>
    s.split('||').some((set) => {
      const comps = set.trim().split(/\s+/).filter(Boolean);
      if (!comps.length) return true;
      // hyphen range "18 - 20"
      if (comps.length === 3 && comps[1] === '-') return m >= majorNum(comps[0]) && m <= majorNum(comps[2]);
      return comps.every((c) => {
        const op = c.match(/^(>=|<=|>|<|=|\^|~)?v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/);
        if (!op) return true;
        const maj = Number(op[2]);
        const minor = op[3] && /^\d+$/.test(op[3]) ? Number(op[3]) : 0;
        const patch = op[4] && /^\d+$/.test(op[4]) ? Number(op[4]) : 0;
        switch (op[1]) {
          case '>=':
            return m >= maj;
          case '>':
            return m > maj || (m === maj && (minor > 0 || patch > 0 || !!op[3]));
          case '<':
            return m < maj || (m === maj && (minor > 0 || patch > 0));
          case '<=':
            return m <= maj;
          default:
            return m === maj; // =, ^, ~, bare
        }
      });
    });
  const ok = NODE_MAJORS.filter(allowed);
  if (!ok.length) {
    const n = majorNum(s);
    return n || undefined;
  }
  return ok.includes(DEFAULT_NODE) ? DEFAULT_NODE : ok[ok.length - 1];
}
const majorNum = (v: string) => Number((v.match(/(\d+)/) || [])[1]) || 0;

/** Where the Node version came from, and which major to use. */
export function pickNode(root: string, top: string, pkg: PkgJson | null, override?: string): { major: number; source: string } {
  const tries: [string, string | undefined][] = [['build settings', override]];
  for (let dir = root; ; dir = path.dirname(dir)) {
    tries.push([`${path.relative(top, path.join(dir, '.nvmrc')) || '.nvmrc'}`, read(path.join(dir, '.nvmrc'))?.split('\n')[0]]);
    tries.push([`${path.relative(top, path.join(dir, '.node-version')) || '.node-version'}`, read(path.join(dir, '.node-version'))?.split('\n')[0]]);
    const tv = read(path.join(dir, '.tool-versions'))?.match(/^(?:nodejs|node)\s+(\S+)/m)?.[1];
    tries.push(['.tool-versions', tv]);
    if (dir === top || !dir.startsWith(top) || path.dirname(dir) === dir) break;
  }
  tries.push(['package.json volta.node', pkg?.volta?.node], ['package.json engines.node', pkg?.engines?.node]);
  for (const [source, spec] of tries) {
    const m = nodeMajorFromSpec(spec);
    if (m) return { major: m, source: `${source} (${String(spec).trim()})` };
  }
  return { major: DEFAULT_NODE, source: 'default' };
}

// ── Server-mode detection ───────────────────────────────────────────────────
const NEXT_CONFIGS = ['next.config.js', 'next.config.mjs', 'next.config.cjs', 'next.config.ts', 'next.config.mts'];

export function nextConfigSource(root: string): { file?: string; src: string } {
  for (const f of NEXT_CONFIGS) {
    const src = read(path.join(root, f));
    if (src !== undefined) return { file: f, src };
  }
  return { src: '' };
}

export const nextHasStaticExport = (root: string) => /output\s*:\s*['"`]export['"`]/.test(nextConfigSource(root).src);

function walk(dir: string, visit: (file: string) => boolean | void, depth = 0, budget = { n: 4000 }) {
  if (depth > 12 || budget.n <= 0) return;
  let ents: fs.Dirent[];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    if (budget.n-- <= 0) return;
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, visit, depth + 1, budget);
    else if (e.isFile() && visit(p) === true) return;
  }
}

/** Reasons a Next.js project needs a running server (empty → a static export is possible). */
export function nextServerReasons(root: string): string[] {
  const reasons: string[] = [];
  const { file, src } = nextConfigSource(root);
  if (/output\s*:\s*['"`]export['"`]/.test(src)) return [];
  reasons.push(file ? `${file} does not set output: 'export'` : "no next.config with output: 'export'");
  if (/\b(redirects|rewrites|headers)\s*(\(|:)/.test(src)) reasons.push(`${file} defines redirects/rewrites/headers`);
  const appDirs = ['app', 'src/app'].map((d) => path.join(root, d)).filter((d) => fs.existsSync(d));
  const pagesDirs = ['pages', 'src/pages'].map((d) => path.join(root, d)).filter((d) => fs.existsSync(d));
  const found = new Set<string>();
  for (const d of appDirs)
    walk(d, (f) => {
      const rel = path.relative(root, f);
      if (/(^|[\\/])route\.(t|j)sx?$/.test(f)) found.add(`route handler ${rel}`);
      else if (/\.(t|j)sx?$/.test(f) && found.size < 12) {
        const s = read(f) || '';
        if (/^\s*['"]use server['"]/m.test(s)) found.add(`server action ${rel}`);
        else if (/export\s+const\s+dynamic\s*=\s*['"]force-dynamic['"]/.test(s)) found.add(`force-dynamic ${rel}`);
      }
      return found.size >= 12;
    });
  for (const d of pagesDirs)
    walk(d, (f) => {
      const rel = path.relative(root, f);
      if (/[\\/]api[\\/]/.test(rel)) found.add(`API route ${rel}`);
      else if (/getServerSideProps/.test(read(f) || '')) found.add(`getServerSideProps in ${rel}`);
      return found.size >= 12;
    });
  for (const m of ['middleware.ts', 'middleware.js', 'src/middleware.ts', 'src/middleware.js'])
    if (fs.existsSync(path.join(root, m))) found.add(`middleware ${m}`);
  return [...reasons, ...[...found].slice(0, 8)];
}

/** Non-Next frameworks that are hosted as a long-running Node server. */
export function nodeServerFramework(pkg: PkgJson): string | undefined {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const start = pkg.scripts?.start || '';
  if (deps.nuxt && !/generate/.test(pkg.scripts?.build || '')) return 'Nuxt';
  if (deps['@remix-run/serve'] || /remix-serve/.test(start)) return 'Remix';
  if (deps['@react-router/serve'] || /react-router-serve/.test(start)) return 'React Router (SSR)';
  if (deps['@sveltejs/adapter-node']) return 'SvelteKit (adapter-node)';
  if (deps['@astrojs/node']) return 'Astro (node adapter)';
  if (start && /\b(node|tsx|ts-node|bun)\b/.test(start) && (deps.express || deps.fastify || deps.koa || deps.hono || deps['@hono/node-server'])) return 'Node server';
  return undefined;
}

// ── Env vars ────────────────────────────────────────────────────────────────
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const RESERVED_ENV = new Set(['HOME', 'PATH', 'PWD', 'USER', 'SHELL', 'HOSTNAME', 'npm_config_cache', 'COREPACK_HOME', 'NODE_ENV']);

export function validateEnv(env: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const entries = Object.entries(env);
  if (entries.length > 100) throw new Error('At most 100 environment variables');
  for (const [k, v] of entries) {
    if (!ENV_KEY_RE.test(k)) throw new Error(`Invalid environment variable name "${k}"`);
    if (RESERVED_ENV.has(k)) throw new Error(`"${k}" cannot be overridden`);
    const s = v == null ? '' : String(v);
    if (s.length > 8192) throw new Error(`Value of ${k} is too long`);
    out[k] = s;
  }
  return out;
}

const PUBLIC_PREFIX = /\b((?:VITE|EXPO_PUBLIC|NEXT_PUBLIC|REACT_APP|PUBLIC|NUXT_PUBLIC)_[A-Z0-9_]+)\b/g;

/** Public build-time env keys the project references (source + .env.example) that are not set anywhere. */
export function missingEnvHints(root: string, provided: Record<string, string> = {}): string[] {
  const referenced = new Set<string>();
  const defined = new Set(Object.keys(provided));
  for (const f of ['.env', '.env.local', '.env.production', '.env.production.local']) {
    for (const line of (read(path.join(root, f)) || '').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (m) defined.add(m[1]);
    }
  }
  for (const f of ['.env.example', '.env.sample', '.env.template', '.env.local.example', '.env.dist']) {
    for (const line of (read(path.join(root, f)) || '').split('\n')) {
      const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/);
      if (m && /^(VITE|EXPO_PUBLIC|NEXT_PUBLIC|REACT_APP|PUBLIC|NUXT_PUBLIC)_/.test(m[1])) referenced.add(m[1]);
    }
  }
  for (const d of ['src', 'app', 'components', 'lib', 'providers', 'utils', 'hooks', 'services', 'config', 'constants']) {
    walk(path.join(root, d), (f) => {
      if (!/\.(m?[jt]sx?|vue|svelte)$/.test(f)) return;
      const s = read(f) || '';
      for (const m of s.matchAll(PUBLIC_PREFIX)) referenced.add(m[1]);
    });
  }
  for (const f of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    if (/^(app\.config|vite\.config|next\.config)\./.test(f)) for (const m of (read(path.join(root, f)) || '').matchAll(PUBLIC_PREFIX)) referenced.add(m[1]);
  }
  return [...referenced].filter((k) => !defined.has(k)).sort();
}

// ── Failure diagnosis ───────────────────────────────────────────────────────
/** Turn a failed build log into concrete "what to change" hints for the researcher. */
export function diagnose(log: string, ctx: { framework?: string; envMissing?: string[] } = {}): string[] {
  const hints: string[] = [];
  const add = (h: string) => !hints.includes(h) && hints.push(h);
  const nativeOnly = [...log.matchAll(/Importing native-only module "([^"]+)" on web from: (\S+)/g)];
  for (const m of nativeOnly.slice(0, 3)) {
    const pkg = m[2].match(/node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1] || m[2];
    add(`${pkg} uses the native-only module ${m[1]} and has no web support. Guard it with Platform.OS !== 'web', or add a ${'`'}.web.tsx${'`'} file that renders a placeholder, then re-upload.`);
  }
  const unresolved = log.match(/Unable to resolve (?:module )?["']?([^"'\s]+)["']? from ["']?([^"'\s]+)/);
  if (unresolved) add(`Metro could not resolve "${unresolved[1]}" (imported from ${unresolved[2]}). Add the package to package.json, or if it is native-only, provide a .web.tsx alternative.`);
  const vite = log.match(/(?:Rollup failed to resolve import|Could not resolve|Failed to resolve import) ["']([^"']+)["'] from ["']([^"']+)["']/);
  if (vite) add(`The build cannot find "${vite[1]}" (imported from ${vite[2]}). Add the missing package to package.json, or include the missing file in the upload.`);
  if (/ERESOLVE|peer dep|Conflicting peer dependency/i.test(log)) add('npm could not resolve peer dependencies. Commit an up-to-date package-lock.json, or set the build command to run with --legacy-peer-deps.');
  if (/JavaScript heap out of memory|Reached heap limit|exit code 137|Killed\s*$/m.test(log)) add('The build ran out of memory (the container was killed). Ask the server admin to raise BUILD_MEMORY (default 8g); if Node itself reports "heap out of memory", also set NODE_OPTIONS=--max-old-space-size=6144 in the environment variables.');
  if (/The engine "node" is incompatible|Unsupported engine|requires? (?:a )?Node(?:\.js)? (?:version )?[>=^~]*\s*v?(\d+)/i.test(log)) add('The project needs a different Node.js version. Set "Node version" in Build settings (or add an .nvmrc), then rebuild.');
  if (/error TS\d+/.test(log)) add('TypeScript reported type errors. Set the build command to skip type checking (for Vite: "npx vite build"), or fix the errors.');
  if (/Missing script: "?build"?/.test(log)) add('package.json has no "build" script. Set a build command in Build settings.');
  if (/ENOSPC/.test(log)) add('The server ran out of disk space during the build.');
  if (/ETIMEDOUT|ECONNRESET|EAI_AGAIN|getaddrinfo/.test(log)) add('A network request failed while installing packages. Try rebuilding; if it keeps failing, the registry or a git dependency may be unreachable.');
  if (/(window|document|localStorage|navigator) is not defined/.test(log)) add('Code touches window/document/localStorage while pages are pre-rendered on the server. Move that code into useEffect or guard it with typeof window !== "undefined".');
  if (/missing "generateStaticParams\(\)"|cannot be used with "output: export"|Page with `dynamic = "force-dynamic"` couldn't be exported|API Routes cannot be used with "output: export"/.test(log))
    add("This Next.js app uses server features that a static export cannot include. Set Hosting mode to \"Server\" in Build settings to run it with next start.");
  if (/No address provided to ConvexReactClient|Missing Publishable Key|publishableKey|supabaseUrl is required|must be defined in environment variables/i.test(log) || (ctx.envMissing?.length && /undefined|not defined|required/i.test(log)))
    add(`The app needs environment variables at build time${ctx.envMissing?.length ? ` (referenced but not set: ${ctx.envMissing.slice(0, 8).join(', ')})` : ''}. Add them under Build settings → Environment variables, then rebuild.`);
  if (/timed out after/.test(log)) add('The build hit the time limit. Heavy steps (obfuscation, image optimisation, sourcemaps) can usually be turned off with an env var or a lighter build command.');
  return hints;
}

// ── Expo ────────────────────────────────────────────────────────────────────
/** The configured Expo `web.output` ('single' | 'static' | 'server'), from app.json or a literal in app.config.*. */
export function expoWebOutput(root: string): string | undefined {
  for (const f of ['app.config.ts', 'app.config.js', 'app.config.mjs', 'app.config.cjs']) {
    const m = read(path.join(root, f))?.match(/output\s*:\s*['"`](single|static|server)['"`]/);
    if (m) return m[1];
  }
  try {
    const j = JSON.parse(read(path.join(root, 'app.json')) || '{}');
    return (j.expo || j)?.web?.output;
  } catch {
    return undefined;
  }
}

/** Node script (run in the project root) that switches Expo web.output to "single" (a plain SPA export). */
export const EXPO_SINGLE_SCRIPT = `const fs=require('fs');let done=false;
try{if(fs.existsSync('app.json')){const j=JSON.parse(fs.readFileSync('app.json','utf8'));const e=j.expo||j;if(e.web&&e.web.output&&e.web.output!=='single'){e.web.output='single';fs.writeFileSync('app.json',JSON.stringify(j,null,2));done=true}}}catch(err){console.log('could not edit app.json: '+err.message)}
for(const f of ['app.config.ts','app.config.js','app.config.mjs','app.config.cjs']){if(!fs.existsSync(f))continue;const s=fs.readFileSync(f,'utf8');const n=s.replace(/(output\\s*:\\s*)(['"\`])(static|server)\\2/g,'$1$2single$2');if(n!==s){fs.writeFileSync(f,n);done=true}}
console.log(done?'Expo web.output set to "single"':'Expo web.output unchanged');
`;

/** Expo Router API routes (+api.ts) cannot run in a static export. */
export function expoApiRoutes(root: string): string[] {
  const out: string[] = [];
  for (const d of ['app', 'src/app']) walk(path.join(root, d), (f) => { if (/\+api\.[jt]sx?$/.test(f)) out.push(path.relative(root, f)); return out.length > 5; });
  return out;
}

// ── Monorepos ───────────────────────────────────────────────────────────────
const FRAMEWORK_DEPS: [string, string][] = [['expo', 'Expo'], ['next', 'Next.js'], ['react-scripts', 'Create React App'], ['@angular/core', 'Angular'], ['nuxt', 'Nuxt'], ['@react-router/dev', 'React Router'], ['@remix-run/dev', 'Remix'], ['@sveltejs/kit', 'SvelteKit'], ['astro', 'Astro'], ['vite', 'Vite']];

export const isWorkspaceRoot = (root: string, pkg: PkgJson | null) => !!pkg?.workspaces || fs.existsSync(path.join(root, 'pnpm-workspace.yaml')) || fs.existsSync(path.join(root, 'lerna.json'));

export function frameworkLabel(pkg: PkgJson | null): string | undefined {
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  return FRAMEWORK_DEPS.find(([d]) => deps[d])?.[1];
}

/** Workspace packages (depth ≤ 3) keyed by name → directory. */
export function workspacePackages(top: string): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (dir: string, depth: number) => {
    if (depth > 3) return;
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const d = path.join(dir, e.name);
      try {
        const p = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')) as PkgJson;
        if (p.name) out.set(p.name, d);
      } catch {
        /* not a package */
      }
      visit(d, depth + 1);
    }
  };
  visit(top, 1);
  return out;
}

/** Monorepo root: the app-looking workspace packages, as {rel, label}. */
export function monorepoApps(top: string): { rel: string; label: string }[] {
  const apps: { rel: string; label: string }[] = [];
  for (const dir of workspacePackages(top).values()) {
    let p: PkgJson | null = null;
    try {
      p = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    const label = frameworkLabel(p);
    const deps = { ...p?.dependencies, ...p?.devDependencies };
    // Skip libraries (UI kits, configs): they have no index.html / app dir / expo dependency of their own.
    const looksLikeApp = deps.expo || deps.next || deps['react-scripts'] || fs.existsSync(path.join(dir, 'index.html')) || fs.existsSync(path.join(dir, 'angular.json')) || fs.existsSync(path.join(dir, 'app')) || fs.existsSync(path.join(dir, 'src', 'app'));
    if (label && looksLikeApp) apps.push({ rel: path.relative(top, dir).split(path.sep).join('/'), label });
  }
  return apps.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** Local workspace dependencies of the app that have a build script (built before the app, deps first). */
export function workspaceDepsToBuild(top: string, root: string): { name: string; rel: string }[] {
  const pkgs = workspacePackages(top);
  const order: { name: string; rel: string }[] = [];
  const seen = new Set<string>();
  const visit = (dir: string, depth: number) => {
    if (depth > 4) return;
    let p: PkgJson;
    try {
      p = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    } catch {
      return;
    }
    for (const [name, spec] of Object.entries({ ...p.dependencies, ...p.devDependencies })) {
      const d = pkgs.get(name);
      if (!d || seen.has(name) || path.resolve(d) === path.resolve(root)) continue;
      if (!/^(workspace:|\*|file:|link:)/.test(spec) && !/^[\^~]?\d/.test(spec)) continue;
      seen.add(name);
      visit(d, depth + 1);
      try {
        const dp = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')) as PkgJson;
        if (dp.scripts?.build) order.push({ name, rel: path.relative(top, d).split(path.sep).join('/') });
      } catch {
        /* skip */
      }
    }
  };
  visit(root, 0);
  return order;
}
