// Study consent forms (researcher API) plus helpers used by the participant API.
//   GET    /api/studies/:id/consent                 form + original document + what the study captures
//   PUT    /api/studies/:id/consent                 save (version bumps when the participant-facing content changes)
//   POST   /api/studies/:id/consent/document        upload PDF / DOCX / TXT / MD / HTML (multipart "file")
//   GET    /api/studies/:id/consent/document        download the original
//   DELETE /api/studies/:id/consent/document        remove the original (text stays)
//   POST   /api/studies/:id/consent/check           deterministic lint + AI review of a (draft) form
//   POST   /api/studies/:id/consent/rewrite         AI plain-language rewrite (returned, never saved)
//   GET    /api/studies/:id/demographics            participant-info breakdowns
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import {
  CONSENT_ELEMENTS,
  ageFromDob,
  activeFields,
  collectsAge,
  consentContent,
  fieldSnapshot,
  lintConsent,
  newId,
  normalizeConsentForm,
  parseIsoDate,
  validateParticipantInfo,
  type ConsentCapture,
  type ConsentCheckResult,
  type ConsentDocument,
  type ConsentElementId,
  type ConsentForm,
  type ConsentFormResponse,
  type ConsentIssue,
  type ConsentRecord,
  type DemographicsBreakdown,
  type DemographicsResponse,
  type ParticipantInfo,
  type PublicConsentForm,
} from '@thinkaloud/shared';
import { db, json } from '../db.ts';
import { assertStudyAccess, requireUser } from '../lib/auth.ts';
import { config } from '../lib/config.ts';
import { HttpError, parse } from '../lib/http.ts';
import { paths } from '../lib/paths.ts';
import { parseProtocol, type Row } from '../lib/repo.ts';
import { consentDocPath, ingestConsentDocument, MAX_CONSENT_UPLOAD_BYTES, safeFilename } from '../lib/consentDocs.ts';
import { obj, str, strArr, structured } from './ai.ts';

export const consentRouter = Router();
consentRouter.use(['/studies/:id/consent', '/studies/:id/demographics'], requireUser);

// ── storage helpers ──────────────────────────────────────────────────────────

export function loadConsentForm(studyId: string): ConsentForm {
  const r = db.prepare('SELECT consent_form FROM studies WHERE id = ?').get(studyId) as Row | undefined;
  return normalizeConsentForm(json.parse<unknown>(r?.consent_form, null));
}

export const consentHash = (f: ConsentForm) => crypto.createHash('sha256').update(consentContent(f)).digest('hex');

/** Persist a form; bumps the version (and keeps the previous text in history) when the content hash changes. */
export function saveConsentForm(studyId: string, next: ConsentForm, prev: ConsentForm): ConsentForm {
  const f = normalizeConsentForm(next);
  const hash = consentHash(f);
  if (hash !== prev.hash) {
    f.version = prev.version + 1;
    f.hash = hash;
    f.history = [{ version: f.version, hash, savedAt: Date.now(), text: f.text }, ...(prev.history ?? [])].slice(0, 50);
  } else {
    f.version = prev.version;
    f.hash = prev.hash;
    f.history = prev.history ?? [];
  }
  f.updatedAt = Date.now();
  db.prepare('UPDATE studies SET consent_form = ?, updated_at = ? WHERE id = ?').run(json.str(f), Date.now(), studyId);
  return f;
}

function docFromRow(r: Row): ConsentDocument {
  return { id: String(r.id), studyId: String(r.study_id), filename: String(r.filename), mime: String(r.mime), size: Number(r.size), sha256: String(r.sha256), createdAt: Number(r.created_at) };
}

function currentDocument(studyId: string, form: ConsentForm): (ConsentDocument & { path: string }) | null {
  if (!form.documentId) return null;
  const r = db.prepare('SELECT * FROM consent_documents WHERE id = ? AND study_id = ?').get(form.documentId, studyId) as Row | undefined;
  return r ? { ...docFromRow(r), path: String(r.path) } : null;
}

/** What the study actually collects: the union over the protocols its active variants use (all protocols when none is active). */
export function studyCapture(studyId: string, form: ConsentForm): ConsentCapture {
  let rows = db.prepare('SELECT p.protocol FROM variants v JOIN protocols p ON p.id = v.protocol_id WHERE v.study_id = ? AND v.active = 1').all(studyId) as Row[];
  if (!rows.length) rows = db.prepare('SELECT protocol FROM protocols WHERE study_id = ?').all(studyId) as Row[];
  const ps = rows.map((r) => parseProtocol(r.protocol));
  const any = (fn: (c: (typeof ps)[number]['consent']) => boolean) => ps.some((p) => fn(p.consent));
  return {
    voice: true,
    storeAudio: any((c) => c.storeAudio),
    screen: any((c) => c.recordScreen),
    eyeTracking: any((c) => c.offerEyeTracking),
    ageGate: any((c) => c.ageGate),
    minAge: form.minAge,
    fields: activeFields(form).map(fieldSnapshot),
  };
}

function response(studyId: string, form: ConsentForm): ConsentFormResponse {
  const doc = currentDocument(studyId, form);
  let document: ConsentDocument | null = null;
  if (doc) {
    const { path: _p, ...d } = doc;
    document = d;
  }
  return { form, document, capture: studyCapture(studyId, form) };
}

// ── researcher routes ────────────────────────────────────────────────────────

const sid = (req: Request) => String(req.params.id);

consentRouter.get('/studies/:id/consent', (req, res) => {
  assertStudyAccess(req, sid(req));
  res.json(response(sid(req), loadConsentForm(sid(req))));
});

const FieldInput = z.object({ id: z.string().max(64) }).passthrough();
const FormInput = z.object({
  enabled: z.boolean().optional(),
  title: z.string().max(200).optional(),
  text: z.string().max(100_000).optional(),
  fields: z.array(FieldInput).max(60).optional(),
  signature: z.object({ mode: z.enum(['checkbox', 'typed_name']), agreeLabel: z.string().max(300).optional() }).optional(),
  minAge: z.number().int().min(0).max(99).optional(),
  requireScroll: z.boolean().optional(),
});

consentRouter.put('/studies/:id/consent', (req, res) => {
  assertStudyAccess(req, sid(req));
  const body = parse(FormInput, req.body);
  const prev = loadConsentForm(sid(req));
  const next = normalizeConsentForm({ ...prev, ...body, documentId: prev.documentId, version: prev.version, hash: prev.hash, lastCheck: prev.lastCheck, history: prev.history });
  res.json(response(sid(req), saveConsentForm(sid(req), next, prev)));
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_CONSENT_UPLOAD_BYTES, files: 1, fields: 5 } });
function single(req: Request, res: Response, next: NextFunction) {
  upload.single('file')(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError)
      return next(new HttpError(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, err.code === 'LIMIT_FILE_SIZE' ? `The file is larger than ${MAX_CONSENT_UPLOAD_BYTES / 1024 / 1024} MB.` : err.message));
    next(err);
  });
}

consentRouter.post('/studies/:id/consent/document', single, async (req, res) => {
  const studyId = sid(req);
  assertStudyAccess(req, studyId);
  const file = req.file;
  if (!file?.buffer?.length) throw new HttpError(400, 'Choose a file to upload (PDF, Word, text, Markdown or HTML).');
  const filename = safeFilename(Buffer.from(file.originalname, 'latin1').toString('utf8'));
  const docId = newId('cdoc').replace(/[^A-Za-z0-9_-]/g, '');
  const stored = await ingestConsentDocument(studyId, docId, file.buffer, filename);
  const prev = loadConsentForm(studyId);
  const old = currentDocument(studyId, prev);
  db.prepare('INSERT INTO consent_documents (id, study_id, filename, mime, size, sha256, text, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    docId, studyId, filename, stored.mime, stored.size, stored.sha256, stored.text, stored.path, Date.now(),
  );
  if (old) removeDocument(studyId, old);
  const title = prev.title;
  const form = saveConsentForm(studyId, { ...prev, title, text: stored.text, documentId: docId }, prev);
  res.status(201).json(response(studyId, form));
});

function removeDocument(studyId: string, doc: { id: string; path: string }) {
  db.prepare('DELETE FROM consent_documents WHERE id = ? AND study_id = ?').run(doc.id, studyId);
  try {
    fs.rmSync(consentDocPath(doc.path), { force: true });
  } catch {
    /* already gone */
  }
}

export function sendConsentDocument(res: Response, studyId: string, form: ConsentForm) {
  const doc = currentDocument(studyId, form);
  if (!doc) throw new HttpError(404, 'No original document was uploaded');
  const file = consentDocPath(doc.path);
  if (!fs.existsSync(file)) throw new HttpError(404, 'Document not found');
  res.setHeader('Content-Type', doc.mime.split(';')[0] === 'text/html' ? 'text/plain; charset=utf-8' : doc.mime); // never render uploaded HTML
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(doc.filename)}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', 'private, max-age=60');
  fs.createReadStream(file).pipe(res);
}

consentRouter.get('/studies/:id/consent/document', (req, res) => {
  assertStudyAccess(req, sid(req));
  sendConsentDocument(res, sid(req), loadConsentForm(sid(req)));
});

consentRouter.delete('/studies/:id/consent/document', (req, res) => {
  const studyId = sid(req);
  assertStudyAccess(req, studyId);
  const prev = loadConsentForm(studyId);
  const doc = currentDocument(studyId, prev);
  if (doc) removeDocument(studyId, doc);
  const form = saveConsentForm(studyId, { ...prev, documentId: null }, prev);
  res.json(response(studyId, form));
});

/** Remove every stored consent original of a study (study deletion). */
export function removeStudyConsentFiles(studyId: string) {
  try {
    fs.rmSync(paths.consentDir(studyId), { recursive: true, force: true });
  } catch {
    /* invalid id or missing */
  }
}

// ── AI review ────────────────────────────────────────────────────────────────

const REVIEWER = `
You are an experienced research-ethics (IRB / REC) reviewer and plain-language editor. You review informed-consent
documents for remote, AI-moderated usability studies: an AI voice moderator talks with the participant while they use a
website; the study may record voice, a transcript, a replay of on-screen activity, answers, optional webcam eye tracking
(computed on device) and participant information such as name, age or gender.
Judge the document as a participant would read it. Flag: missing or unclear required elements (purpose, procedures, what
is recorded, duration, risks, benefits, compensation, confidentiality, storage and retention, who has access including
service providers, voluntary participation, right to withdraw at any time and what happens to data, AI-moderator
disclosure, researcher contact, ethics board / IRB contact, age requirement), statements that contradict what the study
collects, coercive or misleading wording, legal waivers, vague promises, jargon and hard-to-read passages.
Write explanations in one or two plain sentences. Suggested rewrites must be ready to paste, at about a grade 6-8 reading
level, in the document's language, and must not invent facts (use [placeholders] for unknown names, amounts or dates).
Quote the offending text verbatim from the document (an exact substring, at most two sentences) whenever the issue is
about existing text; omit the quote for missing content.
`.trim();

const normWs = (t: string) => t.replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const ELEMENT_IDS = new Set<string>(CONSENT_ELEMENTS.map((e) => e.id));

const AiIssue = z.object({
  severity: z.preprocess((v) => (typeof v === 'string' ? v.toLowerCase() : v), z.enum(['high', 'medium', 'low'])).catch('medium'),
  element: z.string().nullish(),
  message: z.string().min(1).max(500),
  explanation: z.string().max(2000).nullish(),
  quote: z.string().max(2000).nullish(),
  suggestion: z.string().max(4000).nullish(),
});

async function aiReview(text: string, capture: ConsentCapture, lint: ConsentIssue[]): Promise<ConsentIssue[]> {
  const docNorm = normWs(text);
  const input = [
    'Review this consent document.',
    '',
    'What the study actually collects:',
    `- Voice moderation by an AI (microphone): yes${capture.storeAudio ? '; audio recordings are stored' : '; audio is transcribed, recordings are not stored'}`,
    `- Replay of on-screen activity (clicks, scrolling, pages): ${capture.screen ? 'yes' : 'no'}`,
    `- Optional webcam eye tracking (on device, no video stored): ${capture.eyeTracking ? 'offered' : 'no'}`,
    `- Minimum age: ${capture.minAge}`,
    `- Participant information asked: ${capture.fields.length ? capture.fields.map((f) => `${f.label}${f.pii ? ' (identifying)' : ''}`).join(', ') : 'none'}`,
    '',
    'An automatic checker already reported these issues; do NOT repeat them, report only additional problems (an empty list is fine):',
    lint.map((i) => `- ${i.message}`).join('\n') || '(none)',
    '',
    'Document (Markdown):',
    '"""',
    text.slice(0, 60_000),
    '"""',
  ].join('\n');
  return structured({
    name: 'consent_review',
    schema: obj(
      {
        issues: {
          type: 'array',
          items: obj(
            {
              severity: { type: 'string', enum: ['high', 'medium', 'low'] },
              element: { type: 'string', enum: [...ELEMENT_IDS], description: 'The consent element this is about, if any.' },
              message: str('Short title of the problem (max ~12 words).'),
              explanation: str('Why it matters, in plain words.'),
              quote: str('Exact substring of the document that has the problem. Omit for missing content.'),
              suggestion: str('Suggested rewrite or text to add, ready to paste.'),
            },
            ['severity', 'message', 'explanation', 'suggestion'],
          ),
        },
      },
      ['issues'],
    ),
    instructions: REVIEWER,
    input,
    validate: (r) =>
      z
        .object({ issues: z.array(z.unknown()).max(60) })
        .parse(r)
        .issues.flatMap((raw, k) => {
          const p = AiIssue.safeParse(raw);
          if (!p.success) return [];
          const x = p.data;
          const issue: ConsentIssue = { key: `ai:${k}`, source: 'ai', category: 'other', severity: x.severity, message: x.message.trim() };
          if (x.element && ELEMENT_IDS.has(x.element)) issue.element = x.element as ConsentElementId;
          if (x.explanation?.trim()) issue.explanation = x.explanation.trim();
          if (x.suggestion?.trim()) issue.suggestion = x.suggestion.trim();
          // Keep a quote only when it really is in the document (models paraphrase).
          if (x.quote?.trim() && docNorm.includes(normWs(x.quote))) issue.quote = x.quote.trim();
          if (/\b(jargon|readab|plain|sentence|wording)\b/i.test(issue.message)) issue.category = 'readability';
          else if (/\b(coerc|pressure|mislead|waive|liabilit|guarantee)\b/i.test(issue.message)) issue.category = 'language';
          else if (/\b(missing|does not (say|mention|state)|doesn['’]t (say|mention|state)|no (mention|information))\b/i.test(issue.message)) issue.category = 'missing';
          else if (/\b(contradict|inconsistent|but the study)\b/i.test(issue.message)) issue.category = 'consistency';
          return [issue];
        }),
  });
}

const CheckInput = FormInput.extend({ ai: z.boolean().default(true) });

consentRouter.post('/studies/:id/consent/check', async (req, res) => {
  const studyId = sid(req);
  assertStudyAccess(req, studyId);
  const body = parse(CheckInput, req.body ?? {});
  const saved = loadConsentForm(studyId);
  const { ai: wantAi, ...draft } = body;
  const form = normalizeConsentForm({ ...saved, ...draft });
  const capture = studyCapture(studyId, form);
  const lint = lintConsent(form.text, capture);
  const result: ConsentCheckResult = {
    checkedAt: Date.now(),
    version: form.version,
    hash: consentHash(form),
    readability: lint.readability,
    elements: lint.elements,
    issues: lint.issues,
    ai: 'skipped',
  };
  if (wantAi && config.openaiKey && form.text.trim()) {
    try {
      const extra = await aiReview(form.text, capture, lint.issues);
      const rank = { high: 0, medium: 1, low: 2 } as const;
      result.issues = [...lint.issues, ...extra].sort((a, b) => rank[a.severity] - rank[b.severity]);
      result.ai = 'ok';
    } catch (e) {
      result.ai = 'failed';
      result.aiError = e instanceof Error ? e.message : String(e);
    }
  }
  // Remember the latest check on the stored form (does not change its hash or version).
  db.prepare('UPDATE studies SET consent_form = ? WHERE id = ?').run(json.str({ ...saved, lastCheck: result }), studyId);
  res.json(result);
});

consentRouter.post('/studies/:id/consent/rewrite', async (req, res) => {
  assertStudyAccess(req, sid(req));
  const { text } = parse(z.object({ text: z.string().trim().min(20).max(60_000) }), req.body);
  if (!config.openaiKey) throw new HttpError(503, 'AI features are not configured on this server (missing OPENAI_API_KEY)');
  const out = await structured({
    name: 'consent_plain_language',
    schema: obj({ text: str('The rewritten document, Markdown with ## headings.'), changes: strArr('3-8 short notes on what changed.') }, ['text', 'changes']),
    instructions: `${REVIEWER}\n\nNow you are rewriting, not reviewing.`,
    input: [
      'Rewrite this consent document in plain language for a general adult audience (aim for grade 6-8):',
      '- Short sentences (15-20 words), everyday words, "we" and "you", active voice.',
      '- Use ## headings for sections and bullet lists for what is recorded.',
      '- Keep EVERY fact: names, contact details, amounts, durations, retention periods, ages, rights and choices. Do not add facts; keep [placeholders] as they are.',
      '- Remove legal waivers and coercive wording; keep the meaning of everything else.',
      '- Same language as the original.',
      '',
      '"""',
      text,
      '"""',
    ].join('\n'),
    validate: (r) => z.object({ text: z.string().min(20).max(100_000), changes: z.array(z.string().max(500)).max(20).default([]) }).parse(r),
  });
  res.json(out);
});

// ── demographics ─────────────────────────────────────────────────────────────

const AGE_BINS: [number, number, string][] = [
  [0, 17, 'Under 18'],
  [18, 24, '18–24'],
  [25, 34, '25–34'],
  [35, 44, '35–44'],
  [45, 54, '45–54'],
  [55, 64, '55–64'],
  [65, 200, '65+'],
];

function numStats(xs: number[]) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const median = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  const sd = s.length > 1 ? Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / (s.length - 1)) : 0;
  const r = (x: number) => Math.round(x * 10) / 10;
  return { mean: r(mean), median: r(median), min: s[0], max: s[s.length - 1], sd: r(sd) };
}

export function demographics(studyId: string, opts: { includePreview?: boolean } = {}): DemographicsResponse {
  const form = loadConsentForm(studyId);
  const rows = db.prepare("SELECT participant_info, consent, created_at FROM sessions WHERE study_id = ? AND status != 'withdrawn'" + (opts.includePreview ? '' : ' AND preview = 0')).all(studyId) as Row[];
  const infos = rows.map((r) => ({ info: json.parse<ParticipantInfo | null>(r.participant_info, null), at: Number(r.created_at) })).filter((x) => x.info && Object.keys(x.info).length);
  const breakdowns: DemographicsBreakdown[] = [];
  for (const f of form.fields) {
    if (!f.enabled && !infos.some((x) => x.info![f.id] !== undefined)) continue;
    if (f.kind === 'short_text' && f.builtin !== 'country' && f.builtin !== 'occupation') continue; // names, emails, free text
    if (f.kind === 'long_text') continue;
    const vals = infos.map((x) => ({ v: x.info![f.id], at: x.at })).filter((x) => x.v !== undefined && x.v !== null && x.v !== '');
    const counts = new Map<string, number>();
    const bump = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);
    let stats: DemographicsBreakdown['stats'] = null;
    if (f.builtin === 'age') {
      const ages = vals.flatMap(({ v, at }) => {
        if (typeof v === 'number') return [v];
        const d = typeof v === 'string' ? parseIsoDate(v) : null;
        return d ? [ageFromDob(d, new Date(at))] : [];
      });
      for (const a of ages) bump(AGE_BINS.find(([lo, hi]) => a >= lo && a <= hi)?.[2] ?? '65+');
      stats = numStats(ages);
      breakdowns.push({ fieldId: f.id, label: 'Age', kind: f.kind, n: ages.length, counts: AGE_BINS.map(([, , l]) => ({ label: l, n: counts.get(l) ?? 0 })).filter((c) => c.n || c.label !== 'Under 18'), stats });
      continue;
    }
    for (const { v } of vals) {
      if (Array.isArray(v)) v.forEach((x) => bump(String(x)));
      else if (typeof v === 'boolean') bump(v ? 'Yes' : 'No');
      else if (f.kind === 'short_text') {
        const t = String(v).trim();
        bump(t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
      } else bump(String(v));
    }
    let list: { label: string; n: number }[];
    if (f.kind === 'single_select' || f.kind === 'multi_select') {
      const opts = f.options ?? [];
      list = [...opts.map((o) => ({ label: o, n: counts.get(o) ?? 0 })), ...[...counts.entries()].filter(([k]) => !opts.includes(k)).map(([label, n]) => ({ label, n }))];
    } else if (f.kind === 'likert') {
      const pts = f.likert?.points ?? 5;
      list = Array.from({ length: pts }, (_, i) => ({ label: i === 0 ? `1 · ${f.likert?.minLabel ?? ''}`.trim() : i === pts - 1 ? `${pts} · ${f.likert?.maxLabel ?? ''}`.trim() : String(i + 1), n: counts.get(String(i + 1)) ?? 0 }));
    } else if (f.kind === 'yes_no') list = ['Yes', 'No'].map((l) => ({ label: l, n: counts.get(l) ?? 0 }));
    else if (f.kind === 'number') {
      stats = numStats(vals.map((x) => Number(x.v)).filter(Number.isFinite));
      list = [];
    } else if (f.kind === 'date') continue;
    else list = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([label, n]) => ({ label, n }));
    breakdowns.push({ fieldId: f.id, label: f.label, kind: f.kind, n: vals.length, counts: list, stats });
  }
  return { sessions: rows.length, withInfo: infos.length, breakdowns };
}

consentRouter.get('/studies/:id/demographics', (req, res) => {
  assertStudyAccess(req, sid(req));
  res.json(demographics(sid(req), { includePreview: req.query.includePreview === '1' || req.query.includePreview === 'true' }));
});

// ── participant helpers (used by routes/participant.ts) ─────────────────────

/** The form participants see, or null when the study has no enabled, saved form. */
export function publicConsentForm(studyId: string, token: string): PublicConsentForm | null {
  const f = loadConsentForm(studyId);
  if (!f.enabled || f.version < 1 || !f.text.trim()) return null;
  const doc = currentDocument(studyId, f);
  return {
    title: f.title,
    text: f.text,
    version: f.version,
    hash: f.hash,
    fields: activeFields(f),
    signature: f.signature,
    minAge: f.minAge,
    requireScroll: f.requireScroll,
    document: doc ? { filename: doc.filename, size: doc.size, url: `/api/p/links/${encodeURIComponent(token)}/consent-document` } : null,
  };
}

const SignatureInput = z.object({ mode: z.enum(['checkbox', 'typed_name']), name: z.string().max(200).optional(), date: z.string().max(20).optional(), agreed: z.literal(true) });

/**
 * Validate the consent form part of a session start. Returns the participant info to store and the
 * consent record fields to merge, or throws 400 (nothing is stored for invalid or under-age submissions).
 */
export function checkConsentSubmission(studyId: string, consent: ConsentRecord & Record<string, unknown>, rawInfo: unknown, opts: { ageGate: boolean }): { info: ParticipantInfo | null; record: Partial<ConsentRecord> } {
  const f = loadConsentForm(studyId);
  if (!f.enabled || f.version < 1) return { info: null, record: {} };
  const fields = activeFields(f);
  const raw = rawInfo && typeof rawInfo === 'object' && !Array.isArray(rawInfo) ? (rawInfo as Record<string, unknown>) : {};
  const v = validateParticipantInfo(fields, raw, { minAge: f.minAge });
  if (Object.keys(v.errors).length) throw new HttpError(400, 'Some answers need attention', { fields: v.errors });
  if (v.underAge) throw new HttpError(403, `This study is for people aged ${f.minAge} or older.`, { reason: 'under_age' });
  if (opts.ageGate && !collectsAge(f) && !consent.ageConfirmed) throw new HttpError(400, `Please confirm that you are ${f.minAge} or older.`);
  const sig = SignatureInput.safeParse(consent.signature);
  if (!sig.success) throw new HttpError(400, 'Please agree to the consent form to continue.');
  const signature = sig.data;
  if (f.signature.mode === 'typed_name') {
    const name = signature.name?.trim() ?? '';
    if (name.length < 2) throw new HttpError(400, 'Please type your full name to sign.', { fields: { signature: 'Please type your full name to sign.' } });
    signature.name = name;
    signature.mode = 'typed_name';
  } else {
    delete signature.name;
    signature.mode = 'checkbox';
  }
  if (signature.date && !parseIsoDate(signature.date)) delete signature.date;
  signature.date ??= new Date().toISOString().slice(0, 10);
  return {
    info: Object.keys(v.values).length ? v.values : null,
    record: { version: String(f.version), formVersion: f.version, formHash: f.hash, signature, fields: fields.map(fieldSnapshot), ageConfirmed: v.age !== null ? !v.underAge : Boolean(consent.ageConfirmed) },
  };
}
