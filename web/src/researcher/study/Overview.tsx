import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Check, ChevronRight, Copy } from 'lucide-react';
import { useToast } from '../../ui/toast.tsx';
import { cn, Stat } from '../../ui/index.tsx';
import { timeAgo } from '../../lib/hooks.ts';
import { copy, rApi, type StudySummary } from '../lib.ts';
import { validateProtocol } from '../protocol/validate.ts';
import { useStudy } from './StudyContext.tsx';

type ItemState = 'done' | 'todo' | 'warn';

export default function Overview() {
  const { detail } = useStudy();
  const { study, protocols, apps, variants, links } = detail;
  const toast = useToast();
  const base = `/studies/${study.id}`;
  const [summary, setSummary] = useState<StudySummary | null>(null);
  useEffect(() => {
    rApi.studies().then((r) => setSummary(r.studies.find((s) => s.id === study.id) ?? null), () => {});
  }, [study.id]);

  const active = variants.filter((v) => v.active);
  const usedProtocols = protocols.filter((p) => active.some((v) => v.protocolId === p.id));
  const protoIssues = usedProtocols.flatMap((p) => validateProtocol(p.protocol));
  const protoErrors = protoIssues.filter((i) => i.level === 'error').length;
  const protoWarnings = protoIssues.filter((i) => i.level === 'warning').length;
  const readyApps = apps.filter((a) => a.status === 'ready');
  const variantsWithApp = active.filter((v) => v.appId);
  const appsBlocking = variantsWithApp.filter((v) => apps.find((a) => a.id === v.appId)?.status !== 'ready');
  const activeLinks = links.filter((l) => l.active);
  const sessions = summary?.sessionCount ?? links.reduce((s, l) => s + (l.sessionCount ?? 0), 0);
  const completed = summary?.completedCount ?? 0;
  const firstProtocol = usedProtocols[0] ?? protocols[0];
  const mainLink = activeLinks[0];

  const items: { state: ItemState; title: string; desc: string; to: string; cta: string; icon?: React.ReactNode }[] = [
    {
      state: !usedProtocols.length || protoErrors ? 'todo' : protoWarnings ? 'warn' : 'done',
      title: 'Protocol is ready',
      desc: !usedProtocols.length
        ? 'No active variant uses a protocol yet.'
        : protoErrors
          ? `${protoErrors} problem${protoErrors > 1 ? 's' : ''} to fix before launch.`
          : protoWarnings
            ? `Usable, with ${protoWarnings} methodology warning${protoWarnings > 1 ? 's' : ''} worth a look.`
            : `${usedProtocols.reduce((s, p) => s + p.protocol.steps.length, 0)} steps, about ${firstProtocol?.protocol.estimatedMinutes ?? '?'} min.`,
      to: firstProtocol ? `${base}/protocols/${firstProtocol.id}` : `${base}/protocols`,
      cta: 'Edit protocol',
    },
    {
      state: appsBlocking.length ? 'todo' : variantsWithApp.length ? 'done' : 'warn',
      title: 'App under test is connected',
      desc: appsBlocking.length
        ? `${appsBlocking.length} variant${appsBlocking.length > 1 ? 's use' : ' uses'} an app that is not ready yet.`
        : variantsWithApp.length
          ? `${readyApps.length} ready build${readyApps.length !== 1 ? 's' : ''} assigned.`
          : readyApps.length
            ? 'You have a ready build. Assign it to a variant.'
            : 'Upload a build or add a URL. Skip this for interview-only studies.',
      to: variantsWithApp.length || !readyApps.length ? `${base}/apps` : `${base}/variants`,
      cta: readyApps.length && !variantsWithApp.length ? 'Assign app' : 'Manage apps',
    },
    {
      state: active.length ? 'done' : 'todo',
      title: 'Variants configured',
      desc: active.length > 1 ? `${active.length} active variants, A/B assignment by weight.` : active.length ? 'One variant. Add another to run an A/B comparison.' : 'Activate at least one variant.',
      to: `${base}/variants`,
      cta: 'Variants',
    },
    {
      state: activeLinks.length ? 'done' : 'todo',
      title: 'Recruitment link ready',
      desc: activeLinks.length ? `${activeLinks.length} active link${activeLinks.length > 1 ? 's' : ''}.` : 'Create or activate a link to share.',
      to: `${base}/recruit`,
      cta: 'Recruit',
    },
    {
      state: study.status === 'live' ? 'done' : 'todo',
      title: 'Study is live',
      desc: study.status === 'live' ? 'Accepting participants.' : study.status === 'paused' ? 'Paused: links are not accepting participants.' : study.status === 'closed' ? 'Closed.' : 'Preview it yourself, then use Go live at the top right.',
      to: `${base}/recruit`,
      cta: 'Share link',
    },
  ];
  const doneCount = items.filter((i) => i.state === 'done').length;

  return (
    <div className="mx-auto max-w-[1120px] px-8 pb-16 pt-8">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-10">
          <section>
            <div className="flex items-end justify-between gap-4 px-1">
              <div>
                <h2 className="text-[22px] font-semibold tracking-[-0.015em]">Setup</h2>
                <p className="mt-0.5 text-[13px] text-secondary">{doneCount === items.length ? 'Everything is set. Your study is running.' : `${doneCount} of ${items.length} done`}</p>
              </div>
            </div>
            <div className="mt-3 overflow-hidden rounded-[18px] bg-surface ring-1 ring-black/[0.04]">
              {items.map((it, i) => (
                <Link key={it.title} to={it.to} className={cn('group relative flex items-center gap-4 px-4 py-3 transition-colors hover:bg-black/[0.02]', i > 0 && 'before:absolute before:left-[52px] before:right-0 before:top-0 before:h-px before:bg-separator')}>
                  <span
                    className={cn(
                      'grid size-[22px] shrink-0 place-items-center rounded-full',
                      it.state === 'done' ? 'bg-sys-green text-white' : it.state === 'warn' ? 'ring-[1.5px] ring-sys-orange' : 'ring-[1.5px] ring-black/20',
                    )}
                  >
                    {it.state === 'done' ? <Check className="size-3.5" strokeWidth={3} /> : it.state === 'warn' ? <span className="size-2 rounded-full bg-sys-orange" /> : null}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[15px] text-label">{it.title}</div>
                    <div className="text-[13px] text-secondary">{it.desc}</div>
                  </div>
                  <span className="hidden shrink-0 text-[13px] text-brand-500 sm:inline">{it.cta}</span>
                  <ChevronRight className="size-4 shrink-0 text-tertiary" />
                </Link>
              ))}
            </div>
          </section>

          <section className="grid gap-4 sm:grid-cols-4">
            <Stat label="Sessions" value={sessions} />
            <Stat label="Completed" value={completed} sub={sessions ? `${Math.round((completed / sessions) * 100)}% completion` : undefined} />
            <Stat label="Active variants" value={active.length} />
            <Stat label="Last session" value={<span className="text-[20px]">{summary?.lastSessionAt ? timeAgo(summary.lastSessionAt) : '—'}</span>} />
          </section>

          <section>
            <div className="flex items-end justify-between px-1">
              <h2 className="text-[22px] font-semibold tracking-[-0.015em]">Variants</h2>
              <Link to={`${base}/variants`} className="text-[14px] text-brand-500 hover:underline">Edit</Link>
            </div>
            <div className="mt-3 overflow-hidden rounded-[18px] bg-surface ring-1 ring-black/[0.04]">
              {variants.map((v, i) => {
                const p = protocols.find((x) => x.id === v.protocolId);
                const a = apps.find((x) => x.id === v.appId);
                return (
                  <div key={v.id} className={cn('grid grid-cols-[80px_1fr_1fr] items-center gap-4 px-4 py-3 text-[14px]', i > 0 && 'border-t border-separator', !v.active && 'opacity-50')}>
                    <span className="font-medium">{v.name}</span>
                    <span className="truncate text-secondary">{p?.name ?? 'Missing protocol'}</span>
                    <span className="truncate text-secondary">{a ? `${a.name}${a.status !== 'ready' ? ` (${a.status})` : ''}` : 'No app'}</span>
                  </div>
                );
              })}
            </div>
          </section>
        </div>

        <aside className="space-y-8">
          <div>
            <h3 className="px-1 text-[15px] font-semibold">About</h3>
            <div className="mt-2 rounded-[18px] bg-surface ring-1 ring-black/[0.04]">
              <p className="px-4 py-3 text-[14px] leading-relaxed text-secondary">{study.description || 'No description.'}</p>
              {[
                ['Created', new Date(study.createdAt).toLocaleDateString()],
                ['Updated', timeAgo(study.updatedAt)],
                ...(firstProtocol ? [['Moderation', STYLE_LABEL[firstProtocol.protocol.moderation.style] ?? firstProtocol.protocol.moderation.style], ['Duration', `About ${firstProtocol.protocol.estimatedMinutes} min`]] : []),
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between border-t border-separator px-4 py-2.5 text-[14px]">
                  <span className="text-secondary">{k}</span>
                  <span>{v}</span>
                </div>
              ))}
            </div>
          </div>
          {mainLink && (
            <div>
              <h3 className="px-1 text-[15px] font-semibold">Participant link</h3>
              <p className="px-1 text-[13px] text-secondary">{study.status === 'live' ? mainLink.name : 'Opens once the study is live.'}</p>
              <button
                onClick={() => { void copy(mainLink.url); toast('Link copied'); }}
                className="mt-2 flex w-full items-center gap-2 rounded-[12px] bg-surface px-3 py-2.5 text-left font-mono text-[12px] ring-1 ring-black/[0.04] transition hover:ring-black/10"
              >
                <span className="truncate">{mainLink.url}</span>
                <Copy className="ml-auto size-3.5 shrink-0 text-tertiary" />
              </button>
            </div>
          )}
          <div className="overflow-hidden rounded-[18px] bg-surface ring-1 ring-black/[0.04]">
            {[
              [`${base}/results`, 'Results and replays'],
              [firstProtocol ? `${base}/protocols/${firstProtocol.id}` : `${base}/protocols`, 'Protocol'],
              [`${base}/apps`, 'App builds'],
              [`${base}/recruit`, 'Recruitment links'],
            ].map(([to, l], i) => (
              <Link key={to} to={to} className={cn('flex items-center px-4 py-2.5 text-[14px] transition-colors hover:bg-black/[0.02]', i > 0 && 'border-t border-separator')}>
                {l}
                <ChevronRight className="ml-auto size-4 text-tertiary" />
              </Link>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

const STYLE_LABEL: Record<string, string> = {
  think_aloud_concurrent: 'Concurrent think-aloud',
  think_aloud_retrospective: 'Retrospective think-aloud',
  interview: 'Interview-led',
  unmoderated: 'Unmoderated',
};
