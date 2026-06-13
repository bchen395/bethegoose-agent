# Be The Goose — Art Business Agent

A small three-agent system that helps a one-person indie art business grow on
Instagram and drive sales to an online shop and in-person art markets. The agents
do the planning and prep; **the artist writes her own captions, approves, and posts.**

Nothing posts to Instagram automatically. The agents prepare a weekly plan, the
supporting material around each post (hashtags, CTA suggestions, reel hooks), and a
posting checklist — she stays in the loop for every published post.

> Built for an artist with **under 1K followers**, ~3 posts/week of original comics,
> doodles, and stickers, who also sells prints, crafts, and a monthly snail-mail
> subscription.

> **Stack:** this is a hosted **Next.js (App Router) + TypeScript** app on **Vercel**,
> with **Supabase** Postgres (via Drizzle) + Storage + magic-link auth. It was ported
> from an earlier local Python/Streamlit/SQLite prototype — see
> [Migration & history](#migration--history). The Python code is retained in-repo as a
> fallback only; it is **not** the running system.

---

## What it does (and doesn't)

**It does:**
- Plan a weekly content calendar (3–4 slots) from her own engagement data, with a
  deliberate **format mix** (reels for reach, carousels for saves) and **occasional**
  web search.
- For each post, after she attaches art: suggest hashtags, a (droppable) CTA line,
  and — for reels — a hook + rough script, all referencing the actual artwork.
- On approval: build a plain-text posting checklist, confirm the posting time, draft
  art-market application blurbs when a deadline is near, and rotate which product the
  CTA promotes.
- Track engagement she enters back in (saves + reach required; likes/comments/**shares**
  optional) and surface **what's working** — top formats, weekdays, and posts ranked by
  a saves-and-shares score — plus **subscriber attribution** (which CTA types convert).
- Meter its own API spend and, on demand, suggest ways to **reuse her top posts**.

**It does NOT:**
- Post to Instagram automatically (API restrictions on personal accounts — she posts).
- Write captions — **she does.** (An optional, default-off "caption starters" helper
  only offers opening lines; the caption field stays empty and required.)
- Scrape competitor accounts or use any paid third-party API beyond Anthropic + the
  hosting stack (Vercel + Supabase).

---

## Architecture

Three standalone agents that share state **only** through one Postgres database (Supabase)
— they never call each other. A Next.js App Router app is the human-in-the-loop review
surface; agent runs are route handlers (so they can set `maxDuration`), short mutations
are server actions, and art uploads go **browser → Supabase Storage** via a signed URL
(never through a function).

```
[Inputs]  Art backlog · Past posts · Shop products · Market history
                              |
                              v
        [Shared memory — Supabase Postgres, via Drizzle (lib/db)]
  settings · posts · calendar · products · markets · brand_voice
  subscriber_events · usage_log
                              |
        ______________________|______________________
       |                      |                      |
       v                      v                      v
  [Strategy Agent]      [Content Agent]      [Distribution Agent]
  claude-sonnet-4-6     claude-haiku-4-5     claude-haiku-4-5
  weekly calendar       per-post material    post-approval prep
       |______________________|______________________|
                              |
                              v
        [Human review — Next.js app (app/(app)) on Vercel]
   /calendar · /review · /engagement · /insights   (magic-link auth)
                              |
                              v
       [Engagement entered back into Postgres → Strategy learns]
```

| Agent | Model | When it runs | What it produces |
|---|---|---|---|
| **Strategy** (`lib/agents/strategy.ts`) | `claude-sonnet-4-6` | Weekly (Vercel cron + UI button) | The week's `calendar` slots; leads with first-party engagement, honors `weekly_mix`, web search gated by `web_search_cadence` (≤3 searches) |
| **Content** (`lib/agents/content.ts`) | `claude-haiku-4-5-20251001` | Per slot, after art is attached | `posts` draft: hashtags, CTA suggestion, reel hook/script — **no caption** |
| **Distribution** (`lib/agents/distribution.ts`) | `claude-haiku-4-5-20251001` | On approval | Posting checklist, confirmed time, market blurb, product-promotion stamp |

All model calls go through `lib/claude.ts` with **forced tool-use / JSON output**,
defensive parsing, and one retry; on final failure they write nothing and surface a
clear error. Every billed call is logged to `usage_log` with an estimated cost (§7).

---

## Project layout

```
bethegoose-agent/
├── README.md                  # this file
├── FEATURES.md                # post-migration feature spec (what/why) — source of truth
├── FEATURES_PLAN.md           # how the features are built + live status tracker
├── DEPLOY.md                  # Vercel production deploy runbook
├── package.json               # next / drizzle / supabase / anthropic
├── drizzle.config.ts          # points at lib/db/schema.ts (uses DIRECT_URL)
├── vercel.json                # weekly cron: /api/cron/weekly-strategy
├── proxy.ts                   # auth middleware (guards the (app) routes)
├── .env.local                 # secrets (gitignored) — see Setup
├── lib/
│   ├── db/
│   │   ├── schema.ts          # Drizzle schema (8 tables)
│   │   └── index.ts           # the only gateway to Postgres (typed helpers)
│   ├── claude.ts              # shared API client + web search + forced-JSON + cost meter
│   ├── storage.ts             # Supabase Storage (signed upload/display URLs)
│   ├── agents/{strategy,content,distribution}.ts
│   └── supabase/{server,client}.ts
├── app/
│   ├── (auth)/login/          # magic-link login
│   ├── (app)/                 # authed views + layout (banners)
│   │   ├── calendar/  review/  engagement/  insights/
│   │   └── _components/        # client components (forms, buttons, cards)
│   ├── api/
│   │   ├── strategy/run/                 # POST — run the weekly plan
│   │   ├── content/generate/             # POST — draft for one slot
│   │   ├── posts/[id]/approve/           # POST — distribute + approve
│   │   ├── cron/weekly-strategy/         # GET  — Vercel cron (CRON_SECRET)
│   │   ├── insights/reuse/               # POST — §8 reuse suggestions (Haiku)
│   │   └── review/caption-starters/      # POST — §9 starters (flagged, default off)
│   └── actions.ts             # server actions (attach art, save, mark posted, numbers…)
├── scripts/
│   └── seed.ts                # seed settings + brand_voice (npm run seed)
└── db/init.sql                # legacy SQLite schema (pre-migration reference)

# Legacy pre-migration fallback (NOT the running system — see Migration & history):
#   agents/*.py · utils/*.py · ui/app.py · cron/weekly_strategy.sh
#   scripts/seed_*.py · requirements.txt
```

---

## Setup (local development)

**Prerequisites:** Node 20+, npm, and a Supabase project + Anthropic API key.

```bash
# 1. Install dependencies
npm install

# 2. Create .env.local with (see DEPLOY.md for what each is):
#    DATABASE_URL                  # Supabase pooled connection (port 6543)
#    DIRECT_URL                    # Supabase direct connection (for db:push only)
#    SUPABASE_SERVICE_ROLE_KEY
#    ANTHROPIC_API_KEY
#    CRON_SECRET
#    NEXT_PUBLIC_SUPABASE_URL
#    NEXT_PUBLIC_SUPABASE_ANON_KEY
#    ALLOWED_EMAILS               # comma-separated magic-link allow-list

# 3. Push the schema and seed the single-row config tables
npm run db:push        # creates the 8 tables in Supabase (uses DIRECT_URL)
npm run seed           # inserts settings + brand_voice (⚠ confirm placeholders first)

# 4. Run the app
npm run dev            # http://localhost:3000  → redirects to /login
```

`npm run build` / `npx tsc --noEmit` must stay green. Other scripts: `npm run lint`,
`npm run db:generate` (Drizzle migration files), `npm start` (prod server).

> ⚠️ **Placeholders to confirm with the artist** before relying on the output:
> `brand_voice.snail_mail_pitch`, `brand_voice.avoid_phrases`, `settings.default_post_time`,
> and the feature tunables `settings.monthly_budget_usd` and `settings.weekly_mix`
> (see `scripts/seed.ts` and FEATURES.md §1) are sensible starter guesses, not confirmed
> values.

---

## Daily / weekly workflow

1. **Monday (automatic).** Vercel cron hits `/api/cron/weekly-strategy` and a fresh week
   of slots is waiting. (Manual fallback: **Run weekly plan now** on `/calendar`.)
2. **Pick a slot, attach art.** On `/calendar`, upload the day's drawing to a slot. The
   file goes straight to Supabase Storage; this creates the draft and enables
   **Generate draft**.
3. **Generate draft.** The Content Agent looks at the actual art and fills in hashtags,
   a CTA suggestion, and (for reels) a hook + outline. The caption stays empty.
4. **Write the caption & approve.** On `/review`, write your own caption, tweak
   hashtags/CTA if you like, and **Approve** (a caption is required). This triggers the
   Distribution Agent, which writes the posting checklist. *(If caption starters are
   enabled, a "Need a starting line?" button offers a few opening lines — read-only; you
   still write the caption.)*
5. **Post it.** On `/engagement`, the approved post shows its checklist. Post it on
   Instagram by hand, then **Mark as posted**.
6. **Enter the numbers.** Enter **saves + reach** (required) and, optionally,
   likes/comments/**shares**. This powers next week's plan; the banner nags until every
   posted item has saves + reach. Log new mailing-list subscribers here too.
7. **See what's working.** `/insights` ranks formats, weekdays, and top posts by a
   saves-and-shares score, shows which CTA types convert to subscribers, and offers an
   on-demand **"Reuse your hits"** button.

---

## Features (post-migration)

`FEATURES.md` is the source of truth for *what and why*; `FEATURES_PLAN.md` tracks *how*
and *status*. All of §2–§9 are built:

| # | Feature | Where | API cost |
|---|---------|-------|----------|
| 2 | "What's working" insights | `/insights` + `lib/db` aggregates | $0 |
| 3 | Lower engagement-entry friction (saves+reach only; `shares` added) | `/engagement` | $0 |
| 4 | Owned-audience (subscriber) attribution | `/engagement` + `/insights` | $0 |
| 5 | Content-mix targets (`weekly_mix`) | Strategy prompt + validation | $0 extra |
| 6 | Right-size web search (`web_search_cadence`, monthly default) | Strategy gate | **−** |
| 7 | Cost meter (`usage_log` + budget banner) | `lib/claude.ts`, `(app)/layout.tsx` | negligible |
| 8 | "Reuse your hits" (on-demand Haiku) | `/api/insights/reuse` | bounded |
| 9 | Caption starters (flagged, **default off**) | `/api/review/caption-starters` | bounded |

---

## Configuration

Everything tunable lives in the single-row `settings` and `brand_voice` tables — nothing
is hardcoded in the agents. Edit `scripts/seed.ts` and re-run `npm run seed` (it upserts
row `id = 1`):

- **`settings`** — timezone, hashtag count range, default post time, `reels_required`,
  and the feature tunables: `weekly_mix` (§5), `web_search_cadence` + `last_web_search_at`
  (§6), `monthly_budget_usd` (§7), `caption_starters_enabled` (§9, default `false`).
- **`brand_voice`** — artist name, tone, example captions, phrases to avoid, snail-mail
  pitch.

---

## Deploying

See **`DEPLOY.md`** for the full Vercel production runbook (env vars, Supabase auth URLs,
Vercel Pro, cron, smoke test). In short: `npm run db:push` + `npm run seed` against the
prod Supabase, set the seven production env vars, deploy on Vercel Pro, and point Supabase
Auth at the prod domain.

---

## Cost

The hosted baseline is roughly **$23–25/month**, dominated by **Vercel Pro** (~$20) — not
the API. Agent calls are cheap: Content/Distribution use Haiku, Strategy is one weekly
Sonnet call plus (now occasional) web search — each search is a billable line item, so
it's hard-capped at 3 per run and gated to a monthly cadence by default (§6). The §7 cost
meter logs every call to `usage_log` and shows month-to-date spend in a banner, warning
past `settings.monthly_budget_usd`. Net API change from the feature set is ≈ $0, likely
slightly negative.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `ANTHROPIC_API_KEY is not set` | Add a real key to `.env.local` (and to Vercel for prod). |
| `settings row is missing` | Run `npm run seed`. |
| Login link rejected | Add the domain + `/auth/callback` to Supabase Auth URL config; confirm the email is in `ALLOWED_EMAILS` (see DEPLOY.md §5). |
| "Generate draft" does nothing | Attach art to the slot first — the Content Agent reads the actual file. |
| Strategy run times out on Vercel | Needs Vercel **Pro** (`maxDuration = 300`); Hobby caps function duration. |
| Re-running the weekly plan duplicates slots | It doesn't — it's idempotent, replacing the week's *unattached* slots; started drafts are kept. |
| Caption-starters button missing | Expected when `settings.caption_starters_enabled = false` (the default). |

---

## Migration & history

- **`FEATURES.md` / `FEATURES_PLAN.md`** — the post-migration feature work (what/why) and
  its build status.
- **`MIGRATION.md`** — the plan that moved this from local Python/Streamlit/SQLite to the
  hosted Next.js + Supabase stack.
- **`SPEC.md`** — the original build spec for the Python prototype.
- **`PROGRESS.md`** — the per-step build log for that original prototype.

The Python files (`agents/*.py`, `utils/`, `ui/app.py`, `cron/weekly_strategy.sh`,
`scripts/seed_*.py`, `requirements.txt`, `db/init.sql`) are kept as a **legacy fallback**
and reference. They are not deployed and not the running system; per MIGRATION.md the plan
is to remove them once the hosted app is fully trusted.
