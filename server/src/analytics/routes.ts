// Analytics API (see docs/API.md → "Analytics").
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { TaskOutcome } from '@thinkaloud/shared';
import { newId } from '@thinkaloud/shared';
import { db, json, tx } from '../db.ts';
import { assertChildAccess, assertStudyAccess, requireUser } from '../lib/auth.ts';
import { HttpError, parse } from '../lib/http.ts';
import { answerFromRow, taskResultFromRow, variantFromRow, type Row } from '../lib/repo.ts';
import { loadNotes, loadSession, loadSessionEvents, loadSessions, loadTaskResults, loadAnswers, noteFromRow } from './data.ts';
import { computeAnalytics, scoreSession, sessionDurationMs } from './metrics.ts';
import { audioTracks, deleteSessionFiles, hasReplay, readPoints, readReplay, sendAudio } from './media.ts';
import { computeHeatmap, type HeatKind } from './heatmap.ts';
import { latestSynthesis, runSynthesis } from './synthesis.ts';
import { exportRows, participantColumns, toCsv, type ExportTable } from './export.ts';

export const analyticsRouter = Router();

const flag = (v: unknown) => v === '1' || v === 'true';
const sid = (req: Request) => String(req.params.sid);

// ── Study-level ─────────────────────────────────────────────────────────────

analyticsRouter.get('/studies/:id/analytics', requireUser, (req, res) => {
  assertStudyAccess(req, String(req.params.id));
  const level = Number(req.query.level ?? 0.9);
  res.json(computeAnalytics(String(req.params.id), { includePreview: flag(req.query.includePreview), level }));
});

analyticsRouter.get('/studies/:id/sessions', requireUser, (req, res) => {
  const studyId = String(req.params.id);
  assertStudyAccess(req, studyId);
  const variants = new Map((db.prepare('SELECT * FROM variants WHERE study_id = ?').all(studyId) as Row[]).map((r) => [String(r.id), variantFromRow(r)]));
  const sessions = loadSessions(studyId, { includePreview: true, includeWithdrawn: true });
  const results = loadTaskResults(studyId);
  const answers = loadAnswers(studyId);
  const counts = new Map<string, Record<string, number>>();
  for (const r of db
    .prepare(
      `SELECT e.session_id AS sid, e.kind AS kind, COUNT(*) AS n FROM events e JOIN sessions s ON s.id = e.session_id
       WHERE s.study_id = ? AND e.kind IN ('app.rage_click','app.dead_click','app.error','app.network_error','app.crash','transcript.participant') GROUP BY e.session_id, e.kind`,
    )
    .all(studyId) as Row[]) {
    const m = counts.get(String(r.sid)) ?? {};
    m[String(r.kind)] = Number(r.n);
    counts.set(String(r.sid), m);
  }
  const list = sessions
    .map((s) => {
      const tr = results.get(s.session.id) ?? [];
      const sc = scoreSession(answers.get(s.session.id) ?? []);
      const c = counts.get(s.session.id) ?? {};
      return {
        ...s.session,
        preview: s.preview,
        effectiveStatus: s.effectiveStatus,
        stale: s.stale,
        lastActivityAt: s.lastActivityAt,
        variantName: variants.get(s.session.variantId)?.name ?? '—',
        durationMs: sessionDurationMs(s),
        tasksSucceeded: tr.filter((r) => r.outcome === 'success').length,
        tasksTotal: s.steps.filter((st) => st.type === 'task').length || tr.length,
        tasksAttempted: tr.length,
        outcomes: tr.map((r) => r.outcome),
        sus: sc.SUS ?? null,
        umuxLite: sc.UMUX_LITE ?? null,
        nps: sc.NPS ?? null,
        tlx: sc.NASA_TLX ?? null,
        rageClicks: c['app.rage_click'] ?? 0,
        deadClicks: c['app.dead_click'] ?? 0,
        errors: (c['app.error'] ?? 0) + (c['app.network_error'] ?? 0) + (c['app.crash'] ?? 0),
        utterances: c['transcript.participant'] ?? 0,
        hasReplay: hasReplay(s.session.id),
        hasAudio: audioTracks(s.session.id).length > 0,
      };
    })
    .sort((a, b) => (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt));
  res.json({ sessions: list, participantFields: participantColumns(studyId, sessions.map((s) => s.session.consent?.fields)) });
});

analyticsRouter.get('/studies/:id/heatmap', requireUser, (req, res) => {
  const studyId = String(req.params.id);
  assertStudyAccess(req, studyId);
  const kind = (['click', 'gaze', 'mouse'].includes(String(req.query.kind)) ? String(req.query.kind) : 'click') as HeatKind;
  res.json(
    computeHeatmap(studyId, {
      kind,
      stepId: req.query.stepId ? String(req.query.stepId) : null,
      path: req.query.path ? String(req.query.path) : null,
      variantId: req.query.variantId ? String(req.query.variantId) : null,
      includePreview: flag(req.query.includePreview),
    }),
  );
});

analyticsRouter.get('/studies/:id/synthesis', requireUser, (req, res) => {
  assertStudyAccess(req, String(req.params.id));
  res.json(latestSynthesis(String(req.params.id)));
});

analyticsRouter.post('/studies/:id/synthesis', requireUser, async (req, res) => {
  assertStudyAccess(req, String(req.params.id));
  res.json(await runSynthesis(String(req.params.id)));
});

analyticsRouter.get('/studies/:id/export', requireUser, (req, res) => {
  const studyId = String(req.params.id);
  const study = assertStudyAccess(req, studyId);
  const table = String(req.query.table ?? 'sessions') as ExportTable;
  if (!['sessions', 'tasks', 'answers', 'events'].includes(table)) throw new HttpError(400, 'table must be sessions|tasks|answers|events');
  const format = req.query.format === 'json' ? 'json' : 'csv';
  const rows = exportRows(studyId, table, { includePreview: flag(req.query.includePreview), includePoints: flag(req.query.includePoints), excludePii: flag(req.query.excludePii) });
  const piiSuffix = flag(req.query.excludePii) ? '-no-pii' : '';
  const base = `${String(study.name ?? 'study').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'study'}-${table}${piiSuffix}`;
  if (format === 'json') {
    res.setHeader('Content-Disposition', `attachment; filename="${base}.json"`);
    res.type('application/json').send(JSON.stringify(rows, null, 2));
  } else {
    res.setHeader('Content-Disposition', `attachment; filename="${base}.csv"`);
    res.type('text/csv; charset=utf-8').send(toCsv(rows));
  }
});

// ── Session-level ───────────────────────────────────────────────────────────

analyticsRouter.get('/sessions/:sid', requireUser, (req, res) => {
  const row = assertChildAccess(req, 'sessions', sid(req));
  const s = loadSession(sid(req))!;
  const variant = db.prepare('SELECT * FROM variants WHERE id = ?').get(String(row.variant_id)) as Row | undefined;
  const taskResults = (db.prepare('SELECT * FROM task_results WHERE session_id = ?').all(sid(req)) as Row[]).map(taskResultFromRow);
  const answers = (db.prepare('SELECT * FROM answers WHERE session_id = ? ORDER BY at').all(sid(req)) as Row[]).map(answerFromRow);
  const events = loadSessionEvents(sid(req), { excludePoints: true });
  const pointCounts = Object.fromEntries(
    (db.prepare("SELECT kind, COUNT(*) AS n FROM events WHERE session_id = ? AND kind IN ('mouse','gaze') GROUP BY kind").all(sid(req)) as Row[]).map((r) => [
      String(r.kind),
      Number(r.n),
    ]),
  );
  // Neighbouring sessions (for prev/next navigation in the UI).
  const ordered = (db.prepare('SELECT id FROM sessions WHERE study_id = ? ORDER BY COALESCE(started_at, created_at) DESC').all(String(row.study_id)) as Row[]).map((r) =>
    String(r.id),
  );
  const i = ordered.indexOf(sid(req));
  res.json({
    session: { ...s.session, preview: s.preview },
    effectiveStatus: s.effectiveStatus,
    variantName: variant ? String(variant.name) : null,
    steps: s.steps,
    protocol: s.protocol,
    events,
    taskResults,
    answers,
    scores: scoreSession(answers),
    durationMs: sessionDurationMs(s),
    notes: loadNotes(sid(req)),
    hasReplay: hasReplay(sid(req)),
    audioTracks: audioTracks(sid(req)),
    pointBatches: { mouse: pointCounts.mouse ?? 0, gaze: pointCounts.gaze ?? 0 },
    participantFields: participantColumns(String(row.study_id), [s.session.consent?.fields]),
    prevSessionId: i > 0 ? ordered[i - 1] : null,
    nextSessionId: i >= 0 && i < ordered.length - 1 ? ordered[i + 1] : null,
  });
});

analyticsRouter.get('/sessions/:sid/replay', requireUser, (req, res) => {
  assertChildAccess(req, 'sessions', sid(req));
  res.setHeader('Cache-Control', 'private, max-age=30');
  res.json(readReplay(sid(req)));
});

analyticsRouter.get('/sessions/:sid/audio', requireUser, (req, res) => {
  assertChildAccess(req, 'sessions', sid(req));
  sendAudio(req, res, sid(req), String(req.query.track ?? 'mixed'));
});

analyticsRouter.get('/sessions/:sid/points', requireUser, (req, res) => {
  assertChildAccess(req, 'sessions', sid(req));
  const kind = req.query.kind === 'gaze' ? 'gaze' : 'mouse';
  res.json({ kind, points: readPoints(sid(req), kind) });
});

const OverrideBody = z.object({ outcome: z.enum(['success', 'partial', 'failure', 'abandoned', 'timeout']), note: z.string().max(2000).optional() });

analyticsRouter.put('/sessions/:sid/tasks/:stepId', requireUser, (req, res) => {
  const row = assertChildAccess(req, 'sessions', sid(req));
  const stepId = String(req.params.stepId);
  const steps = json.parse<{ id: string; type: string }[]>(row.steps, []);
  if (steps.length && !steps.some((s) => s.id === stepId && s.type === 'task')) throw new HttpError(404, 'Task step not found in this session');
  const body = parse(OverrideBody, req.body);
  const existing = db.prepare('SELECT * FROM task_results WHERE session_id = ? AND step_id = ?').get(sid(req), stepId) as Row | undefined;
  const who = req.user?.name || req.user?.email || 'researcher';
  if (existing) {
    const prev = taskResultFromRow(existing);
    const trail = prev.source === 'researcher' ? (prev.evidence ?? '') : `Originally ${prev.outcome} (${prev.source})${prev.evidence ? `: ${prev.evidence}` : ''}`;
    const evidence = `Override by ${who}${body.note ? ` — ${body.note}` : ''}${trail ? ` | ${trail.replace(/^Override by [^|]*\| ?/, '')}` : ''}`;
    db.prepare("UPDATE task_results SET outcome = ?, source = 'researcher', evidence = ? WHERE session_id = ? AND step_id = ?").run(body.outcome, evidence, sid(req), stepId);
  } else {
    // No result yet (e.g. task never ended) — derive timing from events where possible.
    const ev = db
      .prepare("SELECT kind, t, at FROM events WHERE session_id = ? AND step_id = ? AND kind IN ('task.start','task.end','step.enter','step.exit') ORDER BY t")
      .all(sid(req), stepId) as Row[];
    const startedAt = ev.length ? Number(ev[0].at) : Date.now();
    const endedAt = ev.length ? Number(ev[ev.length - 1].at) : startedAt;
    db.prepare(
      "INSERT INTO task_results (session_id, step_id, outcome, source, started_at, ended_at, duration_ms, evidence) VALUES (?, ?, ?, 'researcher', ?, ?, ?, ?)",
    ).run(sid(req), stepId, body.outcome as TaskOutcome, startedAt, endedAt, Math.max(0, endedAt - startedAt), `Override by ${who}${body.note ? ` — ${body.note}` : ''}`);
  }
  const r = db.prepare('SELECT * FROM task_results WHERE session_id = ? AND step_id = ?').get(sid(req), stepId) as Row;
  res.json({ taskResult: taskResultFromRow(r) });
});

const NoteBody = z.object({ t: z.number().min(0), text: z.string().trim().min(1).max(5000), tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]) });

analyticsRouter.post('/sessions/:sid/notes', requireUser, (req, res) => {
  assertChildAccess(req, 'sessions', sid(req));
  const body = parse(NoteBody, req.body);
  const id = newId('note');
  db.prepare('INSERT INTO notes (id, session_id, author_id, t, text, tags, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    sid(req),
    req.user!.id,
    Math.round(body.t),
    body.text,
    json.str([...new Set(body.tags.map((t) => t.toLowerCase()))]),
    Date.now(),
  );
  const r = db.prepare('SELECT n.*, u.name AS author_name FROM notes n LEFT JOIN users u ON u.id = n.author_id WHERE n.id = ?').get(id) as Row;
  res.json({ note: noteFromRow(r) });
});

analyticsRouter.patch('/notes/:nid', requireUser, (req, res) => {
  const n = db.prepare('SELECT * FROM notes WHERE id = ?').get(String(req.params.nid)) as Row | undefined;
  if (!n) throw new HttpError(404, 'Note not found');
  assertChildAccess(req, 'sessions', String(n.session_id));
  const body = parse(NoteBody.partial(), req.body);
  db.prepare('UPDATE notes SET t = COALESCE(?, t), text = COALESCE(?, text), tags = COALESCE(?, tags) WHERE id = ?').run(
    body.t ?? null,
    body.text ?? null,
    body.tags ? json.str(body.tags) : null,
    String(req.params.nid),
  );
  const r = db.prepare('SELECT n.*, u.name AS author_name FROM notes n LEFT JOIN users u ON u.id = n.author_id WHERE n.id = ?').get(String(req.params.nid)) as Row;
  res.json({ note: noteFromRow(r) });
});

analyticsRouter.delete('/notes/:nid', requireUser, (req, res) => {
  const n = db.prepare('SELECT * FROM notes WHERE id = ?').get(String(req.params.nid)) as Row | undefined;
  if (!n) throw new HttpError(404, 'Note not found');
  assertChildAccess(req, 'sessions', String(n.session_id));
  db.prepare('DELETE FROM notes WHERE id = ?').run(String(req.params.nid));
  res.json({ ok: true });
});

analyticsRouter.delete('/sessions/:sid', requireUser, (req, res) => {
  assertChildAccess(req, 'sessions', sid(req));
  tx(() => {
    for (const t of ['events', 'task_results', 'answers', 'notes']) db.prepare(`DELETE FROM ${t} WHERE session_id = ?`).run(sid(req));
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sid(req));
  });
  deleteSessionFiles(sid(req));
  res.json({ ok: true });
});
