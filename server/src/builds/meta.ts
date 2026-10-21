// Per-app build metadata that has no DB column (kept in DATA_DIR/apps/<id>/meta.json).
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../lib/paths.ts';

export interface AppMeta {
  /** External URL apps: serve through the app host reverse proxy with the probe injected. */
  proxy?: boolean;
  /** Monorepo: project lives in this subdirectory of the upload/repo. */
  subdir?: string;
  /** Git: branch/tag to clone. */
  branch?: string;
  /** Original upload filename. */
  fileName?: string;
}

const file = (appId: string) => path.join(paths.app(appId), 'meta.json');

export function readMeta(appId: string): AppMeta {
  try {
    return JSON.parse(fs.readFileSync(file(appId), 'utf8')) as AppMeta;
  } catch {
    return {};
  }
}

export function writeMeta(appId: string, patch: AppMeta): AppMeta {
  const next = { ...readMeta(appId), ...patch };
  fs.mkdirSync(paths.app(appId), { recursive: true });
  fs.writeFileSync(file(appId), JSON.stringify(next, null, 2));
  return next;
}

export const uploadZipPath = (appId: string) => path.join(paths.app(appId), 'upload.zip');
