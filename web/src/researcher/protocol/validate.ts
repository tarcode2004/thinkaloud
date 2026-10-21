import type { Protocol, Question, Step } from '@thinkaloud/shared';

export type IssueLevel = 'error' | 'warning' | 'info';
export interface LocalIssue {
  stepId?: string;
  /** 'general' | 'moderation' | 'consent' for non-step sections */
  section?: 'general' | 'moderation' | 'consent';
  level: IssueLevel;
  message: string;
}

const PLACEHOLDER = /…|\.\.\.|\bTODO\b|Describe what success looks like/i;
// Phrases that tend to lead participants or reveal the path.
const LEADING = [
  /\b(was|is|did you find) (it|that|this) (easy|simple|intuitive|clear|helpful|great)\b/i,
  /\bdon'?t you (think|agree)\b/i,
  /\bhow (easy|great|good|helpful) (was|is)\b/i,
  /\bwouldn'?t you\b/i,
];
const REVEALING = /\b(click|tap|press|select) (on )?(the )?["'“]?[A-Z][\w ]{1,24}["'”]? (button|link|tab|menu|icon)\b/;

function checkQuestion(q: Question, stepId: string, label: string, out: LocalIssue[]) {
  if (!q.prompt?.trim()) out.push({ stepId, level: 'error', message: `${label}: question text is empty.` });
  if ((q.kind === 'single_choice' || q.kind === 'multi_choice') && (q.options?.filter((o) => o.trim()).length ?? 0) < 2)
    out.push({ stepId, level: 'error', message: `${label}: choice questions need at least 2 options.` });
  if (q.kind === 'rating' && q.scale && q.scale.min >= q.scale.max) out.push({ stepId, level: 'error', message: `${label}: rating scale minimum must be below the maximum.` });
  if (q.prompt && LEADING.some((r) => r.test(q.prompt))) out.push({ stepId, level: 'warning', message: `${label}: wording may be leading. Prefer open, neutral phrasing ("How was that?").` });
  if (q.prompt && /\band\b.*\?/.test(q.prompt) && /\b(how|what|why)\b.*\band (how|what|why)\b/i.test(q.prompt))
    out.push({ stepId, level: 'warning', message: `${label}: looks double-barreled. Ask one thing at a time.` });
}

export function validateStep(s: Step, i: number): LocalIssue[] {
  const out: LocalIssue[] = [];
  const label = s.title?.trim() || `Step ${i + 1}`;
  switch (s.type) {
    case 'instruction':
      if (!s.script?.trim()) out.push({ stepId: s.id, level: 'error', message: `${label}: the moderator has nothing to say (script is empty).` });
      break;
    case 'question':
      checkQuestion(s.question, s.id, label, out);
      break;
    case 'task':
      if (!s.instruction?.trim()) out.push({ stepId: s.id, level: 'error', message: `${label}: task instruction is empty.` });
      else if (PLACEHOLDER.test(s.instruction)) out.push({ stepId: s.id, level: 'warning', message: `${label}: instruction still contains placeholder text ("…").` });
      if (!s.successCriteria?.trim() || PLACEHOLDER.test(s.successCriteria))
        out.push({ stepId: s.id, level: 'warning', message: `${label}: add hidden success criteria so the moderator and analysis know what "done" means.` });
      if (!s.successRules?.length) out.push({ stepId: s.id, level: 'info', message: `${label}: no automatic success rules. Outcome will be judged by the AI from behaviour and speech.` });
      for (const r of s.successRules ?? []) {
        const empty =
          (r.type === 'url_matches' && !r.pattern?.trim()) ||
          (r.type === 'element_visible' && !r.selector?.trim()) ||
          (r.type === 'text_visible' && !r.text?.trim()) ||
          (r.type === 'click_matches' && !r.selector?.trim() && !r.text?.trim()) ||
          (r.type === 'custom_event' && !r.name?.trim());
        if (empty) out.push({ stepId: s.id, level: 'error', message: `${label}: a success rule is incomplete.` });
        if (r.type === 'url_matches' && r.pattern) {
          try {
            new RegExp(r.pattern);
          } catch {
            out.push({ stepId: s.id, level: 'error', message: `${label}: URL pattern "${r.pattern}" is not a valid regular expression.` });
          }
        }
      }
      if (s.instruction && REVEALING.test(s.instruction)) out.push({ stepId: s.id, level: 'warning', message: `${label}: instruction names a UI control. Describe the goal, not the path.` });
      if (s.instruction && LEADING.some((r) => r.test(s.instruction))) out.push({ stepId: s.id, level: 'warning', message: `${label}: instruction may be leading.` });
      s.postTaskQuestions?.forEach((q, j) => checkQuestion(q, s.id, `${label} › follow-up ${j + 1}`, out));
      break;
    case 'questionnaire':
      if (s.instrument === 'custom') {
        if (!s.questions?.length) out.push({ stepId: s.id, level: 'error', message: `${label}: custom questionnaire has no questions.` });
        s.questions?.forEach((q, j) => checkQuestion(q, s.id, `${label} › item ${j + 1}`, out));
      }
      break;
    case 'interview':
      if (!s.questions?.filter((q) => q.trim()).length) out.push({ stepId: s.id, level: 'error', message: `${label}: interview has no questions.` });
      s.questions?.forEach((q, j) => {
        if (LEADING.some((r) => r.test(q))) out.push({ stepId: s.id, level: 'warning', message: `${label} › Q${j + 1}: wording may be leading.` });
      });
      break;
  }
  return out;
}

export function validateProtocol(p: Protocol): LocalIssue[] {
  const out: LocalIssue[] = [];
  if (!p.steps.length) out.push({ level: 'error', section: 'general', message: 'The protocol has no steps yet.' });
  if (!p.steps.some((s) => s.type === 'task')) out.push({ level: 'info', section: 'general', message: 'No tasks. That is fine for an interview-only study.' });
  if (!p.researchGoals.filter((g) => g.trim()).length) out.push({ level: 'warning', section: 'general', message: 'Add research goals. The moderator and AI synthesis use them for focus.' });
  if (!p.intro.trim()) out.push({ level: 'warning', section: 'general', message: 'Intro is empty. Participants should hear the AI disclosure and the think-aloud request.' });
  else if (!/\bAI\b|artificial|automated/i.test(p.intro)) out.push({ level: 'warning', section: 'general', message: 'Intro does not disclose that the moderator is an AI (EU AI Act Art. 50).' });
  if (!p.consent.text.trim()) out.push({ level: 'error', section: 'consent', message: 'Consent text is empty.' });
  const ids = new Set<string>();
  p.steps.forEach((s) => {
    if (ids.has(s.id)) out.push({ stepId: s.id, level: 'error', message: `Duplicate step id "${s.id}".` });
    ids.add(s.id);
  });
  p.steps.forEach((s, i) => out.push(...validateStep(s, i)));
  if (p.moderation.style !== 'unmoderated' && p.moderation.silencePromptSeconds > 0 && p.moderation.silencePromptSeconds < 5)
    out.push({ level: 'warning', section: 'moderation', message: 'Silence nudges under 5 s interrupt natural thinking. 5–15 s is recommended.' });
  return out;
}

export function issueCounts(issues: LocalIssue[]) {
  return {
    error: issues.filter((i) => i.level === 'error').length,
    warning: issues.filter((i) => i.level === 'warning').length,
    info: issues.filter((i) => i.level === 'info').length,
  };
}
