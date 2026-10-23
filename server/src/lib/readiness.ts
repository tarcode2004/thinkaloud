// Pre-publish readiness: gathers the facts for shared/readiness.ts (DB rows, live app probes,
// realtime health) for GET /api/studies/:id/readiness.
import { notFoundMarker, readinessItems, readinessReport, type ProbeResult, type ReadinessReport, type ReadinessVariant } from '@thinkaloud/shared';
import { db } from '../db.ts';
import { readMeta } from '../builds/meta.ts';
import { config } from './config.ts';
import { parseProtocol, variantFromRow, type Row } from './repo.ts';
import { loadConsentForm } from '../routes/consent.ts';

const PROBE_TIMEOUT_MS = 6000;
const MAX_PROBES = 12;

/** Load one app path through the local app host, like a participant's iframe would. */
export async function probeAppPath(appId: string, path: string): Promise<ProbeResult> {
  const url = `http://127.0.0.1:${config.appHostPort}/a/${appId}${path.startsWith('/') ? path : `/${path}`}`;
  try {
    const r = await fetch(url, { headers: { Accept: 'text/html' }, redirect: 'manual', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const ct = r.headers.get('content-type') ?? '';
    let problem: string | undefined;
    if (r.status < 300 && ct.includes('text/html')) problem = notFoundMarker(await r.text());
    else await r.body?.cancel();
    return { appId, path, status: r.status, problem };
  } catch (e) {
    return { appId, path, status: 0, problem: (e as Error).name === 'TimeoutError' ? 'timed out' : (e as Error).message };
  }
}

async function voiceStatus(): Promise<{ ok: boolean; detail?: string }> {
  const selfHosted = !/^https:\/\/api\.openai\.com\//.test(config.realtimeBaseUrl + '/');
  if (!selfHosted) return config.openaiKey ? { ok: true } : { ok: false, detail: 'No OpenAI API key is configured on the server (OPENAI_API_KEY), and no self-hosted realtime server is set (REALTIME_BASE_URL).' };
  const health = config.realtimeBaseUrl.replace(/\/v1$/, '') + '/health';
  try {
    const r = await fetch(health, { signal: AbortSignal.timeout(3000) });
    return r.ok ? { ok: true } : { ok: false, detail: `The realtime voice server answered ${r.status}.` };
  } catch {
    return { ok: false, detail: 'The realtime voice server is not reachable.' };
  }
}

export async function studyReadiness(studyId: string, opts: { probe?: boolean } = {}): Promise<ReadinessReport> {
  const variantRows = db.prepare('SELECT * FROM variants WHERE study_id = ? AND active = 1 ORDER BY created_at').all(studyId) as Row[];
  const variants: ReadinessVariant[] = [];
  const probeTargets = new Map<string, { appId: string; path: string }>();
  let appsUpdatedAt = 0;
  for (const row of variantRows) {
    const v = variantFromRow(row);
    const rv: ReadinessVariant = { id: v.id, name: v.name, protocolId: v.protocolId ?? null };
    const pr = v.protocolId ? (db.prepare('SELECT * FROM protocols WHERE id = ?').get(v.protocolId) as Row | undefined) : undefined;
    const protocol = pr ? parseProtocol(pr.protocol) : null;
    if (pr && protocol) {
      rv.protocolName = String(pr.name);
      rv.stepCount = protocol.steps?.length ?? 0;
      rv.taskCount = (protocol.steps ?? []).filter((s) => s.type === 'task').length;
      rv.protocolConsentText = protocol.consent?.text ?? '';
      rv.protocolUpdatedAt = Number(pr.updated_at);
    }
    if (v.appId) {
      const app = db.prepare('SELECT * FROM apps WHERE id = ?').get(v.appId) as Row | undefined;
      if (!app) rv.appMissing = true;
      else {
        const id = String(app.id);
        const sourceKind = String(app.source_kind);
        const proxied = sourceKind !== 'url' || Boolean(readMeta(id).proxy);
        rv.app = { id, name: String(app.name), status: String(app.status), sourceKind, proxied };
        appsUpdatedAt = Math.max(appsUpdatedAt, Number(app.updated_at));
        if (opts.probe !== false && app.status === 'ready' && proxied) {
          const paths = new Set(['/']);
          for (const s of protocol?.steps ?? []) if (s.type === 'task' && s.startPath) paths.add(s.startPath);
          for (const p of paths) probeTargets.set(`${id}${p}`, { appId: id, path: p });
        }
      }
    } else rv.app = null;
    variants.push(rv);
  }

  const form = loadConsentForm(studyId);
  const last = db.prepare('SELECT MAX(created_at) AS t FROM sessions WHERE study_id = ? AND preview = 1').get(studyId) as { t: number | null };
  const [probes, voice] = await Promise.all([
    Promise.all([...probeTargets.values()].slice(0, MAX_PROBES).map((t) => probeAppPath(t.appId, t.path))),
    opts.probe === false ? Promise.resolve({ ok: true }) : voiceStatus(),
  ]);
  const items = readinessItems({
    variants,
    hasActiveLink: Boolean(db.prepare('SELECT 1 FROM links WHERE study_id = ? AND active = 1').get(studyId)),
    consent: { formEnabled: form.enabled && form.version >= 1, formText: form.text },
    voice,
    probes,
    lastPreviewAt: Number(last?.t ?? 0),
    appsUpdatedAt,
  });
  return readinessReport(items);
}
