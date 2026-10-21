// Small researcher-only building blocks.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { marked } from 'marked';
import QRCode from 'qrcode';
import { GripVertical, Plus, Trash2 } from 'lucide-react';
import type { StudyStatus } from '@thinkaloud/shared';
import { cn, Input } from '../../ui/index.tsx';
import { STATUS_META } from '../lib.ts';

export function Logo({ className, mark = false }: { className?: string; mark?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-2 text-[15px] font-semibold tracking-[-0.015em] text-label', className)}>
      <svg viewBox="0 0 32 32" className="size-6" fill="none" aria-hidden>
        <circle cx="16" cy="16" r="15" fill="currentColor" />
        <path d="M10 16.5a6 6 0 0 1 12 0" stroke="white" strokeWidth="2.6" strokeLinecap="round" />
        <circle cx="16" cy="20" r="2.8" fill="white" />
      </svg>
      {!mark && <span>ThinkAloud</span>}
    </span>
  );
}

export function StatusBadge({ status, className }: { status: StudyStatus; className?: string }) {
  const m = STATUS_META[status] ?? STATUS_META.draft;
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-[13px] font-medium text-secondary', className)}>
      <span className={cn('size-2 rounded-full', m.dot)} />
      {m.label}
    </span>
  );
}

/** Click-to-edit text. Commits on blur / Enter, reverts on Escape. */
export function InlineEdit({ value, onSave, className, placeholder, inputClassName }: { value: string; onSave: (v: string) => void; className?: string; placeholder?: string; inputClassName?: string }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  if (editing)
    return (
      <input
        autoFocus
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          setEditing(false);
          const t = v.trim();
          if (t && t !== value) onSave(t);
          else setV(value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setV(value);
            setEditing(false);
          }
        }}
        className={cn('rounded-[8px] border border-brand-500 bg-white px-1.5 outline-none ring-4 ring-brand-500/15', inputClassName)}
      />
    );
  return (
    <button type="button" title="Click to rename" onClick={() => setEditing(true)} className={cn('truncate rounded-[8px] px-1.5 text-left transition hover:bg-black/[0.05]', className)}>
      {value || <span className="text-tertiary">{placeholder}</span>}
    </button>
  );
}

/** Editable ordered list of strings (probes, goals, questions, rules). */
export function StringListEditor({ items, onChange, placeholder, addLabel = 'Add', multiline = false, numbered = false }: { items: string[]; onChange: (v: string[]) => void; placeholder?: string; addLabel?: string; multiline?: boolean; numbered?: boolean }) {
  const refs = useRef<(HTMLInputElement | HTMLTextAreaElement | null)[]>([]);
  const [focusIdx, setFocusIdx] = useState<number | null>(null);
  useEffect(() => {
    if (focusIdx != null) {
      refs.current[focusIdx]?.focus();
      setFocusIdx(null);
    }
  }, [focusIdx, items.length]);
  const [drag, setDrag] = useState<number | null>(null);
  return (
    <div className="space-y-2">
      {items.map((it, i) => (
        <div
          key={i}
          className={cn('group flex items-start gap-1.5', drag === i && 'opacity-50')}
          onDragOver={(e) => {
            if (drag == null) return;
            e.preventDefault();
            if (drag !== i) {
              const next = [...items];
              const [m] = next.splice(drag, 1);
              next.splice(i, 0, m);
              onChange(next);
              setDrag(i);
            }
          }}
        >
          <span draggable onDragStart={() => setDrag(i)} onDragEnd={() => setDrag(null)} className="mt-2.5 cursor-grab text-black/20 hover:text-tertiary" title="Drag to reorder">
            <GripVertical className="size-4" />
          </span>
          {numbered && <span className="mt-2 w-5 shrink-0 text-right text-[13px] tabular-nums text-tertiary">{i + 1}.</span>}
          {multiline ? (
            <textarea
              ref={(el) => {
                refs.current[i] = el;
              }}
              rows={2}
              value={it}
              placeholder={placeholder}
              onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))}
              className="block w-full resize-y rounded-[10px] border border-black/10 bg-white px-3 py-2 text-[14px] placeholder:text-tertiary focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-brand-500/15"
            />
          ) : (
            <Input
              ref={(el) => {
                refs.current[i] = el;
              }}
              value={it}
              placeholder={placeholder}
              onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const next = [...items];
                  next.splice(i + 1, 0, '');
                  onChange(next);
                  setFocusIdx(i + 1);
                }
                if (e.key === 'Backspace' && it === '' && items.length > 0) {
                  e.preventDefault();
                  onChange(items.filter((_, j) => j !== i));
                  setFocusIdx(Math.max(0, i - 1));
                }
              }}
            />
          )}
          <button type="button" onClick={() => onChange(items.filter((_, j) => j !== i))} className="mt-1.5 rounded-full p-1.5 text-tertiary opacity-0 transition hover:bg-sys-red/10 hover:text-sys-red group-hover:opacity-100 focus:opacity-100" aria-label="Remove">
            <Trash2 className="size-4" strokeWidth={1.75} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => {
          onChange([...items, '']);
          setFocusIdx(items.length);
        }}
        className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[14px] text-brand-500 hover:bg-brand-500/[0.08]"
      >
        <Plus className="size-4" strokeWidth={1.75} /> {addLabel}
      </button>
    </div>
  );
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = marked.parse(text || '', { async: false }) as string;
  return <div className={cn('prose-ta text-[14px] text-label', className)} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function QR({ value, size = 180, className }: { value: string; size?: number; className?: string }) {
  const [src, setSrc] = useState<string>('');
  useEffect(() => {
    QRCode.toDataURL(value, { width: size * 2, margin: 1, color: { dark: '#0f172a', light: '#ffffff' } }).then(setSrc, () => setSrc(''));
  }, [value, size]);
  return src ? <img src={src} width={size} height={size} alt="QR code" className={className} /> : <div style={{ width: size, height: size }} className="animate-pulse rounded bg-fill" />;
}

export function Segmented<T extends string>({ value, onChange, options, className, size = 'md' }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; hint?: string }[]; className?: string; size?: 'sm' | 'md' }) {
  return (
    <div className={cn('inline-flex rounded-[9px] bg-black/[0.06] p-[2px]', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.hint}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-[7px] font-medium transition-all duration-200 ease-apple',
            size === 'sm' ? 'px-3 py-[3px] text-[12px]' : 'px-3.5 py-1 text-[13px]',
            value === o.value ? 'bg-white text-label shadow-[0_1px_3px_rgba(0,0,0,.12),0_0_0_0.5px_rgba(0,0,0,.04)]' : 'text-secondary hover:text-label',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** iOS-style grouped section: header + footnote above a white rounded group. */
export function FormSection({ title, description, children, className, actions, flush }: { title: ReactNode; description?: ReactNode; children: ReactNode; className?: string; actions?: ReactNode; flush?: boolean }) {
  return (
    <section className={cn('', className)}>
      <div className="mb-2 flex items-end justify-between gap-3 px-1">
        <div>
          <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-label">{title}</h3>
          {description && <p className="mt-0.5 text-[13px] leading-snug text-secondary">{description}</p>}
        </div>
        {actions}
      </div>
      <div className={cn('rounded-[18px] bg-surface ring-1 ring-black/[0.04]', flush ? '' : 'space-y-4 p-5')}>{children}</div>
    </section>
  );
}

/** Grouped inset list (iOS Settings). Children should be <Row>s. */
export function Group({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('overflow-hidden rounded-[18px] bg-surface ring-1 ring-black/[0.04] [&>*+*]:relative [&>*+*]:before:absolute [&>*+*]:before:left-4 [&>*+*]:before:right-0 [&>*+*]:before:top-0 [&>*+*]:before:h-px [&>*+*]:before:bg-separator', className)}>{children}</div>;
}

export function Row({ label, description, children, className, onClick }: { label: ReactNode; description?: ReactNode; children?: ReactNode; className?: string; onClick?: () => void }) {
  return (
    <div className={cn('flex min-h-11 items-center gap-4 px-4 py-2.5', onClick && 'cursor-pointer hover:bg-black/[0.02]', className)} onClick={onClick}>
      <div className="min-w-0 flex-1">
        <div className="text-[14px] text-label">{label}</div>
        {description && <div className="mt-0.5 text-[12px] leading-snug text-secondary">{description}</div>}
      </div>
      {children != null && <div className="shrink-0">{children}</div>}
    </div>
  );
}

/** Bare iOS switch for use inside a Row. */
export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={(e) => { e.stopPropagation(); onChange(!checked); }}
      className={cn('relative inline-flex h-[22px] w-[38px] shrink-0 rounded-full transition-colors duration-200 ease-apple', checked ? 'bg-sys-green' : 'bg-black/15')}
    >
      <span className={cn('absolute top-[2px] size-[18px] rounded-full bg-white shadow-[0_2px_4px_rgba(0,0,0,.2)] transition-transform duration-200 ease-apple', checked ? 'translate-x-[18px]' : 'translate-x-[2px]')} />
    </button>
  );
}

export function NumberInput({ value, onChange, min, max, step, suffix, placeholder, className }: { value: number | undefined; onChange: (v: number | undefined) => void; min?: number; max?: number; step?: number; suffix?: string; placeholder?: string; className?: string }) {
  return (
    <div className={cn('relative', className)}>
      <Input
        type="number"
        value={value ?? ''}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        onChange={(e) => {
          const s = e.target.value;
          if (s === '') return onChange(undefined);
          const n = Number(s);
          if (!Number.isNaN(n)) onChange(n);
        }}
        className={suffix ? 'pr-12' : undefined}
      />
      {suffix && <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-tertiary">{suffix}</span>}
    </div>
  );
}

/** Lightweight dropdown menu. */
export function Menu({ trigger, children, align = 'left', className }: { trigger: (p: { open: boolean; toggle: () => void }) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div className={cn('absolute z-40 mt-1.5 min-w-56 rounded-[14px] border border-black/[0.06] bg-white p-1 shadow-[0_12px_40px_rgba(0,0,0,.14)] backdrop-blur-xl animate-[ta-sheet_.2s_cubic-bezier(0.32,0.72,0,1)]', align === 'right' ? 'right-0' : 'left-0', className)}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ icon, children, onClick, danger, description, disabled }: { icon?: ReactNode; children: ReactNode; onClick?: () => void; danger?: boolean; description?: ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex w-full items-start gap-2.5 rounded-[9px] px-2.5 py-1.5 text-left text-[14px] transition disabled:opacity-40',
        danger ? 'text-sys-red hover:bg-sys-red/[0.08]' : 'text-label hover:bg-black/[0.05]',
      )}
    >
      {icon && <span className={cn('mt-0.5 shrink-0', danger ? 'text-sys-red' : 'text-secondary')}>{icon}</span>}
      <span className="min-w-0">
        <span className="block">{children}</span>
        {description && <span className="block text-[12px] text-secondary">{description}</span>}
      </span>
    </button>
  );
}

export function KeyHint({ children }: { children: ReactNode }) {
  return <kbd className="rounded-[5px] bg-fill px-1 font-sans text-[11px] text-secondary ring-1 ring-black/[0.06]">{children}</kbd>;
}

export function Callout({ tone = 'info', icon, title, children, className }: { tone?: 'info' | 'warn' | 'error' | 'success' | 'brand'; icon?: ReactNode; title?: ReactNode; children?: ReactNode; className?: string }) {
  const t = {
    info: 'bg-fill text-label [&_.ic]:text-secondary',
    warn: 'bg-sys-orange/[0.08] text-label [&_.ic]:text-sys-orange',
    error: 'bg-sys-red/[0.07] text-label [&_.ic]:text-sys-red',
    success: 'bg-sys-green/[0.08] text-label [&_.ic]:text-sys-green',
    brand: 'bg-brand-500/[0.06] text-label [&_.ic]:text-brand-500',
  }[tone];
  return (
    <div className={cn('flex gap-2.5 rounded-[12px] px-3.5 py-2.5 text-[13px]', t, className)}>
      {icon && <span className="ic mt-px shrink-0">{icon}</span>}
      <div className="min-w-0">
        {title && <div className="font-semibold">{title}</div>}
        {children && <div className={cn('leading-relaxed', title ? 'mt-0.5 text-secondary' : '')}>{children}</div>}
      </div>
    </div>
  );
}

export function ConfirmButton({ onConfirm, children, confirmLabel = 'Confirm?', className }: { onConfirm: () => void; children: ReactNode; confirmLabel?: string; className?: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      type="button"
      onClick={() => (armed ? (setArmed(false), onConfirm()) : setArmed(true))}
      className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[13px] font-medium transition', armed ? 'bg-sys-red text-white' : 'text-secondary hover:bg-sys-red/10 hover:text-sys-red', className)}
    >
      {armed ? confirmLabel : children}
    </button>
  );
}

/** Like ui/Field but a <div>: use for composite controls (lists, chips, segmented) so clicks aren't forwarded by a <label>. */
export function FieldGroup({ label, hint, children, className }: { label?: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('block', className)} role="group">
      {label && <div className="mb-1.5 block text-[13px] font-medium text-secondary">{label}</div>}
      {children}
      {hint && <div className="mt-1 block text-xs text-tertiary">{hint}</div>}
    </div>
  );
}
