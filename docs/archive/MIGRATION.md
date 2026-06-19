# MIGRATION.md — Streamlit/SQLite → React on Vercel

Plan to move the Art Business Agent from a **local-first Python app** (Streamlit UI,
SQLite file, local art dir, crontab) to a **hosted TypeScript app** the artist reaches
from any browser, while you keep iterating on the agents without disrupting her.

**Locked decisions (see the dialogue that produced them):**
- **One Next.js (App Router) app on Vercel**, TypeScript, single repo, single deploy.
- **Supabase** for all three data needs: **Postgres** (data), **Storage** (art files),
  **Auth** (login). One vendor, one dashboard.
- Agents **ported to TypeScript** and run server-side in the Next.js app (API routes /
  server actions) — the `ANTHROPIC_API_KEY` never reaches the browser.
- Commercial use → **Vercel Pro ($20/mo)** is the real baseline; it also unlocks the
  300s function timeout the weekly Strategy run wants.

---

## 1. Target architecture

```
                         [ Her browser — any device ]
                                     |
                         (Supabase Auth session cookie)
                                     |
                                     v
        ┌───────────────── Next.js app on Vercel ─────────────────┐
        │  React pages (RSC)            Server actions / API routes │
        │  • /calendar  (View 1)        • run weekly plan           │
        │  • /review    (View 2)        • generate draft            │
        │  • /engagement(View 3)        • approve → distribute      │
        │  • banners (shared layout)    • cron: weekly-strategy     │
        │                                                            │
        │  lib/agents/*  (Strategy · Content · Distribution)         │
        │  lib/claude.ts (forced-JSON · web search · image blocks)   │
        │  lib/db.ts     (Drizzle typed helpers)                     │
        └───────┬───────────────────┬───────────────────┬───────────┘
                │                   │                   │
       Anthropic API        Supabase Postgres     Supabase Storage
       (Sonnet/Haiku +      (6 tables, jsonb)     (art bucket;
        web search)                                browser uploads direct)
                                     ^
                                     |
                         Vercel Cron (Mon ~08:00) ──► /api/cron/weekly-strategy
```

What maps 1:1 from today, and what fundamentally changes:

| Today (local) | Becomes (hosted) | Note |
|---|---|---|
| `utils/db.py` (SQLite file) | `lib/db.ts` (Drizzle → Supabase Postgres) | JSON-TEXT cols → `jsonb`; manual encode/decode disappears |
| `data/art/` local files | Supabase Storage bucket | `art_filename` becomes a storage key |
| `utils/claude.py` | `lib/claude.ts` | same primitives in the Anthropic TS SDK |
| 3 Python agents | `lib/agents/*.ts` behind routes | logic ported faithfully |
| `ui/app.py` (Streamlit) | 3 React pages + shared banner | `st.rerun` → normal data fetching |
| crontab line | Vercel Cron in `vercel.json` | runs in UTC |
| (no auth) | Supabase Auth, email allow-list | required — public + commercial |

---

## 2. Proposed repo layout

```
bethegoose-agent/
├── app/
│   ├── (auth)/login/page.tsx          # Supabase magic-link / password login
│   ├── (app)/
│   │   ├── layout.tsx                  # auth guard + always-on banners + nav
│   │   ├── calendar/page.tsx           # View 1
│   │   ├── review/page.tsx             # View 2
│   │   └── engagement/page.tsx         # View 3
│   ├── api/
│   │   ├── content/generate/route.ts   # POST { slotId }  → Content Agent
│   │   ├── strategy/run/route.ts       # POST { weekStart } → Strategy Agent
│   │   ├── posts/[id]/approve/route.ts # POST → Distribution Agent
│   │   └── cron/weekly-strategy/route.ts
│   └── actions.ts                      # server actions for UI mutations (attach art, save, mark posted, save numbers)
├── lib/
│   ├── claude.ts                       # ← utils/claude.py
│   ├── db/
│   │   ├── schema.ts                   # Drizzle schema (6 tables)
│   │   └── index.ts                    # connection + typed helpers (← utils/db.py)
│   ├── storage.ts                      # signed upload URL, fetch art bytes
│   ├── supabase/{server,client}.ts     # @supabase/ssr clients
│   └── agents/{strategy,content,distribution}.ts
├── scripts/
│   ├── seed.ts                         # ← seed_settings.py + seed_brand_voice.py
│   └── migrate-data.ts                 # one-shot: old SQLite + data/art → Supabase
├── drizzle/                            # generated SQL migrations
├── middleware.ts                       # session refresh + route protection
├── vercel.json                         # cron schedule
└── (Python files kept until cutover, then removed)
```

Dependencies: `next`, `@anthropic-ai/sdk`, `drizzle-orm` + `postgres` (postgres.js),
`@supabase/supabase-js`, `@supabase/ssr`, `zod` (output schemas + validation),
`luxon` (timezone-aware timestamps, replacing `zoneinfo`).

---

## 3. Database: SQLite → Supabase Postgres

Port `db/init.sql`'s 6 tables to a Drizzle schema. Mostly mechanical:

- `INTEGER PRIMARY KEY` → `bigint generated always as identity` (or `serial`).
- `hashtags`, `example_captions`, `avoid_phrases` (JSON in TEXT) → **`jsonb`**.
  This deletes the `_loads`/`_encode`/`_JSON_COLUMNS` plumbing — Drizzle returns/accepts
  arrays natively.
- All your `CHECK` constraints (`status`, `format`, `cta_type`, `priority`,
  `type`, `id = 1`, `min <= max`) port directly.
- Foreign keys (`posts.product_id`, `calendar.post_id`) port directly; Postgres
  enforces them by default, so the per-connection `PRAGMA foreign_keys = ON` dance is gone.
- **Timestamps/dates:** keep them as ISO **`text`** initially (faithful port — your
  lexicographic ISO comparisons in `_date_window`, `get_upcoming_markets`, etc. keep
  working unchanged). Optional later upgrade to real `date`/`timestamptz`.

**`lib/db.ts` helpers** — port every function in `utils/db.py` 1:1 so the agents and UI
keep the same call surface: `getSettings`, `getBrandVoice`, `insertPost`, `updatePost`,
`getPost`, `getPostsByStatus`, `getRecentPosts`, `getRecentPosted`,
`getPostsMissingEngagement`, `setPostStatus`, `markPosted`, `updateEngagement`,
`replaceWeekPlan`, `getCalendarWeek`, `getCalendarSlot`, `getCalendarSlotByPost`,
`getRecentScheduledTimes`, `updateCalendarSlot`, `linkSlotToPost`, `insertProduct`,
`getProduct`, `getActiveProducts`, `setProductPromoted`, `insertMarket`, `getMarket`,
`getUpcomingMarkets`, `getMarketsWithDeadline`, `setMarketDraftApplication`.
`now_iso`/`today_iso` → Luxon reading `settings.timezone`.

**Serverless connection pooling (important):** connect Drizzle through Supabase's
**Supavisor transaction pooler** connection string, not the direct one — serverless
functions open many short-lived connections and will exhaust the direct limit.

---

## 4. Storage: `data/art/` → Supabase Storage

- One **private** bucket, e.g. `art/`. `posts.art_filename` stores the object key
  (keep the existing `slot{id}_{stem}.ext` naming).
- **Browser uploads go direct to Supabase via a signed upload URL** — they do *not*
  pass through a Vercel function. This sidesteps Vercel's ~4.5 MB serverless request-body
  limit (photos of drawings will exceed it) and keeps uploads fast.
- The Content Agent fetches the bytes from Storage → base64 → image block (replacing
  `_resolve_art_path` + local `read_bytes`).
- Display in the UI uses short-lived **signed URLs** (bucket is private).

> **⚠ ffmpeg gotcha — DECIDED.** `content_agent._extract_video_frame` shells out to
> `ffmpeg`, which is **not available on Vercel serverless.** **Decision: for reel slots
> she attaches a still image** (a representative frame / the reel cover) — no video frame
> extraction. The agent always receives an image, so the ffmpeg path is dropped entirely.
> The app therefore handles **images only**, which also removes video storage and video
> rendering from the UI. (She still records/posts the actual video herself — posting is
> manual either way.) Practically: keep `format = 'reel'` as a slot type, but its attached
> art is a still image like every other format.

---

## 5. The Claude client — `utils/claude.py` → `lib/claude.ts`

The TS SDK has every primitive you use, so this is a faithful port:

- `getClient()` → singleton `new Anthropic({ apiKey })` from a **server-only** env var.
- `AgentError` → custom `Error` subclass; on it, callers write nothing (unchanged contract).
- `call_json(...)` → `messages.create` with `tools: [{ name, input_schema }]` and
  `tool_choice: { type: 'tool', name }`; pull the `tool_use` block's `.input`; validate
  with **zod** (replacing the schema dict); one retry with the stricter instruction; then
  throw `AgentError`. Keep the fence-stripping fallback for string args.
- `web_search(...)` → `tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses }]`,
  the `pause_turn` resume loop, collect `server_tool_use` queries + text. Keep
  `MAX_WEB_SEARCHES = 3` (cost cap).
- `image_block(bytes, mediaType)` → base64 from Storage bytes (not a path); keep the
  supported-type guard.
- Model id constants unchanged: `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`.

---

## 6. The agents — `agents/*.py` → `lib/agents/*.ts`

Port each agent's orchestration verbatim; only I/O (db/storage) swaps underneath.

- **Strategy** `run_weekly_plan(weekStart)` — read last 30 posts + settings + upcoming
  markets + active products; one web-search call; forced-JSON synthesis; `replaceWeekPlan`.
  Returns `{ weekStart, reasoning, webQueries, ... }` for the UI.
- **Content** `generateDraft(slotId)` — load slot + art bytes from Storage; build
  image+context content; forced-JSON; normalize hashtags + resolve CTA/product exactly as
  today; upsert the draft (caption stays null). **No video handling** — the attached art is
  always an image (reels included, per §4), so `_extract_video_frame`/`ffmpeg` and the
  `_VIDEO_EXTS` branch are dropped; only `image_block` remains.
- **Distribution** `distribute(postId)` — confirm `slot_time` (nudge logic), build the
  posting checklist **deterministically in TS** (verbatim filename/caption/URL), the single
  market-blurb model call, stamp `last_promoted_at`, set status `approved` **last**.

Keep the "write nothing on failure" contract: surface `AgentError` to the UI.

---

## 7. The UI — 3 Streamlit views → React

| Streamlit | React |
|---|---|
| sidebar radio nav | nav in `(app)/layout.tsx` |
| `render_banners()` | shared server component in the layout (engagement nudge + market deadlines) |
| View 1 calendar: week nav, "Run weekly plan now", per-slot upload + "Generate draft" | `/calendar`: RSC reads the week; upload = signed-URL direct upload → server action links draft; buttons POST to agent routes with a loading state |
| View 2 review: caption box, hashtags, CTA fields, Save/Approve/Discard | `/review`: form → server actions; Approve calls the distribution route (caption required) |
| View 3 engagement: ready-to-post + checklist + "Mark posted"; numbers entry | `/engagement`: server actions for mark-posted + saving metrics |

- **Reads:** React Server Components calling `lib/db.ts` directly (no client API needed).
- **Mutations:** server actions (`app/actions.ts`) for attach-art / save / approve /
  mark-posted / save-numbers.
- **Long agent triggers** (Strategy especially): call route handlers with a spinner;
  set `export const maxDuration = 300` on those routes (Pro). `st.spinner`/`st.toast` →
  React loading + toast.
- `st.rerun()` has no equivalent and isn't needed — revalidate the page after a mutation.

---

## 8. Auth (required)

- **Supabase Auth**, email magic-link (simplest) or email+password.
- **Disable public signups**; create her (and your) accounts in the Supabase dashboard,
  and/or **allow-list emails** in `middleware.ts`. This is the cost control too — only
  she can trigger API spend.
- `middleware.ts` (with `@supabase/ssr`) refreshes the session and redirects unauthorized
  requests to `/login`; it also guards every `/api/*` agent route.

---

## 9. Cron — crontab → Vercel Cron

`vercel.json`:

```json
{ "crons": [{ "path": "/api/cron/weekly-strategy", "schedule": "0 12 * * 1" }] }
```

- The route checks the `CRON_SECRET` (Vercel sends it in the `Authorization` header),
  then calls `strategy.runWeeklyPlan(thisWeekMonday)`. `maxDuration = 300`.
- **Vercel Cron is UTC.** `0 12 * * 1` ≈ Mon 08:00 America/New_York during EDT; it drifts
  an hour at DST — fine for a weekly plan. (Or schedule daily and gate on local weekday/time.)
- The "Run weekly plan now" button stays as the manual fallback.

---

## 10. Env vars

Server-only (Vercel project settings + `.env.local`):
`ANTHROPIC_API_KEY`, `DATABASE_URL` (Supavisor pooled), `SUPABASE_SERVICE_ROLE_KEY`,
`CRON_SECRET`.
Public (browser-safe): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
**Never** prefix the Anthropic key with `NEXT_PUBLIC_`.

---

## 11. Migrating existing data

If she already has real rows / art (not just seeds):
- `scripts/migrate-data.ts` (run once, locally): open the old `data/art_business.db`,
  copy `settings`, `brand_voice`, `products`, `markets`, `posts`, `calendar` into
  Supabase; upload each `data/art/*` file to the Storage bucket under the same key.
- Port `seed_settings.py` + `seed_brand_voice.py` → `scripts/seed.ts` for fresh setups.
- The ⚠ placeholders flagged in PROGRESS.md (snail_mail_pitch, avoid_phrases,
  default_post_time) still need confirming with her — migration doesn't change that.

---

## 12. Build sequence (each step independently verifiable)

0. **Scaffold** — `create-next-app` (TS, App Router); add deps; create the Supabase
   project; wire `.env.local`. _Verify:_ app boots locally.
1. **Schema + data layer** — Drizzle schema → push to Supabase; port `lib/db.ts` helpers;
   port `scripts/seed.ts`. _Verify:_ seeds insert; a few helper reads return expected rows.
2. **Storage** — create the `art` bucket; `lib/storage.ts` (signed upload URL, fetch
   bytes, signed display URL). _Verify:_ upload a test image, read it back.
3. **Claude client** — port `lib/claude.ts`. _Verify:_ a throwaway script does one
   `call_json` and one `web_search`.
4. **Agents** — port the 3 agents. Reel slots take a still image (§4), so the Content
   Agent drops all video/ffmpeg handling. _Verify:_ run each against seeded data and
   confirm DB writes match the Python output.
5. **Auth** — Supabase Auth + `middleware.ts` + `/login`; email allow-list. _Verify:_
   unauthorized → redirect; her email → in.
6. **UI** — the 3 pages + banners + nav; reads via RSC, mutations via server actions,
   agent triggers via routes with `maxDuration`. _Verify:_ full attach→generate→
   caption→approve→post→numbers loop locally.
7. **Cron** — `vercel.json` + `/api/cron/weekly-strategy` + `CRON_SECRET`. _Verify:_ hit
   the route manually with the secret; a week of slots appears.
8. **Deploy** — push repo to Vercel; set env vars; **upgrade to Pro**; confirm preview
   vs production branch workflow. Run `migrate-data.ts` if there's real data. _Verify:_
   end-to-end on the production URL.
9. **Cutover** — keep the Streamlit app runnable as a fallback for a week; once confident,
   remove the Python UI/agents and update README.

---

## 13. Risks & gotchas (don't get surprised)

- **ffmpeg is gone on serverless** — resolved: reels take a still image; app is image-only (§4).
- **Vercel body limit (~4.5 MB)** — uploads must go browser→Supabase direct, not through a
  function (§4).
- **Postgres connections in serverless** — use the Supavisor **pooled** string or you'll
  hit connection limits (§3).
- **Supabase free tier pauses after ~7 days idle** — her weekly use + the weekly cron
  likely keep it warm; add a tiny keep-alive cron if not, or go Supabase Pro ($25/mo).
- **Function timeouts** — set `maxDuration = 300` on the Strategy/cron routes (needs Pro).
- **Cron is UTC** — accept the DST hour-drift or gate inside the function.
- **Key hygiene** — agents run server-side only; the Anthropic key is never `NEXT_PUBLIC_`.

---

## 14. Cost (monthly)

| Piece | Plan | Cost |
|---|---|---|
| Vercel (commercial → Pro; also unlocks 300s timeout) | Pro | **$20** |
| Supabase (free tier; mind the pause, or Pro to remove it) | Free / Pro | **$0** / +$25 |
| Anthropic API (unchanged: 1 weekly Sonnet + capped web search + Haiku per post) | — | **~$3–5** |
| **Baseline total** | | **~$23–25/mo** |

The old "<$5/mo" target no longer holds once it's hosted + commercial — the jump is
almost entirely **Vercel Pro**, which the commercial-use terms and the long Strategy run
both call for. Everything else stays on free tiers.
```
