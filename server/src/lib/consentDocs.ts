// Consent document ingestion: sniff the real type from magic bytes (never trust the extension or
// the client's MIME type), enforce size limits, and extract editable Markdown from PDF, DOCX,
// TXT, Markdown and HTML. Originals are stored under DATA_DIR/consent/<studyId>/<docId>.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { MAX_CONSENT_TEXT } from '@thinkaloud/shared';
import { HttpError } from './http.ts';
import { paths } from './paths.ts';

export const MAX_CONSENT_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_DOCX_UNZIPPED = 60 * 1024 * 1024;
const MAX_PDF_PAGES = 60;

export type ConsentDocKind = 'pdf' | 'docx' | 'txt' | 'md' | 'html';
export const CONSENT_MIME: Record<ConsentDocKind, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
};

const startsWith = (buf: Buffer, sig: number[]) => sig.every((b, i) => buf[i] === b);

/** Decode as UTF-8 text, or null when it is binary (NUL bytes, invalid UTF-8 or too many control chars). */
function asText(buf: Buffer): string | null {
  let body = buf;
  if (startsWith(buf, [0xef, 0xbb, 0xbf])) body = buf.subarray(3);
  else if (startsWith(buf, [0xff, 0xfe]) || startsWith(buf, [0xfe, 0xff])) {
    const le = buf[0] === 0xff;
    const u16 = Buffer.from(buf.subarray(2));
    if (!le) u16.swap16();
    return u16.toString('utf16le');
  }
  if (body.includes(0)) return null;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return null;
  }
  const ctrl = (text.match(/[\x00-\x08\x0e-\x1f]/g) ?? []).length;
  return ctrl > text.length * 0.01 ? null : text;
}

/** Determine the real document type from its bytes (the extension only disambiguates text formats). */
export function sniffConsentDocument(buf: Buffer, filename: string): ConsentDocKind {
  const ext = path.extname(filename).toLowerCase();
  if (!buf.length) throw new HttpError(400, 'The file is empty.');
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf'; // %PDF-
  if (startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
    throw new HttpError(415, 'This looks like an older Word file (.doc). Save it as .docx or PDF and upload it again.');
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) {
    let zip: AdmZip;
    try {
      zip = new AdmZip(buf);
    } catch {
      throw new HttpError(415, 'The file could not be opened. Upload a PDF, Word (.docx), text, Markdown or HTML file.');
    }
    const entries = zip.getEntries();
    if (entries.some((e) => e.entryName === 'word/document.xml')) {
      const total = entries.reduce((s, e) => s + (e.header.size || 0), 0);
      if (total > MAX_DOCX_UNZIPPED || entries.length > 2000) throw new HttpError(413, 'This Word document is too large to process.');
      return 'docx';
    }
    throw new HttpError(415, 'This zip file is not a Word document. Upload a PDF, Word (.docx), text, Markdown or HTML file.');
  }
  const text = asText(buf);
  if (text === null) throw new HttpError(415, 'Unsupported file type. Upload a PDF, Word (.docx), text (.txt), Markdown (.md) or HTML file.');
  if (ext === '.html' || ext === '.htm' || /^\s*(<!doctype html|<html[\s>])/i.test(text)) return 'html';
  if (ext === '.md' || ext === '.markdown') return 'md';
  return 'txt';
}

// ── text → Markdown ──────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', copy: '©', reg: '®', trade: '™' };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Escape characters that would turn plain text into raw HTML in Markdown. */
const escMd = (s: string) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Small, safe HTML → Markdown: headings, paragraphs, lists, bold/italic, links (http/mailto only). All other tags are dropped. */
export function htmlToMarkdown(html: string): string {
  let h = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|title|template|noscript|svg|iframe|object)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/\r\n?/g, '\n');
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(h);
  if (body) h = body[1];
  h = h.replace(/\s*\n\s*/g, ' ');
  h = h.replace(/<a\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => {
    const t = text.replace(/<[^>]+>/g, '').trim();
    const u = decodeEntities(href).trim();
    return /^(https?:|mailto:)/i.test(u) && t ? `[${t}](${u.replace(/[()\s]/g, encodeURIComponent)})` : t;
  });
  h = h
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, x: string) => (x.trim() ? `**${x.trim()}**` : ''))
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, x: string) => (x.trim() ? `*${x.trim()}*` : ''))
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl: string, x: string) => `\n\n${'#'.repeat(Math.max(2, Math.min(4, Number(lvl) + 1)))} ${x.replace(/<[^>]+>/g, '').trim()}\n\n`)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(li)>/gi, '')
    .replace(/<\/?(ul|ol)\b[^>]*>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|section|article|header|footer|table|tr|blockquote)\b[^>]*>/gi, '\n\n')
    .replace(/<\/t[dh]>/gi, ' ')
    .replace(/<[^>]+>/g, '');
  return tidy(escMd(decodeEntities(h)));
}

function tidy(md: string): string {
  return md
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trimEnd().replace(/^ (?=\S)/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_CONSENT_TEXT);
}

const BULLET = /^\s*([•●▪◦‣∙·\-–*]|\d{1,2}[.)]|[a-z][.)])\s+/;

/** Plain text (TXT or text pulled from a PDF) → Markdown: unwraps hard-wrapped lines, detects headings and bullets. */
export function plainTextToMarkdown(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\f/g, '\n\n').split('\n').map((l) => l.replace(/\s+$/, ''));
  const blocks: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push(para.join(' ').replace(/\s+/g, ' ').replace(/(\w)- (\w)/g, '$1$2'));
    para = [];
  };
  const isHeading = (l: string, next: string | undefined) => {
    const t = l.trim();
    if (t.length < 3 || t.length > 70 || /[.,;:]$/.test(t) || BULLET.test(t) || /@/.test(t)) return false;
    const words = t.split(/\s+/);
    if (words.length > 9) return false;
    const upper = t === t.toUpperCase() && /[A-Z]/.test(t);
    const numbered = /^\d+(\.\d+)*\.?\s+[A-Z]/.test(t);
    const titled = words.filter((w) => /^[A-Z0-9]/.test(w)).length >= Math.ceil(words.length * 0.6);
    const blankAfter = next === undefined || !next.trim();
    return upper || numbered || (titled && (blankAfter || words.length <= 5));
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const t = l.trim();
    if (!t) {
      flush();
      continue;
    }
    if (/^#{1,6}\s/.test(t)) {
      flush();
      blocks.push(t);
      continue;
    }
    if (BULLET.test(t)) {
      flush();
      para = [`- ${t.replace(BULLET, '')}`];
      continue;
    }
    const prev = lines[i - 1]?.trim() ?? '';
    if ((!prev || /[.!?:]$/.test(prev) || para.length === 0) && isHeading(t, lines[i + 1])) {
      flush();
      const h = t.replace(/^\d+(\.\d+)*\.?\s+/, '');
      blocks.push(`## ${h === h.toUpperCase() ? h.charAt(0) + h.slice(1).toLowerCase() : h}`);
      continue;
    }
    // A bullet continues on the next indented/wrapped line; a sentence end followed by a capital usually starts a new paragraph only on blank lines.
    para.push(t);
  }
  flush();
  const out: string[] = [];
  for (const b of blocks) {
    const prevB = out[out.length - 1];
    if (b.startsWith('- ') && prevB?.startsWith('- ')) out[out.length - 1] = `${prevB}\n${b}`;
    else out.push(b);
  }
  return tidy(escMd(out.join('\n\n')));
}

async function pdfToMarkdown(buf: Buffer): Promise<string> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(buf), { isEvalSupported: false, useSystemFonts: false, verbosity: 0 } as never);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/password/i.test(msg)) throw new HttpError(422, 'This PDF is password-protected. Remove the password and upload it again.');
    throw new HttpError(422, 'This PDF could not be read. Try exporting it again, or upload a Word or text version.');
  }
  if (pdf.numPages > MAX_PDF_PAGES) throw new HttpError(413, `This PDF has ${pdf.numPages} pages; consent documents are limited to ${MAX_PDF_PAGES}.`);
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = (Array.isArray(text) ? text : [text]).map((p) => p.trim());
  const joined = pages.join('\n\n');
  if (!joined.replace(/\s/g, '')) throw new HttpError(422, 'No text found in this PDF. It may be a scanned image; upload a version with selectable text.');
  return plainTextToMarkdown(joined);
}

async function docxToMarkdown(buf: Buffer): Promise<string> {
  const mammoth = (await import('mammoth')).default;
  let html: string;
  try {
    ({ value: html } = await mammoth.convertToHtml({ buffer: buf }, { includeDefaultStyleMap: true, convertImage: mammoth.images.imgElement(async () => ({ src: '' })) }));
  } catch {
    throw new HttpError(422, 'This Word document could not be read. Try saving it again, or upload a PDF.');
  }
  return htmlToMarkdown(html);
}

/** Extract editable Markdown from a sniffed document. */
export async function extractConsentText(buf: Buffer, kind: ConsentDocKind): Promise<string> {
  let md: string;
  if (kind === 'pdf') md = await pdfToMarkdown(buf);
  else if (kind === 'docx') md = await docxToMarkdown(buf);
  else {
    const text = asText(buf) ?? '';
    md = kind === 'html' ? htmlToMarkdown(text) : kind === 'md' ? tidy(text) : plainTextToMarkdown(text);
  }
  if (!md.trim()) throw new HttpError(422, 'No text found in this document.');
  return md;
}

export interface StoredConsentDoc {
  kind: ConsentDocKind;
  mime: string;
  sha256: string;
  size: number;
  text: string;
  path: string;
}

/** Sniff, extract and store an uploaded original under DATA_DIR/consent/<studyId>/<docId>. */
export async function ingestConsentDocument(studyId: string, docId: string, buf: Buffer, filename: string): Promise<StoredConsentDoc> {
  if (buf.length > MAX_CONSENT_UPLOAD_BYTES) throw new HttpError(413, `The file is larger than ${MAX_CONSENT_UPLOAD_BYTES / 1024 / 1024} MB.`);
  const kind = sniffConsentDocument(buf, filename);
  const text = await extractConsentText(buf, kind);
  const file = paths.consentFile(studyId, docId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
  return { kind, mime: CONSENT_MIME[kind], sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length, text, path: path.relative(paths.root, file) };
}

/** Resolve a stored (relative) path back to the file, refusing anything outside DATA_DIR/consent. */
export function consentDocPath(stored: string): string {
  const base = path.resolve(paths.root, 'consent');
  const abs = path.resolve(paths.root, stored);
  if (!abs.startsWith(base + path.sep)) throw new HttpError(404, 'Document not found');
  return abs;
}

/** Filename safe for a Content-Disposition header. */
export function safeFilename(name: string): string {
  const base = path.basename(name).replace(/[^\w.\- ()]+/g, '_').replace(/^\.+/, '').slice(0, 120);
  return base || 'consent-document';
}
