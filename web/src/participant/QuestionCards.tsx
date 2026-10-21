// On-screen answer cards. Participants can click OR answer by voice (the AI calls
// record_answer and the card reflects the recorded value).
import { useState } from 'react';
import { Check, Keyboard } from 'lucide-react';
import type { Question } from '@thinkaloud/shared';
import { Button, cn } from '../ui/index.tsx';
import type { AnswerValue } from './runner.ts';

type Ans = Omit<AnswerValue, 'source'>;

function scalePoints(q: Question): number[] {
  const sc = q.scale ?? { min: 1, max: 5 };
  const step = sc.step ?? 1;
  const out: number[] = [];
  for (let v = sc.min; v <= sc.max + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

export function AnswerInput({ q, answer, onAnswer, allowOpenInput, compact }: { q: Question; answer?: AnswerValue; onAnswer: (a: Ans) => void; allowOpenInput: boolean; compact?: boolean }) {
  const [text, setText] = useState(answer?.text ?? '');
  const [num, setNum] = useState(answer?.value != null ? String(answer.value) : '');
  switch (q.kind) {
    case 'rating': {
      const pts = scalePoints(q);
      if (pts.length > 11) {
        const v = answer?.value ?? null;
        return (
          <div>
            <div className="flex items-center gap-4">
              <input
                type="range"
                min={q.scale?.min ?? 0}
                max={q.scale?.max ?? 100}
                step={q.scale?.step ?? 1}
                value={v ?? Math.round(((q.scale?.min ?? 0) + (q.scale?.max ?? 100)) / 2)}
                onChange={(e) => onAnswer({ value: Number(e.target.value) })}
                aria-label={q.prompt}
                className={cn('h-1.5 w-full cursor-pointer accent-brand-500', v == null && 'opacity-60')}
              />
              <span className="w-10 text-right text-[17px] font-semibold tabular-nums text-label">{v ?? '–'}</span>
            </div>
            <ScaleLabels q={q} />
          </div>
        );
      }
      return (
        <div>
          <div className="flex gap-1.5" role="radiogroup" aria-label={q.prompt}>
            {pts.map((p) => {
              const sel = answer?.value === p;
              return (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={sel}
                  data-value={p}
                  onClick={() => onAnswer({ value: p })}
                  className={cn(
                    'flex-1 rounded-[10px] font-medium tabular-nums transition-all duration-200 ease-apple active:scale-[0.97]',
                    compact ? 'h-10 text-[15px]' : 'h-12 text-[17px]',
                    sel ? 'bg-brand-500 text-white' : 'bg-fill text-label hover:bg-black/[0.07]',
                  )}
                >
                  {p}
                </button>
              );
            })}
          </div>
          <ScaleLabels q={q} />
        </div>
      );
    }
    case 'yes_no':
      return (
        <div className="flex gap-2">
          {['Yes', 'No'].map((o, i) => {
            const sel = answer?.value === (i === 0 ? 1 : 0);
            return (
              <button
                key={o}
                type="button"
                onClick={() => onAnswer({ value: i === 0 ? 1 : 0, choices: [o] })}
                className={cn('h-12 flex-1 rounded-[10px] text-[17px] font-medium transition-all duration-200 ease-apple', sel ? 'bg-brand-500 text-white' : 'bg-fill text-label hover:bg-black/[0.07]')}
              >
                {o}
              </button>
            );
          })}
        </div>
      );
    case 'single_choice':
    case 'multi_choice': {
      const multi = q.kind === 'multi_choice';
      const sel = new Set(answer?.choices ?? []);
      return (
        <div className="overflow-hidden rounded-[12px] bg-fill">
          {(q.options ?? []).map((o, i) => {
            const on = sel.has(o);
            return (
              <button
                key={o}
                type="button"
                onClick={() => {
                  let next: string[];
                  if (multi) {
                    const s = new Set(sel);
                    if (s.has(o)) s.delete(o);
                    else s.add(o);
                    next = (q.options ?? []).filter((x) => s.has(x));
                  } else next = [o];
                  onAnswer({ choices: next, value: (q.options ?? []).indexOf(next[0]) });
                }}
                className={cn('flex w-full items-center justify-between px-4 py-3 text-left text-[16px] text-label transition-colors hover:bg-black/[0.04]', i > 0 && 'border-t border-separator')}
              >
                <span>{o}</span>
                <span className={cn('flex size-5 items-center justify-center rounded-full transition-colors', on ? 'bg-brand-500 text-white' : multi ? 'border border-black/20' : '')}>
                  {on && <Check className="size-3.5" strokeWidth={2.5} />}
                </span>
              </button>
            );
          })}
        </div>
      );
    }
    case 'number':
      return (
        <div className="flex gap-2">
          <input
            type="number"
            inputMode="decimal"
            value={num}
            onChange={(e) => setNum(e.target.value)}
            className="h-12 w-40 rounded-[10px] border border-black/10 bg-white px-3 text-[17px] tabular-nums focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-brand-500/15"
          />
          <Button size="lg" variant="secondary" disabled={num.trim() === '' || !isFinite(Number(num))} onClick={() => onAnswer({ value: Number(num) })}>
            Save
          </Button>
        </div>
      );
    default:
      if (!allowOpenInput) return answer?.text ? <p className="text-[15px] text-secondary">“{answer.text}”</p> : null;
      return (
        <div className="space-y-3">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            placeholder="Type your answer"
            className="block w-full resize-none rounded-[12px] border border-black/10 bg-white px-3.5 py-3 text-[16px] text-label placeholder:text-tertiary focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-brand-500/15"
          />
          <div className="flex justify-end">
            <Button disabled={!text.trim()} onClick={() => onAnswer({ text: text.trim() })}>
              {answer?.text ? 'Update answer' : 'Save answer'}
            </Button>
          </div>
        </div>
      );
  }
}

function ScaleLabels({ q }: { q: Question }) {
  if (!q.scale?.minLabel && !q.scale?.maxLabel) return null;
  return (
    <div className="mt-2 flex justify-between gap-4 text-[13px] text-tertiary">
      <span>{q.scale?.minLabel}</span>
      <span className="text-right">{q.scale?.maxLabel}</span>
    </div>
  );
}

export function QuestionCard({
  q,
  answer,
  onAnswer,
  onDecline,
  voiceMode,
}: {
  q: Question;
  answer?: AnswerValue;
  onAnswer: (a: Ans) => void;
  /** "I'm not sure": a valid answer to every question (stored as declined). */
  onDecline?: () => void;
  voiceMode: boolean;
}) {
  const open = q.kind === 'open';
  // In voice mode the typed answer is optional and tucked away; on screen it is always there.
  const [typing, setTyping] = useState(!voiceMode);
  const hint = open ? (voiceMode ? 'Answer out loud' : null) : voiceMode ? 'Tap an answer or say it out loud' : null;
  const declined = Boolean(answer?.declined);
  return (
    <div
      data-testid="question-card"
      data-qid={q.id}
      className="w-full max-w-[560px] rounded-[22px] bg-surface p-6 shadow-[0_1px_2px_rgba(0,0,0,.04),0_8px_28px_rgba(0,0,0,.06)] [animation:ta-sheet_.35s_cubic-bezier(.32,.72,0,1)]"
    >
      <p className="text-[19px] font-semibold leading-snug tracking-[-0.012em] text-label" data-testid="question-prompt">
        {q.prompt}
      </p>
      {hint && <p className="mt-1 text-[13px] text-tertiary">{hint}</p>}
      {(!open || typing || (answer?.text && !declined)) && (
        <div className="mt-5">
          {open && !typing && answer?.text ? <p className="text-[15px] text-secondary">“{answer.text}”</p> : <AnswerInput q={q} answer={declined ? undefined : answer} onAnswer={onAnswer} allowOpenInput compact={false} />}
        </div>
      )}
      {answer && answer.source !== 'screen' && !open && !declined && (
        <p className="mt-3 flex items-center gap-1.5 text-[13px] text-secondary">
          <span className="size-1.5 rounded-full bg-sys-green" /> Recorded from your voice — tap to change
        </p>
      )}
      <div className="mt-4 flex items-center justify-between gap-3 border-t border-separator pt-3">
        {open && voiceMode && !typing ? (
          <button type="button" onClick={() => setTyping(true)} className="-ml-2 flex h-8 items-center gap-1.5 rounded-full px-2 text-[13px] font-medium text-secondary transition-colors hover:bg-black/5" data-testid="type-answer">
            <Keyboard className="size-4" strokeWidth={1.75} /> Type your answer
          </button>
        ) : (
          <span />
        )}
        {declined ? (
          <span className="flex items-center gap-1.5 text-[13px] text-secondary" data-testid="declined">
            <span className="size-1.5 rounded-full bg-tertiary" /> Not sure — that’s fine
          </span>
        ) : (
          onDecline &&
          !answer && (
            <button type="button" onClick={onDecline} className="-mr-2 flex h-8 items-center rounded-full px-3 text-[13px] font-medium text-secondary transition-colors hover:bg-black/5" data-testid="decline-question">
              I’m not sure
            </button>
          )
        )}
      </div>
    </div>
  );
}

export function QuestionnaireCard({
  title,
  questions,
  answers,
  onAnswer,
  onSubmit,
  submitted,
}: {
  title?: string;
  questions: Question[];
  answers: (qid: string) => AnswerValue | undefined;
  onAnswer: (q: Question, a: Ans) => void;
  onSubmit: () => void;
  submitted?: boolean;
}) {
  const done = questions.filter((q) => answers(q.id)).length;
  const missing = questions.filter((q) => q.required && !answers(q.id)).length;
  return (
    <div data-testid="questionnaire-card" className="w-full max-w-[680px] rounded-[22px] bg-surface shadow-[0_1px_2px_rgba(0,0,0,.04),0_8px_28px_rgba(0,0,0,.06)] [animation:ta-sheet_.35s_cubic-bezier(.32,.72,0,1)]">
      <div className="flex items-baseline justify-between gap-4 px-6 pb-3 pt-6">
        <h2 className="text-[22px] font-semibold tracking-[-0.015em] text-label">{title ?? 'Questionnaire'}</h2>
        <span className="text-[13px] tabular-nums text-tertiary">
          {done} of {questions.length}
        </span>
      </div>
      <ol className="max-h-[56vh] overflow-y-auto px-6">
        {questions.map((q, i) => (
          <li key={q.id} className={cn('py-5', i > 0 && 'border-t border-separator')} data-qid={q.id}>
            <p className="mb-3 text-[16px] leading-snug text-label">
              <span className="mr-2 tabular-nums text-tertiary">{i + 1}.</span>
              {q.prompt}
            </p>
            <AnswerInput q={q} answer={answers(q.id)} onAnswer={(a) => onAnswer(q, a)} allowOpenInput compact />
            {answers(q.id) && answers(q.id)!.source !== 'screen' && (
              <p className="mt-2 flex items-center gap-1.5 text-[12px] text-tertiary" data-testid="voice-answer">
                <span className="size-1.5 rounded-full bg-sys-green" /> From your voice — tap to change
              </p>
            )}
          </li>
        ))}
      </ol>
      <div className="flex items-center justify-between gap-4 border-t border-separator px-6 py-4">
        <span className="text-[13px] text-tertiary">{missing ? `${missing} left to answer` : 'All answered'}</span>
        <Button size="lg" disabled={missing > 0 || submitted} onClick={onSubmit}>
          {submitted ? 'Submitted' : 'Submit'}
        </Button>
      </div>
    </div>
  );
}
