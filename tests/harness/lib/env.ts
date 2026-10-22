// Shared paths + .env loading for the realistic participant harness.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '../../..');
export const HARNESS_DIR = path.resolve(import.meta.dirname, '..');
export const REPORTS_DIR = path.join(HARNESS_DIR, 'reports');
export const CACHE_DIR = path.join(HARNESS_DIR, '.cache');
export const CHROME = path.join(os.homedir(), '.cache/ms-playwright/chromium-1234/chrome-linux/chrome');

/**
 * Zero-cost guard: the harness is fully offline (mock realtime, scripted moderator, rule-based
 * participant, deterministic judge). It refuses to run when an OpenAI key is present in its own
 * environment, and it never reads .env.
 */
export function assertNoKey() {
  for (const k of ['OPENAI_API_KEY', 'OPENAI_KEY', 'AZURE_OPENAI_API_KEY']) {
    if (process.env[k] && process.env[k]!.trim())
      throw new Error(`Refusing to start: ${k} is set in the harness environment. The harness is offline and must run without any OpenAI key (unset it, e.g. \`env -u ${k} npm run harness …\`).`);
  }
}

/** Environment for child processes: never carries an OpenAI key. */
export function keylessEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (/OPENAI/i.test(k)) delete env[k];
  return { ...env, OPENAI_API_KEY: '', ...extra };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function stamp(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Seeded PRNG (mulberry32) so a scenario's random knobs are reproducible with --seed. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Normalised word overlap: is `said` a reading of `prompt`? (same idea as web/src/participant/rules.ts isReadingOf) */
export function isReadingOf(said: string, prompt: string, threshold = 0.6): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[’']/g, "'")
      .replace(/[^\p{L}\p{N} ]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const a = norm(said);
  const b = norm(prompt);
  if (!b) return false;
  const words = b.split(' ').filter((w) => w.length > 3);
  if (!words.length) return a.includes(b);
  const hit = words.filter((w) => a.includes(w)).length;
  return hit / words.length >= threshold;
}
