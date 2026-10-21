// Reference values: scipy 1.11 (stats.t, special.betainc, ttest_ind, fisher_exact, mannwhitneyu)
// and worked examples from Sauro & Lewis, "Quantifying the User Experience" (2016).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as s from './stats.ts';

const close = (actual: number | null | undefined, expected: number, tol = 1e-6, msg?: string) => {
  assert.ok(actual != null && Math.abs(actual - expected) <= tol, `${msg ?? ''} expected ${expected}, got ${actual}`);
};

test('logGamma', () => {
  close(s.logGamma(0.5), 0.5723649429247, 1e-12);
  close(s.logGamma(10), 12.801827480081469, 1e-12);
  close(s.logGamma(1), 0, 1e-12);
});

test('regularized incomplete beta', () => {
  close(s.incompleteBeta(0.4, 2, 3), 0.5248, 1e-12);
  close(s.incompleteBeta(0.1, 0.5, 5), 0.6833570849799877, 1e-10);
  assert.equal(s.incompleteBeta(0, 2, 2), 0);
  assert.equal(s.incompleteBeta(1, 2, 2), 1);
});

test('normal CDF / quantile', () => {
  close(s.normalCdf(1.96), 0.9750021048517795, 1e-12);
  close(s.normalCdf(0), 0.5, 1e-15);
  close(s.normalQuantile(0.95), 1.6448536269514722, 1e-10);
  close(s.normalQuantile(1e-6), -4.753424308822899, 1e-9);
  close(s.zCritical(0.95), 1.959963984540054, 1e-10);
  close(s.zCritical(0.9), 1.6448536269514722, 1e-10);
});

test('t distribution CDF and quantiles (textbook table values)', () => {
  close(s.tCdf(2.0, 5), 0.9490302605850709, 1e-10);
  close(s.tCdf(-1.3, 12), 0.10900858554175712, 1e-10);
  close(s.tQuantile(0.975, 9), 2.262157162740991, 1e-7); // t table: 2.262
  close(s.tQuantile(0.95, 4), 2.1318467813362902, 1e-7); // 2.132
  close(s.tQuantile(0.995, 1), 63.65674116287399, 1e-6); // 63.657
  close(s.tQuantile(0.975, 100), 1.9839715184496334, 1e-7);
  close(s.tQuantile(0.9, 2.5), 1.7302509288071768, 1e-7); // non-integer df (Welch)
  close(s.tQuantile(0.025, 9), -2.262157162740991, 1e-7);
});

test('chi-square df=1 upper tail', () => {
  close(s.chiSquare1UpperP(3.84), 0.05004352124870519, 1e-10);
});

test('adjusted-Wald completion CI (Sauro & Lewis: 7/10 → ~39%–90% at 95%)', () => {
  const ci = s.adjustedWald(7, 10, 0.95)!;
  close(ci.estimate, 0.7, 1e-12);
  close(ci.low, 0.3923, 5e-4);
  close(ci.high, 0.8967, 5e-4);
  // 10/10 never produces an upper bound > 1 and gives a sensible lower bound
  const all = s.adjustedWald(10, 10, 0.95)!;
  assert.equal(all.high, 1);
  close(all.low, 0.6791, 5e-4); // Agresti-Coull lower bound for 10/10
  assert.equal(s.adjustedWald(0, 0), null);
});

test('mean CI (t-based) and geometric mean CI on logs', () => {
  const ci = s.meanCI([94, 88, 72, 60, 85, 77], 0.9)!;
  close(ci.estimate, 79.33333333333333, 1e-9);
  close(ci.low, 69.22233184785034, 1e-7);
  close(ci.high, 89.44433481881632, 1e-7);
  const g = s.geometricMeanCI([40, 52, 61, 35, 90, 47], 0.95)!;
  close(g.estimate, 51.55849878347201, 1e-8);
  close(g.low, 36.26878953589098, 1e-6);
  close(g.high, 73.2938383337745, 1e-6);
  const clamped = s.meanCI([100, 100, 95], 0.95, [0, 100])!;
  assert.ok(clamped.high <= 100);
});

test('Welch t test (scipy ttest_ind equal_var=False)', () => {
  const a = [34, 25, 51, 40, 38, 45, 29, 47];
  const b = [22, 30, 19, 28, 25, 33, 21];
  const r = s.welchT(a, b)!;
  close(-r.t, 3.5446600976170246, 1e-9); // our t is (B − A)
  close(r.df, 11.341920077361102, 1e-9);
  close(r.p, 0.004388398000510468, 1e-9);
  const lg = s.welchTLog(a, b)!;
  close(-lg.t, 3.5432532750121646, 1e-9);
  close(lg.df, 12.965800976460397, 1e-8);
  close(lg.p, 0.003616296406748436, 1e-9);
  assert.ok(lg.ratio < 1);
});

test('N-1 two-proportion test', () => {
  // 11/12 vs 5/10: chi² = (ad−bc)²(N−1)/(mnrs) = 50²·21/(16·6·12·10) = 4.557
  const r = s.nMinus1ChiSquare(11, 12, 5, 10)!;
  close(r.chi2, 4.557291666666667, 1e-9);
  close(r.p, 0.032778869508858575, 1e-9);
  close(r.diff, 0.5 - 11 / 12, 1e-12);
  assert.ok(r.ci[0] < r.diff && r.ci[1] > r.diff - 0.2);
  // identical rates → p = 1
  close(s.nMinus1ChiSquare(5, 10, 5, 10)!.p, 1, 1e-12);
  // all succeed in both groups → degenerate, p = 1
  close(s.nMinus1ChiSquare(10, 10, 8, 8)!.p, 1, 1e-12);
});

test('Fisher exact two-sided (scipy fisher_exact)', () => {
  close(s.fisherExact(7, 3, 2, 8), 0.06977851869492736, 1e-10);
  close(s.fisherExact(1, 9, 11, 3), 0.0027594561852200836, 1e-10);
  close(s.fisherExact(10, 0, 10, 0), 1, 1e-12);
});

test('Mann-Whitney U with ties (scipy asymptotic, continuity)', () => {
  const r = s.mannWhitneyU([1, 2, 2, 3, 4, 5, 5, 5], [3, 4, 6, 6, 7, 8, 8])!;
  close(r.u1, 8, 1e-12);
  close(r.p, 0.02290340259352298, 1e-9);
  assert.ok(r.rankBiserial > 0);
});

test('effect sizes', () => {
  const a = [34, 25, 51, 40, 38, 45, 29, 47];
  const b = [22, 30, 19, 28, 25, 33, 21];
  close(s.cohensD(a, b), -1.7688134166391911, 1e-9);
  close(s.hedgesG(a, b), -1.6647655686015916, 1e-9);
  assert.equal(s.effectLabel(-1.66), 'large');
  assert.equal(s.effectLabel(0.3), 'small');
  assert.equal(s.effectLabel(0.1), 'negligible');
});

test('lostness (Smith 1996)', () => {
  // S=8 visits, N=6 unique, R=4 optimal → sqrt(0.0625 + 0.1111) = 0.4167
  close(s.lostness(8, 6, 4), 0.41666666666666667, 1e-3);
  close(s.lostness(4, 4, 4), 0, 1e-12); // perfect path
  assert.equal(s.lostness(0, 0, 3), null);
});

test('descriptives + NPS', () => {
  close(s.median([3, 1, 4, 1, 5, 9, 2, 6]), 3.5, 1e-12);
  close(s.quantile([3, 1, 4, 1, 5, 9, 2, 6], 0.25), 1.75, 1e-12);
  close(s.geometricMean([1, 10, 100]), 10, 1e-9);
  const n = s.nps([10, 9, 9, 8, 7, 6, 3, 10])!;
  assert.equal(n.promoters, 4);
  assert.equal(n.detractors, 2);
  assert.equal(n.passives, 2);
  close(n.score, 25, 1e-9);
});

test('sample size helpers are sane', () => {
  const n = s.sampleSizeTwoProportions(0.5, 0.8)!;
  assert.ok(n > 30 && n < 50, `n=${n}`); // ≈ 39 per group
  const m = s.sampleSizeTwoMeans(0.5)!;
  assert.ok(m >= 63 && m <= 65, `m=${m}`); // ≈ 64 per group
});
