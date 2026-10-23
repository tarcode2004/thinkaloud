// Billing configuration. Billing (SaaS mode) is OFF unless STRIPE_SECRET_KEY is set, so
// self-hosted installs run with no limits. Everything is read from the environment at call
// time (not import time) so tests can switch billing on and off within one process.
//
// Plans come from a JSON file (BILLING_PLANS_FILE, default config/billing-plans.json) or an
// inline JSON string (BILLING_PLANS). Prices are never hard-coded here.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { BillingPlan } from '@thinkaloud/shared';
import { repoRoot } from '../lib/paths.ts';

const env = () => process.env;

/** Stripe webhook events the server handles (subscribe the endpoint to exactly these). */
export const HANDLED_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
] as const;


export function billingEnabled(): boolean {
  return Boolean(env().STRIPE_SECRET_KEY);
}

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : fallback;
};

export function billingSettings() {
  const e = env();
  return {
    secretKey: e.STRIPE_SECRET_KEY || '',
    webhookSecret: e.STRIPE_WEBHOOK_SECRET || '',
    /** Must match the `event_name` of the Stripe Billing Meter. */
    meterEventName: e.STRIPE_METER_EVENT_NAME || 'thinkaloud_voice_minutes',
    /** Days a past_due account keeps running sessions before it is blocked. */
    graceDays: num(e.BILLING_GRACE_DAYS, 3),
    /** One session never bills more than this many minutes (guards against stuck sessions). */
    maxSessionMinutes: num(e.BILLING_MAX_SESSION_MINUTES, 120),
    /** A session with voice and no activity for this long is treated as abandoned and billed. */
    abandonAfterMinutes: num(e.BILLING_ABANDON_AFTER_MINUTES, 30),
    /** Background usage reporter interval; 0 disables it (e.g. in tests). */
    reportIntervalMs: e.BILLING_REPORTER === 'off' ? 0 : num(e.BILLING_REPORT_INTERVAL_MS, 60_000),
  };
}

const PlanSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,40}$/, 'plan id: lowercase letters, digits, - and _'),
  name: z.string().min(1).max(60),
  description: z.string().max(300).default(''),
  monthlyPriceCents: z.number().int().min(0),
  includedMinutes: z.number().int().min(0),
  overageCentsPerMinute: z.number().min(0),
  trialDays: z.number().int().min(0).max(730).default(0),
  trialMinutes: z.number().int().min(0).nullable().default(null),
  features: z.array(z.string().max(120)).max(12).default([]),
  stripeBasePriceId: z.string().optional(),
  stripeMeteredPriceId: z.string().optional(),
});
const PlansFileSchema = z.object({
  placeholder: z.boolean().optional(),
  currency: z.string().length(3).default('usd'),
  plans: z.array(PlanSchema).min(1),
});

export interface ServerPlan extends BillingPlan {
  /** Licensed (flat monthly) Stripe price. */
  stripeBasePriceId: string;
  /** Metered price attached to the voice-minutes meter (graduated: first N minutes free). */
  stripeMeteredPriceId: string;
}

export interface PlansConfig {
  placeholder: boolean;
  currency: string;
  plans: ServerPlan[];
}

/** Parse + validate a plans document. Price IDs fall back to STRIPE_PRICE_<ID>_BASE / _METERED. */
export function parsePlans(raw: unknown, e: NodeJS.ProcessEnv = env()): PlansConfig {
  const doc = PlansFileSchema.parse(raw);
  const ids = new Set<string>();
  const plans = doc.plans.map((p): ServerPlan => {
    if (ids.has(p.id)) throw new Error(`Duplicate billing plan id "${p.id}"`);
    ids.add(p.id);
    const key = p.id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      currency: doc.currency.toLowerCase(),
      monthlyPriceCents: p.monthlyPriceCents,
      includedMinutes: p.includedMinutes,
      overageCentsPerMinute: p.overageCentsPerMinute,
      trialDays: p.trialDays,
      trialMinutes: p.trialMinutes,
      features: p.features,
      stripeBasePriceId: e[`STRIPE_PRICE_${key}_BASE`] || p.stripeBasePriceId || '',
      stripeMeteredPriceId: e[`STRIPE_PRICE_${key}_METERED`] || p.stripeMeteredPriceId || '',
    };
  });
  return { placeholder: Boolean(doc.placeholder), currency: doc.currency.toLowerCase(), plans };
}

let cache: { key: string; value: PlansConfig } | null = null;

/** The configured plans (cached per source). Throws on an invalid file so misconfiguration is loud. */
export function loadPlans(): PlansConfig {
  const e = env();
  const inline = e.BILLING_PLANS?.trim();
  const file = path.resolve(repoRoot, e.BILLING_PLANS_FILE || 'config/billing-plans.json');
  const priceEnv = Object.keys(e).filter((k) => k.startsWith('STRIPE_PRICE_')).sort().map((k) => `${k}=${e[k]}`).join(';');
  let key: string;
  let text: string;
  if (inline) {
    key = `inline:${inline}`;
    text = inline;
  } else {
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      throw new Error(`Billing plans file not found: ${file} (set BILLING_PLANS_FILE or BILLING_PLANS)`);
    }
    key = `file:${file}:${mtime}`;
    text = '';
  }
  key += `|${priceEnv}`;
  if (cache?.key === key) return cache.value;
  if (!inline) text = fs.readFileSync(file, 'utf8');
  const value = parsePlans(JSON.parse(text), e);
  cache = { key, value };
  return value;
}

export function findPlan(id: string | null | undefined): ServerPlan | null {
  if (!id) return null;
  return loadPlans().plans.find((p) => p.id === id) ?? null;
}

/** Match a plan from the Stripe price IDs on a subscription. */
export function planForPrices(priceIds: string[]): ServerPlan | null {
  return loadPlans().plans.find((p) => priceIds.includes(p.stripeBasePriceId) || priceIds.includes(p.stripeMeteredPriceId)) ?? null;
}

/** Public view of a plan: no Stripe IDs. */
export function publicPlan(p: ServerPlan): BillingPlan {
  const { stripeBasePriceId: _b, stripeMeteredPriceId: _m, ...rest } = p;
  return rest;
}

/** Startup sanity check: logs problems instead of crashing a running install. */
export function billingConfigWarnings(): string[] {
  if (!billingEnabled()) return [];
  const out: string[] = [];
  const s = billingSettings();
  if (!s.webhookSecret) out.push('STRIPE_WEBHOOK_SECRET is not set: webhooks will be rejected and subscriptions will not activate.');
  try {
    const cfg = loadPlans();
    if (cfg.placeholder) out.push('Billing plans are PLACEHOLDERS (config/billing-plans.json has "placeholder": true). Set real prices before launch.');
    for (const p of cfg.plans) {
      if (!p.stripeBasePriceId || !p.stripeMeteredPriceId) out.push(`Plan "${p.id}" has no Stripe price IDs (STRIPE_PRICE_${p.id.toUpperCase()}_BASE / _METERED). Run scripts/stripe-setup.ts.`);
    }
  } catch (e) {
    out.push(`Billing plans are invalid: ${e instanceof Error ? e.message : String(e)}`);
  }
  return out;
}
