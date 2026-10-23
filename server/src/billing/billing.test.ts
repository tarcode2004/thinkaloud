// Billing: plan config, usage calculation, idempotency, webhook state transitions, enforcement
// and the meter-event reporter. No real Stripe calls (the SDK client is a mock; webhooks are
// signed locally with generateTestHeaderString) and no OpenAI (the realtime mint goes to a stub).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import Stripe from 'stripe';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-billing-test-'));
process.env.DATA_DIR = dataDir;
process.env.OPENAI_API_KEY = ''; // never call OpenAI from unit tests
process.env.STRIPE_SECRET_KEY = 'sk_test_unit_mock';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_unit_test';
process.env.PUBLIC_URL = 'https://app.example.test';
process.env.BILLING_REPORTER = 'off';
const PLANS = {
  currency: 'usd',
  plans: [
    { id: 'starter', name: 'Starter', monthlyPriceCents: 4900, includedMinutes: 10, overageCentsPerMinute: 25, trialDays: 14, trialMinutes: 3, stripeBasePriceId: 'price_base_s', stripeMeteredPriceId: 'price_meter_s' },
    { id: 'team', name: 'Team', monthlyPriceCents: 19900, includedMinutes: 100, overageCentsPerMinute: 12.5, trialDays: 0 },
  ],
};
process.env.BILLING_PLANS = JSON.stringify(PLANS);
process.env.STRIPE_PRICE_TEAM_BASE = 'price_base_t';
process.env.STRIPE_PRICE_TEAM_METERED = 'price_meter_t';

// Stub realtime mint endpoint (stands in for OpenAI / OpenRealtime).
const realtimeStub = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ value: 'ek_stub', expires_at: 9_999_999_999 }));
  });
});

let api: http.Server;
let base = '';
let db: typeof import('../db.ts').db;
let cfg: typeof import('./config.ts');
let account: typeof import('./account.ts');
let usage: typeof import('./usage.ts');
let reporter: typeof import('./reporter.ts');
let setStripeClient: typeof import('./stripe.ts').setStripeClient;

// ── Stripe mock ──────────────────────────────────────────────────────────────
const calls: { method: string; args: unknown[] }[] = [];
const subs = new Map<string, unknown>();
let meterFailures = 0;
const mockStripe = {
  customers: { create: async (...args: unknown[]) => (calls.push({ method: 'customers.create', args }), { id: 'cus_owner' }) },
  checkout: { sessions: { create: async (...args: unknown[]) => (calls.push({ method: 'checkout.sessions.create', args }), { id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' }) } },
  billingPortal: { sessions: { create: async (...args: unknown[]) => (calls.push({ method: 'billingPortal.sessions.create', args }), { url: 'https://billing.stripe.test/p_1' }) } },
  subscriptions: {
    retrieve: async (id: string) => (calls.push({ method: 'subscriptions.retrieve', args: [id] }), subs.get(id)),
    update: async (...args: unknown[]) => (calls.push({ method: 'subscriptions.update', args }), {}),
  },
  billing: {
    meterEvents: {
      create: async (...args: unknown[]) => {
        calls.push({ method: 'billing.meterEvents.create', args });
        if (meterFailures > 0) {
          meterFailures--;
          throw new Error('Stripe is having a moment');
        }
        return { object: 'billing.meter_event' };
      },
    },
  },
};

function listen(app: http.RequestListener | http.Server): Promise<http.Server> {
  return new Promise((resolve) => {
    const s = app instanceof http.Server ? app : http.createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

before(async () => {
  await listen(realtimeStub);
  process.env.REALTIME_BASE_URL = `http://127.0.0.1:${(realtimeStub.address() as AddressInfo).port}/v1`;
  const { createApp } = await import('../app.ts');
  ({ db } = await import('../db.ts'));
  cfg = await import('./config.ts');
  account = await import('./account.ts');
  usage = await import('./usage.ts');
  reporter = await import('./reporter.ts');
  ({ setStripeClient } = await import('./stripe.ts'));
  setStripeClient(mockStripe);
  api = await listen(createApp());
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});
after(() => {
  api?.close();
  realtimeStub.close();
  setStripeClient(null);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function client() {
  let cookie = '';
  return async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json };
  };
}

let eventSeq = 0;
async function sendEvent(type: string, object: unknown, opts: { id?: string; created?: number; signature?: string } = {}) {
  const event = { id: opts.id ?? `evt_${++eventSeq}`, object: 'event', type, created: opts.created ?? Math.floor(Date.now() / 1000) + eventSeq, data: { object } };
  const payload = JSON.stringify(event);
  const signature = opts.signature ?? Stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET! });
  const res = await fetch(`${base}/api/billing/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature }, body: payload });
  return { status: res.status, json: await res.json().catch(() => null), event };
}

const now = () => Math.floor(Date.now() / 1000);
function subscription(userId: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'sub_1', object: 'subscription', customer: 'cus_owner', status, metadata: { user_id: userId, plan: 'starter' },
    cancel_at_period_end: false, trial_end: status === 'trialing' ? now() + 14 * 86400 : null,
    items: { data: [{ price: { id: 'price_base_s' }, current_period_start: now() - 3600, current_period_end: now() + 30 * 86400 }, { price: { id: 'price_meter_s' }, current_period_start: now() - 3600, current_period_end: now() + 30 * 86400 }] },
    ...extra,
  };
}

const device = { userAgent: 'test', viewportW: 1, viewportH: 1, screenW: 1, screenH: 1, dpr: 1, timezone: 'UTC', language: 'en' };
const consent = { version: '1', acceptedAt: Date.now(), audio: true, screen: true, eyeTracking: false, ageConfirmed: true };

// ── pure units ───────────────────────────────────────────────────────────────

test('plan config: validates, applies defaults, reads price IDs from env, hides them publicly', () => {
  const p = cfg.parsePlans(PLANS, { STRIPE_PRICE_TEAM_BASE: 'pb', STRIPE_PRICE_TEAM_METERED: 'pm' } as NodeJS.ProcessEnv);
  assert.equal(p.currency, 'usd');
  assert.equal(p.plans[0].stripeBasePriceId, 'price_base_s');
  assert.equal(p.plans[1].stripeBasePriceId, 'pb');
  assert.equal(p.plans[1].trialMinutes, null);
  assert.deepEqual(p.plans[1].features, []);
  const pub = cfg.publicPlan(p.plans[0]) as unknown as Record<string, unknown>;
  assert.equal(pub.stripeBasePriceId, undefined);
  assert.equal(pub.stripeMeteredPriceId, undefined);
  assert.throws(() => cfg.parsePlans({ plans: [PLANS.plans[0], PLANS.plans[0]] }), /Duplicate/);
  assert.throws(() => cfg.parsePlans({ plans: [] }));
  assert.throws(() => cfg.parsePlans({ plans: [{ ...PLANS.plans[0], monthlyPriceCents: -1 }] }));
  assert.throws(() => cfg.parsePlans({ plans: [{ ...PLANS.plans[0], id: 'Bad Id' }] }));
  // The shipped placeholder file is valid and marked as placeholder.
  const shipped = cfg.parsePlans(JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../../config/billing-plans.json'), 'utf8')), {} as NodeJS.ProcessEnv);
  assert.equal(shipped.placeholder, true);
  assert.ok(shipped.plans.length >= 1);
});

test('billing is off without STRIPE_SECRET_KEY', async () => {
  const key = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  try {
    assert.equal(cfg.billingEnabled(), false);
    assert.deepEqual(account.entitlement('anyone'), { canRunSessions: true, blockReason: null });
    const r = await client()('GET', '/api/billing/plans');
    assert.deepEqual(r.json, { enabled: false, plans: [] });
    assert.equal((await sendEvent('invoice.paid', {})).status, 404);
  } finally {
    process.env.STRIPE_SECRET_KEY = key;
  }
});

test('voice minutes: rounded up per session, at least 1, capped', () => {
  assert.equal(usage.voiceMinutes(0, 1, 120), 1);
  assert.equal(usage.voiceMinutes(0, 60_000, 120), 1);
  assert.equal(usage.voiceMinutes(0, 60_001, 120), 2);
  assert.equal(usage.voiceMinutes(0, 5.5 * 60_000, 120), 6);
  assert.equal(usage.voiceMinutes(0, 10 * 3_600_000, 120), 120);
  assert.equal(usage.voiceMinutes(10, 0, 120), 1); // clock oddities never go negative
});

test('cost estimate: included minutes, overage, trials are free', () => {
  const plan = { monthlyPriceCents: 4900, includedMinutes: 10, overageCentsPerMinute: 12.5 };
  assert.deepEqual(account.estimateCost(plan, 4, false), { includedMinutes: 10, overageMinutes: 0, estimatedOverageCents: 0, estimatedTotalCents: 4900 });
  assert.deepEqual(account.estimateCost(plan, 13, false), { includedMinutes: 10, overageMinutes: 3, estimatedOverageCents: 38, estimatedTotalCents: 4938 });
  assert.equal(account.estimateCost(plan, 500, true).estimatedTotalCents, 0);
  assert.equal(account.estimateCost(null, 5, false).estimatedTotalCents, 0);
});

test('entitlement decisions cover every status, the grace period and the spend cap', () => {
  const t = Date.now();
  const acc = (status: string, extra: Record<string, unknown> = {}) => ({ status, past_due_since: null, spend_cap_cents: null, ...extra }) as never;
  const u = (extra: Record<string, unknown> = {}) => ({ estimatedTotalCents: 4900, trialMinutes: null, trialMinutesUsed: null, ...extra }) as never;
  assert.equal(account.decide(null, null, t), 'no_subscription');
  assert.equal(account.decide(acc('none'), null, t), 'no_subscription');
  assert.equal(account.decide(acc('active'), u(), t), null);
  assert.equal(account.decide(acc('trialing'), u({ trialMinutes: 3, trialMinutesUsed: 2 }), t), null);
  assert.equal(account.decide(acc('trialing'), u({ trialMinutes: 3, trialMinutesUsed: 3 }), t), 'trial_minutes_used');
  assert.equal(account.decide(acc('past_due', { past_due_since: t - 864e5 }), u(), t), null);
  assert.equal(account.decide(acc('past_due', { past_due_since: t - 4 * 864e5 }), u(), t), 'payment_failed');
  assert.equal(account.decide(acc('unpaid'), u(), t), 'payment_failed');
  assert.equal(account.decide(acc('canceled'), u(), t), 'canceled');
  assert.equal(account.decide(acc('incomplete'), u(), t), 'incomplete');
  assert.equal(account.decide(acc('active', { spend_cap_cents: 4900 }), u(), t), 'spend_cap');
  assert.equal(account.decide(acc('active', { spend_cap_cents: 5000 }), u(), t), null);
  assert.equal(account.decide(acc('trialing', { spend_cap_cents: 1 }), u({ estimatedTotalCents: 0 }), t), null);
});

test('reporter backoff grows and is capped', () => {
  assert.equal(reporter.backoffMs(1), 30_000);
  assert.equal(reporter.backoffMs(2), 60_000);
  assert.equal(reporter.backoffMs(20), 3_600_000);
});

// ── end to end over HTTP ─────────────────────────────────────────────────────

const owner = client();
let userId = '';
let studyId = '';
let token = '';

async function startSession(preview = false) {
  const who = preview ? owner : client();
  const s = await who('POST', `/api/p/links/${token}/sessions`, { urlParams: {}, device, consent, ...(preview ? { preview: true } : {}) });
  return { ...s, who };
}

async function voiceSession(minutesAgo = 0) {
  const s = await startSession();
  assert.equal(s.status, 201, JSON.stringify(s.json));
  const h = { 'X-Session-Secret': s.json.secret };
  const t = await s.who('POST', `/api/p/sessions/${s.json.session.id}/realtime-token`, {}, h);
  assert.equal(t.status, 200, JSON.stringify(t.json));
  if (minutesAgo) db.prepare('UPDATE sessions SET voice_started_at = ? WHERE id = ?').run(Date.now() - minutesAgo * 60_000, s.json.session.id);
  return { id: s.json.session.id as string, h, who: s.who };
}

const usageRows = () => db.prepare('SELECT * FROM usage_events ORDER BY at').all() as any[];

test('without a plan: build and preview work; publishing and participant sessions are blocked', async () => {
  const su = await owner('POST', '/api/auth/signup', { email: 'owner@example.com', password: 'password123', name: 'Owner' });
  userId = su.json.user.id;
  studyId = (await owner('POST', '/api/studies', { name: 'Gift shop study', template: 'starter' })).json.study.id;
  const detail = (await owner('GET', `/api/studies/${studyId}`)).json;
  token = detail.links[0].token;

  const ov = (await owner('GET', '/api/billing')).json;
  assert.equal(ov.enabled, true);
  assert.equal(ov.status, 'none');
  assert.equal(ov.canRunSessions, false);
  assert.equal(ov.trialAvailable, true);

  const live = await owner('PATCH', `/api/studies/${studyId}`, { status: 'live' });
  assert.equal(live.status, 402);
  assert.equal(live.json.details.billing, true);

  // Preview by the owner is free and allowed.
  const pv = await startSession(true);
  assert.equal(pv.status, 201, JSON.stringify(pv.json));
  const tok = await owner('POST', `/api/p/sessions/${pv.json.session.id}/realtime-token`, {}, { 'X-Session-Secret': pv.json.secret });
  assert.equal(tok.status, 200);
  await owner('POST', `/api/p/sessions/${pv.json.session.id}/complete`, { status: 'completed' }, { 'X-Session-Secret': pv.json.secret });
  assert.equal(usageRows().length, 0, 'previews are never billed');

  // Force the study live (as if the plan lapsed later): participants get the neutral message only.
  db.prepare("UPDATE studies SET status = 'live' WHERE id = ?").run(studyId);
  const info = (await client()('GET', `/api/p/links/${token}`)).json;
  assert.equal(info.available, false);
  assert.equal(info.unavailableReason, 'unavailable');
  const start = await startSession();
  assert.equal(start.status, 409);
  assert.equal(start.json.error, 'This study isn’t accepting participants right now.');
  assert.doesNotMatch(JSON.stringify(start.json) + JSON.stringify({ ...info, consent: null }), /billing|plan|subscri|payment|stripe/i);
  db.prepare("UPDATE studies SET status = 'draft' WHERE id = ?").run(studyId);
});

test('checkout: creates the customer once, licensed + metered prices, trial, front-end return URLs', async () => {
  assert.equal((await owner('POST', '/api/billing/checkout', { planId: 'nope' })).status, 400);
  const r = await owner('POST', '/api/billing/checkout', { planId: 'starter' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.url, 'https://checkout.stripe.test/cs_1');
  const create = calls.find((c) => c.method === 'checkout.sessions.create')!.args[0] as any;
  assert.equal(create.mode, 'subscription');
  assert.equal(create.customer, 'cus_owner');
  assert.equal(create.client_reference_id, userId);
  assert.deepEqual(create.line_items, [{ price: 'price_base_s', quantity: 1 }, { price: 'price_meter_s' }]);
  assert.equal(create.subscription_data.trial_period_days, 14);
  assert.equal(create.subscription_data.metadata.user_id, userId);
  assert.match(create.success_url, /^https:\/\/app\.example\.test\/billing\?checkout=success/);
  assert.match(create.cancel_url, /^https:\/\/app\.example\.test\/billing/);
  const cust = calls.find((c) => c.method === 'customers.create')!;
  assert.deepEqual(cust.args[1], { idempotencyKey: `customer-${userId}` });
  await owner('POST', '/api/billing/checkout', { planId: 'starter' });
  assert.equal(calls.filter((c) => c.method === 'customers.create').length, 1, 'customer is reused');
});

test('webhook: signature is verified on the raw body', async () => {
  const bad = await sendEvent('invoice.paid', {}, { signature: 't=1,v1=deadbeef' });
  assert.equal(bad.status, 400);
  const res = await fetch(`${base}/api/billing/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 400, 'missing signature');
  // A valid signature over different bytes (re-serialised JSON) must fail.
  const payload = JSON.stringify({ id: 'evt_x', type: 'invoice.paid', data: { object: {} } });
  const sig = Stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET! });
  const tampered = await fetch(`${base}/api/billing/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': sig }, body: payload.replace('{}', '{ }') });
  assert.equal(tampered.status, 400);
});

test('checkout.session.completed activates a trial; events are applied once; stale events are ignored', async () => {
  subs.set('sub_1', subscription(userId, 'trialing'));
  const done = await sendEvent('checkout.session.completed', { id: 'cs_1', object: 'checkout.session', mode: 'subscription', client_reference_id: userId, customer: 'cus_owner', subscription: 'sub_1', metadata: {} }, { id: 'evt_checkout' });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(done.json.result, 'processed');
  let ov = (await owner('GET', '/api/billing')).json;
  assert.equal(ov.status, 'trialing');
  assert.equal(ov.plan.id, 'starter');
  assert.equal(ov.canRunSessions, true);
  assert.equal(ov.trialAvailable, false);
  assert.ok(ov.trialEnd > Date.now());

  const again = await sendEvent('checkout.session.completed', {}, { id: 'evt_checkout' });
  assert.equal(again.json.result, 'duplicate');
  assert.equal(calls.filter((c) => c.method === 'subscriptions.retrieve').length, 1);

  // An old "canceled" delivery arriving late must not roll the account back.
  const stale = await sendEvent('customer.subscription.updated', subscription(userId, 'canceled'), { created: now() - 86400 });
  assert.equal(stale.status, 200);
  ov = (await owner('GET', '/api/billing')).json;
  assert.equal(ov.status, 'trialing');
  // Checkout again while subscribed is refused.
  assert.equal((await owner('POST', '/api/billing/checkout', { planId: 'starter' })).status, 409);
});

test('trial usage is recorded once per session, not sent to Stripe, and trial minutes are enforced', async () => {
  assert.equal((await owner('PATCH', `/api/studies/${studyId}`, { status: 'live' })).status, 200);
  const s = await voiceSession(1.5);
  const c1 = await s.who('POST', `/api/p/sessions/${s.id}/complete`, { status: 'completed' }, s.h);
  assert.equal(c1.status, 200);
  await s.who('POST', `/api/p/sessions/${s.id}/complete`, { status: 'completed' }, s.h);
  assert.equal(usage.recordSessionUsage(s.id), null, 'second record is a no-op');
  let rows = usageRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].quantity, 2);
  assert.equal(rows[0].skipped, 'trial');
  assert.equal(rows[0].user_id, userId);
  const r = await reporter.reportPendingUsage();
  assert.equal(r.sent, 0);

  // 2 of 3 trial minutes used; one more 1-minute session reaches the allowance.
  const s2 = await voiceSession();
  await s2.who('POST', `/api/p/sessions/${s2.id}/complete`, { status: 'abandoned' }, s2.h);
  rows = usageRows();
  assert.equal(rows.length, 2, 'abandoned sessions with voice are billed');
  const ov = (await owner('GET', '/api/billing')).json;
  assert.equal(ov.usage.trialMinutesUsed, 3);
  assert.equal(ov.blockReason, 'trial_minutes_used');
  assert.equal((await startSession()).status, 409);

  // End trial early.
  assert.equal((await owner('POST', '/api/billing/end-trial')).status, 200);
  assert.deepEqual(calls.find((c) => c.method === 'subscriptions.update')!.args, ['sub_1', { trial_end: 'now' }]);
});

test('active subscription: usage is billable and the reporter retries with the usage id as idempotency key', async () => {
  const upd = await sendEvent('customer.subscription.updated', subscription(userId, 'active'));
  assert.equal(upd.status, 200);
  assert.equal((await owner('GET', '/api/billing')).json.status, 'active');

  const s = await voiceSession(4.2);
  await s.who('POST', `/api/p/sessions/${s.id}/complete`, { status: 'completed' }, s.h);
  const row = usageRows().find((u) => u.session_id === s.id);
  assert.equal(row.quantity, 5);
  assert.equal(row.skipped, null);

  meterFailures = 1;
  const t0 = Date.now();
  const first = await reporter.reportPendingUsage(t0);
  assert.deepEqual(first, { sent: 0, failed: 1, skipped: 0 });
  let r = db.prepare('SELECT * FROM usage_events WHERE id = ?').get(row.id) as any;
  assert.equal(r.attempts, 1);
  assert.equal(r.reported_at, null);
  assert.ok(r.next_attempt_at > t0);
  assert.match(r.last_error, /moment/);
  assert.deepEqual(await reporter.reportPendingUsage(t0 + 1000), { sent: 0, failed: 0, skipped: 0 }, 'waits for the backoff');
  const second = await reporter.reportPendingUsage(t0 + 31_000);
  assert.equal(second.sent, 1);
  r = db.prepare('SELECT * FROM usage_events WHERE id = ?').get(row.id) as any;
  assert.ok(r.reported_at);
  const sends = calls.filter((c) => c.method === 'billing.meterEvents.create');
  assert.equal(sends.length, 2);
  for (const c of sends) {
    const [params, opts] = c.args as any[];
    assert.equal(params.identifier, row.id);
    assert.equal(params.event_name, 'thinkaloud_voice_minutes');
    assert.deepEqual(params.payload, { stripe_customer_id: 'cus_owner', value: '5' });
    assert.equal(params.timestamp, Math.floor(row.at / 1000));
    assert.deepEqual(opts, { idempotencyKey: `usage-${row.id}` });
  }
  assert.equal((await reporter.reportPendingUsage(t0 + 10 * 3_600_000)).sent, 0, 'never re-sent');

  const ov = (await owner('GET', '/api/billing')).json;
  assert.equal(ov.usage.minutesUsed, 5, 'trial minutes are not counted in the paid period');
  assert.equal(ov.usage.includedMinutes, 10);
  assert.equal(ov.usage.estimatedTotalCents, 4900);
});

test('sessions that used voice and went quiet are billed by the sweeper', async () => {
  const s = await voiceSession();
  const past = Date.now() - 45 * 60_000;
  db.prepare('UPDATE sessions SET voice_started_at = ?, voice_last_seen_at = ? WHERE id = ?').run(past - 7 * 60_000, past, s.id);
  assert.equal(usage.sweepUnbilledSessions(), 1);
  assert.equal(usage.sweepUnbilledSessions(), 0);
  const row = usageRows().find((u) => u.session_id === s.id);
  assert.equal(row.quantity, 7);
  assert.equal(row.at, past);
  // A session without voice is never billed.
  const quiet = await startSession();
  db.prepare('UPDATE sessions SET created_at = ? WHERE id = ?').run(past, quiet.json.session.id);
  assert.equal(usage.sweepUnbilledSessions(), 0);
});

test('payment failure: grace period, then blocked; invoice.paid restores', async () => {
  const fail = await sendEvent('invoice.payment_failed', { id: 'in_1', object: 'invoice', customer: 'cus_owner', parent: { subscription_details: { subscription: 'sub_1' } } });
  assert.equal(fail.status, 200);
  let ov = (await owner('GET', '/api/billing')).json;
  assert.equal(ov.status, 'past_due');
  assert.equal(ov.canRunSessions, true, 'within the grace period');
  assert.ok(ov.graceEndsAt > Date.now());
  // An invoice from some other subscription is ignored.
  await sendEvent('invoice.paid', { id: 'in_2', object: 'invoice', customer: 'cus_owner', parent: { subscription_details: { subscription: 'sub_old' } } });
  assert.equal((await owner('GET', '/api/billing')).json.status, 'past_due');

  db.prepare('UPDATE billing_accounts SET past_due_since = ? WHERE user_id = ?').run(Date.now() - 4 * 864e5, userId);
  ov = (await owner('GET', '/api/billing')).json;
  assert.equal(ov.blockReason, 'payment_failed');
  assert.equal((await client()('GET', `/api/p/links/${token}`)).json.unavailableReason, 'unavailable');

  await sendEvent('invoice.paid', { id: 'in_1', object: 'invoice', customer: 'cus_owner', parent: { subscription_details: { subscription: 'sub_1' } } });
  ov = (await owner('GET', '/api/billing')).json;
  assert.equal(ov.status, 'active');
  assert.equal(ov.graceEndsAt, null);
  assert.equal(ov.canRunSessions, true);
});

test('spend cap: validated, blocks new sessions, and a running session is not cut off', async () => {
  const running = await voiceSession();
  assert.equal((await owner('PATCH', '/api/billing/settings', { spendCapCents: 100 })).status, 400);
  const set = await owner('PATCH', '/api/billing/settings', { spendCapCents: 4900 });
  assert.equal(set.status, 200);
  assert.equal(set.json.blockReason, 'spend_cap');
  assert.equal((await startSession()).status, 409);
  // Reconnect of a session whose voice already started still works.
  assert.equal((await running.who('POST', `/api/p/sessions/${running.id}/realtime-token`, {}, running.h)).status, 200);
  assert.equal((await owner('PATCH', '/api/billing/settings', { spendCapCents: null })).json.canRunSessions, true);
});

test('portal and cancellation', async () => {
  const p = await owner('POST', '/api/billing/portal');
  assert.equal(p.json.url, 'https://billing.stripe.test/p_1');
  assert.deepEqual(calls.find((c) => c.method === 'billingPortal.sessions.create')!.args[0], { customer: 'cus_owner', return_url: 'https://app.example.test/billing' });
  const del = await sendEvent('customer.subscription.deleted', subscription(userId, 'active'));
  assert.equal(del.status, 200);
  const ov = (await owner('GET', '/api/billing')).json;
  assert.equal(ov.status, 'canceled');
  assert.equal(ov.blockReason, 'canceled');
  assert.equal((await owner('PATCH', `/api/studies/${studyId}`, { status: 'paused' })).status, 200);
  assert.equal((await owner('PATCH', `/api/studies/${studyId}`, { status: 'live' })).status, 402);
});

test('accounts are isolated: another researcher sees only their own billing', async () => {
  const other = client();
  await other('POST', '/api/auth/signup', { email: 'other@example.com', password: 'password123', name: 'Other' });
  const ov = (await other('GET', '/api/billing')).json;
  assert.equal(ov.status, 'none');
  assert.equal(ov.hasCustomer, false);
  assert.equal(ov.usage, null);
  assert.equal((await other('POST', '/api/billing/portal')).status, 400);
  assert.equal((await other('POST', '/api/billing/end-trial')).status, 400);
  await other('PATCH', '/api/billing/settings', { spendCapCents: 99999 });
  assert.notEqual(account.getAccount(userId)!.spend_cap_cents, 99999);
});
