# Billing (SaaS mode)

ThinkAloud can run as a paid service: researchers sign up, subscribe with Stripe, and pay a monthly plan that includes some voice minutes, plus pay-as-you-go for extra minutes.

Billing is **off unless `STRIPE_SECRET_KEY` is set**. A self-hosted install without it behaves exactly as before, with no plans, limits or billing UI.

## How it works

| | |
|---|---|
| **Plan** | One Stripe subscription per researcher with two prices: a licensed monthly price (quantity 1) and a metered price attached to a Billing Meter. |
| **Included minutes** | The metered price uses graduated tiers: the first *N* minutes each period cost 0 and later minutes cost the overage rate. ThinkAloud reports every minute, and Stripe works out the bill. |
| **Voice minute** | Counted from the first realtime-token mint (the moderator connecting) until the session completes, is abandoned or is withdrawn. It is rounded up to a whole minute per session, with a minimum of 1 and a cap of `BILLING_MAX_SESSION_MINUTES`. |
| **Free** | The owner's previews, sessions that never connected voice, and minutes used during the free trial. |
| **Abandoned sessions** | A session that used voice but stopped reporting activity for `BILLING_ABANDON_AFTER_MINUTES` is billed up to its last activity (server clock). A background sweep does this. |
| **Recording** | One `usage_events` row per session (`UNIQUE(session_id, kind)`), so recording is idempotent. |
| **Reporting** | A background worker sends unreported rows as [Meter Events](https://docs.stripe.com/billing/subscriptions/usage-based/recording-usage-api). The usage event id is both the meter event `identifier` and the request idempotency key. Failures retry with exponential backoff (30 s, doubling, capped at 1 h). |
| **Enforcement** | Without an active or trialing plan, a researcher can still sign up, build studies and preview them, but can't go live, and participant links show "This study isn't accepting participants right now." Participants never see billing details. |
| **Payment failure** | `past_due` keeps working for `BILLING_GRACE_DAYS` (default 3), then sessions are blocked until an invoice is paid. |
| **Spending limit** | A researcher can set a monthly limit (plan price + extra minutes). Once the period's estimate reaches it, new sessions are blocked. Sessions already in progress, and their reconnects, are never cut off. |
| **Trial** | Offered once per account: `trialDays`, and optionally `trialMinutes`, whichever runs out first. When the trial minutes are used up, the researcher can start the paid plan early from the Billing page. |

## Plans (owner decision)

Plans live in **`config/billing-plans.json`**, or the file named by `BILLING_PLANS_FILE`, or inline JSON in `BILLING_PLANS`. No prices are hard-coded. The shipped file contains **placeholders** (`"placeholder": true`), and the server logs a warning at startup until you change it.

```jsonc
{
  "currency": "usd",
  "plans": [
    {
      "id": "starter",                 // lowercase; maps to STRIPE_PRICE_STARTER_BASE / _METERED
      "name": "Starter",
      "description": "For a researcher running a few studies a month.",
      "monthlyPriceCents": 4900,       // placeholder
      "includedMinutes": 300,          // placeholder
      "overageCentsPerMinute": 25,     // placeholder; fractions allowed (e.g. 12.5)
      "trialDays": 14,                 // 0 = no trial
      "trialMinutes": 30,              // null = only limited by days
      "features": ["300 voice minutes a month", "..."]
    }
  ]
}
```

Stripe price IDs come from `STRIPE_PRICE_<PLAN_ID>_BASE` and `STRIPE_PRICE_<PLAN_ID>_METERED`, or from `stripeBasePriceId` and `stripeMeteredPriceId` in the file. The public pricing API (`GET /api/billing/plans`) never exposes them.

## Stripe setup

### 1. Create the meter, products and prices

Run the setup script with a **test-mode** key. It is idempotent: it reuses objects found by `lookup_key` or metadata, and creates whatever is missing.

```bash
STRIPE_SECRET_KEY=sk_test_... npx tsx scripts/stripe-setup.ts
# optional: also create the webhook endpoint
STRIPE_SECRET_KEY=sk_test_... npx tsx scripts/stripe-setup.ts --webhook-url=https://<api-origin>/api/billing/webhook
```

It creates:

- the **Billing Meter**: `event_name` = `STRIPE_METER_EVENT_NAME` (default `thinkaloud_voice_minutes`), sum aggregation, customer mapped from `payload.stripe_customer_id`, and value from `payload.value`;
- one **product** per plan (`metadata.thinkaloud_plan = <id>`);
- a licensed **monthly price** (`unit_amount = monthlyPriceCents`);
- a metered **monthly price** on the meter, with graduated tiers: `up_to = includedMinutes` at 0, then `overageCentsPerMinute`.

It prints the lines to add to `.env`. Stripe prices are immutable, so if you change an amount, re-run the script and switch the env var to the new price.

To do it by hand in the Dashboard instead: Billing → Meters → Create meter (as above), then for each plan create a product with a recurring monthly flat price and a recurring usage-based price on that meter, using graduated tiers.

### 2. Customer Portal

In the Dashboard, under Settings → Billing → Customer portal, turn on invoice history, payment method updates and cancellation, then save, which activates the default configuration. Test mode and live mode each need this once. The **Manage billing** and **Open portal** buttons use it.

Subscriptions have two prices (licensed and metered), so plan switching isn't offered in the portal. A researcher who wants a different plan cancels and subscribes again, or the owner changes the subscription in the Dashboard. ThinkAloud picks up the new plan from the subscription's prices.

### 3. Webhook

**URL:** `https://<API origin>/api/billing/webhook`

The webhook must point at the **API origin**, the host that runs the ThinkAloud server. When the front end is hosted separately (for example on Firebase Hosting, with the API behind a Cloudflare tunnel), use the **tunnel's API URL**, not the `web.app` front-end domain. If the tunnel URL changes (quick tunnels), update the endpoint URL in Stripe.

**Events to send** (exactly these):

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

Copy the endpoint's signing secret into `STRIPE_WEBHOOK_SECRET`. The route verifies `Stripe-Signature` over the raw body. It is mounted with `express.raw()` before the JSON parser and is exempt from the CSRF origin guard; the signature is its only authentication. Each event id is applied once (`stripe_events`), and subscription updates older than the last applied one are ignored, so retries and out-of-order deliveries are safe.

### 4. Return URLs

Checkout success and cancel URLs and the portal return URL are built from **`PUBLIC_URL`**, the origin researchers use in their browser (the front end, e.g. `https://<project>.web.app`), not the API origin. They go to `/billing?checkout=success|canceled` and `/billing`.

## Testing locally with the Stripe CLI

```bash
stripe login
stripe listen --forward-to localhost:4000/api/billing/webhook
# prints "Your webhook signing secret is whsec_..." → STRIPE_WEBHOOK_SECRET in .env, restart the server

npm start
# sign up → Billing → Start free trial → pay with 4242 4242 4242 4242, any future date, any CVC
stripe trigger invoice.payment_failed      # or use test clocks to exercise renewals and failures
```

Useful test cards: `4000 0000 0000 0341` attaches, then fails on charge (useful for past_due); `4000 0025 0000 3155` requires 3-D Secure. Meter events appear under Billing → Meters → *your meter* → Events, about a minute after a session ends.

## Environment variables

| Variable | Default | |
|---|---|---|
| `STRIPE_SECRET_KEY` | (unset) | Turns billing on. Server only, never sent to the browser. |
| `STRIPE_WEBHOOK_SECRET` | (unset) | Signing secret of the webhook endpoint (or from `stripe listen`). Required when billing is on. |
| `STRIPE_METER_EVENT_NAME` | `thinkaloud_voice_minutes` | Must match the meter's `event_name`. |
| `STRIPE_PRICE_<PLAN>_BASE` / `STRIPE_PRICE_<PLAN>_METERED` | (unset) | Price IDs per plan id (upper-case, `-` → `_`). |
| `BILLING_PLANS_FILE` | `config/billing-plans.json` | Plans file (relative to the repo root). |
| `BILLING_PLANS` | (unset) | Inline plans JSON; overrides the file. |
| `BILLING_GRACE_DAYS` | `3` | Days a `past_due` account keeps running sessions. |
| `BILLING_MAX_SESSION_MINUTES` | `120` | The most minutes one session can bill. |
| `BILLING_ABANDON_AFTER_MINUTES` | `30` | Idle time after which a voice session is billed as abandoned. |
| `BILLING_REPORT_INTERVAL_MS` | `60000` | Sweep and report interval. `BILLING_REPORTER=off` disables the worker. |
| `PUBLIC_URL` | | Front-end origin used for the Stripe return URLs. |

No publishable key is needed: the browser is only ever sent Stripe-hosted Checkout and Portal URLs.

## API

| Route | Auth | |
|---|---|---|
| `GET /api/billing/plans` | public | `{ enabled, plans }`, with no Stripe IDs. |
| `GET /api/billing` | researcher | Plan, status, usage this period, estimate, block reason. |
| `POST /api/billing/checkout` `{ planId }` | researcher | `{ url }` of a Stripe Checkout session (mode `subscription`). |
| `POST /api/billing/portal` | researcher | `{ url }` of a Customer Portal session. |
| `POST /api/billing/end-trial` | researcher | Ends a trial now (`trial_end: 'now'`). |
| `PATCH /api/billing/settings` `{ spendCapCents \| null }` | researcher | Monthly spending limit (at least the plan price). |
| `POST /api/billing/webhook` | Stripe signature | Webhook receiver. |

Going live (`PATCH /api/studies/:id {status:'live'}`) returns **402** when the account can't run sessions.

## Data

Migration 6 in `server/src/db.ts` adds:

- `billing_accounts`: customer, subscription, plan, status, period, trial, grace start, spending limit and the stale-event guard;
- `usage_events`: one row per session and kind, with report state, attempts and backoff;
- `stripe_events`: processed event ids;
- `sessions.voice_started_at` and `sessions.voice_last_seen_at`.

## Tests

`server/src/billing/billing.test.ts` covers the plan config, usage maths, entitlement decisions, signed webhooks (built with `stripe.webhooks.generateTestHeaderString`), idempotency, stale events, trial, grace period, spending limit, the sweeper, and reporter retries. The Stripe SDK is replaced with a mock, so no request leaves the machine. Security cases are in `server/src/security.test.ts`, and the browser flow is in `tests/e2e/billing.spec.ts`.
