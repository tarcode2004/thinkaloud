// Billing API (mounted at /api/billing) and the Stripe webhook handler.
// Only redirect URLs ever reach the browser; the secret key stays on the server.
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { BillingPlansResponse } from '@thinkaloud/shared';
import { HttpError, parse } from '../lib/http.ts';
import { requireUser } from '../lib/auth.ts';
import { config } from '../lib/config.ts';
import { billingEnabled, findPlan, loadPlans, publicPlan } from './config.ts';
import { ensureAccount, getAccount, overview, updateAccount } from './account.ts';
import { stripe, verifyWebhook } from './stripe.ts';
import { handleStripeEvent } from './webhooks.ts';

export const billingRouter = Router();

function requireBilling() {
  if (!billingEnabled()) throw new HttpError(404, 'Billing is not enabled on this server');
}

/** Where Stripe sends the browser back: the public front-end origin, never the API origin. */
const returnUrl = (path: string) => `${config.publicUrl}${path}`;

billingRouter.get('/plans', (_req, res) => {
  const out: BillingPlansResponse = billingEnabled() ? { enabled: true, plans: loadPlans().plans.map(publicPlan) } : { enabled: false, plans: [] };
  res.json(out);
});

billingRouter.use(requireUser);

billingRouter.get('/', (req, res) => {
  res.json(overview(req.user!.id));
});

async function customerFor(req: Request): Promise<string> {
  const user = req.user!;
  const acc = ensureAccount(user.id);
  if (acc.stripe_customer_id) return acc.stripe_customer_id;
  const customer = await stripe().customers.create(
    { email: user.email, name: user.name, metadata: { user_id: user.id } },
    { idempotencyKey: `customer-${user.id}` },
  );
  updateAccount(user.id, { stripe_customer_id: customer.id });
  return customer.id;
}

billingRouter.post('/checkout', async (req, res) => {
  requireBilling();
  const { planId } = parse(z.object({ planId: z.string().min(1).max(60) }), req.body ?? {});
  const plan = findPlan(planId);
  if (!plan) throw new HttpError(400, 'Unknown plan');
  if (!plan.stripeBasePriceId || !plan.stripeMeteredPriceId) throw new HttpError(503, 'This plan is not available yet');
  const acc = getAccount(req.user!.id);
  if (acc && ['active', 'trialing', 'past_due'].includes(acc.status)) {
    throw new HttpError(409, 'You already have a subscription. Use Manage billing to change it.');
  }
  const customer = await customerFor(req);
  const trial = !acc?.had_subscription && plan.trialDays > 0;
  const session = await stripe().checkout.sessions.create({
    mode: 'subscription',
    customer,
    client_reference_id: req.user!.id,
    line_items: [{ price: plan.stripeBasePriceId, quantity: 1 }, { price: plan.stripeMeteredPriceId }],
    subscription_data: {
      metadata: { user_id: req.user!.id, plan: plan.id },
      ...(trial ? { trial_period_days: plan.trialDays } : {}),
    },
    metadata: { user_id: req.user!.id, plan: plan.id },
    allow_promotion_codes: true,
    success_url: returnUrl('/billing?checkout=success'),
    cancel_url: returnUrl('/billing?checkout=canceled'),
  });
  if (!session.url) throw new HttpError(502, 'Stripe did not return a checkout page');
  res.json({ url: session.url });
});

billingRouter.post('/portal', async (req, res) => {
  requireBilling();
  const acc = getAccount(req.user!.id);
  if (!acc?.stripe_customer_id) throw new HttpError(400, 'Choose a plan first');
  const portal = await stripe().billingPortal.sessions.create({ customer: acc.stripe_customer_id, return_url: returnUrl('/billing') });
  res.json({ url: portal.url });
});

/** End a free trial early (e.g. trial minutes used up) so the paid plan starts now. */
billingRouter.post('/end-trial', async (req, res) => {
  requireBilling();
  const acc = getAccount(req.user!.id);
  if (!acc?.subscription_id || acc.status !== 'trialing') throw new HttpError(400, 'There is no trial to end');
  await stripe().subscriptions.update(acc.subscription_id, { trial_end: 'now' });
  res.json({ ok: true });
});

const Settings = z.object({ spendCapCents: z.number().int().min(0).max(100_000_000).nullable() });

billingRouter.patch('/settings', (req, res) => {
  requireBilling();
  const body = parse(Settings, req.body ?? {});
  const acc = ensureAccount(req.user!.id);
  const plan = findPlan(acc.plan);
  if (body.spendCapCents != null && plan && body.spendCapCents < plan.monthlyPriceCents) {
    throw new HttpError(400, 'The limit must be at least the plan price');
  }
  updateAccount(req.user!.id, { spend_cap_cents: body.spendCapCents });
  res.json(overview(req.user!.id));
});

/**
 * POST /api/billing/webhook — mounted in app.ts with express.raw() BEFORE the JSON parser and
 * before the CSRF origin guard (Stripe is a server, not a browser). Authenticated solely by the
 * Stripe-Signature header over the exact raw body.
 */
export async function stripeWebhookHandler(req: Request, res: Response) {
  if (!billingEnabled()) throw new HttpError(404, 'Billing is not enabled on this server');
  const raw = req.body;
  if (!Buffer.isBuffer(raw)) throw new HttpError(400, 'Expected the raw request body');
  let event;
  try {
    event = verifyWebhook(raw, req.headers['stripe-signature'] as string | undefined);
  } catch (e) {
    throw new HttpError(400, `Webhook signature verification failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const result = await handleStripeEvent(event);
  res.json({ received: true, result });
}
