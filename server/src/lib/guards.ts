import type { NextFunction, Request, Response } from 'express';
import { config } from './config.ts';
import { HttpError } from './http.ts';

/**
 * CSRF guard for cookie-authenticated researcher endpoints. Browsers always send
 * Origin on cross-site and on non-GET fetches; a state-changing request whose
 * Origin isn't the platform itself (e.g. a form posted from a hosted test app)
 * is refused. Participant endpoints use the session secret header and are exempt.
 */
export function sameOriginGuard(req: Request, _res: Response, next: NextFunction) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (req.path.startsWith('/p/')) return next();
  const origin = req.headers.origin;
  if (!origin) return next(); // non-browser clients (curl, scripts) — cookie still required
  const allowed = new Set([originOf(config.publicUrl), `${req.protocol}://${req.get('host')}`]);
  if (!config.isProd) for (const p of [5173, 5300, 5400, 5500, 5800]) allowed.add(`http://localhost:${p}`);
  if (!allowed.has(origin)) return next(new HttpError(403, 'Cross-origin request refused'));
  next();
}

function originOf(url: string) {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** Fixed-window in-memory rate limiter keyed by client IP. */
export function rateLimit({ windowMs, max }: { windowMs: number; max: number }) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (req: Request, _res: Response, next: NextFunction) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) {
      hits.set(key, { n: 1, reset: now + windowMs });
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
      return next();
    }
    if (++h.n > max) return next(new HttpError(429, 'Too many attempts. Try again in a few minutes.'));
    next();
  };
}
