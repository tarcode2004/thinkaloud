// AI synthesis: evidence-cited insights from transcripts + behaviour, with deterministic
// anti-hallucination checks. Every quote must fuzzy-match the cited session's transcript near the
// cited time; unverifiable evidence is dropped and insights without evidence are discarded.
import OpenAI, { APIError } from 'openai';
import type { Answer, SessionEvent, Step, TaskResult } from '@thinkaloud/shared';
import { newId, stepQuestions } from '@thinkaloud/shared';
import { verifyInsights, type ProposedInsight, type SessionCorpus, type SynthesisX, type TranscriptLine } from './verify.ts';
import { db, json } from '../db.ts';
import { config } from '../lib/config.ts';
import { HttpError } from '../lib/http.ts';
import type { Row } from '../lib/repo.ts';
import { loadAnswers, loadSessionEvents, loadSessions, loadTaskResults, loadVariants, type LoadedSession } from './data.ts';
import { computeAnalytics, scoreSession, sessionDurationMs } from './metrics.ts';

export * from './verify.ts';

// ── Corpus building ─────────────────────────────────────────────────────────

export function transcriptOf(events: SessionEvent[]): TranscriptLine[] {
  return events
    .filter((e) => e.kind === 'transcript.participant' || e.kind === 'transcript.moderator')
    .map((e) => ({
      t: Number((e.data as { startT?: number }).startT ?? e.t),
      speaker: e.kind === 'transcript.participant' ? ('participant' as const) : ('moderator' as const),
      text: String((e.data as { text?: string }).text ?? '').trim(),
    }))
    .filter((l) => l.text)
    .sort((a, b) => a.t - b.t);
}

const NOTABLE = new Set(['task.assist', 'app.rage_click', 'app.dead_click', 'app.error', 'app.network_error', 'app.crash', 'moderator.probe', 'moderator.nudge', 'task.start', 'task.end', 'app.navigate']);

const ts = (ms: number) => (ms / 1000).toFixed(1);

function describeEvent(e: SessionEvent): string {
  const d = e.data as Record<string, unknown>;
  const el = d.el as { text?: string; selector?: string } | undefined;
  switch (e.kind) {
    case 'app.rage_click':
      return `rage click (${d.count ?? '?'}×) on "${el?.text || el?.selector || '?'}"`;
    case 'app.dead_click':
      return `click with no effect on "${el?.text || el?.selector || '?'}"`;
    case 'app.error':
    case 'app.network_error':
    case 'app.crash':
      return `${e.kind}: ${String(d.message ?? d.url ?? '').slice(0, 120)}`;
    case 'app.navigate':
      return `navigated to ${d.path}`;
    case 'task.start':
      return `task started`;
    case 'task.end':
      return `task ended: ${d.outcome}`;
    case 'moderator.probe':
    case 'moderator.nudge':
      return `${e.kind.replace('moderator.', 'moderator ')}${d.text ? `: "${String(d.text).slice(0, 100)}"` : ''}`;
    default:
      return e.kind;
  }
}

interface Built {
  prompt: string;
  corpus: SessionCorpus[];
  stepIds: Set<string>;
  variantIds: Set<string>;
  sessionCount: number;
}

function buildInput(studyId: string): Built {
  const study = db.prepare('SELECT * FROM studies WHERE id = ?').get(studyId) as Row;
  const variants = loadVariants(studyId);
  const sessions = loadSessions(studyId).filter((s) => s.effectiveStatus === 'completed' || s.effectiveStatus === 'abandoned');
  const results = loadTaskResults(studyId);
  const answers = loadAnswers(studyId);
  const vName = new Map(variants.map((v) => [v.id, v.name]));
  const stepIds = new Set<string>();
  const corpus: SessionCorpus[] = [];
  const blocks: string[] = [];
  let protocolBlock = '';
  const BUDGET = 260_000;
  const per = Math.max(4000, Math.floor(BUDGET / Math.max(1, sessions.length)));
  for (const s of sessions) {
    const evs = loadSessionEvents(s.session.id, { excludePoints: true });
    const lines = transcriptOf(evs);
    corpus.push({
      sessionId: s.session.id,
      participantCode: s.session.participantCode,
      variantId: s.session.variantId,
      lines,
      events: evs.filter((e) => e.kind.startsWith('app.') || e.kind.startsWith('moderator.') || e.kind.startsWith('task.')).map((e) => ({ t: e.t, kind: e.kind })),
    });
    for (const st of s.steps) stepIds.add(st.id);
    if (!protocolBlock && s.protocol) protocolBlock = protocolSummary(s.protocol.researchGoals, s.protocol.productContext, s.steps);
    blocks.push(sessionBlock(s, vName.get(s.session.variantId) ?? '?', lines, evs, results.get(s.session.id) ?? [], answers.get(s.session.id) ?? [], per));
  }
  const prompt = [
    `# Study: ${study?.name ?? ''}`,
    quantBlock(studyId),
    String(study?.description ?? ''),
    protocolBlock,
    `## Variants\n${variants.map((v) => `- ${v.name} (variantId: ${v.id})`).join('\n')}`,
    `## Sessions (${sessions.length})`,
    ...blocks,
  ].join('\n\n');
  return { prompt, corpus, stepIds, variantIds: new Set(variants.map((v) => v.id)), sessionCount: sessions.length };
}

/** Authoritative numbers computed by the analytics engine — the model must not count on its own. */
function quantBlock(studyId: string) {
  const a = computeAnalytics(studyId, { level: 0.9 });
  const lines: string[] = ['## Quantitative results (authoritative — quote these numbers, never compute your own)'];
  for (const v of a.variants) {
    lines.push(`### ${v.name}: ${v.sessions} sessions, ${v.completed} completed${v.sus ? `, SUS mean ${v.sus.estimate.toFixed(1)} (n=${v.susScores.length})` : ''}${v.nps ? `, NPS ${v.nps.score}` : ''}`);
    for (const t of v.tasks)
      lines.push(
        `- ${t.title} (stepId=${t.stepId}): ${t.successes}/${t.n} succeeded${t.timeOnTaskMs ? `, geometric mean time ${Math.round(t.timeOnTaskMs.estimate / 1000)}s` : ''}${t.seq ? `, SEQ mean ${t.seq.estimate.toFixed(1)}` : ''}, rage clicks ${t.rageClicks}, errors ${t.errors}`,
      );
  }
  const tested = a.comparisons.filter((c) => c.pValue != null);
  if (tested.length) {
    lines.push('### A/B tests (90% confidence)');
    for (const c of tested) lines.push(`- ${c.label}: ${c.significant ? 'significant' : 'not significant'} (p=${c.pValue?.toFixed(3)})`);
  }
  return lines.join('\n');
}

function protocolSummary(goals: string[], context: string, steps: Step[]) {
  const st = steps
    .map((s) => {
      if (s.type === 'task') return `- [task] stepId=${s.id} "${s.title}": ${s.instruction} (success: ${s.successCriteria})`;
      if (s.type === 'questionnaire') return `- [questionnaire] stepId=${s.id} ${s.instrument}`;
      if (s.type === 'question') return `- [question] stepId=${s.id} "${s.question.prompt}"`;
      if (s.type === 'interview') return `- [interview] stepId=${s.id} ${s.questions.join(' / ')}`;
      return `- [instruction] stepId=${s.id} ${s.title}`;
    })
    .join('\n');
  return `## Research goals\n${goals.map((g) => `- ${g}`).join('\n')}\n\n## Product context\n${context}\n\n## Protocol steps\n${st}`;
}

function sessionBlock(
  s: LoadedSession,
  variantName: string,
  lines: TranscriptLine[],
  evs: SessionEvent[],
  results: TaskResult[],
  answers: Answer[],
  budget: number,
) {
  const titles = new Map(s.steps.map((st) => [st.id, st.title]));
  const prompts = new Map<string, string>();
  for (const st of s.steps) {
    for (const q of stepQuestions(st)) prompts.set(`${st.id}:${q.id}`, q.prompt); // incl. interview questions
  }
  const sc = scoreSession(answers);
  const dur = sessionDurationMs(s);
  const head = `### Session ${s.session.participantCode} (session: ${s.session.id}, variant: ${variantName}, status: ${s.effectiveStatus}${dur ? `, ${Math.round(dur / 1000)}s` : ''})`;
  const tasks = results.map((r) => {
    const seq = answers.find((a) => a.stepId === r.stepId && a.questionId === 'seq')?.value;
    return `- ${titles.get(r.stepId) ?? r.stepId} (stepId=${r.stepId}): ${r.outcome} in ${Math.round(r.durationMs / 1000)}s${seq != null ? `, SEQ ${seq}/7` : ''}${r.evidence ? ` — ${r.evidence}` : ''}`;
  });
  const scores = Object.entries(sc).map(([k, v]) => `${k} ${Math.round(v * 10) / 10}`);
  const open = answers
    .filter((a) => a.text && a.text.trim())
    .map((a) => `- ${prompts.get(`${a.stepId}:${a.questionId}`) ?? a.questionId}: "${a.text!.trim().slice(0, 400)}"${a.value != null ? ` (rating ${a.value})` : ''}`);
  const notable = evs
    .filter((e) => NOTABLE.has(e.kind))
    .slice(0, 80)
    .map((e) => `[${ts(e.t)}] ${e.stepId ? `(${e.stepId}) ` : ''}${describeEvent(e)}`);
  let transcript = lines.map((l) => `[${ts(l.t)}] ${l.speaker === 'participant' ? 'P' : 'M'}: ${l.text}`).join('\n');
  if (transcript.length > budget) transcript = transcript.slice(0, budget) + '\n[…transcript truncated]';
  return [
    head,
    tasks.length ? `Tasks:\n${tasks.join('\n')}` : '',
    scores.length ? `Questionnaire scores: ${scores.join(', ')}` : '',
    open.length ? `Answers:\n${open.join('\n')}` : '',
    notable.length ? `Notable behaviour (t in seconds):\n${notable.join('\n')}` : '',
    `Transcript (t in seconds, P = participant, M = AI moderator):\n${transcript || '(no transcript)'}`,
  ]
    .filter(Boolean)
    .join('\n');
}

// ── Model call ──────────────────────────────────────────────────────────────

const INSTRUCTIONS = `You are a senior UX researcher synthesizing a moderated think-aloud usability study.
Produce an executive summary and a set of insights grounded ONLY in the provided sessions.

Rules (strict):
- Every insight MUST cite evidence from specific sessions. Use the session id (e.g. "s_abc") or the participant code (e.g. "P-7K2Q") exactly as given.
- Quotes must be copied VERBATIM from participant (P) lines of the transcript — never paraphrase, never merge words from different lines, never invent. Prefer short, telling quotes (5–25 words).
- tSec is the timestamp in seconds shown in brackets on the line you quote (or on the behaviour event you cite).
- Behaviour evidence without a quote: set quote to null and eventKind to the exact event kind (e.g. "app.rage_click", "app.dead_click", "app.error").
- Count how many participants experienced an issue; mention prevalence (e.g. "5 of 12 participants") in the body; do not overgeneralize from one session.
- Severity: critical = blocks task completion for several participants; major = causes significant delay/frustration or failure for some; minor = cosmetic/small friction; positive = something that worked well; info = neutral observation.
- Compare variants where relevant (set variantId when an insight is specific to one variant). Set stepId when an insight is about one task.
- The AI moderator's own words are never evidence of a usability problem.
- Numbers (success counts, times, SUS, significance) must come from the "Quantitative results" section — never count or compute them yourself. Only call a difference significant if that section says so. Be concise, concrete and neutral.
- Summary: markdown without a top-level heading, 120–250 words, with the 3–5 most important findings and a short "Recommended next steps" list.
- Return 4–12 insights, ordered by importance.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'insights'],
  properties: {
    summary: { type: 'string' },
    insights: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'body', 'severity', 'tags', 'stepId', 'variantId', 'recommendation', 'evidence'],
        properties: {
          title: { type: 'string' },
          body: { type: 'string', description: 'Markdown, 1–4 sentences, include prevalence.' },
          severity: { type: 'string', enum: ['critical', 'major', 'minor', 'positive', 'info'] },
          tags: { type: 'array', items: { type: 'string' } },
          stepId: { type: ['string', 'null'] },
          variantId: { type: ['string', 'null'] },
          recommendation: { type: ['string', 'null'] },
          evidence: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['session', 'tSec', 'quote', 'eventKind'],
              properties: {
                session: { type: 'string' },
                tSec: { type: 'number' },
                quote: { type: ['string', 'null'] },
                eventKind: { type: ['string', 'null'] },
              },
            },
          },
        },
      },
    },
  },
} as const;

let client: OpenAI | null = null;
const supportsReasoning = (model: string) => /^(gpt-5|o\d)/i.test(model);

export async function runSynthesis(studyId: string): Promise<SynthesisX> {
  if (!config.openaiKey) throw new HttpError(503, 'AI synthesis is not configured on this server (missing OPENAI_API_KEY)');
  const built = buildInput(studyId);
  if (!built.sessionCount) throw new HttpError(400, 'No completed sessions to synthesize yet');
  client ??= new OpenAI({ apiKey: config.openaiKey, timeout: 300_000, maxRetries: 1 });
  let parsed: { summary: string; insights: ProposedInsight[] } | null = null;
  let lastErr = '';
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    try {
      const resp = await client.responses.create({
        model: config.textModel,
        instructions: INSTRUCTIONS,
        input: built.prompt,
        max_output_tokens: 32_000,
        ...(supportsReasoning(config.textModel) ? { reasoning: { effort: 'medium' as const } } : {}),
        text: { format: { type: 'json_schema', name: 'study_synthesis', schema: SCHEMA as unknown as Record<string, unknown>, strict: true } },
      });
      const text = resp.output_text;
      if (!text) throw new Error(resp.incomplete_details?.reason ? `incomplete: ${resp.incomplete_details.reason}` : 'empty response');
      const obj = JSON.parse(text) as { summary?: unknown; insights?: unknown };
      if (typeof obj.summary !== 'string' || !Array.isArray(obj.insights)) throw new Error('malformed output');
      parsed = obj as { summary: string; insights: ProposedInsight[] };
    } catch (e) {
      if (e instanceof APIError) throw new HttpError(e.status === 429 ? 503 : 502, `AI request failed: ${e.message}`);
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  if (!parsed) throw new HttpError(502, `AI synthesis failed: ${lastErr}`);
  const { insights, verification } = verifyInsights(parsed.insights, built.corpus, { stepIds: built.stepIds, variantIds: built.variantIds });
  return saveSynthesis(studyId, { model: config.textModel, summary: parsed.summary, insights, verification, sessionCount: built.sessionCount, generatedBy: 'ai' });
}

export function saveSynthesis(
  studyId: string,
  s: Pick<SynthesisX, 'model' | 'summary' | 'insights' | 'verification' | 'sessionCount' | 'generatedBy'>,
): SynthesisX {
  const syn: SynthesisX = { id: newId('syn'), studyId, createdAt: Date.now(), ...s };
  db.prepare('INSERT INTO syntheses (id, study_id, created_at, model, data) VALUES (?, ?, ?, ?, ?)').run(
    syn.id,
    studyId,
    syn.createdAt,
    syn.model,
    json.str({ summary: syn.summary, insights: syn.insights, sessionCount: syn.sessionCount, verification: syn.verification, generatedBy: syn.generatedBy }),
  );
  return syn;
}

export function latestSynthesis(studyId: string): SynthesisX | null {
  const r = db.prepare('SELECT * FROM syntheses WHERE study_id = ? ORDER BY created_at DESC LIMIT 1').get(studyId) as Row | undefined;
  if (!r) return null;
  const d = json.parse<Partial<SynthesisX>>(r.data, {});
  return {
    id: String(r.id),
    studyId,
    createdAt: Number(r.created_at),
    model: String(r.model),
    summary: d.summary ?? '',
    insights: d.insights ?? [],
    sessionCount: d.sessionCount ?? 0,
    verification: d.verification ?? { insightsProposed: 0, insightsKept: 0, evidenceProposed: 0, evidenceVerified: 0, evidenceDropped: 0, timestampsCorrected: 0 },
    ...(d.generatedBy ? { generatedBy: d.generatedBy } : {}),
  };
}

/** Exposed for the demo seed: verify + store a hand-written synthesis through the same checks. */
export function corpusForStudy(studyId: string) {
  return buildInput(studyId);
}
