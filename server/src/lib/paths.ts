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
  /** Built web SPA (web/dist) and probe bundle (probe/dist/probe.js). */
  webDist: path.join(repoRoot, 'web', 'dist'),
  probeBundle: path.join(repoRoot, 'probe', 'dist', 'probe.js'),
};
