import { useCallback, useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router';
import { AlertTriangle, ChevronDown, ChevronRight, Eye, MoreHorizontal, Pause, Play, Rocket, Square, Trash2 } from 'lucide-react';
import type { StudyStatus } from '@thinkaloud/shared';
import { useAsync } from '../../lib/hooks.ts';
import { Button, cn, FullPageSpinner, Modal } from '../../ui/index.tsx';
import { useToast } from '../../ui/toast.tsx';
import { Callout, InlineEdit, Menu, MenuItem, StatusBadge } from '../components/index.tsx';
import { errorDetails, errorMessage, rApi, type StudyDetail } from '../lib.ts';
import { notifyStudiesChanged } from '../AppShell.tsx';
import { StudyContext, useStudy as useStudyCtx } from './StudyContext.tsx';

export default function StudyLayout() {
  const { studyId = '' } = useParams();
  const { data, error, loading, reload, setData } = useAsync(() => rApi.study(studyId), [studyId]);
  const update = useCallback((fn: (d: StudyDetail) => StudyDetail) => setData((d) => (d ? fn(d) : d)), [setData]);
  const ctx = useMemo(() => (data ? { detail: data, reload, update } : null), [data, reload, update]);

  if (loading && !data) return <FullPageSpinner />;
  if (error || !ctx)
    return (
      <div className="mx-auto max-w-xl px-6 py-20">
        <Callout tone="error" title="Study not found" icon={<AlertTriangle className="size-4" />}>
          {error ? errorMessage(error) : 'This study does not exist or you do not have access.'}{' '}
          <Link className="underline" to="/studies">Back to studies</Link>
        </Callout>
      </div>
    );

  return (
    <StudyContext.Provider value={ctx}>
      <div className="flex min-h-screen flex-col">
        <StudyHeader />
        <div className="flex-1">
          <Outlet />
        </div>
      </div>
    </StudyContext.Provider>
  );
}

const TABS = [
  { to: '', label: 'Overview', end: true },
  { to: 'protocols', label: 'Protocol' },
  { to: 'apps', label: 'App builds' },
  { to: 'variants', label: 'Variants' },
  { to: 'recruit', label: 'Recruit' },
  { to: 'results', label: 'Results' },
];

function StudyHeader() {
  const { detail, update, reload } = useStudyCtx();
  const { study, variants, links, apps, protocols } = detail;
  const toast = useToast();
  const nav = useNavigate();
  const loc = useLocation();
  const [busy, setBusy] = useState<StudyStatus | null>(null);
  const [issues, setIssues] = useState<{ title: string; items: string[] } | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const base = `/studies/${study.id}`;

  const setStatus = async (status: StudyStatus) => {
    setBusy(status);
    try {
      const { study: s } = await rApi.patchStudy(study.id, { status });
      update((d) => ({ ...d, study: s }));
      notifyStudiesChanged();
      toast(status === 'live' ? 'Study is live. Share your link from Recruit.' : status === 'paused' ? 'Study paused. New participants cannot join.' : status === 'closed' ? 'Study closed' : 'Status updated');
    } catch (e) {
      const items = errorDetails(e);
      setIssues({ title: status === 'live' ? 'Your study is not ready to go live' : 'Could not change status', items: items.length ? items : [errorMessage(e)] });
    } finally {
      setBusy(null);
    }
  };

  const rename = async (name: string) => {
    update((d) => ({ ...d, study: { ...d.study, name } }));
    try {
      await rApi.patchStudy(study.id, { name });
      notifyStudiesChanged();
    } catch (e) {
      toast(errorMessage(e), 'error');
      void reload();
    }
  };

  const preview = async (variantId?: string) => {
    // Open synchronously to avoid popup blockers, then navigate.
    const w = window.open('about:blank', '_blank');
    try {
      const { url } = await rApi.previewUrl(study.id, variantId);
      if (w) w.location.href = url;
      else window.open(url, '_blank');
    } catch (e) {
      w?.close();
      toast(errorMessage(e), 'error');
    }
  };

  const activeVariants = variants.filter((v) => v.active);
  const tabCounts: Record<string, number | undefined> = { protocols: protocols.length, apps: apps.length, variants: variants.length, recruit: links.length };

  return (
    <div className="bg-canvas">
      <div className="mx-auto max-w-[1120px] px-8 pt-8">
        <div className="flex items-center gap-1 text-[13px] text-secondary">
          <Link to="/studies" className="text-brand-500 hover:underline">Studies</Link>
          <ChevronRight className="size-3.5 text-tertiary" />
          <span className="truncate">{study.name}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <InlineEdit value={study.name} onSave={rename} className="-ml-1.5 max-w-[50vw] text-[34px] font-bold leading-tight tracking-[-0.022em] text-label" inputClassName="-ml-1.5 text-[34px] font-bold leading-tight tracking-[-0.022em]" />
            <StatusBadge status={study.status} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {activeVariants.length > 1 ? (
              <Menu
                align="right"
                trigger={({ toggle }) => (
                  <Button variant="secondary" size="sm" icon={<Eye className="size-4" />} onClick={toggle}>
                    Preview <ChevronDown className="size-3.5" />
                  </Button>
                )}
              >
                {(close) =>
                  activeVariants.map((v) => (
                    <MenuItem key={v.id} onClick={() => { close(); void preview(v.id); }} description={protocols.find((p) => p.id === v.protocolId)?.name}>
                      Preview {v.name}
                    </MenuItem>
                  ))
                }
              </Menu>
            ) : (
              <Button variant="secondary" size="sm" icon={<Eye className="size-4" />} onClick={() => preview(activeVariants[0]?.id)} title="Run the participant session yourself. Preview sessions are excluded from results.">
                Preview
              </Button>
            )}
            {study.status === 'draft' && (
              <Button size="sm" icon={<Rocket className="size-4" />} loading={busy === 'live'} onClick={() => setStatus('live')} data-testid="go-live">Go live</Button>
            )}
            {study.status === 'live' && (
              <>
                <Button variant="secondary" size="sm" icon={<Pause className="size-4" />} loading={busy === 'paused'} onClick={() => setStatus('paused')}>Pause</Button>
                <Button variant="secondary" size="sm" icon={<Square className="size-3.5" />} onClick={() => setConfirmClose(true)}>Close</Button>
              </>
            )}
            {study.status === 'paused' && (
              <>
                <Button size="sm" icon={<Play className="size-4" />} loading={busy === 'live'} onClick={() => setStatus('live')}>Resume</Button>
                <Button variant="secondary" size="sm" icon={<Square className="size-3.5" />} onClick={() => setConfirmClose(true)}>Close</Button>
              </>
            )}
            {study.status === 'closed' && (
              <Button variant="secondary" size="sm" icon={<Play className="size-4" />} loading={busy === 'live'} onClick={() => setStatus('live')}>Reopen</Button>
            )}
            <Menu align="right" trigger={({ toggle }) => <button onClick={toggle} aria-label="More" className="grid size-7 place-items-center rounded-full bg-fill text-label transition-colors hover:bg-black/[0.07]"><MoreHorizontal className="size-4" /></button>}>
              {(close) => (
                <>
                  {study.status !== 'draft' && <MenuItem icon={<Square className="size-4" />} onClick={() => { close(); void setStatus('draft'); }} description="Back to editing mode">Move to draft</MenuItem>}
                  <MenuItem danger icon={<Trash2 className="size-4" />} onClick={() => { close(); setConfirmDelete(true); }}>Delete study</MenuItem>
                </>
              )}
            </Menu>
          </div>
        </div>
      </div>
      <nav className="mx-auto mt-5 flex max-w-[1120px] gap-1 overflow-x-auto px-8 pb-1">
        {TABS.map((t) => {
          const to = t.to ? `${base}/${t.to}` : base;
          const active = t.end ? loc.pathname === base || loc.pathname === base + '/' : loc.pathname.startsWith(to);
          return (
            <NavLink
              key={t.label}
              to={to}
              end={t.end}
              className={cn('whitespace-nowrap rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors duration-200', active ? 'bg-label text-white' : 'text-secondary hover:bg-black/[0.05] hover:text-label')}
            >
              {t.label}
              {tabCounts[t.to] != null && <span className={cn('ml-1.5 tabular-nums', active ? 'text-white/60' : 'text-tertiary')}>{tabCounts[t.to]}</span>}
            </NavLink>
          );
        })}
      </nav>

      <Modal
        open={!!issues}
        onClose={() => setIssues(null)}
        title={issues?.title}
        footer={<Button onClick={() => setIssues(null)}>OK</Button>}
      >
        <p className="text-[15px] text-secondary">Fix these, then try again.</p>
        <ul className="mt-3 space-y-2">
          {issues?.items.map((m, i) => (
            <li key={i} className="flex items-start gap-2.5 text-[14px] text-label">
              <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-sys-orange" /> {m}
            </li>
          ))}
        </ul>
        <div className="mt-5 flex flex-wrap gap-4 text-[14px]">
          {[['protocols', 'Open protocol'], ['apps', 'Open app builds'], ['variants', 'Open variants']].map(([to, l]) => (
            <Link key={to} to={`${base}/${to}`} onClick={() => setIssues(null)} className="inline-flex items-center gap-0.5 text-brand-500 hover:underline">
              {l} <ChevronRight className="size-3.5" />
            </Link>
          ))}
        </div>
      </Modal>

      <Modal
        open={confirmClose}
        onClose={() => setConfirmClose(false)}
        title="Close this study?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmClose(false)}>Cancel</Button>
            <Button variant="danger" onClick={() => { setConfirmClose(false); void setStatus('closed'); }}>Close study</Button>
          </>
        }
      >
        <p className="text-[15px] leading-relaxed text-secondary">Links stop accepting new participants. Sessions in progress can finish, and all results stay available. You can reopen it later.</p>
      </Modal>

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete study?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={async () => {
                try {
                  await rApi.deleteStudy(study.id);
                  notifyStudiesChanged();
                  toast('Study deleted');
                  nav('/studies');
                } catch (e) {
                  toast(errorMessage(e), 'error');
                }
              }}
            >
              Delete permanently
            </Button>
          </>
        }
      >
        <p className="text-[15px] leading-relaxed text-secondary">This permanently deletes <b>{study.name}</b>, including protocols, app builds, links and every session recording. This cannot be undone.</p>
      </Modal>
    </div>
  );
}
