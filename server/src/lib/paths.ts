import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '../../..');
const root = path.resolve(repoRoot, process.env.DATA_DIR || './data');

export const paths = {
  root,
  dbFile: path.join(root, 'thinkaloud.db'),
  /** data/apps/<appId>/{source,dist,build.log} */
  app: (appId: string) => path.join(root, 'apps', appId),
  appSource: (appId: string) => path.join(root, 'apps', appId, 'source'),
  appDist: (appId: string) => path.join(root, 'apps', appId, 'dist'),
  appLog: (appId: string) => path.join(root, 'apps', appId, 'build.log'),
  /** data/sessions/<sessionId>/{rrweb-000001.json, audio-000001.webm, ...} */
  session: (sessionId: string) => path.join(root, 'sessions', sessionId),
  /** data/consent/<studyId>/ — uploaded consent documents (originals). */
  consentDir: (studyId: string) => confined(path.join(root, 'consent'), studyId),
  /** data/consent/<studyId>/<docId> — never escapes data/consent (ids are validated). */
  consentFile: (studyId: string, docId: string) => confined(confined(path.join(root, 'consent'), studyId), docId),
  /** Built web SPA (web/dist) and probe bundle (probe/dist/probe.js). */
  webDist: path.join(repoRoot, 'web', 'dist'),
  probeBundle: path.join(repoRoot, 'probe', 'dist', 'probe.js'),
};

/** Join one id segment under base, refusing anything that is not a plain id or resolves outside base. */
export function confined(base: string, segment: string): string {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(segment)) throw new Error(`Unsafe path segment: ${JSON.stringify(segment).slice(0, 60)}`);
  const resolved = path.resolve(base, segment);
  if (path.dirname(resolved) !== path.resolve(base)) throw new Error('Path escapes its directory');
  return resolved;
}
