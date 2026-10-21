import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { diagnose, expoWebOutput, missingEnvHints, nextServerReasons, nodeMajorFromSpec, nodeServerFramework, pickNode, validateEnv } from './plan.ts';
import { rewriteLocation, stripFrameAncestors } from '../apphost/serverProxy.ts';

function project(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-plan-'));
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  return dir;
}

test('Node version specs map to a supported major', () => {
  assert.equal(nodeMajorFromSpec('22.x'), 22);
  assert.equal(nodeMajorFromSpec('v20.11.1'), 20);
  assert.equal(nodeMajorFromSpec('^18.17'), 18);
  assert.equal(nodeMajorFromSpec('lts/iron'), 20);
  assert.equal(nodeMajorFromSpec('>=18'), 22);
  assert.equal(nodeMajorFromSpec('>=18 <21'), 20);
  assert.equal(nodeMajorFromSpec('18 || 20'), 20);
  assert.equal(nodeMajorFromSpec('>=24'), 24);
  assert.equal(nodeMajorFromSpec('node'), undefined);
  assert.equal(nodeMajorFromSpec(''), undefined);
});

test('pickNode prefers build settings, then .nvmrc, then engines', () => {
  const dir = project({ '.nvmrc': '20\n', 'package.json': '{}' });
  assert.equal(pickNode(dir, dir, { engines: { node: '22.x' } }).major, 20);
  assert.equal(pickNode(dir, dir, { engines: { node: '22.x' } }, '18').major, 18);
  const dir2 = project({ 'package.json': '{}' });
  assert.equal(pickNode(dir2, dir2, { engines: { node: '22.x' } }).major, 22);
  assert.equal(pickNode(dir2, dir2, null).source, 'default');
});

test('Next.js server detection: route handlers / redirects / no export → server; output export → static', () => {
  const server = project({ 'next.config.mjs': 'export default { async redirects() { return [] } }', 'src/app/api/x/route.ts': 'export async function GET() {}', 'src/app/page.tsx': '' });
  const reasons = nextServerReasons(server);
  assert.ok(reasons.some((r) => r.includes('route handler src/app/api/x/route.ts')), reasons.join());
  assert.ok(reasons.some((r) => r.includes('redirects')));
  const stat = project({ 'next.config.js': "module.exports = { output: 'export' }", 'app/page.tsx': '' });
  assert.deepEqual(nextServerReasons(stat), []);
  const actions = project({ 'app/actions.ts': "'use server'\nexport async function a() {}" });
  assert.ok(nextServerReasons(actions).some((r) => r.startsWith('server action')));
});

test('node server frameworks are detected', () => {
  assert.equal(nodeServerFramework({ dependencies: { '@remix-run/serve': '2' }, scripts: { start: 'remix-serve build' } }), 'Remix');
  assert.equal(nodeServerFramework({ dependencies: { nuxt: '3' }, scripts: { build: 'nuxt build' } }), 'Nuxt');
  assert.equal(nodeServerFramework({ dependencies: { nuxt: '3' }, scripts: { build: 'nuxt generate' } }), undefined);
  assert.equal(nodeServerFramework({ dependencies: { express: '4' }, scripts: { start: 'node server.js' } }), 'Node server');
  assert.equal(nodeServerFramework({ dependencies: { react: '18', vite: '5' }, scripts: { build: 'vite build' } }), undefined);
});

test('Expo web.output is read from app.json or app.config', () => {
  assert.equal(expoWebOutput(project({ 'app.json': JSON.stringify({ expo: { web: { output: 'server' } } }) })), 'server');
  assert.equal(expoWebOutput(project({ 'app.config.ts': "export default { web: { output: 'static' } }" })), 'static');
  assert.equal(expoWebOutput(project({ 'app.json': '{"expo":{}}' })), undefined);
});

test('missing public env vars are reported; provided / .env ones are not', () => {
  const dir = project({ '.env.example': 'VITE_SUPABASE_URL=\nSECRET=x\n', 'src/a.ts': 'import.meta.env.VITE_API_KEY; process.env.EXPO_PUBLIC_X', '.env': 'EXPO_PUBLIC_X=1' });
  assert.deepEqual(missingEnvHints(dir, { VITE_API_KEY: 'k' }), ['VITE_SUPABASE_URL']);
});

test('env validation', () => {
  assert.deepEqual(validateEnv({ VITE_A: 1, B_: 'x' }), { VITE_A: '1', B_: 'x' });
  assert.throws(() => validateEnv({ '1BAD': 'x' }));
  assert.throws(() => validateEnv({ PATH: '/x' }));
});

test('diagnose turns common failures into actionable hints', () => {
  assert.match(diagnose('Importing native-only module "react-native/Libraries/Utilities/codegenNativeCommands" on web from: node_modules/react-native-maps/lib/MapView.js').join(), /react-native-maps.*\.web\.tsx/);
  assert.match(diagnose('Killed\n ELIFECYCLE  Command failed with exit code 137.').join(), /memory/);
  assert.match(diagnose('src/App.tsx(3,1): error TS2322: nope').join(), /vite build/);
  assert.match(diagnose('Error: No address provided to ConvexReactClient.', { envMissing: ['EXPO_PUBLIC_CONVEX_URL'] }).join(), /EXPO_PUBLIC_CONVEX_URL/);
  assert.match(diagnose('Error: API Routes cannot be used with "output: export"').join(), /Server/);
  assert.deepEqual(diagnose('all good'), []);
});

test('server proxy header helpers', () => {
  assert.equal(stripFrameAncestors("default-src 'self'; frame-ancestors 'none'"), "default-src 'self'");
  assert.equal(stripFrameAncestors("frame-ancestors 'self'"), undefined);
  assert.equal(rewriteLocation('http://127.0.0.1:32768/home?x=1', 32768, 'http://app-a.localhost:4901/'), 'http://app-a.localhost:4901/home?x=1');
  assert.equal(rewriteLocation('http://localhost:3000/a', 40000, 'https://app-a.apps.example.com/'), 'https://app-a.apps.example.com/a');
  assert.equal(rewriteLocation('/ChineseEVs', 1, 'http://x/'), '/ChineseEVs');
  assert.equal(rewriteLocation('/ChineseEVs', 1, 'http://x/', '/a/app_1'), '/a/app_1/ChineseEVs');
  assert.equal(rewriteLocation('https://github.com/login', 1, 'http://x/'), 'https://github.com/login');
});
