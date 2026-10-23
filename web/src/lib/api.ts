// Tiny typed fetch wrapper. Researcher calls use the auth cookie (same origin) or a bearer token (when the
// API is on another origin, see runtime config below); participant calls pass the session secret.

// ── Runtime config ──────────────────────────────────────────────────────────────────────────────
// A statically hosted front end (Firebase Hosting) reads /config.json at boot to find the API, whose
// public URL can change (quick tunnels). Self-hosted, /config.json does not exist and the API is same-origin.
let apiBase = '';
const TOKEN_KEY = 'ta_auth_token';

export async function loadRuntimeConfig(): Promise<void> {
  try {
    const res = await fetch('/config.json', { cache: 'no-store' });
    if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) return;
    const c = (await res.json()) as { apiBase?: string };
    if (typeof c.apiBase === 'string' && /^https?:\/\//.test(c.apiBase)) apiBase = c.apiBase.replace(/\/$/, '');
  } catch {
    /* no runtime config: same-origin API */
  }
}

/** True when the API lives on another origin (cookies would be third-party, so use bearer auth). */
export const apiIsCrossOrigin = () => Boolean(apiBase) && new URL(apiBase).origin !== window.location.origin;

/** Absolute URL for an API path (`/api/...`); unchanged when the API is same-origin. */
export const apiUrl = (path: string) => (apiBase && path.startsWith('/') && !/^\/\//.test(path) ? apiBase + path : path);

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
export function setAuthToken(token: string | null | undefined) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage blocked: same-origin cookie auth still works */
  }
}

/** Auth header for researcher requests to a cross-origin API (empty same-origin: the cookie is used). */
export function authHeaders(): Record<string, string> {
  const t = apiIsCrossOrigin() ? readToken() : null;
  return t ? { Authorization: `Bearer ${t}` } : {};
}

/** Cookies only travel same-origin; cross-origin requests never use credentials (CORS without credentials). */
export const apiCredentials = (): RequestCredentials => (apiIsCrossOrigin() ? 'omit' : 'include');

/** Fetch an authenticated API resource as a blob URL (media/downloads when cookies can't be used). */
export async function apiBlobUrl(path: string): Promise<string> {
  const res = await fetch(apiUrl(path), { credentials: apiCredentials(), headers: authHeaders() });
  if (!res.ok) throw new ApiError(res.status, res.statusText);
  return URL.createObjectURL(await res.blob());
}

/** Download an API file. Same-origin a plain link works; cross-origin it needs the bearer header. */
export async function apiDownload(path: string, fallbackName = 'download') {
  const res = await fetch(apiUrl(path), { credentials: apiCredentials(), headers: authHeaders() });
  if (!res.ok) throw new ApiError(res.status, res.statusText);
  const name = /filename="?([^";]+)"?/.exec(res.headers.get('content-disposition') || '')?.[1] || fallbackName;
  const href = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const isBlob = typeof Blob !== 'undefined' && body instanceof Blob;
  const send = () =>
    fetch(apiUrl(url), {
      method,
      credentials: apiCredentials(),
      headers: { ...authHeaders(), ...(body !== undefined && !isForm && !isBlob ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : isForm || isBlob ? (body as BodyInit) : JSON.stringify(body),
    });
  let res: Response;
  try {
    res = await send();
  } catch (e) {
    // Network error with a configured API base: the tunnel URL may have changed since this page loaded.
    const before = apiBase;
    if (!before) throw e;
    await loadRuntimeConfig();
    if (apiBase === before) throw e;
    res = await send();
  }
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string })?.error || res.statusText, (data as { details?: unknown })?.details);
  return data as T;
}

function safeJson(t: string) {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

export const api = {
  get: <T>(url: string, headers?: Record<string, string>) => request<T>('GET', url, undefined, headers),
  post: <T>(url: string, body?: unknown, headers?: Record<string, string>) => request<T>('POST', url, body ?? {}, headers),
  patch: <T>(url: string, body?: unknown, headers?: Record<string, string>) => request<T>('PATCH', url, body ?? {}, headers),
  put: <T>(url: string, body?: unknown, headers?: Record<string, string>) => request<T>('PUT', url, body ?? {}, headers),
  del: <T>(url: string, headers?: Record<string, string>) => request<T>('DELETE', url, undefined, headers),
};
