// API server: REST API under /api, probe bundle, and (in production) the built SPA.
import express from 'express';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';
import path from 'node:path';
import './db.ts';
import { config } from './lib/config.ts';
import { paths } from './lib/paths.ts';
import { loadUser } from './lib/auth.ts';
import { errorMiddleware } from './lib/http.ts';
import { rateLimit, sameOriginGuard } from './lib/guards.ts';
import { authRouter } from './routes/auth.ts';
import { studiesRouter } from './routes/studies.ts';
import { participantRouter } from './routes/participant.ts';
import { aiRouter } from './routes/ai.ts';
import { buildsRouter } from './builds/routes.ts';
import { analyticsRouter } from './analytics/routes.ts';

/** The API + SPA Express app (no listening; see index.ts). */
export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(cookieParser());
  app.use(express.json({ limit: '25mb' }));
  app.use(loadUser);

  app.get('/api/health', (_req, res) => res.json({ ok: true, appHostUrl: config.appHostUrl, ai: Boolean(config.openaiKey) }));
  app.use('/api', sameOriginGuard);
  app.use(['/api/auth/login', '/api/auth/signup'], rateLimit({ windowMs: 10 * 60_000, max: Number(process.env.AUTH_RATE_LIMIT || (config.isProd ? 30 : 1000)) }));
  app.use('/api/auth', authRouter);
  app.use('/api/p', participantRouter); // public participant API (session-secret auth)
  app.use('/api/ai', aiRouter);
  app.use('/api', studiesRouter);
  app.use('/api', buildsRouter);
  app.use('/api', analyticsRouter);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API route' }));

  // Probe bundle (also served by the app host, here for external-URL snippet installs).
  app.get('/probe.js', (_req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.sendFile(paths.probeBundle);
  });

  // Production: serve the built SPA.
  if (fs.existsSync(paths.webDist)) {
    app.use(express.static(paths.webDist, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(paths.webDist, 'index.html')));
  }

  app.use(errorMiddleware);
  return app;
}
