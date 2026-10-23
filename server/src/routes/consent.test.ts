// Consent forms: document extraction (PDF / DOCX / TXT / MD / HTML fixtures generated here), the
// informed-consent lint, participant-info validation, the HTTP flow (upload → save → check →
// participant start → export → withdrawal) and the AI review against a MOCK OpenAI endpoint.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import AdmZip from 'adm-zip';
import {
  DEFAULT_CONSENT_DOCUMENT,
  lintConsent,
  normalizeConsentForm,
  readability,
  validateParticipantInfo,
  type ConsentCapture,
  type ParticipantField,
} from '@thinkaloud/shared';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-consent-test-'));
process.env.DATA_DIR = dataDir;
// Mock OpenAI (the SDK honours OPENAI_BASE_URL). Never the real API.
process.env.OPENAI_API_KEY = 'sk-test';

let aiQueue: string[] = [];
const aiRequests: Record<string, unknown>[] = [];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    aiRequests.push(JSON.parse(body));
    const text = aiQueue.shift() ?? '{"issues":[]}';
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'r', object: 'response', created_at: 0, status: 'completed', model: 'gpt-5-mini', output: [{ type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }] }));
  });
});

let api: http.Server;
let base = '';
let docs: typeof import('../lib/consentDocs.ts');
let paths: typeof import('../lib/paths.ts');
let db: typeof import('../db.ts').db;

before(async () => {
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/v1`;
  docs = await import('../lib/consentDocs.ts');
  paths = await import('../lib/paths.ts');
  ({ db } = await import('../db.ts'));
  const { createApp } = await import('../app.ts');
  api = http.createServer(createApp());
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});
after(() => {
  api?.close();
  mock.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ── fixtures ─────────────────────────────────────────────────────────────────

/** A minimal, valid single-page PDF with Helvetica text lines. */
function makePdf(lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, (m) => '\\' + m);
  const content = 'BT /F1 12 Tf 72 720 Td 16 TL ' + lines.map((l) => `(${esc(l)}) Tj T*`).join(' ') + ' ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** A minimal DOCX: a Heading1 paragraph, body paragraphs and a bold run. */
function makeDocx(): Buffer {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`));
  zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`));
  const p = (text: string, style?: string, bold = false) =>
    `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  zip.addFile(
    'word/document.xml',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${p('Your rights', 'Heading1')}${p('Taking part is voluntary.')}${p('You can withdraw at any time.', undefined, true)}${p('Contact: lab@uni.example')}</w:body></w:document>`,
    ),
  );
  return zip.toBuffer();
}

// ── extraction ───────────────────────────────────────────────────────────────

test('PDF: sniffed by magic bytes and extracted to Markdown with headings', async () => {
  const pdf = makePdf(['PURPOSE OF THE STUDY', '', 'We are testing a website to find out', 'how easy it is to use.', '', 'You can withdraw at any time.']);
  assert.equal(docs.sniffConsentDocument(pdf, 'consent.bin'), 'pdf');
  const md = await docs.extractConsentText(pdf, 'pdf');
  assert.match(md, /^## Purpose of the study/m);
  assert.match(md, /We are testing a website/);
  assert.match(md, /withdraw at any time/);
});

test('DOCX: headings, bold and paragraphs survive; legacy .doc and non-Word zips are refused', async () => {
  const docx = makeDocx();
  assert.equal(docs.sniffConsentDocument(docx, 'form.docx'), 'docx');
  const md = await docs.extractConsentText(docx, 'docx');
  assert.match(md, /^## Your rights$/m);
  assert.match(md, /\*\*You can withdraw at any time\.\*\*/);
  assert.match(md, /lab@uni\.example/);
  const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0]);
  assert.throws(() => docs.sniffConsentDocument(ole, 'old.doc'), /\.docx or PDF/);
  const z = new AdmZip();
  z.addFile('evil.txt', Buffer.from('x'));
  assert.throws(() => docs.sniffConsentDocument(z.toBuffer(), 'fake.docx'), /not a Word document/);
});

test('TXT / MD / HTML: text formats, unwrapping, and no HTML or scripts pass through', async () => {
  const txt = Buffer.from('ABOUT THIS STUDY\n\nWe are testing a website\nto learn how people use it.\n\n• Your voice\n• Your clicks\n');
  assert.equal(docs.sniffConsentDocument(txt, 'c.txt'), 'txt');
  const md1 = await docs.extractConsentText(txt, 'txt');
  assert.match(md1, /^## About this study/m);
  assert.match(md1, /We are testing a website to learn how people use it\./);
  assert.match(md1, /^- Your voice\n- Your clicks$/m);
  assert.equal(docs.sniffConsentDocument(Buffer.from('# Title\n\nHello'), 'c.md'), 'md');
  const html = Buffer.from('<!doctype html><html><head><title>x</title><script>alert(1)</script></head><body><h1>Consent</h1><p>Read <b>this</b> &amp; <a href="javascript:alert(1)">click</a> or <a href="https://ethics.example">ethics</a>.</p><img src=x onerror=alert(1)><ul><li>One</li><li>Two</li></ul><p>&lt;script&gt;bad()&lt;/script&gt;</p></body></html>');
  assert.equal(docs.sniffConsentDocument(html, 'page.bin'), 'html');
  const md = await docs.extractConsentText(html, 'html');
  assert.match(md, /^## Consent$/m);
  assert.match(md, /Read \*\*this\*\* & click or \[ethics\]\(https:\/\/ethics\.example\)\./);
  assert.match(md, /^- One\n- Two$/m);
  assert.doesNotMatch(md, /alert|javascript|<script|onerror|<img/i);
  assert.match(md, /&lt;script&gt;bad\(\)&lt;\/script&gt;/, 'escaped text stays escaped');
});

test('binary files and fake extensions are refused; paths stay confined', () => {
  const exe = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00]);
  assert.throws(() => docs.sniffConsentDocument(exe, 'consent.pdf'), /Unsupported file type/);
  assert.throws(() => docs.sniffConsentDocument(Buffer.alloc(0), 'x.txt'), /empty/);
  assert.throws(() => paths.paths.consentFile('stu_1', '../../thinkaloud.db'), /Unsafe/);
  assert.throws(() => paths.paths.consentFile('..', 'x'), /Unsafe/);
  assert.throws(() => docs.consentDocPath('../thinkaloud.db'), /not found/);
  assert.throws(() => docs.consentDocPath('consent/../../etc/passwd'), /not found/);
});

// ── lint ─────────────────────────────────────────────────────────────────────

const fullCapture: ConsentCapture = { voice: true, storeAudio: true, screen: true, eyeTracking: true, ageGate: true, minAge: 18, fields: [] };

test('lint: the default document covers every element at a readable level', () => {
  const r = lintConsent(DEFAULT_CONSENT_DOCUMENT, fullCapture);
  assert.deepEqual(r.elements.filter((e) => e.status !== 'ok'), []);
  assert.deepEqual(r.issues.filter((i) => i.severity !== 'low'), []);
  assert.ok(r.readability.grade <= 8, `grade ${r.readability.grade}`);
});

test('lint: missing elements, capture inconsistencies, anonymity claims, coercion and jargon', () => {
  const text = [
    '## Study',
    'We are testing a website to find out how easy it is to use. The session takes 20 minutes.',
    'All data is completely anonymous and kept securely for 12 months.',
    'You will only be paid if you complete all tasks.',
    'By participating you waive any claims against the university, pursuant to the aforementioned protocol.',
    'You must be 16 or older to take part.',
  ].join('\n\n');
  const r = lintConsent(text, { ...fullCapture, fields: [{ id: 'full_name', label: 'Full name', kind: 'short_text', pii: true }, { id: 'gender', label: 'Gender identity', kind: 'single_select', pii: false }] });
  const keys = r.issues.map((i) => i.key);
  for (const k of ['missing:risks', 'missing:withdrawal', 'missing:ai_disclosure', 'missing:contact', 'missing:ethics_contact', 'capture:eye_tracking', 'capture:screen', 'capture:voice', 'field:full_name', 'field:gender', 'consistency:anonymous', 'age:mismatch'])
    assert.ok(keys.includes(k), `expected ${k} in ${keys.join(', ')}`);
  const anon = r.issues.find((i) => i.key === 'consistency:anonymous')!;
  assert.equal(anon.severity, 'high');
  assert.match(anon.quote!, /completely anonymous/);
  assert.ok(r.issues.some((i) => i.category === 'language' && /waive/.test(i.message)));
  assert.ok(r.issues.some((i) => i.category === 'language' && /payment depend/i.test(i.message)));
  assert.ok(r.issues.some((i) => i.key === 'jargon:pursuant to'));
  assert.equal(r.elements.find((e) => e.id === 'confidentiality')?.status, 'inconsistent');
  assert.equal(r.elements.find((e) => e.id === 'age')?.status, 'inconsistent');
  // Turning eye tracking off makes the webcam warning go away.
  assert.ok(!lintConsent(text, { ...fullCapture, eyeTracking: false }).issues.some((i) => i.key === 'capture:eye_tracking'));
});

test('readability: Flesch-Kincaid grade separates plain and dense prose; long sentences are quoted', () => {
  const plain = readability('We test a website. You try a few tasks. You can stop at any time. We keep your data safe.');
  const dense = readability('Participation in this investigation necessitates the utilization of computational instrumentation, and the investigators will subsequently undertake comprehensive analyses of behavioural characteristics.');
  assert.ok(plain.grade < 4, `plain ${plain.grade}`);
  assert.ok(dense.grade > 14, `dense ${dense.grade}`);
  const long = 'This sentence keeps going with many words because it is meant to be far too long for a participant to follow comfortably in one reading without losing track of the point that is being made here.';
  const r = lintConsent(`${long}\n\n${DEFAULT_CONSENT_DOCUMENT}`, fullCapture);
  assert.equal(r.issues.find((i) => i.key.startsWith('readability:long'))?.quote, long);
});

// ── field validation ─────────────────────────────────────────────────────────

test('participant info: required, email, number bounds, select with self-describe, Likert, dates and age gate', () => {
  const form = normalizeConsentForm({
    fields: [
      { id: 'full_name', enabled: true },
      { id: 'email', enabled: true },
      { id: 'age', enabled: true },
      { id: 'gender', enabled: true },
      { id: 'cf_hours', kind: 'number', label: 'Hours online per day', required: true, min: 0, max: 24 },
      { id: 'cf_trust', kind: 'likert', label: 'I trust AI', required: true, likert: { points: 7 } },
      { id: 'cf_devices', kind: 'multi_select', label: 'Devices', options: ['Phone', 'Laptop'], required: false },
      { id: 'cf_ok', kind: 'yes_no', label: 'Used it before?', required: true },
    ],
  });
  const fields = form.fields;
  const bad = validateParticipantInfo(fields, { email: 'nope', age: 17.5, gender: '', cf_hours: 30, cf_trust: 8, cf_devices: ['Tablet', 'TV'], cf_ok: 'yes' }, { minAge: 18 });
  assert.match(bad.errors.full_name, /enter your full name/);
  assert.match(bad.errors.email, /valid email/);
  assert.match(bad.errors.age, /whole years/);
  assert.equal(bad.errors.gender, undefined, 'gender is optional');
  assert.match(bad.errors.cf_hours, /no higher than 24/);
  assert.match(bad.errors.cf_trust, /choose an option/);
  assert.match(bad.errors.cf_devices, /choose from the options/);
  assert.match(bad.errors.cf_ok, /yes or no/);

  const good = validateParticipantInfo(fields, { full_name: '  Ada Lovelace ', email: 'ada@example.org', age: 36, gender: 'Agender', cf_hours: '5', cf_trust: 6, cf_devices: ['Phone'], cf_ok: false, unknown: 'dropped' }, { minAge: 18 });
  assert.deepEqual(good.errors, {});
  assert.deepEqual(good.values, { full_name: 'Ada Lovelace', email: 'ada@example.org', age: 36, gender: 'Agender', cf_hours: 5, cf_trust: 6, cf_devices: ['Phone'], cf_ok: false });
  assert.equal(good.underAge, false);
  assert.equal(validateParticipantInfo(fields, { ...good.values, age: 16 }, { minAge: 18 }).underAge, true);

  const dob = normalizeConsentForm({ fields: [{ id: 'age', enabled: true, ageFormat: 'date_of_birth' }] }).fields.find((f) => f.id === 'age') as ParticipantField;
  assert.equal(dob.kind, 'date');
  assert.equal(dob.label, 'Date of birth');
  const today = new Date(Date.UTC(2026, 9, 23));
  assert.equal(validateParticipantInfo([dob], { age: '2008-10-24' }, { minAge: 18, today }).underAge, true, 'one day short of 18');
  assert.equal(validateParticipantInfo([dob], { age: '2008-10-23' }, { minAge: 18, today }).age, 18);
  assert.match(validateParticipantInfo([dob], { age: '2026-02-30' }, { today }).errors.age, /valid date/);
  assert.match(validateParticipantInfo([dob], { age: '2030-01-01' }, { today }).errors.age, /future/);
});

// ── HTTP flow ────────────────────────────────────────────────────────────────

function client() {
  let cookie = '';
  return async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const isForm = body instanceof FormData;
    const res = await fetch(base + url, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let json: any = text;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* raw */
    }
    return { status: res.status, json, text, headers: res.headers };
  };
}
const device = { userAgent: 't', viewportW: 1, viewportH: 1, screenW: 1, screenH: 1, dpr: 1, timezone: 'UTC', language: 'en' };
const baseConsent = { version: '1', acceptedAt: Date.now(), audio: true, screen: true, eyeTracking: false, ageConfirmed: false };

let owner: ReturnType<typeof client>;
let studyId = '';
let token = '';

test('researcher: upload a PDF, edit fields, version bumps only on content change, check runs lint + mocked AI', async () => {
  owner = client();
  assert.ok((await owner('POST', '/api/auth/signup', { email: 'consent-owner@example.com', password: 'password123', name: 'Owner' })).status < 300);
  studyId = (await owner('POST', '/api/studies', { name: 'Consent study', template: 'starter' })).json.study.id;
  const detail = (await owner('GET', `/api/studies/${studyId}`)).json;
  token = detail.links[0].token;

  const g = await owner('GET', `/api/studies/${studyId}/consent`);
  assert.equal(g.status, 200);
  assert.equal(g.json.form.version, 0);
  assert.equal(g.json.capture.screen, true);

  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array(makePdf(['ABOUT THIS STUDY', '', 'We are testing a website.', 'You can withdraw at any time.']))], { type: 'application/octet-stream' }), 'consent.pdf');
  const up = await owner('POST', `/api/studies/${studyId}/consent/document`, fd);
  assert.equal(up.status, 201, up.text);
  assert.equal(up.json.document.filename, 'consent.pdf');
  assert.equal(up.json.document.mime, 'application/pdf');
  assert.match(up.json.form.text, /We are testing a website/);
  assert.equal(up.json.form.version, 1);
  const docRow = db.prepare('SELECT path FROM consent_documents WHERE id = ?').get(up.json.form.documentId) as { path: string };
  assert.ok(path.resolve(dataDir, docRow.path).startsWith(path.join(dataDir, 'consent', studyId) + path.sep));

  const fake = new FormData();
  fake.append('file', new Blob([new Uint8Array([0x4d, 0x5a, 0x90, 0, 1, 2, 3, 0])]), 'consent.pdf');
  assert.equal((await owner('POST', `/api/studies/${studyId}/consent/document`, fake)).status, 415);

  const text = DEFAULT_CONSENT_DOCUMENT.replace('## Questions', 'We will ask for your name, your age, your sex and your gender.\n\n## Questions');
  const put = await owner('PUT', `/api/studies/${studyId}/consent`, {
    enabled: true,
    text,
    signature: { mode: 'typed_name' },
    fields: [
      { id: 'full_name', enabled: true },
      { id: 'age', enabled: true },
      { id: 'sex', enabled: true },
      { id: 'gender', enabled: true, required: true },
      { id: 'cf_role', kind: 'single_select', label: 'Role', options: ['Designer', 'Developer'], required: true, pii: false },
    ],
  });
  assert.equal(put.status, 200, put.text);
  assert.equal(put.json.form.version, 2);
  assert.ok(/^[0-9a-f]{64}$/.test(put.json.form.hash));
  assert.equal(put.json.form.history.length, 2);
  const same = await owner('PUT', `/api/studies/${studyId}/consent`, { text });
  assert.equal(same.json.form.version, 2, 'saving unchanged content keeps the version');
  assert.equal(same.json.form.hash, put.json.form.hash);

  aiQueue = [JSON.stringify({ issues: [
    { severity: 'Medium', element: 'compensation', message: 'Payment amount is vague', explanation: 'Say how much.', quote: 'You will receive the payment described in the study listing.', suggestion: 'You will receive £10.' },
    { severity: 'low', element: 'bogus', message: 'Paraphrased quote', explanation: 'x', quote: 'this sentence is not in the document', suggestion: 'y' },
  ] })];
  aiRequests.length = 0;
  const chk = await owner('POST', `/api/studies/${studyId}/consent/check`, {});
  assert.equal(chk.status, 200, chk.text);
  assert.equal(chk.json.ai, 'ok');
  assert.equal(aiRequests.length, 1, 'one (mocked) AI request');
  assert.match(String(aiRequests[0].input), /Participant information asked: Full name \(identifying\), Age, Sex, Gender identity, Role/);
  const ai = chk.json.issues.filter((i: any) => i.source === 'ai');
  assert.equal(ai[0].severity, 'medium');
  assert.equal(ai[0].element, 'compensation');
  assert.equal(ai[0].quote, 'You will receive the payment described in the study listing.');
  assert.equal(ai[1].quote, undefined, 'quotes not found in the document are dropped');
  assert.equal(ai[1].element, undefined);
  assert.ok(chk.json.issues.some((i: any) => i.key === 'field:custom'), 'lint runs too');
  assert.ok(chk.json.readability.grade > 0);
  assert.equal((await owner('GET', `/api/studies/${studyId}/consent`)).json.form.lastCheck.checkedAt, chk.json.checkedAt);

  aiQueue = [JSON.stringify({ text: '## About\n\nWe test a website. You can stop at any time.', changes: ['Shorter sentences'] })];
  const rw = await owner('POST', `/api/studies/${studyId}/consent/rewrite`, { text });
  assert.equal(rw.status, 200);
  assert.deepEqual(rw.json.changes, ['Shorter sentences']);
  assert.equal((await owner('GET', `/api/studies/${studyId}/consent`)).json.form.version, 2, 'rewrite never saves');

  const dl = await owner('GET', `/api/studies/${studyId}/consent/document`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition') ?? '', /attachment; filename="consent\.pdf"/);
  assert.ok(dl.text.startsWith('%PDF-'));
});

test('participant: sees the form, invalid or under-age submissions store nothing, valid ones store info + signature', async () => {
  assert.equal((await owner('PATCH', `/api/studies/${studyId}`, { status: 'live' })).status, 200);
  const anon = client();
  const info = (await anon('GET', `/api/p/links/${token}`)).json;
  assert.equal(info.consentForm.version, 2);
  assert.equal(info.consentForm.signature.mode, 'typed_name');
  assert.deepEqual(info.consentForm.fields.map((f: any) => f.id), ['full_name', 'age', 'sex', 'gender', 'cf_role']);
  assert.equal(info.consentForm.lastCheck, undefined, 'check results stay private');
  assert.equal(info.consentForm.history, undefined);
  const pdl = await anon('GET', info.consentForm.document.url);
  assert.equal(pdl.status, 200);
  assert.ok(pdl.text.startsWith('%PDF-'));

  const count = () => (db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE study_id = ?').get(studyId) as { n: number }).n;
  const sig = { mode: 'typed_name', name: 'Ada Lovelace', agreed: true };
  const goodInfo = { full_name: 'Ada Lovelace', age: 36, sex: 'Female', gender: 'Woman', cf_role: 'Designer' };
  const bad = await anon('POST', `/api/p/links/${token}/sessions`, { device, consent: { ...baseConsent, signature: sig }, participantInfo: { ...goodInfo, gender: '', cf_role: 'CEO' } });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.details.fields.gender && bad.json.details.fields.cf_role);
  const young = await anon('POST', `/api/p/links/${token}/sessions`, { device, consent: { ...baseConsent, signature: sig }, participantInfo: { ...goodInfo, age: 15 } });
  assert.equal(young.status, 403);
  assert.equal(young.json.details.reason, 'under_age');
  const unsigned = await anon('POST', `/api/p/links/${token}/sessions`, { device, consent: { ...baseConsent, signature: { mode: 'typed_name', name: ' ', agreed: true } }, participantInfo: goodInfo });
  assert.equal(unsigned.status, 400);
  assert.equal(count(), 0, 'nothing stored for rejected submissions');

  const ok = await anon('POST', `/api/p/links/${token}/sessions`, { device, consent: { ...baseConsent, version: 'client-lies', signature: sig }, participantInfo: { ...goodInfo, extra: 'dropped' } });
  assert.equal(ok.status, 201, ok.text);
  const row = db.prepare('SELECT consent, participant_info FROM sessions WHERE id = ?').get(ok.json.session.id) as { consent: string; participant_info: string };
  const rec = JSON.parse(row.consent);
  assert.equal(rec.version, '2');
  assert.equal(rec.formVersion, 2);
  assert.equal(rec.formHash, info.consentForm.hash);
  assert.equal(rec.signature.name, 'Ada Lovelace');
  assert.match(rec.signature.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(rec.ageConfirmed, true);
  assert.deepEqual(rec.fields.map((f: any) => f.id), ['full_name', 'age', 'sex', 'gender', 'cf_role']);
  assert.deepEqual(JSON.parse(row.participant_info), goodInfo);

  // A second participant, for demographics.
  const ok2 = await anon('POST', `/api/p/links/${token}/sessions`, { device, consent: { ...baseConsent, signature: { mode: 'typed_name', name: 'Grace Hopper', agreed: true } }, participantInfo: { full_name: 'Grace Hopper', age: 61, gender: 'Prefer to describe: none', cf_role: 'Developer' } });
  assert.equal(ok2.status, 201, ok2.text);

  // Researcher sees info in the sessions list, detail, export and demographics.
  const list = (await owner('GET', `/api/studies/${studyId}/sessions`)).json;
  assert.ok(list.participantFields.some((f: any) => f.id === 'cf_role' && f.column === 'info.role'));
  assert.equal(list.sessions.find((s: any) => s.id === ok.json.session.id).participantInfo.full_name, 'Ada Lovelace');
  const det = (await owner('GET', `/api/sessions/${ok.json.session.id}`)).json;
  assert.equal(det.session.participantInfo.cf_role, 'Designer');
  assert.equal(det.session.consent.signature.name, 'Ada Lovelace');

  const csv = (await owner('GET', `/api/studies/${studyId}/export?table=sessions&format=csv`)).text;
  assert.match(csv, /info\.full_name/);
  assert.match(csv, /Ada Lovelace/);
  assert.match(csv, /consentFormVersion/);
  const safe = await owner('GET', `/api/studies/${studyId}/export?table=sessions&format=json&excludePii=1`);
  assert.match(safe.headers.get('content-disposition') ?? '', /sessions-no-pii\.json/);
  assert.doesNotMatch(safe.text, /Ada Lovelace|Grace Hopper|info\.full_name|consentSignedName/);
  assert.equal(safe.json.find((r: any) => r.sessionId === ok.json.session.id)['info.role'], 'Designer');
  assert.equal(safe.json.find((r: any) => r.sessionId === ok.json.session.id)['info.age'], 36);

  const demo = (await owner('GET', `/api/studies/${studyId}/demographics`)).json;
  assert.equal(demo.withInfo, 2);
  const age = demo.breakdowns.find((b: any) => b.fieldId === 'age');
  assert.deepEqual(age.counts.filter((c: any) => c.n).map((c: any) => c.label), ['35–44', '55–64']);
  assert.equal(age.stats.median, 48.5);
  const gender = demo.breakdowns.find((b: any) => b.fieldId === 'gender');
  assert.deepEqual(gender.counts.filter((c: any) => c.n), [{ label: 'Woman', n: 1 }, { label: 'Prefer to describe: none', n: 1 }]);
  assert.ok(!demo.breakdowns.some((b: any) => b.fieldId === 'full_name'), 'names are never charted');

  // Withdrawal deletes participant info and the typed name.
  const w = await anon('POST', `/api/p/sessions/${ok.json.session.id}/withdraw`, {}, { 'X-Session-Secret': ok.json.secret });
  assert.equal(w.status, 200);
  const after = db.prepare('SELECT status, consent, participant_info FROM sessions WHERE id = ?').get(ok.json.session.id) as { status: string; consent: string; participant_info: string | null };
  assert.equal(after.status, 'withdrawn');
  assert.equal(after.participant_info, null);
  assert.equal(JSON.parse(after.consent).signature.name, undefined);
  assert.doesNotMatch((await owner('GET', `/api/studies/${studyId}/export?table=sessions&format=csv`)).text, /Ada Lovelace/);
  assert.equal((await owner('GET', `/api/studies/${studyId}/demographics`)).json.withInfo, 1);
});

test('another account cannot read or change a study consent form', async () => {
  const intruder = client();
  await intruder('POST', '/api/auth/signup', { email: 'consent-intruder@example.com', password: 'password123', name: 'X' });
  const anon = client();
  const fd = () => {
    const f = new FormData();
    f.append('file', new Blob(['Hello there, this is text.']), 'x.txt');
    return f;
  };
  const checks: [string, string, unknown?][] = [
    ['GET', `/api/studies/${studyId}/consent`],
    ['PUT', `/api/studies/${studyId}/consent`, { text: 'pwned' }],
    ['POST', `/api/studies/${studyId}/consent/document`, fd()],
    ['GET', `/api/studies/${studyId}/consent/document`],
    ['DELETE', `/api/studies/${studyId}/consent/document`],
    ['POST', `/api/studies/${studyId}/consent/check`, {}],
    ['POST', `/api/studies/${studyId}/consent/rewrite`, { text: 'x'.repeat(40) }],
    ['GET', `/api/studies/${studyId}/demographics`],
  ];
  const leaks: string[] = [];
  for (const [m, u, b] of checks) {
    const r = await intruder(m, u, b instanceof FormData ? fd() : b);
    if (r.status !== 404 && r.status !== 403) leaks.push(`${m} ${u} → ${r.status}`);
    const a = await anon(m, u, b instanceof FormData ? fd() : b);
    if (![401, 403, 404].includes(a.status)) leaks.push(`anon ${m} ${u} → ${a.status}`);
  }
  assert.deepEqual(leaks, []);
  const form = (await owner('GET', `/api/studies/${studyId}/consent`)).json.form;
  assert.notEqual(form.text, 'pwned');
  assert.ok(form.documentId, 'document still attached');
  // Deleting the study removes the stored originals.
  assert.equal((await owner('DELETE', `/api/studies/${studyId}`)).status, 200);
  assert.equal(fs.existsSync(path.join(dataDir, 'consent', studyId)), false);
});
