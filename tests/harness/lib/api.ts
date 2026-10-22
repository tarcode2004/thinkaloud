// Researcher API client (cookie jar) used to set up one live study per scenario run.
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { sleep } from './env.ts';

export type LogEvent = { kind: string; t: number; at?: number; stepId?: string | null; data: Record<string, unknown> };

export interface SessionDetail {
  session: { id: string; status: string; participantCode?: string };
  steps: Record<string, unknown>[];
  protocol: Record<string, unknown>;
  events: LogEvent[];
  taskResults: { stepId: string; outcome: string; source: string; evidence?: string }[];
  answers: { stepId: string; questionId: string; value?: number; text?: string; choices?: string[]; source: string }[];
}

export class Researcher {
  private cookie = '';
  constructor(readonly api: string) {}

  async call<T>(method: string, url: string, body?: unknown, raw?: BodyInit): Promise<T> {
    const res = await fetch(this.api + url, {
      method,
      headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${text.slice(0, 500)}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  async login(tag: string) {
    const email = `harness-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
    await this.call('POST', '/api/auth/signup', { email, password: 'password123', name: 'Harness Researcher' });
  }

  /** Static app from a directory (zipped) → ready build. */
  async uploadStaticApp(studyId: string, name: string, dir: string) {
    const zip = new AdmZip();
    for (const f of fs.readdirSync(dir)) zip.addLocalFile(path.join(dir, f));
    const fd = new FormData();
    fd.append('name', name);
    fd.append('file', new Blob([new Uint8Array(zip.toBuffer())], { type: 'application/zip' }), `${name.replace(/\W+/g, '-')}.zip`);
    let { app } = await this.call<{ app: { id: string; status: string; error?: string } }>('POST', `/api/studies/${studyId}/apps`, undefined, fd);
    for (let i = 0; i < 240 && app.status !== 'ready'; i++) {
      if (app.status === 'failed') throw new Error(`app build failed: ${app.error ?? ''}`);
      await sleep(500);
      ({ app } = await this.call<{ app: typeof app }>('GET', `/api/apps/${app.id}`));
    }
    if (app.status !== 'ready') throw new Error('app build timed out');
    return app.id;
  }

  /** Git build (server apps like Stacky/CrossWeave). Slow; reused across runs when `reuseAppId` is ready. */
  async gitApp(studyId: string, name: string, gitUrl: string, maxMin = 20) {
    let { app } = await this.call<{ app: { id: string; status: string; error?: string } }>('POST', `/api/studies/${studyId}/apps`, { name, gitUrl });
    const t0 = Date.now();
    while (app.status !== 'ready' && Date.now() - t0 < maxMin * 60_000) {
      if (app.status === 'failed') throw new Error(`git app build failed: ${app.error ?? ''} (see ${this.api}/api/apps/${app.id}/log)`);
      await sleep(5000);
      ({ app } = await this.call<{ app: typeof app }>('GET', `/api/apps/${app.id}`));
    }
    if (app.status !== 'ready') throw new Error('git app build timed out');
    return app.id;
  }

  /** Live study with one variant (protocol + optional app). */
  async createStudy(name: string, protocol: unknown, app?: { kind: 'static'; dir: string } | { kind: 'git'; url: string }) {
    const { study } = await this.call<{ study: { id: string } }>('POST', '/api/studies', { name, template: 'blank' });
    const detail = await this.call<{ protocols: { id: string }[]; variants: { id: string }[]; links: { token: string }[] }>('GET', `/api/studies/${study.id}`);
    await this.call('PUT', `/api/protocols/${detail.protocols[0].id}`, { protocol });
    if (app) {
      const appId = app.kind === 'static' ? await this.uploadStaticApp(study.id, name, app.dir) : await this.gitApp(study.id, name, app.url);
      await this.call('PATCH', `/api/variants/${detail.variants[0].id}`, { appId });
    }
    await this.call('PATCH', `/api/studies/${study.id}`, { status: 'live' });
    return { studyId: study.id, token: detail.links[0].token };
  }

  async lastSession(studyId: string): Promise<SessionDetail | null> {
    const { sessions } = await this.call<{ sessions: { id: string }[] }>('GET', `/api/studies/${studyId}/sessions`);
    if (!sessions.length) return null;
    return this.call<SessionDetail>('GET', `/api/sessions/${sessions[0].id}`);
  }
}
