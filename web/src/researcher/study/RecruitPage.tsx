import { useState } from 'react';
import { Copy, Download, MoreHorizontal, Pencil, Plus, QrCode, Trash2 } from 'lucide-react';
import QRCode from 'qrcode';
import type { StudyLink } from '@thinkaloud/shared';
import { api } from '../../lib/api.ts';
import { Button, cn, Field, Input, Modal, Select } from '../../ui/index.tsx';
import { useToast } from '../../ui/toast.tsx';
import { Callout, Menu, MenuItem, QR, Switch } from '../components/index.tsx';
import { copy, errorMessage, type LinkWithUrl } from '../lib.ts';
import { useStudy } from './StudyContext.tsx';

export default function RecruitPage() {
  const { detail, update } = useStudy();
  const { links, variants, study } = detail;
  const toast = useToast();
  const [editing, setEditing] = useState<LinkWithUrl | 'new' | null>(null);
  const [qr, setQr] = useState<LinkWithUrl | null>(null);
  const prolific = links[0] ? `${links[0].url}?PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}` : '';

  const setLink = (l: LinkWithUrl) => update((d) => ({ ...d, links: d.links.some((x) => x.id === l.id) ? d.links.map((x) => (x.id === l.id ? { ...x, ...l } : x)) : [...d.links, l] }));
  const patch = async (l: LinkWithUrl, body: Partial<StudyLink>) => {
    setLink({ ...l, ...body });
    try {
      const r = await api.patch<{ link?: LinkWithUrl }>(`/api/links/${l.id}`, body);
      if (r.link) setLink({ ...l, ...r.link });
    } catch (e) {
      setLink(l);
      toast(errorMessage(e), 'error');
    }
  };
  const remove = async (l: LinkWithUrl) => {
    if (l.sessionCount > 0 && !confirm(`${l.sessionCount === 1 ? '1 participant' : `${l.sessionCount} participants`} used this link. Delete it anyway? Their sessions are kept.`)) return;
    try {
      await api.del(`/api/links/${l.id}`);
      update((d) => ({ ...d, links: d.links.filter((x) => x.id !== l.id) }));
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  return (
    <div className="mx-auto max-w-[1120px] px-8 py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl">
          <h2 className="text-[22px] font-semibold tracking-[-0.015em]">Recruitment links</h2>
          <p className="mt-1 text-[15px] leading-relaxed text-secondary">Share a link with participants. It works on any modern desktop browser with a microphone. Create separate links per channel to see where people came from.</p>
        </div>
        <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')} data-testid="new-link">New link</Button>
      </div>
      {study.status !== 'live' && (
        <Callout tone="warn" className="mt-6" icon={<span className="block size-2 translate-y-1 rounded-full bg-sys-orange" />}>
          The study is {study.status}. Links only accept participants while it is live. You can still try it with Preview.
        </Callout>
      )}

      <div className="mt-6 overflow-hidden rounded-[18px] bg-surface ring-1 ring-black/[0.04]">
        {links.length === 0 && <div className="px-5 py-10 text-center text-[15px] text-secondary">No links yet.</div>}
        {links.map((l, i) => {
          const v = variants.find((x) => x.id === l.variantId);
          const expired = l.expiresAt != null && l.expiresAt < Date.now();
          const full = l.maxParticipants != null && l.sessionCount >= l.maxParticipants;
          return (
            <div key={l.id} className={cn('px-5 py-4', i > 0 && 'border-t border-separator', !l.active && 'opacity-60')} data-testid="link-row">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[15px] font-medium">{l.name}</span>
                    {expired && <span className="text-[12px] text-[#d70015]">Expired</span>}
                    {full && <span className="text-[12px] text-[#c93400]">Full</span>}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 text-[13px] text-secondary">
                    <span>{v ? `Variant ${v.name}` : 'Auto-balance across variants'}</span>
                    <span className="tabular-nums">{l.sessionCount}{l.maxParticipants ? ` / ${l.maxParticipants}` : ''} {l.sessionCount === 1 && !l.maxParticipants ? 'participant' : 'participants'}</span>
                    {l.expiresAt && <span>{expired ? 'Expired' : 'Expires'} {new Date(l.expiresAt).toLocaleDateString()}</span>}
                    {l.redirectUrl && <span className="max-w-64 truncate">Redirects to {new URL(l.redirectUrl, location.href).host}</span>}
                  </div>
                </div>
                <Switch checked={l.active} onChange={(active) => patch(l, { active })} label="Active" />
                <Menu align="right" trigger={({ toggle }) => <button onClick={toggle} className="rounded-full p-1.5 text-secondary hover:bg-black/[0.05]" aria-label="More"><MoreHorizontal className="size-4" /></button>}>
                  {(close) => (
                    <>
                      <MenuItem icon={<Pencil className="size-4" />} onClick={() => { close(); setEditing(l); }}>Edit</MenuItem>
                      <MenuItem icon={<QrCode className="size-4" />} onClick={() => { close(); setQr(l); }}>QR code</MenuItem>
                      <MenuItem danger icon={<Trash2 className="size-4" />} onClick={() => { close(); void remove(l); }}>Delete</MenuItem>
                    </>
                  )}
                </Menu>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <button onClick={() => { void copy(l.url); toast('Link copied'); }} className="flex min-w-0 flex-1 items-center gap-2 rounded-[10px] bg-canvas px-3 py-2 text-left font-mono text-[12px] text-label transition hover:bg-fill" title="Copy link" data-testid="link-url">
                  <span className="truncate">{l.url}</span>
                  <Copy className="ml-auto size-3.5 shrink-0 text-tertiary" />
                </button>
                <button onClick={() => setQr(l)} className="rounded-[10px] bg-canvas p-2 text-secondary transition hover:bg-fill" aria-label="QR code"><QrCode className="size-4" /></button>
              </div>
            </div>
          );
        })}
      </div>

      <section className="mt-12 grid gap-10 md:grid-cols-2">
        <div>
          <h3 className="text-[17px] font-semibold tracking-[-0.01em]">Passing participant IDs</h3>
          <p className="mt-1 text-[14px] leading-relaxed text-secondary">Any query parameter you append is stored with the session and included in exports. Use it for panel IDs, cohorts or conditions.</p>
          <div className="mt-3 rounded-[12px] bg-surface p-3 font-mono text-[12px] leading-relaxed text-label ring-1 ring-black/[0.04]">
            {links[0]?.url ?? 'https://…/s/token'}<span className="text-brand-500">?source=newsletter&amp;cohort=2</span>
          </div>
        </div>
        <div>
          <h3 className="text-[17px] font-semibold tracking-[-0.01em]">Prolific</h3>
          <ol className="mt-1 list-decimal space-y-1.5 pl-5 text-[14px] leading-relaxed text-secondary">
            <li>In Prolific, choose “I'll use URL parameters” and paste this as the study URL:</li>
          </ol>
          {prolific && (
            <button onClick={() => { void copy(prolific); toast('Prolific URL copied'); }} className="mt-2 flex w-full items-start gap-2 rounded-[12px] bg-surface p-3 text-left font-mono text-[12px] leading-relaxed text-label ring-1 ring-black/[0.04] hover:ring-black/10">
              <span className="min-w-0 flex-1 break-all">{prolific}</span>
              <Copy className="mt-0.5 size-3.5 shrink-0 text-tertiary" />
            </button>
          )}
          <ol start={2} className="mt-2 list-decimal space-y-1.5 pl-5 text-[14px] leading-relaxed text-secondary">
            <li>Copy Prolific's completion URL (https://app.prolific.com/submissions/complete?cc=…) into the link's <span className="text-label">Redirect after completion</span> field.</li>
            <li>Participants return to Prolific automatically when they finish.</li>
          </ol>
        </div>
      </section>

      <LinkModal value={editing} onClose={() => setEditing(null)} onSaved={(l) => { setLink(l); setEditing(null); }} />
      <QrModal link={qr} onClose={() => setQr(null)} />
    </div>
  );
}

function toDateInput(ms: number | null) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function LinkModal({ value, onClose, onSaved }: { value: LinkWithUrl | 'new' | null; onClose: () => void; onSaved: (l: LinkWithUrl) => void }) {
  const { detail } = useStudy();
  const existing = value && value !== 'new' ? value : null;
  const key = value === 'new' ? 'new' : existing?.id ?? 'none';
  return value ? <LinkForm key={key} existing={existing} variants={detail.variants} studyId={detail.study.id} onClose={onClose} onSaved={onSaved} count={detail.links.length} /> : null;
}

function LinkForm({ existing, variants, studyId, onClose, onSaved, count }: { existing: LinkWithUrl | null; variants: { id: string; name: string; active: boolean }[]; studyId: string; onClose: () => void; onSaved: (l: LinkWithUrl) => void; count: number }) {
  const toast = useToast();
  const [name, setName] = useState(existing?.name ?? (count === 0 ? 'Main link' : `Link ${count + 1}`));
  const [variantId, setVariantId] = useState(existing?.variantId ?? '');
  const [max, setMax] = useState(existing?.maxParticipants ? String(existing.maxParticipants) : '');
  const [expires, setExpires] = useState(toDateInput(existing?.expiresAt ?? null));
  const [redirect, setRedirect] = useState(existing?.redirectUrl ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    if (redirect && !/^https?:\/\//i.test(redirect)) return setErr('Redirect URL must start with https://');
    setBusy(true);
    setErr('');
    const body = {
      name: name.trim() || 'Link',
      variantId: variantId || null,
      maxParticipants: max ? Math.max(1, Number(max)) : null,
      expiresAt: expires ? new Date(`${expires}T23:59:59`).getTime() : null,
      redirectUrl: redirect.trim() || null,
    };
    try {
      const r = existing ? await api.patch<{ link: LinkWithUrl }>(`/api/links/${existing.id}`, body) : await api.post<{ link: LinkWithUrl }>(`/api/studies/${studyId}/links`, body);
      onSaved({ ...existing, ...r.link, sessionCount: existing?.sessionCount ?? (r.link as LinkWithUrl).sessionCount ?? 0 } as LinkWithUrl);
      toast(existing ? 'Link updated' : 'Link created');
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={existing ? 'Edit link' : 'New link'} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={submit} data-testid="save-link">{existing ? 'Save' : 'Create link'}</Button></>}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Field label="Name" hint="For you, e.g. the channel: Prolific, newsletter, lab."><Input autoFocus name="link-name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Variant" hint="Auto-balance is right for A/B tests. Pin a variant for targeted recruiting.">
          <Select value={variantId} onChange={(e) => setVariantId(e.target.value)}>
            <option value="">Auto-balance across active variants</option>
            {variants.map((v) => <option key={v.id} value={v.id}>Always variant {v.name}{v.active ? '' : ' (inactive)'}</option>)}
          </Select>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Participant limit" hint="Empty for no limit."><Input type="number" min={1} value={max} onChange={(e) => setMax(e.target.value)} placeholder="No limit" /></Field>
          <Field label="Expires" hint="Empty for never."><Input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} /></Field>
        </div>
        <Field label="Redirect after completion" hint="Send participants back to your panel, e.g. a Prolific completion URL.">
          <Input value={redirect} onChange={(e) => setRedirect(e.target.value)} placeholder="https://app.prolific.com/submissions/complete?cc=XXXX" />
        </Field>
        {err && <p className="text-[13px] text-sys-red">{err}</p>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function QrModal({ link, onClose }: { link: LinkWithUrl | null; onClose: () => void }) {
  const download = async () => {
    if (!link) return;
    const url = await QRCode.toDataURL(link.url, { width: 1024, margin: 2 });
    const a = document.createElement('a');
    a.href = url;
    a.download = `${link.name.replace(/\W+/g, '-').toLowerCase()}-qr.png`;
    a.click();
  };
  return (
    <Modal open={!!link} onClose={onClose} title={link?.name} width="max-w-sm" footer={<Button variant="secondary" icon={<Download className="size-4" />} onClick={download}>Download PNG</Button>}>
      {link && (
        <div className="flex flex-col items-center">
          <QR value={link.url} size={240} className="rounded-[14px]" />
          <p className="mt-3 break-all text-center font-mono text-[11px] text-secondary">{link.url}</p>
        </div>
      )}
    </Modal>
  );
}
