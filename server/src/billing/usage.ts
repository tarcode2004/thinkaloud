// Metered usage: one `voice_minutes` usage event per real (non-preview) session that used voice.
// Voice time runs from the first realtime-token mint to the end of the session, rounded up to
// whole minutes and capped. usage_events has UNIQUE(session_id, kind), so recording is idempotent.
import { newId } from '@thinkaloud/shared';
import { db } from '../db.ts';
import { billingEnabled, billingSettings } from './config.ts';
import { getAccount, VOICE_MINUTES } from './account.ts';

const MINUTE = 60_000;

/** Pure: billable whole minutes for a voice session. Any voice use bills at least one minute. */
export function voiceMinutes(voiceStartedAt: number, endedAt: number, maxMinutes = billingSettings().maxSessionMinutes): number {
  const ms = Math.max(0, endedAt - voiceStartedAt);
  return Math.min(Math.max(1, Math.ceil(ms / MINUTE)), Math.max(1, maxMinutes));
}

/** Called on every realtime-token mint; only the first one sets the start. */
export function markVoiceStarted(sessionId: string, now = Date.now()) {
  db.prepare('UPDATE sessions SET voice_started_at = COALESCE(voice_started_at, ?), voice_last_seen_at = ? WHERE id = ?').run(now, now, sessionId);
}

/** Participant activity after voice started (server clock, so client clock skew can't shorten a session). */
export function touchVoice(sessionId: string, now = Date.now()) {
  db.prepare('UPDATE sessions SET voice_last_seen_at = ? WHERE id = ? AND voice_started_at IS NOT NULL').run(now, sessionId);
}

interface SessionUsageRow {
  id: string;
  preview: number;
  status: string;
  voice_started_at: number | null;
  voice_last_seen_at: number | null;
  ended_at: number | null;
  owner_id: string;
}

const sessionRow = (sessionId: string) =>
  db
    .prepare(
      `SELECT s.id, s.preview, s.status, s.voice_started_at, s.voice_last_seen_at, s.ended_at, st.owner_id
       FROM sessions s JOIN studies st ON st.id = s.study_id WHERE s.id = ?`,
    )
    .get(sessionId) as SessionUsageRow | undefined;

/**
 * Record the session's voice minutes once. `end` defaults to the session's ended_at (or now).
 * Returns the minutes recorded, or null when nothing is billable (billing off, preview, no voice,
 * or already recorded).
 */
export function recordSessionUsage(sessionId: string, opts: { end?: number; now?: number } = {}): number | null {
  if (!billingEnabled()) return null;
  const s = sessionRow(sessionId);
  if (!s || s.preview || s.voice_started_at == null) return null;
  const now = opts.now ?? Date.now();
  const end = Math.min(opts.end ?? s.ended_at ?? now, now);
  const minutes = voiceMinutes(s.voice_started_at, end);
  const acc = getAccount(s.owner_id);
  // Trial minutes are free and never sent to Stripe; accounts without a customer can't be billed.
  const skipped = acc?.status === 'trialing' ? 'trial' : !acc?.stripe_customer_id ? 'no_customer' : null;
  const r = db
    .prepare(
      `INSERT OR IGNORE INTO usage_events (id, user_id, session_id, kind, quantity, at, skipped) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(newId('use'), s.owner_id, s.id, VOICE_MINUTES, minutes, end, skipped);
  return Number(r.changes) ? minutes : null;
}

/**
 * Bill sessions that used voice but never reported an end: participants who closed the tab,
 * lost their connection, or ended in a state the client couldn't report. Also catches ended
 * sessions whose usage wasn't recorded (e.g. billing was switched on mid-session).
 */
export function sweepUnbilledSessions(now = Date.now()): number {
  if (!billingEnabled()) return 0;
  const idleBefore = now - billingSettings().abandonAfterMinutes * MINUTE;
  const rows = db
    .prepare(
      `SELECT s.id, s.status, s.ended_at, s.voice_started_at, s.voice_last_seen_at FROM sessions s
       WHERE s.preview = 0 AND s.voice_started_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM usage_events u WHERE u.session_id = s.id AND u.kind = ?)
         AND (s.status IN ('completed', 'abandoned', 'withdrawn') OR COALESCE(s.voice_last_seen_at, s.voice_started_at) < ?)
       LIMIT 500`,
    )
    .all(VOICE_MINUTES, idleBefore) as { id: string; status: string; ended_at: number | null; voice_started_at: number; voice_last_seen_at: number | null }[];
  let n = 0;
  for (const r of rows) {
    const ended = r.status === 'completed' || r.status === 'abandoned' || r.status === 'withdrawn';
    const end = ended && r.ended_at ? r.ended_at : (r.voice_last_seen_at ?? r.voice_started_at);
    if (recordSessionUsage(r.id, { end, now }) != null) n++;
  }
  return n;
}
