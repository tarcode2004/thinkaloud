// Deterministic stand-in for the realtime model ("scripted moderator"). It follows the same tool
// protocol as gpt-realtime-2 and reads the same inputs: the session instructions, [STEP]/[EVENT]/
// [TRIGGER] system items, tool results (briefs, ok:false + hint), directed "# NOW" turns, forced
// tool_choice and out-of-band classification prompts. Where the real model has to judge, it applies
// the rule text it was actually given — e.g. it answers "What does that mean?" plainly only when the
// instructions say so, otherwise it uses the redirect phrases the instructions list (and an
// over-broad researcher rule such as "if asked, reply 'What do you think it means?'" is applied to
// every "what does that mean" unless the instructions say rules apply narrowly) — so the harness
// measures what the prompts and the runner make a rule-following model do. No network, no LLM.

export type ModeratorOutput = { kind: 'speech'; text: string; textOnly?: boolean } | { kind: 'tool'; name: string; args: Record<string, unknown> } | { kind: 'none'; silent?: boolean };

type Brief = Record<string, any> & { step?: { id: string; type: string; phase?: string; title?: string }; say_verbatim?: string; your_job?: string; question?: { question_id: string; answer_format?: string } };
type Item = { id: string; role: 'system' | 'user' | 'assistant' | 'tool'; text: string; json?: any; deleted?: boolean };

const Q = (s: string) => [...s.matchAll(/["“]([^"”]{2,400})["”]/g)].map((m) => m[1]);

// Participant utterance patterns (EN + DE).
const P = {
  ready: /\b(yes|yeah|yep|ready|let'?s (go|begin|start)|sure|okay|ok|ja|bereit|los geht|können anfangen)\b/i,
  done: /\b(i'?m done|i am done|i think i'?m done|done now|okay,? done|^done\b|i('ve| have)? found it|found it|i was able to find it|that'?s it|finished|i'?m finished|ich bin (jetzt )?fertig|bin fertig|fertig)\b/i,
  skip: /\b(skip|give up|move on|überspringen|aufgeben)\b/i,
  taskQ: /\b(what am i supposed to do|what (was|is) the task|what do i (have to|need to) do|repeat (that|the task)|say (that|it) again|can you repeat|noch ?mal|wiederholen|was soll ich (machen|tun))\b/i,
  meaning: /\b(what does (that|this|it) mean|what do you mean|what('?s| is) (that|this) mean|are you saying|do you mean|what (green|post|text)\b.*\?|wie meinen sie|was bedeutet|was meinen sie|say again more slowly|say it simpler|can you say (it|again))/i,
  mechanics: /\b(do i (click|press|hit) (done|i'?m done|the button)|should i (click|press)|how do i (finish|end|stop)|can i skip|is there a (done|skip) button|soll ich .*(klicken|drücken))\b/i,
  help: /\b(where do i (click|go|find)|how do i get|is this (right|correct)|did i do it|am i (right|on the right track)|wo (muss|soll) ich klicken)\b/i,
  observation: /\b(i (don'?t|do not|can'?t|cannot) (see|find)|nothing (here|there)|there'?s no|stupid|annoying|confusing|whatever|ich (sehe|finde) (kein|nichts))/i,
  dontKnow: /\b(i (don'?t|do not) know|don'?t know|dunno|no idea|not sure|i'?m not sure|keine ahnung|weiß (ich )?nicht|ich weiß es nicht)\b/i,
};
const NUM_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eins: 1, zwei: 2, drei: 3, vier: 4, fünf: 5, sechs: 6, sieben: 7 };

const DE: Record<string, string> = {
  'Thanks.': 'Danke.',
  'Okay.': 'Okay.',
  'Mm-hm.': 'Mhm.',
  'How do you feel that went?': 'Wie ist es Ihrer Meinung nach gelaufen?',
  'What are you thinking right now?': 'Woran denken Sie gerade?',
  'Remember to keep talking.': 'Denken Sie bitte weiter laut.',
  "What's on your mind right now?": 'Was geht Ihnen gerade durch den Kopf?',
  'What would you expect?': 'Was würden Sie erwarten?',
  "What would you do if I weren't here?": 'Was würden Sie tun, wenn ich nicht da wäre?',
  'Do whatever feels natural to you.': 'Machen Sie es so, wie es sich für Sie natürlich anfühlt.',
  'What do you think it means?': 'Was denken Sie, was es bedeutet?',
  'What would you try next?': 'Was würden Sie als Nächstes versuchen?',
  'Would you like to keep going, or move on to the next part?': 'Möchten Sie weitermachen oder zum nächsten Teil gehen?',
  "No problem, let's move on.": 'Kein Problem, machen wir weiter.',
  "Thanks, let's stop this task there.": 'Danke, wir beenden diese Aufgabe hier.',
  "Let's stop this one here.": 'Wir hören bei dieser hier auf.',
  "If you'd like, you can skip this one — just say so or press Skip.": 'Wenn Sie möchten, können Sie diese Aufgabe überspringen – sagen Sie es einfach oder drücken Sie „Überspringen“.',
  'Sorry, we had a short connection problem.': 'Entschuldigung, wir hatten ein kurzes Verbindungsproblem.',
  "Okay, let's continue.": 'Okay, machen wir weiter.',
  'Take your time.': 'Lassen Sie sich Zeit.',
  "If you're finished, just say 'done' or press 'I'm done'.": 'Wenn Sie fertig sind, sagen Sie einfach „fertig“ oder drücken Sie „Ich bin fertig“.',
};

export class ScriptedModerator {
  language: string;
  private rand: () => number;
  private instructions = '';
  private tools: { name: string; parameters?: { properties?: Record<string, unknown> } }[] = [];
  private items: Item[] = [];
  /** Index of the first item not yet considered by a response. */
  private cursor = 0;
  private brief: Brief | null = null;
  private stepId = 'intro';
  private askedInStep = new Map<string, number>();
  private awaitingHowWent = false;
  private lastSpoken = '';
  private lastRedirect = '';
  private lastNudge = '';
  private probeAsked = false;
  private recordedLast = false;
  private callSeq = 0;
  /** Decisions taken (for the report). */
  readonly decisions: { t: number; why: string; out: string }[] = [];

  constructor(o: { language: string; rand: () => number }) {
    this.language = (o.language || 'en').toLowerCase().split(/[-_]/)[0];
    this.rand = o.rand;
  }

  private get en() {
    return this.language === 'en';
  }
  private L(s: string) {
    return this.en ? s : (DE[s] ?? s);
  }

  // ── inputs ─────────────────────────────────────────────────────────────────
  onConnect() {
    this.items = [];
    this.cursor = 0;
  }
  setInstructions(s: string) {
    this.instructions = s;
  }
  setTools(t: unknown[]) {
    this.tools = t as typeof this.tools;
  }
  addSystem(text: string, id: string) {
    this.items.push({ id, role: 'system', text });
    const b = this.parseBrief(text);
    if (b) this.setBrief(b);
  }
  addUser(text: string, id: string) {
    if (!text.trim()) return;
    const ex = this.items.find((i) => i.id === id);
    if (ex) ex.text = text;
    else this.items.push({ id, role: 'user', text });
  }
  addToolOutput(_callId: string, output: string) {
    let json: any = null;
    try {
      json = JSON.parse(output);
    } catch {
      /* not json */
    }
    this.items.push({ id: `tool_${this.items.length}`, role: 'tool', text: output, json });
    const b = json?.step ? json : json?.current?.step ? json.current : null;
    if (b) this.setBrief(b);
  }
  deleteItem(id: string) {
    const it = this.items.find((i) => i.id === id);
    if (it) it.deleted = true;
  }
  truncated(_id: string, _ms: number) {}
  interrupted() {}
  noteSpoken(text: string, id: string) {
    this.items.push({ id, role: 'assistant', text });
    this.lastSpoken = text;
  }

  private parseBrief(text: string): Brief | null {
    const i = text.indexOf('[STEP] ');
    if (i < 0) return null;
    try {
      return JSON.parse(text.slice(i + 7)) as Brief;
    } catch {
      return null;
    }
  }
  private setBrief(b: Brief) {
    const id = b.step?.id ?? this.stepId;
    if (id !== this.stepId) {
      this.stepId = id;
      this.askedInStep = new Map();
      this.awaitingHowWent = false;
      this.probeAsked = false;
    }
    if (b.step?.phase === 'post_task') this.awaitingHowWent = false;
    this.brief = b;
  }

  // ── rules derived from the instructions it was given ───────────────────────
  private get plainRule() {
    return /ALWAYS gets a plain, direct answer|always answer plainly|answer plainly when/i.test(this.instructions);
  }
  private get observationAck() {
    return /Never answer an observation with a redirect/i.test(this.instructions);
  }
  private get narrowRules() {
    return /applied narrowly|Apply each researcher rule only/i.test(this.instructions);
  }
  private get customReply(): string | null {
    const sec = this.instructions.split(/# Researcher rules/)[1] ?? '';
    const m = /if asked,? (?:reply|say|answer) ['"“]([^'"”]+)['"”]/i.exec(sec);
    return m ? m[1] : null;
  }
  private redirects(): string[] {
    const forbidden = new Set<string>();
    for (const line of this.instructions.split('\n')) if (/never (say|use)/i.test(line)) for (const q of Q(line)) forbidden.add(q);
    const out: string[] = [];
    for (const line of this.instructions.split('\n')) if (/redirect/i.test(line)) for (const q of Q(line)) if (/\?$|\.$/.test(q) && q.length < 60 && !forbidden.has(q) && !/[Ii]s this right|Where do I|Am I done|Did I|How do I/.test(q)) out.push(q);
    return out.length ? out : ['What would you expect?'];
  }
  private redirect(): string {
    const r = this.redirects();
    const choices = r.filter((x) => x !== this.lastRedirect);
    const pick = (choices.length ? choices : r)[Math.floor(this.rand() * (choices.length || r.length))];
    this.lastRedirect = pick;
    return this.L(pick);
  }
  private hasDeclinedParam() {
    const ra = this.tools.find((t) => t.name === 'record_answer');
    return Boolean(ra?.parameters?.properties && 'declined' in ra.parameters.properties);
  }

  // ── outputs ────────────────────────────────────────────────────────────────
  private say(text: string, why: string): ModeratorOutput {
    this.decisions.push({ t: Date.now(), why, out: `say: ${text}` });
    return { kind: 'speech', text };
  }
  private tool(name: string, args: Record<string, unknown>, why: string): ModeratorOutput {
    this.decisions.push({ t: Date.now(), why, out: `${name} ${JSON.stringify(args)}` });
    if (name === 'record_answer') this.recordedLast = true;
    this.callSeq++;
    return { kind: 'tool', name, args };
  }
  private none(why: string, silent = false): ModeratorOutput {
    this.decisions.push({ t: Date.now(), why, out: 'none' });
    return { kind: 'none', silent };
  }
  private ask(text: string, why: string, ack = ''): ModeratorOutput {
    this.askedInStep.set(text, (this.askedInStep.get(text) ?? 0) + 1);
    return this.say(`${ack ? `${ack} ` : ''}${text}`, why);
  }

  private newItems(): Item[] {
    const n = this.items.slice(this.cursor).filter((i) => !i.deleted && i.role !== 'assistant');
    this.cursor = this.items.length;
    return n;
  }
  private lastUserText(n = 3): string {
    return this.items
      .filter((i) => i.role === 'user' && !i.deleted)
      .slice(-n)
      .map((i) => i.text)
      .join(' ');
  }

  /** In-band response. */
  respond(req: { instructions?: string; toolChoice?: unknown; textOnly?: boolean; auto?: boolean }): ModeratorOutput {
    const fresh = this.newItems();
    const now = req.instructions?.includes('# NOW') ? (req.instructions.split('# NOW').pop() ?? '').trim() : '';
    const forced = typeof req.toolChoice === 'object' && req.toolChoice ? (req.toolChoice as { name?: string }).name : undefined;
    if (forced) return this.forcedTool(forced, now);
    if (now) {
      const s = this.fromNow(now);
      if (s) return { ...s, ...(req.textOnly && s.kind === 'speech' ? { textOnly: true } : {}) };
    }
    // Generic turn: react to the newest meaningful input.
    const meaningful = fresh.filter((i) => !(i.role === 'system' && /^\[APP\]/.test(i.text)));
    const last = meaningful[meaningful.length - 1];
    if (!last) {
      if (req.auto) return this.none('VAD turn without new input', true);
      return this.actOnBrief(this.brief, '', 'plain response.create, nothing new');
    }
    if (last.role === 'tool') return this.onToolResult(last.json);
    if (last.role === 'system') return this.onSystem(last.text);
    const userText = meaningful
      .filter((i) => i.role === 'user')
      .slice(-3)
      .map((i) => i.text)
      .join(' ');
    return this.onUser(userText);
  }

  /** Directed "# NOW" turn: say the dictated text (ack + quote), or the canned equivalent. */
  private fromNow(now: string): ModeratorOutput | null {
    // The runner hands over the participant's complete answer turn: react to exactly those words.
    const turn = /Their complete answer turn[^:]*: "([^"]*)"/.exec(now)?.[1];
    if (turn != null) return this.onUser(turn);
    if (/when they are finished they can just say so/i.test(now)) return this.say(this.L("If you're finished, just say 'done' or press 'I'm done'."), 'directed: how to finish');
    const quotes = Q(now);
    const verbatim = /verbatim|exactly (this|the following)|ask exactly this|say once|say:/i.test(now);
    if (quotes.length && verbatim) {
      // 'Say "Thanks.", then say … :\n"TEXT"' → ack + text; otherwise the last quote is the text.
      const text = quotes[quotes.length - 1];
      const ack = /\bSay ["“]([^"”]{1,40})["”],? then/i.exec(now)?.[1];
      const lead = /acknowledge it/i.test(now) ? (this.en ? "I hear you, that's frustrating." : 'Ich verstehe, das ist frustrierend.') : '';
      const nonEnAck = !this.en && /equivalent of ["“]([^"”]+)["”]/i.exec(now)?.[1];
      const ackText = ack ? this.L(ack) : nonEnAck ? this.L(nonEnAck) : '';
      if (this.brief && text === this.brief.say_verbatim) this.askedInStep.set(text, (this.askedInStep.get(text) ?? 0) + 1);
      if (/how do you feel that went/i.test(text)) this.awaitingHowWent = true;
      return this.say([lead, ackText, this.L(text)].filter(Boolean).join(' '), 'directed verbatim');
    }
    if (/how they feel the task went/i.test(now)) {
      this.awaitingHowWent = true;
      return this.say(this.L('How do you feel that went?'), 'directed: ask how it went');
    }
    if (/skip this task/i.test(now)) return this.say(this.L("If you'd like, you can skip this one — just say so or press Skip."), 'directed: skip reminder');
    if (/call (\w+) now/i.test(now)) return this.forcedTool(/call (\w+) now/i.exec(now)![1], now);
    return null;
  }

  private forcedTool(name: string, now: string): ModeratorOutput {
    const said = /["“]([^"”]+)["”]/.exec(now.split(/how it went: |for: |what the task asked for: /)[1] ?? '')?.[1] ?? this.lastUserText(2);
    if (name === 'set_task_outcome') return this.tool('set_task_outcome', { outcome: P.done.test(said) || /delivered|told you/i.test(now) ? 'success' : 'partial', evidence: `no matching app activity observed; participant said: "${said.slice(0, 160)}"` }, 'forced set_task_outcome');
    if (name === 'record_answer') {
      const qid = /question_id "([^"]+)"/.exec(now)?.[1] ?? this.brief?.question?.question_id ?? '';
      const text = /Their complete answer turn[^:]*: "([^"]*)"/.exec(now)?.[1] || this.lastUserText(2) || 'No answer given.';
      return this.tool('record_answer', { question_id: qid, text, ...(this.hasDeclinedParam() && (P.dontKnow.test(text) || !text) ? { declined: true } : {}) }, 'forced record_answer');
    }
    if (name === 'complete_step') return this.tool('complete_step', { summary: this.summary() }, 'forced complete_step');
    return this.tool(name, {}, 'forced tool');
  }

  private summary() {
    const u = this.lastUserText(2);
    return u ? `Participant said: "${u.slice(0, 160)}"` : 'Step finished.';
  }

  private onSystem(text: string): ModeratorOutput {
    if (/^\[TRIGGER\]/.test(text)) {
      const ex = Q(text).filter((q) => q !== this.lastNudge);
      const pick = ex.length ? ex[Math.floor(this.rand() * ex.length)] : 'What are you thinking right now?';
      this.lastNudge = pick;
      return this.say(this.L(pick), 'trigger (nudge / check-in)');
    }
    if (/pressed the "I'm done" button/i.test(text) && !/\[STEP\]/.test(text)) {
      this.awaitingHowWent = true;
      return this.say(this.L(Q(text).find((q) => /\?$/.test(q)) ?? 'How do you feel that went?'), '[EVENT] done button');
    }
    if (/connection dropped/i.test(text)) {
      const b = this.parseBrief(text);
      const r = this.actOnBrief(b, '', 'reconnect');
      return r.kind === 'speech' ? this.say(`${this.L('Sorry, we had a short connection problem.')} ${r.text}`, 'reconnect') : this.say(this.L('Sorry, we had a short connection problem.'), 'reconnect');
    }
    const ack = Q(text.split('[STEP]')[0]).find((q) => q.length < 45 && /\.$/.test(q) && !/\?/.test(q)) ?? '';
    return this.actOnBrief(this.parseBrief(text) ?? this.brief, ack ? this.L(ack) : '', 'system item');
  }

  private actOnBrief(b: Brief | null, ack: string, why: string, allowRepeat = false): ModeratorOutput {
    if (!b) return this.none(`${why}: no brief`);
    const job = String(b.your_job ?? '');
    const sv = b.say_verbatim;
    if (sv && (allowRepeat || !this.askedInStep.has(sv))) return this.ask(sv, `${why}: say_verbatim`, ack);
    if (/call complete_step/i.test(job) && !/do not call complete_step/i.test(job) && !/^(briefing|active)$/.test(String(b.step?.phase ?? ''))) {
      if (b.allowed_researcher_probes?.length && !this.probeAsked && /follow-up/i.test(job)) {
        this.probeAsked = true;
        return this.ask(String(b.allowed_researcher_probes[0]), 'post-task researcher probe', ack);
      }
      return this.tool('complete_step', { summary: this.summary() }, `${why}: brief says complete_step`);
    }
    if (ack) return this.say(ack, `${why}: ack only`);
    return this.none(`${why}: nothing to do`);
  }

  private onToolResult(out: any): ModeratorOutput {
    if (!out) return this.actOnBrief(this.brief, '', 'tool result (unparsed)');
    if (out.ok === false) {
      const hint = String(out.hint ?? '');
      const err = String(out.error ?? '');
      if (/wait silently|stay quiet|stay completely quiet/i.test(hint)) return this.none('tool error: wait');
      const hq = /verbatim(?: now)?:? ["“]([^"”]+)["”]/i.exec(hint)?.[1];
      if (hq) return this.ask(hq, `tool error → hint: ${err}`);
      if (/numeric value|between \d+ and \d+/i.test(err)) {
        const m = /from (\d+) to (\d+)/.exec(String(out.current?.question?.answer_format ?? hint));
        return this.say(this.en ? `Please pick a number from ${m?.[1] ?? 1} to ${m?.[2] ?? 7} on the scale.` : `Bitte wählen Sie eine Zahl von ${m?.[1] ?? 1} bis ${m?.[2] ?? 7}.`, 'tool error: rating needs a number');
      }
      // e.g. yes/no validation failed: re-ask the current question.
      return this.actOnBrief(out.current ?? this.brief, '', `tool error (${err})`, true);
    }
    const ack = out.recorded ? this.L('Thanks.') : '';
    if (/Say the closing text verbatim/i.test(String(out.your_job ?? ''))) return this.none('closing handled by system');
    return this.actOnBrief(out.step ? out : this.brief, ack, 'tool result');
  }

  /** The participant said something and a response was requested (VAD or the runner). */
  private onUser(u: string): ModeratorOutput {
    const b = this.brief;
    const type = b?.step?.type ?? 'intro';
    const phase = String(b?.step?.phase ?? '');
    const isQ = /\?\s*$/.test(u.trim());
    if (type === 'intro') {
      if (P.ready.test(u) && !isQ) return this.tool('complete_step', { summary: 'The participant said they are ready.' }, 'intro: ready');
      return this.say(this.en ? 'Sure. Just let me know when you are ready to begin.' : 'Gern. Sagen Sie einfach Bescheid, wenn Sie bereit sind.', 'intro: other');
    }
    if (type === 'closing') return this.none('closing: nothing to add');
    const qid = b?.question?.question_id;
    const fmt = String(b?.question?.answer_format ?? '');
    // Task in progress.
    if (type === 'task' && (phase === 'briefing' || phase === 'active')) {
      if (this.awaitingHowWent && !isQ && u.trim()) {
        this.awaitingHowWent = false;
        return this.tool('set_task_outcome', { outcome: 'success', evidence: `participant said: "${u.slice(0, 160)}"` }, 'answer to "how did it go"');
      }
      if (P.skip.test(u) && !isQ) return this.tool('participant_requests_skip', { reason: u.slice(0, 200) }, 'participant wants to skip');
      if (P.done.test(u) && !isQ) {
        this.awaitingHowWent = true;
        return this.say(this.L(Q(this.instructions.split('\n').find((l) => /how do you feel that went/i.test(l)) ?? '').find((q) => /how do you feel/i.test(q)) ?? 'How do you feel that went?'), 'participant says done');
      }
      return this.clarifyOrRedirect(u, String(b?.task_text ?? b?.say_verbatim ?? ''));
    }
    // A question is open (post-task, question step, interview, spoken questionnaire).
    if (qid && b?.say_verbatim) {
      const sv = b.say_verbatim;
      if (!this.askedInStep.has(sv)) return this.ask(sv, 'open question not asked yet', this.recordedLast ? this.L('Thanks.') : '');
      const job = String(b.your_job ?? '');
      const dk = P.dontKnow.test(u);
      if (isQ && !dk) {
        if (/do not explain the question and do not ask it again/i.test(job)) return this.tool('record_answer', { question_id: qid, text: u, ...(this.hasDeclinedParam() ? { declined: true } : {}) }, 'question after a skipped task: accept as answer');
        if (P.meaning.test(u) || /\bwhat\b/i.test(u)) return this.ask(sv, 'clarification of the question → re-read it', this.plainRule ? (this.en ? 'Sure —' : 'Gern —') : '');
        return this.clarifyOrRedirect(u, sv);
      }
      if (dk) {
        if (this.hasDeclinedParam()) return this.tool('record_answer', { question_id: qid, text: u, declined: true }, '"I don\'t know" (declined)');
        return this.tool('record_answer', { question_id: qid, text: "They said they don't know." }, '"I don\'t know" (no declined field)');
      }
      if (/^Rating from/i.test(fmt)) {
        const n = /\b(\d+)\b/.exec(u)?.[1] ?? Object.entries(NUM_WORDS).find(([w]) => new RegExp(`\\b${w}\\b`, 'i').test(u))?.[1];
        return this.tool('record_answer', n != null ? { question_id: qid, value: Number(n), text: u } : { question_id: qid, text: u }, 'rating answer');
      }
      if (/^Yes or no/i.test(fmt)) {
        const v = /\b(yes|yeah|yep|ja)\b/i.test(u) ? 1 : /\b(no|nope|nein)\b/i.test(u) ? 0 : undefined;
        return this.tool('record_answer', v != null ? { question_id: qid, value: v, text: u } : { question_id: qid, text: u }, 'yes/no answer');
      }
      if (/^Choose/i.test(fmt)) return this.tool('record_answer', { question_id: qid, choices: [u.replace(/[.!]$/, '')], text: u }, 'choice answer');
      return this.tool('record_answer', { question_id: qid, text: u }, 'open answer');
    }
    if (b && /call complete_step/i.test(String(b.your_job ?? ''))) return this.actOnBrief(b, '', 'participant spoke; brief says complete');
    if (type === 'questionnaire') return this.none('on-screen questionnaire: stay quiet');
    return this.say(this.L('Okay.'), 'participant spoke, nothing open');
  }

  /** Questions and observations during a task, by the rule text in the instructions. */
  private clarifyOrRedirect(u: string, rawTask: string): ModeratorOutput {
    const taskText = rawTask.replace(/^(Thanks|Okay|Got it|No problem, let's move on|Danke)[.,!]?\s+/i, '');
    const isQ = /\?\s*$/.test(u.trim());
    if (P.taskQ.test(u) && taskText) return this.ask(taskText, 'asked for the task again → re-read verbatim');
    if (P.mechanics.test(u)) {
      if (this.plainRule) return this.say(this.en ? 'Yes — when you have finished, press "I\'m done", or just tell me.' : 'Ja – wenn Sie fertig sind, drücken Sie „Ich bin fertig“ oder sagen Sie es mir einfach.', 'mechanics question: plain answer');
      return this.say(this.redirect(), 'mechanics question: redirect (no plain-answer rule)');
    }
    if (P.meaning.test(u) || /without (your|my) help/i.test(u)) {
      if (this.plainRule) {
        if (/without (your|my) help|are you saying/i.test(u)) return this.say(this.en ? "Yes — I can't help with the task itself, but you can skip it whenever you like." : 'Ja – bei der Aufgabe selbst kann ich nicht helfen, aber Sie können sie jederzeit überspringen.', 'meaning question: plain');
        const prev = this.lastSpoken && !taskText.includes(this.lastSpoken) ? this.lastSpoken : '';
        return this.say(prev && /\?$/.test(prev) ? (this.en ? `I just meant: tell me what you're looking for or expect to see here.` : 'Ich meinte nur: Sagen Sie mir, wonach Sie suchen oder was Sie hier erwarten.') : this.en ? `I meant the task: ${taskText}` : `Ich meinte die Aufgabe: ${taskText}`, 'meaning question: plain rephrase');
      }
      const cr = this.customReply;
      if (cr && !this.narrowRules && /mean/i.test(u)) return this.say(this.L(cr), 'meaning question: researcher rule applied broadly');
      return this.say(this.redirect(), 'meaning question: redirect');
    }
    if (P.help.test(u)) return this.say(this.redirect(), 'help request: redirect');
    if (P.observation.test(u) && !isQ) {
      if (this.observationAck) return this.say(this.L('Mm-hm.'), 'observation: acknowledge');
      return this.say(this.redirect(), 'observation: redirect (old rule 3)');
    }
    if (isQ) return this.say(this.plainRule ? this.L('Okay.') : this.redirect(), 'other question');
    return this.say(this.L('Mm-hm.'), 'think-aloud reply');
  }

  // ── out-of-band classification ─────────────────────────────────────────────
  classify(prompt: string): string {
    const u = /transcribed as: "([^"]*)"/.exec(prompt)?.[1] ?? '';
    const awaiting = /The moderator had just asked them something/.test(prompt);
    const isQ = /\?\s*$/.test(u.trim());
    const multi = /DONE —/.test(prompt);
    const task = /they were told: "([^"]*)"/.exec(prompt)?.[1] ?? '';
    const addressed = isQ || P.meaning.test(u) || P.mechanics.test(u) || P.taskQ.test(u) || P.help.test(u);
    if (!multi) return addressed || (P.done.test(u) && !isQ) || P.skip.test(u) || awaiting || /rating|questionnaire/.test(prompt) && /\b\d\b/.test(u) ? 'YES' : 'NO';
    if (P.skip.test(u) && !isQ) return 'SKIP';
    if (P.done.test(u) && !isQ) return 'DONE';
    if (addressed) return 'ADDRESSED';
    if (P.observation.test(u)) return 'STUCK';
    if (/\b(tell me|explain|describe|say 'done')/i.test(task) && u.split(/\s+/).length >= 8 && !this.soundsUnfinished(u)) return 'DELIVERED';
    return awaiting ? 'ADDRESSED' : 'NO';
  }

  soundsUnfinished(text: string): boolean {
    const t = text.trim();
    if (/(\.\.\.|…|—|-)$/.test(t)) return true;
    const n = t.split(/\s+/).length;
    if (n < 4 && !/[.!?]$/.test(t)) return true;
    return /\b(and|but|or|so|because|the|a|to|of|um|uh|like|und|aber|weil)$/i.test(t.replace(/[^\p{L}\p{N}' ]+$/u, ''));
  }
}
