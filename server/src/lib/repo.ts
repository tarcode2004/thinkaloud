// Row → API object mappers shared by every route module.
// Conventions: snake_case columns → camelCase fields, JSON TEXT columns parsed,
// INTEGER booleans → boolean, SQL NULL → null (or omitted for optional fields).
import type {
  Answer,
  AppBuild,
  ConsentRecord,
  DeviceInfo,
  Protocol,
  ProtocolRecord,
  Session,
  SessionEvent,
  Step,
  Study,
  StudyLink,
  TaskResult,
  Variant,
} from '@thinkaloud/shared';
import { emptyProtocol } from '@thinkaloud/shared';
import { json } from '../db.ts';
import { config } from './config.ts';
import { normalizeProtocol } from './protocolSchema.ts';

export type Row = Record<string, unknown>;

const str = (v: unknown): string => (v == null ? '' : String(v));
const optStr = (v: unknown): string | undefined => (v == null ? undefined : String(v));
const nullStr = (v: unknown): string | null => (v == null ? null : String(v));
const nullNum = (v: unknown): number | null => (v == null ? null : Number(v));
const optNum = (v: unknown): number | undefined => (v == null ? undefined : Number(v));

/** Public participant URL for a link token. */
export function linkUrl(token: string): string {
  return `${config.publicUrl}/s/${token}`;
}

/** Parse a stored protocol JSON string; tolerant of older/partial JSON. */
export function parseProtocol(raw: unknown): Protocol {
  const obj = json.parse<unknown>(raw, null);
  if (!obj) return emptyProtocol();
  try {
    return normalizeProtocol(obj);
  } catch {
    return obj as Protocol;
  }
}

export function studyFromRow(r: Row): Study {
  return {
    id: str(r.id),
    ownerId: str(r.owner_id),
    name: str(r.name),
    description: str(r.description),
    status: str(r.status) as Study['status'],
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export function protocolFromRow(r: Row): ProtocolRecord {
  return {
    id: str(r.id),
    studyId: str(r.study_id),
    name: str(r.name),
    protocol: parseProtocol(r.protocol),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export function appFromRow(r: Row): AppBuild {
  return {
    id: str(r.id),
    studyId: str(r.study_id),
    name: str(r.name),
    sourceKind: str(r.source_kind) as AppBuild['sourceKind'],
    sourceUrl: optStr(r.source_url),
    framework: (str(r.framework) || 'unknown') as AppBuild['framework'],
    status: str(r.status) as AppBuild['status'],
    error: optStr(r.error),
    url: optStr(r.url),
    instrumented: Boolean(r.instrumented),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export function variantFromRow(r: Row): Variant {
  return {
    id: str(r.id),
    studyId: str(r.study_id),
    name: str(r.name),
    protocolId: str(r.protocol_id),
    appId: nullStr(r.app_id),
    weight: Number(r.weight ?? 1),
    active: Boolean(r.active),
    createdAt: Number(r.created_at),
    appParams: str(r.app_params ?? ''),
  };
}

export function linkFromRow(r: Row): StudyLink {
  return {
    id: str(r.id),
    studyId: str(r.study_id),
    token: str(r.token),
    name: str(r.name),
    variantId: nullStr(r.variant_id),
    maxParticipants: nullNum(r.max_participants),
    expiresAt: nullNum(r.expires_at),
    redirectUrl: nullStr(r.redirect_url),
    active: Boolean(r.active),
    createdAt: Number(r.created_at),
  };
}

/** Never includes the session secret. */
export function sessionFromRow(r: Row): Session {
  return {
    id: str(r.id),
    studyId: str(r.study_id),
    variantId: str(r.variant_id),
    linkId: str(r.link_id),
    participantCode: str(r.participant_code),
    status: str(r.status) as Session['status'],
    consent: json.parse<ConsentRecord | null>(r.consent, null),
    device: json.parse<DeviceInfo | null>(r.device, null),
    urlParams: json.parse<Record<string, string>>(r.url_params, {}),
    stepOrder: json.parse<string[]>(r.step_order, []),
    startedAt: nullNum(r.started_at),
    endedAt: nullNum(r.ended_at),
    createdAt: Number(r.created_at),
    gazeErrorPx: nullNum(r.gaze_error_px),
    preview: Boolean(r.preview),
  };
}

/** Resolved (ordered) step snapshot stored with a session. */
export function sessionStepsFromRow(r: Row): Step[] {
  return json.parse<Step[]>(r.steps, []);
}

/** Protocol snapshot stored with a session (null for legacy rows without one). */
export function sessionProtocolFromRow(r: Row): Protocol | null {
  return r.protocol_snapshot ? parseProtocol(r.protocol_snapshot) : null;
}

export function taskResultFromRow(r: Row): TaskResult {
  return {
    sessionId: str(r.session_id),
    stepId: str(r.step_id),
    outcome: str(r.outcome) as TaskResult['outcome'],
    source: str(r.source) as TaskResult['source'],
    startedAt: Number(r.started_at),
    endedAt: Number(r.ended_at),
    durationMs: Number(r.duration_ms),
    evidence: optStr(r.evidence),
  };
}

export function answerFromRow(r: Row): Answer {
  const a: Answer = {
    sessionId: str(r.session_id),
    stepId: str(r.step_id),
    questionId: str(r.question_id),
    source: str(r.source) as Answer['source'],
    at: Number(r.at),
  };
  const text = optStr(r.text);
  const value = optNum(r.value);
  const choices = r.choices == null ? undefined : json.parse<string[] | undefined>(r.choices, undefined);
  if (text !== undefined) a.text = text;
  if (value !== undefined) a.value = value;
  if (choices !== undefined) a.choices = choices;
  return a;
}

export function eventFromRow(r: Row): SessionEvent {
  return {
    sessionId: str(r.session_id),
    seq: Number(r.seq),
    kind: str(r.kind) as SessionEvent['kind'],
    t: Number(r.t),
    at: Number(r.at),
    stepId: nullStr(r.step_id),
    data: json.parse<Record<string, unknown>>(r.data, {}),
  };
}
