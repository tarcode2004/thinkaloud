// Heatmap data: click / gaze / mouse points for a task + page path, normalized to the viewport,
// plus first-click analysis and a reference to an rrweb moment that shows that page.
import type { ClickData, PointBatchData, SuccessRule, TaskStep } from '@thinkaloud/shared';
import { db, json } from '../db.ts';
import type { Row } from '../lib/repo.ts';
import { loadSessions, loadTaskResults, loadProtocols, loadVariants } from './data.ts';
import { hasReplay } from './media.ts';

export type HeatKind = 'click' | 'gaze' | 'mouse';

export interface HeatPoint {
  /** Normalized viewport coordinates 0..1 */
  nx: number;
  ny: number;
  /** Document (scroll-adjusted) coordinates normalized by viewport width/height (can exceed 1 vertically). */
  px: number;
  py: number;
  sessionId: string;
  t: number;
  dead?: boolean;
  rage?: boolean;
}

export interface FirstClick {
  sessionId: string;
  participantCode: string;
  variantId: string;
  nx: number;
  ny: number;
  ms: number | null;
  target: string;
  selector: string;
  path: string;
  outcome: string | null;
  /** Matches a click_matches success rule of the task (null when the task has no such rule). */
  onTarget: boolean | null;
}

export const normPath = (p: unknown) => {
  const s = String(p ?? '').split('#')[0] || '/';
  return s.length > 1 ? s.replace(/\/+$/, '') : s;
};

function clickMatchesRule(el: ClickData['el'] | undefined, rules: SuccessRule[] | undefined): boolean | null {
  const cr = (rules ?? []).filter((r): r is Extract<SuccessRule, { type: 'click_matches' }> => r.type === 'click_matches');
  if (!cr.length) return null;
  if (!el) return false;
  return cr.some((r) => {
    const selOk = !r.selector || el.selector?.includes(r.selector) || r.selector.split(/[\s>]+/).every((part) => (el.selector ?? '').includes(part));
    const textOk = !r.text || (el.text ?? '').toLowerCase().includes(r.text.toLowerCase()) || (el.ariaLabel ?? '').toLowerCase().includes(r.text.toLowerCase());
    return selOk && textOk;
  });
}

export function computeHeatmap(
  studyId: string,
  q: { stepId?: string | null; path?: string | null; kind: HeatKind; variantId?: string | null; includePreview?: boolean },
) {
  const sessions = loadSessions(studyId, { includePreview: q.includePreview }).filter((s) => !q.variantId || s.session.variantId === q.variantId);
  const byId = new Map(sessions.map((s) => [s.session.id, s]));
  const ids = [...byId.keys()];
  const results = loadTaskResults(studyId);
  const protocols = loadProtocols(studyId);
  const variants = loadVariants(studyId);
  // Task definition (for click rules) from any session snapshot / protocol.
  let task: TaskStep | undefined;
  if (q.stepId) {
    for (const s of sessions) {
      task = s.steps.find((st): st is TaskStep => st.id === q.stepId && st.type === 'task');
      if (task) break;
    }
    if (!task)
      for (const p of protocols.values()) {
        task = p.steps.find((st): st is TaskStep => st.id === q.stepId && st.type === 'task');
        if (task) break;
      }
  }

  const kinds = q.kind === 'click' ? ['app.click', 'app.dead_click', 'app.rage_click'] : [q.kind];
  const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(',');
  const rows: Row[] = ids.length
    ? (db
        .prepare(
          `SELECT session_id, kind, t, step_id, data FROM events WHERE session_id IN (${placeholders(ids.length)}) AND kind IN (${placeholders(kinds.length)})
           ${q.stepId ? 'AND step_id = ?' : ''} ORDER BY session_id, t, seq`,
        )
        .all(...ids, ...kinds, ...(q.stepId ? [q.stepId] : [])) as Row[])
    : [];

  const wantPath = q.path ? normPath(q.path) : null;
  const pathCounts = new Map<string, number>();
  const points: HeatPoint[] = [];
  const vws: number[] = [];
  const vhs: number[] = [];
  const deadKeys = new Set<string>();
  const rageKeys = new Set<string>();
  const key = (sid: string, t: number) => `${sid}:${Math.round(t / 50)}`;
  if (q.kind === 'click') {
    for (const r of rows) {
      const sid = String(r.session_id);
      if (r.kind === 'app.dead_click') deadKeys.add(key(sid, Number(r.t)));
      if (r.kind === 'app.rage_click') rageKeys.add(key(sid, Number(r.t)));
    }
  }
  let firstSnapshot: { sessionId: string; t: number; path: string; timestamp?: number } | null = null;
  const replayCache = new Map<string, boolean>();
  const replayOk = (sid: string) => {
    if (!replayCache.has(sid)) replayCache.set(sid, hasReplay(sid));
    return replayCache.get(sid)!;
  };

  for (const r of rows) {
    const sid = String(r.session_id);
    const d = json.parse<Record<string, unknown>>(r.data, {});
    if (q.kind === 'click') {
      if (r.kind !== 'app.click') continue;
      const c = d as unknown as ClickData;
      const p = normPath(c.path);
      pathCounts.set(p, (pathCounts.get(p) ?? 0) + 1);
      if (wantPath && p !== wantPath) continue;
      if (!c.vw || !c.vh) continue;
      vws.push(c.vw);
      vhs.push(c.vh);
      const t = Number(r.t);
      points.push({
        nx: c.x / c.vw,
        ny: c.y / c.vh,
        px: (c.pageX ?? c.x) / c.vw,
        py: (c.pageY ?? c.y) / c.vh,
        sessionId: sid,
        t,
        ...(deadKeys.has(key(sid, t)) || deadKeys.has(key(sid, t + 50)) ? { dead: true } : {}),
        ...(rageKeys.has(key(sid, t)) ? { rage: true } : {}),
      });
      if (!firstSnapshot && replayOk(sid)) firstSnapshot = { sessionId: sid, t: Math.max(0, t - 30), path: p };
    } else {
      const b = d as unknown as PointBatchData;
      const p = normPath(b.path);
      pathCounts.set(p, (pathCounts.get(p) ?? 0) + (b.points?.length ?? 0));
      if (wantPath && p !== wantPath) continue;
      if (!b.vw || !b.vh) continue;
      vws.push(b.vw);
      vhs.push(b.vh);
      for (const pt of b.points ?? []) {
        const [t, x, y] = pt;
        if (x < 0 || y < 0 || x > b.vw || y > b.vh) continue;
        points.push({ nx: x / b.vw, ny: y / b.vh, px: (x + (b.scrollX ?? 0)) / b.vw, py: (y + (b.scrollY ?? 0)) / b.vh, sessionId: sid, t });
      }
      if (!firstSnapshot && replayOk(sid) && b.points?.length) firstSnapshot = { sessionId: sid, t: b.points[0][0], path: p };
    }
  }

  // First-click analysis (always computed from clicks of the selected task, regardless of `kind`).
  const firstClicks: FirstClick[] = [];
  if (q.stepId && ids.length) {
    const fc = db
      .prepare(
        `SELECT e.session_id, e.t, e.data, (SELECT MIN(t) FROM events s WHERE s.session_id = e.session_id AND s.kind = 'task.start' AND s.step_id = e.step_id) AS start_t
         FROM events e WHERE e.session_id IN (${placeholders(ids.length)}) AND e.kind = 'app.click' AND e.step_id = ?
         AND e.t = (SELECT MIN(t) FROM events x WHERE x.session_id = e.session_id AND x.kind = 'app.click' AND x.step_id = e.step_id)`,
      )
      .all(...ids, q.stepId) as Row[];
    for (const r of fc) {
      const sid = String(r.session_id);
      const s = byId.get(sid)!;
      const c = json.parse<ClickData>(r.data, {} as ClickData);
      if (!c.vw || !c.vh) continue;
      const res = results.get(sid)?.find((x) => x.stepId === q.stepId);
      firstClicks.push({
        sessionId: sid,
        participantCode: s.session.participantCode,
        variantId: s.session.variantId,
        nx: c.x / c.vw,
        ny: c.y / c.vh,
        ms: r.start_t == null ? null : Number(r.t) - Number(r.start_t),
        target: (c.el?.text || c.el?.ariaLabel || c.el?.selector || '?').slice(0, 80),
        selector: c.el?.selector ?? '',
        path: normPath(c.path),
        outcome: res?.outcome ?? null,
        onTarget: clickMatchesRule(c.el, task?.successRules),
      });
    }
  }
  // Group first clicks by target → share + downstream success (Bailey & Wolfson: correct first click ≈ 2× success).
  const groups = new Map<string, { target: string; selector: string; count: number; successes: number; withOutcome: number; onTarget: boolean | null }>();
  for (const f of firstClicks) {
    const k = f.selector || f.target;
    const g = groups.get(k) ?? { target: f.target, selector: f.selector, count: 0, successes: 0, withOutcome: 0, onTarget: f.onTarget };
    g.count++;
    if (f.outcome) {
      g.withOutcome++;
      if (f.outcome === 'success') g.successes++;
    }
    groups.set(k, g);
  }

  const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
  const tasks: { stepId: string; title: string }[] = [];
  const seenT = new Set<string>();
  for (const v of variants)
    for (const st of protocols.get(v.protocolId)?.steps ?? [])
      if (st.type === 'task' && !seenT.has(st.id)) (seenT.add(st.id), tasks.push({ stepId: st.id, title: st.title }));

  return {
    kind: q.kind,
    stepId: q.stepId ?? null,
    path: wantPath,
    paths: [...pathCounts.entries()].sort((a, b) => b[1] - a[1]).map(([path, count]) => ({ path, count })),
    viewport: { w: med(vws) ?? 1280, h: med(vhs) ?? 800 },
    points,
    sessions: new Set(points.map((p) => p.sessionId)).size,
    snapshot: firstSnapshot
      ? { ...firstSnapshot, timestamp: (byId.get(firstSnapshot.sessionId)?.session.startedAt ?? 0) + firstSnapshot.t }
      : null,
    firstClicks,
    firstClickTargets: [...groups.values()].sort((a, b) => b.count - a.count),
    tasks,
    variants: variants.map((v) => ({ id: v.id, name: v.name })),
  };
}
