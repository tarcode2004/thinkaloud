// Derived 2/1/0 completion score for a task result: outcome + the task.assist events of that step.
import { completionScore, type AssistanceSummary, type TaskOutcome } from '@thinkaloud/shared';
import { db, json } from '../db.ts';

export function assistanceFor(sessionId: string, stepId: string): AssistanceSummary {
  const rows = db.prepare("SELECT data FROM events WHERE session_id = ? AND step_id = ? AND kind = 'task.assist'").all(sessionId, stepId) as { data: string }[];
  const a: AssistanceSummary = { general: 0, direct: 0 };
  for (const r of rows) {
    const d = json.parse<{ level?: string }>(r.data, {});
    if (d.level === 'direct') a.direct++;
    else a.general++;
  }
  return a;
}

/** Recompute and store the score of one task result (no-op when the task has no result yet). */
export function refreshCompletionScore(sessionId: string, stepId: string): void {
  const row = db.prepare('SELECT outcome FROM task_results WHERE session_id = ? AND step_id = ?').get(sessionId, stepId) as { outcome: string } | undefined;
  if (!row) return;
  const a = assistanceFor(sessionId, stepId);
  db.prepare('UPDATE task_results SET completion_score = ?, assistance = ? WHERE session_id = ? AND step_id = ?').run(
    completionScore(row.outcome as TaskOutcome, a),
    JSON.stringify(a),
    sessionId,
    stepId,
  );
}
