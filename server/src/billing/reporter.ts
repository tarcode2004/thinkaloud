// Background reporter: sends unreported usage events to Stripe as Billing Meter Events.
// The usage event id is both the meter event `identifier` and the request idempotency key, so a
// retry after a timeout (or a crash between sending and marking) can never double-bill.
import { db } from '../db.ts';
import { billingEnabled, billingSettings } from './config.ts';
import { stripe } from './stripe.ts';
import { VOICE_MINUTES } from './account.ts';
import { sweepUnbilledSessions } from './usage.ts';

/** Stripe accepts meter event timestamps up to 35 days in the past; keep a margin. */
const MAX_EVENT_AGE_MS = 34 * 864e5;

/** Exponential backoff: 30 s, 1 min, 2 min … capped at 1 h. */
export function backoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 3_600_000);
}

interface PendingRow {
  id: string;
  quantity: number;
  at: number;
  attempts: number;
  stripe_customer_id: string | null;
}

let running = false;

export async function reportPendingUsage(now = Date.now(), batch = 100): Promise<{ sent: number; failed: number; skipped: number }> {
  const out = { sent: 0, failed: 0, skipped: 0 };
  if (!billingEnabled() || running) return out;
  running = true;
  try {
    const rows = db
      .prepare(
        `SELECT u.id, u.quantity, u.at, u.attempts, b.stripe_customer_id FROM usage_events u
         LEFT JOIN billing_accounts b ON b.user_id = u.user_id
         WHERE u.kind = ? AND u.reported_at IS NULL AND u.skipped IS NULL AND (u.next_attempt_at IS NULL OR u.next_attempt_at <= ?)
         ORDER BY u.at LIMIT ?`,
      )
      .all(VOICE_MINUTES, now, batch) as unknown as PendingRow[];
    const { meterEventName } = billingSettings();
    for (const r of rows) {
      if (!r.stripe_customer_id) {
        db.prepare("UPDATE usage_events SET skipped = 'no_customer' WHERE id = ?").run(r.id);
        out.skipped++;
        continue;
      }
      if (now - r.at > MAX_EVENT_AGE_MS) {
        db.prepare("UPDATE usage_events SET skipped = 'expired', last_error = 'older than Stripe accepts' WHERE id = ?").run(r.id);
        console.error(`[billing] usage ${r.id} is too old to report to Stripe; skipped`);
        out.skipped++;
        continue;
      }
      try {
        await stripe().billing.meterEvents.create(
          {
            event_name: meterEventName,
            identifier: r.id,
            timestamp: Math.floor(r.at / 1000),
            payload: { stripe_customer_id: r.stripe_customer_id, value: String(r.quantity) },
          },
          { idempotencyKey: `usage-${r.id}` },
        );
        db.prepare('UPDATE usage_events SET reported_at = ?, last_error = NULL, next_attempt_at = NULL WHERE id = ?').run(now, r.id);
        out.sent++;
      } catch (e) {
        const attempts = r.attempts + 1;
        const msg = e instanceof Error ? e.message : String(e);
        db.prepare('UPDATE usage_events SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?').run(attempts, now + backoffMs(attempts), msg.slice(0, 500), r.id);
        console.error(`[billing] meter event for usage ${r.id} failed (attempt ${attempts}): ${msg}`);
        out.failed++;
      }
    }
  } finally {
    running = false;
  }
  return out;
}

/** Start the periodic sweep + report loop (server process only; never in app.ts, so tests stay timer-free). */
export function startBillingWorker(): (() => void) | null {
  const { reportIntervalMs } = billingSettings();
  if (!billingEnabled() || !reportIntervalMs) return null;
  const tick = () => {
    try {
      sweepUnbilledSessions();
    } catch (e) {
      console.error('[billing] sweep failed', e);
    }
    reportPendingUsage().catch((e) => console.error('[billing] report failed', e));
  };
  const timer = setInterval(tick, reportIntervalMs);
  timer.unref();
  setTimeout(tick, 5_000).unref();
  return () => clearInterval(timer);
}
