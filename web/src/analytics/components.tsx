import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Download } from 'lucide-react';
import type { Interval, TaskOutcome } from '@thinkaloud/shared';
import { cn } from '../ui/index.tsx';
import { OUTCOME_META } from './format.ts';

export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  size = 'md',
  className,
}: {
  options: { value: T; label: ReactNode }[];
  value: T;
  onChange: (v: T) => void;
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <div className={cn('inline-flex rounded-[9px] bg-black/[0.06] p-[2px]', className)} role="radiogroup">
      {options.map((o) => (
        <button
          key={String(o.value)}
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-[7px] font-medium tabular-nums transition-all duration-200 ease-apple',
            size === 'sm' ? 'px-2.5 py-0.5 text-[12px]' : 'px-3 py-1 text-[13px]',
            value === o.value ? 'bg-white text-label shadow-[0_1px_3px_rgba(0,0,0,.12),0_0_0_0.5px_rgba(0,0,0,.04)]' : 'text-secondary hover:text-label',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function SectionTitle({ title, caption, actions }: { title: ReactNode; caption?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-[22px] font-semibold tracking-[-0.015em] text-label">{title}</h2>
        {caption && <p className="mt-0.5 text-[13px] text-secondary">{caption}</p>}
      </div>
      {actions}
    </div>
  );
}

export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('rounded-[18px] bg-surface shadow-[0_1px_2px_rgba(0,0,0,.04),0_4px_16px_rgba(0,0,0,.04)] ring-1 ring-black/[0.04]', className)}>{children}</div>;
}

export function Dot({ color, className }: { color: string; className?: string }) {
  return <span className={cn('inline-block size-2 shrink-0 rounded-full', className)} style={{ background: color }} />;
}

/** Horizontal bar to the estimate with a thin CI whisker; domain [0, max]. */
export function CIBar({ ci, color, max = 1, width = 120 }: { ci: Interval | null; color: string; max?: number; width?: number }) {
  if (!ci) return <div className="h-1.5 rounded-full bg-fill" style={{ width }} />;
  const x = (v: number) => `${Math.max(0, Math.min(1, v / max)) * 100}%`;
  return (
    <div className="relative h-3" style={{ width }} title={`${(ci.low * 100).toFixed(0)}–${(ci.high * 100).toFixed(0)} (${Math.round(ci.level * 100)}% CI)`}>
      <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-fill" />
      <div className="absolute left-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full" style={{ width: x(ci.estimate), background: color }} />
      <div className="absolute top-1/2 h-px -translate-y-1/2 bg-label/70" style={{ left: x(ci.low), width: `calc(${x(ci.high)} - ${x(ci.low)})` }} />
      <div className="absolute top-[3px] h-[6px] w-px bg-label/70" style={{ left: x(ci.low) }} />
      <div className="absolute top-[3px] h-[6px] w-px bg-label/70" style={{ left: x(ci.high) }} />
    </div>
  );
}

/** Stacked outcome bar (counts). */
export function OutcomeBar({ outcomes, width = 120 }: { outcomes: Record<TaskOutcome, number>; width?: number }) {
  const total = Object.values(outcomes).reduce((s, v) => s + v, 0);
  if (!total) return <div className="h-1.5 rounded-full bg-fill" style={{ width }} />;
  const order: TaskOutcome[] = ['success', 'partial', 'failure', 'abandoned', 'timeout'];
  return (
    <div className="flex h-1.5 gap-[2px] overflow-hidden rounded-full" style={{ width }} title={order.filter((o) => outcomes[o]).map((o) => `${OUTCOME_META[o].label}: ${outcomes[o]}`).join(' · ')}>
      {order
        .filter((o) => outcomes[o])
        .map((o) => (
          <div key={o} style={{ flex: outcomes[o], background: OUTCOME_META[o].color }} />
        ))}
    </div>
  );
}

export function OutcomeDots({ outcomes, total }: { outcomes: TaskOutcome[]; total: number }) {
  return (
    <span className="inline-flex items-center gap-1">
      {Array.from({ length: Math.max(total, outcomes.length) }, (_, i) => {
        const o = outcomes[i];
        return <span key={i} title={o ? OUTCOME_META[o].label : 'Not reached'} className={cn('size-2 rounded-full', !o && 'ring-1 ring-inset ring-black/15')} style={o ? { background: OUTCOME_META[o].color } : undefined} />;
      })}
    </span>
  );
}

export function Popover({ trigger, children, align = 'right' }: { trigger: (toggle: () => void, open: boolean) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k);
    return () => (document.removeEventListener('mousedown', h), document.removeEventListener('keydown', k));
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      {trigger(() => setOpen((o) => !o), open)}
      {open && (
        <div
          className={cn(
            'absolute z-40 mt-2 min-w-[220px] rounded-[14px] bg-white/90 p-1.5 shadow-[0_10px_40px_rgba(0,0,0,.16),0_0_0_0.5px_rgba(0,0,0,.08)] backdrop-blur-xl animate-[ta-sheet_.25s_cubic-bezier(0.32,0.72,0,1)]',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function ExportMenu({ studyId, includePreview }: { studyId: string; includePreview: boolean }) {
  const tables = [
    ['sessions', 'Sessions', 'One row per participant, with scores'],
    ['tasks', 'Task results', 'Outcome, time and SEQ per task'],
    ['answers', 'Answers', 'Every questionnaire and open answer'],
    ['events', 'Event log', 'Clicks, navigation, transcript, errors'],
  ] as const;
  const href = (t: string, f: string) => `/api/studies/${studyId}/export?table=${t}&format=${f}${includePreview ? '&includePreview=1' : ''}`;
  return (
    <Popover
      trigger={(toggle) => (
        <button onClick={toggle} className="inline-flex h-8 items-center gap-1.5 rounded-full bg-fill px-3.5 text-[13px] font-medium text-label transition-colors hover:bg-black/[0.07]">
          <Download className="size-3.5" strokeWidth={1.75} /> Export <ChevronDown className="size-3 text-tertiary" strokeWidth={2} />
        </button>
      )}
    >
      {() => (
        <div className="py-1">
          {tables.map(([t, label, desc]) => (
            <div key={t} className="flex items-center justify-between gap-4 rounded-[10px] px-3 py-2 hover:bg-black/[0.04]">
              <div>
                <div className="text-[13px] font-medium text-label">{label}</div>
                <div className="text-[12px] text-tertiary">{desc}</div>
              </div>
              <div className="flex gap-1 text-[12px] font-medium">
                <a className="rounded-full px-2 py-0.5 text-brand-500 hover:bg-brand-500/10" href={href(t, 'csv')} download>
                  CSV
                </a>
                <a className="rounded-full px-2 py-0.5 text-brand-500 hover:bg-brand-500/10" href={href(t, 'json')} download>
                  JSON
                </a>
              </div>
            </div>
          ))}
        </div>
      )}
    </Popover>
  );
}

/** Tiny iOS-style switch with inline label. */
export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    <label className="inline-flex cursor-pointer select-none items-center gap-2 text-[13px] text-secondary">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn('relative inline-flex h-[18px] w-[30px] shrink-0 rounded-full transition-colors duration-200', checked ? 'bg-sys-green' : 'bg-black/15')}
      >
        <span className={cn('absolute top-[2px] size-[14px] rounded-full bg-white shadow transition-transform duration-200 ease-apple', checked ? 'translate-x-[14px]' : 'translate-x-[2px]')} />
      </button>
      {label}
    </label>
  );
}

export function Empty({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="rounded-[22px] bg-surface px-8 py-16 text-center ring-1 ring-black/[0.04]">
      <div className="text-[20px] font-semibold tracking-[-0.015em] text-label">{title}</div>
      {children && <div className="mx-auto mt-1.5 max-w-md text-[15px] leading-relaxed text-secondary">{children}</div>}
    </div>
  );
}
