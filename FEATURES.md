# FEATURES.md — Post-migration feature work

> **⚠ Superseded in places (2026-06-17).** A later simplification removed the Review
> section, photo upload, and the **Content** and **Distribution** agents; posting and CTAs
> are now manual, and **Instagram is the source of posted rows** (the daily sync ingests
> media + metrics — see `docs/archive/AUTOMATION_PLAN.md` Item #1 and the 2026-06-17 entry in
> `docs/archive/PROGRESS.md`). Where this file describes the attach-art → generate-draft → review →
> approve → mark-posted → type-the-numbers loop (esp. §3), that flow no longer exists —
> metrics auto-sync, with the manual form only as a fallback. The §1 schema, §2 insights,
> §4 subscribers, §5–§7 tunables, and §8 reuse still hold. §9 caption-starters was removed.

Feature changes layered on top of the hosted TypeScript stack from `docs/archive/MIGRATION.md`.
These are **behavior changes**, not a port. They ship **after** the migration cutover
(docs/archive/MIGRATION.md §12, Step 9) so they're built once, on the new stack, against real
first-party data.

> **Why this is a separate file from `docs/archive/MIGRATION.md`.** The migration's whole safety
> property is "the new code reproduces the Python behavior" — every step verifiable by
> comparison. Mixing new behavior into it destroys that check (a discrepancy becomes
> ambiguous: port bug or intended change?). So features live here and run later. The
> *only* coupling is schema — see the next box.

> **⚠ Do this during the migration, not after.** The schema deltas in §1 are additive,
> nullable, and defaulted, so nothing in the faithful port reads or writes them — they
> don't change the migration's verification. Create them in the **migration's Step 1
> (Drizzle schema)** so you migrate the database *once*. Everything else in this file
> waits until after cutover.

---

## Guiding principles

These shape every feature below; if a feature would violate one, it's redesigned.

1. **The LLM is for generation only.** Anything that's an aggregation of data she
   already enters is **SQL, $0 API.** Most of this file is SQL. Two features make a
   single, on-demand, bounded Haiku call. Nothing adds a recurring API charge.
2. **Saves and shares are the target metric, not likes.** Current Instagram reality for
   a sub-1K account: Reels drive most reach to non-followers, and the algorithm weighs
   saves and DM-shares above likes. Rankings, scores, and the content mix all lead with
   saves/shares.
3. **Cost-neutral on the API line.** The migration already moved the baseline to
   ~$23–25/mo (mostly Vercel Pro). This feature set adds roughly **$0–1/mo** of API, and
   §6 (right-sizing web search) likely makes the net change *negative*.
4. **Her voice stays the product.** The "she writes captions" rule holds. The one feature
   that brushes against it (§9) ships behind a default-off flag.
5. **Nothing hardcoded.** New tunables live in `settings` (matching the existing
   convention), seeded by `scripts/seed.ts`.

---

## 1. Schema deltas (create during the migration's Step 1)

All additive — safe to add to `lib/db/schema.ts` during the port. None are read or
written by ported code, so the migration's behavior comparison is unaffected.

**Altered tables**

| Table | Column | Type | Default | Used by |
|---|---|---|---|---|
| `engagement` (or `posts`, wherever metrics live) | `shares` | `integer` | `null` | §2, §3 |
| `settings` | `weekly_mix` | `jsonb` | `{"reel":3,"carousel":2,"static":1}` | §5 |
| `settings` | `web_search_cadence` | `text` (`'weekly'｜'monthly'｜'off'`) | `'monthly'` | §6 |
| `settings` | `last_web_search_at` | `text` (ISO) | `null` | §6 |
| `settings` | `monthly_budget_usd` | `numeric` (store as text if matching the ISO-text convention) | `5` | §7 |
| `settings` | `caption_starters_enabled` | `boolean` | `false` | §9 |

**New tables**

```sql
-- §4: owned-audience attribution
subscriber_events (
  id            bigint generated always as identity primary key,
  occurred_at   text not null,                  -- ISO, Luxon in settings.timezone
  channel       text not null,                  -- CHECK ('snail_mail','email')
  count         integer not null default 1,     -- batch entry allowed ("got 3 this week")
  source_post_id bigint references posts(id),   -- nullable; what drove the signup, if known
  note          text
);

-- §7: cost meter
usage_log (
  id            bigint generated always as identity primary key,
  occurred_at   text not null,                  -- ISO
  agent         text not null,                  -- CHECK ('strategy','content','distribution')
  model         text not null,
  input_tokens  integer not null default 0,
  output_tokens integer not null default 0,
  web_searches  integer not null default 0,
  est_cost_usd  numeric not null default 0      -- computed at write time
);
```

Add the matching `seed.ts` values for the new `settings` columns (with the same ⚠
"confirm with the artist" treatment as the existing placeholders — especially
`monthly_budget_usd` and the default `weekly_mix`).

_Verify (at migration time):_ schema pushes; new columns are null/defaulted on existing
rows; the ported agents and UI still pass their Step 4/6 behavior checks unchanged.

---

## 2. "What's working" insights — $0 API  ★ build first

The highest value-per-dollar feature. The loop already leads with what worked; this
turns raw numbers into *patterns* she can act on.

**What it does.** Aggregates `posts × engagement` over a rolling window and surfaces:
which **format** (comic/doodle/sticker; reel/carousel/static) earns the most saves+shares,
best **weekday/time**, and **top posts**. Ranked by a performance score, not likes.

**Score (tunable, in `lib/db.ts`, not the model):**
```
score = 3·shares + 2·saves + 1·(comments) + 0.25·likes,  normalized by reach when reach > 0
```
Weighting reflects principle #2; expose the weights as constants so they're easy to retune.

**Where.**
- `lib/db.ts`: `getEngagementByFormat(windowDays)`, `getEngagementByWeekday(windowDays)`,
  `getTopPosts(windowDays, n)` — pure SQL aggregates.
- A new `/insights` RSC page (or a panel at the top of `/engagement`) that calls these
  directly. No client API, no model call.

**API cost.** $0.

_Verify:_ seed posts with deliberately skewed engagement (e.g. reels out-saving statics);
the panel ranks formats/weekdays correctly and matches a hand-written SQL query.

---

## 3. Lower engagement-entry friction — $0 API

The whole system dies if she stops entering numbers, so make entry trivial and collect
the metrics that matter.

**What it does.** Makes **saves + reach** the only required fields; likes, comments, and
`shares` are optional. The "you still owe numbers" banner clears once saves+reach are
present. Adds a `shares` field to the form (the strongest growth signal — worth one extra
tap).

**Where.** `/engagement` form + validation; the banner query in `(app)/layout.tsx`
(`getPostsMissingEngagement` → "missing saves or reach").

**API cost.** $0.

_Verify:_ a post can be completed with only saves+reach; banner clears; likes/comments
left blank don't re-trigger it.

---

## 4. Owned-audience (subscriber) attribution — $0 API

Converting followers to the snail-mail/email list is the most durable growth for an
artist this size. Today the subscription is just one CTA in rotation; make it a tracked
outcome.

**What it does.** A tiny entry on `/engagement` — "new subscribers this period" with a
channel toggle and an optional "which post drove it?" picker — writes `subscriber_events`.
An insights panel joins `subscriber_events.source_post_id → posts.cta_type` to show
**which CTA types actually convert to subscribers**, not just which got likes.

**Where.**
- `app/actions.ts`: `logSubscriberEvent({ channel, count, sourcePostId? })`.
- `lib/db.ts`: `getSubscribersByCtaType(windowDays)`, `getSubscriberTrend(windowDays)`.
- Panel on `/insights`.

**API cost.** $0.

_Verify:_ log 3 email signups attributed to a post whose `cta_type = 'snail_mail'`; the
panel credits that CTA type and the running trend updates.

---

## 5. Content-mix targets (reel weighting) — $0 extra API

**What it does.** Teaches the Strategy Agent to plan a deliberate format mix —
reels for discovery, carousels for saves, a little static — instead of treating all
slots the same. The target lives in `settings.weekly_mix` (configurable), and the agent's
forced-JSON output is validated (zod) to roughly honor it. The prompt explains *why*
(reels = reach to non-followers; carousels = saves).

**Where.** `lib/agents/strategy.ts`: inject `weekly_mix` into the prompt; extend the zod
output schema so each slot carries a `format`, and post-validate the week's distribution
against the target (nudge, don't hard-fail — she may have only doodles that week).

**API cost.** None — same single weekly Sonnet call.

_Verify:_ with `weekly_mix = {reel:3,carousel:2,static:1}`, a generated 6-slot week lands
on (or near) that distribution; changing the setting changes the plan.

---

## 6. Right-size web search — *reduces* API cost

The migration keeps web search at up to 3 searches **every** week. For a tiny niche
account, generic trend data is weak signal and the strongest input (her own engagement)
is now far richer thanks to §2/§5. Make web search occasional.

**What it does.** Strategy reads `settings.web_search_cadence`:
- `'monthly'` (new default) — search only if `last_web_search_at` is >~28 days old; else
  plan from first-party data alone, and stamp `last_web_search_at` when it does search.
- `'weekly'` — current behavior.
- `'off'` — never search.

Keep `MAX_WEB_SEARCHES = 3` as the per-run cap regardless.

**Where.** `lib/agents/strategy.ts` (cadence gate around the existing `web_search` call);
`lib/db.ts` (`getSettings`/`updateSettings` already cover the new columns).

**API cost.** Net **negative** — roughly 3–4 fewer billable searches per month.

_Verify:_ with `'monthly'` and a recent `last_web_search_at`, a run performs **zero**
searches and still produces a plan; after 28 days it performs ≤3 and updates the stamp.

---

## 7. Cost meter — negligible API

She cares about the budget; make spend visible and self-policing.

**What it does.** Every agent call logs its token usage (already returned on the
response) plus any web searches to `usage_log`, with an estimated dollar cost. A banner
shows **"API spend this month: $X.XX"** and warns when it crosses
`settings.monthly_budget_usd`.

**Where.**
- `lib/claude.ts`: after `messages.create` resolves, insert a `usage_log` row from
  `response.usage` (+ counted `server_tool_use` web searches). One small write; don't let
  a logging failure break the agent (catch + ignore).
- `lib/db.ts`: `getMonthlySpend()`.
- Banner in `(app)/layout.tsx`.

> **⚠ Confirm current prices.** The cost estimate needs a per-model price map
> (`input`/`output` per-MTok, and per-web-search). **Do not hardcode remembered numbers**
> — pull current Anthropic pricing when you implement, and keep the map in one labelled
> constant so it's trivial to update. Treat it like the other ⚠ placeholders.

**API cost.** Negligible (logging only; usage data is already in the response).

_Verify:_ run each agent once; `usage_log` gains a row per call with non-zero token
counts; the banner sums the current month and the warning fires past the configured
budget.

---

## 8. "Reuse your hits" — one bounded Haiku call, on demand

**What it does.** A button on `/insights` takes her top posts from the last 90 days
(§2's `getTopPosts`, by saves+shares) and asks Haiku for 2–3 **concrete** repurposes
grounded in those actual posts: turn a popular doodle into a sticker SKU, re-cut a top
comic as a reel, compile a theme into a carousel. Suggestions reference the real posts and
her active products + brand voice — never generic advice.

**Where.** `app/api/insights/reuse/route.ts` (POST, no body needed) → loads top posts +
brand voice + active products → one `call_json` (Haiku, forced-JSON, zod, the existing
"write nothing on failure" contract) → returns suggestions. Triggered by a button with a
loading state; nothing persists unless she acts on it.

**API cost.** One Haiku call **per click** (fractions of a cent). Bounded — never runs on
its own.

_Verify:_ with seeded top posts, a click returns 2–3 suggestions that name the actual
posts and propose real reuses; an API failure surfaces cleanly and writes nothing.

---

## 9. Optional caption starters — flagged, default off

> **Tension, stated honestly.** This is the one feature that touches the "she writes
> captions" principle, which is a real strength of the system. It ships **behind
> `settings.caption_starters_enabled`, default `false`**, and is framed as *starters*, not
> a draft. Revisit with the artist before enabling — she may not want it, and that's a
> valid outcome.

**What it does.** When enabled, a "need a starting line?" button on `/review` offers 2–3
short opening lines / angles in her voice (from `brand_voice`) referencing the attached
art. The caption field stays **empty and required** — she still writes the caption; this
only fights the blank page.

**Where.** `app/api/review/caption-starters/route.ts` (POST `{ postId }`) → one Haiku
call, gated on the flag → returns ≤3 short strings. UI button hidden when the flag is off.

**API cost.** One Haiku call per click, only when enabled. Bounded.

_Verify:_ with the flag off, no button renders and no route is reachable from the UI; with
it on, a click yields ≤3 short starters and the caption field remains empty + required.

---

## Build sequence (each step independently verifiable)

Runs after docs/archive/MIGRATION.md Step 9 (cutover). Schema (§1) excepted — that's folded into the
migration's Step 1.

1. **Insights core (§2)** — the SQL helpers + `/insights` page. Highest value, unblocks
   §4, §8. _Verify:_ rankings match hand-written SQL.
2. **Engagement friction + shares (§3)** — required-field change + `shares` input.
   _Verify:_ saves+reach alone completes a post.
3. **Subscriber attribution (§4)** — entry + panel. _Verify:_ a signup credits the right
   CTA type.
4. **Content mix (§5)** — Strategy prompt + schema validation. _Verify:_ plan honors
   `weekly_mix`.
5. **Web-search cadence (§6)** — the gate. _Verify:_ monthly cadence skips searches and
   still plans.
6. **Cost meter (§7)** — `usage_log` writes + banner (confirm prices first). _Verify:_ a
   row per call; banner sums the month.
7. **Reuse your hits (§8)** — on-demand Haiku route + button. _Verify:_ grounded
   suggestions; clean failure.
8. **Caption starters (§9)** — last, behind the flag, after talking to her. _Verify:_
   off = invisible; on = ≤3 starters, caption still required.

Update `docs/archive/PROGRESS.md` per step, same as the migration.

---

## Cost impact

| Feature | API cost change |
|---|---|
| §2 Insights, §3 friction, §4 subscribers, §5 content mix | $0 |
| §6 Right-size web search | **−** (≈3–4 fewer searches/mo) |
| §7 Cost meter | negligible (logging only) |
| §8 Reuse, §9 caption starters | bounded, on-demand Haiku (fractions of a cent per click) |
| **Net monthly API change** | **roughly $0, likely slightly negative** |

The features don't move the hosted baseline (~$23–25/mo, dominated by Vercel Pro). They
add capability while staying cost-neutral on the API line — and §7 finally makes that line
*visible*.