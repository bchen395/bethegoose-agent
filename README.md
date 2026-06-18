# Be The Goose — Art Business Agent

A planning + insights tool for a one-person indie art business growing on Instagram
and driving sales to an online shop and in-person art markets. A **Strategy Agent**
suggests a weekly posting plan; **the artist makes, captions, and posts everything
herself.** Post metrics then sync back automatically from the Instagram API.

Nothing posts to Instagram automatically, and the app writes no captions or CTAs — it
suggests *what kind of post* to make each day, then learns from how each post performs.

> Built for an artist with **under 1K followers**, ~3 posts/week of original comics,
> doodles, and stickers, who also sells prints, crafts, and a monthly snail-mail
> subscription.

> **Stack:** this is a hosted **Next.js (App Router) + TypeScript** app on **Vercel**,
> with **Supabase** Postgres (via Drizzle) + magic-link auth, the **Instagram API** for
> post metrics, and **Stripe** for shop-product sync. It was ported from an earlier local
> Python/Streamlit/SQLite prototype — see [Migration & history](#migration--history). The
> Python code is retained in-repo as a fallback only; it is **not** the running system.

---

## What it does (and doesn't)

**It does:**
- Suggest a weekly content calendar (3–4 slots) from her own engagement data — each slot
  is a *type of post*: format, theme, content idea, suggested time — with a deliberate
  **format mix** (reels for reach, carousels for saves) and **occasional** web search.
- **Auto-pull post metrics from Instagram** (saves, reach, likes, comments, shares) plus
  the real publish time and follower count — no hand-typing. (A manual form remains as a
  fallback for any metric the API omits.)
- Surface **what's working** — top formats, weekdays, posts ranked by a saves-and-shares
  score, follower growth — plus **subscriber attribution** (which CTA types convert).
- Keep a shop-product list (synced from Stripe) and art-market list as planning context,
  and meter its own API spend; on demand, suggest ways to **reuse her top posts**.

**It does NOT:**
- Post to Instagram automatically — **she posts.** The Instagram integration only *reads*
  her own insights.
- Write captions or generate CTAs — **she does both by hand.** The app suggests the kind
  of post, not its words.
- Scrape competitor accounts or use any paid third-party API beyond Anthropic + the
  hosting stack (Vercel + Supabase + Stripe + the free Instagram API).

---

## Architecture

One **Strategy Agent** plans forward; the **Instagram sync** fills in actuals. They share
state **only** through one Postgres database (Supabase). A Next.js App Router app is the
human surface; the agent run + the daily syncs are route handlers (so they can set
`maxDuration`), and short mutations are server actions.

```
[Inputs]  Past posts · Shop products (Stripe) · Market history · Settings
                              |
                              v
        [Shared memory — Supabase Postgres, via Drizzle (lib/db)]
  settings · posts · calendar · products · markets · brand_voice
  subscriber_events · usage_log · instagram_account · follower_snapshots
              |                                      ^
              v                                      |
     [Strategy Agent]                      [Instagram sync — daily cron]
     claude-sonnet-4-6                      lib/instagram.ts (reads insights)
     weekly calendar suggestions            ingests media as posted rows +
              |                              metrics + follower snapshots
              |______________________________________|
                              |
                              v
        [Human surface — Next.js app (app/(app)) on Vercel]
   /calendar · /engagement · /insights · /products · /markets · /settings
                              |
                              v
   [She posts by hand on IG → metrics sync back → Strategy + Insights learn]
```

| Component | Model / API | When it runs | What it produces |
|---|---|---|---|
| **Strategy Agent** (`lib/agents/strategy.ts`) | `claude-sonnet-4-6` | Weekly (Vercel cron + UI button) | The week's `calendar` slots (format/theme/idea/time); leads with first-party engagement, honors `weekly_mix`, web search gated by `web_search_cadence` (≤3 searches) |
| **Instagram sync** (`lib/instagram.ts`) | Instagram API (free) | Daily (Vercel cron) | Ingests recent media as `posted` rows + the five metrics + follower snapshots; refreshes the token |
| **Shop sync** (`lib/shop.ts`) | Stripe API (free reads) | Daily (Vercel cron) | Upserts the `products` catalog from Stripe |

Model calls go through `lib/claude.ts` with **forced tool-use / JSON output**, defensive
parsing, and one retry; on final failure they write nothing and surface a clear error.
Every billed call is logged to `usage_log` with an estimated cost (§7). The Instagram and
Stripe syncs are plain HTTP, free, and **fail-soft** (an error no-ops and leaves the manual
paths intact).

---

## Project layout

```
bethegoose-agent/
├── README.md                  # this file
├── FEATURES.md                # post-migration feature spec (what/why) — source of truth
├── FEATURES_PLAN.md           # how the features are built + live status tracker
├── DEPLOY.md                  # Vercel production deploy runbook
├── INSTAGRAM_SETUP.md         # one-time Instagram/Meta setup (for the metrics sync)
├── package.json               # next / drizzle / supabase / anthropic / stripe
├── drizzle.config.ts          # points at lib/db/schema.ts (uses DIRECT_URL)
├── vercel.json                # crons: weekly-strategy, shop-sync, instagram-sync
├── proxy.ts                   # auth middleware (guards the (app) routes)
├── .env.local                 # secrets (gitignored) — see Setup
├── lib/
│   ├── db/
│   │   ├── schema.ts          # Drizzle schema (10 tables)
│   │   └── index.ts           # the only gateway to Postgres (typed helpers)
│   ├── claude.ts              # shared API client + web search + forced-JSON + cost meter
│   ├── instagram.ts           # Instagram API reader (token + media + insights) — fail-soft
│   ├── shop.ts                # Stripe catalog reader — fail-soft
│   ├── agents/strategy.ts     # the one agent
│   └── supabase/{server,client}.ts
├── app/
│   ├── (auth)/login/          # magic-link login
│   ├── (app)/                 # authed views + layout (banners)
│   │   ├── calendar/  engagement/  insights/  products/  markets/  settings/
│   │   └── _components/        # client components (forms, buttons, cards)
│   ├── api/
│   │   ├── strategy/run/                 # POST — run the weekly plan
│   │   ├── instagram/callback/           # GET  — Instagram OAuth callback
│   │   ├── cron/weekly-strategy/         # GET  — Vercel cron (CRON_SECRET)
│   │   ├── cron/shop-sync/               # GET  — Vercel cron: Stripe → products
│   │   ├── cron/instagram-sync/          # GET  — Vercel cron: IG media + metrics
│   │   └── insights/reuse/               # POST — §8 reuse suggestions (Haiku)
│   └── actions.ts             # server actions (numbers fallback, subscribers, CRUD…)
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
#    STRIPE_SECRET_KEY            # restricted read-only key (shop sync)
#    INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET / INSTAGRAM_REDIRECT_URI  # Meta app (IG sync)

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
   of *suggestions* is waiting on `/calendar` — each slot says what kind of post to make,
   when, and why. (Manual fallback: **Run weekly plan now**.)
2. **Make & post it — by hand.** Use a slot as a prompt: make the art/reel, write the
   caption and any CTA yourself, and post it on Instagram. The app is not in this loop.
3. **Metrics sync back (automatic).** The daily `/api/cron/instagram-sync` pulls your
   recent posts in as records with their real publish time, caption, format, the five
   metrics (saves/reach/likes/comments/shares), and your follower count.
4. **(Rarely) fill a gap.** On `/engagement`, recent posts show read-only with a "synced
   ✓" badge. If Instagram omitted a metric, the manual numbers form is there as a fallback.
   Log new mailing-list subscribers here too.
5. **See what's working.** `/insights` ranks formats, weekdays (by real publish day), and
   top posts by a saves-and-shares score, charts follower growth, shows which CTA types
   convert to subscribers, and offers an on-demand **"Reuse your hits"** button.

> **One-time:** connect Instagram on `/settings` (Creator account + a Meta app — full
> walkthrough in **`INSTAGRAM_SETUP.md`**). Until then the calendar suggestions still work;
> only the metrics sync is idle.

---

## Features (post-migration)

`FEATURES.md` is the source of truth for *what and why*; `FEATURES_PLAN.md` tracks *how*
and *status*. All of §2–§9 are built:

| # | Feature | Where | API cost |
|---|---------|-------|----------|
| 2 | "What's working" insights (+ follower growth) | `/insights` + `lib/db` aggregates | $0 |
| 3 | Engagement auto-pulled from Instagram (manual form is the fallback) | `/engagement` + `instagram-sync` cron | $0 |
| 4 | Owned-audience (subscriber) attribution | `/engagement` + `/insights` | $0 |
| 5 | Content-mix targets (`weekly_mix`) | Strategy prompt + validation | $0 extra |
| 6 | Right-size web search (`web_search_cadence`, monthly default) | Strategy gate | **−** |
| 7 | Cost meter (`usage_log` + budget banner) | `lib/claude.ts`, `(app)/layout.tsx` | negligible |
| 8 | "Reuse your hits" (on-demand Haiku) | `/api/insights/reuse` | bounded |
| Shop sync | Stripe → `products` (Item #3) | `shop-sync` cron, `lib/shop.ts` | $0 |
| IG sync | Instagram → post metrics (Item #1) | `instagram-sync` cron, `lib/instagram.ts` | $0 |

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
Vercel Pro, crons, the Meta/Instagram setup, smoke test). In short: `npm run db:push` +
`npm run seed` against the prod Supabase, push the production env vars
(`bash scripts/vercel-env.sh production`), deploy on Vercel Pro, point Supabase Auth at the
prod domain, and connect Instagram on `/settings` (walkthrough in `INSTAGRAM_SETUP.md`).

---

## Cost

The hosted baseline is roughly **$23–25/month**, dominated by **Vercel Pro** (~$20) — not
the API. Model calls are cheap: the on-demand "reuse your hits" helper uses Haiku, and
Strategy is one weekly Sonnet call plus (occasional) web search — each search is a billable
line item, so it's hard-capped at 3 per run and gated to a monthly cadence by default (§6).
The Instagram and Stripe syncs are free. The §7 cost meter logs every model call to
`usage_log` and shows month-to-date spend in a banner, warning past
`settings.monthly_budget_usd`.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `ANTHROPIC_API_KEY is not set` | Add a real key to `.env.local` (and to Vercel for prod). |
| `settings row is missing` | Run `npm run seed`. |
| Login link rejected | Add the domain + `/auth/callback` to Supabase Auth URL config; confirm the email is in `ALLOWED_EMAILS` (see DEPLOY.md §5). |
| Instagram metrics not syncing | Connect on `/settings`; confirm the IG account is **Professional/Creator** and the Meta app's redirect URI matches `INSTAGRAM_REDIRECT_URI`; trigger `/api/cron/instagram-sync` with the `CRON_SECRET` header. |
| `/engagement` is empty | No posts synced yet — connect Instagram and run the sync; calendar suggestions work regardless. |
| Strategy run times out on Vercel | Needs Vercel **Pro** (`maxDuration = 300`); Hobby caps function duration. |
| Re-running the weekly plan duplicates slots | It doesn't — it's idempotent, replacing the week's slots. |

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
