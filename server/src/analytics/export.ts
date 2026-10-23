// CSV / JSON export of sessions, tasks, answers and events.
import type { Step } from '@thinkaloud/shared';
import { completionScore, stepQuestions } from '@thinkaloud/shared';
import { db } from '../db.ts';
import { eventFromRow, type Row } from '../lib/repo.ts';
import { loadAnswers, loadMetricEvents, loadSessions, loadTaskResults, loadVariants } from './data.ts';
import { scoreSession, sessionDurationMs, taskBehaviour } from './metrics.ts';
import { loadConsentForm } from '../routes/consent.ts';
import type { ParticipantFieldSnapshot, ParticipantValue } from '@thinkaloud/shared';

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
    if (st.type === 'task') prompts.set(`${st.id}:seq`, 'Overall, how difficult or easy was the task to complete?');
    // stepQuestions covers every step kind, incl. interview questions ("<step>_q1").
    for (const q of stepQuestions(st)) prompts.set(`${st.id}:${q.id}`, q.prompt);
  }
  return { titles, prompts };
}

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'field';

/** Participant-info columns: the current form's fields plus fields only present in older consent records. */
export function participantColumns(studyId: string, snapshots: (ParticipantFieldSnapshot[] | undefined)[]) {
  const cols = new Map<string, ParticipantFieldSnapshot & { column: string }>();
  const used = new Set<string>();
  const add = (f: ParticipantFieldSnapshot) => {
    if (cols.has(f.id)) return;
    let column = `info.${f.id.startsWith('cf_') ? slug(f.label) : f.id}`;
    while (used.has(column)) column += '_2';
    used.add(column);
    cols.set(f.id, { ...f, column });
  };
  for (const f of loadConsentForm(studyId).fields) if (f.enabled) add(f);
  for (const snap of snapshots) for (const f of snap ?? []) add(f);
  return [...cols.values()];
}

const cellOf = (v: ParticipantValue | undefined): Cell => (v === undefined ? null : Array.isArray(v) ? v.join('; ') : v);

export function exportRows(studyId: string, table: ExportTable, opts: { includePreview?: boolean; includePoints?: boolean; excludePii?: boolean } = {}) {
  const sessions = loadSessions(studyId, { includePreview: opts.includePreview });
  const variants = new Map(loadVariants(studyId).map((v) => [v.id, v.name]));
  const results = loadTaskResults(studyId);
  const answers = loadAnswers(studyId);
  const rows: Record<string, Cell>[] = [];

  if (table === 'sessions') {
    const infoCols = participantColumns(studyId, sessions.map((s) => s.session.consent?.fields)).filter((c) => !(opts.excludePii && c.pii));
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
        consentFormVersion: s.session.consent?.formVersion ?? null,
        consentFormHash: s.session.consent?.formHash ?? null,
        consentSignature: s.session.consent?.signature?.mode ?? null,
        ...(opts.excludePii ? {} : { consentSignedName: s.session.consent?.signature?.name ?? null }),
        consentSignedDate: s.session.consent?.signature?.date ?? null,
        ...Object.fromEntries(infoCols.map((c) => [c.column, cellOf(s.session.participantInfo?.[c.id])])),
        gazeErrorPx: s.session.gazeErrorPx ?? null,
        viewport: s.session.device ? `${s.session.device.viewportW}x${s.session.device.viewportH}` : null,
        userAgent: s.session.device?.userAgent ?? null,
        language: s.session.device?.language ?? null,
        urlParams: JSON.stringify(s.session.urlParams ?? {}),
      });
    }
  } else if (table === 'tasks') {
    const events = loadMetricEvents(studyId);
    for (const s of sessions) {
      const { titles } = stepTitles(s.steps);
      const ans = answers.get(s.session.id) ?? [];
      const evs = events.get(s.session.id) ?? [];
      for (const r of results.get(s.session.id) ?? []) {
        const b = taskBehaviour(evs, r.stepId, null);
        const assists = evs.filter((e) => e.kind === 'task.assist' && e.stepId === r.stepId);
        const a = r.assistance ?? { general: 0, direct: 0 };
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
          completionScore: r.completionScore ?? completionScore(r.outcome, a),
          assistGeneral: a.general,
          assistDirect: a.direct,
          assistanceGiven: assists.length
            ? assists.map((e) => `[${Math.round(Number(e.data.atMs ?? 0) / 1000)}s ${e.data.level === 'direct' ? 'direct' : 'general'}] ${String(e.data.text ?? '')}`).join(' | ')
            : null,
          firstAction: b.firstAction,
          backtracks: b.hasApp ? b.backtracks : null,
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
          declined: a.declined ? 1 : 0,
          wording: a.wording ?? null,
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
