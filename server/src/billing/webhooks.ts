// Stripe webhook processing. Each event is applied at most once (stripe_events), and
// subscription syncs ignore events older than the last one applied, so out-of-order or
// replayed deliveries can't roll state back.
import { db } from '../db.ts';
import { findPlan, planForPrices } from './config.ts';
import { stripe, type Stripe } from './stripe.ts';
import { getAccount, getAccountByCustomer, updateAccount, type AccountRow } from './account.ts';
import type { BillingStatus } from '@thinkaloud/shared';

const idOf = (v: string | { id: string } | null | undefined) => (typeof v === 'string' ? v : (v?.id ?? null));

export { HANDLED_EVENTS } from './config.ts';

function mapStatus(s: Stripe.Subscription.Status): BillingStatus {
  switch (s) {
    case 'trialing':
    case 'active':
    case 'past_due':
    case 'canceled':
    case 'incomplete':
    case 'unpaid':
    case 'paused':
      return s as BillingStatus;
    case 'incomplete_expired':
      return 'canceled';
    default:
      return 'incomplete';
  }
}

function userExists(id: string | null | undefined): id is string {
  return Boolean(id && db.prepare('SELECT 1 FROM users WHERE id = ?').get(id));
}

/** Find which user a Stripe object belongs to: our metadata first, then the customer mapping. */
function resolveUser(metadataUserId: string | undefined, customerId: string | null): string | null {
  if (userExists(metadataUserId)) return metadataUserId;
  if (customerId) return getAccountByCustomer(customerId)?.user_id ?? null;
  return null;
}

/** Apply a subscription's state to its account. `eventCreatedMs` orders concurrent deliveries. */
export function syncSubscription(sub: Stripe.Subscription, eventCreatedMs: number): 'applied' | 'stale' | 'unknown_user' | 'other_subscription' {
  const customerId = idOf(sub.customer as string | { id: string });
  const userId = resolveUser(sub.metadata?.user_id, customerId);
  if (!userId) return 'unknown_user';
  const acc = getAccount(userId);
  const status = mapStatus(sub.status);
  // A different, older subscription ending must not cancel the current one.
  if (acc?.subscription_id && acc.subscription_id !== sub.id && (status === 'canceled' || status === 'incomplete')) return 'other_subscription';
  if (acc?.subscription_id === sub.id && acc.last_event_at != null && eventCreatedMs < acc.last_event_at) return 'stale';

  const items = sub.items?.data ?? [];
  const priceIds = items.map((i) => i.price?.id).filter(Boolean) as string[];
  const plan = findPlan(sub.metadata?.plan) ?? planForPrices(priceIds);
  const starts = items.map((i) => i.current_period_start).filter((n): n is number => typeof n === 'number');
  const ends = items.map((i) => i.current_period_end).filter((n): n is number => typeof n === 'number');
  updateAccount(userId, {
    stripe_customer_id: acc?.stripe_customer_id ?? customerId,
    subscription_id: sub.id,
    plan: plan?.id ?? acc?.plan ?? 'free',
    status,
    current_period_start: starts.length ? Math.min(...starts) * 1000 : null,
    current_period_end: ends.length ? Math.max(...ends) * 1000 : null,
    trial_end: sub.trial_end ? sub.trial_end * 1000 : null,
    cancel_at_period_end: sub.cancel_at_period_end ? 1 : 0,
    past_due_since: status === 'past_due' || status === 'unpaid' ? (acc?.past_due_since ?? eventCreatedMs) : null,
    had_subscription: 1,
    last_event_at: Math.max(eventCreatedMs, acc?.last_event_at ?? 0),
  });
  return 'applied';
}

async function onCheckoutCompleted(s: Stripe.Checkout.Session, createdMs: number) {
  if (s.mode !== 'subscription') return;
  const customerId = idOf(s.customer as string | { id: string } | null);
  const userId = resolveUser(s.client_reference_id ?? s.metadata?.user_id ?? undefined, customerId);
  if (!userId) return;
  const acc = getAccount(userId);
  updateAccount(userId, { stripe_customer_id: acc?.stripe_customer_id ?? customerId, had_subscription: 1 });
  const subId = idOf(s.subscription as string | { id: string } | null);
  if (!subId) return;
  // The subscription object is the source of truth; fetch it so this event alone activates the account.
  const sub = typeof s.subscription === 'object' && s.subscription ? (s.subscription as Stripe.Subscription) : await stripe().subscriptions.retrieve(subId);
  syncSubscription(sub, createdMs);
}

function invoiceAccount(inv: Stripe.Invoice): AccountRow | null {
  const customerId = idOf(inv.customer as string | { id: string } | null);
  const acc = customerId ? getAccountByCustomer(customerId) : null;
  if (!acc) return null;
  const subId = idOf(inv.parent?.subscription_details?.subscription as string | { id: string } | null | undefined);
  if (subId && acc.subscription_id && subId !== acc.subscription_id) return null; // an old subscription's invoice
  return acc;
}

function onInvoicePaid(inv: Stripe.Invoice) {
  const acc = invoiceAccount(inv);
  if (!acc) return;
  if (acc.status === 'past_due' || acc.status === 'unpaid') updateAccount(acc.user_id, { status: 'active', past_due_since: null });
}

function onInvoiceFailed(inv: Stripe.Invoice, createdMs: number) {
  const acc = invoiceAccount(inv);
  if (!acc) return;
  if (acc.status === 'active' || acc.status === 'trialing' || acc.status === 'past_due') {
    updateAccount(acc.user_id, { status: 'past_due', past_due_since: acc.past_due_since ?? createdMs });
  }
}

/** Process a verified event. Returns 'duplicate' for an event id already applied. */
export async function handleStripeEvent(event: Stripe.Event): Promise<'processed' | 'duplicate' | 'ignored'> {
  if (db.prepare('SELECT 1 FROM stripe_events WHERE id = ?').get(event.id)) return 'duplicate';
  const createdMs = (event.created ?? Math.floor(Date.now() / 1000)) * 1000;
  let result: 'processed' | 'ignored' = 'processed';
  switch (event.type) {
    case 'checkout.session.completed':
      await onCheckoutCompleted(event.data.object as Stripe.Checkout.Session, createdMs);
      break;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      syncSubscription(event.type === 'customer.subscription.deleted' ? { ...sub, status: 'canceled' } : sub, createdMs);
      break;
    }
    case 'invoice.paid':
      onInvoicePaid(event.data.object as Stripe.Invoice);
      break;
    case 'invoice.payment_failed':
      onInvoiceFailed(event.data.object as Stripe.Invoice, createdMs);
      break;
    default:
      result = 'ignored';
  }
  // Recorded only after a successful apply: if processing throws, Stripe retries the delivery.
  db.prepare('INSERT OR IGNORE INTO stripe_events (id, type, received_at) VALUES (?, ?, ?)').run(event.id, event.type, Date.now());
  return result;
}
