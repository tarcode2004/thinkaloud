// CSV / JSON export of sessions, tasks, answers and events.
import type { Step } from '@thinkaloud/shared';
import { questionnaireItems } from '@thinkaloud/shared';
import { db } from '../db.ts';
import { eventFromRow, type Row } from '../lib/repo.ts';
import { loadAnswers, loadSessions, loadTaskResults, loadVariants } from './data.ts';
import { scoreSession, sessionDurationMs } from './metrics.ts';

export type ExportTable = 'sessions' | 'tasks' | 'answers' | 'events';

type Cell = string | number | boolean | null | undefined;

/** RFC 4180 escaping + spreadsheet formula-injection guard for text cells. */
export function csvCell(v: Cell): string {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Record<string, Cell>[], columns?: string[]): string {
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const lines = [cols.map(csvCell).join(',')];
  for (const r of rows) lines.push(cols.map((c) => csvCell(r[c])).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

const iso = (ms: number | null | undefined) => (ms == null ? null : new Date(ms).toISOString());

function stepTitles(steps: Step[]) {
  const titles = new Map<string, string>();
  const prompts = new Map<string, string>();
  for (const st of steps) {
    titles.set(st.id, st.title);
    if (st.type === 'question') prompts.set(`${st.id}:${st.question.id}`, st.question.prompt);
    if (st.type === 'questionnaire') for (const q of questionnaireItems(st)) prompts.set(`${st.id}:${q.id}`, q.prompt);
    if (st.type === 'task') {
      prompts.set(`${st.id}:seq`, 'Overall, how difficult or easy was the task to complete?');
      for (const q of st.postTaskQuestions ?? []) prompts.set(`${st.id}:${q.id}`, q.prompt);
    }
  }
  return { titles, prompts };
}

export function exportRows(studyId: string, table: ExportTable, opts: { includePreview?: boolean; includePoints?: boolean } = {}) {
  const sessions = loadSessions(studyId, { includePreview: opts.includePreview });
  const variants = new Map(loadVariants(studyId).map((v) => [v.id, v.name]));
  const results = loadTaskResults(studyId);
  const answers = loadAnswers(studyId);
  const rows: Record<string, Cell>[] = [];

  if (table === 'sessions') {
    for (const s of sessions) {
      const tr = results.get(s.session.id) ?? [];
      const sc = scoreSession(answers.get(s.session.id) ?? []);
      rows.push({
        sessionId: s.session.id,
        participantCode: s.session.participantCode,
        variant: variants.get(s.session.variantId) ?? s.session.variantId,
        variantId: s.session.variantId,
        status: s.session.status,
        effectiveStatus: s.effectiveStatus,
        preview: s.preview,
        createdAt: iso(s.session.createdAt),
        startedAt: iso(s.session.startedAt),
        endedAt: iso(s.session.endedAt),
        durationMs: sessionDurationMs(s),
        tasksSucceeded: tr.filter((r) => r.outcome === 'success').length,
        tasksTotal: tr.length,
        sus: sc.SUS ?? null,
        umuxLite: sc.UMUX_LITE ?? null,
        nasaTlx: sc.NASA_TLX ?? null,
        nps: sc.NPS ?? null,
        consentVersion: s.session.consent?.version ?? null,
        consentAt: iso(s.session.consent?.acceptedAt),
        consentAudio: s.session.consent?.audio ?? null,
        consentScreen: s.session.consent?.screen ?? null,
        consentEyeTracking: s.session.consent?.eyeTracking ?? null,
        gazeErrorPx: s.session.gazeErrorPx ?? null,
        viewport: s.session.device ? `${s.session.device.viewportW}x${s.session.device.viewportH}` : null,
        userAgent: s.session.device?.userAgent ?? null,
        language: s.session.device?.language ?? null,
        urlParams: JSON.stringify(s.session.urlParams ?? {}),
      });
    }
  } else if (table === 'tasks') {
    for (const s of sessions) {
      const { titles } = stepTitles(s.steps);
      const ans = answers.get(s.session.id) ?? [];
      for (const r of results.get(s.session.id) ?? []) {
        rows.push({
          sessionId: s.session.id,
          participantCode: s.session.participantCode,
          variant: variants.get(s.session.variantId) ?? s.session.variantId,
          stepId: r.stepId,
          task: titles.get(r.stepId) ?? r.stepId,
          outcome: r.outcome,
          success: r.outcome === 'success' ? 1 : 0,
          source: r.source,
          durationMs: r.durationMs,
          startedAt: iso(r.startedAt),
          endedAt: iso(r.endedAt),
          seq: ans.find((a) => a.stepId === r.stepId && a.questionId === 'seq')?.value ?? null,
          evidence: r.evidence ?? null,
        });
      }
    }
  } else if (table === 'answers') {
    for (const s of sessions) {
      const { titles, prompts } = stepTitles(s.steps);
      for (const a of answers.get(s.session.id) ?? []) {
        rows.push({
          sessionId: s.session.id,
          participantCode: s.session.participantCode,
          variant: variants.get(s.session.variantId) ?? s.session.variantId,
          stepId: a.stepId,
          step: titles.get(a.stepId) ?? a.stepId,
          questionId: a.questionId,
          question: prompts.get(`${a.stepId}:${a.questionId}`) ?? null,
          value: a.value ?? null,
          text: a.text ?? null,
          choices: a.choices?.join('; ') ?? null,
          source: a.source,
          at: iso(a.at),
        });
      }
    }
  } else {
    const ids = sessions.map((s) => s.session.id);
    const code = new Map(sessions.map((s) => [s.session.id, s.session.participantCode]));
    const variantOf = new Map(sessions.map((s) => [s.session.id, variants.get(s.session.variantId) ?? s.session.variantId]));
    if (ids.length) {
      const sql = `SELECT * FROM events WHERE session_id IN (${ids.map(() => '?').join(',')}) ${opts.includePoints ? '' : "AND kind NOT IN ('mouse','gaze')"} ORDER BY session_id, t, seq`;
      for (const r of db.prepare(sql).all(...ids) as Row[]) {
        const e = eventFromRow(r);
        rows.push({
          sessionId: e.sessionId,
          participantCode: code.get(e.sessionId!) ?? null,
          variant: variantOf.get(e.sessionId!) ?? null,
          seq: e.seq,
          kind: e.kind,
          t: e.t,
          at: iso(e.at),
          stepId: e.stepId ?? null,
          text: typeof e.data.text === 'string' ? e.data.text : null,
          path: typeof e.data.path === 'string' ? e.data.path : null,
          data: JSON.stringify(e.data),
        });
      }
    }
  }
  return rows;
}
