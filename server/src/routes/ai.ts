// AI helpers for the protocol builder: generate, refine and review protocols.
// Uses the OpenAI Responses API with JSON-schema structured output; every
// result is re-validated with normalizeProtocol so it always matches Protocol.
import { Router } from 'express';
import OpenAI, { APIError } from 'openai';
import { z } from 'zod';
import { DEFAULT_INTRO, emptyProtocol, type InstrumentId, type ModerationStyle, type Protocol, type Step, type TaskStep } from '@thinkaloud/shared';
import { requireUser } from '../lib/auth.ts';
import { config } from '../lib/config.ts';
import { HttpError, parse } from '../lib/http.ts';
import { normalizeProtocol } from '../lib/protocolSchema.ts';

export const aiRouter = Router();
aiRouter.use(requireUser);

// ── OpenAI plumbing ──────────────────────────────────────────────────────────

let client: OpenAI | null = null;
function openai(): OpenAI {
  if (!config.openaiKey) throw new HttpError(503, 'AI features are not configured on this server (missing OPENAI_API_KEY)');
  client ??= new OpenAI({ apiKey: config.openaiKey, timeout: 180_000, maxRetries: 1 });
  return client;
}

const supportsReasoning = (model: string) => /^(gpt-5|o\d)/i.test(model);

/**
 * Call the model with a JSON schema and validate the result. Retries once,
 * feeding the validation error back, when the output does not validate.
 */
export async function structured<T>(opts: {
  name: string;
  schema: Record<string, unknown>;
  instructions: string;
  input: string;
  validate: (raw: unknown) => T;
}): Promise<T> {
  const ai = openai();
  let input = opts.input;
  let lastErr = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    let text: string;
    try {
      const resp = await ai.responses.create({
        model: config.textModel,
        instructions: opts.instructions,
        input,
        max_output_tokens: 32_000,
        ...(supportsReasoning(config.textModel) ? { reasoning: { effort: 'low' as const } } : {}),
        text: { format: { type: 'json_schema', name: opts.name, schema: opts.schema, strict: false } },
      });
      text = resp.output_text;
      if (!text) throw new Error(resp.incomplete_details?.reason ? `incomplete: ${resp.incomplete_details.reason}` : 'empty response');
    } catch (e) {
      if (e instanceof APIError) {
        console.error(`[ai:${opts.name}] OpenAI error`, e.status, e.message);
        if (e.status === 401 || e.status === 403) throw new HttpError(503, 'The AI provider rejected the server API key');
        throw new HttpError(e.status === 429 ? 503 : 502, `AI request failed: ${e.message}`);
      }
      lastErr = e instanceof Error ? e.message : String(e);
      continue;
    }
    try {
      return opts.validate(JSON.parse(text));
    } catch (e) {
      lastErr = e instanceof z.ZodError ? JSON.stringify(e.issues.slice(0, 10)) : e instanceof Error ? e.message : String(e);
      input = `${opts.input}\n\nYour previous output was invalid (${lastErr.slice(0, 1500)}). Return corrected JSON that follows the schema exactly.`;
    }
  }
  throw new HttpError(502, 'The AI returned an invalid result, please try again', { reason: lastErr.slice(0, 500) });
}

// ── JSON schemas for model output ────────────────────────────────────────────

export const str = (description?: string) => ({ type: 'string', ...(description ? { description } : {}) });
export const strArr = (description?: string) => ({ type: 'array', items: { type: 'string' }, ...(description ? { description } : {}) });
export const obj = (properties: Record<string, unknown>, required: string[], description?: string) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
  ...(description ? { description } : {}),
});

const questionJson = obj(
  {
    id: str('Short snake_case id, unique in the protocol.'),
    prompt: str('Participant-facing wording, read verbatim. Neutral, one question only.'),
    kind: { type: 'string', enum: ['open', 'single_choice', 'multi_choice', 'rating', 'yes_no', 'number'] },
    options: strArr('Only for single_choice / multi_choice.'),
    scale: obj(
      { min: { type: 'number' }, max: { type: 'number' }, minLabel: str(), maxLabel: str() },
      ['min', 'max'],
      'Only for rating questions. Use balanced, labelled endpoints.',
    ),
    required: { type: 'boolean' },
    allowFollowUp: { type: 'boolean', description: 'Allow ONE open follow-up after the answer.' },
    intent: str('Hidden note for the moderator: what the researcher wants to learn.'),
  },
  ['id', 'prompt', 'kind', 'required'],
);

const successRuleJson = {
  anyOf: [
    obj({ type: { type: 'string', enum: ['url_matches'] }, pattern: str('JavaScript regex tested against pathname+search+hash, e.g. "^/checkout/confirm"') }, ['type', 'pattern']),
    obj({ type: { type: 'string', enum: ['element_visible'] }, selector: str('CSS selector') }, ['type', 'selector']),
    obj({ type: { type: 'string', enum: ['text_visible'] }, text: str() }, ['type', 'text']),
    obj({ type: { type: 'string', enum: ['click_matches'] }, selector: str(), text: str() }, ['type']),
    obj({ type: { type: 'string', enum: ['custom_event'] }, name: str() }, ['type', 'name']),
  ],
};

const stepJson = {
  anyOf: [
    obj(
      {
        id: str(),
        type: { type: 'string', enum: ['instruction'] },
        title: str(),
        script: str('What the moderator says, close to verbatim.'),
        showApp: { type: 'boolean' },
        exploreSeconds: { type: 'number' },
      },
      ['id', 'type', 'title', 'script'],
    ),
    obj({ id: str(), type: { type: 'string', enum: ['question'] }, title: str(), question: questionJson }, ['id', 'type', 'title', 'question']),
    obj(
      {
        id: str(),
        type: { type: 'string', enum: ['task'] },
        title: str('Researcher-facing short title.'),
        instruction: str('Participant-facing realistic scenario + goal. Never names UI labels, menus, buttons or the path.'),
        startPath: str('App path to load when the task starts, e.g. "/".'),
        successCriteria: str('HIDDEN. Concrete, observable end state that counts as success.'),
        successRules: { type: 'array', items: successRuleJson, description: 'Deterministic detection, only when confidently inferable.' },
        optimalPathLength: { type: 'number', description: 'Minimum number of distinct screens on the ideal path.' },
        timeLimitSec: { type: 'number' },
        probes: strArr('Open, neutral retrospective probes asked AFTER the task.'),
        postTaskQuestions: { type: 'array', items: questionJson },
        askSEQ: { type: 'boolean', description: 'Ask the standard Single Ease Question after the task.' },
      },
      ['id', 'type', 'title', 'instruction', 'successCriteria', 'successRules', 'probes', 'askSEQ', 'timeLimitSec'],
    ),
    obj(
      {
        id: str(),
        type: { type: 'string', enum: ['questionnaire'] },
        title: str(),
        instrument: { type: 'string', enum: ['SUS', 'UMUX_LITE', 'SEQ', 'NASA_TLX', 'NPS', 'custom'] },
        questions: { type: 'array', items: questionJson, description: 'Only for instrument "custom".' },
        productName: str(),
        onScreen: { type: 'boolean' },
      },
      ['id', 'type', 'title', 'instrument'],
    ),
    obj(
      {
        id: str(),
        type: { type: 'string', enum: ['interview'] },
        title: str(),
        goal: str('Hidden goal of this block.'),
        questions: strArr('Open questions asked in order, verbatim.'),
        maxFollowUps: { type: 'number' },
      },
      ['id', 'type', 'title', 'goal', 'questions'],
    ),
  ],
};

const moderationJson = obj(
  {
    style: { type: 'string', enum: ['think_aloud_concurrent', 'think_aloud_retrospective', 'interview', 'unmoderated'] },
    probingLevel: { type: 'string', enum: ['none', 'light', 'moderate', 'deep'] },
    allowClosedQuestions: { type: 'boolean' },
    silencePromptSeconds: { type: 'number' },
    maxProbesPerStep: { type: 'number' },
    probeOnBehavior: { type: 'boolean' },
    language: str('BCP-47, e.g. "en", "de"'),
    voice: { type: 'string', enum: ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'] },
    tone: str(),
    customRules: strArr(),
    allowTextFallback: { type: 'boolean' },
  },
  [],
);

const consentJson = obj(
  { text: str('Markdown'), storeAudio: { type: 'boolean' }, recordScreen: { type: 'boolean' }, offerEyeTracking: { type: 'boolean' }, ageGate: { type: 'boolean' }, version: str() },
  [],
);

const protocolJson = (withSettings: boolean) =>
  obj(
    {
      title: str(),
      researchGoals: strArr('2-5 hidden research goals.'),
      productContext: str('Hidden context for the moderator. Never used to help the participant.'),
      intro: str('Spoken greeting.'),
      closing: str('Spoken at the end.'),
      steps: { type: 'array', items: stepJson },
      randomizeTasks: { type: 'boolean' },
      estimatedMinutes: { type: 'number' },
      ...(withSettings ? { moderation: moderationJson, consent: consentJson } : {}),
    },
    ['title', 'researchGoals', 'productContext', 'intro', 'closing', 'steps', 'randomizeTasks', 'estimatedMinutes'],
  );

// ── methodology prompt ───────────────────────────────────────────────────────

const METHODOLOGY = `
You are a senior UX researcher (HCI PhD, 15 years of moderated usability testing) writing protocols that an AI voice moderator runs with real participants. Apply this methodology strictly:

TASK SCENARIOS
- Each task is a short, realistic scenario with a motivation and a concrete goal ("Imagine you're planning a weekend trip with a friend and want to ... Find ..."). One goal per task, 1-3 sentences, plain spoken language (it is read aloud).
- NEVER reveal the solution path or UI vocabulary: do not name buttons, menus, tabs, links, icons, page names or on-screen labels, and do not say "click", "tap", "go to", "use the X menu", "navigate". Use the user's own words for their goal, not the product's labels (say "save it for later", not "click Add to Wishlist").
- No hints, no confirmation of correctness, no evaluative words ("easy", "simple", "quick") in task wording.
- Tasks must be achievable and have a clear end state. Order tasks from simpler to more complex unless randomized.
- successCriteria is HIDDEN: describe the concrete, observable end state (what screen/state proves success, what counts as partial).
- successRules: add deterministic rules only when confidently inferable (e.g. url_matches "^/checkout/(success|confirmation)" for a completed order, custom_event if the researcher mentions one). If unsure, return an empty array — a wrong rule is worse than none. Rule text/patterns must never appear in the task wording.
- startPath: "/" unless the scenario needs a different starting page. timeLimitSec: a hard cap (usually 180-420 s).
- probes: 1-3 open, neutral, retrospective probes asked AFTER the task (never during): "What did you expect to happen when ...?", "How did you decide where to look first?", "Tell me more about ...". Never leading ("Was that easy?", "Did you like ...?"), never double-barreled, one question each.
- askSEQ: true for every task (post-task Single Ease Question; the platform adds the standard wording, do not duplicate it in postTaskQuestions).

INTRO (spoken, warm, ~60-90 words)
- Greet and thank, clearly disclose the moderator is an AI in plain words (e.g. "I'm an AI moderator") — never mention laws or regulations to the participant, say "we're testing the product, not you — there are no wrong answers", ask the participant to think aloud (say what they look at, try, expect), say the moderator can't help with tasks and they may skip a task, ask if they are ready.

STRUCTURE (in this order)
1. Warm-up open question about current habits/context (question step, kind "open", allowFollowUp true).
2. A short think-aloud practice: an instruction step with showApp true that asks for first impressions while looking around (exploreSeconds 30-60) — this doubles as think-aloud practice.
3. The tasks (task steps).
4. Standardized questionnaires only as requested (SUS = instrument "SUS", UMUX-Lite = "UMUX_LITE"); onScreen true. Never write your own version of SUS/UMUX/SEQ/NPS items.
5. Wrap-up interview step: 2-4 open questions (overall experience, most frustrating moment, what they would change), maxFollowUps 1-2.
- Interview/open questions: open first (what/how/tell me about), neutral, one idea per question, no double-barreled questions, no leading or loaded wording, no assumptions about the participant's feelings.
- Research goals (hidden): 2-5 specific, answerable goals tied to the tasks.
- Keep total duration realistic: ~3-6 minutes per task plus ~5 minutes for intro, warm-up, questionnaires and wrap-up.
- Use short snake_case ids (warmup, first_impression, task_find_product, sus, wrapup).
`.trim();

// ── methodology lint (deterministic) ─────────────────────────────────────────

export interface ReviewIssue {
  stepId?: string;
  severity: 'high' | 'medium' | 'low';
  message: string;
  suggestion: string;
}

const LEADING = /^(was|is|were|are|did|do|does|would|wouldn'?t|don'?t|didn'?t|isn'?t|wasn'?t|aren'?t|can|could)\b.*\b(easy|easier|simple|helpful|clear|intuitive|like|love|enjoy|useful|great|good|nice|confusing|frustrating|hard|difficult|annoying|better|worse)\b/i;
const UI_VERBS = /\b(click|clicking|tap|tapping|press|hover|scroll down to|navigate to)\b/i;
const UI_NOUNS = /\b(button|menu|tab|link|icon|dropdown|drop-down|navbar|nav bar|sidebar|hamburger|toolbar|checkbox)\b/i;

function checkQuestionWording(text: string, stepId: string, where: string, out: ReviewIssue[]) {
  const t = text.trim();
  if (!t) return;
  if (LEADING.test(t))
    out.push({
      stepId,
      severity: 'medium',
      message: `${where} may be leading or closed: "${t.slice(0, 120)}"`,
      suggestion: 'Ask an open, neutral question, e.g. "How was that for you?" or "Tell me about how that went."',
    });
  if ((t.match(/\?/g) ?? []).length > 1)
    out.push({ stepId, severity: 'low', message: `${where} asks several questions at once.`, suggestion: 'Split it so each prompt asks exactly one thing.' });
}

/** Rule-based methodology checks that do not need the model. */
export function lintProtocol(p: Protocol): ReviewIssue[] {
  const out: ReviewIssue[] = [];
  const tasks = p.steps.filter((s): s is TaskStep => s.type === 'task');
  const thinkAloud = p.moderation.style === 'think_aloud_concurrent' || p.moderation.style === 'think_aloud_retrospective';

  if (!p.steps.length) out.push({ severity: 'high', message: 'The protocol has no steps.', suggestion: 'Add a warm-up question, tasks and a wrap-up interview.' });
  else if (!tasks.length && p.moderation.style !== 'interview')
    out.push({ severity: 'medium', message: 'There are no tasks.', suggestion: 'Add task steps for the flows you want to evaluate, or switch the moderation style to interview.' });

  if (!/\b(AI|A\.I\.|artificial intelligence|automated|virtual (moderator|assistant))\b/i.test(p.intro))
    out.push({
      severity: 'high',
      message: 'The intro does not disclose that the moderator is an AI.',
      suggestion: 'Say plainly, e.g. "I\'m an AI moderator" (required for transparency, EU AI Act Art. 50).',
    });
  if (!/not (testing )?you|no (right or )?wrong answers/i.test(p.intro))
    out.push({ severity: 'medium', message: 'The intro does not reassure the participant that the product is being tested, not them.', suggestion: 'Add "We\'re testing the product, not you, so there are no wrong answers."' });
  if (thinkAloud && !/think(ing)? (out )?loud|thinking aloud|out loud|what you('re| are) thinking/i.test(p.intro))
    out.push({ severity: 'medium', message: 'The intro does not ask the participant to think aloud.', suggestion: 'Ask them to say what they are looking at, trying to do and expecting as they go.' });
  if (thinkAloud && tasks.length && !p.steps.slice(0, p.steps.indexOf(tasks[0])).some((s) => s.type === 'instruction' && s.showApp))
    out.push({ severity: 'low', message: 'No think-aloud practice before the first task.', suggestion: 'Add a short "look around and tell me your first impressions" instruction step with the app shown.' });
  if (!p.closing.trim()) out.push({ severity: 'low', message: 'The closing message is empty.', suggestion: 'Thank the participant and tell them what happens next.' });
  if (tasks.length > 8) out.push({ severity: 'low', message: `${tasks.length} tasks is a lot for one session (fatigue).`, suggestion: 'Keep to about 3-6 tasks, or split into two studies/variants.' });

  for (const s of p.steps) {
    if (s.type === 'task') {
      const instr = s.instruction.trim();
      if (!instr) out.push({ stepId: s.id, severity: 'high', message: `Task "${s.title}" has no participant instruction.`, suggestion: 'Write a short realistic scenario with a clear goal.' });
      if (!s.successCriteria.trim() || /^describe what success looks like/i.test(s.successCriteria.trim()))
        out.push({ stepId: s.id, severity: 'high', message: `Task "${s.title}" has no hidden success criteria.`, suggestion: 'Describe the concrete end state that counts as success (and what counts as partial).' });
      if (/…|\.\.\./.test(instr)) out.push({ stepId: s.id, severity: 'high', message: `Task "${s.title}" still contains placeholder text.`, suggestion: 'Replace the "…" with the actual scenario.' });
      if (UI_VERBS.test(instr) || UI_NOUNS.test(instr))
        out.push({
          stepId: s.id,
          severity: UI_VERBS.test(instr) ? 'high' : 'medium',
          message: `Task "${s.title}" refers to UI elements or actions, which can reveal the path.`,
          suggestion: 'Describe the goal in the participant\'s own terms without naming buttons, menus, links or clicks.',
        });
      const quoted = instr.match(/["“'‘]([^"”'’]{3,40})["”'’]/g);
      if (quoted?.length)
        out.push({ stepId: s.id, severity: 'medium', message: `Task "${s.title}" quotes ${quoted.join(', ')} — quoted words often mirror on-screen labels.`, suggestion: 'Paraphrase in everyday language instead of quoting interface wording.' });
      for (const r of s.successRules ?? []) {
        const label = r.type === 'text_visible' ? r.text : r.type === 'click_matches' ? r.text : undefined;
        if (label && label.trim().length >= 4 && instr.toLowerCase().includes(label.trim().toLowerCase()))
          out.push({ stepId: s.id, severity: 'high', message: `Task "${s.title}" contains "${label}", the very label its success rule looks for.`, suggestion: 'Reword the task so it does not give away the target.' });
      }
      if (/\b(easy|easily|simple|simply|quick(ly)?|just)\b/i.test(instr))
        out.push({ stepId: s.id, severity: 'medium', message: `Task "${s.title}" uses evaluative wording (e.g. "easy", "just", "quickly").`, suggestion: 'Remove words that set expectations about difficulty.' });
      if (!s.successRules?.length)
        out.push({ stepId: s.id, severity: 'low', message: `Task "${s.title}" has no automatic success rule.`, suggestion: 'If the end state has a distinctive URL or element, add a url_matches / element_visible rule.' });
      if (!s.timeLimitSec) out.push({ stepId: s.id, severity: 'low', message: `Task "${s.title}" has no time limit.`, suggestion: 'Set a hard cap (e.g. 300 s) so stuck participants can move on.' });
      if (!s.askSEQ && !(s.postTaskQuestions ?? []).some((q) => /difficult or easy/i.test(q.prompt)))
        out.push({ stepId: s.id, severity: 'low', message: `Task "${s.title}" has no post-task ease rating.`, suggestion: 'Enable the Single Ease Question (SEQ) for comparable task-level data.' });
      (s.probes ?? []).forEach((q) => checkQuestionWording(q, s.id, 'A probe', out));
      (s.postTaskQuestions ?? []).forEach((q) => checkQuestionWording(q.prompt, s.id, 'A post-task question', out));
    } else if (s.type === 'question') {
      const q = s.question;
      if (!q.prompt.trim()) out.push({ stepId: s.id, severity: 'high', message: `Question step "${s.title}" has no prompt.`, suggestion: 'Write the question.' });
      if ((q.kind === 'single_choice' || q.kind === 'multi_choice') && (q.options?.length ?? 0) < 2)
        out.push({ stepId: s.id, severity: 'high', message: `Choice question "${s.title}" has fewer than two options.`, suggestion: 'Add the answer options (include an "Other / none" option when appropriate).' });
      if (q.kind === 'open' || q.kind === 'yes_no') checkQuestionWording(q.prompt, s.id, 'The question', out);
    } else if (s.type === 'interview') {
      if (!s.questions.length) out.push({ stepId: s.id, severity: 'medium', message: `Interview block "${s.title}" has no questions.`, suggestion: 'Add 2-4 open questions.' });
      s.questions.forEach((q) => checkQuestionWording(q, s.id, 'An interview question', out));
    } else if (s.type === 'questionnaire' && s.instrument === 'custom' && !s.questions?.length) {
      out.push({ stepId: s.id, severity: 'high', message: `Custom questionnaire "${s.title}" has no questions.`, suggestion: 'Add items or pick a standard instrument (SUS, UMUX-Lite).' });
    }
  }
  return out;
}

// ── post-processing for generated protocols ──────────────────────────────────

function hasInstrument(p: Protocol, id: InstrumentId) {
  return p.steps.some((s) => s.type === 'questionnaire' && s.instrument === id);
}

function finalizeGenerated(p: Protocol, req: { productName: string; includeSUS?: boolean; style?: ModerationStyle; durationMinutes?: number }): Protocol {
  const steps: Step[] = p.steps
    .filter((s) => !(req.includeSUS === false && s.type === 'questionnaire' && s.instrument === 'SUS'))
    .map((s) => {
      if (s.type === 'task') return { ...s, askSEQ: s.askSEQ ?? true, timeLimitSec: s.timeLimitSec || 300, startPath: s.startPath || '/' };
      if (s.type === 'questionnaire' && s.instrument !== 'custom') return { ...s, productName: s.productName || req.productName, onScreen: s.onScreen ?? true };
      return s;
    });
  const out: Protocol = { ...p, steps };
  if (req.includeSUS && !hasInstrument(out, 'SUS')) {
    const sus: Step = { id: 'sus', type: 'questionnaire', title: 'System Usability Scale', instrument: 'SUS', productName: req.productName, onScreen: true };
    const lastInterview = out.steps.map((s) => s.type).lastIndexOf('interview');
    out.steps.splice(lastInterview >= 0 ? lastInterview : out.steps.length, 0, sus);
  }
  if (req.style) {
    out.moderation = { ...out.moderation, style: req.style };
    if (req.style === 'unmoderated') out.moderation.probingLevel = 'none';
  }
  if (req.durationMinutes) out.estimatedMinutes = req.durationMinutes;
  // Non-negotiable disclosures: fall back to the vetted default intro.
  if (!/\bAI\b|artificial intelligence/i.test(out.intro) || !/not (testing )?you|no (right or )?wrong answers/i.test(out.intro)) out.intro = DEFAULT_INTRO;
  return normalizeProtocol(out);
}

// ── optional app crawl (structure hints for success rules) ───────────────────

const decode = (s: string) =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
const stripTags = (s: string) => decode(s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Fetch the app's start page and summarize its structure (title, headings, link paths). Best effort. */
async function describeApp(url: string): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(6000), redirect: 'follow', headers: { 'User-Agent': 'ThinkAloud-ProtocolBuilder/1.0' } });
    if (!r.ok || !(r.headers.get('content-type') ?? '').includes('html')) return null;
    const html = (await r.text()).slice(0, 1_000_000);
    const title = stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
    const desc = decode(html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i)?.[1] ?? '');
    const headings = [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map((m) => stripTags(m[1])).filter(Boolean).slice(0, 25);
    const links = new Map<string, string>();
    for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      try {
        const href = new URL(decode(m[1]), u);
        if (href.origin !== u.origin) continue;
        const p = href.pathname + href.search;
        if (!links.has(p)) links.set(p, stripTags(m[2]).slice(0, 60));
      } catch {
        /* ignore malformed hrefs */
      }
      if (links.size >= 80) break;
    }
    const lines = [
      title && `Title: ${title}`,
      desc && `Description: ${desc}`,
      headings.length && `Headings: ${headings.join(' | ')}`,
      links.size && `Internal links (path — label):\n${[...links].map(([p, l]) => `  ${p} — ${l}`).join('\n')}`,
    ].filter(Boolean);
    return lines.length ? lines.join('\n').slice(0, 8000) : null;
  } catch {
    return null;
  }
}

// ── routes ───────────────────────────────────────────────────────────────────

const Generate = z.object({
  goal: z.string().trim().min(3).max(4000),
  productName: z.string().trim().min(1).max(200),
  productContext: z.string().max(8000).optional(),
  audience: z.string().max(2000).optional(),
  durationMinutes: z.number().int().min(5).max(120).optional(),
  taskCount: z.number().int().min(1).max(10).optional(),
  includeSUS: z.boolean().optional(),
  style: z.enum(['think_aloud_concurrent', 'think_aloud_retrospective', 'interview', 'unmoderated']).optional(),
  appUrl: z.string().max(2000).optional(),
});

aiRouter.post('/generate-protocol', async (req, res) => {
  const body = parse(Generate, req.body);
  openai(); // 503 early when unconfigured
  const appInfo = body.appUrl ? await describeApp(body.appUrl) : null;
  const taskCount = body.taskCount ?? (body.style === 'interview' ? 1 : 3);
  const input = [
    `Product name: ${body.productName}`,
    `Research goal (from the researcher): ${body.goal}`,
    body.productContext && `Product context: ${body.productContext}`,
    body.audience && `Target participants: ${body.audience}`,
    `Moderation style: ${body.style ?? 'think_aloud_concurrent'}`,
    `Number of tasks: ${taskCount}`,
    body.durationMinutes && `Target duration: ${body.durationMinutes} minutes (set estimatedMinutes accordingly)`,
    `Include SUS questionnaire: ${body.includeSUS ? 'yes' : 'no'}`,
    body.appUrl && `App URL: ${body.appUrl}`,
    appInfo &&
      `Observed structure of the app's start page. Use it ONLY to infer startPath, successRules (e.g. url_matches on a path) and optimalPathLength. NEVER reuse these labels or paths in participant-facing wording:\n${appInfo}`,
    '',
    'Write the complete protocol now.',
  ]
    .filter((x): x is string => typeof x === 'string')
    .join('\n');

  const protocol = await structured({
    name: 'usability_protocol',
    schema: protocolJson(false),
    instructions: METHODOLOGY,
    input,
    validate: (raw) => {
      const base = emptyProtocol(body.productName);
      const p = normalizeProtocol({ ...base, ...(raw as object), moderation: base.moderation, consent: base.consent });
      if (!p.steps.length) throw new Error('protocol has no steps');
      if (body.style !== 'interview' && !p.steps.some((s) => s.type === 'task')) throw new Error('protocol has no task steps');
      return finalizeGenerated(p, body);
    },
  });
  res.json({ protocol });
});

const Refine = z.object({ protocol: z.unknown(), instruction: z.string().trim().min(2).max(4000) });

aiRouter.post('/refine-protocol', async (req, res) => {
  const body = parse(Refine, req.body);
  const original = normalizeProtocol(body.protocol);
  openai();
  const { consent: _consent, ...forModel } = original;
  const consentRelated = /consent|privacy|gdpr|record|eye ?track|webcam|age/i.test(body.instruction);
  const input = [
    'Current protocol (JSON):',
    JSON.stringify(consentRelated ? original : forModel),
    '',
    `Researcher's change request: ${body.instruction}`,
    '',
    'Return the COMPLETE updated protocol plus a short list of the changes you made (one line each, researcher-facing).',
    'Rules: apply the request and nothing else; keep the ids of steps you keep; keep everything else unchanged and verbatim;',
    'keep all methodology rules (neutral non-leading wording, no UI labels or paths in tasks, hidden success criteria, AI disclosure in the intro).',
    'If the request would violate the methodology (e.g. reveal the path in a task), apply the closest neutral alternative and say so in changes.',
    consentRelated ? '' : 'Omit the "consent" field (it is kept unchanged).',
  ].join('\n');

  const result = await structured({
    name: 'refined_protocol',
    schema: obj({ protocol: protocolJson(true), changes: strArr('What changed, one short line each.') }, ['protocol', 'changes']),
    instructions: METHODOLOGY,
    input,
    validate: (raw) => {
      const r = raw as { protocol?: Partial<Protocol>; changes?: unknown };
      if (!r || typeof r !== 'object' || !r.protocol) throw new Error('missing protocol');
      const merged = {
        ...original,
        ...r.protocol,
        moderation: { ...original.moderation, ...(r.protocol.moderation ?? {}) },
        consent: { ...original.consent, ...(r.protocol.consent ?? {}) },
      };
      const protocol = normalizeProtocol(merged);
      const changes = z.array(z.string()).catch([]).parse(r.changes).map((c) => c.trim()).filter(Boolean).slice(0, 30);
      return { protocol, changes };
    },
  });
  res.json(result);
});

const IssueSchema = z.object({
  stepId: z.string().nullish(),
  severity: z.preprocess((v) => (typeof v === 'string' ? v.toLowerCase() : v), z.enum(['high', 'medium', 'low'])).catch('medium'),
  message: z.string().min(1).max(2000),
  suggestion: z.string().max(2000).default(''),
});

aiRouter.post('/review-protocol', async (req, res) => {
  const { protocol: raw } = parse(z.object({ protocol: z.unknown() }), req.body);
  const protocol = normalizeProtocol(raw);
  const rank = { high: 0, medium: 1, low: 2 } as const;
  const lint = lintProtocol(protocol).sort((a, b) => rank[a.severity] - rank[b.severity]);
  // Without a key the rule-based review is still useful — return it rather than failing.
  if (!config.openaiKey) return void res.json({ issues: lint });

  const stepIds = new Set(protocol.steps.map((s) => s.id));
  const { consent: _c, ...forModel } = protocol;
  const input = [
    'Review this usability-test protocol for methodology problems. Look for: leading or loaded questions, double-barreled questions,',
    'closed questions where open ones are needed, tasks that reveal the answer, path or UI labels, unrealistic or ambiguous scenarios,',
    'tasks with several goals, missing/vague/unobservable success criteria, success rules that do not match the criteria,',
    'probes that would be asked during a task, missing AI disclosure or reassurance in the intro, poor ordering, fatigue/length issues,',
    'and anything that would bias participants. Be specific and actionable; quote the problematic wording; give a concrete rewrite as suggestion.',
    'Use the step id in stepId (omit it for protocol-level issues). Severity: high = biases data or breaks the study; medium = likely hurts data quality; low = polish.',
    'An automatic linter already reported the issues below — do NOT repeat them; report only additional problems (return an empty list if there are none).',
    '',
    `Already reported:\n${lint.map((i) => `- [${i.stepId ?? 'protocol'}] ${i.message}`).join('\n') || '(none)'}`,
    '',
    'Protocol (JSON):',
    JSON.stringify(forModel),
  ].join('\n');

  const aiIssues = await structured({
    name: 'protocol_review',
    schema: obj(
      {
        issues: {
          type: 'array',
          items: obj(
            { stepId: str(), severity: { type: 'string', enum: ['high', 'medium', 'low'] }, message: str(), suggestion: str() },
            ['severity', 'message', 'suggestion'],
          ),
        },
      },
      ['issues'],
    ),
    instructions: METHODOLOGY,
    input,
    validate: (r) =>
      z
        .object({ issues: z.array(z.unknown()) })
        .parse(r)
        .issues.flatMap((i) => {
          const p = IssueSchema.safeParse(i);
          if (!p.success) return [];
          const issue: ReviewIssue = { severity: p.data.severity, message: p.data.message, suggestion: p.data.suggestion };
          if (p.data.stepId && stepIds.has(p.data.stepId)) issue.stepId = p.data.stepId;
          return [issue];
        }),
  });
  const issues = [...lint, ...aiIssues].sort((a, b) => rank[a.severity] - rank[b.severity]);
  res.json({ issues });
});
