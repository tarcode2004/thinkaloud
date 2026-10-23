// Consent check side panel: readability, required elements, live lint issues and the AI review.
import { useState } from 'react';
import { AlertTriangle, Check, CircleDashed, Copy, Loader2, ShieldCheck, Wand2 } from 'lucide-react';
import type { ConsentCheckResult, ConsentElementStatus, ConsentIssue, ConsentReadability } from '@thinkaloud/shared';
import { Button, cn } from '../../ui/index.tsx';
import { Callout } from '../components/index.tsx';

const SEV = {
  high: { dot: 'bg-sys-red', label: 'Must fix' },
  medium: { dot: 'bg-sys-orange', label: 'Should fix' },
  low: { dot: 'bg-black/25', label: 'Consider' },
} as const;

export function ReadabilityMeter({ r }: { r: ConsentReadability }) {
  const max = 16;
  const pos = Math.min(1, r.grade / max);
  const good = r.grade <= 8;
  return (
    <div data-testid="readability">
      <div className="flex items-baseline justify-between">
        <div className="text-[13px] font-medium text-secondary">Reading level</div>
        <div className="text-[12px] text-tertiary tabular-nums">{r.words} words · about {r.minutes} min</div>
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-[34px] font-semibold leading-none tracking-[-0.025em] text-label tabular-nums">{r.grade.toFixed(1)}</span>
        <span className={cn('text-[13px] font-medium', good ? 'text-[#248a3d]' : 'text-[#c93400]')}>{good ? 'Easy to read' : r.grade <= 12 ? 'Harder than ideal' : 'Hard to read'}</span>
      </div>
      <div className="relative mt-3 h-1.5 rounded-full bg-fill">
        <div className={cn('absolute inset-y-0 left-0 rounded-full', good ? 'bg-sys-green' : 'bg-sys-orange')} style={{ width: `${pos * 100}%` }} />
        <div className="absolute -top-1 h-3.5 w-px bg-label/50" style={{ left: `${(8 / max) * 100}%` }} title="Target: grade 8" />
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-tertiary tabular-nums">
        <span>Flesch–Kincaid grade · target 8</span>
        <span>{Math.round(r.avgSentenceWords)} words per sentence</span>
      </div>
    </div>
  );
}

export function ElementList({ elements }: { elements: ConsentElementStatus[] }) {
  const ok = elements.filter((e) => e.status === 'ok').length;
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <div className="text-[13px] font-medium text-secondary">Required elements</div>
        <div className="text-[12px] text-tertiary tabular-nums" data-testid="elements-count">{ok} of {elements.length} covered</div>
      </div>
      <ul className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        {elements.map((e) => (
          <li key={e.id} className="flex items-center gap-1.5 text-[13px]" data-element={e.id} data-status={e.status}>
            {e.status === 'ok' ? <Check className="size-3.5 shrink-0 text-sys-green" strokeWidth={2.5} /> : e.status === 'inconsistent' ? <AlertTriangle className="size-3.5 shrink-0 text-sys-orange" /> : <CircleDashed className="size-3.5 shrink-0 text-sys-red" />}
            <span className={cn('truncate', e.status === 'ok' ? 'text-secondary' : 'text-label')}>{e.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function IssueCard({ i, canReplace, onApply }: { i: ConsentIssue; canReplace: boolean; onApply: (i: ConsentIssue, mode: 'replace' | 'append') => void }) {
  const [copied, setCopied] = useState(false);
  const s = SEV[i.severity];
  return (
    <li className="rounded-[12px] border border-separator bg-white p-3" data-testid="consent-issue" data-key={i.key} data-source={i.source}>
      <div className="flex items-start gap-2">
        <span className={cn('mt-[7px] size-1.5 shrink-0 rounded-full', s.dot)} title={s.label} />
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-medium leading-snug text-label">{i.message}</p>
          {i.explanation && <p className="mt-1 text-[13px] leading-relaxed text-secondary">{i.explanation}</p>}
          {i.quote && <blockquote className="mt-2 border-l-2 border-sys-orange/50 pl-2.5 text-[13px] italic leading-relaxed text-secondary">{i.quote}</blockquote>}
          {i.suggestion && (
            <div className="mt-2 rounded-[9px] bg-fill px-2.5 py-2 text-[13px] leading-relaxed text-label">
              {i.suggestion}
              <div className="mt-1.5 flex gap-3 text-[12px] font-medium">
                {!/^\s*(Remove|Split|Say|Upload|Turn)\b/.test(i.suggestion) && (
                  <button type="button" className="text-brand-500 hover:underline" onClick={() => onApply(i, i.quote && canReplace ? 'replace' : 'append')}>
                    {i.quote && canReplace ? 'Replace in document' : 'Add to document'}
                  </button>
                )}
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-secondary hover:text-label"
                  onClick={() => {
                    void navigator.clipboard?.writeText(i.suggestion!);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                >
                  <Copy className="size-3" /> {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

export function ConsentChecks({
  live,
  ai,
  aiStale,
  aiBusy,
  aiError,
  text,
  onRunAi,
  onRewrite,
  onApply,
}: {
  live: { issues: ConsentIssue[]; elements: ConsentElementStatus[]; readability: ConsentReadability };
  ai: ConsentCheckResult | null;
  aiStale: boolean;
  aiBusy: boolean;
  aiError?: string | null;
  text: string;
  onRunAi: () => void;
  onRewrite: () => void;
  onApply: (i: ConsentIssue, mode: 'replace' | 'append') => void;
}) {
  const [showLow, setShowLow] = useState(false);
  const important = live.issues.filter((i) => i.severity !== 'low');
  const low = live.issues.filter((i) => i.severity === 'low');
  const aiIssues = ai?.issues.filter((i) => i.source === 'ai') ?? [];
  const inDoc = (q?: string) => Boolean(q && text.includes(q));
  return (
    <div className="space-y-6" data-testid="consent-checks">
      <ReadabilityMeter r={live.readability} />
      <div className="h-px bg-separator" />
      <ElementList elements={live.elements} />
      <div className="h-px bg-separator" />
      <section>
        <div className="mb-2 flex items-baseline justify-between">
          <h4 className="text-[13px] font-medium text-secondary">Automatic checks</h4>
          <span className="text-[12px] text-tertiary">Update as you type</span>
        </div>
        {live.issues.length === 0 ? (
          <div className="flex items-center gap-2 rounded-[10px] bg-sys-green/[0.08] px-3 py-2.5 text-[14px] text-label"><Check className="size-4 text-sys-green" /> No problems found.</div>
        ) : (
          <>
            <ul className="space-y-2" data-testid="lint-issues">
              {important.map((i) => <IssueCard key={i.key} i={i} canReplace={inDoc(i.quote)} onApply={onApply} />)}
              {(showLow || !important.length) && low.map((i) => <IssueCard key={i.key} i={i} canReplace={inDoc(i.quote)} onApply={onApply} />)}
            </ul>
            {important.length > 0 && low.length > 0 && (
              <button type="button" onClick={() => setShowLow((v) => !v)} className="mt-2 text-[13px] font-medium text-brand-500 hover:underline">
                {showLow ? 'Hide suggestions' : `Show ${low.length} more suggestion${low.length > 1 ? 's' : ''}`}
              </button>
            )}
          </>
        )}
      </section>
      <div className="h-px bg-separator" />
      <section>
        <div className="mb-2 flex items-baseline justify-between">
          <h4 className="text-[13px] font-medium text-secondary">AI review</h4>
          {ai && !aiBusy && <button type="button" onClick={onRunAi} className="text-[12px] font-medium text-brand-500 hover:underline">{aiStale ? 'Run again' : 'Re-run'}</button>}
        </div>
        {aiError && <Callout tone="error" className="mb-2">{aiError}</Callout>}
        {aiBusy ? (
          <div className="flex items-center gap-2 rounded-[10px] bg-brand-500/[0.06] px-3 py-3 text-[14px] text-label"><Loader2 className="size-4 animate-spin" /> Reading the document like an ethics reviewer…</div>
        ) : !ai ? (
          <div className="rounded-[14px] border border-dashed border-black/15 p-4">
            <p className="text-[13px] leading-relaxed text-secondary">Checks the wording against what this study collects and suggests rewrites, with a quote of each problem.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="subtle" icon={<ShieldCheck className="size-4" />} onClick={onRunAi} data-testid="run-ai-check">Run AI review</Button>
              <Button size="sm" variant="secondary" icon={<Wand2 className="size-4" />} onClick={onRewrite}>Plain language</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2" data-testid="ai-result">
            {aiStale && <p className="text-[12px] text-tertiary">The document changed since this review.</p>}
            {ai.ai === 'skipped' ? (
              <Callout tone="info">AI review isn’t available on this server (no OpenAI key). The automatic checks above are complete.</Callout>
            ) : ai.ai === 'failed' ? (
              <Callout tone="warn" icon={<AlertTriangle className="size-4" />} title="The AI review didn’t finish">{ai.aiError ?? 'Please try again.'} The automatic checks above are complete.</Callout>
            ) : aiIssues.length === 0 ? (
              <div className="flex items-center gap-2 rounded-[10px] bg-sys-green/[0.08] px-3 py-2.5 text-[14px] text-label"><Check className="size-4 text-sys-green" /> No further problems found.</div>
            ) : (
              <ul className="space-y-2">{aiIssues.map((i) => <IssueCard key={i.key} i={i} canReplace={inDoc(i.quote)} onApply={onApply} />)}</ul>
            )}
            <Button size="sm" variant="secondary" icon={<Wand2 className="size-4" />} onClick={onRewrite} className="mt-1">Rewrite in plain language</Button>
          </div>
        )}
      </section>
    </div>
  );
}
