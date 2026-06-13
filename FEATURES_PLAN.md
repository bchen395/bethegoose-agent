# FEATURES_PLAN.md — implementation plan + progress

Implementation plan for the post-migration feature work in `FEATURES.md`, plus a
live status tracker. `FEATURES.md` is the source of truth for *what* and *why*;
this file records *how it's being built* and *what's done*.

> **Why a separate file from `PROGRESS.md`.** `PROGRESS.md` tracks the original
> SPEC build / migration on the old terms. The features here layer on the hosted
> TypeScript stack, so they get their own tracker to avoid muddying that history.

> **Path reconciliation.** `FEATURES.md` says `lib/db.ts`; the real module is
> `lib/db/index.ts` (imported as `@/lib/db`). It says "panel on `/engagement`" and
> `/insights` — both used. `getSettings` exists; `updateSettings` is added when §6
> needs it (not in this batch).

---

## Status at a glance

| # | Feature | API cost | Status |
|---|---------|----------|--------|
| 1 | Schema deltas | — | ✅ Done (folded into migration Step 1: `schema.ts`, `seed.ts`) |
| 2 | "What's working" insights | $0 | ✅ Built — build green; functional verify pending live DB |
| 3 | Engagement-entry friction + `shares` | $0 | ✅ Built — build green; functional verify pending live DB |
| 4 | Subscriber attribution | $0 | ✅ Built — build green; functional verify pending live DB |
| 5 | Content-mix targets (reel weighting) | $0 extra | ✅ Built — build green; functional verify pending live DB + API key |
| 6 | Right-size web search | − | ✅ Built — build green; functional verify pending live DB |
| 7 | Cost meter | negligible | ✅ Built — build green; functional verify pending live DB + API key |
| 8 | "Reuse your hits" (Haiku, on-demand) | bounded | ✅ Built — build green; functional verify pending live DB + API key |
| 9 | Caption starters (flagged, default off) | bounded | ✅ Built (default off) — build green; functional verify pending |

**Batch 1 = the $0-API high-value set: §2, §3, §4. Batch 2 = the model-touching
and metering features: §5–§9** (built 2026-06-13, in the FEATURES.md sequence
§5 → §6 → §7 → §8 → §9).

---

## Scope decisions (this batch)

- **No new settings UI.** New tunables stay seeded via `scripts/seed.ts` / DB.
- **Score weights, windows live as named constants** in `lib/db/index.ts`
  (principle #5: nothing hardcoded in the model).
- **Verification of §2–§4 needs no API key** — only seeded skewed engagement and a
  hand-written SQL cross-check.

---

## §2 — "What's working" insights ($0) — build first

**Score (constants in `lib/db/index.ts`):**
`score = 3·shares + 2·saves + 1·comments + 0.25·likes`, and when `reach > 0` it's
divided by reach (a saves/shares *rate*, not a raw count — rewards efficient posts,
not just high-reach ones). Nullable metrics `coalesce` to 0.

**db helpers (`lib/db/index.ts`):**
- `getEngagementByFormat(windowDays)` — posted rows grouped by `format`; per format:
  count, avg saves/shares/reach, avg score; ranked by avg score desc.
- `getEngagementByWeekday(windowDays)` — grouped by ISO weekday of `posted_at`
  **computed in `settings.timezone`**; per weekday: count, avg score. (Honest note:
  there is no reliable time-of-day signal — `posted_at` is the "mark posted" click,
  not the IG publish time — so we rank weekday, not hour.)
- `getTopPosts(windowDays, n)` — top N posted rows by score (full row + computed
  `score`); reused by §8.

**UI:** `app/(app)/insights/page.tsx` (RSC) calls these directly — three panels
(format ranking, weekday ranking, top posts w/ art thumbnails). `/insights` added to
`NavLinks.tsx`. No client API, no model call.

_Verify:_ seed posts with reels deliberately out-saving statics; the panels rank
formats/weekdays correctly and match a hand-written SQL query.

## §3 — Engagement-entry friction + `shares` ($0)

- `getPostsMissingEngagement` → require only saves+reach (`isNull(saves) OR isNull(reach)`).
- `NumbersForm.tsx` → saves+reach required; likes/comments/**shares** optional; add a
  `shares` input. Blank optional fields persist as `null`, not `0` (string-backed state).
- `saveNumbers` action + `updateEngagement` helper → accept `shares` + nullable optionals.
- Banner text in `(app)/layout.tsx` → "missing saves or reach".

_Verify:_ a post completes with only saves+reach; banner clears; blank likes/comments
don't re-trigger it.

## §4 — Subscriber attribution ($0)

- `app/actions.ts`: `logSubscriberEvent({ channel, count, sourcePostId?, note? })`.
- `lib/db/index.ts`: `insertSubscriberEvent`, `getSubscribersByCtaType(windowDays)`
  (join `source_post_id → posts.cta_type`, sum counts; null → "unattributed"),
  `getSubscriberTrend(windowDays)` (total, by channel, weekly buckets in tz).
- UI: `SubscriberForm` on `/engagement` (channel toggle, count, optional post picker);
  a subscribers-by-CTA + trend panel on `/insights`.

_Verify:_ log 3 signups attributed to a `snail_mail`-CTA post; the panel credits that
CTA type and the trend updates.

---

## Batch 2 (§5–§9) — built 2026-06-13

As built (the prompt is the real lever; SQL/validation does the rest):

- **§5 content mix:** inject `settings.weekly_mix` into the Strategy prompt/context;
  `mixSummary` post-validates distribution as a *nudge* (never hard-fails), surfaced on
  `WeeklyPlanResult` + `RunPlanButton`.
- **§6 web-search cadence:** `decideWebSearch` gate on `web_search_cadence` (`monthly`
  default, 28-day stamp via new `updateSettings`); `MAX_WEB_SEARCHES` cap unchanged;
  `webSkippedReason` surfaced.
- **§7 cost meter:** `agent` threaded through `callJson`/`webSearch`; one `usage_log` row
  per billed call (catch+ignore); `MODEL_PRICES` pulled live (Sonnet 4.6 $3/$15, Haiku 4.5
  $1/$5 per MTok; web search $10/1k); `getMonthlySpend()` + budget banner.
- **§8 reuse your hits:** `app/api/insights/reuse/route.ts` → one Haiku call over
  `getTopPosts(90)`; `ReuseHitsButton` on `/insights`; nothing persists.
- **§9 caption starters:** `app/api/review/caption-starters/route.ts` behind
  `caption_starters_enabled` (default off, double-gated); button hidden when off; starters
  render read-only so the caption stays empty + required.

---

## Build log — batch 1 ($0 features §2–§4)

**Built 2026-06-13.** `npx tsc --noEmit` and `npm run build` both green; `/insights`
registered as a dynamic route.

Files touched:
- `lib/db/index.ts` — added `SCORE_WEIGHTS`, `INSIGHTS_WINDOW_DAYS`, `scoreExpr`,
  `getEngagementByFormat`, `getEngagementByWeekday`, `getTopPosts` (§2);
  `insertSubscriberEvent`, `getSubscribersByCtaType`, `getSubscriberTrend` (§4);
  relaxed `getPostsMissingEngagement` to saves+reach and reworked `updateEngagement`
  to nullable optionals + `shares` (§3). Imported `subscriberEvents`.
- `app/(app)/insights/page.tsx` — new RSC: format / weekday / top-posts panels + the
  §4 subscribers-by-CTA + trend panel.
- `app/(app)/_components/NavLinks.tsx` — added `/insights`.
- `app/(app)/_components/NumbersForm.tsx` — string-backed state; saves+reach required;
  optional likes/comments/**shares**; blanks persist as null.
- `app/(app)/_components/SubscriberForm.tsx` — new: channel toggle, count, optional
  post picker, note.
- `app/(app)/engagement/page.tsx` — nullable `NumbersForm` initial incl. `shares`;
  `SubscriberForm` section with a recent-posts picker.
- `app/(app)/layout.tsx` — banner now says "missing saves or reach".
- `app/actions.ts` — reworked `saveNumbers` (nullable + `shares`, server-side coerce/
  require); added `logSubscriberEvent`.

**Design notes / honest limits:**
- Score is reach-*normalized* when reach > 0 (a saves/shares rate), so efficient small
  posts can top a lucky high-reach one. Weights are one exported constant.
- Insights rank weekday, not hour — `posted_at` is the "mark posted" click, not the IG
  publish time, so there's no trustworthy time-of-day signal to surface.
- Weekday + weekly buckets are computed in `settings.timezone` via
  `(posted_at)::timestamptz at time zone <tz>`; assumes `posted_at`/`occurred_at` carry
  an offset (they do — Luxon `nowIso`).

**Verification still owed (needs a live `DATABASE_URL` + a little seed data):**
- §2: seed posts with reels deliberately out-saving statics → confirm format/weekday/top
  rankings match a hand-written SQL query.
- §3: complete a post with only saves+reach → banner clears; blank likes/comments don't
  re-trigger it.
- §4: log 3 email signups attributed to a `snail_mail`-CTA post → panel credits that CTA
  type; trend total/weekly update.

## Build log — batch 2 (model-touching + metering, §5–§9)

**Built 2026-06-13.** `npx tsc --noEmit` and `npm run build` green after each step;
`/api/insights/reuse` and `/api/review/caption-starters` registered as dynamic routes.
Order followed FEATURES.md: §5 → §6 → §7 → §8 → §9 (§7 before §8/§9 so their Haiku
calls inherit the cost meter).

Files touched:
- `lib/agents/strategy.ts` — §5: `formatWeeklyMix`, `weekly_mix` in context + prompt,
  `mixSummary` (nudge, never throws), mix fields on `WeeklyPlanResult`. §6:
  `WEB_SEARCH_MIN_DAYS`, `decideWebSearch`, cadence gate in `runWeeklyPlan` + stamp via
  `updateSettings`, `webSkippedReason`. §7: `agent: "strategy"` on `callJson` + `webSearch`.
- `app/(app)/_components/RunPlanButton.tsx` — surfaces achieved-vs-target mix (§5) and
  cadence-skip vs unavailable copy (§6).
- `lib/db/index.ts` — `updateSettings` (§6); `insertUsageLog` + `getMonthlySpend` (§7).
- `lib/claude.ts` — §7: `UsageAgent`, `MODEL_PRICES` (⚠ live-pulled), `estimateCost`,
  `readUsage`/`logUsage`; `agent` opt on `callJson`/`webSearch`; one row per billed call
  (callJson logs each retry; webSearch sums the pause_turn loop into one row); logging
  swallows errors so it never breaks an agent.
- `lib/agents/content.ts`, `lib/agents/distribution.ts` — `agent` label on their `callJson`.
- `app/(app)/layout.tsx` — §7 budget banner (shows once spend > 0; warns past budget).
- `app/api/insights/reuse/route.ts` + `app/(app)/_components/ReuseHitsButton.tsx` +
  `app/(app)/insights/page.tsx` — §8.
- `app/api/review/caption-starters/route.ts` + `app/(app)/_components/ReviewCard.tsx` +
  `app/(app)/review/page.tsx` — §9.

**Design notes / honest limits:**
- §5 is a *nudge*: the prompt carries `weekly_mix` as relative emphasis (she posts ~3-4x/
  week, not the literal 6), and her own `format_performance` is told to outrank it.
  `mixSummary` only reports + flags a gentle note; it never rejects a plan.
- §6 stamps `last_web_search_at` only when a search actually ran (`web.ok && queries > 0`),
  so an unavailable web search doesn't advance the 28-day clock.
- §7 reads token + `server_tool_use.web_search_requests` straight off `response.usage`;
  `getMonthlySpend` sums the month via the same lexicographic ISO-date compare as the
  insights helpers (tiny DST-edge imprecision, consistent with the codebase). `MODEL_PRICES`
  is one labelled ⚠ constant — re-confirm if Anthropic changes prices.
- §9 starters are **read-only** (no click-to-insert): the caption field stays empty and the
  existing approve gate still requires a her-typed caption. Default stays **off** — revisit
  with the artist before enabling; do not flip the seed.

**Verification still owed (needs live `DATABASE_URL` + `ANTHROPIC_API_KEY`):**
- §5: with `weekly_mix={reel:3,carousel:2,static:1}` a generated week leans reels/carousels;
  changing the setting changes the plan.
- §6: `'monthly'` + recent `last_web_search_at` → 0 searches, still plans; after 28d → ≤3
  searches and the stamp updates.
- §7: run each agent once → one `usage_log` row per model call with non-zero tokens; banner
  sums the month; warning fires past `monthly_budget_usd`.
- §8: seeded top posts → click returns 2-3 suggestions naming the actual posts; induced API
  failure surfaces cleanly and writes nothing.
- §9: flag off → no button, route returns "disabled" (403); flag on → ≤3 starters, caption
  stays empty + required.

## Closing tasks (per batch)

- `npm run build` / typecheck green. ✅ (batch 1, batch 2)
- Update this table as each step lands.
