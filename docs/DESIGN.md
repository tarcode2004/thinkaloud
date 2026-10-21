# ThinkAloud design language — Apple HIG / WWDC style

The goal: it should feel like a first-party Apple app or a WWDC session slide — calm, precise, confident. Not "AI slop".

## Hard bans (AI-slop tells)
- No purple→pink / blue→purple gradients, glowing blobs, "aurora" backgrounds, gradient text.
- No ✨ sparkles, emoji in UI, "Supercharge / Unlock / Seamless / Revolutionize" copy.
- No generic hero + 3 feature cards with icons in colored circles. No icon-in-a-tinted-square on every row.
- No heavy drop shadows, no neon borders, no badges everywhere, no ALL-CAPS tracking-wide labels sprinkled around.
- No centered-everything layouts; no placeholder lorem; no fake testimonials/logos.

## Typography (the most important part)
- Font stack: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Inter", system-ui, sans-serif` (Tailwind `font-sans` is set to this).
- Large titles: `text-[34px] font-bold tracking-[-0.022em] leading-tight` (page titles). Hero/marketing: 56–80px, `font-semibold tracking-[-0.03em]`.
- Section headers: `text-[22px] font-semibold tracking-[-0.015em]`. Body: 15–17px, `text-label` / `text-secondary`.
- Captions/footnotes: 12–13px `text-tertiary`. Sentence case everywhere. Numbers: `tabular-nums`.
- Hierarchy comes from size + weight + grey levels, not color.

## Color (semantic tokens in web/src/index.css)
- Accent = system blue `brand-500 #0071e3` (apple.com link/action blue), used sparingly: primary actions, links, selection, focus.
- Labels: `text-label` (#1d1d1f), `text-secondary` (#6e6e73), `text-tertiary` (#86868b). Separators: `border-separator` (hairline rgba(0,0,0,.08)).
- Backgrounds: page `bg-canvas` (#f5f5f7), grouped content on white `bg-surface`; secondary fill `bg-fill` (#f0f0f2).
- Status uses system colors: green #34c759, orange #ff9f0a, red #ff3b30, yellow #ffcc00, teal #30b0c7 — as small dots/text, not big tinted panels.
- Charts: blue, teal, green, orange, indigo (#5856d6), pink (#ff2d55) — flat fills, no gradients.

## Shape, materials, depth
- Continuous corners: controls `rounded-full` (pill buttons) or `rounded-[10px]`; cards/panels `rounded-[18px]`–`rounded-[22px]`; sheets `rounded-[28px]`.
- Cards: white, hairline border OR very soft shadow (`shadow-[0_1px_2px_rgba(0,0,0,.04),0_4px_16px_rgba(0,0,0,.04)]`), never both heavy.
- Menus, popovers, dropdowns and sheets are OPAQUE (`bg-white` / `bg-surface`) with a soft shadow — never translucent; text underneath must not show through.
- Materials: toolbars, sidebars, floating docks use translucent blur — `bg-white/72 backdrop-blur-xl backdrop-saturate-180` + hairline border. Dark contexts: `bg-black/55 backdrop-blur-2xl`.
- Grouped inset lists (iOS Settings style) for settings/forms: rows separated by inset hairlines, label left, control right.
- Segmented controls instead of tabs where there are 2–5 options.

## Layout
- Generous whitespace: page padding 32–48px, section gaps 40px+, max content width ~1120px (marketing ~980px like apple.com).
- Left sidebar like macOS (translucent, 240px, SF-style 13px rows, selected row = `bg-black/5` rounded). Content area calm on `bg-canvas`.
- Align to a 4/8px grid. Left-aligned text in app UI; centered only for hero/empty states.

## Motion
- Subtle, purposeful: 200–350ms, easing `cubic-bezier(0.32, 0.72, 0, 1)` (iOS sheet) or spring-like. Fade+scale(0.98→1) for sheets; no bouncing gimmicks.
- Respect `prefers-reduced-motion`.

## Icons
- lucide-react with `strokeWidth={1.75}`, size 16–18 in rows, 20–22 in toolbars. Monochrome (inherit text color). Like SF Symbols.

## Voice orb (participant)
- Think Siri / Apple Intelligence restraint: a soft, mostly monochrome sphere with gentle glow driven by real audio levels; one hue (system blue → teal) at low saturation, on near-black or near-white backgrounds. Captions in SF-style 22–28px, secondary grey for the moderator's previous line.

## Copy
- Plain, specific, human. "Upload a build", "Share link", "Sessions", "Task success". Short.
