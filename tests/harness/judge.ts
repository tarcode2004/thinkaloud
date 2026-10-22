// Automated judge (deterministic, offline): checks over the event log plus the harness's
// ground-truth timeline of what the synthetic participant actually said/did. No LLM.
import type { LogEvent } from './lib/api.ts';
import { isReadingOf } from './lib/env.ts';
import type { Timeline, UtteranceRec } from './agent.ts';

type Json = Record<string, unknown>;

export type CheckId =
  | 'session_completed'
  | 'wrapup_timing'
  | 'question_repeats'
  | 'card_visible'
  | 'premature_advance'
  | 'done_latency'
  | 'nudge_cap'
  | 'talk_over'
  | 'deflection'
  | 'answer_fidelity'
  | 'answer_after_question'
  | 'language'
  | 'neutral_wording';

export const CHECK_TITLES: Record<CheckId, string> = {
  session_completed: 'Session reached the end',
  wrapup_timing: 'No close while an answer is unfinished or < 1.5s after a fragment',
  question_repeats: 'No question asked more than twice',
  card_visible: 'Every question step has a visible card',
  premature_advance: 'No premature task end / step advance',
  done_latency: 'Done → moderator question latency < 2s (fail > 4s)',
  nudge_cap: 'Silence nudges capped',
  talk_over: 'Moderator never talks over the participant',
  deflection: 'Clarifying questions are answered, not deflected',
  answer_fidelity: 'Recorded answers match what was said',
  answer_after_question: 'Answers only from speech after the question was read out',
  language: 'Moderator speaks only the session language',
  neutral_wording: 'No praise, outcome disclosure or self-narration',
};

export interface Finding {
  t: number;
  stepId?: string | null;
  message: string;
  severity: 'fail' | 'warn';
}

export interface CheckResult {
  id: CheckId;
  title: string;
  status: 'pass' | 'fail' | 'warn' | 'na';
  findings: Finding[];
  note?: string;
}

export interface RubricItem {
  id: string;
  title: string;
  score: number;
  verdict: 'pass' | 'fail';
  summary: string;
  evidence: { t: number; speaker: string; quote: string; note: string }[];
}

export interface Judgement {
  checks: CheckResult[];
  rubric: RubricItem[] | null;
  rubricError?: string;
  failed: number;
  warned: number;
}

const s = (t: number) => `${(t / 1000).toFixed(1)}s`;
const txt = (e: LogEvent) => String(e.data.text ?? '');
const DEFLECT = /what would you do if i (were|was)n'?t here|what do you think (it|that) means|do whatever feels natural|what would you expect|what do you think you should do|what would you do next|was würden sie (tun|machen), wenn ich nicht da wäre|was denken sie, was (das|es) bedeutet/i;
const CLOSE_TOOLS = new Set(['set_task_outcome', 'record_answer', 'complete_step', 'participant_requests_skip', 'end_session']);

interface QInfo {
  stepId: string;
  id: string;
  prompt: string;
  /** Other accepted wordings (the SEQ in English and in the session language). */
  alts?: string[];
  kind: string;
  where: 'question' | 'post' | 'interview' | 'questionnaire';
}

const SEQ_EN = 'Overall, how difficult or easy was the task to complete?';
const SEQ_BY_LANG: Record<string, string> = { de: 'Wie schwierig oder einfach war es insgesamt, die Aufgabe zu erledigen?' };
const reads = (said: string, q: QInfo, th = 0.7) => isReadingOf(said, q.prompt, th) || Boolean(q.alts?.some((a) => isReadingOf(said, a, th)));

function questionsOf(steps: Json[], language = 'en'): QInfo[] {
  const out: QInfo[] = [];
  for (const st of steps) {
    const id = String(st.id);
    if (st.type === 'question') {
      const q = st.question as Json;
      out.push({ stepId: id, id: String(q.id), prompt: String(q.prompt), kind: String(q.kind), where: 'question' });
    } else if (st.type === 'task') {
      if (st.askSEQ) out.push({ stepId: id, id: 'seq', prompt: SEQ_BY_LANG[language] ?? SEQ_EN, alts: SEQ_BY_LANG[language] ? [SEQ_EN] : [], kind: 'rating', where: 'post' });
      for (const q of (st.postTaskQuestions as Json[]) ?? []) out.push({ stepId: id, id: String(q.id), prompt: String(q.prompt), kind: String(q.kind), where: 'post' });
    } else if (st.type === 'interview') {
      (st.questions as string[]).forEach((p, i) => out.push({ stepId: id, id: `${id}_q${i + 1}`, prompt: p, kind: 'open', where: 'interview' }));
    }
  }
  return out;
}

/** Participant speech fragments [start,end] — harness ground truth when available, else VAD events. */
function participantFragments(events: LogEvent[], tl: Timeline | null): { start: number; end: number; text: string; u?: UtteranceRec; idx?: number }[] {
  if (tl && tl.utterances.length) return tl.utterances.flatMap((u) => u.chunks.map((c, idx) => ({ start: c.start, end: c.end, text: c.text, u, idx })));
  const out: { start: number; end: number; text: string }[] = [];
  let open: number | null = null;
  for (const e of events) {
    if (e.kind === 'speech.start' && e.data.who === 'participant') open = e.t;
    if (e.kind === 'speech.stop' && e.data.who === 'participant' && open != null) {
      out.push({ start: open, end: e.t, text: '' });
      open = null;
    }
  }
  return out;
}

/** Windows in which the participant's utterance is unfinished (mid-answer pauses, or cut short). */
function unfinishedWindows(tl: Timeline | null): { from: number; to: number; u: UtteranceRec; said: string; rest: string }[] {
  if (!tl) return [];
  const out: { from: number; to: number; u: UtteranceRec; said: string; rest: string }[] = [];
  for (const u of tl.utterances) {
    for (let i = 0; i < u.planned.length - 1; i++) {
      const c = u.chunks[i];
      if (!c) break;
      const next = u.chunks[i + 1];
      const to = next ? next.start : c.end + u.planned[i].pauseAfterMs + 2500;
      out.push({ from: c.end, to, u, said: u.planned.slice(0, i + 1).map((x) => x.text).join(' '), rest: u.planned.slice(i + 1).map((x) => x.text).join(' ') });
    }
  }
  return out;
}

export function runChecks(o: { events: LogEvent[]; steps: Json[]; timeline: Timeline | null; expect?: Partial<Record<CheckId, 'fail' | 'warn' | 'off'>>; completed: boolean; language?: string; verbatim?: string[] }): CheckResult[] {
  const ev = [...o.events].sort((a, b) => a.t - b.t);
  const tl = o.timeline;
  const qs = questionsOf(o.steps, o.language);
  const frags = participantFragments(ev, tl);
  const unfinished = unfinishedWindows(tl);
  const modTurns = ev.filter((e) => e.kind === 'transcript.moderator');
  const modStarts = ev.filter((e) => e.kind === 'speech.start' && e.data.who === 'moderator').map((e) => e.t);
  const results: CheckResult[] = [];
  const add = (id: CheckId, findings: Finding[], note?: string, na = false) => {
    const sev = o.expect?.[id];
    if (sev === 'off') return void results.push({ id, title: CHECK_TITLES[id], status: 'na', findings: [], note: 'disabled for this scenario' });
    const f = sev === 'warn' ? findings.map((x) => ({ ...x, severity: 'warn' as const })) : findings;
    const status = na ? 'na' : f.some((x) => x.severity === 'fail') ? 'fail' : f.length ? 'warn' : 'pass';
    results.push({ id, title: CHECK_TITLES[id], status, findings: f, note });
  };
  const lastFragEndBefore = (t: number) => frags.filter((f) => f.end <= t).reduce((m, f) => Math.max(m, f.end), -Infinity);
  const speakingAt = (t: number) => frags.find((f) => f.start - 150 <= t && t <= f.end - 250);
  const stepAt = (t: number) => [...ev].reverse().find((e) => e.kind === 'step.enter' && e.t <= t)?.stepId ?? null;

  // 1 — session completed
  add('session_completed', o.completed ? [] : [{ t: ev.at(-1)?.t ?? 0, message: `Session did not reach the done screen (${tl?.endReason ?? 'incomplete'}).`, severity: 'fail' }]);

  // 2 — wrap-up timing: closes while the answer is unfinished, or < 1.5 s after a fragment.
  {
    const f: Finding[] = [];
    const closes: { t: number; what: string; strict: boolean; stepId?: string | null }[] = [];
    for (const e of ev) {
      if (e.kind === 'moderator.tool' && CLOSE_TOOLS.has(String(e.data.name)) && e.data.ok !== false) {
        const name = String(e.data.name);
        const qid = String((e.data.args as Json | undefined)?.question_id ?? '');
        const q = qs.find((x) => x.id === qid && x.stepId === e.stepId);
        const open = name === 'record_answer' && (!q || q.kind === 'open');
        closes.push({ t: e.t, what: `${name}${qid ? `(${qid})` : ''}`, strict: name === 'set_task_outcome' || open || name === 'end_session', stepId: e.stepId });
      }
      if (e.kind === 'step.enter' && e.t > 0 && e.data.type === 'closing') closes.push({ t: e.t, what: 'closing step entered', strict: true, stepId: e.stepId });
    }
    for (const c of closes) {
      const w = unfinished.find((x) => c.t >= x.from && c.t <= x.to);
      if (w) {
        f.push({ t: c.t, stepId: c.stepId, severity: 'fail', message: `${c.what} while the participant's answer was unfinished: said "${w.said}" … still to say "${w.rest}" (mid-answer pause).` });
        continue;
      }
      const last = lastFragEndBefore(c.t);
      const gap = c.t - last;
      if (c.strict && isFinite(last) && gap >= 0 && gap < 1500) {
        const frag = frags.find((x) => x.end === last);
        // With ground truth: a complete answer (all chunks said, nothing more within 3 s) closed quickly is only a warning.
        const complete = frag?.u ? frag.u.finished && frag.idx === frag.u.chunks.length - 1 && !frags.some((x) => x.start > last && x.start < last + 3000) : false;
        f.push({ t: c.t, stepId: c.stepId, severity: complete ? 'warn' : 'fail', message: `${c.what} only ${gap} ms after the participant's last speech fragment${frag?.text ? ` ("${frag.text}")` : ''}${complete ? ' (answer was complete)' : ''}.` });
      }
    }
    for (const w of unfinished) {
      const m = modStarts.find((t) => t >= w.from + 200 && t <= w.to);
      if (m != null && !f.some((x) => Math.abs(x.t - m) < 1500)) f.push({ t: m, stepId: w.u.stepId, severity: 'fail', message: `Moderator started talking into a mid-answer pause: participant had said "${w.said}" and was about to say "${w.rest}".` });
    }
    add('wrapup_timing', f, tl ? undefined : 'no harness timeline: unfinished-answer detection unavailable; 1.5 s rule on VAD fragments only');
  }

  // 3 — question repeats: readings + re-asks between first reading and resolution.
  {
    const f: Finding[] = [];
    for (const q of qs) {
      const inStep = modTurns.filter((e) => e.stepId === q.stepId);
      const first = inStep.find((e) => reads(txt(e), q));
      if (!first) continue;
      const answered = ev.find((e) => e.kind === 'answer' && e.data.questionId === q.id && e.stepId === q.stepId && e.t >= first.t);
      const skipped = ev.find((e) => e.kind === 'observation' && e.data.kind === 'question_skipped' && e.data.questionId === q.id && e.t >= first.t);
      const others = qs.filter((x) => x.stepId === q.stepId && x.id !== q.id);
      const nextOther = inStep.find((e) => e.t > first.t && others.some((x) => reads(txt(e), x)));
      const until = Math.min(answered?.t ?? Infinity, skipped?.t ?? Infinity, nextOther?.t ?? Infinity, ev.find((e) => e.kind === 'step.exit' && e.stepId === q.stepId && e.t > first.t)?.t ?? Infinity);
      const asks = inStep.filter((e) => e.t >= first.t && e.t <= until && (reads(txt(e), q) || (e.t > first.t && (/[?？]/.test(txt(e)) || /\byes or no\b|\bja oder nein\b|pick (a|the|one)|closest to you|wählen sie eine zahl/i.test(txt(e))))));
      if (asks.length > 2)
        f.push({ t: asks[2].t, stepId: q.stepId, severity: 'fail', message: `"${q.prompt}" (${q.id}) asked ${asks.length}× before it was resolved: ${asks.map((a) => `[${s(a.t)}] "${txt(a).slice(0, 80)}"`).join(' · ')}` });
    }
    add('question_repeats', f);
  }

  // 4 — every question (question steps, post-task questions) has a visible on-screen card while it is asked.
  {
    const f: Finding[] = [];
    let na = false;
    if (!tl || !tl.ui.length) na = true;
    else
      for (const q of qs) {
        const readings = modTurns.filter((e) => e.stepId === q.stepId && reads(txt(e), q));
        const seen = new Set<string>();
        for (const r of readings) {
          const key = `${q.stepId}::${q.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const win = tl.ui.filter((u) => u.t >= r.t - 1500 && u.t <= r.t + 4000);
          const ok = win.some((u) => u.card?.visible && (u.card.activeQuestionId === q.id || (u.card.prompt && reads(u.card.prompt, q, 0.8))));
          if (!ok) {
            const skipped = ev.some((e) => e.kind === 'task.end' && e.stepId === q.stepId && e.data.source === 'participant' && e.t < r.t);
            f.push({
              t: r.t,
              stepId: q.stepId,
              severity: q.where === 'interview' ? 'warn' : 'fail',
              message: `No visible question card while the moderator asked "${q.prompt}" (${q.kind}, ${q.where === 'post' ? `post-task${skipped ? ', after the task was skipped' : ''}` : q.where}).`,
            });
          }
        }
      }
    add('card_visible', f, na ? 'no UI timeline' : 'interview questions are reported as warnings', na);
  }

  // 5 — premature advance: AI task end without a done/skip signal; answers recorded on silence; step change mid-utterance.
  {
    const f: Finding[] = [];
    const doneSignals = (stepId: string | null | undefined, before: number) => {
      const sig: number[] = [];
      for (const e of ev) if (e.stepId === stepId && e.t <= before && e.kind === 'observation' && e.data.kind === 'participant_done_button') sig.push(e.t);
      if (tl) {
        for (const u of tl.utterances) if (u.stepId === stepId && (u.intent === 'declare_done' || u.intent === 'request_skip') && u.start <= before) sig.push(u.start);
        for (const a of tl.actions) if (a.stepId === stepId && (a.kind === 'press_done' || a.kind === 'press_skip') && a.t <= before) sig.push(a.t);
      } else {
        for (const e of ev)
          if (e.stepId === stepId && e.t <= before && e.kind === 'transcript.participant' && /\b(i'?m done|i am done|done\b|finished|that'?s it|fertig|skip)/i.test(txt(e)) && !/\?\s*$/.test(txt(e).trim())) sig.push(e.t);
      }
      return sig;
    };
    for (const e of ev) {
      if (e.kind === 'task.end' && e.data.source === 'ai' && !doneSignals(e.stepId, e.t).length) {
        const lastP = [...ev].reverse().find((x) => x.kind === 'transcript.participant' && x.t <= e.t && x.stepId === e.stepId);
        f.push({ t: e.t, stepId: e.stepId, severity: 'fail', message: `Task ended by the AI (${String(e.data.outcome)}) although the participant never said they were done or pressed "I'm done"${lastP ? ` — last thing they said: "${txt(lastP).slice(0, 100)}"` : ''}.` });
      }
      if (e.kind === 'moderator.tool' && e.data.ok !== false && (e.data.name === 'record_answer' || e.data.name === 'set_task_outcome')) {
        // The moderator's latest turn before the close (a question may be cut short and lack the "?").
        const q = [...modTurns].reverse().find((m) => m.t < e.t && m.stepId === e.stepId && !/^\W*(thanks|thank you|okay|ok|got it|danke|alles klar)\W*$/i.test(txt(m)));
        if (!q) continue;
        const screen = ev.some((x) => x.kind === 'answer' && x.data.source === 'screen' && x.t > q.t && x.t <= e.t);
        if (screen) continue;
        // When the moderator started that turn (transcripts complete at its end; ASR lags, so use speech starts).
        const prevTurn = [...modTurns].reverse().find((m) => m.t < q.t);
        const qStart = [...modStarts].reverse().find((t) => t <= q.t && t > (prevTurn?.t ?? -Infinity)) ?? q.t - 1500;
        const spoke = tl
          ? frags.some((x) => x.start >= qStart - 300 && x.start < e.t)
          : ev.some((x) => x.kind === 'transcript.participant' && Number(x.data.startT ?? x.t) >= qStart - 300 && x.t <= e.t + 200);
        if (!spoke && tl) f.push({ t: e.t, stepId: e.stepId, severity: 'fail', message: `${String(e.data.name)} after "${txt(q).slice(0, 80)}" although the participant had not said anything since (silence treated as an answer)${e.data.args && (e.data.args as Json).text ? `; recorded: "${String((e.data.args as Json).text).slice(0, 100)}"` : ''}.` });
      }
      if (e.kind === 'step.enter' && e.t > 0) {
        const w = unfinished.find((x) => e.t >= x.from && e.t <= x.to);
        if (w) f.push({ t: e.t, stepId: e.stepId, severity: 'fail', message: `Advanced to "${String(e.data.title)}" while the participant was mid-answer ("${w.said}" … "${w.rest}").` });
      }
    }
    add('premature_advance', f);
  }

  // 6 — Done → question latency (button), and a stuck "pending" Done button.
  {
    const f: Finding[] = [];
    const presses = tl ? tl.actions.filter((a) => a.kind === 'press_done' && a.ok).map((a) => ({ t: a.t, stepId: a.stepId })) : ev.filter((e) => e.kind === 'observation' && e.data.kind === 'participant_done_button').map((e) => ({ t: e.t, stepId: e.stepId }));
    for (const p of presses) {
      const next = modStarts.find((t) => t > p.t);
      const lat = next != null ? next - p.t : Infinity;
      if (lat > 4000) f.push({ t: p.t, stepId: p.stepId, severity: 'fail', message: `"I'm done" pressed → moderator spoke ${isFinite(lat) ? `${(lat / 1000).toFixed(1)} s` : 'never'} later (limit 4 s).` });
      else if (lat > 2000) f.push({ t: p.t, stepId: p.stepId, severity: 'warn', message: `"I'm done" pressed → moderator spoke ${(lat / 1000).toFixed(1)} s later (target < 2 s).` });
    }
    if (tl) {
      let since: number | null = null;
      for (const u of tl.ui) {
        if (u.pending === 'done') since ??= u.t;
        else if (since != null) {
          // Pending is fine once the moderator has reacted (asked how it went); it is the user-reported
          // problem when the button is stuck and nothing is said.
          const answered = modStarts.find((t) => t > since! && t < u.t);
          const silentFor = (answered ?? u.t) - since;
          if (silentFor > 8000) f.push({ t: since, stepId: u.stepId, severity: 'fail', message: `"I'm done" button stayed pending for ${(silentFor / 1000).toFixed(1)} s with no reaction from the moderator.` });
          else if (u.t - since > 15_000) f.push({ t: since, stepId: u.stepId, severity: 'warn', message: `"I'm done" button disabled for ${((u.t - since) / 1000).toFixed(1)} s while the wrap-up ran (moderator reacted after ${((silentFor) / 1000).toFixed(1)} s).` });
          since = null;
        }
      }
      const taskSteps = new Set(ev.filter((x) => x.kind === 'task.start').map((x) => x.stepId));
      for (const u of tl.utterances.filter((x) => x.intent === 'declare_done' && x.finished && taskSteps.has(x.stepId))) {
        const next = modStarts.find((t) => t > u.end);
        const lat = next != null ? next - u.end : Infinity;
        if (lat > 6000) f.push({ t: u.end, stepId: u.stepId, severity: 'warn', message: `Said they were done ("${u.text.slice(0, 60)}") → moderator replied ${isFinite(lat) ? `${(lat / 1000).toFixed(1)} s` : 'never'} later.` });
      }
    }
    add('done_latency', f, presses.length ? undefined : 'no Done-button presses', !presses.length && !(tl?.utterances.some((x) => x.intent === 'declare_done')));
  }

  // 7 — nudges capped (3 per task + 1 check-in), never while the participant talks.
  {
    const f: Finding[] = [];
    const per = new Map<string, LogEvent[]>();
    for (const e of ev.filter((x) => x.kind === 'moderator.nudge')) per.set(String(e.stepId), [...(per.get(String(e.stepId)) ?? []), e]);
    for (const [stepId, ns] of per) {
      const regular = ns.filter((n) => n.data.kind !== 'check_in');
      const checkIns = ns.filter((n) => n.data.kind === 'check_in');
      if (regular.length > 3) f.push({ t: regular[3].t, stepId, severity: 'fail', message: `${regular.length} silence nudges in one task (cap 3).` });
      if (checkIns.length > 1) f.push({ t: checkIns[1].t, stepId, severity: 'fail', message: `${checkIns.length} check-ins in one task (cap 1).` });
      for (const n of ns) {
        const sp = speakingAt(n.t);
        if (sp) f.push({ t: n.t, stepId, severity: 'fail', message: `Nudge fired while the participant was speaking ("${sp.text.slice(0, 60)}").` });
      }
    }
    add('nudge_cap', f);
  }

  // 8 — moderator talk-over.
  {
    const f: Finding[] = [];
    for (const t of modStarts) {
      const sp = speakingAt(t);
      if (sp) f.push({ t, stepId: stepAt(t), severity: 'fail', message: `Moderator started speaking while the participant was talking${sp.text ? ` ("${sp.text.slice(0, 70)}")` : ''}.` });
    }
    add('talk_over', f, tl ? 'ground truth: harness audio playback windows' : 'VAD speech events only');
  }

  // 9 — clarifying questions / meta questions / observations deflected.
  {
    const f: Finding[] = [];
    const asks = tl
      ? tl.utterances.filter((u) => ['clarify', 'meta_question', 'observation', 'complaint'].includes(u.intent) && u.chunks.length).map((u) => ({ t: u.end, text: u.text, intent: u.intent }))
      : ev.filter((e) => e.kind === 'transcript.participant' && /\?\s*$|\bi don'?t (see|understand)|what does (that|it) mean/i.test(txt(e))).map((e) => ({ t: e.t, text: txt(e), intent: 'clarify' }));
    for (const a of asks) {
      const reply = modTurns.find((m) => m.t > a.t && m.t < a.t + 20_000);
      if (reply && DEFLECT.test(txt(reply)))
        f.push({ t: reply.t, stepId: reply.stepId, severity: a.intent === 'observation' ? 'warn' : 'fail', message: `Participant (${a.intent}): "${a.text.slice(0, 80)}" → moderator deflected: "${txt(reply).slice(0, 100)}"` });
      // A question during a task ("Do I click done?") that the system answered by ending the task instead.
      if (tl && (a.intent === 'meta_question' || a.intent === 'clarify') && /\?\s*$/.test(a.text.trim())) {
        const stepId = stepAt(a.t);
        const end = ev.find((e) => e.kind === 'task.end' && e.stepId === stepId && e.t > a.t && e.data.source === 'ai');
        const answered = modTurns.some((m) => m.t > a.t && (!end || m.t < end.t) && !/how do you feel|wie ist es/i.test(txt(m)));
        const pressed = tl.actions.some((x) => x.stepId === stepId && x.t > a.t && (!end || x.t < end.t) && (x.kind === 'press_done' || x.kind === 'press_skip'));
        if (end && !answered && !pressed) f.push({ t: end.t, stepId, severity: 'fail', message: `Participant asked "${a.text.slice(0, 80)}" during the task and got no answer: the task was ended instead.` });
      }
    }
    add('deflection', f);
  }
  // 10 — recorded closed answers must reflect what the participant said ("I don't know" ≠ "No").
  {
    const f: Finding[] = [];
    const DK = /\b(i (don'?t|do not) know|no idea|not sure|dunno|i'?m unsure|weiß (es |ich )?nicht|keine ahnung)\b/i;
    const DEFINITE = /\b(yes|yeah|yep|no(?!\s+idea)|nope|ja|nein|\d+|one|two|three|four|five|six|seven|eins|zwei|drei|vier|fünf|sechs|sieben)\b/i;
    for (const e of ev) {
      if (e.kind !== 'moderator.tool' || e.data.name !== 'record_answer' || e.data.ok === false) continue;
      const args = (e.data.args ?? {}) as Json;
      if (args.value == null && !(Array.isArray(args.choices) && args.choices.length)) continue;
      const q = [...modTurns].reverse().find((m) => m.t < e.t && m.stepId === e.stepId);
      if (!q) continue;
      const said = tl
        ? tl.utterances.filter((u) => u.chunks.length && u.start >= q.t - 3000 && u.start < e.t).map((u) => u.chunks.map((c) => c.text).join(' '))
        : ev.filter((x) => x.kind === 'transcript.participant' && x.t > q.t - 3000 && x.t <= e.t + 200).map(txt);
      const all = said.join(' ');
      if (said.length && DK.test(all) && !DEFINITE.test(all.replace(DK, '')))
        f.push({ t: e.t, stepId: e.stepId, severity: 'fail', message: `record_answer(${String(args.question_id)}) stored ${JSON.stringify(args.value ?? args.choices)} although the participant only said "${all.slice(0, 100)}".` });
    }
    add('answer_fidelity', f);
  }

  // 10b — a recorded answer only uses speech that started after the question was read out (never
  // thinking aloud from the task, never what was said while the question was still to come).
  {
    const f: Finding[] = [];
    const norm = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
    for (const e of ev) {
      if (e.kind !== 'moderator.tool' || e.data.name !== 'record_answer' || e.data.ok === false) continue;
      const args = (e.data.args ?? {}) as Json;
      const q = qs.find((x) => x.id === String(args.question_id ?? '') && x.stepId === e.stepId);
      if (!q) continue;
      const reading = [...modTurns].reverse().find((m) => m.t <= e.t && m.stepId === e.stepId && reads(txt(m), q));
      if (!reading) {
        f.push({ t: e.t, stepId: e.stepId, severity: 'fail', message: `record_answer(${q.id}) by voice although "${q.prompt}" was never read out.` });
        continue;
      }
      // The reading's audio started at the last moderator speech start before its transcript.
      const prevTurn = [...modTurns].reverse().find((m) => m.t < reading.t);
      const qStart = [...modStarts].reverse().find((t) => t <= reading.t && t > (prevTurn?.t ?? -Infinity)) ?? reading.t - 2500;
      const text = norm(String(args.text ?? ''));
      if (!text || !tl) continue;
      const after = tl.utterances.flatMap((u) => u.chunks).filter((c) => c.start >= qStart - 300 && c.start <= e.t).map((c) => norm(c.text));
      for (const u of tl.utterances) {
        for (const c of u.chunks) {
          if (c.end > qStart) continue;
          const head = norm(c.text).split(' ').slice(0, 5).join(' ');
          // (The same words said again after the question are fine.)
          if (head.split(' ').length >= 3 && text.includes(head) && !after.some((x) => x.includes(head)))
            f.push({ t: e.t, stepId: e.stepId, severity: 'fail', message: `record_answer(${q.id}) used words said before the question was read out ("${c.text.slice(0, 70)}" at ${s(c.start)}; question started ${s(qStart)}).` });
        }
      }
    }
    add('answer_after_question', f, tl ? undefined : 'no harness timeline: only "never read out" is checked');
  }

  // 11 — language consistency: in a non-English session, no moderator line may be mostly English.
  {
    const f: Finding[] = [];
    const lang = o.language ?? 'en';
    if (lang !== 'en') {
      const EN = new Set('the and you your what how was is are to of it that this do does did please thanks thank overall difficult easy task complete would like let move on stop there problem keep talking thinking right now'.split(' '));
      for (const m of modTurns) {
        const ws = txt(m).toLowerCase().match(/[a-zäöüß']+/g) ?? [];
        const en = ws.filter((w) => EN.has(w)).length;
        if (ws.length >= 1 && en / ws.length >= 0.4) f.push({ t: m.t, stepId: m.stepId, severity: 'fail', message: `English in a "${lang}" session: "${txt(m).slice(0, 100)}"` });
        else {
          const lead = /^(thanks|thank you|got it|great)\b[.!,]?(\s|$)/i.exec(txt(m));
          if (lead && lang !== 'en') f.push({ t: m.t, stepId: m.stepId, severity: 'fail', message: `English acknowledgement "${lead[1]}" in a "${lang}" session: "${txt(m).slice(0, 80)}"` });
        }
      }
      // Standard instruments (the SEQ) must be presented — and recorded — in the session language.
      for (const e of ev.filter((x) => x.kind === 'answer' && x.data.questionId === 'seq')) {
        const w = String(e.data.wording ?? '');
        if (!w) f.push({ t: e.t, stepId: e.stepId, severity: 'warn', message: 'SEQ answer recorded without the wording that was presented.' });
        else if (!new RegExp(`/${lang}\\b`).test(w) && !/translated/i.test(w)) f.push({ t: e.t, stepId: e.stepId, severity: 'fail', message: `SEQ answer recorded with wording "${w}" in a "${lang}" session.` });
      }
      const enCard = tl?.ui.find((u) => u.card?.visible && u.card.activeQuestionId === 'seq' && u.card.prompt && isReadingOf(u.card.prompt, SEQ_EN, 0.8));
      if (enCard) f.push({ t: enCard.t, stepId: enCard.stepId, severity: 'fail', message: `SEQ card shown in English in a "${lang}" session: "${enCard.card!.prompt}"` });
    }
    add('language', f, lang === 'en' ? 'English session' : undefined, lang === 'en');
  }

  // 12 — neutral wording: no praise / outcome disclosure, no narration of tool use.
  {
    const f: Finding[] = [];
    const FILLER = /\b(let me (note|record|write|save|log|check|capture)|i('ll| will) (note|record|write|save|log|capture)|(noting|recording|saving|capturing) (that|this|your)|one moment|just a (moment|second)|i have what i need|(that'?s|it'?s|all) noted|got (that|it) down|making a note|(one|a) quick follow-?up)\b/i;
    const JUDGEMENT = /\b(great job|well done|perfect|correct(ly)?|you did it|success(fully)?|nice work|good job|you (failed|got it)|unfortunately|gut gemacht|richtig|perfekt)\b/i;
    for (const m of modTurns) {
      if (FILLER.test(txt(m))) f.push({ t: m.t, stepId: m.stepId, severity: 'fail', message: `Self-narration: "${txt(m).slice(0, 100)}"` });
      if (JUDGEMENT.test(txt(m)) && !o.verbatim?.some((v) => isReadingOf(txt(m), v, 0.8))) f.push({ t: m.t, stepId: m.stepId, severity: 'fail', message: `Praise / outcome disclosure: "${txt(m).slice(0, 100)}"` });
    }
    add('neutral_wording', f);
  }
  return results;
}

// ── transcript for the LLM judge / report ────────────────────────────────────

export function conversationLines(events: LogEvent[], tl: Timeline | null): { t: number; who: string; text: string }[] {
  const lines: { t: number; who: string; text: string }[] = [];
  for (const e of events) {
    if (e.kind === 'transcript.moderator') lines.push({ t: e.t, who: 'MODERATOR', text: txt(e) });
    else if (e.kind === 'transcript.participant' && !tl) lines.push({ t: e.t, who: 'PARTICIPANT', text: txt(e) });
    else if (e.kind === 'transcript.participant' && tl) lines.push({ t: e.t, who: 'asr', text: `(moderator heard: "${txt(e)}")` });
    else if (e.kind === 'step.enter') lines.push({ t: e.t, who: 'EVENT', text: `step → ${String(e.data.title)} (${String(e.data.type)})` });
    else if (e.kind === 'task.start') lines.push({ t: e.t, who: 'EVENT', text: `task started (${String(e.data.trigger)})` });
    else if (e.kind === 'task.end') lines.push({ t: e.t, who: 'EVENT', text: `task ended: ${String(e.data.outcome)} by ${String(e.data.source)}` });
    else if (e.kind === 'moderator.tool') lines.push({ t: e.t, who: 'TOOL', text: `${String(e.data.name)} ${JSON.stringify(e.data.args ?? {}).slice(0, 160)}${e.data.ok === false ? ` → ERROR ${String(e.data.error ?? '')}` : ''}` });
    else if (e.kind === 'moderator.nudge') lines.push({ t: e.t, who: 'EVENT', text: `silence nudge #${String(e.data.n)} (${String(e.data.silentSec)}s silent)` });
    else if (e.kind === 'answer') lines.push({ t: e.t, who: 'EVENT', text: `answer recorded ${String(e.data.questionId)} = ${JSON.stringify(e.data.value ?? e.data.choices ?? e.data.text)} (${String(e.data.source)})` });
    else if (e.kind === 'observation' && e.data.kind === 'participant_done_button') lines.push({ t: e.t, who: 'EVENT', text: 'participant pressed "I\'m done"' });
  }
  if (tl) {
    for (const u of tl.utterances) {
      // One line per spoken chunk at its real time, so tool calls / moderator lines inside a pause show up inside it.
      u.chunks.forEach((c, i) => {
        const last = i === u.chunks.length - 1;
        const more = !last || !u.finished;
        const pause = !last ? ` …(${((u.chunks[i + 1].start - c.end) / 1000).toFixed(1)}s thinking pause, continues below)` : !u.finished ? ' …(thinking pause)' : '';
        lines.push({ t: c.start, who: `PARTICIPANT[${u.intent}]${u.chunks.length > 1 || !u.finished ? ` part ${i + 1}` : ''}`, text: `${i > 0 ? '…' : ''}${c.text}${more ? pause : ''}` });
      });
      if (!u.finished && u.chunks.length) {
        const c = u.chunks[u.chunks.length - 1];
        lines.push({ t: c.end + 1, who: 'NOTE', text: `participant stopped because the moderator talked into their pause; they still wanted to say: "${u.planned.slice(u.chunks.length).map((x) => x.text).join(' ')}"` });
      }
    }
    for (const a of tl.actions) if (a.kind !== 'speak') lines.push({ t: a.t, who: 'PARTICIPANT-ACTION', text: `${a.kind} ${a.detail}${a.ok ? '' : ` (failed: ${a.error ?? ''})`}` });
  }
  return lines.sort((a, b) => a.t - b.t);
}

export async function judge(o: { events: LogEvent[]; steps: Json[]; protocol: Json; verbatim: { kind: string; stepId: string; text: string }[]; timeline: Timeline | null; expect?: Partial<Record<CheckId, 'fail' | 'warn' | 'off'>>; completed: boolean }): Promise<Judgement & { overall?: string }> {
  const language = String(((o.protocol.moderation ?? {}) as Json).language ?? 'en').toLowerCase().split(/[-_]/)[0];
  const checks = runChecks({ ...o, language, verbatim: o.verbatim.map((v) => v.text) });
  const failed = checks.filter((c) => c.status === 'fail').length;
  const warned = checks.filter((c) => c.status === 'warn').length;
  return { checks, rubric: null, failed, warned };
}
