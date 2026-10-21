import { Router } from 'express';
import { z } from 'zod';
import { newId } from '@thinkaloud/shared';
import { db } from '../db.ts';
import { HttpError, parse } from '../lib/http.ts';
import { createAuthSession, destroyAuthSession, hashPassword, requireUser, verifyPassword } from '../lib/auth.ts';

export const authRouter = Router();

const Signup = z.object({ email: z.string().email().max(200), password: z.string().min(8).max(200), name: z.string().min(1).max(100) });
const Login = z.object({ email: z.string().email(), password: z.string().min(1) });

authRouter.post('/signup', (req, res) => {
  const body = parse(Signup, req.body);
  const exists = db.prepare('SELECT 1 FROM users WHERE email = ?').get(body.email);
  if (exists) throw new HttpError(409, 'An account with this email already exists');
  const user = { id: newId('usr'), email: body.email.toLowerCase(), name: body.name.trim(), createdAt: Date.now() };
  db.prepare('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(
    user.id, user.email, user.name, hashPassword(body.password), user.createdAt,
  );
  createAuthSession(res, user.id);
  res.status(201).json({ user });
});

authRouter.post('/login', (req, res) => {
  const body = parse(Login, req.body);
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(body.email) as
    | { id: string; email: string; name: string; password_hash: string; created_at: number }
    | undefined;
  if (!row || !verifyPassword(body.password, row.password_hash)) throw new HttpError(401, 'Wrong email or password');
  createAuthSession(res, row.id);
  res.json({ user: { id: row.id, email: row.email, name: row.name, createdAt: row.created_at } });
});

authRouter.post('/logout', (req, res) => {
  destroyAuthSession(req, res);
  res.json({ ok: true });
});

authRouter.get('/me', requireUser, (req, res) => {
  res.json({ user: req.user });
});
