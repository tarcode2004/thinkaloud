import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { User } from '@thinkaloud/shared';
import { db } from '../db.ts';
import { config } from './config.ts';
import { HttpError } from './http.ts';

export const AUTH_COOKIE = 'ta_auth';
const SESSION_DAYS = 30;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [, saltHex, hashHex] = stored.split('$');
  if (!saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

export function createAuthSession(res: Response, userId: string): string {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const expires = now + SESSION_DAYS * 864e5;
  db.prepare('INSERT INTO auth_sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(token, userId, now, expires);
  res.cookie(AUTH_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: config.publicUrl.startsWith('https://'), maxAge: SESSION_DAYS * 864e5, path: '/' });
  return token;
}

export function destroyAuthSession(req: Request, res: Response) {
  const token = req.cookies?.[AUTH_COOKIE];
  if (token) db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
  res.clearCookie(AUTH_COOKIE, { path: '/' });
}

/** Populates req.user if a valid auth cookie (or `Authorization: Bearer <token>`) is present. */
export function loadUser(req: Request, _res: Response, next: NextFunction) {
  const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
  const token = req.cookies?.[AUTH_COOKIE] || bearer;
  if (token) {
    const row = db
      .prepare(
        `SELECT u.id, u.email, u.name, u.created_at FROM auth_sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND s.expires_at > ?`,
      )
      .get(token, Date.now()) as { id: string; email: string; name: string; created_at: number } | undefined;
    if (row) req.user = { id: row.id, email: row.email, name: row.name, createdAt: row.created_at };
  }
  next();
}

export function requireUser(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new HttpError(401, 'Not signed in'));
  next();
}

/** Throws 404 unless the study exists and belongs to the current user. Returns the study row. */
export function assertStudyAccess(req: Request, studyId: string) {
  const row = db.prepare('SELECT * FROM studies WHERE id = ?').get(studyId) as Record<string, unknown> | undefined;
  if (!row || row.owner_id !== req.user?.id) throw new HttpError(404, 'Study not found');
  return row;
}

/** Resolve the study id that owns a child row (protocols/apps/variants/links/sessions) and check access. */
export function assertChildAccess(req: Request, table: 'protocols' | 'apps' | 'variants' | 'links' | 'sessions', id: string) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!row) throw new HttpError(404, 'Not found');
  assertStudyAccess(req, row.study_id as string);
  return row;
}

/** Participant auth: X-Session-Secret header (or ?secret= for beacons). Returns the session row. */
export function assertParticipant(req: Request, sessionId: string) {
  const secret = (req.headers['x-session-secret'] as string | undefined) || (req.query.secret as string | undefined);
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as Record<string, unknown> | undefined;
  if (!row || typeof secret !== 'string' || !secret || !safeEqual(String(row.secret), secret)) throw new HttpError(403, 'Invalid session');
  return row;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
