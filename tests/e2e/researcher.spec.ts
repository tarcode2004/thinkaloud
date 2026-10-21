// Researcher dashboard end-to-end flow.
// Expects the API + web dev server to be running (defaults match the researcher dev ports):
//   cd server && PORT=4500 APP_HOST_PORT=4501 APP_HOST_URL=http://localhost:4501 PUBLIC_URL=http://localhost:5500 DATA_DIR=./data-researcher npx tsx --env-file=../.env src/index.ts
//   cd web && PORT=4500 npx vite --port 5500
// Run: RESEARCHER_URL=http://localhost:5500 npx playwright test tests/e2e/researcher.spec.ts
import { expect, test, type Page } from '@playwright/test';

const BASE = process.env.RESEARCHER_URL || 'http://localhost:5500';
const SHOTS = process.env.SHOTS_DIR || 'tests/e2e/screenshots/researcher';

// Use a locally installed Chromium if the bundled one for this Playwright version is missing.
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
function localChromium(): string | undefined {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  const root = `${homedir()}/.cache/ms-playwright`;
  if (!existsSync(root)) return undefined;
  for (const d of readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    for (const sub of readdirSync(`${root}/${d}`)) {
      const exe = `${root}/${d}/${sub}/chrome`;
      if (existsSync(exe)) return exe;
    }
  }
  return undefined;
}
test.use({ launchOptions: { executablePath: localChromium() }, viewport: { width: 1440, height: 900 }, trace: 'off' });

async function shot(page: Page, name: string) {
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

test('signup → study → protocol task → URL app → link', async ({ page }) => {
  const email = `r${Date.now()}@example.com`;

  await page.goto(`${BASE}/`);
  await expect(page.getByRole('heading', { name: /usability lab/i })).toBeVisible();
  await shot(page, '01-landing');

  await page.goto(`${BASE}/signup`);
  await shot(page, '02-signup');
  await page.locator('input[name=name]').fill('Ada Researcher');
  await page.locator('input[name=email]').fill(email);
  await page.locator('input[name=password]').fill('password123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/studies$/);
  await expect(page.getByRole('heading', { name: 'Studies' })).toBeVisible();
  await shot(page, '03-studies-empty');

  // Create study
  await page.getByTestId('new-study').click();
  await page.locator('input[name=study-name]').fill('Checkout redesign');
  await page.locator('textarea[name=study-description]').fill('Where do first-time buyers hesitate?');
  await shot(page, '04-create-study-modal');
  await page.getByTestId('create-study-submit').click();
  await expect(page).toHaveURL(/\/studies\/[^/]+$/);
  await expect(page.getByText('Setup')).toBeVisible();
  await shot(page, '05-overview');

  // Protocol editor
  await page.getByRole('link', { name: /^Protocol/ }).first().click();
  await expect(page).toHaveURL(/\/protocols\/[^/]+$/);
  await expect(page.getByTestId('step-item').first()).toBeVisible();
  await shot(page, '06-protocol-editor');
  const before = await page.getByTestId('step-item').count();
  await page.getByTestId('add-step').click();
  await page.getByRole('button', { name: /^Task\s*A scenario/ }).click();
  await expect(page.getByTestId('step-item')).toHaveCount(before + 1);
  await page.getByTestId('step-title').fill('Find a gift under $50');
  await page.getByTestId('task-instruction').fill("Imagine your friend's birthday is next week and you want to send them a gift under $50. Find something you would buy.");
  await page.getByTestId('task-success').fill('A product under $50 is in the cart.');
  await page.getByRole('button', { name: /URL matches/ }).last().click();
  await page.getByPlaceholder('^/checkout/(done|success)').fill('^/cart');
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved', { timeout: 15_000 });
  await shot(page, '07-protocol-task');
  await page.getByRole('button', { name: 'Moderator script' }).click();
  await shot(page, '08-protocol-script');
  await page.getByRole('button', { name: /Moderation/ }).first().click();
  await shot(page, '09-protocol-moderation');
  await page.getByRole('button', { name: /Consent/ }).first().click();
  await shot(page, '10-protocol-consent');

  // Persisted after reload
  await page.reload();
  await expect(page.getByTestId('step-item').filter({ hasText: 'Find a gift under $50' })).toBeVisible();

  // App builds: external URL
  await page.getByRole('link', { name: /^App builds/ }).click();
  await page.getByRole('button', { name: 'Website URL' }).click();
  await page.locator('input[name=app-url]').fill('https://example.com');
  await page.locator('input[name=app-name]').fill('Example site');
  await page.getByTestId('add-url').click();
  await expect(page.getByTestId('app-row').filter({ hasText: 'Example site' })).toBeVisible();
  await shot(page, '11-apps');

  // Variants
  await page.getByRole('link', { name: /^Variants/ }).click();
  await expect(page.getByTestId('variant-row').first()).toBeVisible();
  await page.getByTestId('variant-row').first().getByLabel('App').selectOption({ label: 'Example site' });
  await shot(page, '12-variants');

  // Recruit: new link
  await page.getByRole('link', { name: /^Recruit/ }).click();
  const links = await page.getByTestId('link-row').count();
  await page.getByTestId('new-link').click();
  await page.locator('input[name=link-name]').fill('Prolific wave 1');
  await page.getByTestId('save-link').click();
  await expect(page.getByTestId('link-row')).toHaveCount(links + 1);
  await expect(page.getByTestId('link-row').filter({ hasText: 'Prolific wave 1' })).toBeVisible();
  await shot(page, '13-recruit');

  // Overview again, then go live
  await page.getByRole('link', { name: 'Overview' }).click();
  await page.getByTestId('go-live').click();
  await page.waitForTimeout(800);
  await shot(page, '14-go-live');

  await page.goto(`${BASE}/studies`);
  await expect(page.getByTestId('study-row').first()).toBeVisible();
  await shot(page, '15-studies-list');
});
