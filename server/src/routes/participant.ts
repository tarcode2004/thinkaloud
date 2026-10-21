// Public participant API (no platform auth). Session calls are authenticated
// with the per-session secret (X-Session-Secret header or ?secret=).
import express, { Router, type Request } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  REALTIME_VOICES,
  newId,
  type Protocol,
  type PublicLinkInfo,
  type RealtimeTokenResponse,
  type StartSessionResponse,
  type Step,
} from '@thinkaloud/shared';
import { db, json, tx } from '../db.ts';
import { HttpError, parse } from '../lib/http.ts';
import { assertParticipant } from '../lib/auth.ts';
import { config } from '../lib/config.ts';
import { paths } from '../lib/paths.ts';
import { parseProtocol, sessionFromRow, sessionProtocolFromRow, variantFromRow, type Row } from '../lib/repo.ts';

export const participantRouter = Router();

export const MAX_EVENTS_PER_BATCH = 2000;
const MAX_EVENT_DATA_BYTES = 256 * 1024;
const MAX_TOKENS_PER_SESSION = 30;

// ── pure helpers (exported for tests) ────────────────────────────────────────

/**
 * Balanced assignment: choose the variant with the lowest count/weight
 * (ties broken randomly). Variants with weight <= 0 are only used when no
 * variant has a positive weight.
 */
export function pickVariant<T extends { id: string; weight: number }>(variants: T[], counts: Record<string, number>, rng: () => number = Math.random): T | null {
  if (!variants.length) return null;
  const positive = variants.filter((v) => v.weight > 0);
  const pool = positive.length ? positive : variants;
  const load = (v: T) => (counts[v.id] ?? 0) / (v.weight > 0 ? v.weight : 1);
  const min = Math.min(...pool.map(load));
  const best = pool.filter((v) => Math.abs(load(v) - min) < 1e-9);
  return best[Math.floor(rng() * best.length)] ?? best[0];
}

/** Shuffle task steps among the task slots; every non-task step keeps its position. */
export function resolveStepOrder(steps: Step[], randomize: boolean, rng: () => number = Math.random): Step[] {
  if (!randomize) return [...steps];
  const slots = steps.flatMap((s, i) => (s.type === 'task' ? [i] : []));
  const tasks = slots.map((i) => steps[i]);
  for (let i = tasks.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [tasks[i], tasks[j]] = [tasks[j], tasks[i]];
  }
  const out = [...steps];
  slots.forEach((slot, k) => (out[slot] = tasks[k]));
  return out;
}

const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export function participantCode(): string {
  const b = crypto.randomBytes(4);
  return 'P-' + Array.from(b, (x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join('');
}

// ── link availability ────────────────────────────────────────────────────────

type Unavailable = NonNullable<PublicLinkInfo['unavailableReason']>;

function getLink(token: string) {
  const link = db.prepare('SELECT * FROM links WHERE token = ?').get(token) as Row | undefined;
  if (!link) throw new HttpError(404, 'This study link does not exist');
  const study = db.prepare('SELECT * FROM studies WHERE id = ?').get(link.study_id as string) as Row;
  return { link, study };
}

function countedSessions(where: string, ...args: string[]): number {
  const r = db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE ${where} AND preview = 0 AND status != 'withdrawn'`).get(...args) as { n: number };
  return r.n;
}

function activeVariants(studyId: string) {
  return (db.prepare('SELECT * FROM variants WHERE study_id = ? AND active = 1 ORDER BY created_at').all(studyId) as Row[]).map(variantFromRow);
}

function unavailableReason(link: Row, study: Row): Unavailable | null {
  if (!link.active) return 'inactive';
  const status = study.status as string;
  if (status === 'draft') return 'draft';
  if (status === 'paused') return 'paused';
  if (status === 'closed') return 'closed';
  if (link.expires_at != null && Number(link.expires_at) <= Date.now()) return 'expired';
  if (link.max_participants != null && countedSessions('link_id = ?', link.id as string) >= Number(link.max_participants)) return 'full';
  if (link.variant_id) {
    const v = db.prepare('SELECT active FROM variants WHERE id = ?').get(link.variant_id as string) as { active: number } | undefined;
    if (!v?.active) return 'inactive';
  } else if (!activeVariants(study.id as string).length) return 'inactive';
  return null;
}

const UNAVAILABLE_MESSAGES: Record<Unavailable, string> = {
  closed: 'This study is closed.',
  paused: 'This study is paused right now. Please try again later.',
  full: 'This study has reached its participant limit.',
  expired: 'This study link has expired.',
  draft: 'This study has not started yet.',
  inactive: 'This study link is no longer active.',
};

const isOwner = (req: Request, study: Row) => Boolean(req.user && req.user.id === study.owner_id);

function protocolForVariant(variantId: string | null | undefined, studyId: string): { variant: Row | undefined; protocol: Protocol | null } {
  const variant = variantId
    ? (db.prepare('SELECT * FROM variants WHERE id = ? AND study_id = ?').get(variantId, studyId) as Row | undefined)
    : (db.prepare('SELECT * FROM variants WHERE study_id = ? ORDER BY active DESC, created_at LIMIT 1').get(studyId) as Row | undefined);
  if (!variant) return { variant, protocol: null };
  const pr = db.prepare('SELECT protocol FROM protocols WHERE id = ?').get(variant.protocol_id as string) as Row | undefined;
  return { variant, protocol: pr ? parseProtocol(pr.protocol) : null };
}

// ── GET /links/:token ────────────────────────────────────────────────────────

participantRouter.get('/links/:token', (req, res) => {
  const { link, study } = getLink(String(req.params.token));
  const preview = req.query.preview === '1' && isOwner(req, study);
  const forced = preview && typeof req.query.variant === 'string' ? req.query.variant : null;
  const { protocol } = protocolForVariant(forced ?? (link.variant_id as string | null), study.id as string);
  const reason = preview ? null : unavailableReason(link, study);
  const info: PublicLinkInfo = {
    token: link.token as string,
    studyName: study.name as string,
    title: protocol?.title ?? (study.name as string),
    estimatedMinutes: protocol?.estimatedMinutes ?? 15,
    consent: protocol?.consent ?? parseProtocol(null).consent,
    language: protocol?.moderation.language ?? 'en',
    available: !reason && Boolean(protocol),
  };
  if (reason) info.unavailableReason = reason;
  else if (!protocol) info.unavailableReason = 'inactive';
  res.json(info);
});

// ── POST /links/:token/sessions ──────────────────────────────────────────────

const shortStr = (max = 500) => z.string().max(max);
const StartSession = z.object({
  urlParams: z
    .record(shortStr(100), shortStr(1000))
    .default({})
    .refine((r) => Object.keys(r).length <= 50, 'Too many URL parameters'),
  device: z.object({
    userAgent: shortStr(1000),
    viewportW: z.number(),
    viewportH: z.number(),
    screenW: z.number(),
    screenH: z.number(),
    dpr: z.number(),
    timezone: shortStr(100),
    language: shortStr(50),
  }),
  consent: z.object({
    version: shortStr(50),
    acceptedAt: z.number(),
    audio: z.boolean(),
    screen: z.boolean(),
    eyeTracking: z.boolean(),
    ageConfirmed: z.boolean(),
  }),
  preview: z.boolean().optional(),
  variantId: shortStr(100).optional(),
});

participantRouter.post('/links/:token/sessions', (req, res) => {
  const body = parse(StartSession, req.body);
  const { link, study } = getLink(String(req.params.token));
  const studyId = study.id as string;
  const owner = isOwner(req, study);
  const preview = Boolean(body.preview);
  if (preview && !owner) throw new HttpError(403, 'Sign in as the study owner to preview this study');

  const result = tx(() => {
    if (!preview) {
      const reason = unavailableReason(link, study);
      if (reason) throw new HttpError(409, UNAVAILABLE_MESSAGES[reason], { reason });
    }

    // Variant assignment.
    let variant: Row | undefined;
    if (preview && body.variantId) {
      variant = db.prepare('SELECT * FROM variants WHERE id = ? AND study_id = ?').get(body.variantId, studyId) as Row | undefined;
      if (!variant) throw new HttpError(400, 'Unknown variant');
    } else if (link.variant_id) {
      variant = db.prepare('SELECT * FROM variants WHERE id = ?').get(link.variant_id as string) as Row | undefined;
    } else {
      const variants = activeVariants(studyId);
      const counts: Record<string, number> = {};
      for (const v of variants) counts[v.id] = countedSessions('variant_id = ?', v.id);
      const chosen = pickVariant(variants, counts);
      if (chosen) variant = db.prepare('SELECT * FROM variants WHERE id = ?').get(chosen.id) as Row;
      else if (preview) variant = db.prepare('SELECT * FROM variants WHERE study_id = ? ORDER BY created_at LIMIT 1').get(studyId) as Row | undefined;
    }
    if (!variant) throw new HttpError(409, 'This study has no variant to run', { reason: 'inactive' });

    const pr = db.prepare('SELECT protocol FROM protocols WHERE id = ?').get(variant.protocol_id as string) as Row | undefined;
    if (!pr) throw new HttpError(409, 'This study has no protocol');
    const protocol = parseProtocol(pr.protocol);
    const steps = resolveStepOrder(protocol.steps, protocol.randomizeTasks);

    const app = variant.app_id ? (db.prepare('SELECT * FROM apps WHERE id = ?').get(variant.app_id as string) as Row | undefined) : undefined;
    const appUrl = app && app.status === 'ready' && app.url ? withAppParams(String(app.url), String(variant.app_params ?? '')) : null;

    let code = participantCode();
    for (let i = 0; i < 20 && db.prepare('SELECT 1 FROM sessions WHERE study_id = ? AND participant_code = ?').get(studyId, code); i++) {
      code = participantCode();
    }
    const id = newId('ses');
    const secret = crypto.randomBytes(24).toString('base64url');
    db.prepare(
      `INSERT INTO sessions (id, study_id, variant_id, link_id, secret, participant_code, status, consent, device, url_params,
         step_order, steps, protocol_snapshot, preview, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'consented', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, studyId, variant.id as string, link.id as string, secret, code,
      json.str({ ...body.consent, acceptedAt: body.consent.acceptedAt || Date.now() }),
      json.str(body.device), json.str(body.urlParams), json.str(steps.map((s) => s.id)), json.str(steps), json.str(protocol),
      preview ? 1 : 0, Date.now(),
    );
    const response: StartSessionResponse = {
      session: sessionFromRow(db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Row),
      secret,
      variant: { id: variant.id as string, name: variant.name as string },
      protocol,
      steps,
      appUrl,
      appInstrumented: Boolean(app?.instrumented),
      redirectUrl: preview ? null : ((link.redirect_url as string | null) ?? null),
    };
    return response;
  });
  res.status(201).json(result);
});

// ── session-scoped calls ─────────────────────────────────────────────────────

function sessionFor(req: Request, opts: { allowEnded?: boolean } = {}) {
  const row = assertParticipant(req, String(req.params.sid));
  if (row.status === 'withdrawn') throw new HttpError(410, 'This session was withdrawn');
  if (!opts.allowEnded && (row.status === 'completed' || row.status === 'abandoned')) throw new HttpError(409, 'This session has ended');
  return row;
}

participantRouter.post('/sessions/:sid/begin', (req, res) => {
  const row = sessionFor(req, { allowEnded: true });
  if (row.started_at != null) return void res.json({ startedAt: Number(row.started_at) });
  if (row.status === 'completed' || row.status === 'abandoned') throw new HttpError(409, 'This session has ended');
  const startedAt = Date.now();
  db.prepare("UPDATE sessions SET status = 'in_progress', started_at = ? WHERE id = ? AND started_at IS NULL").run(startedAt, row.id as string);
  res.json({ startedAt });
});

// Events
const EventSchema = z.object({
  seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  kind: z.string().min(1).max(64),
  t: z.number(),
  at: z.number(),
  stepId: z.string().max(100).nullish(),
  data: z.record(z.string(), z.unknown()).default({}),
});
const EventsBody = z.object({ events: z.array(z.unknown()).max(MAX_EVENTS_PER_BATCH) });

const TaskEndData = z.object({
  stepId: z.string().max(100).optional(),
  outcome: z.enum(['success', 'partial', 'failure', 'abandoned', 'timeout']),
  source: z.enum(['rule', 'ai', 'participant', 'researcher']).default('ai'),
  startedAt: z.number(),
  endedAt: z.number(),
  durationMs: z.number().min(0),
  evidence: z.string().max(4000).optional(),
});
const AnswerData = z.object({
  stepId: z.string().max(100).optional(),
  questionId: z.string().min(1).max(100),
  text: z.string().max(20_000).optional(),
  value: z.number().optional(),
  choices: z.array(z.string().max(1000)).max(100).optional(),
  source: z.enum(['voice', 'screen', 'text']).default('screen'),
  at: z.number().optional(),
});

/** Insert a batch of events for a session and apply derived side effects. Returns the number of newly stored events. */
export function ingestEvents(sessionId: string, rawEvents: unknown[]): { accepted: number; rejected: number } {
  let accepted = 0;
  let rejected = 0;
  tx(() => {
    let nextSeq: number | null = null;
    const insert = db.prepare('INSERT OR IGNORE INTO events (session_id, seq, kind, t, at, step_id, data) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const upsertTask = db.prepare(
      `INSERT INTO task_results (session_id, step_id, outcome, source, started_at, ended_at, duration_ms, evidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (session_id, step_id) DO UPDATE SET outcome = excluded.outcome, source = excluded.source,
         started_at = excluded.started_at, ended_at = excluded.ended_at, duration_ms = excluded.duration_ms, evidence = excluded.evidence
       WHERE task_results.source != 'researcher'`,
    );
    const upsertAnswer = db.prepare(
      `INSERT INTO answers (session_id, step_id, question_id, text, value, choices, source, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (session_id, step_id, question_id) DO UPDATE SET text = excluded.text, value = excluded.value,
         choices = excluded.choices, source = excluded.source, at = excluded.at`,
    );
    for (const raw of rawEvents) {
      const p = EventSchema.safeParse(raw);
      if (!p.success) {
        rejected++;
        continue;
      }
      const e = p.data;
      const data = JSON.stringify(e.data);
      if (data.length > MAX_EVENT_DATA_BYTES) {
        rejected++;
        continue;
      }
      let seq = e.seq;
      if (seq === undefined) {
        if (nextSeq === null) {
          const r = db.prepare('SELECT MAX(seq) AS m FROM events WHERE session_id = ?').get(sessionId) as { m: number | null };
          nextSeq = (r.m ?? -1) + 1;
        }
        seq = nextSeq++;
      }
      const stepId = e.stepId ?? null;
      const changed = Number(insert.run(sessionId, seq, e.kind, Math.round(e.t), Math.round(e.at), stepId, data).changes);
      if (!changed) continue; // duplicate (session_id, seq): already processed
      accepted++;

      if (e.kind === 'task.end') {
        const d = TaskEndData.safeParse(e.data);
        const sid = stepId ?? (d.success ? d.data.stepId : undefined);
        if (d.success && sid) {
          const x = d.data;
          upsertTask.run(sessionId, sid, x.outcome, x.source, Math.round(x.startedAt), Math.round(x.endedAt), Math.round(x.durationMs), x.evidence ?? null);
        }
      } else if (e.kind === 'answer') {
        const d = AnswerData.safeParse(e.data);
        const sid = stepId ?? (d.success ? d.data.stepId : undefined);
        if (d.success && sid) {
          const x = d.data;
          upsertAnswer.run(sessionId, sid, x.questionId, x.text ?? null, x.value ?? null, x.choices ? json.str(x.choices) : null, x.source, Math.round(x.at ?? e.at));
        }
      } else if (e.kind === 'eyetracking.calibrated') {
        const err = Number(e.data.errorPx);
        if (Number.isFinite(err)) db.prepare('UPDATE sessions SET gaze_error_px = ? WHERE id = ?').run(err, sessionId);
      }
    }
  });
  return { accepted, rejected };
}

participantRouter.post('/sessions/:sid/events', (req, res) => {
  const row = sessionFor(req, { allowEnded: true });
  const body = parse(EventsBody, req.body);
  const { accepted, rejected } = ingestEvents(row.id as string, body.events);
  res.json({ ok: true, accepted, rejected });
});

// rrweb chunks
const seqParam = (req: Request) => {
  const n = Number(req.query.seq);
  if (!Number.isInteger(n) || n < 0 || n > 999_999) throw new HttpError(400, 'seq must be an integer between 0 and 999999');
  return String(n).padStart(6, '0');
};

function writeSessionFile(sessionId: string, name: string, data: string | Buffer) {
  const dir = paths.session(sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

participantRouter.post('/sessions/:sid/rrweb', (req, res) => {
  const row = sessionFor(req, { allowEnded: true });
  const consent = json.parse<{ screen?: boolean } | null>(row.consent, null);
  if (consent && consent.screen === false) throw new HttpError(403, 'Screen recording was not consented');
  const seq = seqParam(req);
  const body = parse(z.object({ events: z.array(z.unknown()).max(50_000) }), req.body);
  writeSessionFile(row.id as string, `rrweb-${seq}.json`, JSON.stringify(body.events));
  res.json({ ok: true });
});

// audio chunks
participantRouter.post(
  '/sessions/:sid/audio',
  express.raw({ type: ['audio/*', 'video/webm', 'application/octet-stream'], limit: '20mb' }),
  (req, res) => {
    const row = sessionFor(req, { allowEnded: true });
    const track = String(req.query.track ?? 'mixed');
    if (track !== 'mixed' && track !== 'mic') throw new HttpError(400, 'track must be mixed or mic');
    const seq = seqParam(req);
    const consent = json.parse<{ audio?: boolean } | null>(row.consent, null);
    const snapshot = sessionProtocolFromRow(row);
    if ((consent && consent.audio === false) || snapshot?.consent.storeAudio === false) throw new HttpError(403, 'Audio storage is disabled for this session');
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Expected a raw audio/webm body');
    writeSessionFile(row.id as string, `audio-${track}-${seq}.webm`, req.body);
    res.json({ ok: true, bytes: req.body.length });
  },
);

// realtime token
const tokenCounts = new Map<string, number>();

function primaryLanguage(lang: string | undefined): string {
  const l = (lang || 'en').trim().toLowerCase().split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(l) ? l : 'en';
}

participantRouter.post('/sessions/:sid/realtime-token', async (req, res) => {
  const row = sessionFor(req);
  if (!config.openaiKey) throw new HttpError(503, 'Voice moderation is not configured on this server (missing OPENAI_API_KEY)');
  const sessionId = row.id as string;
  const used = tokenCounts.get(sessionId) ?? 0;
  if (used >= MAX_TOKENS_PER_SESSION) throw new HttpError(429, 'Too many voice connections for this session');
  tokenCounts.set(sessionId, used + 1);

  const protocol = sessionProtocolFromRow(row) ?? protocolForVariant(row.variant_id as string, row.study_id as string).protocol;
  const wanted = protocol?.moderation.voice;
  const voice = wanted && (REALTIME_VOICES as readonly string[]).includes(wanted) ? wanted : config.realtimeVoice;
  const model = config.realtimeModel;
  const session = {
    type: 'realtime',
    model,
    audio: {
      input: {
        transcription: { model: config.transcribeModel, language: primaryLanguage(protocol?.moderation.language) },
        noise_reduction: { type: 'near_field' },
        turn_detection: { type: 'semantic_vad', eagerness: 'low', create_response: true, interrupt_response: true },
      },
      output: { voice },
    },
  };

  const mint = async (withReasoning: boolean) =>
    fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: withReasoning ? { ...session, reasoning: { effort: config.realtimeEffort } } : session }),
      signal: AbortSignal.timeout(15_000),
    });

  let r: Response;
  try {
    r = await mint(Boolean(config.realtimeEffort));
    // Older/other realtime models reject `reasoning` — retry without it.
    if (r.status === 400 && config.realtimeEffort) {
      const text = await r.text();
      if (/reasoning/i.test(text)) r = await mint(false);
      else throw new HttpError(502, 'Could not start the voice session', { upstream: text.slice(0, 500) });
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(503, 'Voice service is unreachable right now');
  }
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    console.error('[realtime-token] OpenAI error', r.status, text.slice(0, 500));
    throw new HttpError(r.status === 429 ? 503 : 502, 'Could not start the voice session', { upstreamStatus: r.status });
  }
  const j = (await r.json()) as { value?: string; expires_at?: number; client_secret?: { value?: string; expires_at?: number } };
  const value = j.value ?? j.client_secret?.value;
  if (!value) throw new HttpError(502, 'Voice service returned no key');
  const out: RealtimeTokenResponse = { value, expiresAt: Number(j.expires_at ?? j.client_secret?.expires_at ?? 0), model, voice };
  res.json(out);
});

// complete / withdraw
participantRouter.post('/sessions/:sid/complete', (req, res) => {
  const row = sessionFor(req, { allowEnded: true });
  const { status } = parse(z.object({ status: z.enum(['completed', 'abandoned']).default('completed') }), req.body ?? {});
  if (row.status !== 'completed' && row.status !== 'abandoned') {
    db.prepare('UPDATE sessions SET status = ?, ended_at = ? WHERE id = ?').run(status, Date.now(), row.id as string);
  } else if (row.status === 'abandoned' && status === 'completed') {
    db.prepare("UPDATE sessions SET status = 'completed' WHERE id = ?").run(row.id as string);
  }
  tokenCounts.delete(row.id as string);
  const link = row.link_id ? (db.prepare('SELECT redirect_url FROM links WHERE id = ?').get(row.link_id as string) as Row | undefined) : undefined;
  res.json({ ok: true, redirectUrl: row.preview ? null : ((link?.redirect_url as string | null) ?? null) });
});

/** Delete everything captured in a session except the bare session record (status → withdrawn). */
export function withdrawSession(sessionId: string) {
  tx(() => {
    for (const t of ['events', 'answers', 'task_results', 'notes']) db.prepare(`DELETE FROM ${t} WHERE session_id = ?`).run(sessionId);
    db.prepare("UPDATE sessions SET status = 'withdrawn', ended_at = COALESCE(ended_at, ?), device = NULL, gaze_error_px = NULL WHERE id = ?").run(
      Date.now(), sessionId,
    );
  });
  fs.rmSync(paths.session(sessionId), { recursive: true, force: true });
  tokenCounts.delete(sessionId);
}

participantRouter.post('/sessions/:sid/withdraw', (req, res) => {
  const row = assertParticipant(req, String(req.params.sid));
  withdrawSession(row.id as string);
  const link = row.link_id ? (db.prepare('SELECT redirect_url FROM links WHERE id = ?').get(row.link_id as string) as Row | undefined) : undefined;
  res.json({ ok: true, redirectUrl: row.preview ? null : ((link?.redirect_url as string | null) ?? null) });
});

/** Merge a variant's launch query string ("flags=a:1&x=2") into the app URL. */
export function withAppParams(url: string, params: string): string {
  if (!params.trim()) return url;
  try {
    const u = new URL(url);
    for (const [k, v] of new URLSearchParams(params)) u.searchParams.set(k, v);
    return u.toString();
  } catch {
    return url;
  }
}
