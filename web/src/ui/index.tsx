// ThinkAloud UI kit. Small, dependency-free, Tailwind-based. Use these everywhere
// instead of ad-hoc styling so the product feels consistent.
import { forwardRef, useEffect, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { Loader2, X } from 'lucide-react';

export function cn(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
type Size = 'sm' | 'md' | 'lg';

const btnVariant: Record<Variant, string> = {
  primary: 'bg-brand-500 text-white hover:bg-brand-600 active:bg-brand-700 disabled:bg-brand-500/40',
  secondary: 'bg-fill text-label hover:bg-black/[0.07] active:bg-black/10 disabled:text-tertiary',
  ghost: 'text-brand-500 hover:bg-brand-500/[0.08] disabled:text-tertiary',
  danger: 'bg-sys-red text-white hover:bg-[#e6352b] disabled:bg-sys-red/40',
  subtle: 'bg-brand-500/10 text-brand-600 hover:bg-brand-500/15 disabled:text-brand-300',
};
const btnSize: Record<Size, string> = {
  sm: 'h-7 px-3 text-[13px] gap-1.5 rounded-full',
  md: 'h-9 px-4 text-[14px] gap-1.5 rounded-full',
  lg: 'h-12 px-7 text-[17px] gap-2 rounded-full',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, icon, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center font-medium tracking-[-0.01em] transition-[background-color,transform,color] duration-200 ease-apple active:scale-[0.98] focus:outline-none focus-visible:ring-4 focus-visible:ring-brand-500/30 disabled:cursor-not-allowed disabled:active:scale-100 whitespace-nowrap',
        btnVariant[variant],
        btnSize[size],
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
});

const field =
  'block w-full rounded-[10px] border border-black/10 bg-white px-3 py-2 text-[14px] text-label placeholder:text-tertiary transition-shadow duration-200 focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-brand-500/15 disabled:bg-fill disabled:text-secondary';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cn(field, 'h-10', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn(field, 'min-h-[80px]', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={cn(field, 'h-10 pr-8', className)} {...rest}>
      {children}
    </select>
  );
});

export function Field({ label, hint, error, children, className }: { label?: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn('block', className)}>
      {label && <span className="mb-1.5 block text-[13px] font-medium text-secondary">{label}</span>}
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-tertiary">{hint}</span>}
      {error && <span className="mt-1 block text-xs text-sys-red">{error}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; description?: ReactNode; disabled?: boolean }) {
  return (
    <label className={cn('flex items-start gap-3', disabled ? 'opacity-60' : 'cursor-pointer')}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn('relative mt-0.5 inline-flex h-[22px] w-[38px] shrink-0 rounded-full transition-colors duration-200 ease-apple', checked ? 'bg-sys-green' : 'bg-black/15')}
      >
        <span className={cn('absolute top-[2px] size-[18px] rounded-full bg-white shadow-[0_2px_4px_rgba(0,0,0,.2)] transition-transform duration-200 ease-apple', checked ? 'translate-x-[18px]' : 'translate-x-[2px]')} />
      </button>
      {(label || description) && (
        <span>
          {label && <span className="block text-[14px] font-medium text-label">{label}</span>}
          {description && <span className="block text-[12px] text-secondary">{description}</span>}
        </span>
      )}
    </label>
  );
}

export function Card({ className, children, ...rest }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('rounded-[18px] bg-surface shadow-[0_1px_2px_rgba(0,0,0,.04),0_4px_20px_rgba(0,0,0,.04)] ring-1 ring-black/[0.04]', className)} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({ title, description, actions, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-start justify-between gap-4 px-6 pt-5 pb-3', className)}>
      <div className="min-w-0">
        <h3 className="text-[17px] font-semibold tracking-[-0.015em] text-label">{title}</h3>
        {description && <p className="mt-0.5 text-[13px] text-secondary">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

const badgeTone = {
  slate: 'bg-black/[0.05] text-secondary',
  brand: 'bg-brand-500/10 text-brand-600',
  green: 'bg-sys-green/12 text-[#248a3d]',
  amber: 'bg-sys-orange/14 text-[#c93400]',
  red: 'bg-sys-red/10 text-[#d70015]',
  blue: 'bg-sys-teal/12 text-[#0071a4]',
};
export type BadgeTone = keyof typeof badgeTone;

export function Badge({ tone = 'slate', children, className }: { tone?: BadgeTone; children: ReactNode; className?: string }) {
  return <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-[1px] text-[12px] font-medium tabular-nums', badgeTone[tone], className)}>{children}</span>;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-5 animate-spin text-tertiary', className)} />;
}

export function FullPageSpinner() {
  return (
    <div className="flex h-full min-h-[50vh] items-center justify-center">
      <Spinner className="size-8" />
    </div>
  );
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[22px] bg-surface px-6 py-16 text-center ring-1 ring-black/[0.04]">
      {icon && <div className="mb-4 text-tertiary">{icon}</div>}
      <h3 className="text-[20px] font-semibold tracking-[-0.015em] text-label">{title}</h3>
      {description && <p className="mt-1.5 max-w-md text-[15px] leading-relaxed text-secondary">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, width = 'max-w-lg' }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; footer?: ReactNode; width?: string }) {
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur-[2px] animate-[ta-fade_.2s_ease-out]" onMouseDown={onClose}>
      <div className={cn('flex max-h-[90vh] w-full flex-col rounded-[28px] bg-surface shadow-[0_24px_80px_rgba(0,0,0,.25)] animate-[ta-sheet_.35s_cubic-bezier(0.32,0.72,0,1)]', width)} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby={title ? titleId : undefined}>
        {title && (
          <div className="flex items-center justify-between px-6 pt-6 pb-2">
            <h2 id={titleId} className="text-[22px] font-semibold tracking-[-0.02em]">{title}</h2>
            <button onClick={onClose} className="rounded-full bg-fill p-1.5 text-secondary transition-colors hover:bg-black/10" aria-label="Close">
              <X className="size-4" strokeWidth={2.25} />
            </button>
          </div>
        )}
        <div className="overflow-y-auto px-6 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 px-6 pb-6 pt-2">{footer}</div>}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, className }: { tabs: { id: T; label: ReactNode; count?: number }[]; value: T; onChange: (v: T) => void; className?: string }) {
  // Apple-style segmented control.
  return (
    <div className={cn('inline-flex rounded-[9px] bg-black/[0.06] p-[2px]', className)} role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cn(
            'rounded-[7px] px-3.5 py-1 text-[13px] font-medium transition-all duration-200 ease-apple',
            value === t.id ? 'bg-white text-label shadow-[0_1px_3px_rgba(0,0,0,.12),0_0_0_0.5px_rgba(0,0,0,.04)]' : 'text-secondary hover:text-label',
          )}
        >
          {t.label}
          {t.count != null && <span className="ml-1.5 tabular-nums text-tertiary">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Stat({ label, value, sub, tone }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: 'good' | 'bad' | 'neutral' }) {
  return (
    <div className="rounded-[18px] bg-surface p-5 ring-1 ring-black/[0.04] shadow-[0_1px_2px_rgba(0,0,0,.04)]">
      <div className="text-[13px] font-medium text-secondary">{label}</div>
      <div className={cn('mt-1 text-[28px] font-semibold tracking-[-0.02em] tabular-nums', tone === 'good' ? 'text-[#248a3d]' : tone === 'bad' ? 'text-[#d70015]' : 'text-label')}>{value}</div>
      {sub && <div className="mt-0.5 text-[12px] text-tertiary">{sub}</div>}
    </div>
  );
}

export function PageHeader({ title, description, actions, breadcrumb }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; breadcrumb?: ReactNode }) {
  return (
    <div className="mb-8">
      {breadcrumb && <div className="mb-2 text-[13px] text-secondary">{breadcrumb}</div>}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[34px] font-bold leading-tight tracking-[-0.022em] text-label">{title}</h1>
          {description && <p className="mt-1 text-[15px] text-secondary">{description}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export function CopyField({ value, onCopied }: { value: string; onCopied?: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <input readOnly value={value} className={cn(field, 'h-9 font-mono text-xs')} onFocus={(e) => e.currentTarget.select()} />
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          void navigator.clipboard.writeText(value);
          onCopied?.();
        }}
      >
        Copy
      </Button>
    </div>
  );
}
