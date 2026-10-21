import { useEffect, useRef, useState } from 'react';
import { AlertCircle, ExternalLink, FileArchive, MoreHorizontal, RefreshCw, ScrollText, SlidersHorizontal, Trash2, Upload } from 'lucide-react';
import type { AppBuild, AppBuildSettings } from '@thinkaloud/shared';
import { api } from '../../lib/api.ts';
import { timeAgo, useInterval } from '../../lib/hooks.ts';
import { Button, cn, Field, Input, Modal, Spinner, Textarea } from '../../ui/index.tsx';
import { useToast } from '../../ui/toast.tsx';
import { Callout, Group, Menu, MenuItem, Segmented, Switch } from '../components/index.tsx';
import { copy, errorMessage } from '../lib.ts';
import { useStudy } from './StudyContext.tsx';

type App = AppBuild & { proxy?: boolean };
type Source = 'upload' | 'url' | 'git';

const FRAMEWORK: Record<string, string> = { vite: 'Vite', cra: 'Create React App', 'next-static': 'Next.js static', 'next-server': 'Next.js server', 'node-server': 'Node server', 'expo-web': 'Expo web', static: 'Static site', unknown: 'Detecting…' };
const RUNTIME: Record<string, string> = { running: 'Server running', starting: 'Server starting', stopped: 'Server stopped', failed: 'Server failed' };

/** "KEY=value" lines ↔ env object. Blank lines and # comments are ignored. */
export function parseEnv(text: string): { env: Record<string, string>; error?: string } {
  const env: Record<string, string> = {};
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) return { env, error: `Line ${i + 1}: use KEY=value` };
    env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return { env };
}
const formatEnv = (env?: Record<string, string>) => Object.entries(env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n');
const STATUS: Record<string, { label: string; dot: string }> = {
  queued: { label: 'Queued', dot: 'bg-tertiary' },
  building: { label: 'Building', dot: 'bg-sys-orange animate-pulse' },
  ready: { label: 'Ready', dot: 'bg-sys-green' },
  failed: { label: 'Failed', dot: 'bg-sys-red' },
};

export default function AppsPage() {
  const { detail, update } = useStudy();
  const apps = detail.apps as App[];
  const toast = useToast();
  const [logApp, setLogApp] = useState<App | null>(null);
  const [openApp, setOpenApp] = useState<App | null>(null);
  const [settingsApp, setSettingsApp] = useState<App | null>(null);
  const pending = apps.filter((a) => a.status === 'queued' || a.status === 'building');

  const setApp = (a: App) => update((d) => ({ ...d, apps: d.apps.some((x) => x.id === a.id) ? d.apps.map((x) => (x.id === a.id ? a : x)) : [a, ...d.apps] }));

  useInterval(
    () => {
      for (const a of pending)
        api.get<{ app: App }>(`/api/apps/${a.id}`).then(({ app }) => {
          setApp(app);
          if (app.status === 'ready' && a.status !== 'ready') toast(`${app.name} is ready`);
          if (app.status === 'failed' && a.status !== 'failed') toast(`${app.name} failed to build`, 'error');
        }, () => {});
    },
    pending.length ? 2000 : null,
  );

  const rebuild = async (a: App) => {
    try {
      const r = await api.post<{ app?: App }>(`/api/apps/${a.id}/rebuild`);
      setApp(r.app ?? { ...a, status: 'queued' });
      toast('Rebuild started');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  const remove = async (a: App) => {
    if (detail.variants.some((v) => v.appId === a.id) && !confirm(`${a.name} is used by a variant. Delete anyway?`)) return;
    try {
      await api.del(`/api/apps/${a.id}`);
      update((d) => ({ ...d, apps: d.apps.filter((x) => x.id !== a.id), variants: d.variants.map((v) => (v.appId === a.id ? { ...v, appId: null } : v)) }));
      toast('App deleted');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  const patch = async (a: App, body: { proxy?: boolean; name?: string }) => {
    try {
      const { app } = await api.patch<{ app: App }>(`/api/apps/${a.id}`, body);
      setApp(app);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  return (
    <div className="mx-auto max-w-[1120px] px-8 py-10">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-10">
          <section>
            <h2 className="text-[22px] font-semibold tracking-[-0.015em]">Add an app</h2>
            <p className="mt-1 text-[15px] text-secondary">The build participants use during tasks. Hosted builds are instrumented automatically.</p>
            <AddApp onAdded={(a) => { setApp(a); }} />
          </section>

          <section>
            <h2 className="text-[22px] font-semibold tracking-[-0.015em]">Builds</h2>
            {apps.length === 0 ? (
              <p className="mt-3 rounded-[18px] bg-surface px-5 py-8 text-center text-[15px] text-secondary ring-1 ring-black/[0.04]">No apps yet. Interview-only studies can run without one.</p>
            ) : (
              <Group className="mt-3">
                {apps.map((a) => (
                  <AppRow key={a.id} a={a} usedBy={detail.variants.filter((v) => v.appId === a.id).map((v) => v.name)} onLog={() => setLogApp(a)} onOpen={() => setOpenApp(a)} onRebuild={() => rebuild(a)} onDelete={() => remove(a)} onProxy={(proxy) => patch(a, { proxy })} onSettings={() => setSettingsApp(a)} />
                ))}
              </Group>
            )}
          </section>
        </div>

        <aside className="space-y-6 text-[13px] leading-relaxed text-secondary">
          <div>
            <h3 className="text-[15px] font-semibold text-label">Supported projects</h3>
            <dl className="mt-3 space-y-3">
              {[
                ['Vite', 'React, Vue, Svelte. We run the build script and serve dist/.'],
                ['Create React App', 'Built with react-scripts and served from build/.'],
                ['Next.js', 'Static export when output is "export". Apps with route handlers, server actions or redirects run as a server (next start).'],
                ['Remix, React Router, Nuxt, Node', 'Run as a server app with the start script. SPA mode (ssr: false) is served as static files.'],
                ['Expo / React Native', 'Exported for the web via react-native-web (npx expo export -p web).'],
                ['Prebuilt static', 'Zip a folder that contains index.html and we serve it as is.'],
              ].map(([t, d]) => (
                <div key={t}>
                  <dt className="font-medium text-label">{t}</dt>
                  <dd>{d}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="border-t border-separator pt-5">
            <h3 className="text-[15px] font-semibold text-label">Tips</h3>
            <ul className="mt-2 list-disc space-y-1.5 pl-4">
              <li>Leave out node_modules. We install dependencies.</li>
              <li>Set VITE_*, EXPO_PUBLIC_* or NEXT_PUBLIC_* values under Build settings.</li>
              <li>Absolute asset paths like /assets/… work.</li>
              <li>Client-side routing is supported through an SPA fallback.</li>
              <li>Use mock data or a test account. Participants will see real data.</li>
            </ul>
          </div>
        </aside>
      </div>

      <LogModal app={logApp} onClose={() => setLogApp(null)} />
      <OpenModal app={openApp} onClose={() => setOpenApp(null)} />
      <SettingsModal app={settingsApp} onClose={() => setSettingsApp(null)} onSaved={(a, rebuilt) => { setApp(a); toast(rebuilt ? 'Saved. Rebuilding…' : 'Build settings saved'); }} />
    </div>
  );
}

function AppRow({ a, usedBy, onLog, onOpen, onRebuild, onDelete, onProxy, onSettings }: { a: App; usedBy: string[]; onLog: () => void; onOpen: () => void; onRebuild: () => void; onDelete: () => void; onProxy: (v: boolean) => void; onSettings: () => void }) {
  const toast = useToast();
  const st = STATUS[a.status] ?? STATUS.queued;
  const [snippet, setSnippet] = useState<string | null>(null);
  useEffect(() => {
    if (a.sourceKind === 'url' && !a.proxy) api.get<{ html: string }>(`/api/apps/${a.id}/snippet`).then((r) => setSnippet(r.html), () => setSnippet(null));
  }, [a.id, a.sourceKind, a.proxy]);
  const source = a.sourceKind === 'upload' ? 'Uploaded .zip' : a.sourceKind === 'git' ? a.sourceUrl : a.sourceUrl;
  return (
    <div className="px-4 py-3.5" data-testid="app-row">
      <div className="flex items-center gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[15px] font-medium text-label">{a.name}</span>
            {usedBy.length > 0 && <span className="text-[12px] text-tertiary">Variant {usedBy.join(', ')}</span>}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[13px] text-secondary">
            <span className="inline-flex items-center gap-1.5"><span className={cn('size-2 rounded-full', st.dot)} />{st.label}</span>
            {a.sourceKind !== 'url' && <span>{FRAMEWORK[a.framework] ?? a.framework}</span>}
            {a.status === 'ready' && a.runtime && <span className={cn(a.runtime.state === 'failed' && 'text-[#d70015]')} title={a.runtime.error}>{RUNTIME[a.runtime.state] ?? a.runtime.state}</span>}
            <span className="max-w-[320px] truncate">{source}</span>
            <span className="text-tertiary">{timeAgo(a.updatedAt)}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {a.status === 'ready' && a.url && <Button size="sm" variant="secondary" onClick={onOpen}>Open</Button>}
          {a.sourceKind !== 'url' && <Button size="sm" variant="ghost" icon={<ScrollText className="size-3.5" />} onClick={onLog}>Log</Button>}
          <Menu align="right" trigger={({ toggle }) => <button onClick={toggle} className="rounded-full p-1.5 text-secondary hover:bg-black/[0.05]" aria-label="More"><MoreHorizontal className="size-4" /></button>}>
            {(close) => (
              <>
                {a.url && <MenuItem icon={<ExternalLink className="size-4" />} onClick={() => { close(); window.open(a.url, '_blank'); }}>Open in new tab</MenuItem>}
                {a.sourceKind !== 'url' && <MenuItem icon={<SlidersHorizontal className="size-4" />} onClick={() => { close(); onSettings(); }}>Build settings</MenuItem>}
                {a.sourceKind !== 'url' && <MenuItem icon={<RefreshCw className="size-4" />} onClick={() => { close(); onRebuild(); }}>Rebuild</MenuItem>}
                <MenuItem danger icon={<Trash2 className="size-4" />} onClick={() => { close(); onDelete(); }}>Delete</MenuItem>
              </>
            )}
          </Menu>
        </div>
      </div>
      {a.status === 'failed' && a.error && (
        <button onClick={onLog} className="mt-2.5 block w-full truncate rounded-[10px] bg-sys-red/[0.06] px-3 py-2 text-left font-mono text-[12px] text-[#d70015]" title="Show full log">
          {a.error.split('\n').filter(Boolean).slice(-1)[0]}
        </button>
      )}
      {a.status === 'building' && (
        <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-fill"><div className="h-full w-1/3 animate-[ta-indeterminate_1.4s_ease-in-out_infinite] rounded-full bg-brand-500" /></div>
      )}
      {a.sourceKind === 'url' && (
        <div className="mt-3 space-y-3 rounded-[12px] bg-canvas p-3">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-label">Serve through ThinkAloud proxy</div>
              <div className="text-[12px] text-secondary">Instruments the site without code changes. Turn off if the site blocks proxies, then add the snippet below.</div>
            </div>
            <Switch checked={!!a.proxy} onChange={onProxy} label="Proxy" />
          </div>
          {!a.proxy && (
            <div>
              <div className="mb-1 text-[12px] text-secondary">Add this to the &lt;head&gt; of your site to record clicks, navigation and replays:</div>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-[8px] bg-white px-2.5 py-1.5 font-mono text-[12px] text-label ring-1 ring-black/[0.06]">{snippet ?? 'Loading…'}</code>
                <Button size="sm" variant="secondary" disabled={!snippet} onClick={() => { void copy(snippet!); toast('Snippet copied'); }}>Copy</Button>
              </div>
            </div>
          )}
        </div>
      )}
      <style>{`@keyframes ta-indeterminate { 0% { transform: translateX(-100%) } 100% { transform: translateX(300%) } }`}</style>
    </div>
  );
}

function AddApp({ onAdded }: { onAdded: (a: App) => void }) {
  const { detail } = useStudy();
  const toast = useToast();
  const [src, setSrc] = useState<Source>('upload');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [proxy, setProxy] = useState(true);
  const [gitUrl, setGitUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [subdir, setSubdir] = useState('');
  const [envText, setEnvText] = useState('');
  const [showEnv, setShowEnv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const studyId = detail.study.id;
  const defaultName = () => name.trim() || `Build ${detail.apps.length + 1}`;

  const upload = (file: File) => {
    if (!/\.zip$/i.test(file.name)) return setErr('Please choose a .zip file.');
    const parsed = parseEnv(envText);
    if (parsed.error) return setErr(`Environment variables: ${parsed.error}`);
    setErr('');
    const fd = new FormData();
    fd.append('name', name.trim() || file.name.replace(/\.zip$/i, ''));
    if (Object.keys(parsed.env).length) fd.append('env', JSON.stringify(parsed.env));
    fd.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/studies/${studyId}/apps`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => e.lengthComputable && setProgress(e.loaded / e.total);
    xhr.onload = () => {
      setProgress(null);
      try {
        const j = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) {
          onAdded(j.app);
          setName('');
          setEnvText('');
          toast('Upload complete. Building…');
        } else setErr(j.error || `Upload failed (${xhr.status})`);
      } catch {
        setErr(`Upload failed (${xhr.status})`);
      }
    };
    xhr.onerror = () => {
      setProgress(null);
      setErr('Upload failed. Check your connection.');
    };
    setProgress(0);
    xhr.send(fd);
  };

  const submitJson = async () => {
    setErr('');
    if (src === 'url' && !/^https?:\/\//i.test(url.trim())) return setErr('Enter a full URL starting with https://');
    if (src === 'git' && !gitUrl.trim()) return setErr('Enter a repository URL.');
    const parsed = parseEnv(envText);
    if (src === 'git' && parsed.error) return setErr(`Environment variables: ${parsed.error}`);
    setBusy(true);
    try {
      const env = Object.keys(parsed.env).length ? parsed.env : undefined;
      const body = src === 'url' ? { name: defaultName(), url: url.trim(), proxy } : { name: defaultName(), gitUrl: gitUrl.trim(), branch: branch.trim() || undefined, subdir: subdir.trim() || undefined, env };
      const { app } = await api.post<{ app: App }>(`/api/studies/${studyId}/apps`, body);
      onAdded(app);
      setName('');
      setUrl('');
      setGitUrl('');
      if (src === 'git') setEnvText('');
      toast(src === 'url' ? 'App added' : 'Cloning and building…');
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 rounded-[18px] bg-surface p-5 ring-1 ring-black/[0.04]">
      <Segmented<Source> value={src} onChange={(v) => { setSrc(v); setErr(''); }} options={[{ value: 'upload', label: 'Upload .zip' }, { value: 'url', label: 'Website URL' }, { value: 'git', label: 'Git repository' }]} />
      <div className="mt-5 space-y-4">
        {src === 'upload' && (
          <>
            <div
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                const f = e.dataTransfer.files[0];
                if (f) upload(f);
              }}
              onClick={() => progress == null && fileRef.current?.click()}
              className={cn('flex cursor-pointer flex-col items-center justify-center rounded-[14px] border-[1.5px] border-dashed px-6 py-10 text-center transition-colors duration-200', drag ? 'border-brand-500 bg-brand-500/[0.04]' : 'border-black/15 hover:border-black/25 hover:bg-black/[0.015]')}
              data-testid="dropzone"
            >
              {progress != null ? (
                <div className="w-full max-w-xs">
                  <div className="text-[15px] font-medium text-label">Uploading… {Math.round(progress * 100)}%</div>
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-fill"><div className="h-full rounded-full bg-brand-500 transition-[width] duration-200" style={{ width: `${progress * 100}%` }} /></div>
                </div>
              ) : (
                <>
                  <FileArchive className="size-7 text-tertiary" strokeWidth={1.5} />
                  <div className="mt-3 text-[15px] font-medium text-label">Drop a .zip of your project</div>
                  <div className="mt-1 text-[13px] text-secondary">or <span className="text-brand-500">choose a file</span>. Source project or a built dist/ folder.</div>
                </>
              )}
              <input ref={fileRef} type="file" accept=".zip,application/zip" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
            </div>
            <Field label="Name" hint="Optional. Defaults to the file name."><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Checkout v2" /></Field>
          </>
        )}
        {src === 'url' && (
          <>
            <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
              <Field label="URL"><Input name="app-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://staging.example.com" /></Field>
              <Field label="Name"><Input name="app-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={`Build ${detail.apps.length + 1}`} /></Field>
            </div>
            <div className="flex items-center gap-3 rounded-[12px] bg-canvas px-3 py-2.5">
              <div className="flex-1">
                <div className="text-[13px] font-medium">Serve through ThinkAloud proxy</div>
                <div className="text-[12px] text-secondary">Recommended. Records clicks and replays without changing your site.</div>
              </div>
              <Switch checked={proxy} onChange={setProxy} label="Proxy" />
            </div>
            <Button onClick={submitJson} loading={busy} data-testid="add-url">Add website</Button>
          </>
        )}
        {src === 'git' && (
          <>
            <Field label="Repository URL" hint="Public HTTPS URL. For private repositories, include a read-only token in the URL.">
              <Input value={gitUrl} onChange={(e) => setGitUrl(e.target.value)} placeholder="https://github.com/acme/shop.git" />
            </Field>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Branch"><Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" /></Field>
              <Field label="Subdirectory"><Input value={subdir} onChange={(e) => setSubdir(e.target.value)} placeholder="apps/web" /></Field>
              <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={`Build ${detail.apps.length + 1}`} /></Field>
            </div>
            <Button onClick={submitJson} loading={busy} icon={<Upload className="size-4" />}>Clone and build</Button>
          </>
        )}
        {src !== 'url' && (
          <div>
            {showEnv ? (
              <Field label="Environment variables" hint="One KEY=value per line, used at build time (and at runtime for server apps). For example VITE_API_URL, EXPO_PUBLIC_*, NEXT_PUBLIC_*.">
                <Textarea value={envText} onChange={(e) => setEnvText(e.target.value)} placeholder={'VITE_API_URL=https://staging.example.com'} spellCheck={false} className="font-mono text-[12px]" data-testid="env-input" />
              </Field>
            ) : (
              <button type="button" onClick={() => setShowEnv(true)} className="text-[13px] text-brand-500 hover:underline">Add environment variables</button>
            )}
          </div>
        )}
        {err && <Callout tone="error" icon={<AlertCircle className="size-4" />}>{err}</Callout>}
      </div>
    </div>
  );
}

function LogModal({ app, onClose }: { app: App | null; onClose: () => void }) {
  const [log, setLog] = useState('');
  const [status, setStatus] = useState(app?.status);
  const pre = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  const load = async () => {
    if (!app) return;
    try {
      const res = await fetch(`/api/apps/${app.id}/log`, { credentials: 'include' });
      setLog(res.ok ? await res.text() : `Log unavailable (${res.status})`);
      const { app: a } = await api.get<{ app: App }>(`/api/apps/${app.id}`);
      setStatus(a.status);
    } catch {
      /* ignore */
    }
  };
  useEffect(() => {
    setLog('');
    setStatus(app?.status);
    stick.current = true;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app?.id]);
  useInterval(load, app && (status === 'queued' || status === 'building') ? 1500 : null);
  useEffect(() => {
    if (stick.current && pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [log]);
  return (
    <Modal open={!!app} onClose={onClose} width="max-w-4xl" title={<span className="flex items-center gap-3">Build log <span className="inline-flex items-center gap-1.5 text-[13px] font-normal text-secondary"><span className={cn('size-2 rounded-full', STATUS[status ?? 'queued']?.dot)} />{STATUS[status ?? 'queued']?.label}</span></span>}>
      <pre
        ref={pre}
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}
        className="h-[60vh] overflow-auto whitespace-pre-wrap rounded-[14px] bg-[#1d1d1f] p-4 font-mono text-[12px] leading-relaxed text-white/85"
      >
        {log || (status === 'queued' ? 'Waiting for a build slot…' : <Spinner className="text-white/50" />)}
      </pre>
    </Modal>
  );
}

function OpenModal({ app, onClose }: { app: App | null; onClose: () => void }) {
  const [k, setK] = useState(0);
  return (
    <Modal open={!!app} onClose={onClose} width="max-w-6xl" title={app?.name}>
      {app?.url && (
        <div className="overflow-hidden rounded-[14px] ring-1 ring-black/[0.08]">
          <div className="flex items-center gap-2 border-b border-separator bg-canvas px-3 py-2">
            <button onClick={() => setK((x) => x + 1)} className="rounded-full p-1 text-secondary hover:bg-black/[0.05]" aria-label="Reload"><RefreshCw className="size-3.5" /></button>
            <span className="min-w-0 flex-1 truncate rounded-full bg-white px-3 py-1 text-center text-[12px] text-secondary ring-1 ring-black/[0.06]">{app.url}</span>
            <a href={app.url} target="_blank" rel="noreferrer" className="rounded-full p-1 text-secondary hover:bg-black/[0.05]" aria-label="Open in new tab"><ExternalLink className="size-3.5" /></a>
          </div>
          <iframe key={k} src={app.url} title={app.name} className="h-[68vh] w-full bg-white" />
        </div>
      )}
    </Modal>
  );
}

function SettingsModal({ app, onClose, onSaved }: { app: App | null; onClose: () => void; onSaved: (a: App, rebuilt: boolean) => void }) {
  const [envText, setEnvText] = useState('');
  const [mode, setMode] = useState<'auto' | 'static' | 'server'>('auto');
  const [buildCommand, setBuildCommand] = useState('');
  const [outputDir, setOutputDir] = useState('');
  const [startCommand, setStartCommand] = useState('');
  const [nodeVersion, setNodeVersion] = useState('');
  const [busy, setBusy] = useState<false | 'save' | 'rebuild'>(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    const fill = (b: AppBuildSettings) => {
      setEnvText(formatEnv(b.env));
      setMode(b.mode ?? 'auto');
      setBuildCommand(b.buildCommand ?? '');
      setOutputDir(b.outputDir ?? '');
      setStartCommand(b.startCommand ?? '');
      setNodeVersion(b.nodeVersion ?? '');
    };
    setErr('');
    fill(app?.buildSettings ?? {});
    // The study payload does not carry build settings: load them from the app itself.
    if (app) api.get<{ app: App }>(`/api/apps/${app.id}`).then(({ app: a }) => fill(a.buildSettings ?? {}), () => {});
  }, [app?.id]);
  const isServer = mode === 'server' || (mode === 'auto' && (app?.framework === 'next-server' || app?.framework === 'node-server'));
  const save = async (rebuild: boolean) => {
    if (!app) return;
    const parsed = parseEnv(envText);
    if (parsed.error) return setErr(`Environment variables: ${parsed.error}`);
    setErr('');
    setBusy(rebuild ? 'rebuild' : 'save');
    try {
      const body = { env: parsed.env, mode, buildCommand: buildCommand.trim() || null, outputDir: outputDir.trim() || null, startCommand: startCommand.trim() || null, nodeVersion: nodeVersion.trim() || null };
      let { app: next } = await api.patch<{ app: App }>(`/api/apps/${app.id}`, body);
      if (rebuild) next = (await api.post<{ app?: App }>(`/api/apps/${app.id}/rebuild`)).app ?? { ...next, status: 'queued' };
      onSaved(next, rebuild);
      onClose();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={!!app}
      onClose={onClose}
      width="max-w-2xl"
      title="Build settings"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="secondary" loading={busy === 'save'} disabled={!!busy} onClick={() => save(false)}>Save</Button>
          <Button loading={busy === 'rebuild'} disabled={!!busy} onClick={() => save(true)} data-testid="save-rebuild">Save and rebuild</Button>
        </div>
      }
    >
      <div className="space-y-5">
        <Field label="Environment variables" hint="One KEY=value per line. Available to the build, and to the server for server apps. Values are not written to the build log.">
          <Textarea value={envText} onChange={(e) => setEnvText(e.target.value)} placeholder={'VITE_API_URL=https://staging.example.com\nEXPO_PUBLIC_SUPABASE_URL=…'} spellCheck={false} className="min-h-[120px] font-mono text-[12px]" data-testid="settings-env" />
        </Field>
        <Field label="Hosting" hint="Auto detects the framework. Server runs the app with its start script, for SSR and API routes.">
          <Segmented<'auto' | 'static' | 'server'> value={mode} onChange={setMode} options={[{ value: 'auto', label: 'Auto' }, { value: 'static', label: 'Static files' }, { value: 'server', label: 'Server' }]} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Build command" hint="Replaces the framework build. Dependencies are installed first."><Input value={buildCommand} onChange={(e) => setBuildCommand(e.target.value)} placeholder="npm run build" spellCheck={false} className="font-mono text-[13px]" /></Field>
          {isServer ? (
            <Field label="Start command" hint="Must listen on $PORT."><Input value={startCommand} onChange={(e) => setStartCommand(e.target.value)} placeholder="npm run start" spellCheck={false} className="font-mono text-[13px]" /></Field>
          ) : (
            <Field label="Output folder" hint="Folder with index.html after the build."><Input value={outputDir} onChange={(e) => setOutputDir(e.target.value)} placeholder="dist" spellCheck={false} className="font-mono text-[13px]" /></Field>
          )}
          <Field label="Node.js version" hint="Default: .nvmrc or engines.node, else 22."><Input value={nodeVersion} onChange={(e) => setNodeVersion(e.target.value)} placeholder="22" inputMode="numeric" className="font-mono text-[13px]" /></Field>
        </div>
        {err && <Callout tone="error" icon={<AlertCircle className="size-4" />}>{err}</Callout>}
      </div>
    </Modal>
  );
}
