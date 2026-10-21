// Session media files: rrweb chunks, audio chunks, mouse/gaze point batches.
import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';
import { db, json } from '../db.ts';
import { paths } from '../lib/paths.ts';
import type { Row } from '../lib/repo.ts';

const seqOf = (f: string) => Number(/-(\d+)\.\w+$/.exec(f)?.[1] ?? 0);

function listFiles(sessionId: string, re: RegExp): string[] {
  const dir = paths.session(sessionId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => re.test(f))
    .sort((a, b) => seqOf(a) - seqOf(b) || a.localeCompare(b))
    .map((f) => path.join(dir, f));
}

export const rrwebFiles = (sid: string) => listFiles(sid, /^rrweb-\d+\.json$/);
export const audioFiles = (sid: string, track: string) => listFiles(sid, new RegExp(`^audio-${track.replace(/[^a-z0-9_]/gi, '')}-\\d+\\.webm$`));

export function hasReplay(sid: string) {
  return rrwebFiles(sid).length > 0;
}

export function audioTracks(sid: string): string[] {
  const dir = paths.session(sid);
  if (!fs.existsSync(dir)) return [];
  const tracks = new Set<string>();
  for (const f of fs.readdirSync(dir)) {
    const m = /^audio-([a-z0-9_]+)-\d+\.webm$/i.exec(f);
    if (m) tracks.add(m[1]);
  }
  // mixed first (moderator + participant), then mic
  return [...tracks].sort((a, b) => (a === 'mixed' ? -1 : b === 'mixed' ? 1 : a.localeCompare(b)));
}

/** Merge rrweb chunk files in sequence order; tolerant of `[...]` or `{events:[...]}` chunk bodies and corrupt chunks. */
export function readReplay(sid: string): unknown[] {
  const out: unknown[] = [];
  for (const f of rrwebFiles(sid)) {
    try {
      const raw = JSON.parse(fs.readFileSync(f, 'utf8')) as unknown;
      const evs = Array.isArray(raw) ? raw : Array.isArray((raw as { events?: unknown[] })?.events) ? (raw as { events: unknown[] }).events : [];
      for (const e of evs) out.push(e);
    } catch {
      /* skip corrupt chunk */
    }
  }
  // rrweb requires chronological order.
  out.sort((a, b) => Number((a as { timestamp?: number }).timestamp ?? 0) - Number((b as { timestamp?: number }).timestamp ?? 0));
  return out;
}

/** Stream concatenated audio chunks with HTTP Range support (seeking in <audio>). */
export function sendAudio(req: Request, res: Response, sid: string, track: string) {
  const files = audioFiles(sid, track);
  if (!files.length) {
    res.status(404).json({ error: 'No audio for this session' });
    return;
  }
  const sizes = files.map((f) => fs.statSync(f).size);
  const total = sizes.reduce((s, v) => s + v, 0);
  res.setHeader('Content-Type', 'audio/webm');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=60');
  let start = 0;
  let end = total - 1;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (m[1] === '' && m[2] === '')) {
      res.status(416).setHeader('Content-Range', `bytes */${total}`).end();
      return;
    }
    if (m[1] === '') {
      start = Math.max(0, total - Number(m[2]));
    } else {
      start = Number(m[1]);
      if (m[2] !== '') end = Math.min(end, Number(m[2]));
    }
    if (start > end || start >= total) {
      res.status(416).setHeader('Content-Range', `bytes */${total}`).end();
      return;
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
  }
  res.setHeader('Content-Length', String(end - start + 1));
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  // Pipe the byte range across chunk files sequentially.
  let offset = 0;
  const parts: { file: string; from: number; to: number }[] = [];
  files.forEach((f, i) => {
    const fStart = offset;
    const fEnd = offset + sizes[i] - 1;
    offset += sizes[i];
    if (fEnd < start || fStart > end) return;
    parts.push({ file: f, from: Math.max(0, start - fStart), to: Math.min(sizes[i] - 1, end - fStart) });
  });
  const next = () => {
    const p = parts.shift();
    if (!p) return void res.end();
    const s = fs.createReadStream(p.file, { start: p.from, end: p.to });
    s.on('error', () => res.destroy());
    s.on('end', next);
    s.pipe(res, { end: false });
  };
  next();
}

export interface FlatPoint {
  t: number;
  x: number;
  y: number;
  vw: number;
  vh: number;
  path: string;
  stepId: string | null;
  scrollX?: number;
  scrollY?: number;
}

/** Flatten mouse/gaze point batches for one session. */
export function readPoints(sid: string, kind: 'mouse' | 'gaze'): FlatPoint[] {
  const rows = db.prepare('SELECT t, step_id, data FROM events WHERE session_id = ? AND kind = ? ORDER BY t, seq').all(sid, kind) as Row[];
  const out: FlatPoint[] = [];
  for (const r of rows) {
    const d = json.parse<{ points?: [number, number, number][]; vw?: number; vh?: number; path?: string; scrollX?: number; scrollY?: number }>(r.data, {});
    for (const p of d.points ?? []) {
      if (!Array.isArray(p) || p.length < 3) continue;
      out.push({
        t: Number(p[0]),
        x: Number(p[1]),
        y: Number(p[2]),
        vw: Number(d.vw ?? 0),
        vh: Number(d.vh ?? 0),
        path: String(d.path ?? ''),
        stepId: r.step_id == null ? null : String(r.step_id),
        ...(d.scrollX != null ? { scrollX: d.scrollX } : {}),
        ...(d.scrollY != null ? { scrollY: d.scrollY } : {}),
      });
    }
  }
  return out;
}

export function deleteSessionFiles(sid: string) {
  fs.rmSync(paths.session(sid), { recursive: true, force: true });
}
