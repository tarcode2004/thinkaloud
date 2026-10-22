// Per-run Markdown + JSON reports and the aggregate summary table.
import fs from 'node:fs';
import path from 'node:path';
import type { Timeline } from './agent.ts';
import type { LogEvent } from './lib/api.ts';
import { REPORTS_DIR } from './lib/env.ts';
import { CHECK_TITLES, conversationLines, type CheckId, type Judgement } from './judge.ts';

export interface RunResult {
  scenario: string;
  description: string;
  persona: string;
  label?: string;
  startedAt: string;
  durationSec: number;
  sessionId?: string;
  completed: boolean;
  error?: string;
  judgement: Judgement & { overall?: string };
  reproduces?: string[];
  beatsFired: { id: string; reproduces?: string; t: number }[];
  timeline: Timeline | null;
  events: LogEvent[];
  answers?: unknown[];
  taskResults?: unknown[];
  usage?: Record<string, number>;
  /** Mock realtime counters (responses, tool calls, interruptions, blocked network requests). */
  mock?: { responses: number; oob: number; toolCalls: number; interruptions: number; blockedRequests: string[] };
  /** Why the scripted moderator did what it did (session-relative seconds). */
  moderatorDecisions?: { s: number; why: string; out: string }[];
  /** Code under test (git ref or working tree). */
  code?: string;
  files?: { md: string; json: string };
}

const s = (t: number) => `${(t / 1000).toFixed(1)}s`;
const mark = (st: string) => (st === 'pass' ? 'PASS' : st === 'fail' ? '**FAIL**' : st === 'warn' ? 'warn' : 'n/a');

export function writeRunReport(r: RunResult, stampStr: string): { md: string; json: string } {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  let base = path.join(REPORTS_DIR, `${r.scenario}${r.label ? `-${r.label}` : ''}-${stampStr}`);
  for (let i = 2; fs.existsSync(`${base}.json`) && !r.files; i++) base = path.join(REPORTS_DIR, `${r.scenario}${r.label ? `-${r.label}` : ''}-${stampStr}-${i}`);
  const j = r.judgement;
  const md: string[] = [];
  md.push(`# Harness run: ${r.scenario}${r.label ? ` (${r.label})` : ''}`);
  md.push('');
  md.push(`- **Scenario:** ${r.description}`);
  md.push(`- **Persona:** ${r.persona}`);
  md.push(`- **Started:** ${r.startedAt} · **Duration:** ${r.durationSec.toFixed(0)} s · **Session:** ${r.sessionId ?? '—'} · **Completed:** ${r.completed ? 'yes' : 'no'}`);
  if (r.error) md.push(`- **Error:** \`${r.error}\``);
  md.push(`- **Result:** ${j.failed ? `**${j.failed} failing**` : 'all passing'}${j.warned ? `, ${j.warned} warning(s)` : ''}`);
  if (r.code) md.push(`- **Code under test:** ${r.code}`);
  if (r.mock) md.push(`- **Mock realtime:** ${r.mock.responses} responses, ${r.mock.toolCalls} tool calls, ${r.mock.oob} classifications, ${r.mock.interruptions} barge-ins; blocked OpenAI requests: ${r.mock.blockedRequests.length}`);
  md.push('');
  md.push('## Deterministic checks');
  md.push('');
  md.push('| Check | Result | Findings |');
  md.push('|---|---|---|');
  for (const c of j.checks) md.push(`| ${c.title} | ${mark(c.status)} | ${c.findings.length}${c.note ? ` (${c.note})` : ''} |`);
  md.push('');
  const fails = j.checks.flatMap((c) => c.findings.map((f) => ({ ...f, check: c.title })));
  md.push('## Failures and warnings (by time)');
  md.push('');
  if (!fails.length) md.push('_None._');
  for (const f of fails.sort((a, b) => a.t - b.t)) md.push(`- \`${s(f.t)}\` ${f.severity === 'fail' ? '**FAIL**' : 'warn'} · ${f.check}${f.stepId ? ` · step \`${f.stepId}\`` : ''}: ${f.message}`);
  if (r.beatsFired.length) {
    md.push('', '## Scripted moments', '');
    for (const b of r.beatsFired) md.push(`- \`${s(b.t)}\` ${b.id}${b.reproduces ? ` — reproduces: ${b.reproduces}` : ''}`);
  }
  if (r.timeline?.notes.length) {
    md.push('', '## Harness notes', '');
    for (const n of r.timeline.notes) md.push(`- ${n}`);
  }
  if (r.moderatorDecisions?.length) {
    md.push('', '## Scripted moderator decisions', '', '```');
    for (const d of r.moderatorDecisions) md.push(`${d.s.toFixed(1).padStart(6)}s  ${d.why.padEnd(48)} → ${d.out.slice(0, 140)}`);
    md.push('```');
  }
  md.push('', '## Conversation', '', '```');
  for (const l of conversationLines(r.events, r.timeline)) md.push(`${s(l.t).padStart(7)} ${l.who.padEnd(26)} ${l.text}`);
  md.push('```');
  fs.writeFileSync(`${base}.md`, md.join('\n'));
  fs.writeFileSync(`${base}.json`, JSON.stringify({ ...r, files: undefined }, null, 1));
  return { md: `${base}.md`, json: `${base}.json` };
}

export function writeSummary(results: RunResult[], stampStr: string, title = 'Harness summary'): string {
  const checkIds = Object.keys(CHECK_TITLES) as CheckId[];
  const rubricIds: { id: string; title: string }[] = [];
  const md: string[] = [`# ${title} (${stampStr})`, ''];
  const cols = ['Scenario', 'Done', 'Fails', ...checkIds.map((c) => CHECK_TITLES[c]), ...rubricIds.map((r) => r.title)];
  md.push(`| ${cols.join(' | ')} |`);
  md.push(`|${cols.map(() => '---').join('|')}|`);
  for (const r of results) {
    const cells = checkIds.map((id) => {
      const c = r.judgement.checks.find((x) => x.id === id);
      if (!c) return '—';
      return c.status === 'fail' ? `**FAIL** (${c.findings.filter((f) => f.severity === 'fail').length})` : c.status === 'warn' ? `warn (${c.findings.length})` : c.status === 'pass' ? 'pass' : 'n/a';
    });
    const rub = rubricIds.map((x) => {
      const it = r.judgement.rubric?.find((y) => y.id === x.id);
      return it ? (it.verdict === 'fail' ? `**${it.score}**` : String(it.score)) : '—';
    });
    md.push(`| ${[`[${r.scenario}${r.label ? ` (${r.label})` : ''}](${r.files ? path.basename(r.files.md) : ''})`, r.completed ? 'yes' : 'no', String(r.judgement.failed), ...cells, ...rub].join(' | ')} |`);
  }
  md.push('', 'Check cells show the number of failing findings. All runs offline: mock realtime + scripted moderator + rule-based participant.');
  const out = path.join(REPORTS_DIR, `summary-${stampStr}.md`);
  fs.writeFileSync(out, md.join('\n'));
  fs.writeFileSync(path.join(REPORTS_DIR, 'summary-latest.md'), md.join('\n'));
  return out;
}

/** Newest run JSON per scenario for a label (rejudged files count, newest wins). */
export function latestRuns(label: string): Map<string, RunResult> {
  const out = new Map<string, { r: RunResult; m: number }>();
  for (const f of fs.readdirSync(REPORTS_DIR)) {
    if (!f.endsWith('.json')) continue;
    const full = path.join(REPORTS_DIR, f);
    let r: RunResult;
    try {
      r = JSON.parse(fs.readFileSync(full, 'utf8')) as RunResult;
    } catch {
      continue;
    }
    if (r.label !== label || !r.judgement) continue;
    const m = fs.statSync(full).mtimeMs;
    const prev = out.get(r.scenario);
    if (!prev || m > prev.m) out.set(r.scenario, { r: { ...r, files: { md: full.replace(/\.json$/, '.md'), json: full } }, m });
  }
  return new Map([...out].map(([k, v]) => [k, v.r]));
}

/** Before/after table: per scenario, each check's failing-finding count and rubric score. */
export function writeComparison(a: string, b: string, stampStr: string): string {
  const A = latestRuns(a);
  const B = latestRuns(b);
  const names = [...new Set([...A.keys(), ...B.keys()])];
  const checkIds = Object.keys(CHECK_TITLES) as CheckId[];
  const cell = (r: RunResult | undefined, id: CheckId) => {
    const c = r?.judgement.checks.find((x) => x.id === id);
    if (!c) return '—';
    const n = c.findings.filter((f) => f.severity === 'fail').length;
    return c.status === 'fail' ? `FAIL ${n}` : c.status === 'warn' ? 'warn' : c.status === 'pass' ? 'pass' : 'n/a';
  };
  const md: string[] = [`# Comparison: ${a} → ${b} (${stampStr})`, ''];
  md.push(`| Check | ${names.map((n) => `${n} ${a} → ${b}`).join(' | ')} |`);
  md.push(`|---|${names.map(() => '---').join('|')}|`);
  for (const id of checkIds) md.push(`| ${CHECK_TITLES[id]} | ${names.map((n) => `${cell(A.get(n), id)} → ${cell(B.get(n), id)}`).join(' | ')} |`);
  md.push(`| **Total failing** | ${names.map((n) => `${A.get(n)?.judgement.failed ?? '—'} → ${B.get(n)?.judgement.failed ?? '—'}`).join(' | ')} |`);
  md.push('', 'Runs used:', ...names.flatMap((n) => [A.get(n), B.get(n)].filter(Boolean).map((r) => `- ${n} (${r!.label}): ${path.basename(r!.files!.md)}`)));
  const out = path.join(REPORTS_DIR, `compare-${a}-${b}-${stampStr}.md`);
  fs.writeFileSync(out, md.join('\n'));
  return out;
}
