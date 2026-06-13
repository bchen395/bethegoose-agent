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
| 5 | Content-mix targets (reel weighting) | $0 extra | ⏳ Deferred (next batch) |
| 6 | Right-size web search | − | ⏳ Deferred (next batch) |
| 7 | Cost meter | negligible | ⏳ Deferred (next batch) |
| 8 | "Reuse your hits" (Haiku, on-demand) | bounded | ⏳ Deferred (next batch) |
| 9 | Caption starters (flagged, default off) | bounded | ⏳ Deferred (next batch) |

**This batch = the $0-API high-value set: §2, §3, §4.** The model-touching and
metering features (§5–§9) are scoped and sequenced but not yet built.

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

## Deferred (next batch) — scoped, not built

- **§5 content mix:** inject `settings.weekly_mix` into Strategy prompt/context;
  post-validate distribution as a *nudge* (no hard-fail).
- **§6 web-search cadence:** gate `runResearch` on `web_search_cadence`
  (`monthly` default, 28-day stamp via new `updateSettings`); keep `MAX_WEB_SEARCHES`.
- **§7 cost meter:** thread `agent` through `callJson`/`webSearch`; log `usage_log` rows
  with a **freshly-pulled** price map; `getMonthlySpend()` + budget banner.
- **§8 reuse your hits:** `app/api/insights/reuse/route.ts` → one Haiku call over
  `getTopPosts(90)`; button on `/insights`.
- **§9 caption starters:** `app/api/review/caption-starters/route.ts` behind
  `caption_starters_enabled` (default off); button hidden when off; caption stays required.

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

## Closing tasks (per batch)

- `npm run build` / typecheck green. ✅ (batch 1)
- Update this table as each step lands.
