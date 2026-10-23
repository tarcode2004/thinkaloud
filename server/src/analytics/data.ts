// Data access for analytics: loads study sessions + related rows in bulk and maps them to API objects.
import type { Answer, Protocol, Session, SessionEvent, Step, TaskResult, Variant } from '@thinkaloud/shared';
import { db, json } from '../db.ts';
import {
  answerFromRow,
  eventFromRow,
  protocolFromRow,
  sessionFromRow,
  sessionProtocolFromRow,
  sessionStepsFromRow,
  taskResultFromRow,
  variantFromRow,
  type Row,
} from '../lib/repo.ts';

/** In-progress sessions with no activity for this long are treated as abandoned. */
export const STALE_MS = 15 * 60_000;

export type EffectiveStatus = Session['status'];

export interface LoadedSession {
  session: Session;
  preview: boolean;
  steps: Step[];
  protocol: Protocol | null;
  /** Last activity (wall clock): latest event, else startedAt / createdAt. */
  lastActivityAt: number;
  /** Status with stale in-progress sessions mapped to 'abandoned'. */
  effectiveStatus: EffectiveStatus;
  stale: boolean;
}

export interface Note {
  id: string;
  sessionId: string;
  authorId: string | null;
  authorName?: string | null;
  t: number;
  text: string;
  tags: string[];
  createdAt: number;
}

export function noteFromRow(r: Row): Note {
  return {
    id: String(r.id),
    sessionId: String(r.session_id),
    authorId: r.author_id == null ? null : String(r.author_id),
    authorName: r.author_name == null ? null : String(r.author_name),
    t: Number(r.t),
    text: String(r.text ?? ''),
    tags: json.parse<string[]>(r.tags, []),
    createdAt: Number(r.created_at),
  };
}

export function loadVariants(studyId: string): Variant[] {
  return (db.prepare('SELECT * FROM variants WHERE study_id = ? ORDER BY created_at, name').all(studyId) as Row[]).map(variantFromRow);
}

export function loadProtocols(studyId: string): Map<string, Protocol> {
  const m = new Map<string, Protocol>();
  for (const r of db.prepare('SELECT * FROM protocols WHERE study_id = ?').all(studyId) as Row[]) {
    const p = protocolFromRow(r);
    m.set(p.id, p.protocol);
  }
  return m;
}

export function effectiveStatusOf(status: Session['status'], lastActivityAt: number, now = Date.now()) {
  const live = status === 'created' || status === 'consented' || status === 'in_progress';
  const stale = live && now - lastActivityAt > STALE_MS;
  return { effectiveStatus: (stale ? 'abandoned' : status) as EffectiveStatus, stale };
}

function toLoaded(r: Row, lastAt: number | undefined, now: number): LoadedSession {
  const session = sessionFromRow(r);
  const lastActivityAt = Math.max(lastAt ?? 0, session.startedAt ?? 0, session.createdAt);
  return {
    session,
    preview: Boolean(r.preview),
    steps: sessionStepsFromRow(r),
    protocol: sessionProtocolFromRow(r),
    lastActivityAt,
    ...effectiveStatusOf(session.status, lastActivityAt, now),
  };
}

export interface LoadOptions {
  includePreview?: boolean;
  includeWithdrawn?: boolean;
}

export function loadSessions(studyId: string, opts: LoadOptions = {}): LoadedSession[] {
  const rows = db.prepare('SELECT * FROM sessions WHERE study_id = ? ORDER BY created_at').all(studyId) as Row[];
  const last = new Map<string, number>();
  for (const r of db
    .prepare('SELECT e.session_id AS sid, MAX(e.at) AS last FROM events e JOIN sessions s ON s.id = e.session_id WHERE s.study_id = ? GROUP BY e.session_id')
    .all(studyId) as Row[])
    last.set(String(r.sid), Number(r.last));
  const now = Date.now();
  return rows
    .filter((r) => (opts.includePreview || !r.preview) && (opts.includeWithdrawn || r.status !== 'withdrawn'))
    .map((r) => toLoaded(r, last.get(String(r.id)), now));
}

export function loadSession(sessionId: string): LoadedSession | null {
  const r = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as Row | undefined;
  if (!r) return null;
  const last = db.prepare('SELECT MAX(at) AS last FROM events WHERE session_id = ?').get(sessionId) as Row | undefined;
  return toLoaded(r, last?.last == null ? undefined : Number(last.last), Date.now());
}

/** Rows for a set of sessions in the study, grouped by session id. */
function groupBy<T extends { sessionId?: string }>(items: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = it.sessionId ?? '';
    let arr = m.get(k);
    if (!arr) m.set(k, (arr = []));
    arr.push(it);
  }
  return m;
}

export function loadTaskResults(studyId: string): Map<string, TaskResult[]> {
  const rows = db
    .prepare('SELECT tr.* FROM task_results tr JOIN sessions s ON s.id = tr.session_id WHERE s.study_id = ?')
    .all(studyId) as Row[];
  return groupBy(rows.map(taskResultFromRow));
}

export function loadAnswers(studyId: string): Map<string, Answer[]> {
  const rows = db.prepare('SELECT a.* FROM answers a JOIN sessions s ON s.id = a.session_id WHERE s.study_id = ? ORDER BY a.at').all(studyId) as Row[];
  return groupBy(rows.map(answerFromRow));
}

/** Behavioural event kinds used in metrics (excludes high-frequency mouse/gaze and transcripts). */
export const METRIC_EVENT_KINDS = [
  'task.start',
  'task.end',
  'task.resume',
  'task.assist',
  'step.enter',
  'app.navigate',
  'app.click',
  'app.dead_click',
  'app.rage_click',
  'app.error',
  'app.console_error',
  'app.network_error',
  'app.crash',
] as const;

export function loadMetricEvents(studyId: string): Map<string, SessionEvent[]> {
  const kinds = METRIC_EVENT_KINDS.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT e.* FROM events e JOIN sessions s ON s.id = e.session_id
       WHERE s.study_id = ? AND e.kind IN (${kinds}) ORDER BY e.session_id, e.t, e.seq`,
    )
    .all(studyId, ...METRIC_EVENT_KINDS) as Row[];
  return groupBy(rows.map(eventFromRow));
}

export function loadSessionEvents(sessionId: string, opts: { excludePoints?: boolean } = {}): SessionEvent[] {
  const sql = opts.excludePoints
    ? "SELECT * FROM events WHERE session_id = ? AND kind NOT IN ('mouse','gaze') ORDER BY t, seq"
    : 'SELECT * FROM events WHERE session_id = ? ORDER BY t, seq';
  return (db.prepare(sql).all(sessionId) as Row[]).map(eventFromRow);
}

export function loadNotes(sessionId: string): Note[] {
  return (
    db
      .prepare('SELECT n.*, u.name AS author_name FROM notes n LEFT JOIN users u ON u.id = n.author_id WHERE n.session_id = ? ORDER BY n.t, n.created_at')
      .all(sessionId) as Row[]
  ).map(noteFromRow);
}
