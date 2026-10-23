// Billing accounts, usage totals and entitlement (may this researcher run real sessions?).
import type { BillingBlockReason, BillingOverview, BillingStatus, BillingUsage } from '@thinkaloud/shared';
import { db } from '../db.ts';
import { billingEnabled, billingSettings, findPlan, publicPlan, type ServerPlan } from './config.ts';

export const VOICE_MINUTES = 'voice_minutes';
const DAY = 864e5;

export interface AccountRow {
  user_id: string;
  stripe_customer_id: string | null;
  subscription_id: string | null;
  plan: string;
  status: BillingStatus;
  current_period_start: number | null;
  current_period_end: number | null;
  trial_end: number | null;
  cancel_at_period_end: number;
  past_due_since: number | null;
  spend_cap_cents: number | null;
  had_subscription: number;
  last_event_at: number | null;
  updated_at: number;
}

export function getAccount(userId: string): AccountRow | null {
  return (db.prepare('SELECT * FROM billing_accounts WHERE user_id = ?').get(userId) as AccountRow | undefined) ?? null;
}

export function getAccountByCustomer(customerId: string): AccountRow | null {
  return (db.prepare('SELECT * FROM billing_accounts WHERE stripe_customer_id = ?').get(customerId) as AccountRow | undefined) ?? null;
}

export function ensureAccount(userId: string): AccountRow {
  db.prepare('INSERT OR IGNORE INTO billing_accounts (user_id, updated_at) VALUES (?, ?)').run(userId, Date.now());
  return getAccount(userId)!;
}

type Patch = Partial<Omit<AccountRow, 'user_id' | 'updated_at'>>;
const COLUMNS = new Set([
  'stripe_customer_id', 'subscription_id', 'plan', 'status', 'current_period_start', 'current_period_end', 'trial_end',
  'cancel_at_period_end', 'past_due_since', 'spend_cap_cents', 'had_subscription', 'last_event_at',
]);

export function updateAccount(userId: string, patch: Patch) {
  ensureAccount(userId);
  const keys = Object.keys(patch).filter((k) => COLUMNS.has(k) && (patch as Record<string, unknown>)[k] !== undefined);
  if (!keys.length) return;
  const sql = `UPDATE billing_accounts SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE user_id = ?`;
  db.prepare(sql).run(...keys.map((k) => (patch as Record<string, string | number | null>)[k]), Date.now(), userId);
}

// ── usage ────────────────────────────────────────────────────────────────────

/** The usage window: the Stripe billing period when known and current, else the calendar month (UTC). */
export function usagePeriod(acc: AccountRow | null, now: number): { start: number; end: number | null } {
  if (acc?.current_period_start && (!acc.current_period_end || now < acc.current_period_end)) {
    return { start: acc.current_period_start, end: acc.current_period_end };
  }
  const d = new Date(now);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return { start, end };
}

/** Pure cost estimate for a period. Trial periods cost nothing. */
export function estimateCost(plan: Pick<ServerPlan, 'monthlyPriceCents' | 'includedMinutes' | 'overageCentsPerMinute'> | null, minutesUsed: number, trialing: boolean) {
  if (!plan) return { includedMinutes: 0, overageMinutes: 0, estimatedOverageCents: 0, estimatedTotalCents: 0 };
  if (trialing) return { includedMinutes: plan.includedMinutes, overageMinutes: 0, estimatedOverageCents: 0, estimatedTotalCents: 0 };
  const overageMinutes = Math.max(0, minutesUsed - plan.includedMinutes);
  const estimatedOverageCents = Math.round(overageMinutes * plan.overageCentsPerMinute);
  return { includedMinutes: plan.includedMinutes, overageMinutes, estimatedOverageCents, estimatedTotalCents: plan.monthlyPriceCents + estimatedOverageCents };
}

function sumMinutes(where: string, ...args: (string | number)[]) {
  const r = db.prepare(`SELECT COALESCE(SUM(quantity), 0) AS m, COUNT(*) AS n FROM usage_events WHERE kind = '${VOICE_MINUTES}' AND ${where}`).get(...args) as { m: number; n: number };
  return { minutes: Number(r.m), count: Number(r.n) };
}

export function usageFor(userId: string, acc: AccountRow | null, now = Date.now()): BillingUsage {
  const plan = findPlan(acc?.plan);
  const { start, end } = usagePeriod(acc, now);
  const trialing = acc?.status === 'trialing';
  const period = sumMinutes(`user_id = ? AND at >= ? AND at < ? AND (skipped IS NULL OR skipped != 'trial')`, userId, start, end ?? Number.MAX_SAFE_INTEGER);
  const trial = sumMinutes(`user_id = ? AND skipped = 'trial'`, userId);
  const minutesUsed = trialing ? trial.minutes : period.minutes;
  return {
    periodStart: start,
    periodEnd: end,
    minutesUsed,
    ...estimateCost(plan, minutesUsed, trialing),
    trialMinutesUsed: trialing ? trial.minutes : null,
    trialMinutes: trialing ? (plan?.trialMinutes ?? null) : null,
    sessionCount: trialing ? trial.count : period.count,
  };
}

// ── entitlement ──────────────────────────────────────────────────────────────

export function graceEndsAt(acc: AccountRow | null): number | null {
  if (!acc || acc.status !== 'past_due' || !acc.past_due_since) return null;
  return acc.past_due_since + billingSettings().graceDays * DAY;
}

/** Pure decision, given an account and its usage. */
export function decide(acc: AccountRow | null, usage: BillingUsage | null, now: number): BillingBlockReason {
  if (!acc) return 'no_subscription';
  switch (acc.status) {
    case 'none':
      return 'no_subscription';
    case 'canceled':
    case 'paused':
      return 'canceled';
    case 'incomplete':
      return 'incomplete';
    case 'unpaid':
      return 'payment_failed';
    case 'past_due': {
      const ends = graceEndsAt(acc);
      if (ends != null && now >= ends) return 'payment_failed';
      break;
    }
    case 'trialing':
      if (usage?.trialMinutes != null && (usage.trialMinutesUsed ?? 0) >= usage.trialMinutes) return 'trial_minutes_used';
      return null; // the spend cap doesn't apply: trials are free
    case 'active':
      break;
    default:
      return 'no_subscription';
  }
  if (acc.spend_cap_cents != null && usage && usage.estimatedTotalCents >= acc.spend_cap_cents) return 'spend_cap';
  return null;
}

export function entitlement(userId: string, now = Date.now()): { canRunSessions: boolean; blockReason: BillingBlockReason } {
  if (!billingEnabled()) return { canRunSessions: true, blockReason: null };
  const acc = getAccount(userId);
  const usage = acc ? usageFor(userId, acc, now) : null;
  const blockReason = decide(acc, usage, now);
  return { canRunSessions: blockReason === null, blockReason };
}

export function overview(userId: string, now = Date.now()): BillingOverview {
  if (!billingEnabled()) {
    return {
      enabled: false, plan: null, status: 'none', hasCustomer: false, currentPeriodEnd: null, trialEnd: null, cancelAtPeriodEnd: false,
      graceEndsAt: null, spendCapCents: null, trialAvailable: false, usage: null, canRunSessions: true, blockReason: null,
    };
  }
  const acc = getAccount(userId);
  const plan = findPlan(acc?.plan);
  const usage = acc && acc.status !== 'none' ? usageFor(userId, acc, now) : null;
  const blockReason = decide(acc, usage, now);
  return {
    enabled: true,
    plan: plan ? publicPlan(plan) : null,
    status: acc?.status ?? 'none',
    hasCustomer: Boolean(acc?.stripe_customer_id),
    currentPeriodEnd: acc?.current_period_end ?? null,
    trialEnd: acc?.trial_end ?? null,
    cancelAtPeriodEnd: Boolean(acc?.cancel_at_period_end),
    graceEndsAt: graceEndsAt(acc),
    spendCapCents: acc?.spend_cap_cents ?? null,
    trialAvailable: !acc?.had_subscription,
    usage,
    canRunSessions: blockReason === null,
    blockReason,
  };
}
