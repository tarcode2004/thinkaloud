// Create (or find) the Stripe objects ThinkAloud billing needs, idempotently, and print the env
// vars to put in .env. Safe to re-run: existing objects are reused, matched by lookup keys and metadata.
//
//   STRIPE_SECRET_KEY=sk_test_... npx tsx scripts/stripe-setup.ts [--webhook-url=https://api.example.com/api/billing/webhook]
//
// Test mode only unless --live is passed. Prices are read from config/billing-plans.json
// (or BILLING_PLANS_FILE / BILLING_PLANS). Stripe prices are immutable, so changing an amount
// in the config creates a new price on the next run; switch the env var to it.
import Stripe from 'stripe';
import { HANDLED_EVENTS, loadPlans, billingSettings } from '../server/src/billing/config.ts';

const args = new Map(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=') || 'true'] as const; }));
const key = process.env.STRIPE_SECRET_KEY || '';
if (!key) {
  console.error('Set STRIPE_SECRET_KEY (a test-mode key, sk_test_...).');
  process.exit(1);
}
if (!key.startsWith('sk_test_') && !key.startsWith('rk_test_') && !args.has('live')) {
  console.error('Refusing to run with a live key. Pass --live if you really mean it.');
  process.exit(1);
}

const stripe = new Stripe(key);
const { meterEventName } = billingSettings();
const cfg = loadPlans();
const env: string[] = [];

async function findOrCreateMeter() {
  for await (const m of stripe.billing.meters.list({ status: 'active', limit: 100 })) {
    if (m.event_name === meterEventName) return { meter: m, created: false };
  }
  const meter = await stripe.billing.meters.create({
    display_name: 'ThinkAloud voice minutes',
    event_name: meterEventName,
    default_aggregation: { formula: 'sum' },
    customer_mapping: { type: 'by_id', event_payload_key: 'stripe_customer_id' },
    value_settings: { event_payload_key: 'value' },
  });
  return { meter, created: true };
}

async function findOrCreateProduct(planId: string, name: string, description: string) {
  for await (const p of stripe.products.list({ active: true, limit: 100 })) {
    if (p.metadata?.thinkaloud_plan === planId) return p;
  }
  return stripe.products.create({ name: `ThinkAloud ${name}`, ...(description ? { description } : {}), metadata: { thinkaloud_plan: planId } });
}

async function priceByLookup(lookupKey: string) {
  const r = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  return r.data[0] ?? null;
}

const slug = (v: number | string) => String(v).replace(/[^a-z0-9]/gi, '_');

const { meter, created } = await findOrCreateMeter();
console.log(`${created ? 'Created' : 'Found'} meter ${meter.id} (event_name "${meterEventName}")`);
env.push(`STRIPE_METER_EVENT_NAME=${meterEventName}`);

for (const plan of cfg.plans) {
  const product = await findOrCreateProduct(plan.id, plan.name, plan.description);
  const KEY = plan.id.toUpperCase().replace(/[^A-Z0-9]/g, '_');

  const baseKey = `thinkaloud_${plan.id}_base_${plan.monthlyPriceCents}_${cfg.currency}`;
  const base =
    (await priceByLookup(baseKey)) ??
    (await stripe.prices.create({
      product: product.id,
      currency: cfg.currency,
      unit_amount: plan.monthlyPriceCents,
      recurring: { interval: 'month', usage_type: 'licensed' },
      lookup_key: baseKey,
      nickname: `${plan.name} monthly`,
    }));

  // Metered price on the meter: the first N minutes each period are free (included), the rest
  // cost the overage rate. Every minute is reported; Stripe's graduated tiers do the maths.
  const meteredKey = `thinkaloud_${plan.id}_metered_${plan.includedMinutes}_${slug(plan.overageCentsPerMinute)}_${cfg.currency}_${meter.id}`;
  const rate = Stripe.Decimal.from(String(plan.overageCentsPerMinute));
  const metered =
    (await priceByLookup(meteredKey)) ??
    (await stripe.prices.create({
      product: product.id,
      currency: cfg.currency,
      recurring: { interval: 'month', usage_type: 'metered', meter: meter.id },
      lookup_key: meteredKey,
      nickname: `${plan.name} voice minutes`,
      ...(plan.includedMinutes > 0
        ? { billing_scheme: 'tiered' as const, tiers_mode: 'graduated' as const, tiers: [{ up_to: plan.includedMinutes, unit_amount: 0 }, { up_to: 'inf' as const, unit_amount_decimal: rate }] }
        : { billing_scheme: 'per_unit' as const, unit_amount_decimal: rate }),
    }));

  console.log(`Plan ${plan.id}: product ${product.id}, base ${base.id}, metered ${metered.id}`);
  env.push(`STRIPE_PRICE_${KEY}_BASE=${base.id}`, `STRIPE_PRICE_${KEY}_METERED=${metered.id}`);
}

const webhookUrl = args.get('webhook-url');
if (webhookUrl && webhookUrl !== 'true') {
  let found: Stripe.WebhookEndpoint | null = null;
  for await (const w of stripe.webhookEndpoints.list({ limit: 100 })) if (w.url === webhookUrl) found = w;
  if (found) {
    await stripe.webhookEndpoints.update(found.id, { enabled_events: [...HANDLED_EVENTS] });
    console.log(`Webhook endpoint ${found.id} already exists (events updated). Its signing secret is in the Dashboard.`);
  } else {
    const w = await stripe.webhookEndpoints.create({ url: webhookUrl, enabled_events: [...HANDLED_EVENTS], description: 'ThinkAloud billing' });
    console.log(`Created webhook endpoint ${w.id}`);
    env.push(`STRIPE_WEBHOOK_SECRET=${w.secret}`);
  }
}

if (cfg.placeholder) console.warn('\nNote: config/billing-plans.json is marked "placeholder": these are placeholder prices.');
console.log('\nAdd to .env:\n');
console.log(env.join('\n'));
