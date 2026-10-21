// Pure anti-hallucination checks for AI synthesis (no DB access; unit tested in verify.test.ts).
import type { EventKind, Insight, Synthesis } from '@thinkaloud/shared';
import { newId } from '@thinkaloud/shared';

// ── Types ───────────────────────────────────────────────────────────────────

export interface EvidenceX {
  sessionId: string;
  participantCode: string;
  t: number;
  quote?: string;
  eventKind?: EventKind;
  /** 'quote' = quote matched the transcript; 'event' = behaviour event found near t. */
  verifiedBy?: 'quote' | 'event';
  /** Token-level match score of the quote against the transcript (0..1). */
  matchScore?: number;
  /** True when the cited time was off and was moved to the matching utterance. */
  timeCorrected?: boolean;
  speaker?: 'participant' | 'moderator';
}

export interface InsightX extends Insight {
  evidence: EvidenceX[];
  /** Evidence items the model cited that could not be verified (dropped). */
  droppedEvidence?: number;
  recommendation?: string;
}

export interface SynthesisX extends Synthesis {
  insights: InsightX[];
  verification: {
    insightsProposed: number;
    insightsKept: number;
    evidenceProposed: number;
    evidenceVerified: number;
    evidenceDropped: number;
    timestampsCorrected: number;
  };
  /** Present on demo/seeded syntheses. */
  generatedBy?: 'ai' | 'seed';
}

export interface TranscriptLine {
  t: number;
  speaker: 'participant' | 'moderator';
  text: string;
}

export interface ProposedInsight {
  title: string;
  body: string;
  severity: Insight['severity'];
  tags: string[];
  stepId: string | null;
  variantId: string | null;
  recommendation?: string | null;
  evidence: { session: string; tSec: number; quote: string | null; eventKind: string | null }[];
}

// ── Fuzzy quote matching ────────────────────────────────────────────────────

const tokens = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9À-￿]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

/** Longest common subsequence length over tokens (quote tokens should appear in order). */
function lcs(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  return prev[b.length];
}

/** Share of quote tokens found (in order) within the text. Ellipses in quotes are tolerated. */
export function quoteMatchScore(quote: string, text: string): number {
  const q = tokens(quote.replace(/\.\.\.|…/g, ' '));
  if (!q.length) return 0;
  return lcs(q, tokens(text)) / q.length;
}

export const MATCH_THRESHOLD = 0.8;
export const NEAR_WINDOW_MS = 45_000;

/**
 * Find the best transcript match for a quote. Utterances are considered alone and joined with their neighbour
 * (quotes may span two transcript segments). Prefers matches within ±45 s of the cited time.
 */
export function matchQuote(quote: string, tMs: number, lines: TranscriptLine[]) {
  let best: { score: number; line: TranscriptLine; near: boolean } | null = null;
  const qLen = tokens(quote).length;
  if (qLen < 2) return null; // single words are not verifiable quotes
  for (let i = 0; i < lines.length; i++) {
    const cands = [lines[i].text];
    if (i + 1 < lines.length && lines[i + 1].speaker === lines[i].speaker) cands.push(`${lines[i].text} ${lines[i + 1].text}`);
    for (const text of cands) {
      const score = quoteMatchScore(quote, text);
      if (score < MATCH_THRESHOLD) continue;
      const near = Math.abs(lines[i].t - tMs) <= NEAR_WINDOW_MS;
      const better =
        !best ||
        (near && !best.near) ||
        (near === best.near && (score > best.score + 1e-9 || (Math.abs(score - best.score) < 1e-9 && Math.abs(lines[i].t - tMs) < Math.abs(best.line.t - tMs))));
      if (better) best = { score, line: lines[i], near };
    }
  }
  return best;
}

export interface SessionCorpus {
  sessionId: string;
  participantCode: string;
  variantId: string;
  lines: TranscriptLine[];
  events: { t: number; kind: string }[];
}

/** Verify proposed insights against the corpus. Pure function (unit tested). */
export function verifyInsights(
  proposed: ProposedInsight[],
  corpus: SessionCorpus[],
  known: { stepIds: Set<string>; variantIds: Set<string> },
): { insights: InsightX[]; verification: SynthesisX['verification'] } {
  const byKey = new Map<string, SessionCorpus>();
  for (const c of corpus) {
    byKey.set(c.sessionId, c);
    byKey.set(c.participantCode.toLowerCase(), c);
  }
  const v = { insightsProposed: proposed.length, insightsKept: 0, evidenceProposed: 0, evidenceVerified: 0, evidenceDropped: 0, timestampsCorrected: 0 };
  const out: InsightX[] = [];
  for (const p of proposed) {
    const evidence: EvidenceX[] = [];
    let dropped = 0;
    const seen = new Set<string>();
    for (const e of p.evidence ?? []) {
      v.evidenceProposed++;
      const c = byKey.get(String(e.session ?? '').trim()) ?? byKey.get(String(e.session ?? '').trim().toLowerCase());
      const tMs = Math.max(0, Math.round(Number(e.tSec ?? 0) * 1000));
      let ok: EvidenceX | null = null;
      if (c && e.quote && e.quote.trim()) {
        // Only participant speech counts as evidence (the moderator's words never do).
        const m = matchQuote(e.quote, tMs, c.lines.filter((l) => l.speaker === 'participant'));
        if (m) {
          const corrected = !m.near;
          ok = {
            sessionId: c.sessionId,
            participantCode: c.participantCode,
            t: m.line.t,
            quote: m.score >= 0.95 ? e.quote.trim() : m.line.text.trim(),
            verifiedBy: 'quote',
            matchScore: Math.round(m.score * 100) / 100,
            speaker: m.line.speaker,
            ...(corrected ? { timeCorrected: true } : {}),
          };
          if (corrected) v.timestampsCorrected++;
        }
      } else if (c && e.eventKind) {
        const kind = String(e.eventKind);
        const hit = c.events
          .filter((x) => x.kind === kind && Math.abs(x.t - tMs) <= 10_000)
          .sort((a, b) => Math.abs(a.t - tMs) - Math.abs(b.t - tMs))[0];
        if (hit) ok = { sessionId: c.sessionId, participantCode: c.participantCode, t: hit.t, eventKind: kind as EventKind, verifiedBy: 'event' };
      }
      if (!ok) {
        dropped++;
        v.evidenceDropped++;
        continue;
      }
      const k = `${ok.sessionId}:${ok.t}:${ok.quote ?? ok.eventKind}`;
      if (seen.has(k)) continue;
      seen.add(k);
      v.evidenceVerified++;
      evidence.push(ok);
    }
    if (!evidence.length) continue;
    out.push({
      id: newId('ins'),
      title: String(p.title ?? '').slice(0, 200),
      body: String(p.body ?? ''),
      severity: (['critical', 'major', 'minor', 'positive', 'info'] as const).includes(p.severity) ? p.severity : 'info',
      tags: (p.tags ?? []).map((t) => String(t).toLowerCase().trim()).filter(Boolean).slice(0, 6),
      stepId: p.stepId && known.stepIds.has(p.stepId) ? p.stepId : null,
      variantId: p.variantId && known.variantIds.has(p.variantId) ? p.variantId : null,
      evidence,
      ...(dropped ? { droppedEvidence: dropped } : {}),
      ...(p.recommendation ? { recommendation: String(p.recommendation) } : {}),
    });
  }
  const order = { critical: 0, major: 1, minor: 2, info: 3, positive: 4 };
  out.sort((a, b) => order[a.severity] - order[b.severity] || b.evidence.length - a.evidence.length);
  v.insightsKept = out.length;
  return { insights: out, verification: v };
}

