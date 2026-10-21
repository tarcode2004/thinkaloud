import { Link } from 'react-router';
import { ChevronRight } from 'lucide-react';
import { Logo } from './components/index.tsx';

const card = 'rounded-[22px] bg-white shadow-[0_1px_2px_rgba(0,0,0,.04),0_12px_40px_rgba(0,0,0,.06)] ring-1 ring-black/[0.04]';

export default function Landing() {
  return (
    <div className="min-h-full bg-white text-label">
      <header className="material sticky top-0 z-30 border-b">
        <div className="mx-auto flex h-12 max-w-[980px] items-center justify-between px-6">
          <Logo />
          <nav className="flex items-center gap-6 text-[13px] text-secondary">
            <a href="#moderator" className="hidden hover:text-label sm:inline">Moderator</a>
            <a href="#protocol" className="hidden hover:text-label sm:inline">Protocols</a>
            <a href="#results" className="hidden hover:text-label sm:inline">Results</a>
            <Link to="/login" className="hover:text-label">Sign in</Link>
            <Link to="/signup" className="rounded-full bg-brand-500 px-3 py-1 text-[12px] font-medium text-white hover:bg-brand-600">Get started</Link>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="bg-canvas px-6 pb-24 pt-20 text-center sm:pt-28">
        <p className="text-[17px] font-semibold text-secondary sm:text-[21px]">ThinkAloud</p>
        <h1 className="mx-auto mt-2 max-w-[900px] text-[48px] font-semibold leading-[1.05] tracking-[-0.03em] sm:text-[80px]">
          The usability lab
          <br />
          that runs itself.
        </h1>
        <p className="mx-auto mt-6 max-w-[640px] text-[19px] leading-relaxed text-secondary sm:text-[21px]">
          Upload your app. Write a protocol. An AI moderator talks every participant through a think-aloud session, then you get replays, task metrics and findings with sources.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-6">
          <Link to="/signup" className="rounded-full bg-brand-500 px-6 py-3 text-[17px] font-medium text-white transition-colors duration-200 hover:bg-brand-600">Start a study</Link>
          <a href="#moderator" className="inline-flex items-center text-[17px] text-brand-500 hover:underline">See how it works <ChevronRight className="size-4" /></a>
        </div>
        <div className="mx-auto mt-16 max-w-[1080px]">
          <SessionMock />
        </div>
      </section>

      {/* Moderator */}
      <section id="moderator" className="bg-black px-6 py-28 text-white">
        <div className="mx-auto max-w-[980px]">
          <p className="text-[17px] font-semibold text-white/50">Voice moderator</p>
          <h2 className="mt-2 max-w-[760px] text-[40px] font-semibold leading-[1.08] tracking-[-0.025em] sm:text-[56px]">Neutral. Patient. Every session, the same.</h2>
          <p className="mt-6 max-w-[620px] text-[19px] leading-relaxed text-white/60">
            It speaks in real time and lets participants interrupt. If someone goes quiet it gives a neutral prompt to keep talking. It never hints and never confirms an answer. Follow-up questions wait until the task is over, so task times aren’t affected.
          </p>
          <div className="mt-16 grid items-center gap-12 md:grid-cols-[280px_1fr]">
            <div className="relative mx-auto size-56">
              <div className="absolute inset-0 rounded-full bg-[radial-gradient(circle_at_40%_35%,rgba(255,255,255,0.9),rgba(160,200,255,0.35)_45%,rgba(80,140,220,0.08)_70%,transparent_72%)] blur-[2px]" style={{ animation: 'ta-pulse 3.2s ease-in-out infinite' }} />
              <div className="absolute inset-6 rounded-full bg-[radial-gradient(circle_at_45%_40%,rgba(255,255,255,0.65),transparent_60%)]" />
            </div>
            <div className="space-y-6">
              <p className="text-[22px] leading-snug text-white/40 sm:text-[26px]">“Imagine you want to send a friend a gift under $50. Go ahead whenever you’re ready.”</p>
              <p className="text-[22px] leading-snug text-white/40 sm:text-[26px]">“Hmm, I expected a price filter up here.”</p>
              <p className="text-[22px] leading-snug text-white sm:text-[28px]">“You said you expected a filter. Where would you look for it next?”</p>
            </div>
          </div>
          <div className="mt-20 grid gap-10 border-t border-white/15 pt-10 sm:grid-cols-3">
            {[
              ['40+ languages', 'Speaks and transcribes in the participant’s language.'],
              ['Reacts to behaviour', 'Notices backtracking and repeated clicks, and asks about them after the task.'],
              ['Guardrails you set', 'Persona, probe depth, silence timing and your own rules.'],
            ].map(([t, d]) => (
              <div key={t}>
                <div className="text-[17px] font-semibold">{t}</div>
                <p className="mt-1 text-[15px] leading-relaxed text-white/55">{d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Protocol */}
      <section id="protocol" className="bg-white px-6 py-28">
        <div className="mx-auto grid max-w-[1080px] items-center gap-14 md:grid-cols-[1fr_1.15fr]">
          <div>
            <p className="text-[17px] font-semibold text-secondary">Protocols</p>
            <h2 className="mt-2 text-[40px] font-semibold leading-[1.08] tracking-[-0.025em] sm:text-[48px]">Write it once. Run it a hundred times.</h2>
            <p className="mt-5 text-[17px] leading-relaxed text-secondary">
              Tasks with hidden success criteria, follow-up questions, interviews and standard questionnaires: SUS, SEQ, UMUX-Lite, NASA-TLX and NPS. Success can be detected automatically from URLs, on-screen text, clicks or your own events.
            </p>
            <p className="mt-4 text-[17px] leading-relaxed text-secondary">
              Write it yourself or describe your goals and let AI write a draft. Then run a methodology check, which flags leading wording and tasks that give away the answer.
            </p>
          </div>
          <TaskMock />
        </div>
      </section>

      {/* Apps */}
      <section className="bg-canvas px-6 py-28">
        <div className="mx-auto max-w-[980px] text-center">
          <h2 className="text-[40px] font-semibold leading-[1.08] tracking-[-0.025em] sm:text-[56px]">Test what you’re building.</h2>
          <p className="mx-auto mt-5 max-w-[640px] text-[19px] leading-relaxed text-secondary">
            Upload a .zip, connect a git repo or paste a URL. We build it, host it on its own isolated domain and add recording automatically. No SDK needed.
          </p>
          <div className={`${card} mx-auto mt-12 max-w-[720px] text-left`}>
            {[
              ['checkout-v2.zip', 'Vite', 'Ready', 'bg-sys-green'],
              ['github.com/acme/mobile', 'Expo web', 'Building', 'bg-sys-orange'],
              ['staging.acme.com', 'Website · proxied', 'Ready', 'bg-sys-green'],
            ].map(([n, f, s, dot], i) => (
              <div key={n} className={`flex items-center gap-4 px-5 py-4 ${i ? 'border-t border-separator' : ''}`}>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[15px] font-medium">{n}</div>
                  <div className="text-[13px] text-secondary">{f}</div>
                </div>
                <span className="inline-flex items-center gap-1.5 text-[13px] text-secondary"><span className={`size-2 rounded-full ${dot}`} />{s}</span>
              </div>
            ))}
          </div>
          <p className="mt-6 text-[13px] text-tertiary">Vite · Create React App · Next.js static export · Expo and React Native for web · static sites</p>
        </div>
      </section>

      {/* Results */}
      <section id="results" className="bg-white px-6 py-28">
        <div className="mx-auto grid max-w-[1080px] items-center gap-14 md:grid-cols-[1.15fr_1fr]">
          <ResultsMock />
          <div>
            <p className="text-[17px] font-semibold text-secondary">Results</p>
            <h2 className="mt-2 text-[40px] font-semibold leading-[1.08] tracking-[-0.025em] sm:text-[48px]">Every finding links to its source.</h2>
            <p className="mt-5 text-[17px] leading-relaxed text-secondary">
              Screen replay, voice and transcript play in sync. Task success, time on task and SUS come with confidence intervals suited to small samples. A/B variants are compared with the right test for each metric.
            </p>
            <p className="mt-4 text-[17px] leading-relaxed text-secondary">AI synthesis groups the issues and rates their severity. Every quote is checked against the transcript and links to the exact moment.</p>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="bg-canvas px-6 py-28 text-center">
        <h2 className="text-[40px] font-semibold tracking-[-0.025em] sm:text-[56px]">Run your first study today.</h2>
        <p className="mx-auto mt-4 max-w-[560px] text-[19px] text-secondary">Every new study comes with a starter protocol: a warm-up, two tasks, SUS and a short interview.</p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-6">
          <Link to="/signup" className="rounded-full bg-brand-500 px-6 py-3 text-[17px] font-medium text-white hover:bg-brand-600">Create an account</Link>
          <Link to="/login" className="inline-flex items-center text-[17px] text-brand-500 hover:underline">Sign in <ChevronRight className="size-4" /></Link>
        </div>
      </section>

      <footer className="border-t border-separator bg-canvas px-6 py-8">
        <div className="mx-auto flex max-w-[980px] flex-wrap justify-between gap-4 text-[12px] text-tertiary">
          <span>ThinkAloud</span>
          <span>Uploaded apps run on an isolated domain. Participants can withdraw and delete their data at any time.</span>
        </div>
      </footer>
    </div>
  );
}

/** A faithful mini rendering of the participant session UI. */
function SessionMock() {
  return (
    <div className={`${card} overflow-hidden text-left`}>
      <div className="flex items-center gap-2 border-b border-separator bg-[#fbfbfd] px-4 py-2.5">
        <span className="size-3 rounded-full bg-[#ff5f57]" />
        <span className="size-3 rounded-full bg-[#febc2e]" />
        <span className="size-3 rounded-full bg-[#28c840]" />
        <span className="mx-auto rounded-md bg-black/[0.04] px-16 py-0.5 text-[12px] text-tertiary">thinkaloud.app/s/k7q2</span>
      </div>
      <div className="grid md:grid-cols-[1fr_320px]">
        <div className="border-r border-separator bg-white p-8">
          <div className="flex items-center justify-between">
            <span className="text-[15px] font-semibold">Leafly</span>
            <div className="flex gap-5 text-[12px] text-secondary"><span>Plants</span><span>Pots</span><span>Care</span><span>Cart</span></div>
          </div>
          <div className="mt-8 text-[28px] font-semibold tracking-[-0.02em]">Low-light plants</div>
          <div className="mt-6 grid grid-cols-3 gap-4">
            {[['Snake plant', '$34'], ['ZZ plant', '$42'], ['Pothos', '$18']].map(([n, p], i) => (
              <div key={n} className="relative">
                <div className="aspect-[4/5] rounded-[14px] bg-[#f2f2f4]" />
                <div className="mt-2 text-[13px] font-medium">{n}</div>
                <div className="text-[12px] text-secondary">{p}</div>
                {i === 1 && <span className="absolute left-1/2 top-1/3 size-6 -translate-x-1/2 rounded-full border-2 border-brand-500/70 bg-brand-500/15" />}
              </div>
            ))}
          </div>
        </div>
        <div className="flex flex-col bg-[#fbfbfd] p-6">
          <div className="text-[12px] font-medium text-tertiary">Task 2 of 3</div>
          <p className="mt-1 text-[15px] leading-relaxed">Imagine you want to send a friend a gift under $50. Go ahead whenever you’re ready.</p>
          <div className="mt-auto pt-10">
            <div className="mx-auto size-16 rounded-full bg-[radial-gradient(circle_at_40%_35%,#fff,rgba(0,113,227,0.25)_55%,rgba(0,113,227,0.05)_72%)] shadow-[0_0_40px_rgba(0,113,227,0.18)]" />
            <p className="mt-5 text-center text-[13px] text-tertiary">“I’d expect a price filter up here…”</p>
            <p className="mt-1.5 text-center text-[17px] leading-snug">Where would you look for it next?</p>
            <div className="mt-6 flex justify-center gap-2 text-[12px]">
              <span className="rounded-full bg-black/[0.05] px-3 py-1 text-secondary">Skip task</span>
              <span className="rounded-full bg-black/[0.05] px-3 py-1 text-secondary">I’m done</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TaskMock() {
  return (
    <div className={`${card} p-6`}>
      <div className="text-[12px] text-tertiary">Step 3 of 7 · Task</div>
      <div className="mt-0.5 text-[20px] font-semibold tracking-[-0.015em]">Buy a gift under $50</div>
      <div className="mt-5 text-[13px] font-medium text-secondary">Task instruction · read aloud</div>
      <div className="mt-1.5 rounded-[10px] border border-black/10 px-3 py-2 text-[14px] leading-relaxed">Imagine your friend’s birthday is next week and you want to send them a gift under $50. Use the site to find something you’d buy.</div>
      <div className="mt-5 text-[13px] font-medium text-secondary">Success, hidden from participants</div>
      <div className="mt-1.5 overflow-hidden rounded-[12px] bg-canvas">
        {[['URL matches', '^/cart'], ['Text visible', 'Added to cart']].map(([k, v], i) => (
          <div key={k} className={`flex items-center justify-between px-3 py-2.5 text-[13px] ${i ? 'border-t border-separator' : ''}`}>
            <span>{k}</span>
            <span className="font-mono text-[12px] text-secondary">{v}</span>
          </div>
        ))}
      </div>
      <div className="mt-5 overflow-hidden rounded-[12px] bg-canvas">
        {[['Ask the Single Ease Question', true], ['Probe on behaviour', true]].map(([k], i) => (
          <div key={k as string} className={`flex items-center justify-between px-3 py-2.5 text-[13px] ${i ? 'border-t border-separator' : ''}`}>
            <span>{k}</span>
            <span className="relative inline-flex h-[22px] w-[38px] rounded-full bg-sys-green"><span className="absolute right-[2px] top-[2px] size-[18px] rounded-full bg-white shadow" /></span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ResultsMock() {
  const rows = [
    { t: 'Find a low-light plant', a: 0.86, b: 0.91 },
    { t: 'Buy a gift under $50', a: 0.48, b: 0.79 },
    { t: 'Change delivery date', a: 0.62, b: 0.66 },
  ];
  return (
    <div className={`${card} p-6`}>
      <div className="flex items-baseline justify-between">
        <div className="text-[17px] font-semibold tracking-[-0.01em]">Task success</div>
        <div className="flex gap-4 text-[12px] text-secondary">
          <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-[#c7c7cc]" />A · current</span>
          <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-brand-500" />B · one-page</span>
        </div>
      </div>
      <div className="mt-5 space-y-5">
        {rows.map((r) => (
          <div key={r.t}>
            <div className="flex justify-between text-[13px]"><span>{r.t}</span><span className="tabular-nums text-secondary">{Math.round(r.a * 100)}% → <span className="font-medium text-label">{Math.round(r.b * 100)}%</span></span></div>
            <div className="mt-1.5 space-y-1">
              <div className="h-1.5 rounded-full bg-fill"><div className="h-full rounded-full bg-[#c7c7cc]" style={{ width: `${r.a * 100}%` }} /></div>
              <div className="h-1.5 rounded-full bg-fill"><div className="h-full rounded-full bg-brand-500" style={{ width: `${r.b * 100}%` }} /></div>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-6 grid grid-cols-3 border-t border-separator pt-5">
        {[['SUS', '74.2', '±6.1'], ['Median time', '1:42', 'task 2'], ['p-value', '0.03', 'N−1 χ²']].map(([l, v, s]) => (
          <div key={l}>
            <div className="text-[12px] text-secondary">{l}</div>
            <div className="text-[22px] font-semibold tabular-nums tracking-[-0.02em]">{v}</div>
            <div className="text-[11px] text-tertiary">{s}</div>
          </div>
        ))}
      </div>
      <div className="mt-5 rounded-[12px] bg-canvas p-3.5 text-[13px] leading-relaxed">
        <div className="font-medium">Price filter is hard to find</div>
        <div className="mt-0.5 text-secondary">7 of 12 participants looked for it above the grid. “I expected a price filter up here.” <span className="text-brand-500">P‑7K2Q · 03:12</span></div>
      </div>
    </div>
  );
}
