import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { starterProtocol, type Step } from '@thinkaloud/shared';
import type { Row } from '../lib/repo.ts';

// db.ts opens the database at import time from DATA_DIR → set it first, import dynamically.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-core-test-'));
process.env.DATA_DIR = dataDir;

type Mod = typeof import('./participant.ts');
let m: Mod;
let db: typeof import('../db.ts').db;
let paths: typeof import('../lib/paths.ts').paths;
let repo: typeof import('../lib/repo.ts');

before(async () => {
  m = await import('./participant.ts');
  ({ db } = await import('../db.ts'));
  ({ paths } = await import('../lib/paths.ts'));
  repo = await import('../lib/repo.ts');
});
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('pickVariant picks the least-loaded variant and respects weights', () => {
  const vs = [
    { id: 'a', weight: 2 },
    { id: 'b', weight: 1 },
  ];
  const counts: Record<string, number> = { a: 0, b: 0 };
  for (let i = 0; i < 300; i++) counts[m.pickVariant(vs, counts, rng(i))!.id]++;
  assert.deepEqual(counts, { a: 200, b: 100 });

  assert.equal(m.pickVariant([{ id: 'a', weight: 1 }, { id: 'b', weight: 1 }], { a: 5, b: 3 })!.id, 'b');
  assert.equal(m.pickVariant([], {}), null);
  // zero-weight variants are skipped while a positive one exists
  assert.equal(m.pickVariant([{ id: 'z', weight: 0 }, { id: 'p', weight: 1 }], { z: 0, p: 100 })!.id, 'p');
});

test('pickVariant breaks ties randomly across all tied variants', () => {
  const vs = [{ id: 'a', weight: 1 }, { id: 'b', weight: 1 }, { id: 'c', weight: 1 }];
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) seen.add(m.pickVariant(vs, {}, rng(i))!.id);
  assert.deepEqual([...seen].sort(), ['a', 'b', 'c']);
});

test('resolveStepOrder shuffles tasks within task slots only', () => {
  const steps = starterProtocol().steps;
  steps.splice(4, 0, { id: 'task_3', type: 'task', title: 'T3', instruction: 'x', successCriteria: 'y' } as Step);
  const kinds = steps.map((s) => s.type);
  assert.deepEqual(m.resolveStepOrder(steps, false), steps);
  const firstSlot = new Set<string>();
  for (let i = 0; i < 60; i++) {
    const out = m.resolveStepOrder(steps, true, rng(i));
    assert.deepEqual(out.map((s) => s.type), kinds, 'slot types preserved');
    assert.deepEqual(out.filter((s) => s.type !== 'task'), steps.filter((s) => s.type !== 'task'), 'non-task steps fixed');
    assert.deepEqual(out.filter((s) => s.type === 'task').map((s) => s.id).sort(), ['task_1', 'task_2', 'task_3']);
    firstSlot.add(out.find((s) => s.type === 'task')!.id);
  }
  assert.equal(firstSlot.size, 3, 'every task can come first');
});

test('participant codes look like P-XXXX', () => {
  for (let i = 0; i < 50; i++) assert.match(m.participantCode(), /^P-[2-9A-HJKMNP-Z]{4}$/);
});

function seedSession(): string {
  const now = Date.now();
  const u = `u_${now}_${Math.random()}`;
  db.prepare('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(u, `${u}@x.dev`, 'T', 'x', now);
  db.prepare("INSERT INTO studies (id, owner_id, name, status, created_at, updated_at) VALUES (?, ?, 'S', 'live', ?, ?)").run(`s_${u}`, u, now, now);
  db.prepare('INSERT INTO protocols (id, study_id, name, protocol, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    `p_${u}`, `s_${u}`, 'P', JSON.stringify(starterProtocol()), now, now,
  );
  db.prepare('INSERT INTO variants (id, study_id, name, protocol_id, created_at) VALUES (?, ?, ?, ?, ?)').run(`v_${u}`, `s_${u}`, 'A', `p_${u}`, now);
  db.prepare('INSERT INTO links (id, study_id, token, name, created_at) VALUES (?, ?, ?, ?, ?)').run(`l_${u}`, `s_${u}`, `t_${u}`, 'L', now);
  db.prepare(
    "INSERT INTO sessions (id, study_id, variant_id, link_id, secret, participant_code, status, created_at) VALUES (?, ?, ?, ?, 'sec', 'P-TEST', 'in_progress', ?)",
  ).run(`ses_${u}`, `s_${u}`, `v_${u}`, `l_${u}`, now);
  return `ses_${u}`;
}

test('ingestEvents stores events idempotently and applies side effects', () => {
  const sid = seedSession();
  const batch = [
    { seq: 0, kind: 'task.start', t: 100, at: 1000, stepId: 'task_1', data: {} },
    {
      seq: 1, kind: 'task.end', t: 5100, at: 6000, stepId: 'task_1',
      data: { outcome: 'success', source: 'rule', startedAt: 1000, endedAt: 6000, durationMs: 5000, evidence: 'url matched' },
    },
    { seq: 2, kind: 'answer', t: 6000, at: 7000, stepId: 'task_1', data: { questionId: 'seq', value: 6, source: 'voice', text: 'fine' } },
    { seq: 3, kind: 'answer', t: 6500, at: 7500, data: { stepId: 'warmup', questionId: 'warmup_q', text: 'I shop online weekly', source: 'voice' } },
    { seq: 4, kind: 'eyetracking.calibrated', t: 50, at: 900, data: { errorPx: 142.5 } },
    { seq: 5, kind: 'app.click', t: 'nope', at: 1 }, // invalid → rejected
    { seq: 6, kind: 'mouse', t: 1, at: 1, data: { blob: 'x'.repeat(300 * 1024) } }, // oversize → rejected
  ];
  assert.deepEqual(m.ingestEvents(sid, batch), { accepted: 5, rejected: 2 });
  assert.deepEqual(m.ingestEvents(sid, batch), { accepted: 0, rejected: 2 }, 'resend is a no-op');

  const tr = (db.prepare('SELECT * FROM task_results WHERE session_id = ?').all(sid) as Row[]).map(repo.taskResultFromRow);
  assert.deepEqual(tr, [{ sessionId: sid, stepId: 'task_1', outcome: 'success', source: 'rule', startedAt: 1000, endedAt: 6000, durationMs: 5000, evidence: 'url matched' }]);

  const answers = (db.prepare('SELECT * FROM answers WHERE session_id = ? ORDER BY at').all(sid) as Row[]).map(repo.answerFromRow);
  assert.equal(answers.length, 2);
  assert.deepEqual(answers[0], { sessionId: sid, stepId: 'task_1', questionId: 'seq', value: 6, text: 'fine', source: 'voice', at: 7000 });
  assert.equal(answers[1].stepId, 'warmup');

  const s = repo.sessionFromRow(db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid) as Row);
  assert.equal(s.gazeErrorPx, 142.5);

  const ev = (db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY seq').all(sid) as Row[]).map(repo.eventFromRow);
  assert.deepEqual(ev.map((e) => e.seq), [0, 1, 2, 3, 4]);
  assert.equal(ev[0].stepId, 'task_1');
  assert.equal(ev[4].stepId, null);
});

test('answers are upserted; researcher task overrides are never overwritten', () => {
  const sid = seedSession();
  m.ingestEvents(sid, [{ seq: 1, kind: 'answer', t: 1, at: 1, stepId: 'q', data: { questionId: 'x', value: 2, source: 'screen' } }]);
  m.ingestEvents(sid, [{ seq: 2, kind: 'answer', t: 2, at: 2, stepId: 'q', data: { questionId: 'x', value: 4, choices: ['a'], source: 'screen' } }]);
  const a = db.prepare('SELECT * FROM answers WHERE session_id = ?').all(sid) as Row[];
  assert.equal(a.length, 1);
  assert.deepEqual(repo.answerFromRow(a[0]).choices, ['a']);
  assert.equal(repo.answerFromRow(a[0]).value, 4);

  db.prepare("INSERT INTO task_results VALUES (?, 't', 'failure', 'researcher', 1, 2, 1, NULL)").run(sid);
  m.ingestEvents(sid, [{ seq: 3, kind: 'task.end', t: 3, at: 3, stepId: 't', data: { outcome: 'success', source: 'ai', startedAt: 1, endedAt: 3, durationMs: 2 } }]);
  const r = db.prepare('SELECT outcome, source FROM task_results WHERE session_id = ?').get(sid) as Row;
  assert.deepEqual({ ...r }, { outcome: 'failure', source: 'researcher' });
});

test('events without seq get server-assigned sequence numbers', () => {
  const sid = seedSession();
  m.ingestEvents(sid, [{ seq: 10, kind: 'note', t: 1, at: 1, data: {} }]);
  assert.deepEqual(m.ingestEvents(sid, [{ kind: 'note', t: 2, at: 2, data: {} }, { kind: 'note', t: 3, at: 3 }]), { accepted: 2, rejected: 0 });
  const seqs = (db.prepare('SELECT seq FROM events WHERE session_id = ? ORDER BY seq').all(sid) as { seq: number }[]).map((r) => r.seq);
  assert.deepEqual(seqs, [10, 11, 12]);
});

test('withdrawSession deletes captured data and files', () => {
  const sid = seedSession();
  m.ingestEvents(sid, [
    { seq: 1, kind: 'answer', t: 1, at: 1, stepId: 'q', data: { questionId: 'x', text: 'hi', source: 'text' } },
    { seq: 2, kind: 'task.end', t: 3, at: 3, stepId: 't', data: { outcome: 'success', startedAt: 1, endedAt: 3, durationMs: 2 } },
  ]);
  fs.mkdirSync(paths.session(sid), { recursive: true });
  fs.writeFileSync(path.join(paths.session(sid), 'rrweb-000001.json'), '[]');
  m.withdrawSession(sid);
  for (const t of ['events', 'answers', 'task_results']) {
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE session_id = ?`).get(sid) as { n: number }).n, 0, t);
  }
  assert.equal(fs.existsSync(paths.session(sid)), false);
  assert.equal((db.prepare('SELECT status FROM sessions WHERE id = ?').get(sid) as Row).status, 'withdrawn');
});
