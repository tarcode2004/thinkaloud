// The Stripe SDK client, created lazily from STRIPE_SECRET_KEY. Tests swap in a mock with
// setStripeClient() so no request ever reaches Stripe.
import Stripe from 'stripe';
import { billingSettings } from './config.ts';

let client: Stripe | null = null;
let clientKey = '';

export function stripe(): Stripe {
  const key = billingSettings().secretKey;
  if (!key) throw new Error('Stripe is not configured (STRIPE_SECRET_KEY)');
  if (!client || (clientKey && clientKey !== key)) {
    client = new Stripe(key, { maxNetworkRetries: 2, timeout: 20_000, appInfo: { name: 'ThinkAloud' } });
    clientKey = key;
  }
  return client;
}

/** Test hook: replace the client (pass null to reset). */
export function setStripeClient(mock: unknown) {
  client = (mock as Stripe | null) ?? null;
  clientKey = '';
}

/** Verify a webhook signature on the raw body and parse the event. Purely local (no network). */
export function verifyWebhook(rawBody: Buffer | string, signature: string | undefined): Stripe.Event {
  const secret = billingSettings().webhookSecret;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not set');
  if (!signature) throw new Error('Missing Stripe-Signature header');
  return Stripe.webhooks.constructEvent(rawBody, signature, secret);
}

export { Stripe };
