// /studies/:id/consent — the study's consent form: document (upload or write), participant info to
// collect, signature, requirements, what the study captures, live checks and the AI review.
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { Link } from 'react-router';
import { AlertTriangle, ArrowRight, Check, Download, FileText, History, Loader2, RotateCcw, Upload, Wand2, X } from 'lucide-react';
import {
  DEFAULT_AGREE_LABEL,
  DEFAULT_CONSENT_DOCUMENT,
  activeFields,
  consentContent,
  fieldSnapshot,
  lintConsent,
  readability,
  type ConsentCheckResult,
  type ConsentForm,
  type ConsentFormResponse,
  type ConsentIssue,
} from '@thinkaloud/shared';
import { api, apiDownload } from '../../lib/api.ts';
import { safeMarkdown } from '../../lib/markdown.ts';
import { timeAgo } from '../../lib/hooks.ts';
import { Button, cn, FullPageSpinner, Input, Modal, Textarea } from '../../ui/index.tsx';
import { useToast } from '../../ui/toast.tsx';
import { Callout, FormSection, Group, NumberInput, Row, Segmented, Switch } from '../components/index.tsx';
import { errorMessage } from '../lib.ts';
import { useStudy } from '../study/StudyContext.tsx';
import { ConsentChecks } from './ConsentChecks.tsx';
import { FieldsEditor } from './FieldsEditor.tsx';

const ACCEPT = '.pdf,.docx,.txt,.md,.markdown,.html,.htm,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown,text/html';
const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Strip empty options before saving (the editor keeps them while typing). */
const clean = (f: ConsentForm): ConsentForm => ({ ...f, fields: f.fields.map((x) => (x.options ? { ...x, options: x.options.map((o) => o.trim()).filter(Boolean) } : x)) });
const contentOf = (f: ConsentForm) => consentContent(clean(f)) + (f.enabled ? '1' : '0');

export default function ConsentPage() {
  const { detail } = useStudy();
  const studyId = detail.study.id;
  const toast = useToast();
  const [saved, setSaved] = useState<ConsentFormResponse | null>(null);
  const [draft, setDraft] = useState<ConsentForm | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [confirmUpload, setConfirmUpload] = useState<File | null>(null);
  const [mode, setMode] = useState<'write' | 'preview'>('write');
  const [ai, setAi] = useState<{ busy: boolean; result: ConsentCheckResult | null; content: string; error?: string | null }>({ busy: false, result: null, content: '' });
  const [rewriteOpen, setRewriteOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api
      .get<ConsentFormResponse>(`/api/studies/${studyId}/consent`)
      .then((r) => {
        setSaved(r);
        setDraft(r.form);
        if (r.form.lastCheck) setAi({ busy: false, result: r.form.lastCheck, content: '' });
      })
      .catch((e) => setLoadErr(errorMessage(e)));
  }, [studyId]);

  const dirty = Boolean(saved && draft && contentOf(saved.form) !== contentOf(draft));
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const capture = useMemo(() => (saved && draft ? { ...saved.capture, minAge: draft.minAge, fields: activeFields(draft).map(fieldSnapshot) } : null), [saved, draft]);
  const live = useMemo(() => (draft && capture ? lintConsent(draft.text, capture) : null), [draft, capture]);
  const html = useMemo(() => (draft && mode === 'preview' ? safeMarkdown(draft.text) : ''), [draft, mode]);

  if (loadErr) return <div className="mx-auto max-w-xl px-8 py-16"><Callout tone="error" icon={<AlertTriangle className="size-4" />} title="Consent form couldn’t load">{loadErr}</Callout></div>;
  if (!saved || !draft || !live || !capture) return <FullPageSpinner />;

  const set = (patch: Partial<ConsentForm>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  const save = async () => {
    setSaving(true);
    try {
      const f = clean(draft);
      const r = await api.put<ConsentFormResponse>(`/api/studies/${studyId}/consent`, { enabled: f.enabled, title: f.title, text: f.text, fields: f.fields, signature: f.signature, minAge: f.minAge, requireScroll: f.requireScroll });
      const bumped = r.form.version !== saved.form.version;
      setSaved(r);
      setDraft(r.form);
      toast(bumped ? `Saved as version ${r.form.version}` : 'Saved');
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  const upload = async (file: File) => {
    setConfirmUpload(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file, file.name);
      const r = await api.post<ConsentFormResponse>(`/api/studies/${studyId}/consent/document`, fd);
      setSaved(r);
      // The server saved the extracted text; keep any unsaved field / setting edits.
      setDraft((d) => (d ? { ...d, text: r.form.text, documentId: r.form.documentId, version: r.form.version, hash: r.form.hash, history: r.form.history } : r.form));
      setMode('write');
      toast(`Text extracted from ${file.name}. Review it, then save.`);
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  const pick = (file: File | undefined | null) => {
    if (!file) return;
    if (draft.text.trim() && draft.text.trim() !== DEFAULT_CONSENT_DOCUMENT.trim()) setConfirmUpload(file);
    else void upload(file);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    pick(e.dataTransfer.files?.[0]);
  };

  const removeOriginal = async () => {
    try {
      const r = await api.del<ConsentFormResponse>(`/api/studies/${studyId}/consent/document`);
      setSaved(r);
      setDraft((d) => (d ? { ...d, documentId: null, version: r.form.version, hash: r.form.hash } : r.form));
      toast('Original removed. The text stays.');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const runAi = async () => {
    const content = contentOf(draft);
    setAi((a) => ({ ...a, busy: true, error: null }));
    try {
      const f = clean(draft);
      const result = await api.post<ConsentCheckResult>(`/api/studies/${studyId}/consent/check`, { title: f.title, text: f.text, fields: f.fields, signature: f.signature, minAge: f.minAge, requireScroll: f.requireScroll });
      setAi({ busy: false, result, content });
      const n = result.issues.filter((i) => i.source === 'ai').length;
      toast(result.ai === 'ok' ? (n ? `AI review found ${n} more issue${n > 1 ? 's' : ''}` : 'AI review found nothing more') : result.ai === 'skipped' ? 'AI review isn’t configured on this server' : 'AI review failed; automatic checks are complete');
    } catch (e) {
      setAi((a) => ({ ...a, busy: false, error: errorMessage(e) }));
    }
  };

  const apply = (i: ConsentIssue, how: 'replace' | 'append') => {
    if (!i.suggestion) return;
    if (how === 'replace' && i.quote && draft.text.includes(i.quote)) set({ text: draft.text.replace(i.quote, i.suggestion) });
    else set({ text: `${draft.text.trimEnd()}\n\n${i.suggestion}\n` });
    setMode('write');
    toast(how === 'replace' ? 'Replaced in the document' : 'Added to the end of the document');
    requestAnimationFrame(() => textRef.current?.focus());
  };

  const doc = saved.document;
  const usedVersions = saved.form.version;
  return (
    <div className="mx-auto max-w-[1280px] px-8 py-10" data-testid="consent-page">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl">
          <h2 className="text-[22px] font-semibold tracking-[-0.015em]">Consent form</h2>
          <p className="mt-1 text-[15px] leading-relaxed text-secondary">
            What participants read and agree to before anything is recorded, and the information you collect about them. It applies to every variant of this study.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[13px] text-tertiary tabular-nums" data-testid="consent-version">
            {usedVersions ? `Version ${usedVersions}` : 'Not saved yet'}
            {saved.form.updatedAt ? ` · saved ${timeAgo(saved.form.updatedAt)}` : ''}
          </span>
          {(saved.form.history?.length ?? 0) > 0 && (
            <button type="button" onClick={() => setHistoryOpen(true)} className="grid size-8 place-items-center rounded-full text-secondary hover:bg-black/[0.05]" aria-label="Version history" title="Version history">
              <History className="size-4" />
            </button>
          )}
          <Button variant={dirty || !saved.form.version ? 'primary' : 'secondary'} onClick={save} loading={saving} disabled={!dirty} icon={!dirty && saved.form.version ? <Check className="size-4" /> : undefined} data-testid="save-consent">
            {dirty || !saved.form.version ? 'Save' : 'Saved'}
          </Button>
        </div>
      </div>

      <div className="mt-6 flex items-center gap-4 rounded-[18px] bg-surface px-5 py-4 ring-1 ring-black/[0.04]">
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-medium text-label">Show this form to participants</div>
          <div className="mt-0.5 text-[13px] text-secondary">
            {draft.enabled ? 'Participants see this document and these questions before the session.' : 'Off: participants see the short consent text from the protocol instead.'}
          </div>
        </div>
        <Switch checked={draft.enabled} onChange={(enabled) => set({ enabled })} label="Show this form to participants" />
      </div>

      <div className="mt-8 grid items-start gap-8 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-8">
          <FormSection
            flush
            title="Document"
            description="Upload your approved form (PDF, Word, text, Markdown or HTML) or write it here. You can edit the extracted text."
            actions={
              <div className="flex items-center gap-2">
                <Segmented size="sm" value={mode} onChange={setMode} options={[{ value: 'write', label: 'Edit' }, { value: 'preview', label: 'Preview' }]} />
              </div>
            }
          >
            <div className="flex flex-wrap items-center gap-3 border-b border-separator px-5 py-3">
              <Input value={draft.title} onChange={(e) => set({ title: e.target.value })} aria-label="Title shown to participants" className="h-9 max-w-sm flex-1 border-transparent bg-transparent !px-0 text-[17px] font-semibold focus:border-transparent focus:ring-0" data-testid="consent-title" />
              <div className="ml-auto flex items-center gap-1.5">
                <input ref={fileRef} type="file" accept={ACCEPT} className="hidden" onChange={(e) => pick(e.target.files?.[0])} data-testid="consent-file" />
                <Button size="sm" variant="secondary" icon={<Upload className="size-3.5" />} loading={uploading} onClick={() => fileRef.current?.click()}>
                  Upload document
                </Button>
                <button type="button" onClick={() => set({ text: DEFAULT_CONSENT_DOCUMENT })} className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[13px] text-secondary hover:bg-black/[0.05]" title="Replace the text with the ThinkAloud template">
                  <RotateCcw className="size-3" /> Template
                </button>
              </div>
            </div>
            {doc && (
              <div className="flex items-center gap-3 border-b border-separator bg-canvas/50 px-5 py-2.5 text-[13px]" data-testid="consent-original">
                <FileText className="size-4 shrink-0 text-secondary" />
                <span className="min-w-0 truncate text-label">{doc.filename}</span>
                <span className="shrink-0 text-tertiary tabular-nums">{kb(doc.size)} · participants can download it</span>
                <span className="ml-auto flex shrink-0 items-center gap-1">
                  <button type="button" onClick={() => void apiDownload(`/api/studies/${studyId}/consent/document`, doc.filename).catch((e) => toast(errorMessage(e), 'error'))} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium text-brand-500 hover:bg-brand-500/10">
                    <Download className="size-3.5" /> Download
                  </button>
                  <button type="button" onClick={removeOriginal} className="grid size-6 place-items-center rounded-full text-tertiary hover:bg-black/[0.05] hover:text-label" aria-label="Remove original">
                    <X className="size-3.5" />
                  </button>
                </span>
              </div>
            )}
            <div
              className={cn('relative transition-colors', dragging && 'bg-brand-500/[0.04]')}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              {mode === 'write' ? (
                <Textarea
                  ref={textRef}
                  value={draft.text}
                  onChange={(e) => set({ text: e.target.value })}
                  rows={22}
                  spellCheck
                  aria-label="Consent document (Markdown)"
                  className="min-h-[460px] resize-y !rounded-none !rounded-b-[18px] !border-0 !px-5 !py-4 font-mono text-[13px] leading-[1.7] focus:ring-0"
                  data-testid="consent-text"
                />
              ) : (
                <div className="max-h-[640px] overflow-y-auto px-8 py-8">
                  <div className="prose-doc mx-auto max-w-[62ch]" dangerouslySetInnerHTML={{ __html: html }} />
                </div>
              )}
              {(dragging || uploading) && (
                <div className="pointer-events-none absolute inset-2 flex items-center justify-center rounded-[14px] border-2 border-dashed border-brand-500/50 bg-white/90 text-[15px] font-medium text-brand-600">
                  {uploading ? <><Loader2 className="mr-2 size-4 animate-spin" /> Extracting text…</> : 'Drop to upload'}
                </div>
              )}
            </div>
          </FormSection>

          <section>
            <div className="mb-2 px-1">
              <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-label">About the participant</h3>
              <p className="mt-0.5 text-[13px] leading-snug text-secondary">Collected at consent, before the session. Personal fields are left out when you export without personal information.</p>
            </div>
            <FieldsEditor fields={draft.fields} onChange={(fields) => set({ fields })} />
          </section>

          <FormSection flush title="Signature">
            <Group className="ring-0">
              <Row label="How participants agree" description={draft.signature.mode === 'typed_name' ? 'They type their full name; today’s date is added.' : 'They tick a checkbox.'}>
                <Segmented size="sm" value={draft.signature.mode} onChange={(mode) => set({ signature: { ...draft.signature, mode } })} options={[{ value: 'checkbox', label: 'Checkbox' }, { value: 'typed_name', label: 'Typed name' }]} />
              </Row>
              <div className="px-4 py-3">
                <label className="block text-[13px] font-medium text-secondary" htmlFor="agree-label">Agreement statement</label>
                <Input id="agree-label" className="mt-1.5" value={draft.signature.agreeLabel} placeholder={DEFAULT_AGREE_LABEL} onChange={(e) => set({ signature: { ...draft.signature, agreeLabel: e.target.value } })} />
              </div>
            </Group>
          </FormSection>

          <FormSection flush title="Requirements">
            <Group className="ring-0">
              <Row label="Minimum age" description={draft.fields.some((f) => f.builtin === 'age' && f.enabled) ? 'Checked against the age participants enter. Younger people are stopped politely and nothing is saved.' : 'Participants confirm they are this age or older.'}>
                <NumberInput value={draft.minAge} min={0} max={99} suffix="years" onChange={(v) => set({ minAge: v ?? 18 })} className="w-32" />
              </Row>
              <Row label="Require reading to the end" description="Participants scroll through the whole document before they can agree.">
                <Switch checked={draft.requireScroll} onChange={(requireScroll) => set({ requireScroll })} label="Require reading to the end" />
              </Row>
            </Group>
          </FormSection>

          <FormSection flush title="What this study records" description="From the protocol of each active variant. The form should mention everything that is on.">
            <Group className="ring-0">
              {[
                ['Voice with the AI moderator', true, capture.storeAudio ? 'Audio recordings are stored' : 'Transcribed; recordings are not stored'],
                ['Session replay', capture.screen, 'Clicks, scrolling and pages visited'],
                ['Webcam eye tracking', capture.eyeTracking, 'Optional for participants, on device'],
                [`Age confirmation (${draft.minAge}+)`, capture.ageGate, 'Asked when the age isn’t collected'],
              ].map(([label, on, d]) => (
                <Row key={String(label)} label={String(label)} description={String(d)}>
                  <span className="inline-flex items-center gap-1.5 text-[13px] text-secondary">
                    <span className={cn('size-2 rounded-full', on ? 'bg-sys-green' : 'bg-black/20')} /> {on ? 'On' : 'Off'}
                  </span>
                </Row>
              ))}
            </Group>
            <div className="px-4 pb-3 pt-1">
              <Link to={`/studies/${studyId}/protocols`} className="inline-flex items-center gap-0.5 text-[13px] text-brand-500 hover:underline">
                Change in the protocol’s consent settings <ArrowRight className="size-3.5" />
              </Link>
            </div>
          </FormSection>
        </div>

        <aside className="xl:sticky xl:top-6">
          <div className="rounded-[18px] bg-surface p-5 shadow-[0_1px_2px_rgba(0,0,0,.04),0_4px_16px_rgba(0,0,0,.04)] ring-1 ring-black/[0.04] xl:max-h-[calc(100vh-48px)] xl:overflow-y-auto">
            <h3 className="mb-4 text-[17px] font-semibold tracking-[-0.015em]">Consent check</h3>
            <ConsentChecks
              live={live}
              ai={ai.result}
              aiStale={Boolean(ai.result && ai.content && ai.content !== contentOf(draft))}
              aiBusy={ai.busy}
              aiError={ai.error}
              text={draft.text}
              onRunAi={runAi}
              onRewrite={() => setRewriteOpen(true)}
              onApply={apply}
            />
          </div>
        </aside>
      </div>

      <Modal
        open={!!confirmUpload}
        onClose={() => setConfirmUpload(null)}
        title="Replace the text?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmUpload(null)}>Cancel</Button>
            <Button onClick={() => confirmUpload && void upload(confirmUpload)}>Replace</Button>
          </>
        }
      >
        <p className="text-[15px] leading-relaxed text-secondary">The text extracted from <b className="text-label">{confirmUpload?.name}</b> replaces what is in the editor now. Earlier saved versions stay in the history.</p>
      </Modal>

      <RewriteModal open={rewriteOpen} onClose={() => setRewriteOpen(false)} studyId={studyId} text={draft.text} onApply={(text) => (set({ text }), setMode('preview'), toast('Plain-language version applied. Review it, then save.'))} />

      <Modal open={historyOpen} onClose={() => setHistoryOpen(false)} title="Version history" width="max-w-xl">
        <p className="text-[14px] text-secondary">Each consent record stores the version and content hash the participant agreed to.</p>
        <ul className="mt-4 divide-y divide-separator rounded-[14px] ring-1 ring-black/[0.06]">
          {(saved.form.history ?? []).map((h) => (
            <li key={h.version} className="flex items-center gap-3 px-4 py-2.5 text-[14px]">
              <span className="w-24 font-medium tabular-nums text-label">Version {h.version}</span>
              <span className="flex-1 text-secondary">{new Date(h.savedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
              <code className="text-[12px] text-tertiary">{h.hash.slice(0, 10)}</code>
            </li>
          ))}
        </ul>
      </Modal>
    </div>
  );
}

function RewriteModal({ open, onClose, studyId, text, onApply }: { open: boolean; onClose: () => void; studyId: string; text: string; onApply: (t: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ text: string; changes: string[] } | null>(null);
  const before = useMemo(() => readability(text), [text]);
  const after = useMemo(() => (result ? readability(result.text) : null), [result]);
  const close = () => {
    setResult(null);
    setErr(null);
    onClose();
  };
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      setResult(await api.post<{ text: string; changes: string[] }>(`/api/studies/${studyId}/consent/rewrite`, { text }));
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={close}
      width="max-w-3xl"
      title="Rewrite in plain language"
      footer={
        result ? (
          <>
            <Button variant="secondary" onClick={() => setResult(null)}>Discard</Button>
            <Button icon={<Check className="size-4" />} onClick={() => (onApply(result.text), close())}>Use this version</Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={close}>Cancel</Button>
            <Button icon={<Wand2 className="size-4" />} loading={busy} onClick={run} disabled={text.trim().length < 20}>Rewrite</Button>
          </>
        )
      }
    >
      {result && after ? (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-6 text-[13px] text-secondary tabular-nums">
            <span>Reading level <b className="text-label">{before.grade.toFixed(1)}</b> → <b className={after.grade <= 8 ? 'text-[#248a3d]' : 'text-label'}>{after.grade.toFixed(1)}</b></span>
            <span>Words per sentence {before.avgSentenceWords} → {after.avgSentenceWords}</span>
          </div>
          {result.changes.length > 0 && (
            <ul className="space-y-1">
              {result.changes.map((c, i) => (
                <li key={i} className="flex items-start gap-2 text-[14px] text-label"><ArrowRight className="mt-1 size-3.5 shrink-0 text-brand-500" /> {c}</li>
              ))}
            </ul>
          )}
          <div className="max-h-[50vh] overflow-y-auto rounded-[14px] bg-canvas px-6 py-5">
            <div className="prose-doc mx-auto max-w-[62ch] text-[15px]" dangerouslySetInnerHTML={{ __html: safeMarkdown(result.text) }} />
          </div>
          <p className="text-[12px] text-tertiary">Check that every fact (contacts, amounts, retention) is still right. Nothing changes until you choose “Use this version” and save.</p>
        </div>
      ) : busy ? (
        <div className="flex flex-col items-center py-12 text-center">
          <Loader2 className="size-6 animate-spin text-tertiary" />
          <p className="mt-3 text-[14px] text-secondary">Rewriting with short sentences and everyday words…</p>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-[15px] leading-relaxed text-secondary">The AI rewrites your document at about a grade 6–8 reading level and keeps every fact, contact and choice. You review it before anything changes.</p>
          <p className="text-[13px] text-tertiary tabular-nums">Current reading level: grade {before.grade.toFixed(1)}</p>
          {err && <Callout tone="error" icon={<AlertTriangle className="size-4" />}>{err}</Callout>}
        </div>
      )}
    </Modal>
  );
}
