import { Router, type Request } from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { z } from 'zod';
import { emptyProtocol, newId, starterProtocol } from '@thinkaloud/shared';
import { db, json, tx } from '../db.ts';
import { HttpError, parse } from '../lib/http.ts';
import { assertChildAccess, assertStudyAccess, requireUser } from '../lib/auth.ts';
import { paths } from '../lib/paths.ts';
import { normalizeProtocol } from '../lib/protocolSchema.ts';
import { entitlement } from '../billing/account.ts';
import {
  appFromRow,
  linkFromRow,
  linkUrl,
  parseProtocol,
  protocolFromRow,
  studyFromRow,
  variantFromRow,
  type Row,
} from '../lib/repo.ts';

export const studiesRouter = Router();

// Only the paths this router owns require auth (it is mounted on /api next to other routers).
studiesRouter.use(['/studies', '/protocols', '/variants', '/links'], requireUser);

// ── helpers ──────────────────────────────────────────────────────────────────

/** URL-safe random token for public links (no ambiguous characters). */
export function newLinkToken(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(12);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

const touchStudy = (studyId: string) => db.prepare('UPDATE studies SET updated_at = ? WHERE id = ?').run(Date.now(), studyId);

const sid = (req: Request) => String(req.params.id);

function linkWithMeta(r: Row) {
  const link = linkFromRow(r);
  const { n } = db
    .prepare("SELECT COUNT(*) AS n FROM sessions WHERE link_id = ? AND preview = 0 AND status != 'withdrawn'")
    .get(link.id) as { n: number };
  return { ...link, url: linkUrl(link.token), sessionCount: n };
}

function insertProtocol(studyId: string, name: string, protocol: unknown) {
  const now = Date.now();
  const id = newId('prt');
  const p = normalizeProtocol(protocol);
  db.prepare('INSERT INTO protocols (id, study_id, name, protocol, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id, studyId, name, json.str(p), now, now,
  );
  return protocolFromRow(db.prepare('SELECT * FROM protocols WHERE id = ?').get(id) as Row);
}

function insertLink(studyId: string, l: { name: string; variantId?: string | null; maxParticipants?: number | null; expiresAt?: number | null; redirectUrl?: string | null }) {
  const id = newId('lnk');
  db.prepare(
    `INSERT INTO links (id, study_id, token, name, variant_id, max_participants, expires_at, redirect_url, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run(id, studyId, newLinkToken(), l.name, l.variantId ?? null, l.maxParticipants ?? null, l.expiresAt ?? null, l.redirectUrl ?? null, Date.now());
  return db.prepare('SELECT * FROM links WHERE id = ?').get(id) as Row;
}

function assertInStudy(table: 'protocols' | 'apps' | 'variants', id: string, studyId: string, label: string) {
  const row = db.prepare(`SELECT id FROM ${table} WHERE id = ? AND study_id = ?`).get(id, studyId);
  if (!row) throw new HttpError(400, `${label} does not belong to this study`);
}

/** Reasons a study cannot go live (empty = ok). */
export function goLiveProblems(studyId: string): string[] {
  const problems: string[] = [];
  const variants = (db.prepare('SELECT * FROM variants WHERE study_id = ? AND active = 1 ORDER BY created_at').all(studyId) as Row[]).map(variantFromRow);
  if (!variants.length) problems.push('Add at least one active variant.');
  for (const v of variants) {
    const pr = db.prepare('SELECT * FROM protocols WHERE id = ?').get(v.protocolId) as Row | undefined;
    if (!pr) problems.push(`Variant "${v.name}" has no protocol.`);
    else if (!parseProtocol(pr.protocol).steps?.length) problems.push(`Protocol "${pr.name}" (variant "${v.name}") has no steps.`);
    if (v.appId) {
      const app = db.prepare('SELECT * FROM apps WHERE id = ?').get(v.appId) as Row | undefined;
      if (!app) problems.push(`Variant "${v.name}" references a missing app.`);
      else if (app.status !== 'ready') problems.push(`App "${app.name}" (variant "${v.name}") is not ready (status: ${app.status}).`);
    }
  }
  if (variants.length && !(db.prepare('SELECT 1 FROM links WHERE study_id = ? AND active = 1').get(studyId))) {
    problems.push('Create at least one active participant link.');
  }
  return problems;
}

function removeSessionFiles(sessionIds: string[]) {
  for (const s of sessionIds) fs.rmSync(paths.session(s), { recursive: true, force: true });
}

// ── studies ──────────────────────────────────────────────────────────────────

studiesRouter.get('/studies', (req, res) => {
  const rows = db
    .prepare(
      `SELECT s.*,
        (SELECT COUNT(*) FROM sessions x WHERE x.study_id = s.id AND x.preview = 0 AND x.status != 'withdrawn') AS session_count,
        (SELECT COUNT(*) FROM sessions x WHERE x.study_id = s.id AND x.preview = 0 AND x.status = 'completed') AS completed_count,
        (SELECT COUNT(*) FROM variants v WHERE v.study_id = s.id) AS variant_count,
        (SELECT MAX(x.created_at) FROM sessions x WHERE x.study_id = s.id AND x.preview = 0) AS last_session_at
       FROM studies s WHERE s.owner_id = ? ORDER BY s.updated_at DESC`,
    )
    .all(req.user!.id) as Row[];
  res.json({
    studies: rows.map((r) => ({
      ...studyFromRow(r),
      sessionCount: Number(r.session_count),
      completedCount: Number(r.completed_count),
      variantCount: Number(r.variant_count),
      lastSessionAt: r.last_session_at == null ? null : Number(r.last_session_at),
    })),
  });
});

const CreateStudy = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(5000).optional(),
  template: z.enum(['starter', 'blank']).optional(),
});

studiesRouter.post('/studies', (req, res) => {
  const body = parse(CreateStudy, req.body);
  const now = Date.now();
  const id = newId('std');
  const study = tx(() => {
    db.prepare('INSERT INTO studies (id, owner_id, name, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id, req.user!.id, body.name, body.description ?? '', 'draft', now, now,
    );
    const protocol = body.template === 'blank' ? emptyProtocol(body.name) : { ...starterProtocol(body.name), title: body.name };
    const pr = insertProtocol(id, 'Protocol A', protocol);
    const vid = newId('var');
    db.prepare('INSERT INTO variants (id, study_id, name, protocol_id, app_id, weight, active, created_at) VALUES (?, ?, ?, ?, NULL, 1, 1, ?)').run(
      vid, id, 'A', pr.id, now,
    );
    insertLink(id, { name: 'Main link' });
    return studyFromRow(db.prepare('SELECT * FROM studies WHERE id = ?').get(id) as Row);
  });
  res.status(201).json({ study });
});

studiesRouter.get('/studies/:id', (req, res) => {
  const study = studyFromRow(assertStudyAccess(req, sid(req)));
  const all = (sql: string) => db.prepare(sql).all(study.id) as Row[];
  res.json({
    study,
    protocols: all('SELECT * FROM protocols WHERE study_id = ? ORDER BY created_at').map(protocolFromRow),
    apps: all('SELECT * FROM apps WHERE study_id = ? ORDER BY created_at').map(appFromRow),
    variants: all('SELECT * FROM variants WHERE study_id = ? ORDER BY created_at').map(variantFromRow),
    links: all('SELECT * FROM links WHERE study_id = ? ORDER BY created_at').map(linkWithMeta),
  });
});

const PatchStudy = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(5000).optional(),
  status: z.enum(['draft', 'live', 'paused', 'closed']).optional(),
});

studiesRouter.patch('/studies/:id', (req, res) => {
  const row = assertStudyAccess(req, sid(req));
  const body = parse(PatchStudy, req.body);
  if (body.status === 'live' && row.status !== 'live') {
    // SaaS billing: building and previewing are free; publishing needs an active plan or trial.
    const ent = entitlement(req.user!.id);
    if (!ent.canRunSessions) throw new HttpError(402, 'Choose a plan to publish this study', { billing: true, reason: ent.blockReason });
    const problems = goLiveProblems(String(row.id));
    if (problems.length) throw new HttpError(400, 'Study is not ready to go live', problems);
  }
  db.prepare(
    `UPDATE studies SET name = COALESCE(?, name), description = COALESCE(?, description), status = COALESCE(?, status), updated_at = ? WHERE id = ?`,
  ).run(body.name ?? null, body.description ?? null, body.status ?? null, Date.now(), row.id as string);
  res.json({ study: studyFromRow(db.prepare('SELECT * FROM studies WHERE id = ?').get(row.id as string) as Row) });
});

studiesRouter.delete('/studies/:id', (req, res) => {
  const row = assertStudyAccess(req, sid(req));
  const sessionIds = (db.prepare('SELECT id FROM sessions WHERE study_id = ?').all(row.id as string) as { id: string }[]).map((r) => r.id);
  const appIds = (db.prepare('SELECT id FROM apps WHERE study_id = ?').all(row.id as string) as { id: string }[]).map((r) => r.id);
  db.prepare('DELETE FROM studies WHERE id = ?').run(row.id as string);
  removeSessionFiles(sessionIds);
  try {
    fs.rmSync(paths.consentDir(row.id as string), { recursive: true, force: true }); // uploaded consent originals
  } catch {
    /* nothing stored */
  }
  for (const a of appIds) fs.rmSync(paths.app(a), { recursive: true, force: true });
  res.json({ ok: true });
});

// ── protocols ────────────────────────────────────────────────────────────────

const CreateProtocol = z.object({ name: z.string().trim().min(1).max(200), protocol: z.unknown().optional() });

studiesRouter.post('/studies/:id/protocols', (req, res) => {
  const study = assertStudyAccess(req, sid(req));
  const body = parse(CreateProtocol, req.body);
  const protocol = insertProtocol(study.id as string, body.name, body.protocol ?? emptyProtocol(body.name));
  touchStudy(study.id as string);
  res.status(201).json({ protocol });
});

const PutProtocol = z.object({ name: z.string().trim().min(1).max(200).optional(), protocol: z.unknown() });

studiesRouter.put('/protocols/:pid', (req, res) => {
  const row = assertChildAccess(req, 'protocols', String(req.params.pid));
  const body = parse(PutProtocol, req.body);
  if (body.protocol === undefined) throw new HttpError(400, 'protocol is required');
  const p = normalizeProtocol(body.protocol);
  db.prepare('UPDATE protocols SET name = COALESCE(?, name), protocol = ?, updated_at = ? WHERE id = ?').run(
    body.name ?? null, json.str(p), Date.now(), row.id as string,
  );
  touchStudy(row.study_id as string);
  res.json({ protocol: protocolFromRow(db.prepare('SELECT * FROM protocols WHERE id = ?').get(row.id as string) as Row) });
});

studiesRouter.post('/protocols/:pid/duplicate', (req, res) => {
  const row = assertChildAccess(req, 'protocols', String(req.params.pid));
  const src = protocolFromRow(row);
  const protocol = insertProtocol(src.studyId, `${src.name} (copy)`.slice(0, 200), src.protocol);
  touchStudy(src.studyId);
  res.status(201).json({ protocol });
});

studiesRouter.delete('/protocols/:pid', (req, res) => {
  const row = assertChildAccess(req, 'protocols', String(req.params.pid));
  const used = db.prepare('SELECT name FROM variants WHERE protocol_id = ?').all(row.id as string) as { name: string }[];
  if (used.length) throw new HttpError(400, `Protocol is used by variant${used.length > 1 ? 's' : ''} ${used.map((u) => `"${u.name}"`).join(', ')}`);
  db.prepare('DELETE FROM protocols WHERE id = ?').run(row.id as string);
  touchStudy(row.study_id as string);
  res.json({ ok: true });
});

// ── variants ─────────────────────────────────────────────────────────────────

const VariantBody = z.object({
  name: z.string().trim().min(1).max(200),
  protocolId: z.string().min(1),
  appId: z.string().min(1).nullable().optional(),
  weight: z.number().min(0).max(1000).optional(),
  active: z.boolean().optional(),
  appParams: z.string().trim().max(2000).transform((s) => s.replace(/^[?&]+/, '')).optional(),
});

studiesRouter.post('/studies/:id/variants', (req, res) => {
  const study = assertStudyAccess(req, sid(req));
  const body = parse(VariantBody.omit({ active: true }), req.body);
  const studyId = study.id as string;
  assertInStudy('protocols', body.protocolId, studyId, 'Protocol');
  if (body.appId) assertInStudy('apps', body.appId, studyId, 'App');
  const id = newId('var');
  db.prepare('INSERT INTO variants (id, study_id, name, protocol_id, app_id, weight, active, created_at, app_params) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)').run(
    id, studyId, body.name, body.protocolId, body.appId ?? null, body.weight ?? 1, Date.now(), body.appParams ?? '',
  );
  touchStudy(studyId);
  res.status(201).json({ variant: variantFromRow(db.prepare('SELECT * FROM variants WHERE id = ?').get(id) as Row) });
});

studiesRouter.patch('/variants/:vid', (req, res) => {
  const row = assertChildAccess(req, 'variants', String(req.params.vid));
  const body = parse(VariantBody.partial(), req.body);
  const studyId = row.study_id as string;
  if (body.protocolId) assertInStudy('protocols', body.protocolId, studyId, 'Protocol');
  if (body.appId) assertInStudy('apps', body.appId, studyId, 'App');
  const v = variantFromRow(row);
  const next = {
    name: body.name ?? v.name,
    protocolId: body.protocolId ?? v.protocolId,
    appId: body.appId === undefined ? v.appId : body.appId,
    weight: body.weight ?? v.weight,
    active: body.active ?? v.active,
    appParams: body.appParams ?? v.appParams ?? '',
  };
  db.prepare('UPDATE variants SET name = ?, protocol_id = ?, app_id = ?, weight = ?, active = ?, app_params = ? WHERE id = ?').run(
    next.name, next.protocolId, next.appId, next.weight, next.active ? 1 : 0, next.appParams, v.id,
  );
  touchStudy(studyId);
  res.json({ variant: variantFromRow(db.prepare('SELECT * FROM variants WHERE id = ?').get(v.id) as Row) });
});

studiesRouter.delete('/variants/:vid', (req, res) => {
  const row = assertChildAccess(req, 'variants', String(req.params.vid));
  // sessions.variant_id cascades — refuse to silently destroy real participant data.
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE variant_id = ? AND preview = 0').get(row.id as string) as { n: number };
  if (n > 0) throw new HttpError(400, `Variant has ${n} participant session${n > 1 ? 's' : ''}. Deactivate it instead, or delete the sessions first.`);
  const previewIds = (db.prepare('SELECT id FROM sessions WHERE variant_id = ?').all(row.id as string) as { id: string }[]).map((r) => r.id);
  db.prepare('DELETE FROM variants WHERE id = ?').run(row.id as string);
  removeSessionFiles(previewIds);
  touchStudy(row.study_id as string);
  res.json({ ok: true });
});

// ── links ────────────────────────────────────────────────────────────────────

const LinkBody = z.object({
  name: z.string().trim().min(1).max(200),
  variantId: z.string().min(1).nullable().optional(),
  maxParticipants: z.number().int().min(1).max(1_000_000).nullable().optional(),
  expiresAt: z.number().int().positive().nullable().optional(),
  redirectUrl: z
    .preprocess((v) => (typeof v === 'string' && !v.trim() ? null : v), z.string().trim().max(2000).regex(/^https?:\/\/\S+$/i, 'Must be an http(s) URL').nullable())
    .optional(),
  active: z.boolean().optional(),
});

studiesRouter.post('/studies/:id/links', (req, res) => {
  const study = assertStudyAccess(req, sid(req));
  const body = parse(LinkBody.omit({ active: true }), req.body);
  if (body.variantId) assertInStudy('variants', body.variantId, study.id as string, 'Variant');
  const row = insertLink(study.id as string, body);
  touchStudy(study.id as string);
  res.status(201).json({ link: linkWithMeta(row) });
});

studiesRouter.patch('/links/:lid', (req, res) => {
  const row = assertChildAccess(req, 'links', String(req.params.lid));
  const body = parse(LinkBody.partial(), req.body);
  if (body.variantId) assertInStudy('variants', body.variantId, row.study_id as string, 'Variant');
  const l = linkFromRow(row);
  const pick = <T,>(v: T | undefined, cur: T) => (v === undefined ? cur : v);
  db.prepare('UPDATE links SET name = ?, variant_id = ?, max_participants = ?, expires_at = ?, redirect_url = ?, active = ? WHERE id = ?').run(
    pick(body.name, l.name),
    pick(body.variantId, l.variantId),
    pick(body.maxParticipants, l.maxParticipants),
    pick(body.expiresAt, l.expiresAt),
    pick(body.redirectUrl, l.redirectUrl),
    pick(body.active, l.active) ? 1 : 0,
    l.id,
  );
  touchStudy(l.studyId);
  res.json({ link: linkWithMeta(db.prepare('SELECT * FROM links WHERE id = ?').get(l.id) as Row) });
});

studiesRouter.delete('/links/:lid', (req, res) => {
  const row = assertChildAccess(req, 'links', String(req.params.lid));
  db.prepare('DELETE FROM links WHERE id = ?').run(row.id as string);
  touchStudy(row.study_id as string);
  res.json({ ok: true });
});

// ── preview ──────────────────────────────────────────────────────────────────

studiesRouter.get('/studies/:id/preview-url', (req, res) => {
  const study = assertStudyAccess(req, sid(req));
  const studyId = study.id as string;
  let variantId = typeof req.query.variantId === 'string' && req.query.variantId ? req.query.variantId : null;
  if (variantId) assertInStudy('variants', variantId, studyId, 'Variant');
  else {
    const v = db.prepare('SELECT id FROM variants WHERE study_id = ? ORDER BY active DESC, created_at LIMIT 1').get(studyId) as { id: string } | undefined;
    if (!v) throw new HttpError(400, 'Add a variant before previewing');
    variantId = v.id;
  }
  // Main link = oldest auto-assign link; fall back to any link, or create one.
  const link =
    (db.prepare('SELECT * FROM links WHERE study_id = ? ORDER BY (variant_id IS NULL) DESC, created_at LIMIT 1').get(studyId) as Row | undefined) ??
    insertLink(studyId, { name: 'Main link' });
  res.json({ url: `${linkUrl(String(link.token))}?preview=1&variant=${encodeURIComponent(variantId)}` });
});
