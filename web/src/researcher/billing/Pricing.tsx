// Landing-page pricing, read from GET /api/billing/plans. Renders nothing on self-hosted
// installs (billing off), so the landing page stays as it was.
import { Link } from 'react-router';
import type { BillingPlansResponse } from '@thinkaloud/shared';
import { minutes, money, trialSummary } from './api.ts';

export default function Pricing({ data }: { data: BillingPlansResponse | null }) {
  if (!data?.enabled || !data.plans.length) return null;
  return (
    <section id="pricing" className="border-b border-separator bg-canvas px-6 py-28" data-testid="pricing">
      <div className="mx-auto max-w-[980px]">
        <p className="text-[17px] font-semibold text-secondary">Pricing</p>
        <h2 className="mt-2 max-w-[720px] text-[40px] font-semibold leading-[1.08] tracking-[-0.025em] sm:text-[48px]">A monthly plan. Extra minutes only when you use them.</h2>
        <p className="mt-5 max-w-[640px] text-[17px] leading-relaxed text-secondary">
          Every plan includes voice minutes for moderated sessions. If a busy month goes past them, each extra minute is billed at the rate below. Building studies and previewing them is always free.
        </p>
        <div className={`mt-12 grid gap-px overflow-hidden rounded-[22px] bg-separator ring-1 ring-black/[0.04] ${data.plans.length > 1 ? 'md:grid-cols-2' : ''}`}>
          {data.plans.map((p) => (
            <div key={p.id} className="flex flex-col bg-white p-8">
              <div className="text-[21px] font-semibold tracking-[-0.015em]">{p.name}</div>
              {p.description && <p className="mt-1 text-[15px] text-secondary">{p.description}</p>}
              <div className="mt-6 text-[48px] font-semibold tabular-nums leading-none tracking-[-0.03em]">
                {money(p.monthlyPriceCents, p.currency)}
                <span className="ml-1 text-[17px] font-normal tracking-normal text-secondary">/ month</span>
              </div>
              <dl className="mt-6 divide-y divide-separator border-y border-separator text-[15px]">
                <div className="flex justify-between gap-4 py-3">
                  <dt className="text-secondary">Voice minutes included</dt>
                  <dd className="tabular-nums">{minutes(p.includedMinutes)}</dd>
                </div>
                <div className="flex justify-between gap-4 py-3">
                  <dt className="text-secondary">Each extra minute</dt>
                  <dd className="tabular-nums">{money(p.overageCentsPerMinute, p.currency, { rate: true })}</dd>
                </div>
              </dl>
              {p.features.length > 0 && (
                <ul className="mt-5 space-y-1.5 text-[15px] text-label">
                  {p.features.map((f) => <li key={f}>{f}</li>)}
                </ul>
              )}
              <div className="mt-auto pt-8">
                <Link to={`/signup?plan=${encodeURIComponent(p.id)}`} className="inline-flex rounded-full bg-brand-500 px-5 py-2.5 text-[15px] font-medium text-white transition-colors duration-200 hover:bg-brand-600">
                  {p.trialDays > 0 ? 'Start free trial' : `Choose ${p.name}`}
                </Link>
                {p.trialDays > 0 && <p className="mt-3 text-[13px] text-tertiary">{trialSummary(p)}</p>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
