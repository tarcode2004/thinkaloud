// Researcher-side API types + helpers (shapes from docs/API.md).
import type { AppBuild, ProtocolRecord, Study, StudyLink, StudyStatus, User, Variant } from '@thinkaloud/shared';
import { api, ApiError } from '../lib/api.ts';

export type StudySummary = Study & { sessionCount: number; completedCount: number; variantCount: number; lastSessionAt: number | null };
export type LinkWithUrl = StudyLink & { url: string; sessionCount: number };
export interface StudyDetail {
  study: Study;
  protocols: ProtocolRecord[];
  apps: AppBuild[];
  variants: Variant[];
  links: LinkWithUrl[];
}

export const rApi = {
  me: () => api.get<{ user: User }>('/api/auth/me'),
  login: (email: string, password: string) => api.post<{ user: User }>('/api/auth/login', { email, password }),
  signup: (name: string, email: string, password: string) => api.post<{ user: User }>('/api/auth/signup', { name, email, password }),
  logout: () => api.post<{ ok: boolean }>('/api/auth/logout'),
  studies: () => api.get<{ studies: StudySummary[] }>('/api/studies'),
  createStudy: (body: { name: string; description?: string; template?: 'starter' | 'blank' }) => api.post<{ study: Study }>('/api/studies', body),
  study: (id: string) => api.get<StudyDetail>(`/api/studies/${id}`),
  patchStudy: (id: string, body: { name?: string; description?: string; status?: StudyStatus }) => api.patch<{ study: Study }>(`/api/studies/${id}`, body),
  deleteStudy: (id: string) => api.del(`/api/studies/${id}`),
  previewUrl: (id: string, variantId?: string) =>
    api.get<{ url: string }>(`/api/studies/${id}/preview-url${variantId ? `?variantId=${encodeURIComponent(variantId)}` : ''}`),
};

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 404) return 'This feature is not available on the server yet (404).';
    if (e.status === 503) return e.message || 'AI is not configured on the server (missing OpenAI key).';
    const d = e.details;
    if (Array.isArray(d) && d.length) return `${e.message}: ${d.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('; ')}`;
    return e.message || `Request failed (${e.status})`;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

export function errorDetails(e: unknown): string[] {
  if (e instanceof ApiError && Array.isArray(e.details)) return e.details.map((x) => (typeof x === 'string' ? x : (x as { message?: string })?.message ?? JSON.stringify(x)));
  return [];
}

export const STATUS_META: Record<StudyStatus, { label: string; tone: 'slate' | 'green' | 'amber' | 'red'; dot: string }> = {
  draft: { label: 'Draft', tone: 'slate', dot: 'bg-tertiary' },
  live: { label: 'Live', tone: 'green', dot: 'bg-sys-green' },
  paused: { label: 'Paused', tone: 'amber', dot: 'bg-sys-orange' },
  closed: { label: 'Closed', tone: 'red', dot: 'bg-sys-red' },
};

export function pct(n: number) {
  return `${Math.round(n * 100)}%`;
}

export function copy(text: string) {
  return navigator.clipboard?.writeText(text).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  });
}
