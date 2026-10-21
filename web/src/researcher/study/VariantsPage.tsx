import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { Variant } from '@thinkaloud/shared';
import { api } from '../../lib/api.ts';
import { Button, cn, Select } from '../../ui/index.tsx';
import { useToast } from '../../ui/toast.tsx';
import { InlineEdit, Switch } from '../components/index.tsx';
import { errorMessage } from '../lib.ts';
import { useStudy } from './StudyContext.tsx';

const COLORS = ['bg-brand-500', 'bg-sys-teal', 'bg-sys-green', 'bg-sys-orange', 'bg-sys-indigo', 'bg-sys-pink'];

export default function VariantsPage() {
  const { detail, update } = useStudy();
  const { variants, protocols, apps } = detail;
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const active = variants.filter((v) => v.active);
  const totalW = active.reduce((s, v) => s + (v.weight || 0), 0);
  const share = (v: Variant) => (v.active && totalW > 0 ? v.weight / totalW : 0);

  const patch = async (v: Variant, body: Partial<Pick<Variant, 'name' | 'protocolId' | 'appId' | 'weight' | 'active' | 'appParams'>>) => {
    update((d) => ({ ...d, variants: d.variants.map((x) => (x.id === v.id ? { ...x, ...body } : x)) }));
    try {
      const r = await api.patch<{ variant?: Variant }>(`/api/variants/${v.id}`, body);
      if (r.variant) update((d) => ({ ...d, variants: d.variants.map((x) => (x.id === v.id ? r.variant! : x)) }));
    } catch (e) {
      toast(errorMessage(e), 'error');
      update((d) => ({ ...d, variants: d.variants.map((x) => (x.id === v.id ? v : x)) }));
    }
  };
  const add = async () => {
    setAdding(true);
    try {
      const letter = String.fromCharCode(65 + variants.length);
      const last = variants[variants.length - 1];
      const { variant } = await api.post<{ variant: Variant }>(`/api/studies/${detail.study.id}/variants`, { name: letter, protocolId: last?.protocolId ?? protocols[0]?.id, appId: last?.appId ?? undefined, weight: 1 });
      update((d) => ({ ...d, variants: [...d.variants, variant] }));
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setAdding(false);
    }
  };
  const remove = async (v: Variant) => {
    try {
      await api.del(`/api/variants/${v.id}`);
      update((d) => ({ ...d, variants: d.variants.filter((x) => x.id !== v.id) }));
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  return (
    <div className="mx-auto max-w-[1120px] px-8 py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl">
          <h2 className="text-[22px] font-semibold tracking-[-0.015em]">Variants</h2>
          <p className="mt-1 text-[15px] leading-relaxed text-secondary">
            Each participant is assigned to exactly one active variant (between-subjects). Auto-assign links keep groups balanced by weight. To compare designs, give each variant a different app build. To compare wording, give each a different protocol. To switch a feature flag or condition in the same build, set launch parameters (added to the app URL).
          </p>
        </div>
        <Button variant="secondary" icon={<Plus className="size-4" />} loading={adding} onClick={add} disabled={!protocols.length}>Add variant</Button>
      </div>

      {active.length > 0 && (
        <div className="mt-8">
          <div className="flex h-2 overflow-hidden rounded-full bg-fill">
            {active.map((v) => (
              <div key={v.id} className={cn('h-full transition-[width] duration-300 ease-apple', COLORS[variants.indexOf(v) % COLORS.length])} style={{ width: `${share(v) * 100}%` }} />
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-secondary">
            {active.map((v) => (
              <span key={v.id} className="inline-flex items-center gap-1.5">
                <span className={cn('size-2 rounded-full', COLORS[variants.indexOf(v) % COLORS.length])} /> {v.name} <span className="tabular-nums text-tertiary">{Math.round(share(v) * 100)}%</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="mt-6 overflow-hidden rounded-[18px] bg-surface ring-1 ring-black/[0.04]">
        <div className="hidden grid-cols-[minmax(120px,1fr)_minmax(160px,1.2fr)_minmax(160px,1.2fr)_220px_64px_40px] items-center gap-4 border-b border-separator px-5 py-2.5 text-[12px] font-medium text-secondary md:grid">
          <span>Name</span><span>Protocol</span><span>App</span><span>Allocation</span><span>Active</span><span />
        </div>
        {variants.map((v, i) => (
          <div key={v.id} className={cn('grid grid-cols-1 items-center gap-3 px-5 py-3.5 md:grid-cols-[minmax(120px,1fr)_minmax(160px,1.2fr)_minmax(160px,1.2fr)_220px_64px_40px] md:gap-4', i > 0 && 'border-t border-separator', !v.active && 'opacity-55')} data-testid="variant-row">
            <div className="flex items-center gap-2">
              <span className={cn('size-2.5 shrink-0 rounded-full', COLORS[i % COLORS.length])} />
              <InlineEdit value={v.name} onSave={(name) => patch(v, { name })} className="-ml-1.5 text-[15px] font-medium" inputClassName="text-[15px] w-full" />
            </div>
            <Select value={v.protocolId} onChange={(e) => patch(v, { protocolId: e.target.value })} aria-label="Protocol" className="h-9">
              {protocols.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
            <Select value={v.appId ?? ''} onChange={(e) => patch(v, { appId: e.target.value || null })} aria-label="App" className="h-9">
              <option value="">No app (interview only)</option>
              {apps.map((a) => <option key={a.id} value={a.id}>{a.name}{a.status !== 'ready' ? ` (${a.status})` : ''}</option>)}
            </Select>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={10}
                step={1}
                value={v.weight}
                disabled={!v.active}
                onChange={(e) => update((d) => ({ ...d, variants: d.variants.map((x) => (x.id === v.id ? { ...x, weight: Number(e.target.value) } : x)) }))}
                onPointerUp={(e) => patch(v, { weight: Number((e.target as HTMLInputElement).value) })}
                onKeyUp={(e) => patch(v, { weight: Number((e.target as HTMLInputElement).value) })}
                className="w-full accent-brand-500"
                aria-label="Weight"
              />
              <span className="w-16 shrink-0 text-right text-[13px] tabular-nums text-secondary"><span className="font-medium text-label">{Math.round(share(v) * 100)}%</span> · {v.weight}</span>
            </div>
            <Switch checked={v.active} onChange={(active) => patch(v, { active })} label="Active" />
            <button onClick={() => remove(v)} disabled={variants.length <= 1} className="justify-self-end rounded-full p-1.5 text-tertiary hover:bg-sys-red/10 hover:text-sys-red disabled:opacity-30" aria-label="Delete variant" title={variants.length <= 1 ? 'A study needs at least one variant' : 'Delete variant'}>
              <Trash2 className="size-4" />
            </button>
            {v.appId && (
              <label className="flex items-center gap-3 md:col-span-6">
                <span className="shrink-0 text-[12px] font-medium text-secondary">Launch parameters</span>
                <input
                  defaultValue={v.appParams ?? ''}
                  placeholder="e.g. flags=summaryCard:1&theme=dark"
                  onBlur={(e) => e.target.value.trim() !== (v.appParams ?? '') && patch(v, { appParams: e.target.value.trim() })}
                  onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                  className="h-8 min-w-0 flex-1 rounded-[8px] border border-black/10 bg-white px-2.5 font-mono text-[12px] text-label placeholder:text-tertiary focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-brand-500/15"
                  aria-label="Launch parameters"
                />
              </label>
            )}
          </div>
        ))}
      </div>
      {apps.some((a) => a.status !== 'ready') && variants.some((v) => v.appId && apps.find((a) => a.id === v.appId)?.status !== 'ready') && (
        <p className="mt-3 text-[13px] text-[#c93400]">A variant uses an app that is not ready. The study can go live once its build finishes.</p>
      )}

      <div className="mt-10 grid gap-8 text-[13px] leading-relaxed text-secondary md:grid-cols-3">
        <div><div className="text-[15px] font-semibold text-label">Weights</div>Weights are relative. 1 and 1 means a 50/50 split. 2 and 1 sends twice as many people to the first variant. A weight of 0 stops new assignments.</div>
        <div><div className="text-[15px] font-semibold text-label">Balancing</div>Each new participant goes to the variant furthest below its target share, so groups stay balanced even with small samples. Preview and withdrawn sessions do not count.</div>
        <div><div className="text-[15px] font-semibold text-label">Sample size</div>For completion-rate differences, plan for about 20 or more participants per variant. Results flag comparisons that are underpowered.</div>
      </div>
    </div>
  );
}
