import { AlertTriangle, Check, ChevronRight, Eye, XCircle } from 'lucide-react';
import type { ReadinessFix, ReadinessItem, ReadinessReport } from '@thinkaloud/shared';
import { Button, cn, Modal, Spinner } from '../../ui/index.tsx';

/** Where a Fix button goes, relative to the study ('preview' is handled by the caller). */
export function fixHref(base: string, fix: ReadinessFix): string {
  if (fix.tab === 'protocols' && fix.id) return `${base}/protocols/${fix.id}`;
  return `${base}/${fix.tab}`;
}

/**
 * Pre-publish checklist. Errors block publishing; warnings ask "publish anyway?". Opened by
 * Go live / Resume / Reopen; publishes straight through when there is nothing to report.
 */
export default function ReadinessSheet({
  open,
  report,
  error,
  publishing,
  onClose,
  onPublish,
  onPreview,
  onFix,
}: {
  open: boolean;
  report: ReadinessReport | null;
  error?: string | null;
  publishing: boolean;
  onClose: () => void;
  onPublish: () => void;
  onPreview: () => void;
  onFix: (fix: ReadinessFix) => void;
}) {
  const errors = report?.items.filter((i) => i.level === 'error') ?? [];
  const warnings = report?.items.filter((i) => i.level === 'warning') ?? [];
  const title = !report ? 'Checking your study…' : errors.length ? 'Not ready to publish' : 'Publish with warnings?';
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width="max-w-xl"
      footer={
        <div className="flex w-full flex-wrap items-center gap-2">
          <Button variant="secondary" icon={<Eye className="size-4" />} onClick={onPreview} data-testid="readiness-preview">
            Preview as participant
          </Button>
          <span className="flex-1" />
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          {report && !errors.length && (
            <Button onClick={onPublish} loading={publishing} data-testid="publish-anyway">Publish anyway</Button>
          )}
          {/* Checks unavailable (e.g. older server): the server still enforces its own go-live rules. */}
          {error && <Button onClick={onPublish} loading={publishing}>Publish without checks</Button>}
        </div>
      }
    >
      {!report && !error && (
        <div className="flex items-center gap-3 py-6 text-[15px] text-secondary" role="status">
          <Spinner className="size-4" /> Loading your app the way participants will…
        </div>
      )}
      {error && <p className="text-[15px] text-secondary">Couldn’t run the checks: {error}</p>}
      {report && (
        <>
          <p className="text-[15px] leading-relaxed text-secondary">
            {errors.length
              ? `Fix ${errors.length === 1 ? 'the item' : `the ${errors.length} items`} marked in red before participants can join.`
              : 'Participants can join, but check these first. A study that looks fine to you can still break for them.'}
          </p>
          <ul className="mt-4 overflow-hidden rounded-[14px] bg-canvas ring-1 ring-black/[0.04]" data-testid="readiness-items">
            {[...errors, ...warnings].map((it, i) => (
              <Row key={it.id} item={it} first={i === 0} onFix={onFix} />
            ))}
          </ul>
          {!errors.length && !warnings.length && (
            <p className="mt-4 flex items-center gap-2 text-[15px] text-label"><Check className="size-4 text-sys-green" /> Everything checks out.</p>
          )}
        </>
      )}
    </Modal>
  );
}

function Row({ item, first, onFix }: { item: ReadinessItem; first: boolean; onFix: (fix: ReadinessFix) => void }) {
  const isError = item.level === 'error';
  return (
    <li className={cn('relative flex items-start gap-3 px-4 py-3', !first && 'before:absolute before:left-11 before:right-0 before:top-0 before:h-px before:bg-separator')} data-level={item.level}>
      {isError ? (
        <XCircle className="mt-0.5 size-[18px] shrink-0 text-sys-red" aria-label="Must fix" />
      ) : (
        <AlertTriangle className="mt-0.5 size-[18px] shrink-0 text-sys-orange" aria-label="Warning" />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-[15px] text-label">{item.title}</div>
        {item.detail && <div className="mt-0.5 text-[13px] leading-snug text-secondary">{item.detail}</div>}
      </div>
      {item.fix && (
        <button
          onClick={() => onFix(item.fix!)}
          className="inline-flex shrink-0 items-center gap-0.5 rounded-full px-2 py-1 text-[13px] font-medium text-brand-500 transition-colors hover:bg-brand-500/10"
        >
          {item.fix.label} <ChevronRight className="size-3.5" />
        </button>
      )}
    </li>
  );
}
