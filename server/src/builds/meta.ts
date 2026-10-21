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
  /** Researcher-provided env vars for build (and runtime, for server apps). Values never logged. */
  env?: Record<string, string>;
  /** Override the framework's build step (install still runs). Runs in the project root. */
  buildCommand?: string;
  /** Override where the static output lives (relative to the project root). */
  outputDir?: string;
  /** Override how a server app is started (default: `next start` / the package "start" script). */
  startCommand?: string;
  /** Hosting mode: auto-detect (default), force static files, or force a long-running server. */
  mode?: 'auto' | 'static' | 'server';
  /** Override the Node.js major used for build/run (default: from .nvmrc / engines.node, else 22). */
  nodeVersion?: string;
  /** Set by the pipeline: the last successful build is a server app (runs in a container). */
  server?: { rel: string; start: string; image: string; framework: string };
}

/** Researcher-editable build settings (subset of AppMeta exposed through the API). */
export const BUILD_SETTING_KEYS = ['env', 'buildCommand', 'outputDir', 'startCommand', 'mode', 'nodeVersion'] as const;
export type BuildSettings = Pick<AppMeta, (typeof BUILD_SETTING_KEYS)[number]>;
export const buildSettingsOf = (m: AppMeta): BuildSettings => Object.fromEntries(BUILD_SETTING_KEYS.filter((k) => m[k] !== undefined).map((k) => [k, m[k]])) as BuildSettings;

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
