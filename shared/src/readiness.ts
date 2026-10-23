// Pre-publish readiness: what the researcher should fix (errors) or confirm (warnings) before a
// study goes live. Pure: the server gathers the facts (DB rows, live probes) and calls
// `readinessItems`; the web merges in its own protocol validation and renders the sheet.

export type ReadinessLevel = 'error' | 'warning' | 'ok';

/** Where a "Fix" button leads, relative to the study (`/studies/<id>/<tab>[/<id>]`). */
export interface ReadinessFix {
  label: string;
  tab: 'protocols' | 'consent' | 'apps' | 'variants' | 'recruit' | 'preview';
  id?: string;
}

export interface ReadinessItem {
  id: string;
  level: ReadinessLevel;
  title: string;
  detail?: string;
  fix?: ReadinessFix;
}

export interface ReadinessReport {
  items: ReadinessItem[];
  /** True when there are no errors (warnings can be published anyway). */
  canPublish: boolean;
  checkedAt: number;
}

export interface ReadinessVariant {
  id: string;
  name: string;
  protocolId: string | null;
  protocolName?: string;
  /** Number of steps / task steps in the variant's protocol (undefined = protocol missing). */
  stepCount?: number;
  taskCount?: number;
  /** Protocol-level consent text (used when the study consent form is off). */
  protocolConsentText?: string;
  protocolUpdatedAt?: number;
  app?: { id: string; name: string; status: string; sourceKind: string; proxied: boolean } | null;
  /** appId set on the variant but the app row is gone. */
  appMissing?: boolean;
}

/** Result of loading one app path through the app host. */
export interface ProbeResult {
  appId: string;
  path: string;
  /** HTTP status, or 0 when the request failed / timed out. */
  status: number;
  /** Error text, or the 404 marker found in the HTML. */
  problem?: string;
}

export interface ReadinessInput {
  variants: ReadinessVariant[];
  hasActiveLink: boolean;
  consent: { formEnabled: boolean; formText: string };
  voice: { ok: boolean; detail?: string };
  probes: ProbeResult[];
  /** Latest preview session start, 0 = never previewed. */
  lastPreviewAt: number;
  /** Latest app update (ms) among the apps in use. */
  appsUpdatedAt: number;
}

/** HTML text that means "this page doesn't exist" even with a 200 status (SPA routers, static hosts). */
export const NOT_FOUND_MARKERS: { re: RegExp; label: string }[] = [
  { re: /Unmatched Route/i, label: 'Expo Router "Unmatched Route"' },
  { re: /This page could not be found/i, label: 'Next.js "This page could not be found"' },
  { re: /404:\s*NOT_FOUND/i, label: 'Vercel 404' },
  { re: /<title>[^<]*\b404\b[^<]*<\/title>/i, label: 'a 404 page title' },
  { re: /<h1[^>]*>\s*(404|Page not found|Not Found)\s*<\/h1>/i, label: 'a "Page not found" heading' },
];

export function notFoundMarker(html: string): string | undefined {
  return NOT_FOUND_MARKERS.find((m) => m.re.test(html))?.label;
}

export function readinessItems(input: ReadinessInput): ReadinessItem[] {
  const items: ReadinessItem[] = [];
  const { variants } = input;

  // Variants and protocols.
  if (!variants.length) {
    items.push({ id: 'variants', level: 'error', title: 'No active variant', detail: 'A variant pairs a protocol with the app participants use.', fix: { label: 'Add variant', tab: 'variants' } });
  }
  for (const v of variants) {
    if (v.stepCount === undefined) {
      items.push({ id: `protocol:${v.id}`, level: 'error', title: `Variant "${v.name}" has no protocol`, fix: { label: 'Choose protocol', tab: 'variants' } });
    } else if (v.stepCount === 0) {
      items.push({ id: `protocol:${v.id}`, level: 'error', title: `Protocol "${v.protocolName ?? ''}" has no steps`, detail: 'Participants would see the intro and then the end.', fix: { label: 'Edit protocol', tab: 'protocols', id: v.protocolId ?? undefined } });
    }
  }

  // Apps.
  for (const v of variants) {
    const tasks = v.taskCount ?? 0;
    if (v.appMissing) {
      items.push({ id: `app:${v.id}`, level: 'error', title: `Variant "${v.name}" points to an app that was deleted`, fix: { label: 'Choose app', tab: 'variants' } });
      continue;
    }
    if (!v.app) {
      if (tasks > 0)
        items.push({
          id: `app:${v.id}`,
          level: 'warning',
          title: `Variant "${v.name}" has ${tasks} task${tasks > 1 ? 's' : ''} but no app`,
          detail: 'Participants would be asked to use an app that isn’t there. Publish anyway only for interview-only studies.',
          fix: { label: 'Assign app', tab: 'variants' },
        });
      continue;
    }
    if (v.app.status === 'failed') {
      items.push({ id: `app:${v.id}`, level: 'error', title: `App "${v.app.name}" failed to build`, detail: 'Open the build log, fix the problem and rebuild.', fix: { label: 'Open build', tab: 'apps', id: v.app.id } });
    } else if (v.app.status !== 'ready') {
      items.push({ id: `app:${v.id}`, level: 'error', title: `App "${v.app.name}" is not ready yet`, detail: `Status: ${v.app.status}. Wait for the build to finish.`, fix: { label: 'Open build', tab: 'apps', id: v.app.id } });
    } else if (v.app.sourceKind === 'url' && !v.app.proxied) {
      items.push({
        id: `proxy:${v.app.id}`,
        level: 'warning',
        title: `App "${v.app.name}" is an external URL that isn’t proxied`,
        detail: 'Many sites refuse to load inside the study, and clicks and pages can’t be recorded.',
        fix: { label: 'App settings', tab: 'apps', id: v.app.id },
      });
    }
  }

  // Live probes: does the app actually load at the paths participants will see?
  const seen = new Set<string>();
  for (const p of input.probes) {
    const key = `${p.appId}${p.path}`;
    if (seen.has(key) || (p.status >= 200 && p.status < 400 && !p.problem)) continue;
    seen.add(key);
    const appName = variants.find((v) => v.app?.id === p.appId)?.app?.name ?? 'The app';
    const where = p.path === '/' ? 'its start page' : p.path;
    items.push({
      id: `probe:${key}`,
      level: 'warning',
      title: `${appName} doesn’t load ${where}`,
      detail: p.status === 0 ? `Couldn’t load it: ${p.problem ?? 'no response'}.` : p.problem ? `The page loads but shows ${p.problem}.` : `The app host answered ${p.status}.`,
      fix: { label: 'Preview', tab: 'preview' },
    });
  }

  // Links.
  if (variants.length && !input.hasActiveLink) {
    items.push({ id: 'link', level: 'error', title: 'No active participant link', fix: { label: 'Create link', tab: 'recruit' } });
  }

  // Consent.
  const consentText = input.consent.formEnabled ? input.consent.formText : '';
  const protocolsWithoutConsent = variants.filter((v) => v.stepCount !== undefined && !(v.protocolConsentText ?? '').trim());
  if (input.consent.formEnabled ? !consentText.trim() : protocolsWithoutConsent.length > 0) {
    items.push({ id: 'consent', level: 'error', title: 'No consent text', detail: 'Participants must see what is recorded before anything is captured.', fix: { label: 'Set up consent', tab: 'consent' } });
  }

  // Voice moderation.
  if (!input.voice.ok) {
    items.push({ id: 'voice', level: 'error', title: 'Voice moderation isn’t available', detail: input.voice.detail ?? 'Sessions can’t start without the realtime voice service.' });
  }

  // Preview.
  const changedAt = Math.max(input.appsUpdatedAt, ...variants.map((v) => v.protocolUpdatedAt ?? 0));
  if (!input.lastPreviewAt) {
    items.push({ id: 'preview', level: 'warning', title: 'You haven’t previewed this study', detail: 'Run it once as a participant to check that the app loads and the tasks make sense.', fix: { label: 'Preview', tab: 'preview' } });
  } else if (changedAt > input.lastPreviewAt) {
    items.push({ id: 'preview', level: 'warning', title: 'Changed since your last preview', detail: 'The protocol or app was edited after you last previewed it.', fix: { label: 'Preview', tab: 'preview' } });
  }

  return items;
}

export function readinessReport(items: ReadinessItem[], checkedAt = Date.now()): ReadinessReport {
  const order: Record<ReadinessLevel, number> = { error: 0, warning: 1, ok: 2 };
  const sorted = [...items].sort((a, b) => order[a.level] - order[b.level]);
  return { items: sorted, canPublish: !sorted.some((i) => i.level === 'error'), checkedAt };
}
