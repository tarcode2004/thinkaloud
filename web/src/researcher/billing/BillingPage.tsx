import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { AlertCircle, ArrowUpRight, CheckCircle2 } from 'lucide-react';
import type { BillingOverview, BillingPlan } from '@thinkaloud/shared';
import { Button, cn, PageHeader, Spinner } from '../../ui/index.tsx';
import { useToast } from '../../ui/toast.tsx';
import { Callout, FormSection, Group, Row, Switch } from '../components/index.tsx';
import { errorMessage } from '../lib.ts';
import {
  BLOCK_COPY, billingApi, goToCheckout, goToPortal, minutes, money, notifyBillingChanged, planSummary, shortDate, STATUS_LABEL, trialSummary,
  useBillingOverview, usePlans,
} from './api.ts';

const SUBSCRIBED = new Set(['trialing', 'active', 'past_due', 'unpaid', 'incomplete']);

export default function BillingPage() {
  const { data, error, reload } = useBillingOverview();
  const [params, setParams] = useSearchParams();
  const checkout = params.get('checkout');
  const start = params.get('start');
  const toast = useToast();
  const [opening, setOpening] = useState(false);
  const started = useRef(false);

  // Arrived from sign-up with a plan picked on the pricing page: continue straight to Checkout.
  useEffect(() => {
    if (!start || started.current || !data?.enabled || SUBSCRIBED.has(data.status)) return;
    started.current = true;
    setOpening(true);
    goToCheckout(start).catch((e) => {
      setOpening(false);
      setParams({}, { replace: true });
      toast(errorMessage(e), 'error');
    });
  }, [start, data, setParams, toast]);

  // Returning from Stripe Checkout: the webhook may land a moment after the redirect, so poll briefly.
  useEffect(() => {
    if (checkout !== 'success' || !data || SUBSCRIBED.has(data.status)) return;
    let n = 0;
    const t = setInterval(() => {
      if (++n > 10) return clearInterval(t);
      void reload().then(() => notifyBillingChanged());
    }, 1500);
    return () => clearInterval(t);
  }, [checkout, data, reload]);

  if (error) return <Page><Callout tone="error" icon={<AlertCircle className="size-4" />} title="Couldn’t load billing">{errorMessage(error)}</Callout></Page>;
  if (!data) return <Page><div className="flex justify-center py-24"><Spinner /></div></Page>;
  if (!data.enabled) {
    return (
      <Page>
        <Callout tone="info" title="Billing is off on this server">This is a self-hosted install, so there are no plans or limits.</Callout>
      </Page>
    );
  }

  const subscribed = SUBSCRIBED.has(data.status);
  if (opening) return <Page><div className="flex flex-col items-center gap-3 py-24 text-[15px] text-secondary"><Spinner />Opening secure checkout…</div></Page>;
  return (
    <Page>
      <div className="space-y-10">
        {checkout === 'success' && (
          <Callout tone="success" icon={<CheckCircle2 className="size-4" />} title={subscribed ? 'You’re all set' : 'Finishing setup…'}>
            {subscribed ? 'Your plan is active. You can publish studies and share links.' : 'Stripe is confirming your subscription. This usually takes a few seconds.'}
          </Callout>
        )}
        {checkout === 'canceled' && (
          <Callout tone="info" title="Checkout canceled">
            Nothing was charged.{' '}
            <button className="text-brand-500 hover:underline" onClick={() => setParams({}, { replace: true })}>Dismiss</button>
          </Callout>
        )}
        {data.blockReason && subscribed && <Callout tone="warn" icon={<AlertCircle className="size-4" />}>{BLOCK_COPY[data.blockReason]}</Callout>}

        {subscribed && data.plan ? <PlanSection data={data} plan={data.plan} onChange={reload} /> : <ChoosePlan data={data} />}
        {subscribed && data.usage && data.plan && <UsageSection data={data} plan={data.plan} />}
        {subscribed && data.plan && data.status !== 'trialing' && <SpendLimit data={data} plan={data.plan} />}
        {data.hasCustomer && <Invoices />}

        <p className="px-1 text-[12px] leading-relaxed text-tertiary">
          A voice minute is counted from when the AI moderator connects until the session ends, rounded up to the next whole minute for each session.
          Sessions that end early still count the minutes they used. Your own previews are free.
        </p>
      </div>
    </Page>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-[760px] px-6 py-10 sm:px-8" data-testid="billing-page">
      <PageHeader title="Billing" description="Your plan, voice minutes and invoices." />
      {children}
    </div>
  );
}

function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast(errorMessage(e), 'error');
      setBusy(null);
    }
  };
  return { busy, run, done: () => setBusy(null) };
}

function StatusDot({ status }: { status: BillingOverview['status'] }) {
  const s = STATUS_LABEL[status];
  return (
    <span className="inline-flex items-center gap-1.5 text-[14px] text-label" data-testid="billing-status">
      <span className={cn('size-2 rounded-full', s.dot)} />
      {s.label}
    </span>
  );
}

function PlanSection({ data, plan, onChange }: { data: BillingOverview; plan: BillingPlan; onChange: () => void }) {
  const { busy, run, done } = useAction();
  const toast = useToast();
  const renewal =
    data.status === 'trialing'
      ? ['Trial ends', shortDate(data.trialEnd)]
      : data.cancelAtPeriodEnd
        ? ['Ends', shortDate(data.currentPeriodEnd)]
        : ['Renews', shortDate(data.currentPeriodEnd)];
  return (
    <FormSection
      title="Plan"
      flush
      actions={<Button size="sm" variant="secondary" loading={busy === 'portal'} onClick={() => run('portal', goToPortal)} data-testid="manage-billing">Manage billing</Button>}
    >
      <Group className="ring-0">
        <Row label={<span className="font-medium">{plan.name}</span>} description={planSummary(plan)}>
          <span className="text-[14px] tabular-nums text-label">{money(plan.monthlyPriceCents, plan.currency)}<span className="text-secondary"> / month</span></span>
        </Row>
        <Row label="Status"><StatusDot status={data.status} /></Row>
        {renewal[1] && <Row label={renewal[0]}><span className="text-[14px] tabular-nums text-secondary">{renewal[1]}</span></Row>}
        {data.status === 'past_due' && data.graceEndsAt && (
          <Row label="Update your card by" description="Participant sessions keep running until then.">
            <span className="text-[14px] tabular-nums text-sys-orange">{shortDate(data.graceEndsAt)}</span>
          </Row>
        )}
        {data.status === 'trialing' && (
          <Row label="Start your paid plan now" description="Ends the trial today. Your card is charged for the first month.">
            <Button
              size="sm"
              variant="secondary"
              loading={busy === 'end'}
              onClick={() =>
                run('end', async () => {
                  await billingApi.endTrial();
                  toast('Your paid plan is starting');
                  done();
                  setTimeout(() => (onChange(), notifyBillingChanged()), 2000);
                })
              }
            >
              Start plan
            </Button>
          </Row>
        )}
      </Group>
    </FormSection>
  );
}

function ChoosePlan({ data }: { data: BillingOverview }) {
  const plans = usePlans();
  const { busy, run } = useAction();
  return (
    <section>
      <div className="mb-3 px-1">
        <h2 className="text-[22px] font-semibold tracking-[-0.015em]">Choose a plan</h2>
        <p className="mt-1 text-[15px] text-secondary">{data.blockReason ? BLOCK_COPY[data.blockReason] : 'Pick the plan that fits how often you test.'}</p>
      </div>
      {!plans ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {plans.plans.map((p) => (
            <div key={p.id} className="flex flex-col rounded-[18px] bg-surface p-6 ring-1 ring-black/[0.04]" data-testid={`plan-${p.id}`}>
              <div className="text-[17px] font-semibold">{p.name}</div>
              {p.description && <p className="mt-1 text-[13px] text-secondary">{p.description}</p>}
              <div className="mt-4 text-[34px] font-semibold tabular-nums tracking-[-0.02em]">
                {money(p.monthlyPriceCents, p.currency)}<span className="text-[15px] font-normal text-secondary"> / month</span>
              </div>
              <p className="mt-1 text-[13px] text-secondary">{planSummary(p)}</p>
              {data.trialAvailable && p.trialDays > 0 && <p className="mt-3 text-[13px] text-label">{trialSummary(p)}</p>}
              <Button className="mt-6" loading={busy === p.id} onClick={() => run(p.id, () => goToCheckout(p.id))}>
                {data.trialAvailable && p.trialDays > 0 ? 'Start free trial' : 'Subscribe'}
              </Button>
            </div>
          ))}
        </div>
      )}
      <p className="mt-3 px-1 text-[12px] text-tertiary">Payments are handled by Stripe. Cancel any time from the billing portal.</p>
    </section>
  );
}

function UsageSection({ data, plan }: { data: BillingOverview; plan: BillingPlan }) {
  const u = data.usage!;
  const trial = data.status === 'trialing' && u.trialMinutes != null;
  const used = trial ? (u.trialMinutesUsed ?? 0) : u.minutesUsed;
  const limit = trial ? u.trialMinutes! : u.includedMinutes;
  const ratio = limit > 0 ? Math.min(1, used / limit) : used > 0 ? 1 : 0;
  const over = !trial && u.overageMinutes > 0;
  return (
    <FormSection
      title={trial ? 'Trial usage' : 'Usage this period'}
      description={trial ? undefined : `${shortDate(u.periodStart)} to ${shortDate(u.periodEnd)}`}
    >
      <div data-testid="usage-meter">
        <div className="flex items-baseline justify-between gap-4">
          <div className="text-[28px] font-semibold tabular-nums tracking-[-0.02em]">
            {minutes(used)}
            <span className="text-[15px] font-normal text-secondary"> of {minutes(limit)} {trial ? 'trial ' : 'included '}minutes</span>
          </div>
          <div className="text-[13px] tabular-nums text-secondary">{minutes(u.sessionCount)} {u.sessionCount === 1 ? 'session' : 'sessions'}</div>
        </div>
        <div
          className="mt-3 h-2 overflow-hidden rounded-full bg-fill"
          role="meter"
          aria-valuemin={0}
          aria-valuemax={limit}
          aria-valuenow={used}
          aria-label="Voice minutes used"
        >
          <div className={cn('h-full rounded-full transition-[width] duration-300 ease-apple', over ? 'bg-sys-orange' : 'bg-brand-500')} style={{ width: `${ratio * 100}%` }} />
        </div>
      </div>
      {!trial && (
        <dl className="divide-y divide-separator border-t border-separator text-[14px]">
          <Line label="Extra minutes" value={minutes(u.overageMinutes)} />
          <Line label={`Extra minutes at ${money(plan.overageCentsPerMinute, plan.currency, { rate: true })} each`} value={money(u.estimatedOverageCents, plan.currency)} />
          <Line label="Estimated total this period" value={money(u.estimatedTotalCents, plan.currency)} strong />
        </dl>
      )}
      {trial && <p className="text-[13px] text-secondary">Trial minutes are free. Your plan starts on {shortDate(data.trialEnd)}, or earlier if you use them all and start it yourself.</p>}
    </FormSection>
  );
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <dt className="text-secondary">{label}</dt>
      <dd className={cn('tabular-nums', strong ? 'font-semibold text-label' : 'text-label')}>{value}</dd>
    </div>
  );
}

function SpendLimit({ data, plan }: { data: BillingOverview; plan: BillingPlan }) {
  const toast = useToast();
  const [on, setOn] = useState(data.spendCapCents != null);
  const [dollars, setDollars] = useState(data.spendCapCents != null ? String(data.spendCapCents / 100) : String((plan.monthlyPriceCents * 2) / 100));
  const [saving, setSaving] = useState(false);
  const min = plan.monthlyPriceCents / 100;
  const save = async (enabled: boolean) => {
    const cents = Math.round(Number(dollars) * 100);
    if (enabled && (!Number.isFinite(cents) || cents < plan.monthlyPriceCents)) return toast(`Enter at least ${money(plan.monthlyPriceCents, plan.currency)}.`, 'error');
    setSaving(true);
    try {
      await billingApi.settings(enabled ? cents : null);
      toast(enabled ? 'Spending limit saved' : 'Spending limit removed');
      notifyBillingChanged();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <FormSection title="Spending limit" description="Stop new participant sessions once this period’s estimated total reaches a limit. Sessions in progress finish normally." flush>
      <Group className="ring-0">
        <Row label="Limit monthly spending">
          <Switch
            checked={on}
            label="Limit monthly spending"
            onChange={(v) => {
              setOn(v);
              if (!v && data.spendCapCents != null) void save(false);
            }}
          />
        </Row>
        {on && (
          <Row label="Limit" description={`Includes the ${money(plan.monthlyPriceCents, plan.currency)} plan price.`}>
            <div className="flex items-center gap-2">
              <div className="relative w-32">
                <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-[14px] text-tertiary">{money(0, plan.currency).replace(/[\d.,\s]/g, '')}</span>
                <input
                  type="number"
                  min={min}
                  step="1"
                  value={dollars}
                  onChange={(e) => setDollars(e.target.value)}
                  aria-label="Monthly limit"
                  className="h-9 w-full rounded-[10px] border border-black/10 bg-white pl-7 pr-3 text-right text-[14px] tabular-nums focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-brand-500/15"
                />
              </div>
              <Button size="sm" loading={saving} onClick={() => save(true)}>Save</Button>
            </div>
          </Row>
        )}
      </Group>
    </FormSection>
  );
}

function Invoices() {
  const { busy, run } = useAction();
  return (
    <FormSection title="Invoices and payment" flush>
      <Group className="ring-0">
        <Row label="Invoices, receipts and card" description="Download past invoices, update your card or cancel in the Stripe billing portal.">
          <Button size="sm" variant="ghost" loading={busy === 'p'} onClick={() => run('p', goToPortal)} icon={<ArrowUpRight className="size-4" />}>Open portal</Button>
        </Row>
      </Group>
    </FormSection>
  );
}
