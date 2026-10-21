// How hosted app URLs are formed (shared by the build pipeline and the app host).
//
//   subdomain mode (default):  APP_HOST_URL=http://localhost:4001  → http://app-<id>.localhost:4001/
//                              APP_HOST_URL=https://apps.example.com → https://app-<id>.apps.example.com/
//   path mode (fallback):      APP_HOST_URL=http://10.0.0.5:4001    → http://10.0.0.5:4001/a/app_<id>/
//
// APP_HOST_ROUTING=subdomain|path overrides the automatic choice (IP hosts → path).
// App ids look like `app_xxxxx`; DNS labels cannot contain `_`, so the label is `app-xxxxx`.
import { config } from '../lib/config.ts';

const base = new URL(config.appHostUrl);
const isIpHost = /^\d{1,3}(\.\d{1,3}){3}$/.test(base.hostname) || base.hostname.includes(':') || base.hostname.startsWith('[');

export const appHostRouting: 'subdomain' | 'path' =
  process.env.APP_HOST_ROUTING === 'path' || process.env.APP_HOST_ROUTING === 'subdomain'
    ? process.env.APP_HOST_ROUTING
    : isIpHost
      ? 'path'
      : 'subdomain';

export const appHostBaseHostname = base.hostname.toLowerCase();

export const labelForApp = (appId: string) => appId.toLowerCase().replace(/_/g, '-');
/** Inverse of labelForApp: first '-' back to '_' (ids are `<prefix>_<alnum>`). */
export const appIdFromLabel = (label: string) => label.toLowerCase().replace('-', '_');

/** Root URL (with trailing slash) at which the app host serves this app. */
export function hostedAppBase(appId: string): string {
  if (appHostRouting === 'path') return `${config.appHostUrl}/a/${appId}/`;
  const u = new URL(config.appHostUrl);
  u.hostname = `${labelForApp(appId)}.${u.hostname}`;
  return `${u.origin}/`;
}

/** The URL the participant iframe loads. For proxied external apps keep the external path. */
export function hostedAppUrl(appId: string, externalUrl?: string): string {
  const root = hostedAppBase(appId);
  if (!externalUrl) return root;
  try {
    const u = new URL(externalUrl);
    return root + (u.pathname + u.search + u.hash).replace(/^\//, '');
  } catch {
    return root;
  }
}
