# Redesign spec — remaining work (steps 4–7 + cleanup)

Handoff doc for a fresh session. The design-system layer (steps 1–3) is **done and shipped**;
this spec covers the per-screen redesign work that builds on it.

> **Status (archived 2026-06-19):** Steps 4–6 and the `fontSize` cleanup are **shipped**.
> The only remaining item is **Step 7's login brand treatment** (goose motif / textured
> backdrop) — the login page is otherwise on the design system. Kept for reference.

## Context

**App:** "Be The Goose" — a single-artist business agent (weekly post plan, engagement
tracking, insights, products/markets CRUD, settings).
**Stack:** Next.js 16 (App Router, Turbopack) + React 19, Supabase auth, Drizzle/Postgres.
**Styling:** vanilla CSS in a single file — `app/globals.css`. **No Tailwind, no component
library.** Do not introduce either. Fonts are loaded via `next/font` in `app/layout.tsx`
(Fraunces display + Hanken Grotesk body).

### Hard rules
- Work within the existing vanilla-CSS stack. No framework/library migrations, no new deps
  unless a step explicitly calls for one (none should).
- Reuse the design tokens and utility classes below — **do not** reintroduce hardcoded
  colors or inline `fontSize`. Add new shared classes to `globals.css` rather than inline styles.
- Don't break functionality. Server actions, data fetching, and form behavior must keep working.
- After each step: `npx tsc --noEmit` and `npm run build` must both be green (the build fetches
  Google fonts over the network — needs connectivity).
- Keep copy as-is unless a step says otherwise; it's deliberately plain and good (active voice,
  no AI clichés). Don't add exclamation marks or "Oops!"-style messages.

### What's already done (steps 1–3 — don't redo)
1. **Fonts + type scale** — Fraunces/Hanken via `next/font`; `h1/h2/h3` styled with the display
   font, tightened tracking/leading, `clamp()` h1, `text-wrap: balance/pretty`. Utility classes
   `.meta`, `.text-sm`, `.text-xs`, `.tabular` added; the repeated `muted + fontSize:13`
   metadata-line pattern was swept to `.meta`.
2. **Color tokens** — single `--accent` (terracotta), one `--ok` green (used for success text
   AND the sparkline), one distinct `--danger` red (errors no longer share the accent hue).
   Warm-tinted card shadows. `.banner.warn` added and wired to the over-budget banner.
3. **Interaction states** — hover/active/`:focus-visible` rings + transitions on `.btn`,
   `.nav a`, `.field`, links; `prefers-reduced-motion` guard. Login page moved onto `.field`/`.btn`.

---

## Design-system reference (already in `app/globals.css`)

Use these. Don't invent parallel ones.

**Color tokens:** `--bg #fafaf7`, `--fg #1f1d1a`, `--muted #6b6660`, `--border #e4e0d8`,
`--card #fff`, `--accent #b4612f`, `--accent-hover #9a4f24`, `--ok #3f7d4f`,
`--danger #b23b3b`, `--danger-tint #fbeceb`.

**Type tokens:** `--font-sans`, `--font-display`; sizes `--fs-xs` 12, `--fs-sm` 13,
`--fs-md` 14, `--fs-base` 16.

**Surface/motion tokens:** `--radius-sm` 6, `--radius` 10, `--radius-lg` 14, `--shadow-sm`,
`--shadow`, `--ring` (focus), `--ease`, `--t-fast` 120ms, `--t` 180ms.

**Utility/component classes:** `.container`, `.topbar`/`.topbar-inner`, `.nav` (+ `.active`),
`.banner` (+ `.info`, `.warn`), `.card` (nested cards auto-drop their shadow), `.btn`
(+ `.btn-primary`), `.field`, `.row`, `.muted`, `.meta`, `.text-sm`, `.text-xs`, `.tabular`,
`.ok`, `.err`, `pre.checklist`.

When a step needs a new reusable visual (chips, grids, data-table, charts), **add a named class
to `globals.css`** following these token conventions.

---

## Step 4 — Calendar → a real weekly layout (highest visual payoff)

**Files:** `app/(app)/calendar/page.tsx`, `app/(app)/_components/SlotCard.tsx`.

**Now:** the page fetches `getCalendarWeek(weekStartIso)` and renders a flat vertical stack of
identical `SlotCard`s. Each card shows a `.meta` line (`slotDate · slotTime · format · priority`)
then theme + idea. It does not read as a week — no day structure, no today marker, empty days
invisible, priority/format are plain text.

Slot fields available (`SlotCardData`): `id, slotDate (ISO), slotTime (HH:MM|null),
format ('static'|'carousel'|'reel'|'story'|null), theme, contentIdea, priority (1|2|null)`.
`priority === 1` = "must-post", else "nice to have". Format labels live in
`app/(app)/_lib/format.ts` (`FORMAT_BADGE`, `badge()`).

**Target:**
- Group slots by day across **Mon→Sun**. Render all 7 days, including empty ones (empty day =
  a muted "—" / "no post planned" rest-row, so the week reads as a grid/timeline).
- Mark **today** distinctly (the page already computes `isThisWeek` and has `todayIso()` from
  `@/lib/db`); de-emphasize past days within the current week.
- Turn `format` into a **colored tag/chip** (one tint per format) and `priority` into a chip
  (filled accent "must-post" vs outline "nice to have") — not text in a `.meta` line.
- Keep it responsive: a 7-row day list on mobile; consider a 7-column or 2-up grid ≥ ~720px
  via CSS Grid. Prefer `min-height`, not fixed heights.

**Implementation notes:**
- Add `.cal-week` (grid), `.cal-day` (day cell w/ date header + today/past modifiers), and a
  reusable `.chip` family (see Step 5 — chips are shared) to `globals.css`.
- Group in the page component (`Map` keyed by `slotDate`), iterate Mon..Sun from `monday`.
- `SlotCard` keeps carrying no actions (posting is off-app) — it's display only.

**Acceptance:** the screen visually reads as a 7-day week with today highlighted, empty days
shown, and format/priority as chips. No inline `fontSize`. Build green.

---

## Step 5 — Products & Markets → read rows + inline edit, status/active chips

**Files:** `app/(app)/products/page.tsx`, `app/(app)/markets/page.tsx`,
`app/(app)/_components/ProductForm.tsx`, `app/(app)/_components/MarketForm.tsx`.

**Now (structural problem):** each list renders the **full editable `ProductForm`/`MarketForm`**
once per row, so the "list" is a stack of open input forms. You can't scan your catalog, and the
"Add" form is visually identical to existing rows (only the button label differs). Active/inactive
products look the same; market status is a bare dropdown value with no color.

Fields — Product: `id, name, url, type ('print'|'sticker'|'craft'|'snail_mail'), active (bool),
lastPromotedAt`. Market: `id, name, location, eventDate, applicationDeadline, status
('considering'|'applied'|'accepted'|'rejected'|'attended'|null), notes, draftApplication`.
Labels: `PRODUCT_TYPES`, `MARKET_STATUSES`, plus `TYPE_LABELS`/`STATUS_LABELS` in the form files.
Server actions used: `createProduct`/`updateProductAction`; `createMarket`/`updateMarketAction`/
`deleteMarketAction` (all in `app/actions.ts`).

**Target:**
- Keep one **"Add" form** at the top, visually distinct (e.g. a card with a clear "Add product/
  market" heading).
- Render existing items as **compact read rows**: name + key fields + a status/type chip +
  active state, with an **Edit** affordance that expands the existing form inline (toggle), and
  collapses on save. Don't open every row by default.
- **Inactive products:** dim the row + an "inactive" chip (don't just rely on a checkbox).
- **Market status:** a colored **status chip** (considering/applied/accepted/rejected/attended),
  not just the dropdown text. Keep the agent-drafted blurb in its `<details>`.
- Keep `deleteMarketAction`; the native `confirm()` is acceptable for now (an inline confirm is a
  nice-to-have, not required).

**Implementation notes:**
- Add a shared **chip system** to `globals.css`: `.chip` base + variants
  (`.chip-accent`, `.chip-ok`, `.chip-muted`, `.chip-danger`, and per-format/per-status tints).
  Reuse these in Step 4 and Step 6.
- Suggested refactor: a small `ProductRow`/`MarketRow` client component that shows the read view
  and renders the existing `ProductForm`/`MarketForm` when `editing`. This keeps all the
  validated form logic intact — you're only adding a read view + toggle around it.
- Don't change server actions or validation.

**Acceptance:** lists are scannable read rows; add vs edit are visually distinct; inactive
products and market statuses are chips; existing create/update/delete still work. Build green.

---

## Step 6 — Insights → dashboard grid + chart polish

**File:** `app/(app)/insights/page.tsx` (contains the inline `Sparkline` component + `CTA_LABEL`).

**Now:** a monotonous vertical stack of `.card` sections — by-format (inline-styled `<table>`),
by-weekday (a `.row` of nested `.card` tiles), follower `Sparkline` (now `var(--ok)`, no fill/
dots), top posts, reuse-hits, subscriber attribution table. Numbers aren't tabular.

**Target:**
- Lay the sections into a **2-column dashboard grid** on wide screens (this is the one screen
  where a grid is right — it's data-dense, not marketing). Single column on mobile.
- **By-format table:** add a `.data-table` class (replace inline `<th>/<td>` styles), apply
  `.tabular` to numeric columns, and add a tiny in-cell bar for the score column (a div whose
  width is `score/maxScore`).
- **By-weekday:** replace the nested-card row with a clean **horizontal bar chart** (one bar per
  weekday, width ∝ avgScore), highlighting the top day.
- **Sparkline:** add an area fill (low-opacity `--ok`), an endpoint dot, and emphasize the
  current value. Keep it SSR-only (no client JS) as it is today.
- Apply `.tabular` to the metric figures in top-posts and the subscriber table.

**Implementation notes:**
- Add `.insights-grid`, `.data-table`, `.bar`/`.bar-track`/`.bar-fill` to `globals.css`.
- Keep all the existing `@/lib/db` queries and the score formula copy unchanged.

**Acceptance:** insights reads as a dashboard (2-col on desktop), tables/charts use shared
classes + tabular figures, sparkline has fill + endpoint. Build green.

---

## Step 7 — Settings grouping, banner hierarchy, login brand treatment

**Files:** `app/(app)/settings/page.tsx`, `app/(app)/_components/SettingsForm.tsx`,
`app/(app)/_components/BrandVoiceForm.tsx`, `app/(app)/layout.tsx`, `app/(auth)/login/page.tsx`.

**Settings form:** currently one long form — a wall of `.row`s of tiny number inputs with no
internal grouping, and it opens with a redundant `<strong>⚙️ Settings</strong>` directly under
the page `<h1>⚙️ Settings`.
- Group fields into labeled sections (use `<fieldset>` + `<legend>` or `<section>` + `<h3>`):
  **Scheduling** (timezone, default post time), **Format mix** (reels/carousels/static +
  reels-required), **Budget & research** (web-search cadence, monthly budget), **Shop** (shop URL),
  plus the caption-starters toggle. Remove the duplicate inner heading.
- BrandVoice and InstagramConnect already read fine — just ensure consistent section spacing.

**Banner hierarchy** (`app/(app)/layout.tsx`): the over-budget `.banner.warn` is already wired
(done in step 2). Remaining polish: give the three banner types (spend/warn, engagement nudge,
market deadline) clearer visual hierarchy and consistent icon treatment, and consider collapsing
multiple market-deadline banners into one stacked alert. Optional: a dismiss affordance.

**Login brand treatment** (`app/(auth)/login/page.tsx`): now uses `.field`/`.btn` but is visually
plain. Add brand presence — a warm textured/illustrated backdrop or the goose motif, so the first
screen feels like the product. Keep the 16px email input (iOS no-zoom) and the magic-link flow.

**Acceptance:** settings is grouped into scannable sections with no duplicate heading; banners
have clear info/warn hierarchy; login has brand presence. Build green.

---

## Cleanup — finish the inline-`fontSize` migration

Steps 1–3 swept the bare `muted + fontSize` metadata pattern, but ~9 files still have inline
`fontSize` where it's **combined with a margin/layout prop** (e.g. `style={{ fontSize: 13,
marginTop: 4 }}`), left to keep that diff reviewable:

`insights/page.tsx`, `engagement/page.tsx`, `BrandVoiceForm.tsx`, `ReuseHitsButton.tsx`,
`ProductForm.tsx`, `SettingsForm.tsx`, `NumbersForm.tsx`, `SubscriberForm.tsx`,
`login/page.tsx` (the login 16px is intentional — leave it).

**Do:** replace the `fontSize` part with the matching utility class (`.text-xs`/`.text-sm`/
`.meta`) and keep the remaining layout props inline, OR add small spacing utilities
(`--space-*` tokens already exist conceptually — add `.mt-1`/`.mb-0` etc. only if it genuinely
reduces churn). Verify with:
`grep -rn --include="*.tsx" "fontSize" app/` (should reduce to just the intentional login case).

---

## Suggested order & verification

Recommended order (visual payoff, low → high coupling): **4 → 5 → 6 → 7 → cleanup.**
The chip system (added in step 4/5) and grid/data-table classes (step 6) are shared — add them to
`globals.css` once and reuse.

Per-step gate:
```
npx tsc --noEmit      # must be clean
npm run build         # must be green (fetches fonts over network)
```
Then run `npm run dev` and eyeball each redesigned screen before moving on.
