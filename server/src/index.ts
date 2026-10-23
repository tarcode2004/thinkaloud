import { config } from './lib/config.ts';
import { createApp } from './app.ts';
import { startAppHost } from './apphost/server.ts';
import { billingConfigWarnings, billingEnabled } from './billing/config.ts';
import { startBillingWorker } from './billing/reporter.ts';

createApp().listen(config.port, () => {
  console.log(`ThinkAloud API on http://localhost:${config.port}  (public: ${config.publicUrl})`);
});
startAppHost();

if (billingEnabled()) {
  console.log('Billing is on (Stripe).');
  for (const w of billingConfigWarnings()) console.warn(`[billing] ${w}`);
  startBillingWorker();
}
