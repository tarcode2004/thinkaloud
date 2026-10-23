// Main session layout: a calm voice screen (orb + captions + cards) and, during
// tasks, the tested app full-screen with a slim moderator dock.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowUp, ChevronDown, ChevronUp, Keyboard, Mic, MicOff, RotateCw, X } from 'lucide-react';
import type { Question, TaskStep } from '@thinkaloud/shared';
import { Button, cn, Modal } from '../ui/index.tsx';
import { VoiceOrb } from './VoiceOrb.tsx';
import { STATUS_LABEL, StatusLabel } from './VoiceStatus.tsx';
import { QuestionCard, QuestionnaireCard } from './QuestionCards.tsx';
import type { SessionRunner } from './runner.ts';
import { isReadingOf } from './rules.ts';

const ICON = { strokeWidth: 1.75 } as const;

export function SessionView({ runner, title, preview, onWithdraw }: { runner: SessionRunner; title: string; preview: boolean; onWithdraw: () => Promise<void> }) {
  const s = useSyncExternalStore(runner.subscribe, runner.getSnapshot);
  const frameRef = useCallback((el: HTMLIFrameElement | null) => runner.attachIframe(el), [runner]);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [typing, setTyping] = useState(runner.snapshot.mode === 'text');
  const allowText = runner.mod.allowTextFallback || s.mode !== 'voice';
  const appUrl = useMemo(() => runner.appUrlFor(undefined), [runner]);
  const hasApp = Boolean(appUrl);
  const app = s.appVisible && hasApp;
  const voice = s.mode !== 'manual';

  useEffect(() => {
    if (s.mode === 'text') setTyping(true);
  }, [s.mode]);

  const mic = () => runner.micMeter?.read() ?? 0;
  const out = () => runner.remoteMeter?.read() ?? 0;
  const progress = s.total ? Math.min(1, Math.max(0, s.index) / s.total) : 0;
  const taskLabel = s.taskNo && s.taskNo.total > 1 ? `Task ${s.taskNo.n} of ${s.taskNo.total}` : s.taskNo ? 'Task' : null;
  const stepLabel = s.index < 0 ? 'Introduction' : s.index >= s.total ? 'Wrapping up' : taskLabel && s.taskNo!.total > 1 ? taskLabel : `Step ${s.index + 1} of ${s.total}`;
  const moderatorCaps = s.captions.filter((c) => c.role === 'moderator');
  const lastMod = moderatorCaps[moderatorCaps.length - 1];
  const prevMod = moderatorCaps[moderatorCaps.length - 2];
  const lastCap = s.captions[s.captions.length - 1];
  const liveUser = lastCap?.role === 'participant' ? lastCap : null;
  const task = s.step?.type === 'task' ? (s.step as TaskStep) : null;

  const answerOf = (qid: string) => (s.card ? s.answers[`${s.card.stepId}::${qid}`] : undefined);
  const onAnswer = (q: Question, a: Parameters<SessionRunner['answerFromScreen']>[2]) => s.card && runner.answerFromScreen(s.card.stepId, q, a);

  return (
    <div className="fixed inset-0 flex flex-col bg-canvas text-label" data-testid="session" data-step={s.step?.id ?? (s.index < 0 ? 'intro' : 'closing')} data-task-phase={s.taskPhase ?? ''} data-app-visible={app ? '1' : '0'} data-orb={s.orb} data-status={s.status} data-mode={s.mode}>
      {preview && (
        <div className="flex h-7 shrink-0 items-center justify-center gap-2 bg-label text-[12px] font-medium text-white/90" data-testid="preview-banner">
          <span className="size-1.5 rounded-full bg-sys-orange" /> Preview — data excluded from results
        </div>
      )}
      {/* Top bar */}
      <header className="material relative z-30 flex h-12 shrink-0 items-center gap-3 border-b px-4 sm:px-5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold tracking-[-0.01em] text-label">{title}</div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] tabular-nums text-tertiary" data-testid="step-label">
              {stepLabel}
            </span>
            <span className="hidden h-[3px] w-24 overflow-hidden rounded-full bg-black/[0.06] sm:block">
              <span className="block h-full rounded-full bg-label/70 transition-[width] duration-500 ease-apple" style={{ width: `${progress * 100}%` }} />
            </span>
          </div>
        </div>
        {s.recording && (
          <span className="flex items-center gap-1.5 text-[12px] text-secondary" title="Audio is being recorded">
            <span className="size-2 rounded-full bg-sys-red [animation:ta-pulse_2s_ease-in-out_infinite]" />
            <span className="hidden sm:inline">Recording</span>
          </span>
        )}
        {s.mode === 'voice' && (
          <button
            onClick={() => runner.toggleMute()}
            className={cn('flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition-colors', s.muted ? 'bg-sys-red/10 text-sys-red' : 'text-secondary hover:bg-black/5')}
            aria-pressed={s.muted}
            data-testid="mute"
          >
            {s.muted ? <MicOff className="size-4" {...ICON} /> : <Mic className="size-4" {...ICON} />}
            <span className="hidden sm:inline">{s.muted ? 'Unmute' : 'Mute'}</span>
          </button>
        )}
        <button onClick={() => setConfirmWithdraw(true)} className="h-8 rounded-full px-3 text-[13px] font-medium text-secondary transition-colors hover:bg-black/5 hover:text-sys-red" data-testid="withdraw">
          Stop &amp; withdraw
        </button>
      </header>

      <main className="relative min-h-0 flex-1">
        {/* App layer (kept mounted so app state and the probe survive between steps) */}
        {hasApp && (
          <div className={cn('absolute inset-0 bg-white transition-[opacity,transform] duration-500 ease-apple', app ? 'opacity-100' : 'pointer-events-none scale-[0.985] opacity-0')} aria-hidden={!app}>
            {s.appFrame.src && (
              <iframe
                key={s.appFrame.key}
                ref={frameRef}
                src={s.appFrame.src}
                title="Website being tested"
                className="h-full w-full border-0"
                allow="clipboard-read; clipboard-write; fullscreen"
                data-testid="app-frame"
              />
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

        {/* Calm layer */}
        <div className={cn('absolute inset-0 flex flex-col items-center overflow-y-auto px-4 transition-opacity duration-500 ease-apple sm:px-8', app ? 'pointer-events-none opacity-0' : 'opacity-100')}>
          <div className={cn('flex w-full max-w-[760px] flex-1 flex-col items-center', s.card ? 'justify-start pt-6 sm:pt-10' : 'justify-center')}>
            {voice && !s.card && (
              <div className="flex flex-col items-center [animation:ta-fade_.4s_ease]">
                <VoiceOrb state={s.orb} micLevel={mic} outLevel={out} size={176} />
                <div className="mt-7 flex h-5 items-center">
                  <StatusLabel status={s.status} live={!app} className="text-[13px]" />
                </div>
              </div>
            )}
            {voice && s.card && (
              <div className="mb-6 flex items-center gap-3 [animation:ta-fade_.4s_ease]">
                <VoiceOrb state={s.orb} micLevel={mic} outLevel={out} size={40} />
                <StatusLabel status={s.status} live={!app} className="text-[13px]" />
              </div>
            )}

            {voice && !s.card && (
              <div className="mt-5 min-h-[132px] w-full max-w-[680px] text-center" aria-live="polite" data-testid="captions">
                {prevMod && prevMod.step === s.index && <p className="mb-3 line-clamp-2 text-[17px] leading-snug text-tertiary">{prevMod.text}</p>}
                {lastMod && <p key={lastMod.id} className="text-[21px] font-medium leading-[1.32] tracking-[-0.015em] text-label [animation:ta-fade_.3s_ease] sm:text-[26px]">{lastMod.text}</p>}
                {liveUser && liveUser.text && <p className="mt-5 text-[15px] text-secondary">“{liveUser.text}”</p>}
              </div>
            )}
            {voice && s.card && lastMod && lastMod.step === s.index && !s.card.questions.some((q) => isReadingOf(lastMod.text, q.prompt) && lastMod.text.length < q.prompt.length + 40) && (
              <p className="mb-5 max-w-[620px] text-center text-[17px] leading-snug text-secondary" data-testid="captions">
                {lastMod.text}
              </p>
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

            {s.canResume && !app && (
              <div className="mt-1 flex justify-center pb-6">
                <Button variant="secondary" onClick={() => runner.resumeTask()} data-testid="back-to-task">
                  Back to task
                </Button>
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

          {/* Text input in calm mode */}
          {voice && allowText && !s.card && (
            <div className="sticky bottom-0 w-full max-w-[680px] pb-6 pt-2">
              {typing ? <TextComposer onSend={(t) => runner.sendText(t)} onClose={s.mode === 'voice' ? () => setTyping(false) : undefined} /> : (
                <div className="flex justify-center">
                  <button onClick={() => setTyping(true)} className="flex h-9 items-center gap-2 rounded-full px-4 text-[13px] font-medium text-secondary transition-colors hover:bg-black/5" data-testid="open-composer">
                    <Keyboard className="size-4" {...ICON} /> Type instead
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* A new task starts: say which one, over the app (the moderator announces it too). */}
        {task && s.taskPhase === 'briefing' && taskLabel && (
          <div key={task.id} className="pointer-events-none absolute inset-x-0 top-4 z-30 flex justify-center px-4 [animation:ta-toast_4.2s_cubic-bezier(.32,.72,0,1)_forwards]" data-testid="task-banner">
            <div className="flex max-w-[min(92vw,520px)] items-baseline gap-2.5 rounded-full bg-surface px-5 py-2.5 shadow-[0_1px_2px_rgba(0,0,0,.06),0_8px_28px_rgba(0,0,0,.12)]">
              <span className="shrink-0 text-[13px] font-semibold tabular-nums text-label">{taskLabel}</span>
              {task.title && <span className="truncate text-[13px] text-secondary">{task.title}</span>}
            </div>
          </div>
        )}

        {/* Dock (app mode) */}
        {(app || (s.step?.type === 'task' && s.taskPhase !== 'post')) && (
          <TaskDock
            runner={runner}
            task={task}
            instruction={task?.instruction ?? (s.step?.type === 'instruction' ? s.step.script : '')}
            caption={voice ? lastMod?.text : undefined}
            allowText={allowText}
            typingDefault={s.mode === 'text'}
          />
        )}
      </main>

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

function TaskDock({ runner, task, instruction, caption, allowText, typingDefault }: { runner: SessionRunner; task: TaskStep | null; instruction: string; caption?: string; allowText: boolean; typingDefault: boolean }) {
  const s = useSyncExternalStore(runner.subscribe, runner.getSnapshot);
  const [open, setOpen] = useState(true);
  const [typing, setTyping] = useState(typingDefault);
  const [showCap, setShowCap] = useState(false);
  const capRef = useRef(caption);
  const voice = s.mode !== 'manual';
  const elapsed = useElapsed(s.taskStartedAt);
  const left = s.taskDeadline ? Math.max(0, Math.round((s.taskDeadline - Date.now()) / 1000)) : null;

  // Voice lost mid-task: show the task text again (it is now the only guidance).
  useEffect(() => {
    if (s.mode === 'manual') setOpen(true);
  }, [s.mode]);

  // Collapse the task text automatically once the participant starts working.
  useEffect(() => {
    if (s.taskPhase === 'active' && s.mode !== 'manual') {
      const t = setTimeout(() => setOpen(false), 9000);
      return () => clearTimeout(t);
    }
    setOpen(true);
  }, [s.taskPhase, s.step?.id, s.mode]);

  // Show the moderator's line briefly above the dock.
  useEffect(() => {
    if (!caption || caption === capRef.current) return;
    capRef.current = caption;
    setShowCap(true);
    const t = setTimeout(() => setShowCap(false), Math.min(12000, 3000 + caption.length * 60));
    return () => clearTimeout(t);
  }, [caption]);

  const mic = () => runner.micMeter?.read() ?? 0;
  const out = () => runner.remoteMeter?.read() ?? 0;
  const inTask = Boolean(task) && s.taskPhase !== 'post';

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col items-center px-3 pb-3 sm:pb-5" data-testid="dock">
      {showCap && caption && !(open && instruction && isReadingOf(caption, instruction)) && (
        <div className="material-dark pointer-events-auto mb-2 max-w-[min(92vw,640px)] rounded-[16px] px-4 py-2.5 text-[15px] leading-snug text-white [animation:ta-sheet_.3s_cubic-bezier(.32,.72,0,1)]" data-testid="dock-caption">
          {caption}
        </div>
      )}
      <div className="material pointer-events-auto w-full max-w-[720px] rounded-[22px] border shadow-[0_8px_32px_rgba(0,0,0,.12)]">
        {s.notice && !voice && (
          <p className="border-b border-separator px-5 py-2.5 text-[13px] text-secondary" data-testid="dock-notice">
            {s.notice}
          </p>
        )}
        {open && instruction && (
          <div className="border-b border-separator px-5 pb-3 pt-4 [animation:ta-fade_.25s_ease]" data-testid="task-text">
            <div className="mb-1 flex items-center justify-between text-[12px] text-tertiary">
              <span>{task ? [s.taskNo && s.taskNo.total > 1 ? `Task ${s.taskNo.n} of ${s.taskNo.total}` : null, task.title].filter(Boolean).join(' · ') : 'Instructions'}</span>
              {inTask && s.taskStartedAt && <span className="tabular-nums">{left != null ? `${fmt(left)} left` : fmt(elapsed)}</span>}
            </div>
            <p className="text-[15px] leading-relaxed text-label">{instruction}</p>
          </div>
        )}
        {typing && allowText && (
          <div className="border-b border-separator px-3 py-2">
            <TextComposer compact onSend={(t) => runner.sendText(t)} onClose={s.mode === 'voice' ? () => setTyping(false) : undefined} />
          </div>
        )}
        <div className="flex items-center gap-2 px-2.5 py-2">
          {voice && (
            <div className="flex shrink-0 items-center gap-1.5 pr-1" title={STATUS_LABEL[s.status]} data-testid="dock-orb">
              <span className="flex size-10 items-center justify-center">
                <VoiceOrb state={s.orb} micLevel={mic} outLevel={out} size={28} />
              </span>
              <StatusLabel status={s.status} compact live={s.appVisible} className="max-w-[9.5rem] text-[12px]" />
            </div>
          )}
          <button onClick={() => setOpen((o) => !o)} className="flex min-w-0 flex-1 items-center gap-1.5 rounded-full px-2 py-1.5 text-left text-[13px] text-secondary hover:bg-black/5" data-testid="toggle-task">
            <span className={cn('truncate', open && 'hidden sm:inline')}>{open ? 'Hide task' : instruction || 'Show task'}</span>
            {open ? <ChevronDown className="size-4 shrink-0" {...ICON} /> : <ChevronUp className="size-4 shrink-0" {...ICON} />}
          </button>
          {s.appStatus === 'limited' && <span className="hidden text-[11px] text-tertiary md:inline">Limited tracking on this site</span>}
          {allowText && voice && (
            <button onClick={() => setTyping((t) => !t)} className={cn('flex size-9 items-center justify-center rounded-full text-secondary transition-colors hover:bg-black/5', typing && 'bg-black/5 text-label')} aria-label="Type a message">
              <Keyboard className="size-[18px]" {...ICON} />
            </button>
          )}
          {s.mode === 'voice' && (
            <button onClick={() => runner.toggleMute()} className={cn('flex size-9 items-center justify-center rounded-full transition-colors', s.muted ? 'bg-sys-red/10 text-sys-red' : 'text-secondary hover:bg-black/5')} aria-label={s.muted ? 'Unmute' : 'Mute'}>
              {s.muted ? <MicOff className="size-[18px]" {...ICON} /> : <Mic className="size-[18px]" {...ICON} />}
            </button>
          )}
          {inTask && (
            <>
              <Button variant="secondary" onClick={() => runner.skipTask()} data-testid="skip-task">
                Skip
              </Button>
              {s.canResume ? (
                <Button variant="secondary" onClick={() => runner.resumeTask()} data-testid="back-to-task">
                  Back to task
                </Button>
              ) : (
                <Button onClick={() => runner.imDone()} disabled={s.pendingAction === 'done'} data-testid="im-done">
                  {s.pendingAction === 'done' ? 'One moment…' : 'I’m done'}
                </Button>
              )}
            </>
          )}

          {!inTask && !voice && (
            <Button onClick={() => runner.manualContinue()} data-testid="manual-continue">
              Continue
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function TextComposer({ onSend, onClose, compact }: { onSend: (t: string) => void; onClose?: () => void; compact?: boolean }) {
  const [v, setV] = useState('');
  const send = () => {
    if (!v.trim()) return;
    onSend(v);
    setV('');
  };
  return (
    <div className={cn('flex items-center gap-2', !compact && 'rounded-full border border-black/10 bg-white py-1.5 pl-4 pr-1.5 shadow-[0_1px_2px_rgba(0,0,0,.04)]')}>
      <input
        autoFocus
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && send()}
        placeholder="Type a message"
        className={cn('min-w-0 flex-1 bg-transparent text-[15px] text-label placeholder:text-tertiary focus:outline-none', compact && 'h-9 rounded-full bg-fill px-4')}
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

function useElapsed(since: number | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!since) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [since]);
  return since ? Math.max(0, Math.round((now - since) / 1000)) : 0;
}

function fmt(sec: number) {
  const m = Math.floor(sec / 60);
  return `${m}:${String(sec % 60).padStart(2, '0')}`;
}
