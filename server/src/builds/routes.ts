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
import { cancelBuild, enqueueBuild, tmpUploadDir } from './pipeline.ts';
import { readMeta, uploadZipPath, writeMeta } from './meta.ts';

export const buildsRouter = Router();

const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB || 300) * 1024 * 1024;
const upload = multer({ dest: tmpUploadDir(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 20 } });

/** Run multer only for multipart requests; JSON bodies are already parsed by express.json(). */
function maybeMultipart(req: Request, res: Response, next: NextFunction) {
  if (!req.is('multipart/form-data')) return next();
  upload.single('file')(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      return next(new HttpError(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, err.code === 'LIMIT_FILE_SIZE' ? `Zip is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB` : err.message));
    }
    next(err);
  });
}

function getAppRow(id: string) {
  return db.prepare('SELECT * FROM apps WHERE id = ?').get(id) as Record<string, unknown>;
}

function toApi(row: Record<string, unknown>) {
  const app = appFromRow(row);
  return row.source_kind === 'url' ? { ...app, proxy: Boolean(readMeta(app.id).proxy) } : app;
}

const httpUrl = z
  .string()
  .trim()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), 'Must be an http(s) URL');

const UrlBody = z.object({ name: z.string().trim().min(1).max(200), url: httpUrl, proxy: z.boolean().optional() });
const GitBody = z.object({
  name: z.string().trim().min(1).max(200),
  gitUrl: httpUrl,
  branch: z.string().trim().max(200).regex(/^[\w./-]*$/, 'Invalid branch').optional(),
  subdir: z.string().trim().max(500).optional(),
});
const PatchBody = z.object({ name: z.string().trim().min(1).max(200).optional(), url: httpUrl.optional(), proxy: z.boolean().optional() });

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

const externalFields = (id: string, url: string, proxy: boolean) => ({ url: proxy ? hostedAppUrl(id, url) : url, instrumented: proxy ? 1 : 0 });

buildsRouter.get('/studies/:id/apps', requireUser, (req, res) => {
  assertStudyAccess(req, req.params.id as string);
  const rows = db.prepare('SELECT * FROM apps WHERE study_id = ? ORDER BY created_at DESC').all(req.params.id as string) as Record<string, unknown>[];
  res.json({ apps: rows.map(toApi) });
});

buildsRouter.post('/studies/:id/apps', requireUser, maybeMultipart, (req, res) => {
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
      const id = insertApp(studyId, name, 'upload', { status: 'queued' });
      fs.renameSync(file.path, uploadZipPath(id));
      writeMeta(id, { subdir, fileName: file.originalname });
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
    const id = insertApp(studyId, b.name, 'git', { sourceUrl: b.gitUrl, status: 'queued' });
    writeMeta(id, { branch: b.branch || undefined, subdir: b.subdir || undefined });
    enqueueBuild(id);
    res.json({ app: toApi(getAppRow(id)) });
    return;
  }
  if (body.url) {
    const b = parse(UrlBody, body);
    const id = newId('app');
    const proxy = Boolean(b.proxy);
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
  res.send(fs.readFileSync(file, 'utf8'));
});

buildsRouter.post('/apps/:id/rebuild', requireUser, (req, res) => {
  const row = assertChildAccess(req, 'apps', req.params.id as string);
  if (row.source_kind === 'url') throw new HttpError(400, 'External URL apps are not built');
  if (row.source_kind === 'upload' && !fs.existsSync(uploadZipPath(row.id as string))) throw new HttpError(400, 'Original upload is missing — upload the zip again');
  enqueueBuild(row.id as string);
  res.json({ app: toApi(getAppRow(row.id as string)) });
});

buildsRouter.patch('/apps/:id', requireUser, (req, res) => {
  const row = assertChildAccess(req, 'apps', req.params.id as string);
  const b = parse(PatchBody, req.body ?? {});
  const id = row.id as string;
  if ((b.url !== undefined || b.proxy !== undefined) && row.source_kind !== 'url') throw new HttpError(400, '"url" and "proxy" only apply to external URL apps');
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  if (b.name !== undefined) {
    sets.push('name = ?');
    vals.push(b.name);
  }
  if (row.source_kind === 'url' && (b.url !== undefined || b.proxy !== undefined)) {
    const sourceUrl = b.url ?? String(row.source_url);
    const proxy = b.proxy ?? Boolean(readMeta(id).proxy);
    writeMeta(id, { proxy });
    const f = externalFields(id, sourceUrl, proxy);
    sets.push('source_url = ?', 'url = ?', 'instrumented = ?');
    vals.push(sourceUrl, f.url, f.instrumented);
  }
  if (sets.length) db.prepare(`UPDATE apps SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, Date.now(), id);
  res.json({ app: toApi(getAppRow(id)) });
});

buildsRouter.delete('/apps/:id', requireUser, (req, res) => {
  const row = assertChildAccess(req, 'apps', req.params.id as string);
  const id = row.id as string;
  cancelBuild(id);
  db.prepare('DELETE FROM apps WHERE id = ?').run(id);
  fs.rmSync(paths.app(id), { recursive: true, force: true });
  res.json({ ok: true });
});

buildsRouter.get('/apps/:id/snippet', requireUser, (req, res) => {
  assertChildAccess(req, 'apps', req.params.id as string);
  res.json({ html: `<script src="${config.publicUrl}/probe.js" async></script>` });
});
