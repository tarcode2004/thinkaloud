import type { ReactNode } from 'react';
import { AudioLines, Clock, Eye, Flag, Hand, MonitorSmartphone, ShieldCheck } from 'lucide-react';
import { INSTRUMENTS, SEQ_QUESTION, questionnaireItems, type Protocol, type Step, type SuccessRule } from '@thinkaloud/shared';
import { cn } from '../../ui/index.tsx';
import { STEP_META } from './stepMeta.tsx';

const KIND_TEXT: Record<string, string> = { open: 'an open answer', single_choice: 'one choice', multi_choice: 'one or more choices', rating: 'a rating', yes_no: 'a yes or no', number: 'a number' };

function Say({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-2">
      <AudioLines className="mt-0.5 size-3.5 shrink-0 text-brand-500" />
      <p className="text-[13px] leading-relaxed text-label">“{children}”</p>
    </div>
  );
}
function Act({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex gap-2 text-xs leading-relaxed text-secondary">
      <span className="mt-0.5 shrink-0 text-tertiary">{icon ?? <Hand className="size-3.5" />}</span>
      <span>{children}</span>
    </div>
  );
}

function ruleText(r: SuccessRule) {
  switch (r.type) {
    case 'url_matches': return `URL matches ${r.pattern || '…'}`;
    case 'element_visible': return `${r.selector || '…'} is visible`;
    case 'text_visible': return `“${r.text || '…'}” is on screen`;
    case 'click_matches': return `they click ${[r.selector, r.text && `“${r.text}”`].filter(Boolean).join(' ') || '…'}`;
    case 'custom_event': return `the app tracks “${r.name || '…'}”`;
  }
}

export function ScriptPreview({ p, onJump, activeId }: { p: Protocol; onJump: (id: string) => void; activeId?: string }) {
  const m = p.moderation;
  const moderated = m.style !== 'unmoderated';
  const probes = moderated && m.probingLevel !== 'none';
  const caps = [p.consent.storeAudio && 'voice recording', p.consent.recordScreen && 'screen replay', p.consent.offerEyeTracking && 'optional eye tracking'].filter(Boolean);

  const block = (key: string, title: ReactNode, body: ReactNode, opts: { icon?: ReactNode; color?: string; onClick?: () => void; active?: boolean } = {}) => (
    <li key={key} className="relative pl-8">
      <span className={cn('absolute left-0 top-0.5 grid size-6 place-items-center rounded-full ring-4 ring-white', opts.color ?? 'bg-fill text-secondary')}>{opts.icon}</span>
      <button
        type="button"
        onClick={opts.onClick}
        disabled={!opts.onClick}
        className={cn('w-full rounded-[10px] p-2 text-left transition', opts.onClick && 'hover:bg-black/[0.03]', opts.active && 'bg-brand-500/[0.08]0/[0.06] ring-1 ring-brand-500/25')}
      >
        <div className="text-xs font-semibold text-label">{title}</div>
        <div className="mt-1.5 space-y-1.5">{body}</div>
      </button>
    </li>
  );

  const stepBody = (s: Step) => {
    switch (s.type) {
      case 'instruction':
        return (
          <>
            {s.script ? <Say>{s.script}</Say> : <Act>(no script yet)</Act>}
            {s.showApp && <Act icon={<Eye className="size-3.5" />}>Shows the app{s.exploreSeconds ? ` for ${s.exploreSeconds}s of free exploration` : ''}.</Act>}
          </>
        );
      case 'question':
        return (
          <>
            {s.question.prompt ? <Say>{s.question.prompt}</Say> : <Act>(no question yet)</Act>}
            <Act>Waits for {KIND_TEXT[s.question.kind] ?? 'an answer'}{s.question.options?.length ? `: ${s.question.options.filter(Boolean).join(' / ')}` : ''}.</Act>
            {probes && s.question.allowFollowUp && <Act>May ask one neutral follow-up{s.question.intent ? `, aiming to learn: ${s.question.intent.replace(/\.$/, '')}` : ''}.</Act>}
          </>
        );
      case 'task':
        return (
          <>
            {s.startPath && <Act icon={<MonitorSmartphone className="size-3.5" />}>Loads {s.startPath} in the app.</Act>}
            {s.instruction ? <Say>{s.instruction}</Say> : <Act>(no instruction yet)</Act>}
            <Act icon={<Clock className="size-3.5" />}>
              Listens while they work.{moderated && m.silencePromptSeconds ? ` After ${m.silencePromptSeconds}s of silence it nudges: “What are you thinking right now?”` : ''} It gives no hints and never confirms correctness.
            </Act>
            <Act icon={<Flag className="size-3.5" />}>
              Task ends when {s.successRules?.length ? s.successRules.map(ruleText).join(' or ') : 'the AI judges the success criteria are met'}, the participant gives up{s.timeLimitSec ? `, or after ${Math.round(s.timeLimitSec / 60 * 10) / 10} min` : ''}.
            </Act>
            {s.askSEQ && <Say>{SEQ_QUESTION.prompt}</Say>}
            {s.postTaskQuestions?.map((q) => <Say key={q.id}>{q.prompt || '…'}</Say>)}
            {probes && (
              <Act>
                Then up to {m.maxProbesPerStep} retrospective probe{m.maxProbesPerStep !== 1 ? 's' : ''}
                {m.probeOnBehavior ? ', based on what happened (errors, backtracking, hesitation)' : ''}
                {s.probes?.filter(Boolean).length ? `, for example: ${s.probes.filter(Boolean).map((x) => `“${x}”`).join(', ')}` : ''}.
              </Act>
            )}
          </>
        );
      case 'questionnaire': {
        const items = questionnaireItems(s);
        const intro = s.instrument !== 'custom' ? INSTRUMENTS[s.instrument].intro : '';
        return (
          <>
            {intro && <Say>{intro}</Say>}
            <Act>{s.onScreen !== false ? `Shows ${items.length} item${items.length !== 1 ? 's' : ''} on screen and waits for answers.` : `Reads ${items.length} item${items.length !== 1 ? 's' : ''} aloud one at a time and records each spoken rating.`}</Act>
          </>
        );
      }
      case 'interview':
        return (
          <>
            {s.questions.filter(Boolean).map((q, i) => <Say key={i}>{q}</Say>)}
            {probes && <Act>Up to {s.maxFollowUps ?? m.maxProbesPerStep} follow-ups per question, reflecting the participant's own words back.</Act>}
          </>
        );
    }
  };

  return (
    <ol className="relative space-y-2 before:absolute before:bottom-3 before:left-3 before:top-3 before:w-px before:bg-black/10">
      {block('consent', 'Consent & setup', <Act icon={<ShieldCheck className="size-3.5" />}>Participant reads the consent, opts in to {caps.join(', ') || 'basic capture'}{p.consent.ageGate ? ', confirms 18+' : ''}, and grants microphone access.</Act>, { icon: <ShieldCheck className="size-3.5" />, color: 'bg-fill text-secondary' })}
      {block('intro', 'Intro', p.intro ? <Say>{p.intro}</Say> : <Act>(no intro)</Act>, { icon: <AudioLines className="size-3.5" />, color: 'bg-fill text-secondary' })}
      {p.randomizeTasks && (
        <li className="pl-8 text-[11px] font-medium text-[#c93400]">Task order is randomized per participant.</li>
      )}
      {p.steps.map((s, i) =>
        block(s.id, <span>{i + 1}. {s.title || STEP_META[s.type].label}</span>, stepBody(s), { icon: STEP_META[s.type].icon('size-3.5'), color: 'bg-fill text-secondary', onClick: () => onJump(s.id), active: activeId === s.id }),
      )}
      {block('closing', 'Closing', p.closing ? <Say>{p.closing}</Say> : <Act>(no closing)</Act>, { icon: <Flag className="size-3.5" />, color: 'bg-fill text-secondary' })}
    </ol>
  );
}
