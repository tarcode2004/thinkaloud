# Requirements brief: AI-moderated, voice-first usability study platform

## 1. Competitors and what we need for parity

**What competitors offer:**
- **Maze:** unmoderated prototype and live-site tests, click and misclick heatmaps, task paths, an AI study builder, and an AI moderator. The moderator turns stated goals into a discussion guide and was extended in April 2026 to work with on-screen designs. It is Enterprise-tier.
- **UserTesting and Lookback:** moderated and unmoderated sessions with screen, webcam and voice recording, time-stamped notes, highlight reels, live observer rooms and a participant panel.
- **Lyssna and Useberry:** first-click tests, five-second tests, card sorting, tree testing, prototype flows with success paths, and surveys.
- **Outset.ai:** AI-generated guide from about 3 goals, up to 10 follow-ups per question ("Abyss Mode"), real-time detection of low-effort answers with re-prompting, 40+ languages, concurrent sessions, Prolific and User Interviews recruiting, guide testing against synthetic participants, and automatic themes and quotes.
- **Listen Labs:** AI interviewer with opt-in screen share, asked every session. Screen and audio are recorded in sync, so you can see where people hesitate.
- **Great Question and Dovetail:** research repository, tagging, AI synthesis with citations, participant CRM and incentives.

**Must-haves for parity:**
- Study builder with tasks, success criteria (URL or event match), per-task questions and standard questionnaires.
- Screener plus a recruiting link. Prolific integration is a big plus.
- Per-participant A/B assignment, randomized or counterbalanced.
- Synced replay of screen (rrweb), audio and transcript, with a clickable transcript.
- Clips and highlights, tags, and quote extraction.
- Click heatmaps, misclicks, path or Sankey views, and first-click analysis.
- AI synthesis where every insight links to transcript and replay timestamps. Hallucination control is a key differentiator.
- Export to CSV and JSON, plus a shareable report.

**AI-moderation specifics:**
- Moderator guide driven by goals.
- Probe depth caps per question.
- Moderator is aware of what is on screen (task state and errors), so it can probe things like "I noticed you went back. What were you looking for?"
- Detection of silence and low effort.
- Barge-in and turn-taking handling.
- Multilingual support.
- Disclosure that the moderator is an AI.
- Researcher-editable persona and guardrails.

## 2. HCI method requirements

**Think-aloud:**
- Use concurrent think-aloud with a short practice task first.
- Prompts must be neutral and only nudge talking (Ericsson & Simon level 1–2): "Keep talking," "What are you thinking?", "What are you looking for?"
- Prompt after 5–15 seconds of silence. Never prompt mid-action.
- Retrospective probes go at the end of each task, not during it, so they don't distort time-on-task.

**Neutrality rules:**
- No leading or loaded wording. Ask "How was that?", not "Was that easy?"
- No help, hints or confirming correctness.
- No praising the design, and no apologizing for it.
- Reflect the participant's words back ("You said 'confusing'. Tell me more.").
- Don't answer "Is this right?" Redirect with "What would you expect?"
- Allow a give-up and skip option, and set a hard time cap per task.

**Probing:** open-ended first (what, how, tell me about), then closed questions only for confirmation. Use one question at a time, a probe funnel ("Why?" up to N levels), and no double-barreled questions.

**Standard instruments:**
- **SUS:** 10 items on a 5-point scale from Strongly disagree (1) to Strongly agree (5).
  1. I think that I would like to use this system frequently.
  2. I found the system unnecessarily complex.
  3. I thought the system was easy to use.
  4. I think that I would need the support of a technical person to be able to use this system.
  5. I found the various functions in this system were well integrated.
  6. I thought there was too much inconsistency in this system.
  7. I would imagine that most people would learn to use this system very quickly.
  8. I found the system very cumbersome to use.
  9. I felt very confident using the system.
  10. I needed to learn a lot of things before I could use this system.

  Scoring: odd items score (x−1), even items score (5−x). The sum times 2.5 gives 0–100. The benchmark mean is about 68.
- **SEQ:** "Overall, how difficult or easy was the task to complete?" Scale 1 = Very difficult to 7 = Very easy, asked right after each task. The average is about 5.5.
- **UMUX-Lite:** 7-point scale, Strongly disagree to Strongly agree.
  1. "[This system's] capabilities meet my requirements."
  2. "[This system] is easy to use."

  Score = ((i1−1)+(i2−1))/12 × 100. The SUS-equivalent is 0.65 × score + 22.9.
- **NASA-TLX (Raw):** six subscales rated 0–100 in steps of 5: Mental demand, Physical demand, Temporal demand, Performance (good to poor), Effort, Frustration. The raw TLX score is their unweighted mean, with no pairwise weighting.
- **NPS:** "How likely are you to recommend [X] to a friend or colleague?" Scale 0–10. NPS = % promoters (9–10) − % detractors (0–6).

## 3. Metrics and statistics

**Per task:**
- Success as binary, plus optional partial (0 / 0.5 / 1) or a researcher override.
- Completion rate.
- Time on task, measured both for all attempts and for successful attempts only.
- Errors and misclicks: clicks on non-interactive elements or off the success path.
- First click: correct or not, and time to first click.
- Backtracks and rage clicks.
- SEQ.
- Lostness (Smith 1996): L = √((N/S−1)² + (R/N−1)²), where S is total pages visited, N is unique pages and R is the minimum pages needed. Above 0.5 means lost; below 0.4 means not lost.

**Per study:** SUS or UMUX-Lite with confidence intervals, NPS, and a summary per variant.

**Statistics, following Sauro & Lewis, *Quantifying the User Experience*:**
- Completion-rate CIs use adjusted Wald (add z²/2 successes and z² trials). It works well at small n.
- Comparing completion between subjects: N−1 two-proportion test (N−1 chi-square). Sauro & Lewis recommend it over Fisher exact, which is too conservative; offer Fisher as an option. Within subjects: McNemar exact.
- Task times are log-transformed before t-tests: Welch between subjects, paired within subjects. Report the geometric mean (n < ~25), or the median for larger n.
- SUS, SEQ and UMUX: t-based CIs and a two-sample t-test.
- Default to 90% CIs for formative work and 95% for summative work. Show effect sizes, the n per variant, and an "underpowered" warning.
- Within-subject A/B designs must counterbalance order.

## 4. Ethics and consent

- Informed consent before any capture:
  - purpose, procedure, duration, data collected, retention period, who sees it, and contact details;
  - participation is voluntary, and the participant can stop at any time without penalty while still being paid;
  - data deletion on request.
- Separate, granular opt-ins for microphone/voice, screen/DOM recording, webcam/eye tracking and use of quotes. Show a visible recording indicator and a one-click way to withdraw that deletes the data.
- Disclose clearly that the moderator is an AI, as required by EU AI Act Art. 50. Say which processors handle the data (OpenAI) and their retention terms.
- Data minimization:
  - mask all inputs by default;
  - no keystroke capture in password, payment or email fields;
  - redact PII in transcripts (names, emails, phone numbers);
  - pseudonymous participant IDs;
  - configurable retention and auto-delete.
- GDPR: a lawful basis, a DPA with processors, and EU hosting as an option. Webcam images can be biometric data, so process gaze on the device and don't store raw video unless the participant opts in.
- Academic users need IRB or ethics-board approval. Provide exportable consent records (timestamp and version), an age gate (18+), and editable consent templates.

## 5. Technical gotchas

**WebGazer:**
- Accuracy is about 4° visual angle, roughly 100–200 px, and it drifts with head movement and lighting. Use it for area-of-interest (AOI) or region-level heatmaps, not word-level fixations.
- Calibration: 9+ click points plus validation points. Report the validation error and re-calibrate between tasks.
- Needs HTTPS (or localhost), camera permission and good lighting. It is CPU-heavy and can fight with the realtime audio session, so throttle it.
- It runs in the parent page. Gaze coordinates must be mapped into the iframe's viewport and scroll offset, so log iframe scroll position.
- License: GPLv3 (commercial licensing via Brown). Check this before commercial use.

**rrweb:**
- It cannot record into cross-origin iframes. Either serve the uploaded build same-origin (on its own sandboxed subdomain with the recorder injected), or inject rrweb into the build and set `recordCrossOriginIframes: true` in both parent and child.
- Use `maskAllInputs: true`, `maskTextSelector`, and the `.rr-block` / `.rr-mask` classes.
- Canvas and WebGL aren't recorded unless `recordCanvas` is set, which is expensive and matters for some Expo-web apps.
- Capture console and network errors with the plugins. Recordings get large, so chunk and compress uploads.
- Sync rrweb, audio and gaze to a single clock (`performance.now()` plus a server offset).

**Iframe:**
- The `sandbox` attribute needs `allow-scripts allow-same-origin`, which defeats isolation on the same origin, so a separate origin is still needed for security. Hence the injection approach.
- Some apps set `X-Frame-Options` and break when framed.

Sources (Sauro & Lewis is cited from memory, not looked up in this pass):
- [Outset AI-moderated interviews](https://outset.ai/interviews)
- [Outset platform](https://outset.ai/platform)
- [Maze AI-moderated interviews](https://maze.co/features/ai-moderated-interviews)
- [Towards AI – Top AI UX tools 2026](https://pub.towardsai.net/top-5-ai-tools-for-ux-research-in-2026-a2e4dad62963)
- [Listen Labs screensharing docs](https://docs.listenlabs.ai/setup-to-launch/desktop-and-mobile-screensharing)
- [Hubble – best AI-moderated tools](https://www.usehubble.io/blog/best-ai-moderated-tools)