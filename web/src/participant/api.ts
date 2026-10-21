// Participant API client (public, session-secret authenticated). See docs/API.md "Participant API".
import type { PublicLinkInfo, RealtimeTokenResponse, SessionEvent, StartSessionRequest, StartSessionResponse } from '@thinkaloud/shared';
import { api } from '../lib/api.ts';

export interface SessionAuth {
  sessionId: string;
  secret: string;
}

const h = (a: SessionAuth) => ({ 'X-Session-Secret': a.secret });
const base = (a: SessionAuth) => `/api/p/sessions/${encodeURIComponent(a.sessionId)}`;

export const pApi = {
  link: (token: string) => api.get<PublicLinkInfo>(`/api/p/links/${encodeURIComponent(token)}`),
  start: (token: string, body: StartSessionRequest) => api.post<StartSessionResponse>(`/api/p/links/${encodeURIComponent(token)}/sessions`, body),
  begin: (a: SessionAuth) => api.post<{ startedAt: number }>(`${base(a)}/begin`, {}, h(a)),
  events: (a: SessionAuth, events: SessionEvent[]) => api.post<{ ok: boolean; accepted: number }>(`${base(a)}/events`, { events }, h(a)),
  rrweb: (a: SessionAuth, seq: number, events: unknown[]) => api.post<{ ok: boolean }>(`${base(a)}/rrweb?seq=${seq}`, { events }, h(a)),
  audio: async (a: SessionAuth, seq: number, track: 'mixed' | 'mic', blob: Blob) => {
    const res = await fetch(`${base(a)}/audio?seq=${seq}&track=${track}`, {
      method: 'POST',
      headers: { ...h(a), 'Content-Type': 'audio/webm' },
      body: blob,
      keepalive: blob.size < 60_000,
    });
    if (!res.ok) throw new Error(`audio upload ${res.status}`);
  },
  realtimeToken: (a: SessionAuth) => api.post<RealtimeTokenResponse>(`${base(a)}/realtime-token`, {}, h(a)),
  complete: (a: SessionAuth, status: 'completed' | 'abandoned') => api.post<{ ok: boolean; redirectUrl: string | null }>(`${base(a)}/complete`, { status }, h(a)),
  withdraw: (a: SessionAuth) => api.post<{ ok: boolean }>(`${base(a)}/withdraw`, {}, h(a)),
  /** For pagehide: sendBeacon with ?secret= (no custom headers possible). */
  beaconEvents: (a: SessionAuth, events: SessionEvent[]) => {
    const url = `${base(a)}/events?secret=${encodeURIComponent(a.secret)}`;
    const blob = new Blob([JSON.stringify({ events })], { type: 'application/json' });
    try {
      return navigator.sendBeacon(url, blob);
    } catch {
      return false;
    }
  },
};
