import { Router } from 'express';
import { z } from 'zod';
import { newId } from '@thinkaloud/shared';
import { db } from '../db.ts';
import { HttpError, parse } from '../lib/http.ts';
import { createAuthSession, destroyAuthSession, hashPassword, requireUser, userJson, verifyPassword, type UserRow } from '../lib/auth.ts';
import { googleConfig, verifyGoogleIdToken } from '../lib/google.ts';

export const authRouter = Router();

const Signup = z.object({ email: z.string().email().max(200), password: z.string().min(8).max(200), name: z.string().min(1).max(100) });
const Login = z.object({ email: z.string().email(), password: z.string().min(1) });
const GoogleLogin = z.object({ credential: z.string().min(20).max(4096) });

authRouter.post('/signup', (req, res) => {
  const body = parse(Signup, req.body);
  const exists = db.prepare('SELECT 1 FROM users WHERE email = ?').get(body.email);
  if (exists) throw new HttpError(409, 'An account with this email already exists');
  const user = { id: newId('usr'), email: body.email.toLowerCase(), name: body.name.trim(), createdAt: Date.now() };
  db.prepare('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(
    user.id, user.email, user.name, hashPassword(body.password), user.createdAt,
  );
  const token = createAuthSession(res, user.id); // token: bearer auth for cross-origin front ends
  res.status(201).json({ token, user });
});

authRouter.post('/login', (req, res) => {
  const body = parse(Login, req.body);
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(body.email) as (UserRow & { password_hash: string }) | undefined;
  // Google-only accounts have an empty password_hash, which verifyPassword never accepts.
  if (!row || !verifyPassword(body.password, row.password_hash)) throw new HttpError(401, 'Wrong email or password');
  const token = createAuthSession(res, row.id);
  res.json({ token, user: userJson(row) });
});

/** Which sign-in providers this server offers. Public: the Google client id is not a secret. */
authRouter.get('/providers', (_req, res) => {
  const g = googleConfig();
  res.json({ google: g ? { clientId: g.clientId, oneTap: g.oneTap } : null });
});

/**
 * Sign in with Google. Body: { credential } = the GIS ID token. Signs in the account linked to that
 * Google id; otherwise links the account with the same (Google-verified) email; otherwise creates one.
 */
authRouter.post('/google', async (req, res) => {
  const body = parse(GoogleLogin, req.body);
  const g = await verifyGoogleIdToken(body.credential); // signature, aud, iss, exp, email_verified
  type Row = UserRow & { google_sub: string | null };
  const bySub = db.prepare('SELECT * FROM users WHERE google_sub = ?').get(g.sub) as Row | undefined;
  let userId: string;
  let created = false;
  if (bySub) {
    userId = bySub.id;
    if (g.picture && g.picture !== bySub.avatar_url) db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(g.picture, userId);
  } else {
    const byEmail = db.prepare('SELECT * FROM users WHERE email = ?').get(g.email) as Row | undefined;
    if (byEmail) {
      // Only reached with email_verified === true (checked above). An account already linked to a
      // different Google id is never re-linked: that would hand it to whoever holds the new Google account.
      if (byEmail.google_sub) throw new HttpError(409, 'This email is already linked to a different Google account. Sign in with that account, or use your email and password.');
      userId = byEmail.id;
      db.prepare('UPDATE users SET google_sub = ?, avatar_url = COALESCE(?, avatar_url) WHERE id = ?').run(g.sub, g.picture, userId);
      // Password sign-up never verified the email, so someone else may have pre-registered it. Google just
      // proved ownership: end every session opened before the link (the new one is created below).
      db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId);
    } else {
      userId = newId('usr');
      // Empty password_hash: password sign-in is impossible until the user sets one.
      db.prepare('INSERT INTO users (id, email, name, password_hash, created_at, google_sub, avatar_url) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        userId, g.email, g.name, '', Date.now(), g.sub, g.picture,
      );
      created = true;
    }
  }
  const token = createAuthSession(res, userId);
  const user = userJson(db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as unknown as UserRow);
  res.status(created ? 201 : 200).json({ token, user, created });
});

authRouter.post('/logout', (req, res) => {
  destroyAuthSession(req, res);
  res.json({ ok: true });
});

authRouter.get('/me', requireUser, (req, res) => {
  res.json({ user: req.user });
});
