// App builds API — see docs/API.md "Builds & app host".
import fs from 'node:fs';
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { newId } from '@thinkaloud/shared';
import { db } from '../db.ts';
import { config } from '../lib/config.ts';
import { paths } from '../lib/paths.ts';
import { assertChildAccess, assertStudyAccess, requireUser } from '../lib/auth.ts';
import { HttpError, parse } from '../lib/http.ts';
import { appFromRow } from '../lib/repo.ts';
import { hostedAppUrl } from '../apphost/urls.ts';
import { cancelBuild, enqueueBuild, isSafeGitUrl, tmpUploadDir } from './pipeline.ts';
import { buildSettingsOf, readMeta, uploadZipPath, writeMeta, type BuildSettings } from './meta.ts';
import { validateEnv } from './plan.ts';
import { assertPublicUrl, SsrfError } from '../lib/ssrf.ts';
import { containerLogs, runtimeInfo, stopRuntime } from './runtime.ts';

export const buildsRouter = Router();

const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB || 1024) * 1024 * 1024;
const upload = multer({ dest: tmpUploadDir(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 20 } });

/** Run multer only for multipart requests; JSON bodies are already parsed by express.json(). */
function maybeMultipart(req: Request, res: Response, next: NextFunction) {
  if (!req.is('multipart/form-data')) return next();
  upload.single('file')(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      return next(new HttpError(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, err.code === 'LIMIT_FILE_SIZE' ? `Zip is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB. Leave out node_modules, .git and build folders and try again.` : err.message));
    }
    next(err);
  });
}

function getAppRow(id: string) {
  return db.prepare('SELECT * FROM apps WHERE id = ?').get(id) as Record<string, unknown>;
}

function toApi(row: Record<string, unknown>) {
  const app = appFromRow(row);
  const meta = readMeta(app.id);
  if (row.source_kind === 'url') return { ...app, proxy: Boolean(meta.proxy) };
  return { ...app, buildSettings: buildSettingsOf(meta), ...(meta.server ? { runtime: runtimeInfo(app.id) } : {}) };
}

// Build settings (uploads / git). Empty strings and null clear a setting.
const optStr = (max: number) => z.union([z.string().trim().max(max), z.null()]).optional();
const SettingsBody = z.object({
  env: z.union([z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])), z.null()]).optional(),
  buildCommand: optStr(2000),
  outputDir: optStr(300),
  startCommand: optStr(2000),
  mode: z.union([z.enum(['auto', 'static', 'server']), z.null()]).optional(),
  nodeVersion: z.union([z.string().trim().regex(/^(|\d{2}(\.\d+){0,2})$/, 'Node version must look like "20" or "22.11"'), z.null()]).optional(),
});

function settingsPatch(raw: unknown): BuildSettings {
  const b = parse(SettingsBody, raw ?? {});
  const out: Record<string, unknown> = {};
  if (b.env !== undefined) {
    try {
      const env = b.env === null ? {} : validateEnv(b.env);
      out.env = Object.keys(env).length ? env : undefined;
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  }
  for (const k of ['buildCommand', 'outputDir', 'startCommand', 'nodeVersion'] as const) if (b[k] !== undefined) out[k] = b[k] || undefined;
  if (b.mode !== undefined) out.mode = b.mode && b.mode !== 'auto' ? b.mode : undefined;
  if (typeof out.outputDir === 'string' && (out.outputDir as string).split(/[\\/]/).includes('..')) throw new HttpError(400, 'Invalid outputDir');
  return out as BuildSettings;
}

/** Multipart fields arrive as strings: env is JSON. */
function settingsFromMultipart(body: Record<string, unknown>): BuildSettings {
  const raw: Record<string, unknown> = {};
  for (const k of ['buildCommand', 'outputDir', 'startCommand', 'mode', 'nodeVersion']) if (typeof body[k] === 'string' && body[k]) raw[k] = body[k];
  if (typeof body.env === 'string' && body.env.trim()) {
    try {
      raw.env = JSON.parse(body.env);
    } catch {
      throw new HttpError(400, '"env" must be a JSON object');
    }
  }
  return settingsPatch(raw);
}

const httpUrl = z
  .string()
  .trim()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), 'Must be an http(s) URL');

const UrlBody = z.object({ name: z.string().trim().min(1).max(200), url: httpUrl, proxy: z.boolean().optional() });
const GitBody = z.object({
  name: z.string().trim().min(1).max(200),
  gitUrl: z.string().trim().max(1000).refine(isSafeGitUrl, 'Use an https:// git URL (or git@host:owner/repo.git when SSH clones are enabled)'),
  branch: z.string().trim().max(200).regex(/^[\w./-]*$/, 'Invalid branch').optional(),
  subdir: z.string().trim().max(500).optional(),
});
const PatchBody = z.object({ name: z.string().trim().min(1).max(200).optional(), url: httpUrl.optional(), proxy: z.boolean().optional() }).passthrough();
const SETTING_FIELDS = ['env', 'buildCommand', 'outputDir', 'startCommand', 'mode', 'nodeVersion'];

function insertApp(studyId: string, name: string, sourceKind: 'upload' | 'url' | 'git', fields: { sourceUrl?: string | null; status: string; url?: string | null; instrumented?: boolean }) {
  const id = newId('app');
  const now = Date.now();
  db.prepare(
    `INSERT INTO apps (id, study_id, name, source_kind, source_url, framework, status, error, url, instrumented, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'unknown', ?, NULL, ?, ?, ?, ?)`,
  ).run(id, studyId, name, sourceKind, fields.sourceUrl ?? null, fields.status, fields.url ?? null, fields.instrumented ? 1 : 0, now, now);
  fs.mkdirSync(paths.app(id), { recursive: true });
  return id;
}

/** SSRF guard for proxied external URLs (re-checked on every proxied request by the app host). */
async function assertProxyable(url: string) {
  try {
    await assertPublicUrl(url);
  } catch (e) {
    if (e instanceof SsrfError) throw new HttpError(400, e.message);
    throw e;
  }
}

const externalFields = (id: string, url: string, proxy: boolean) => ({ url: proxy ? hostedAppUrl(id, url) : url, instrumented: proxy ? 1 : 0 });

buildsRouter.get('/studies/:id/apps', requireUser, (req, res) => {
  assertStudyAccess(req, req.params.id as string);
  const rows = db.prepare('SELECT * FROM apps WHERE study_id = ? ORDER BY created_at DESC').all(req.params.id as string) as Record<string, unknown>[];
  res.json({ apps: rows.map(toApi) });
});

buildsRouter.post('/studies/:id/apps', requireUser, maybeMultipart, async (req, res) => {
  const studyId = req.params.id as string;
  try {
    assertStudyAccess(req, studyId);
  } catch (e) {
    if (req.file) fs.rmSync(req.file.path, { force: true });
    throw e;
  }

  if (req.file) {
    const file = req.file;
    try {
      const fd = fs.openSync(file.path, 'r');
      const magic = Buffer.alloc(4);
      fs.readSync(fd, magic, 0, 4, 0);
      fs.closeSync(fd);
      if (magic.readUInt32LE(0) !== 0x04034b50) throw new HttpError(400, 'File must be a .zip archive');
      const name = String(req.body?.name || file.originalname.replace(/\.zip$/i, '') || 'App').trim().slice(0, 200) || 'App';
      const subdir = typeof req.body?.subdir === 'string' && req.body.subdir.trim() ? req.body.subdir.trim() : undefined;
      if (subdir && subdir.split(/[\\/]/).includes('..')) throw new HttpError(400, 'Invalid subdir');
      const settings = settingsFromMultipart(req.body ?? {});
      const id = insertApp(studyId, name, 'upload', { status: 'queued' });
      fs.renameSync(file.path, uploadZipPath(id));
      writeMeta(id, { subdir, fileName: file.originalname, ...settings });
      enqueueBuild(id);
      res.json({ app: toApi(getAppRow(id)) });
    } finally {
      fs.rmSync(file.path, { force: true });
    }
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  if (req.is('multipart/form-data') && !body.url && !body.gitUrl) throw new HttpError(400, 'Missing "file" (zip upload)');
  if (body.gitUrl) {
    const b = parse(GitBody, body);
    const settings = settingsPatch(Object.fromEntries(SETTING_FIELDS.filter((k) => body[k] !== undefined).map((k) => [k, body[k]])));
    const id = insertApp(studyId, b.name, 'git', { sourceUrl: b.gitUrl, status: 'queued' });
    writeMeta(id, { branch: b.branch || undefined, subdir: b.subdir || undefined, ...settings });
    enqueueBuild(id);
    res.json({ app: toApi(getAppRow(id)) });
    return;
  }
  if (body.url) {
    const b = parse(UrlBody, body);
    const id = newId('app');
    const proxy = Boolean(b.proxy);
    if (proxy) await assertProxyable(b.url);
    const f = externalFields(id, b.url, proxy);
    const now = Date.now();
    db.prepare(
      `INSERT INTO apps (id, study_id, name, source_kind, source_url, framework, status, error, url, instrumented, created_at, updated_at)
       VALUES (?, ?, ?, 'url', ?, 'unknown', 'ready', NULL, ?, ?, ?, ?)`,
    ).run(id, studyId, b.name, b.url, f.url, f.instrumented, now, now);
    writeMeta(id, { proxy });
    res.json({ app: toApi(getAppRow(id)) });
    return;
  }
  throw new HttpError(400, 'Provide a zip "file" (multipart), a "url", or a "gitUrl"');
});

buildsRouter.get('/apps/:id', requireUser, (req, res) => {
  const row = assertChildAccess(req, 'apps', req.params.id as string);
  res.json({ app: toApi(row) });
});

buildsRouter.get('/apps/:id/log', requireUser, (req, res) => {
  const row = assertChildAccess(req, 'apps', req.params.id as string);
  res.type('text/plain; charset=utf-8').setHeader('Cache-Control', 'no-store');
  const file = paths.appLog(row.id as string);
  if (!fs.existsSync(file)) {
    res.send(row.source_kind === 'url' ? 'External URL — nothing to build.\n' : '');
    return;
  }
  let text = fs.readFileSync(file, 'utf8');
  if (readMeta(row.id as string).server) {
    const info = runtimeInfo(row.id as string);
    const logs = containerLogs(row.id as string, 200);
    text += `\n── Server: ${info.state}${info.container ? ` (container ${info.container})` : ''}${info.error ? ` — ${info.error}` : ''} ──\n${logs || '(no server output yet)'}\n`;
  }
  res.send(text);
});

buildsRouter.post('/apps/:id/rebuild', requireUser, (req, res) => {
  const row = assertChildAccess(req, 'apps', req.params.id as string);
  if (row.source_kind === 'url') throw new HttpError(400, 'External URL apps are not built');
  if (row.source_kind === 'upload' && !fs.existsSync(uploadZipPath(row.id as string))) throw new HttpError(400, 'Original upload is missing — upload the zip again');
  enqueueBuild(row.id as string);
  res.json({ app: toApi(getAppRow(row.id as string)) });
});

buildsRouter.patch('/apps/:id', requireUser, async (req, res) => {
  const row = assertChildAccess(req, 'apps', req.params.id as string);
  const b = parse(PatchBody, req.body ?? {});
  const id = row.id as string;
  if ((b.url !== undefined || b.proxy !== undefined) && row.source_kind !== 'url') throw new HttpError(400, '"url" and "proxy" only apply to external URL apps');
  const raw = (req.body ?? {}) as Record<string, unknown>;
  if (SETTING_FIELDS.some((k) => raw[k] !== undefined)) {
    if (row.source_kind === 'url') throw new HttpError(400, 'Build settings only apply to uploaded or git apps');
    writeMeta(id, settingsPatch(Object.fromEntries(SETTING_FIELDS.filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]]))));
  }
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  if (b.name !== undefined) {
    sets.push('name = ?');
    vals.push(b.name);
  }
  if (row.source_kind === 'url' && (b.url !== undefined || b.proxy !== undefined)) {
    const sourceUrl = b.url ?? String(row.source_url);
    const proxy = b.proxy ?? Boolean(readMeta(id).proxy);
    if (proxy) await assertProxyable(sourceUrl);
    writeMeta(id, { proxy });
    const f = externalFields(id, sourceUrl, proxy);
    sets.push('source_url = ?', 'url = ?', 'instrumented = ?');
    vals.push(sourceUrl, f.url, f.instrumented);
  }
  if (sets.length) db.prepare(`UPDATE apps SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, Date.now(), id);
  res.json({ app: toApi(getAppRow(id)) });
});

buildsRouter.delete('/apps/:id', requireUser, async (req, res) => {
  const row = assertChildAccess(req, 'apps', req.params.id as string);
  const id = row.id as string;
  cancelBuild(id);
  await stopRuntime(id);
  db.prepare('DELETE FROM apps WHERE id = ?').run(id);
  fs.rmSync(paths.app(id), { recursive: true, force: true });
  res.json({ ok: true });
});

buildsRouter.get('/apps/:id/snippet', requireUser, (req, res) => {
  assertChildAccess(req, 'apps', req.params.id as string);
  res.json({ html: `<script src="${config.publicUrl}/probe.js" async></script>` });
});
