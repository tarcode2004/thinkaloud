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
  if (req.path === '/billing/webhook') return next(); // Stripe server-to-server; authenticated by its signature
  // Bearer-authenticated requests are not CSRF-able: a browser only attaches the header from script,
  // and cross-origin script needs a CORS preflight that only CORS_ORIGINS pass (see corsMiddleware).
  if (req.headers.authorization?.startsWith('Bearer ')) return next();
  const origin = req.headers.origin;
  if (!origin) return next(); // non-browser clients (curl, scripts) — cookie still required
  const allowed = new Set([originOf(config.publicUrl), ...config.corsOrigins, `${req.protocol}://${req.get('host')}`]);
  if (!config.isProd) for (const p of [5173, 5300, 5400, 5500, 5800]) allowed.add(`http://localhost:${p}`);
  if (!allowed.has(origin)) return next(new HttpError(403, 'Cross-origin request refused'));
  next();
}

/**
 * CORS for a front end hosted on another origin (e.g. Firebase Hosting → API tunnel). Only the
 * configured origins get Access-Control-Allow-Origin, and never with credentials: cross-origin
 * researcher calls authenticate with `Authorization: Bearer`, participant calls with X-Session-Secret.
 * Same-origin requests are untouched.
 */
export function corsMiddleware(req: Request, res: Response, next: NextFunction) {
  const origin = req.headers.origin;
  if (!origin || !config.corsOrigins.includes(origin)) return next();
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.append('Vary', 'Origin');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, Content-Range');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Session-Secret, Range');
    res.setHeader('Access-Control-Max-Age', '600');
    return res.status(204).end();
  }
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
