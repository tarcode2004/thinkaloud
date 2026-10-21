// Small, dependency-free statistics library for usability metrics.
// Methods follow Sauro & Lewis, "Quantifying the User Experience" (2nd ed., 2016):
//  - adjusted-Wald CIs for completion rates (works well at small n)
//  - N-1 two-proportion test (N-1 chi-square) for between-subjects completion comparisons; Fisher exact as option
//  - task times: log-transform, geometric mean + t-based CI on logs, Welch t on logs
//  - rating scales (SUS/SEQ/UMUX): t-based CIs and Welch two-sample t
// Numerical routines: Lanczos log-gamma, Lentz continued fraction for the regularized incomplete beta,
// Hart/West double-precision normal CDF, Acklam normal quantile with one Halley refinement step.

import type { Interval } from '@thinkaloud/shared';

// ── Special functions ───────────────────────────────────────────────────────

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** Natural log of the gamma function (Lanczos, g=7). Accurate to ~1e-15 for x > 0. */
export function logGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - logGamma(1 - x);
  x -= 1;
  let a = 0.99999999999980993;
  const t = x + 7.5;
  for (let i = 0; i < 8; i++) a += LANCZOS[i] / (x + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function logBeta(a: number, b: number) {
  return logGamma(a) + logGamma(b) - logGamma(a + b);
}

/** Continued fraction for the incomplete beta (modified Lentz). */
function betacf(x: number, a: number, b: number): number {
  const MAXIT = 500;
  const EPS = 1e-15;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
export function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - logBeta(a, b));
  if (x < (a + 1) / (a + b + 2)) return (front * betacf(x, a, b)) / a;
  return 1 - (front * betacf(1 - x, b, a)) / b;
}

/** Standard normal CDF (Hart 1968 / West 2005 double precision, |err| < 1e-14). */
export function normalCdf(z: number): number {
  const x = Math.abs(z);
  let c: number;
  if (x > 37) c = 0;
  else {
    const e = Math.exp((-x * x) / 2);
    if (x < 7.07106781186547) {
      let b = 3.52624965998911e-2 * x + 0.700383064443688;
      b = b * x + 6.37396220353165;
      b = b * x + 33.912866078383;
      b = b * x + 112.079291497871;
      b = b * x + 221.213596169931;
      b = b * x + 220.206867912376;
      c = e * b;
      b = 8.83883476483184e-2 * x + 1.75566716318264;
      b = b * x + 16.064177579207;
      b = b * x + 86.7807322029461;
      b = b * x + 296.564248779674;
      b = b * x + 637.333633378831;
      b = b * x + 793.826512519948;
      b = b * x + 440.413735824752;
      c = c / b;
    } else {
      let b = x + 0.65;
      b = x + 4 / b;
      b = x + 3 / b;
      b = x + 2 / b;
      b = x + 1 / b;
      c = e / b / 2.506628274631;
    }
  }
  return z > 0 ? 1 - c : c;
}

/** Standard normal quantile (Acklam's algorithm + one Halley step; ~1e-15 relative). */
export function normalQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let x: number;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - pl) {
    const q = p - 0.5;
    const r = q * q;
    x = ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  // Halley refinement
  const e = normalCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

/** Two-sided critical z for a confidence level (0.95 → 1.959964). */
export function zCritical(level: number): number {
  return normalQuantile(1 - (1 - level) / 2);
}

/** Student t CDF. */
export function tCdf(t: number, df: number): number {
  if (!isFinite(t)) return t > 0 ? 1 : 0;
  if (df === Infinity) return normalCdf(t);
  const x = df / (df + t * t);
  const tail = 0.5 * incompleteBeta(x, df / 2, 0.5);
  return t > 0 ? 1 - tail : tail;
}

/** Two-sided p-value for a t statistic. */
export function tTwoSidedP(t: number, df: number): number {
  if (!isFinite(t)) return 0;
  return Math.min(1, incompleteBeta(df / (df + t * t), df / 2, 0.5));
}

/** Student t quantile (inverse CDF) by safeguarded Newton/bisection on tCdf. */
export function tQuantile(p: number, df: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p === 0.5) return 0;
  if (df === Infinity || df > 1e7) return normalQuantile(p);
  if (p < 0.5) return -tQuantile(1 - p, df);
  // bracket [0, hi]
  let lo = 0;
  let hi = Math.max(1, normalQuantile(p) * 2);
  while (tCdf(hi, df) < p) hi *= 2;
  let x = normalQuantile(p);
  if (!(x > lo && x < hi)) x = (lo + hi) / 2;
  const logC = logGamma((df + 1) / 2) - logGamma(df / 2) - 0.5 * Math.log(df * Math.PI);
  for (let i = 0; i < 200; i++) {
    const f = tCdf(x, df) - p;
    if (Math.abs(f) < 1e-15) break;
    if (f > 0) hi = x;
    else lo = x;
    const pdf = Math.exp(logC - ((df + 1) / 2) * Math.log(1 + (x * x) / df));
    let nx = x - f / pdf;
    if (!(nx > lo && nx < hi)) nx = (lo + hi) / 2;
    if (Math.abs(nx - x) < 1e-14 * Math.max(1, Math.abs(x))) {
      x = nx;
      break;
    }
    x = nx;
  }
  return x;
}

/** Two-sided critical t for a confidence level. */
export function tCritical(level: number, df: number): number {
  return tQuantile(1 - (1 - level) / 2, df);
}

/** Chi-square upper tail for df = 1 (exact via the normal). */
export function chiSquare1UpperP(x: number): number {
  if (x <= 0) return 1;
  return 2 * (1 - normalCdf(Math.sqrt(x)));
}

// ── Descriptives ────────────────────────────────────────────────────────────

export const sum = (xs: number[]) => xs.reduce((s, v) => s + v, 0);
export const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : NaN);

/** Sample variance (n-1). */
export function variance(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return sum(xs.map((v) => (v - m) ** 2)) / (xs.length - 1);
}
export const sd = (xs: number[]) => Math.sqrt(variance(xs));

/** Quantile with linear interpolation (type 7, same as R/numpy default). */
export function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const h = (s.length - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return s[lo] + (h - lo) * (s[hi] - s[lo]);
}
export const median = (xs: number[]) => quantile(xs, 0.5);

export function geometricMean(xs: number[]): number {
  const pos = xs.filter((v) => v > 0);
  if (!pos.length) return NaN;
  return Math.exp(mean(pos.map(Math.log)));
}

// ── Confidence intervals ────────────────────────────────────────────────────

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Adjusted-Wald (Agresti-Coull) interval for a binomial proportion.
 * Adds z²/2 successes and z² trials. The point estimate reported is the observed x/n.
 */
export function adjustedWald(x: number, n: number, level = 0.95): Interval | null {
  if (n <= 0) return null;
  const z = zCritical(level);
  const nAdj = n + z * z;
  const pAdj = (x + (z * z) / 2) / nAdj;
  const half = z * Math.sqrt((pAdj * (1 - pAdj)) / nAdj);
  return { estimate: x / n, low: clamp(pAdj - half, 0, 1), high: clamp(pAdj + half, 0, 1), level };
}

/** t-based CI for a mean. Optionally clamp to a scale range (e.g. SUS 0–100). */
export function meanCI(xs: number[], level = 0.95, range?: [number, number]): Interval | null {
  const v = xs.filter((x) => Number.isFinite(x));
  if (!v.length) return null;
  const m = mean(v);
  if (v.length < 2) return { estimate: m, low: m, high: m, level };
  const half = tCritical(level, v.length - 1) * (sd(v) / Math.sqrt(v.length));
  let low = m - half;
  let high = m + half;
  if (range) {
    low = clamp(low, range[0], range[1]);
    high = clamp(high, range[0], range[1]);
  }
  return { estimate: m, low, high, level };
}

/** Geometric mean with a t-based CI computed on log values and back-transformed. */
export function geometricMeanCI(xs: number[], level = 0.95): Interval | null {
  const v = xs.filter((x) => Number.isFinite(x) && x > 0);
  if (!v.length) return null;
  const logs = v.map(Math.log);
  const m = mean(logs);
  if (v.length < 2) return { estimate: Math.exp(m), low: Math.exp(m), high: Math.exp(m), level };
  const half = tCritical(level, v.length - 1) * (sd(logs) / Math.sqrt(v.length));
  return { estimate: Math.exp(m), low: Math.exp(m - half), high: Math.exp(m + half), level };
}

// ── Hypothesis tests ────────────────────────────────────────────────────────

export interface WelchResult {
  t: number;
  df: number;
  p: number;
  meanA: number;
  meanB: number;
  /** meanB - meanA */
  diff: number;
  ci: [number, number];
}

/** Welch's unequal-variance two-sample t test (two-sided). */
export function welchT(a: number[], b: number[], level = 0.95): WelchResult | null {
  if (a.length < 2 || b.length < 2) return null;
  const ma = mean(a);
  const mb = mean(b);
  const va = variance(a) / a.length;
  const vb = variance(b) / b.length;
  const se = Math.sqrt(va + vb);
  const diff = mb - ma;
  if (se === 0) {
    const p = diff === 0 ? 1 : 0;
    return { t: diff === 0 ? 0 : Infinity * Math.sign(diff), df: a.length + b.length - 2, p, meanA: ma, meanB: mb, diff, ci: [diff, diff] };
  }
  const t = diff / se;
  const df = (va + vb) ** 2 / (va ** 2 / (a.length - 1) + vb ** 2 / (b.length - 1));
  const p = tTwoSidedP(t, df);
  const half = tCritical(level, df) * se;
  return { t, df, p, meanA: ma, meanB: mb, diff, ci: [diff - half, diff + half] };
}

/** Welch t on log-transformed values (task times). Returns ratio of geometric means B/A with CI. */
export function welchTLog(a: number[], b: number[], level = 0.95) {
  const la = a.filter((v) => v > 0).map(Math.log);
  const lb = b.filter((v) => v > 0).map(Math.log);
  const r = welchT(la, lb, level);
  if (!r) return null;
  return { ...r, ratio: Math.exp(r.diff), ratioCi: [Math.exp(r.ci[0]), Math.exp(r.ci[1])] as [number, number], geoA: Math.exp(r.meanA), geoB: Math.exp(r.meanB) };
}

export interface TwoPropResult {
  chi2: number;
  p: number;
  pA: number;
  pB: number;
  /** pB - pA */
  diff: number;
  /** Adjusted-Wald CI for the difference (Sauro & Lewis: add z²/4 successes and z²/2 trials per group). */
  ci: [number, number];
  /** Smallest expected cell count; N-1 chi-square is recommended when all expected counts ≥ 1. */
  minExpected: number;
}

/**
 * N-1 two-proportion test (Campbell 2007; recommended by Sauro & Lewis for between-subjects completion rates).
 * chi² = (ad − bc)² (N − 1) / (m n r s)
 */
export function nMinus1ChiSquare(xA: number, nA: number, xB: number, nB: number, level = 0.95): TwoPropResult | null {
  if (nA <= 0 || nB <= 0) return null;
  const a = xA;
  const b = nA - xA;
  const c = xB;
  const d = nB - xB;
  const N = nA + nB;
  const m = a + c; // successes
  const nn = b + d; // failures
  const pA = xA / nA;
  const pB = xB / nB;
  let chi2 = 0;
  let p = 1;
  if (m > 0 && nn > 0) {
    chi2 = ((a * d - b * c) ** 2 * (N - 1)) / (m * nn * nA * nB);
    p = chiSquare1UpperP(chi2);
  }
  const z = zCritical(level);
  const add = (z * z) / 4;
  const pa = (xA + add) / (nA + 2 * add);
  const pb = (xB + add) / (nB + 2 * add);
  const se = Math.sqrt((pa * (1 - pa)) / (nA + 2 * add) + (pb * (1 - pb)) / (nB + 2 * add));
  const dAdj = pb - pa;
  const minExpected = Math.min((m * nA) / N, (m * nB) / N, (nn * nA) / N, (nn * nB) / N);
  return { chi2, p, pA, pB, diff: pB - pA, ci: [clamp(dAdj - z * se, -1, 1), clamp(dAdj + z * se, -1, 1)], minExpected };
}

function logFactorial(n: number) {
  return logGamma(n + 1);
}

/** Fisher exact test, two-sided (sum of tables with probability ≤ observed), 2×2 [[a,b],[c,d]]. */
export function fisherExact(a: number, b: number, c: number, d: number): number {
  const r1 = a + b;
  const r2 = c + d;
  const c1 = a + c;
  const n = r1 + r2;
  const lo = Math.max(0, c1 - r2);
  const hi = Math.min(r1, c1);
  const base = logFactorial(r1) + logFactorial(r2) + logFactorial(c1) + logFactorial(n - c1) - logFactorial(n);
  const prob = (x: number) => Math.exp(base - logFactorial(x) - logFactorial(r1 - x) - logFactorial(c1 - x) - logFactorial(r2 - c1 + x));
  const pObs = prob(a);
  let p = 0;
  for (let x = lo; x <= hi; x++) {
    const px = prob(x);
    if (px <= pObs * (1 + 1e-7)) p += px;
  }
  return Math.min(1, p);
}

/** Average ranks (ties get the mean rank). */
export function rank(xs: number[]): number[] {
  const idx = xs.map((v, i) => [v, i] as const).sort((p, q) => p[0] - q[0]);
  const ranks = new Array<number>(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[idx[k][1]] = r;
    i = j + 1;
  }
  return ranks;
}

/**
 * Mann-Whitney U (Wilcoxon rank-sum), two-sided, normal approximation with tie correction and
 * continuity correction (same as scipy.stats.mannwhitneyu(method='asymptotic', use_continuity=True)).
 */
export function mannWhitneyU(a: number[], b: number[]) {
  const n1 = a.length;
  const n2 = b.length;
  if (!n1 || !n2) return null;
  const all = [...a, ...b];
  const r = rank(all);
  const r1 = sum(r.slice(0, n1));
  const u1 = r1 - (n1 * (n1 + 1)) / 2;
  const u2 = n1 * n2 - u1;
  const n = n1 + n2;
  const counts = new Map<number, number>();
  for (const v of all) counts.set(v, (counts.get(v) ?? 0) + 1);
  let tie = 0;
  for (const t of counts.values()) tie += t ** 3 - t;
  const mu = (n1 * n2) / 2;
  const sigma = Math.sqrt(((n1 * n2) / 12) * (n + 1 - tie / (n * (n - 1))));
  const u = Math.max(u1, u2);
  if (sigma === 0) return { u1, u2, z: 0, p: 1, rankBiserial: 0 };
  const z = (u - mu - 0.5) / sigma;
  const p = Math.min(1, 2 * (1 - normalCdf(z)));
  // rank-biserial correlation (positive = B tends to be larger)
  const rankBiserial = (2 * u2) / (n1 * n2) - 1;
  return { u1, u2, z, p, rankBiserial };
}

// ── Effect sizes ────────────────────────────────────────────────────────────

/** Cohen's d with pooled SD (B − A). */
export function cohensD(a: number[], b: number[]): number | null {
  if (a.length < 2 || b.length < 2) return null;
  const pooled = Math.sqrt(((a.length - 1) * variance(a) + (b.length - 1) * variance(b)) / (a.length + b.length - 2));
  if (!pooled) return null;
  return (mean(b) - mean(a)) / pooled;
}

/** Hedges' g = d × J, J = 1 − 3 / (4(n1+n2) − 9). */
export function hedgesG(a: number[], b: number[]): number | null {
  const d = cohensD(a, b);
  if (d == null) return null;
  return d * (1 - 3 / (4 * (a.length + b.length) - 9));
}

/** Conventional magnitude label for a standardized mean difference (Cohen 1988). */
export function effectLabel(d: number | null | undefined): 'negligible' | 'small' | 'medium' | 'large' | null {
  if (d == null || !isFinite(d)) return null;
  const x = Math.abs(d);
  return x < 0.2 ? 'negligible' : x < 0.5 ? 'small' : x < 0.8 ? 'medium' : 'large';
}

// ── Usability-specific ──────────────────────────────────────────────────────

/**
 * Lostness (Smith 1996): L = sqrt((N/S − 1)² + (R/N − 1)²)
 * S = total pages visited (incl. revisits), N = unique pages visited, R = minimum pages required.
 * L < 0.4 not lost, > 0.5 lost.
 */
export function lostness(S: number, N: number, R: number): number | null {
  if (S <= 0 || N <= 0 || R <= 0) return null;
  return Math.sqrt((N / S - 1) ** 2 + (Math.min(R, N) / N - 1) ** 2);
}

/** Net Promoter Score from 0–10 ratings. */
export function nps(ratings: number[]) {
  const n = ratings.length;
  if (!n) return null;
  const promoters = ratings.filter((r) => r >= 9).length;
  const detractors = ratings.filter((r) => r <= 6).length;
  const passives = n - promoters - detractors;
  return { score: Math.round(((promoters - detractors) / n) * 1000) / 10, promoters, passives, detractors, n };
}

/** Approximate sample size per group needed to detect a difference in proportions (two-sided, normal approx). */
export function sampleSizeTwoProportions(p1: number, p2: number, alpha = 0.05, power = 0.8): number | null {
  if (p1 === p2) return null;
  const za = zCritical(1 - alpha);
  const zb = normalQuantile(power);
  const pbar = (p1 + p2) / 2;
  const num = (za * Math.sqrt(2 * pbar * (1 - pbar)) + zb * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2;
  return Math.ceil(num / (p1 - p2) ** 2);
}

/** Approximate n per group to detect standardized effect d (two-sided t, normal approx + 1 correction). */
export function sampleSizeTwoMeans(d: number, alpha = 0.05, power = 0.8): number | null {
  if (!d || !isFinite(d)) return null;
  const za = zCritical(1 - alpha);
  const zb = normalQuantile(power);
  return Math.ceil((2 * (za + zb) ** 2) / (d * d) + (za * za) / 4);
}
