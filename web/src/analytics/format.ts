import type { Interval, TaskOutcome } from '@thinkaloud/shared';

/** Variant identity colors (validated: adjacent CVD ΔE ≥ 8; always paired with direct labels/tables). */
export const VARIANT_COLORS = ['#0071e3', '#e8890c', '#30b0c7', '#5856d6', '#ff2d55', '#34c759'];
export const variantColor = (i: number) => VARIANT_COLORS[i % VARIANT_COLORS.length];

export const OUTCOME_META: Record<TaskOutcome, { label: string; color: string }> = {
  success: { label: 'Success', color: '#34c759' },
  partial: { label: 'Partial', color: '#ffcc00' },
  failure: { label: 'Failure', color: '#ff3b30' },
  abandoned: { label: 'Gave up', color: '#ff9f0a' },
  timeout: { label: 'Timed out', color: '#8e8e93' },
};

export const pct = (v: number | null | undefined, d = 0) => (v == null || !isFinite(v) ? '—' : `${(v * 100).toFixed(d)}%`);
export const num = (v: number | null | undefined, d = 1) => (v == null || !isFinite(v) ? '—' : v.toFixed(d));

export function secs(ms: number | null | undefined): string {
  if (ms == null || !isFinite(ms)) return '—';
  const s = ms / 1000;
  if (s < 9.95) return `${s.toFixed(1)}s`;
  const total = Math.round(s);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  if (m >= 60) return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  return `${m}m ${String(total % 60).padStart(2, '0')}s`;
}

/** Player clock: m:ss */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

export function fmtP(p: number | null | undefined): string {
  if (p == null) return '—';
  if (p < 0.001) return '< .001';
  return p.toFixed(3).replace(/^0/, '');
}

export const ciText = (i: Interval | null | undefined, f: (v: number) => string) => (i ? `${f(i.low)}–${f(i.high)}` : '');

/** Bangor, Kortum & Miller (2009) adjective scale + Sauro-Lewis curved grading scale. */
export function susGrade(score: number): { adjective: string; grade: string; percentile: string } {
  const adjective =
    score >= 84.1 ? 'Best imaginable' : score >= 80.3 ? 'Excellent' : score >= 68 ? 'Good' : score >= 51 ? 'OK' : score >= 25 ? 'Poor' : 'Worst imaginable';
  const grade =
    score >= 84.1 ? 'A+' : score >= 80.8 ? 'A' : score >= 78.9 ? 'A−' : score >= 77.2 ? 'B+' : score >= 74.1 ? 'B' : score >= 72.6 ? 'B−' : score >= 71.1 ? 'C+' : score >= 65 ? 'C' : score >= 62.7 ? 'C−' : score >= 51.7 ? 'D' : 'F';
  const percentile = score >= 80.8 ? '90th+' : score >= 74.1 ? '70–89th' : score >= 68 ? '50–69th' : score >= 51.7 ? '15–49th' : '< 15th';
  return { adjective, grade, percentile };
}

export const lostnessLabel = (l: number | null) => (l == null ? '' : l < 0.4 ? 'Not lost' : l <= 0.5 ? 'Borderline' : 'Lost');

/** Simple markdown-ish emphasis for server strings with **bold**. */
export const plain = (s: string) => s.replace(/\*\*/g, '');

/** Participant-info value as text (yes/no, lists, YYYY-MM-DD dates). Empty → ''. */
export function infoText(v: string | number | boolean | string[] | null | undefined, kind?: string): string {
  if (v == null || v === '') return '';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.join(', ');
  if (kind === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const d = new Date(`${v}T00:00:00`);
    if (!isNaN(d.getTime())) return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  return String(v);
}
