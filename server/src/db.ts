// SQLite (node:sqlite, synchronous). JSON columns are stored as TEXT and
// (de)serialized by the repo helpers in lib/repo.ts. Files (builds, rrweb
// chunks, audio) live under DATA_DIR — see lib/paths.ts.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { paths } from './lib/paths.ts';

fs.mkdirSync(paths.root, { recursive: true });

export const db = new DatabaseSync(paths.dbFile);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const MIGRATIONS: string[] = [
  /* 1 */ `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE auth_sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE studies (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE protocols (
    id TEXT PRIMARY KEY,
    study_id TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    protocol TEXT NOT NULL,            -- JSON Protocol
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE apps (
    id TEXT PRIMARY KEY,
    study_id TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    source_kind TEXT NOT NULL,         -- upload | url | git
    source_url TEXT,
    framework TEXT NOT NULL DEFAULT 'unknown',
    status TEXT NOT NULL DEFAULT 'queued',
    error TEXT,
    url TEXT,
    instrumented INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE variants (
    id TEXT PRIMARY KEY,
    study_id TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    protocol_id TEXT NOT NULL REFERENCES protocols(id) ON DELETE CASCADE,
    app_id TEXT REFERENCES apps(id) ON DELETE SET NULL,
    weight REAL NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE links (
    id TEXT PRIMARY KEY,
    study_id TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    variant_id TEXT REFERENCES variants(id) ON DELETE SET NULL,
    max_participants INTEGER,
    expires_at INTEGER,
    redirect_url TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    study_id TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
    variant_id TEXT NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
    link_id TEXT REFERENCES links(id) ON DELETE SET NULL,
    secret TEXT NOT NULL,
    participant_code TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'created',
    consent TEXT,                      -- JSON ConsentRecord
    device TEXT,                       -- JSON DeviceInfo
    url_params TEXT NOT NULL DEFAULT '{}',
    step_order TEXT NOT NULL DEFAULT '[]',
    steps TEXT NOT NULL DEFAULT '[]',  -- JSON Step[] snapshot (protocol may change later)
    protocol_snapshot TEXT,            -- JSON Protocol snapshot
    preview INTEGER NOT NULL DEFAULT 0,
    gaze_error_px REAL,
    started_at INTEGER,
    ended_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_study ON sessions(study_id);
  CREATE TABLE events (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    t INTEGER NOT NULL,
    at INTEGER NOT NULL,
    step_id TEXT,
    data TEXT NOT NULL,                -- JSON
    PRIMARY KEY (session_id, seq)
  );
  CREATE INDEX events_kind ON events(session_id, kind);
  CREATE TABLE task_results (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    step_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    source TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    evidence TEXT,
    PRIMARY KEY (session_id, step_id)
  );
  CREATE TABLE answers (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    step_id TEXT NOT NULL,
    question_id TEXT NOT NULL,
    text TEXT,
    value REAL,
    choices TEXT,                      -- JSON string[]
    source TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (session_id, step_id, question_id)
  );
  CREATE TABLE syntheses (
    id TEXT PRIMARY KEY,
    study_id TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    model TEXT NOT NULL,
    data TEXT NOT NULL                 -- JSON Synthesis (summary + insights + sessionCount)
  );
  CREATE TABLE notes (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    t INTEGER NOT NULL,
    text TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  );
  `,
  /* 2 */ `ALTER TABLE variants ADD COLUMN app_params TEXT NOT NULL DEFAULT '';`,
  /* 3 */ `ALTER TABLE answers ADD COLUMN declined INTEGER NOT NULL DEFAULT 0;`,
  /* 4 */ `ALTER TABLE answers ADD COLUMN wording TEXT;`,
];

db.exec('CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
const applied = new Set((db.prepare('SELECT version FROM _migrations').all() as { version: number }[]).map((r) => r.version));
MIGRATIONS.forEach((sql, i) => {
  const version = i + 1;
  if (applied.has(version)) return;
  db.exec('BEGIN');
  try {
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (version, applied_at) VALUES (?, ?)').run(version, Date.now());
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

/** Run fn inside a transaction. */
export function tx<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const json = {
  parse<T>(s: unknown, fallback: T): T {
    if (typeof s !== 'string' || !s) return fallback;
    try {
      return JSON.parse(s) as T;
    } catch {
      return fallback;
    }
  },
  str(v: unknown): string {
    return JSON.stringify(v ?? null);
  },
};
