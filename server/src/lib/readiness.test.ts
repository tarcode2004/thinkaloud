// Pre-publish readiness checklist (pure logic in shared/readiness.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { notFoundMarker, readinessItems, readinessReport, type ReadinessInput, type ReadinessVariant } from '@thinkaloud/shared';

const app = { id: 'app_1', name: 'Build 1', status: 'ready', sourceKind: 'upload', proxied: true };
const variant = (over: Partial<ReadinessVariant> = {}): ReadinessVariant => ({
  id: 'var_a', name: 'A', protocolId: 'prt_1', protocolName: 'P', stepCount: 4, taskCount: 2, protocolConsentText: 'We record.', protocolUpdatedAt: 100, app, ...over,
});
const base = (over: Partial<ReadinessInput> = {}): ReadinessInput => ({
  variants: [variant()],
  hasActiveLink: true,
  consent: { formEnabled: false, formText: '' },
  voice: { ok: true },
  probes: [{ appId: 'app_1', path: '/', status: 200 }],
  lastPreviewAt: 500,
  appsUpdatedAt: 200,
  ...over,
});
const ids = (input: ReadinessInput) => readinessItems(input).map((i) => `${i.level}:${i.id}`);

test('a fully set-up, previewed study has nothing to report', () => {
  assert.deepEqual(readinessItems(base()), []);
  assert.equal(readinessReport([]).canPublish, true);
});

test('tasks without an app: warning that can be published anyway', () => {
  const items = readinessItems(base({ variants: [variant({ app: null })] }));
  assert.deepEqual(items.map((i) => `${i.level}:${i.id}`), ['warning:app:var_a']);
  assert.match(items[0].title, /2 tasks but no app/);
  assert.equal(items[0].fix?.tab, 'variants');
  assert.equal(readinessReport(items).canPublish, true);
});

test('interview-only protocol without an app is fine', () => {
  assert.deepEqual(ids(base({ variants: [variant({ app: null, taskCount: 0 })] })), []);
});

test('build not ready or failed blocks publishing', () => {
  const failed = readinessItems(base({ variants: [variant({ app: { ...app, status: 'failed' } })] }));
  assert.equal(failed[0].level, 'error');
  assert.equal(failed[0].fix?.tab, 'apps');
  assert.equal(readinessReport(failed).canPublish, false);
  assert.deepEqual(ids(base({ variants: [variant({ app: { ...app, status: 'building' } })] })), ['error:app:var_a']);
});

test('unproxied URL app warns', () => {
  assert.deepEqual(ids(base({ variants: [variant({ app: { ...app, sourceKind: 'url', proxied: false } })] })), ['warning:proxy:app_1']);
});

test('probe failures and SPA 404 pages warn, once per path', () => {
  const items = readinessItems(base({
    probes: [
      { appId: 'app_1', path: '/', status: 200, problem: 'Expo Router "Unmatched Route"' },
      { appId: 'app_1', path: '/', status: 200, problem: 'Expo Router "Unmatched Route"' },
      { appId: 'app_1', path: '/checkout', status: 404 },
      { appId: 'app_1', path: '/slow', status: 0, problem: 'timed out' },
    ],
  }));
  assert.deepEqual(items.map((i) => i.id), ['probe:app_1/', 'probe:app_1/checkout', 'probe:app_1/slow']);
  assert.match(items[0].detail ?? '', /Unmatched Route/);
  assert.match(items[1].detail ?? '', /404/);
  assert.match(items[2].detail ?? '', /timed out/);
  assert.ok(items.every((i) => i.level === 'warning'));
});

test('missing link, consent and voice are errors', () => {
  assert.deepEqual(ids(base({ hasActiveLink: false })), ['error:link']);
  assert.deepEqual(ids(base({ variants: [variant({ protocolConsentText: ' ' })] })), ['error:consent']);
  // An enabled study consent form overrides empty protocol consent text.
  assert.deepEqual(ids(base({ variants: [variant({ protocolConsentText: '' })], consent: { formEnabled: true, formText: 'Form text' } })), []);
  assert.deepEqual(ids(base({ consent: { formEnabled: true, formText: '' } })), ['error:consent']);
  assert.deepEqual(ids(base({ voice: { ok: false, detail: 'down' } })), ['error:voice']);
});

test('no variant / no protocol / empty protocol', () => {
  assert.deepEqual(ids(base({ variants: [] })), ['error:variants']);
  assert.ok(ids(base({ variants: [variant({ stepCount: undefined, protocolConsentText: undefined })] })).includes('error:protocol:var_a'));
  assert.ok(ids(base({ variants: [variant({ stepCount: 0 })] })).includes('error:protocol:var_a'));
  assert.deepEqual(ids(base({ variants: [variant({ app: undefined, appMissing: true })] })), ['error:app:var_a']);
});

test('preview: never, or stale after an edit', () => {
  assert.deepEqual(ids(base({ lastPreviewAt: 0 })), ['warning:preview']);
  assert.deepEqual(ids(base({ appsUpdatedAt: 900 })), ['warning:preview']);
  assert.deepEqual(ids(base({ variants: [variant({ protocolUpdatedAt: 900 })] })), ['warning:preview']);
});

test('report puts errors first', () => {
  const r = readinessReport(readinessItems(base({ lastPreviewAt: 0, hasActiveLink: false })));
  assert.deepEqual(r.items.map((i) => i.level), ['error', 'warning']);
  assert.equal(r.canPublish, false);
});

test('not-found markers', () => {
  assert.match(notFoundMarker('<div>Unmatched Route</div><p>Page could not be found.</p>') ?? '', /Expo/);
  assert.match(notFoundMarker('<h2>This page could not be found.</h2>') ?? '', /Next/);
  assert.ok(notFoundMarker('<title>404 – Missing</title>'));
  assert.equal(notFoundMarker('<title>Mentor Tracker</title><p>We have 404 members</p>'), undefined);
});
