// Main session layout: the tested app (or the calm voice screen with question cards) takes the
// full height, and one opaque right-hand panel holds everything else — voice status, the current
// task in writing, the session's steps, and the controls. Under 900 px the panel becomes a bottom
// sheet in the layout flow (it pushes the app up, never covers it).
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowUp, Check, ChevronDown, ChevronUp, Eye, Keyboard, Mic, MicOff, RotateCw, X } from 'lucide-react';
import type { Question, RealtimeProvider, Step, TaskStep } from '@thinkaloud/shared';
import { Button, cn, Modal } from '../ui/index.tsx';
import { VoiceOrb } from './VoiceOrb.tsx';
import { StatusLabel } from './VoiceStatus.tsx';
import { QuestionCard, QuestionnaireCard } from './QuestionCards.tsx';
import type { RunnerState, SessionRunner } from './runner.ts';

const ICON = { strokeWidth: 1.75 } as const;

export function SessionView({ runner, title, preview, onWithdraw }: { runner: SessionRunner; title: string; preview: boolean; onWithdraw: () => Promise<void> }) {
  const s = useSyncExternalStore(runner.subscribe, runner.getSnapshot);
  const frameRef = useCallback((el: HTMLIFrameElement | null) => runner.attachIframe(el), [runner]);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [typing, setTyping] = useState(runner.snapshot.mode === 'text');
  const wide = useMediaQuery('(min-width: 900px)');
  const allowText = runner.mod.allowTextFallback || s.mode !== 'voice';
  const appUrl = useMemo(() => runner.appUrlFor(undefined), [runner]);
  const hasApp = Boolean(appUrl);
  const app = s.appVisible && hasApp;
  const voice = s.mode !== 'manual';
  // The big orb is the calm screen's focus; elsewhere the panel shows it (always exactly once).
  const heroOrb = voice && !app && !s.card;

  useEffect(() => {
    if (s.mode === 'text') setTyping(true);
  }, [s.mode]);

  const mic = () => runner.micMeter?.read() ?? 0;
  const out = () => runner.remoteMeter?.read() ?? 0;
  const task = s.step?.type === 'task' ? (s.step as TaskStep) : null;

  const answerOf = (qid: string) => (s.card ? s.answers[`${s.card.stepId}::${qid}`] : undefined);
  const onAnswer = (q: Question, a: Parameters<SessionRunner['answerFromScreen']>[2]) => s.card && runner.answerFromScreen(s.card.stepId, q, a);

  return (
    <div className="fixed inset-0 flex flex-col bg-canvas text-label" data-testid="session" data-step={s.step?.id ?? (s.index < 0 ? 'intro' : 'closing')} data-task-phase={s.taskPhase ?? ''} data-app-visible={app ? '1' : '0'} data-orb={s.orb} data-status={s.status} data-mode={s.mode} data-layout={wide ? 'panel' : 'sheet'}>
      {/* The server offers a choice of voice engines only to the owner's previews. */}
      {(preview || s.engine.available.length > 1) && (
        <div className="flex h-7 shrink-0 items-center justify-center gap-2 bg-label text-[12px] font-medium text-white/90" data-testid="preview-banner">
          <span className="size-1.5 rounded-full bg-sys-orange" /> Preview — data excluded from results
          <EngineSwitch runner={runner} s={s} />
        </div>
      )}

      <div className={cn('flex min-h-0 flex-1', wide ? 'flex-row' : 'flex-col')}>
        <main className="relative min-h-0 min-w-0 flex-1">
          {/* App layer (kept mounted so app state and the probe survive between steps) */}
          {hasApp && (
            <div className={cn('absolute inset-0 bg-white transition-[opacity,transform] duration-500 ease-apple', app ? 'opacity-100' : 'pointer-events-none scale-[0.985] opacity-0')} aria-hidden={!app}>
              {s.appFrame.src && (
                <iframe key={s.appFrame.key} ref={frameRef} src={s.appFrame.src} title="Website being tested" className="h-full w-full border-0" allow="clipboard-read; clipboard-write; fullscreen" data-testid="app-frame" />
              )}
              {s.appStatus === 'crashed' && app && (
                <div className="absolute inset-0 flex items-center justify-center bg-white/60 backdrop-blur-sm">
                  <div className="w-[min(92vw,380px)] rounded-[22px] bg-surface p-6 text-center shadow-[0_8px_40px_rgba(0,0,0,.12)]">
                    <p className="text-[17px] font-semibold text-label">The website stopped responding</p>
                    <p className="mt-1 text-[14px] text-secondary">This isn’t something you did. Reload it to continue.</p>
                    <Button className="mt-5" icon={<RotateCw className="size-4" {...ICON} />} onClick={() => runner.reloadApp()} data-testid="reload-app">
                      Reload website
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Calm layer: the voice orb, or the question card; manual mode's prompt */}
          <div className={cn('absolute inset-0 flex flex-col items-center overflow-y-auto px-4 transition-opacity duration-500 ease-apple sm:px-8', app ? 'pointer-events-none opacity-0' : 'opacity-100')} aria-hidden={app}>
            <div className={cn('flex w-full max-w-[760px] flex-1 flex-col items-center', s.card ? 'justify-start pt-6 sm:pt-10' : 'justify-center')}>
              {heroOrb && (
                <div className="flex flex-col items-center [animation:ta-fade_.4s_ease]">
                  <VoiceOrb state={s.orb} micLevel={mic} outLevel={out} size={wide ? 176 : 132} />
                  <div className="mt-7 flex h-5 items-center">
                    <StatusLabel status={s.status} live className="text-[13px]" />
                  </div>
                </div>
              )}

              {!voice && (
                <div className="w-full max-w-[640px] pt-10 sm:pt-16" data-testid="manual-panel">
                  {s.notice && <p className="mb-6 rounded-[12px] bg-fill px-4 py-3 text-[14px] text-secondary">{s.notice}</p>}
                  <p className="text-[13px] font-medium text-tertiary">{s.step?.title ?? (s.index < 0 ? 'Welcome' : 'Thank you')}</p>
                  {s.manualPrompt && <p className="mt-2 whitespace-pre-line text-[24px] font-medium leading-[1.3] tracking-[-0.015em] text-label">{s.manualPrompt}</p>}
                </div>
              )}

              {s.card && (
                <div className="mt-2 flex w-full justify-center pb-10">
                  {s.card.kind === 'questionnaire' ? (
                    <QuestionnaireCard title={s.card.title} questions={s.card.questions} answers={answerOf} onAnswer={onAnswer} onSubmit={() => runner.submitQuestionnaire()} submitted={s.card.submitted} />
                  ) : (
                    <QuestionCard
                      key={`${s.card.stepId}:${s.card.questions[0].id}`}
                      q={s.card.questions[0]}
                      answer={answerOf(s.card.questions[0].id)}
                      onAnswer={(a) => onAnswer(s.card!.questions[0], a)}
                      onDecline={() => runner.declineFromScreen(s.card!.stepId, s.card!.questions[0])}
                      voiceMode={voice}
                    />
                  )}
                </div>
              )}

              {!voice && !(task && s.taskPhase !== 'post') && (
                <div className="mt-8 flex w-full max-w-[640px] items-center justify-between gap-3 pb-12">
                  <span className="text-[13px] text-sys-red">{s.manualError}</span>
                  <div className="flex gap-2">
                    {s.card?.kind === 'question' && !s.card.questions[0].required && !answerOf(s.card.questions[0].id) && (
                      <Button variant="secondary" size="lg" onClick={() => runner.manualSkipQuestion()}>
                        Skip
                      </Button>
                    )}
                    {s.card?.kind !== 'questionnaire' && (
                      <Button size="lg" onClick={() => runner.manualContinue()} data-testid="manual-continue">
                        {s.index >= s.total ? 'Finish' : 'Continue'}
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </main>

        <SidePanel
          runner={runner}
          s={s}
          title={title}
          wide={wide}
          heroOrb={heroOrb}
          allowText={allowText}
          typing={typing}
          setTyping={setTyping}
          onWithdraw={() => setConfirmWithdraw(true)}
        />
      </div>

      <Modal
        open={confirmWithdraw}
        onClose={() => setConfirmWithdraw(false)}
        title="Stop and withdraw?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmWithdraw(false)}>
              Keep going
            </Button>
            <Button
              variant="danger"
              loading={withdrawing}
              data-testid="confirm-withdraw"
              onClick={async () => {
                setWithdrawing(true);
                await onWithdraw().finally(() => setWithdrawing(false));
              }}
            >
              Stop and delete my data
            </Button>
          </>
        }
      >
        <p className="text-[15px] leading-relaxed text-secondary">The session ends right away and everything recorded so far — audio, screen activity and answers — is deleted. That’s completely fine and you won’t be asked why.</p>
      </Modal>
    </div>
  );
}

// ── Voice engine switch (owner previews) ─────────────────────────────────────

const ENGINES: { id: RealtimeProvider; label: string }[] = [
  { id: 'openrealtime', label: 'OpenRealtime' },
  { id: 'openai', label: 'OpenAI' },
];

function EngineSwitch({ runner, s }: { runner: SessionRunner; s: RunnerState }) {
  const e = s.engine;
  const offered = ENGINES.filter((x) => e.available.includes(x.id));
  if (s.mode === 'manual' || offered.length < 2) return null;
  const measured = offered.filter((x) => e.replies[x.id]);
  return (
    <div className="ml-3 flex items-center gap-2" data-testid="engine-switch" data-engine={e.current ?? ''}>
      <div role="radiogroup" aria-label="Voice engine" className="flex rounded-full bg-white/15 p-0.5">
        {offered.map((x) => {
          const on = x.id === e.current;
          return (
            <button
              key={x.id}
              role="radio"
              aria-checked={on}
              disabled={e.switching}
              onClick={() => void runner.switchEngine(x.id)}
              className={cn('h-5 rounded-full px-2.5 text-[11px] font-semibold transition-colors', on ? 'bg-white text-label' : 'text-white/80 hover:text-white', e.switching && 'cursor-default opacity-60')}
              data-testid={`engine-${x.id}`}
            >
              {x.label}
            </button>
          );
        })}
      </div>
      <span className="hidden tabular-nums text-white/60 sm:inline" data-testid="engine-latency" title="Time from the end of your turn until the moderator is heard: median (number of replies)">
        {e.switching
          ? 'Switching…'
          : measured.length
            ? `Reply time ${measured.map((x) => `${x.label} ${(e.replies[x.id]!.median / 1000).toFixed(1)} s (${e.replies[x.id]!.n})`).join(' · ')}`
            : 'Reply time —'}
      </span>
    </div>
  );
}

// ── Panel ────────────────────────────────────────────────────────────────────

interface PanelProps {
  runner: SessionRunner;
  s: RunnerState;
  title: string;
  wide: boolean;
  heroOrb: boolean;
  allowText: boolean;
  typing: boolean;
  setTyping: (v: boolean | ((t: boolean) => boolean)) => void;
  onWithdraw: () => void;
}

function SidePanel(p: PanelProps) {
  const { runner, s, wide, heroOrb } = p;
  const [sheetOpen, setSheetOpen] = useState(false);
  const voice = s.mode !== 'manual';
  const task = s.step?.type === 'task' ? (s.step as TaskStep) : null;
  const inTask = Boolean(task) && s.taskPhase !== 'post';
  const mic = () => runner.micMeter?.read() ?? 0;
  const out = () => runner.remoteMeter?.read() ?? 0;

  // Voice lost mid-session: the panel is now the only guidance, so the sheet opens.
  useEffect(() => {
    if (s.mode === 'manual') setSheetOpen(true);
  }, [s.mode]);

  const status = voice && (
    <div className="flex min-w-0 items-center gap-3" data-testid="panel-status">
      <span className="flex size-11 shrink-0 items-center justify-center">
        <VoiceOrb state={s.orb} micLevel={mic} outLevel={out} size={wide ? 40 : 28} />
      </span>
      <StatusLabel status={s.status} live={!heroOrb} compact={!wide} className={wide ? 'text-[14px]' : 'text-[13px]'} />
    </div>
  );

  const body = (
    <>
      {s.notice && !voice && (
        <p className="mx-4 mt-4 rounded-[12px] bg-fill px-4 py-3 text-[13px] leading-snug text-secondary" data-testid="dock-notice">
          {s.notice}
        </p>
      )}
      <CurrentCard runner={runner} s={s} />
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-4">
        <StepList runner={runner} s={s} />
        <Conversation s={s} />
      </div>
      <Controls {...p} inTask={inTask} />
    </>
  );

  if (wide)
    return (
      <aside className="flex w-[360px] shrink-0 flex-col border-l border-separator bg-surface" data-testid="panel" aria-label="Session">
        <header className="border-b border-separator px-5 pb-4 pt-4">
          <SessionHeading s={s} title={p.title} />
          {!heroOrb && <div className="mt-3">{status}</div>}
        </header>
        {body}
      </aside>
    );

  // Bottom sheet: a compact row that always shows the status, the task and Done.
  const label = taskLabelOf(s);
  return (
    <aside className="flex max-h-[62vh] shrink-0 flex-col border-t border-separator bg-surface shadow-[0_-4px_16px_rgba(0,0,0,.04)]" data-testid="panel" data-sheet={sheetOpen ? 'open' : 'closed'} aria-label="Session">
      <div className="flex items-center gap-2 px-3 py-2">
        {status || <span className="pl-2 text-[13px] font-medium text-secondary">{label ?? stepLabelOf(s)}</span>}
        <button
          className="flex min-w-0 flex-1 flex-col items-start rounded-[10px] px-2 py-1 text-left hover:bg-black/[0.04]"
          onClick={() => setSheetOpen((o) => !o)}
          aria-expanded={sheetOpen}
          aria-controls="ta-sheet-body"
        >
          {voice && <span className="text-[11px] tabular-nums text-tertiary">{label ?? stepLabelOf(s)}</span>}
          <span className="max-w-full truncate text-[13px] font-medium text-label">{s.step?.title ?? (s.index < 0 ? 'Introduction' : 'Wrapping up')}</span>
        </button>
        {inTask && !sheetOpen && (
          s.canResume ? (
            <Button variant="secondary" size="sm" onClick={() => runner.resumeTask()} data-testid="back-to-task">
              Back to task
            </Button>
          ) : (
            <Button size="sm" onClick={() => runner.imDone()} disabled={s.pendingAction === 'done'} data-testid="im-done">
              {s.pendingAction === 'done' ? 'One moment…' : 'I’m done'}
            </Button>
          )
        )}
        <button className="flex size-9 shrink-0 items-center justify-center rounded-full text-secondary hover:bg-black/5" onClick={() => setSheetOpen((o) => !o)} aria-label={sheetOpen ? 'Hide details' : 'Show task and steps'} aria-expanded={sheetOpen} data-testid="sheet-toggle">
          {sheetOpen ? <ChevronDown className="size-5" {...ICON} /> : <ChevronUp className="size-5" {...ICON} />}
        </button>
      </div>
      {sheetOpen && (
        <div id="ta-sheet-body" className="flex min-h-0 flex-1 flex-col border-t border-separator [animation:ta-fade_.2s_ease]">
          {body}
        </div>
      )}
    </aside>
  );
}

function SessionHeading({ s, title }: { s: RunnerState; title: string }) {
  const progress = s.total ? Math.min(1, Math.max(0, s.index) / s.total) : 0;
  return (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold tracking-[-0.01em] text-label">{title}</div>
        <div className="mt-0.5 flex items-center gap-2">
          <span className="text-[11px] tabular-nums text-tertiary" data-testid="step-label">
            {stepLabelOf(s)}
          </span>
          <span className="h-[3px] w-20 overflow-hidden rounded-full bg-black/[0.06]" aria-hidden>
            <span className="block h-full rounded-full bg-label/70 transition-[width] duration-500 ease-apple" style={{ width: `${progress * 100}%` }} />
          </span>
        </div>
      </div>
      {s.recording && (
        <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-tertiary" title="Audio is being recorded">
          <span className="size-[7px] rounded-full bg-sys-red [animation:ta-pulse_2s_ease-in-out_infinite]" /> Recording
        </span>
      )}
    </div>
  );
}

/** The current task (or app step), in writing, once the moderator has said it. */
function CurrentCard({ runner, s }: { runner: SessionRunner; s: RunnerState }) {
  const step = s.step;
  const [shownFor, setShownFor] = useState<string | null>(null);
  const elapsed = useElapsed(s.taskStartedAt);
  const exploreLeft = useCountdown(s.exploreEndsAt);
  if (!step) return null;
  if (step.type === 'task') {
    const t = step as TaskStep;
    const voice = s.mode !== 'manual';
    // Written out once it has been said (the task goes active after its reading), right away
    // without voice, or when the participant asks to see it.
    const revealed = !voice || s.taskPhase !== 'briefing' || shownFor === t.id;
    const left = s.taskDeadline ? Math.max(0, Math.round((s.taskDeadline - Date.now()) / 1000)) : null;
    return (
      <section key={t.id} className="mx-4 mt-4 rounded-[18px] bg-fill p-4 [animation:ta-flash_2.6s_cubic-bezier(.32,.72,0,1)]" data-testid="task-text" data-revealed={revealed ? '1' : '0'} aria-labelledby="ta-task-title">
        <div className="flex items-baseline justify-between gap-3 text-[12px]">
          <span className="font-semibold tabular-nums text-brand-500" data-testid="task-label">
            {taskLabelOf(s) ?? 'Task'}
          </span>
          {s.taskStartedAt && s.taskPhase !== 'post' && <span className="tabular-nums text-tertiary">{left != null ? `${fmt(left)} left` : fmt(elapsed)}</span>}
          {s.taskPhase === 'post' && <span className="text-tertiary">Finished</span>}
        </div>
        {t.title && (
          <h2 id="ta-task-title" className="mt-0.5 text-[17px] font-semibold leading-snug tracking-[-0.015em] text-label">
            {t.title}
          </h2>
        )}
        {revealed ? (
          <p className="mt-2 whitespace-pre-line text-[15px] leading-relaxed text-label [animation:ta-fade_.3s_ease]" data-testid="task-instruction-text">
            {t.instruction}
          </p>
        ) : (
          <p className="mt-2 text-[14px] text-secondary">
            Listen to the task…{' '}
            <button className="font-medium text-brand-500 hover:underline" onClick={() => setShownFor(t.id)} data-testid="show-task">
              Show it
            </button>
          </p>
        )}
      </section>
    );
  }
  if (step.type === 'instruction' && s.appVisible) {
    return (
      <section key={step.id} className="mx-4 mt-4 rounded-[18px] bg-fill p-4 [animation:ta-flash_2.6s_cubic-bezier(.32,.72,0,1)]" data-testid="task-text" data-revealed="1">
        <div className="flex items-baseline justify-between text-[12px]">
          <span className="font-semibold text-brand-500">Look around</span>
          {exploreLeft != null && <span className="tabular-nums text-tertiary">{fmt(exploreLeft)} left</span>}
        </div>
        <h2 className="mt-0.5 text-[17px] font-semibold leading-snug tracking-[-0.015em] text-label">{step.title}</h2>
        {runner.mod.style === 'unmoderated' || s.mode === 'manual' ? <p className="mt-2 text-[15px] leading-relaxed text-label">{step.script}</p> : null}
      </section>
    );
  }
  return null;
}

const KIND: Record<Step['type'], string> = { instruction: 'Instructions', question: 'Question', task: 'Task', questionnaire: 'Questionnaire', interview: 'Conversation' };

function StepList({ runner, s }: { runner: SessionRunner; s: RunnerState }) {
  const outline = useMemo(() => runner.outline, [runner]);
  const currentRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    currentRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [s.index]);
  let taskN = 0;
  const tasks = outline.filter((o) => o.type === 'task').length;
  return (
    <nav aria-label="Session steps">
      <h3 className="px-3 pb-1.5 text-[12px] font-semibold text-tertiary">Steps</h3>
      <ol data-testid="panel-steps">
        {outline.map((o, i) => {
          if (o.type === 'task') taskN++;
          const state = i < s.index ? 'done' : i === s.index ? 'current' : 'next';
          return (
            <li
              key={o.id}
              ref={state === 'current' ? currentRef : undefined}
              aria-current={state === 'current' ? 'step' : undefined}
              data-testid="panel-step"
              data-state={state}
              className={cn('flex items-center gap-3 rounded-[10px] px-3 py-2 transition-colors duration-300', state === 'current' && 'bg-brand-500/[0.07]')}
            >
              <span
                className={cn(
                  'flex size-5 shrink-0 items-center justify-center rounded-full',
                  state === 'done' && 'bg-sys-green text-white',
                  state === 'current' && 'border-[5px] border-brand-500 bg-white',
                  state === 'next' && 'border-[1.5px] border-black/15',
                )}
                aria-hidden
              >
                {state === 'done' && <Check className="size-3" strokeWidth={3} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn('block truncate text-[14px] leading-tight', state === 'current' ? 'font-semibold text-label' : state === 'done' ? 'text-secondary' : 'text-tertiary')}>{o.title}</span>
                <span className="block text-[11px] tabular-nums text-tertiary">
                  {o.type === 'task' && tasks > 1 ? `Task ${taskN} of ${tasks}` : KIND[o.type]}
                  <span className="sr-only">{state === 'done' ? ', done' : state === 'current' ? ', current step' : ''}</span>
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** The transcript, collapsed by default: the AI's words are spoken, not streamed on screen. */
function Conversation({ s }: { s: RunnerState }) {
  const [open, setOpen] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const caps = s.captions.filter((c) => c.text.trim());
  useEffect(() => {
    if (open) endRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [open, caps.length]);
  return (
    <div className="mt-3 border-t border-separator px-1 pt-2">
      <button className="flex w-full items-center justify-between rounded-[10px] px-2 py-2 text-[13px] font-medium text-secondary hover:bg-black/[0.04]" onClick={() => setOpen((o) => !o)} aria-expanded={open} data-testid="toggle-conversation">
        {open ? 'Hide conversation' : 'Show conversation'}
        {open ? <ChevronUp className="size-4" {...ICON} /> : <ChevronDown className="size-4" {...ICON} />}
      </button>
      {open && (
        <div className="space-y-2.5 px-2 pb-2 pt-1 [animation:ta-fade_.2s_ease]" data-testid="captions">
          {caps.length === 0 && <p className="text-[13px] text-tertiary">Nothing yet.</p>}
          {caps.map((c) => (
            <p key={c.id} className="text-[13px] leading-snug">
              <span className="font-semibold text-label">{c.role === 'moderator' ? 'Moderator' : 'You'}: </span>
              <span className="text-secondary">{c.text}</span>
            </p>
          ))}
          <div ref={endRef} />
        </div>
      )}
    </div>
  );
}

function Controls({ runner, s, allowText, typing, setTyping, onWithdraw, inTask }: PanelProps & { inTask: boolean }) {
  const voice = s.mode !== 'manual';
  return (
    <div className="space-y-3 border-t border-separator px-4 pb-4 pt-3">
      {typing && allowText && <TextComposer onSend={(t) => runner.sendText(t)} onClose={s.mode === 'voice' ? () => setTyping(false) : undefined} />}
      {inTask ? (
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => runner.skipTask()} data-testid="skip-task">
            Skip
          </Button>
          {s.canResume ? (
            <Button variant="secondary" className="flex-1" onClick={() => runner.resumeTask()} data-testid="back-to-task">
              Back to task
            </Button>
          ) : (
            <Button className="flex-1" onClick={() => runner.imDone()} disabled={s.pendingAction === 'done'} data-testid="im-done">
              {s.pendingAction === 'done' ? 'One moment…' : 'I’m done'}
            </Button>
          )}
        </div>
      ) : (
        s.canResume && (
          <Button variant="secondary" className="w-full" onClick={() => runner.resumeTask()} data-testid="back-to-task">
            Back to task
          </Button>
        )
      )}
      {!inTask && !voice && s.appVisible && (
        <Button className="w-full" onClick={() => runner.manualContinue()} data-testid="manual-continue">
          Continue
        </Button>
      )}
      <div className="flex items-center gap-1">
        {s.mode === 'voice' && (
          <button
            onClick={() => runner.toggleMute()}
            className={cn('flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition-colors', s.muted ? 'bg-sys-red/10 text-sys-red' : 'text-secondary hover:bg-black/5')}
            aria-pressed={s.muted}
            data-testid="mute"
          >
            {s.muted ? <MicOff className="size-4" {...ICON} /> : <Mic className="size-4" {...ICON} />}
            {s.muted ? 'Unmute' : 'Mute'}
          </button>
        )}
        {allowText && voice && (
          <button
            onClick={() => setTyping((t) => !t)}
            className={cn('flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-secondary transition-colors hover:bg-black/5', typing && 'bg-black/5 text-label')}
            aria-pressed={typing}
            data-testid="open-composer"
          >
            <Keyboard className="size-4" {...ICON} /> Type
          </button>
        )}
        {runner.eyeTracking && (
          <span className="flex h-8 items-center gap-1.5 px-2 text-[12px] text-tertiary" title="Eye tracking runs on your device; only gaze points are stored">
            <Eye className="size-4" {...ICON} /> Eye tracking on
          </span>
        )}
        {s.appStatus === 'limited' && <span className="px-2 text-[11px] text-tertiary">Limited tracking on this site</span>}
        <button onClick={onWithdraw} className="ml-auto shrink-0 rounded-full px-2 py-1 text-[12px] text-tertiary transition-colors hover:bg-black/5 hover:text-sys-red" data-testid="withdraw">
          Stop &amp; withdraw
        </button>
      </div>
    </div>
  );
}

function taskLabelOf(s: RunnerState) {
  return s.taskNo && s.taskNo.total > 1 ? `Task ${s.taskNo.n} of ${s.taskNo.total}` : s.taskNo ? 'Task' : null;
}

function stepLabelOf(s: RunnerState) {
  if (s.index < 0) return 'Introduction';
  if (s.index >= s.total) return 'Wrapping up';
  const t = taskLabelOf(s);
  return t && s.taskNo!.total > 1 ? t : `Step ${s.index + 1} of ${s.total}`;
}

function TextComposer({ onSend, onClose }: { onSend: (t: string) => void; onClose?: () => void }) {
  const [v, setV] = useState('');
  const send = () => {
    if (!v.trim()) return;
    onSend(v);
    setV('');
  };
  return (
    <div className="flex items-center gap-2">
      <input
        autoFocus
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && send()}
        placeholder="Type a message"
        aria-label="Type a message"
        className="h-9 min-w-0 flex-1 rounded-full bg-fill px-4 text-[15px] text-label placeholder:text-tertiary focus:outline-none focus-visible:ring-4 focus-visible:ring-brand-500/20"
        data-testid="composer-input"
      />
      <button onClick={send} disabled={!v.trim()} className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-500 text-white transition-opacity disabled:opacity-30" aria-label="Send" data-testid="composer-send">
        <ArrowUp className="size-4" strokeWidth={2.25} />
      </button>
      {onClose && (
        <button onClick={onClose} className="flex size-8 shrink-0 items-center justify-center rounded-full text-tertiary hover:bg-black/5" aria-label="Close keyboard">
          <X className="size-4" {...ICON} />
        </button>
      )}
    </div>
  );
}

function useMediaQuery(q: string) {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [q]);
  return m;
}

function useElapsed(since: number | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!since) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [since]);
  return since ? Math.max(0, Math.round((now - since) / 1000)) : 0;
}

function useCountdown(until: number | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!until) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [until]);
  return until ? Math.max(0, Math.round((until - now) / 1000)) : null;
}

function fmt(sec: number) {
  const m = Math.floor(sec / 60);
  return `${m}:${String(sec % 60).padStart(2, '0')}`;
}
