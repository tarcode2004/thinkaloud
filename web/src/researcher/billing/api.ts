// Billing client: plans (public), the signed-in researcher's overview, and Stripe redirects.
// The browser only ever receives Stripe-hosted URLs (Checkout, Customer Portal); no keys.
import { useCallback, useEffect, useState } from 'react';
import type { BillingBlockReason, BillingOverview, BillingPlan, BillingPlansResponse, BillingStatus } from '@thinkaloud/shared';
import { api } from '../../lib/api.ts';

export const billingApi = {
  plans: () => api.get<BillingPlansResponse>('/api/billing/plans'),
  overview: () => api.get<BillingOverview>('/api/billing'),
  checkout: (planId: string) => api.post<{ url: string }>('/api/billing/checkout', { planId }),
  portal: () => api.post<{ url: string }>('/api/billing/portal'),
  endTrial: () => api.post<{ ok: boolean }>('/api/billing/end-trial'),
  settings: (spendCapCents: number | null) => api.patch<BillingOverview>('/api/billing/settings', { spendCapCents }),
};

/** Fire after anything that changes billing state so the shell (banner, sidebar) refreshes. */
export function notifyBillingChanged() {
  window.dispatchEvent(new Event('ta:billing-changed'));
}

export function useBillingOverview() {
  const [data, setData] = useState<BillingOverview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => billingApi.overview().then((d) => (setData(d), setError(null)), setError), []);
  useEffect(() => {
    void load();
    window.addEventListener('ta:billing-changed', load);
    return () => window.removeEventListener('ta:billing-changed', load);
  }, [load]);
  return { data, error, reload: load };
}

export function usePlans() {
  const [data, setData] = useState<BillingPlansResponse | null>(null);
  useEffect(() => {
    let alive = true;
    billingApi.plans().then((d) => alive && setData(d), () => alive && setData({ enabled: false, plans: [] }));
    return () => {
      alive = false;
    };
  }, []);
  return data;
}

/** Send the browser to Stripe. */
export async function goToCheckout(planId: string) {
  const { url } = await billingApi.checkout(planId);
  window.location.assign(url);
}
export async function goToPortal() {
  const { url } = await billingApi.portal();
  window.location.assign(url);
}

// ── formatting ───────────────────────────────────────────────────────────────

export function money(cents: number, currency = 'usd', opts: { rate?: boolean } = {}) {
  const v = cents / 100;
  const whole = Number.isInteger(v);
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: whole && !opts.rate ? 0 : 2,
    maximumFractionDigits: opts.rate ? 4 : 2,
  }).format(v);
}

export const minutes = (n: number) => new Intl.NumberFormat().format(Math.round(n));

export function shortDate(ms: number | null | undefined) {
  if (!ms) return '';
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(ms).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

export const STATUS_LABEL: Record<BillingStatus, { label: string; dot: string }> = {
  none: { label: 'No plan', dot: 'bg-tertiary' },
  trialing: { label: 'Free trial', dot: 'bg-brand-500' },
  active: { label: 'Active', dot: 'bg-sys-green' },
  past_due: { label: 'Payment due', dot: 'bg-sys-orange' },
  unpaid: { label: 'Unpaid', dot: 'bg-sys-red' },
  incomplete: { label: 'Payment incomplete', dot: 'bg-sys-orange' },
  canceled: { label: 'Canceled', dot: 'bg-tertiary' },
  paused: { label: 'Paused', dot: 'bg-tertiary' },
};

export const BLOCK_COPY: Record<NonNullable<BillingBlockReason>, string> = {
  no_subscription: 'Choose a plan to share studies with participants. Building and previewing studies is free.',
  canceled: 'Your subscription has ended. Choose a plan to run participant sessions again.',
  incomplete: 'Your first payment didn’t go through. Update your card to start your plan.',
  payment_failed: 'Your last payment failed. Update your card to run participant sessions again.',
  trial_minutes_used: 'You’ve used all your trial minutes. Start your paid plan to keep running sessions.',
  spend_cap: 'You’ve reached the spending limit you set for this period. Raise it to run more sessions.',
};

export function planSummary(p: BillingPlan) {
  return `${minutes(p.includedMinutes)} voice minutes included, then ${money(p.overageCentsPerMinute, p.currency, { rate: true })} per minute`;
}

export function trialSummary(p: BillingPlan) {
  if (!p.trialDays) return '';
  return p.trialMinutes != null ? `Free for ${p.trialDays} days or ${minutes(p.trialMinutes)} voice minutes, whichever comes first.` : `Free for ${p.trialDays} days.`;
}
