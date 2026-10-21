// Tiny typed fetch wrapper. All researcher calls use cookies; participant calls pass the session secret.
export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const isBlob = typeof Blob !== 'undefined' && body instanceof Blob;
  const res = await fetch(url, {
    method,
    credentials: 'include',
    headers: body !== undefined && !isForm && !isBlob ? { 'Content-Type': 'application/json', ...headers } : headers,
    body: body === undefined ? undefined : isForm || isBlob ? (body as BodyInit) : JSON.stringify(body),
  });
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
