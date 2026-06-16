# AUTOMATION_PLAN.md — reduce manual data entry

> **Purpose.** A standalone, implementable plan for cutting the recurring data-entry
> chores in the Be The Goose agent (Instagram stats, products, markets, subscribers).
> Written so it can be executed in a **fresh Claude Code session** with no prior context.
>
> **Status:** none of this is built yet. This is the design + step-by-step build guide.

## How to use this doc in a new session

1. Point the session at this file plus the key source files it references:
   - `lib/db/schema.ts` (Drizzle schema), `lib/db/index.ts` (the only DB gateway),
   - `lib/agents/{strategy,content,distribution}.ts`, `lib/claude.ts` (model + usage log),
   - `app/(app)/engagement/page.tsx` + `_components/NumbersForm.tsx` + `SubscriberForm.tsx`,
   - `app/actions.ts` (server actions), `app/api/cron/weekly-strategy/route.ts` (cron pattern),
   - `vercel.json` (cron registration), `scripts/seed.ts` (config seeding), `DEPLOY.md`.
2. Build the items in the **Build sequence** order at the bottom. Each item is independently
   shippable and independently verifiable.
3. After each item, run `npx tsc --noEmit` and `npm run build` (must stay green), update
   `PROGRESS.md`, and add any new env vars to `.env.local` **and** Vercel + `DEPLOY.md`.

## Design principles to preserve (from FEATURES.md)

- **Automate the *ingest* side, never the *create/publish* side.** She still writes
  captions, approves, and posts to Instagram by hand. Everything here automates data she
  currently *re-types* — it adds no creative or publishing automation.
- **Nothing hardcoded.** New tunables/credentials go in `settings` or a dedicated config
  table, seeded via `scripts/seed.ts` — not literals in the agents.
- **Cost-aware.** The Instagram/Etsy/ESP APIs are free at this scale. Any new model calls
  go through `lib/claude.ts` so they're metered in `usage_log` (there are none in this plan).
- **Fail soft.** A sync failure must never break a page or an agent — catch,
  log, and fall back to the existing manual path (mirror the `logUsage` catch-and-ignore in
  `lib/claude.ts`).

---

## System recap (for a cold-start session)

Stack: **Next.js App Router + TypeScript on Vercel (Pro)**, **Supabase Postgres via Drizzle**
+ Supabase Storage + magic-link auth. Three agents share state only through Postgres:

- **Strategy** (`claude-sonnet-4-6`, weekly cron + button) → writes `calendar` slots.
- **Content** (`claude-haiku-4-5`, per slot after art attached) → fills a `posts` draft
  (hashtags, CTA, reel hook) — **no caption**.
- **Distribution** (`claude-haiku-4-5`, on approval) → posting checklist + market blurb.

The weekly loop: plan → attach art → generate draft → **she writes caption + approves** →
**she posts manually** → **she types the numbers in** (`/engagement`) → `/insights` learns.

**Existing cron pattern** (replicate for new crons): `vercel.json` registers a schedule that
hits a `GET` route under `app/api/cron/...`; the route checks
`Authorization: Bearer ${CRON_SECRET}` before doing work.

**Current env vars** (`.env.local`, mirrored in Vercel): `DATABASE_URL`, `DIRECT_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `CRON_SECRET`, `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `ALLOWED_EMAILS`.

### The manual-entry map (what this plan attacks)

| Manual input | Where today | Frequency | Has a UI? | This plan |
|---|---|---|---|---|
| **IG stats** (saves, reach, likes, comments, shares) | `/engagement` → `NumbersForm` | every post, forever | yes | **#1 auto-pull** |
| Mark as posted | `/engagement` | every post | yes | auto (side-effect of #1) |
| **Products** (drive all CTAs + rotation) | `scripts/seed.ts` only | when shop changes | **none** | **#2 CRUD / #3 sync** |
| **Markets** (drive blurbs + "tease market") | seed only | per event | **none** | **#2 CRUD** |
| Subscribers | `/engagement` → `SubscriberForm` | per signup | yes | **#4 ESP sync (email)** |
| Settings / brand voice | seed + re-run script | rarely | **none** | **#2 CRUD** |

> ⚠️ **Latent gap:** `lib/db/index.ts` has `insertProduct`/`insertMarket` but **nothing calls
> them and there is no screen** — products & markets can only be changed by editing
> `scripts/seed.ts` and re-running `npm run seed`. The README says products are "synced from
> the shop," but no sync exists. The CTA engine and market-blurb feature silently depend on
> data the artist cannot edit. Items #2/#3 fix this.

---

# Item #1 — Auto-pull Instagram stats (the headline win)

**Problem.** Entering saves/reach/likes/comments/shares on `/engagement` is the single
most-repeated chore, required for *every post forever*, and the "you still owe numbers"
banner nags until it's done. Those five fields map **exactly** to five Instagram API metrics.

**Insight that unblocks this.** The README's "API restrictions on personal accounts" only
blocks *posting from a personal account*. **Reading your own insights is fully supported** via
the modern **Instagram API with Instagram Login** (the replacement for the deprecated Basic
Display API). It needs a **Professional/Creator** account (free conversion) but **no linked
Facebook Page**, and **no App Review for a single self-owned account** (run the app in
development mode with the owner as a tester). Meta does not charge for it.

**Bonus benefits:**
1. **Real publish time.** `getEngagementByWeekday()` in `lib/db/index.ts` deliberately avoids
   time-of-day ranking because `posted_at` is the "Mark posted" *click*, not the IG publish
   time. The API returns the real media `timestamp` → unlocks best-time analysis.
2. **Auto "posted" detection** (flip status without the manual click) and **follower-count
   tracking** (charted nowhere today).

### 1A. Instagram API setup — step by step

> These steps reflect Meta's 2026 "Instagram API with Instagram Login" flow. Meta changes
> this often — verify against the live docs as you go:
> - Instagram API with Instagram Login: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/
> - Media insights reference: https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights/
> - Insights overview: https://developers.facebook.com/docs/instagram-platform/insights/

1. **Convert the IG account to Professional.** In the Instagram app: *Settings → Account type
   and tools → Switch to professional account → Creator* (free; reversible). A Facebook Page
   is **not** required for the Instagram-Login path.
2. **Create a Meta app.** Go to https://developers.facebook.com/apps → *Create app* → use case
   **"Other" → Business** (or the "Instagram" use case if offered). Note the **App ID** and
   **App Secret** (*App settings → Basic*).
3. **Add the Instagram product.** In the app dashboard, add **Instagram** → choose
   **"Instagram API setup with Instagram login"** (the business-login variant, *not* the old
   Basic Display).
4. **Configure business login / OAuth.** Under Instagram → API setup with Instagram login:
   - Set **Valid OAuth Redirect URIs** to your callback, e.g.
     `https://<your-vercel-domain>/api/instagram/callback` (and a localhost variant for dev).
   - Request scopes: **`instagram_business_basic`** and **`instagram_business_manage_insights`**
     (add `instagram_business_content_publish` only if you ever opt into auto-publish — not in
     this plan).
5. **Add yourself as a tester.** App **Roles → add the IG account as an Instagram tester**, and
   accept the invite from the IG account (Instagram app → *Settings → Apps and websites →
   Tester invites*). In **development mode** the owner/tester can read their own data with **no
   App Review**.
6. **Get a token (one-time OAuth).** Either use Meta's token generator in the dashboard, or run
   the OAuth flow yourself:
   - Authorize URL (opens IG consent):
     `https://www.instagram.com/oauth/authorize?client_id=<APP_ID>&redirect_uri=<REDIRECT>&response_type=code&scope=instagram_business_basic,instagram_business_manage_insights`
   - Exchange `code` → **short-lived token** (POST `https://api.instagram.com/oauth/access_token`
     with `client_id`, `client_secret`, `grant_type=authorization_code`, `redirect_uri`, `code`).
   - Exchange short-lived → **long-lived (60-day) token**:
     `GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=<APP_SECRET>&access_token=<SHORT_TOKEN>`
   - This also returns your `user_id`. Store both (see schema below).
7. **Keep the token alive.** Long-lived tokens last ~60 days and must be refreshed *before*
   expiry: `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=<LONG_TOKEN>`.
   The weekly cron (1D) will do this automatically.
8. **The data endpoints** (host `https://graph.instagram.com`, append `access_token=`):
   - List recent media: `GET /me/media?fields=id,caption,media_type,permalink,timestamp`
   - Per-post metrics: `GET /{ig-media-id}/insights?metric=reach,saved,likes,comments,shares,total_interactions`
     (metric availability varies by media type — feed vs reel vs carousel; check the reference
     doc and degrade gracefully if a metric is absent).
   - Account/followers: `GET /me?fields=user_id,username,followers_count,media_count`
9. **New env vars** (add to `.env.local`, Vercel, and `DEPLOY.md`):
   - `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `INSTAGRAM_REDIRECT_URI`
   - (The access token + user id are stored in the DB by the OAuth callback, not in env — see 1B.)

### 1B. Schema additions (`lib/db/schema.ts` + `npm run db:push`)

```text
-- single-row Instagram connection (id = 1), mirrors the settings/brand_voice pattern
instagram_account (
  id               bigint primary key check (id = 1),
  ig_user_id       text not null,
  username         text,
  access_token     text not null,         -- long-lived; refreshed by cron
  token_expires_at text,                  -- ISO; refresh before this
  followers_count  integer,
  synced_at        text                   -- ISO of last successful sync
)

-- posts: link a post to its published IG media + the REAL publish time
ALTER posts ADD COLUMN ig_media_id   text;   -- set when matched
ALTER posts ADD COLUMN published_at  text;   -- real IG timestamp (not the "mark posted" click)
ALTER posts ADD COLUMN stats_synced_at text; -- ISO; null until insights pulled

-- optional: follower growth over time (charted on /insights)
follower_snapshots (
  id              bigint generated always as identity primary key,
  captured_at     text not null,          -- ISO
  followers_count integer not null
)
```

> Token-at-rest note: storing the access token in Postgres is acceptable for a single-user app
> behind magic-link auth + RLS-off service role. If you want defense-in-depth, encrypt it with a
> key from env before insert. Don't expose it to any client component.

### 1C. Implementation

- **`lib/instagram.ts`** (new, server-only — like `lib/claude.ts`): a thin client.
  - `getConnection()` / `saveConnection()` (read/write the single `instagram_account` row).
  - `refreshTokenIfNeeded()` — refresh when `token_expires_at` is < ~7 days away.
  - `listRecentMedia(sinceIso?)`, `getMediaInsights(igMediaId)`, `getAccount()`.
  - Defensive parsing + one retry, fail-soft (return null, never throw into a page).
- **OAuth callback route** `app/api/instagram/callback/route.ts` — handles step 6's redirect,
  does the short→long exchange, writes `instagram_account`. Guard so only an authed admin can
  complete it. A "Connect Instagram" button on a settings page kicks off the authorize URL.
- **Post↔media matching** (she posts manually, so we match after the fact):
  - **Primary (zero extra taps):** in the sync cron, call `listRecentMedia(since=post.postedAt)`
    and match the approved/posted post by **caption equality/similarity** and/or **nearest
    timestamp**. On match, set `ig_media_id`, `published_at`, and flip `status='posted'` if not
    already. Be conservative — only auto-match high-confidence pairs; leave the rest manual.
  - **Fallback (one paste):** add an optional "IG post link" field to `MarkPostedButton` /
    engagement card; match the pasted `permalink` against `listRecentMedia()` to resolve the
    media id deterministically.
- **Stats sync cron** `app/api/cron/instagram-sync/route.ts` (GET, `CRON_SECRET`-guarded;
  register in `vercel.json`, suggest daily):
  1. `refreshTokenIfNeeded()`.
  2. For posts with `ig_media_id` set, `status='posted'`, and (`stats_synced_at` null **or**
     `published_at` < ~7 days ago — metrics keep maturing), call `getMediaInsights` and write
     `saves/reach/likes/comments/shares` via the existing `updateEngagement` path (add a variant
     that doesn't require the manual saves+reach guard, or reuse `updatePost`). Stamp
     `stats_synced_at`.
  3. For posts that are `posted` but have no `ig_media_id`, attempt matching (above).
  4. `getAccount()` → update `instagram_account.followers_count` + insert a `follower_snapshots`
     row.
- **UI changes:**
  - `NumbersForm` / `/engagement`: keep the manual form as **override/fallback**; show a
    "synced from Instagram ✓ (<date>)" badge when `stats_synced_at` is set, and pre-fill the
    fields with the synced values (still editable).
  - Banner: `getPostsMissingEngagement()` in `lib/db/index.ts` already keys off null
    saves/reach — once sync fills them, the banner self-clears. No change needed, but consider
    excluding posts whose sync is pending (< 48h old) so it doesn't nag during the maturation
    window.
  - `/insights`: now that `published_at` exists, you *can* add the time-of-day ranking the code
    currently refuses (update the comment + `getEngagementByWeekday` to prefer `published_at`),
    and add a follower-growth sparkline from `follower_snapshots`.

**Verify:** connect a test/own account; post something; run the sync cron manually; the post's
five metrics populate, `published_at` is the real IG time, the banner clears, follower count and
a snapshot row appear. Disconnecting or an API error leaves the manual form fully working.

**Effort:** ~1–2 days (most of it is the one-time Meta app + OAuth callback; the sync logic is small).

---

# Item #2 — CRUD screens for products, markets, settings & brand voice

**Problem.** Products, markets, settings, and brand voice are **seed-only** — editable only by
changing `scripts/seed.ts` and re-running `npm run seed`. The CTA engine (products) and the
market-blurb/"tease the market" features (markets) silently depend on data the artist can't edit.

**Solution.** Authed CRUD pages under `app/(app)/`, reusing existing db helpers and adding the
missing ones. No API/model cost.

### Implementation

- **DB helpers to add in `lib/db/index.ts`** (insert helpers already exist):
  - Products: `getAllProducts()`, `updateProduct(id, fields)`, `setProductActive(id, bool)`.
  - Markets: `getAllMarkets()`, `updateMarket(id, fields)`, `deleteMarket(id)` (or status-based).
  - Settings/brand voice: `updateSettings()` exists; add `updateBrandVoice(fields)`.
- **Pages** (RSC + server actions in `app/actions.ts`, behind the existing auth middleware):
  - `app/(app)/products/page.tsx` — list/add/edit/deactivate; fields: name, url,
    type (`print|sticker|craft|snail_mail`), active. (`lastPromotedAt` stays agent-managed.)
  - `app/(app)/markets/page.tsx` — list/add/edit; fields: name, location, eventDate,
    applicationDeadline, status (`considering|applied|accepted|rejected|attended`), notes.
    Show the agent's `draftApplication` read-only.
  - `app/(app)/settings/page.tsx` — edit `settings` (timezone, hashtag range, default post time,
    `reels_required`, `weekly_mix`, `web_search_cadence`, `monthly_budget_usd`,
    `caption_starters_enabled`) and `brand_voice` (name, tone, example captions, avoid phrases,
    snail-mail pitch). This is also where the **"Connect Instagram"** button (Item #1) lives.
  - Add these to `NavLinks.tsx`.
- Respect existing CHECK constraints (the server actions should validate enum values before write,
  mirroring `CTA_OPTIONS` in `app/actions.ts`).

**Verify:** add a product via the UI → it appears in `getActiveProducts()` and the Content Agent
can pick it as a CTA target; add a market with a near deadline → the Distribution Agent drafts a
blurb on the next approval; edit `weekly_mix` → the next Strategy run honors it.

**Effort:** ~1 day.

---

# Item #3 — Shop product sync (optional, once platform is known)

**Problem.** Even with #2's CRUD, products drift out of date as the shop changes.

**Solution.** Pull active listings from the shop's free API into the `products` table.
**Decision needed:** which platform is the shop on? Outline per platform:

- **Etsy** (Open API v3): register an app (https://www.etsy.com/developers), OAuth2 for read
  scope, `GET /v3/application/shops/{shop_id}/listings/active` → map each listing to a product
  (`name`=title, `url`=listing url, `type` inferred from taxonomy/tags, `active`=true). Store
  `etsy_listing_id` on products to upsert idempotently.
- **Shopify**: a custom-app Admin API token, `GET /admin/api/<ver>/products.json` → same mapping.
- **Square / Big Cartel / Gumroad**: each has a products/items endpoint; same upsert pattern.

Implement as `lib/shop.ts` + a `app/api/cron/shop-sync/route.ts` (daily, `CRON_SECRET`-guarded)
that upserts by external id and deactivates products no longer present. Keep manual CRUD (#2) as
the source of truth for `type` overrides.

**Verify:** add/remove a listing in the shop → after the cron, `products` reflects it; CTAs only
point at in-stock items.

**Effort:** ~1 day per platform once the platform is confirmed. **Blocked on:** which shop platform?

---

# Item #4 — Email-subscriber sync (optional)

**Problem.** Email subscribers are hand-entered in `SubscriberForm`. Snail-mail is genuinely
offline (keep manual), but the email channel likely lives on a real ESP.

**Solution.** A webhook (or daily pull) from the ESP → `insertSubscriberEvent({channel:'email', count, note})`.

- **Decision needed:** which ESP? Buttondown, Kit (ConvertKit), Mailchimp, and MailerLite all
  have free webhooks/APIs with new-subscriber events + timestamps.
- Implement `app/api/webhooks/<esp>/route.ts` (POST; verify the ESP's signing secret) → on a
  `subscriber.created` event, call the existing `insertSubscriberEvent`. Attribution to a
  `sourcePostId` stays manual/unknown unless the ESP passes a referrer.
- Snail-mail subscribers that come through the shop (a recurring product) can instead be picked
  up by the Item #3 shop sync.

**Verify:** a test signup in the ESP creates a `subscriber_events` row with channel `email`; the
`/insights` subscriber panel updates.

**Effort:** ~half a day once the ESP is confirmed. **Blocked on:** which ESP?

---

# Explicitly NOT in scope (by design)

- **Auto-writing captions** — she writes them (FEATURES.md principle #4).
- **Auto-approving** — human-in-the-loop is the point.
- **Auto-publishing to Instagram** — technically possible on a Creator account via the Content
  Publishing API (`instagram_business_content_publish`), but it contradicts the product's whole
  philosophy. Leave it out, or at most a future opt-in flag — not part of this plan.

---

# Build sequence (each step independently shippable & verifiable)

1. **Item #2 — CRUD screens.** Closes the "seed-only, no UI" gap; should exist regardless;
   provides the settings page that hosts the "Connect Instagram" button. ~1 day.
2. **Item #1 — Instagram stats auto-pull.** The headline win; depends on the Meta app + the
   settings page from #2. ~1–2 days.
3. **Item #3 — Shop product sync.** *Blocked on platform choice.* ~1 day.
4. **Item #4 — Email-subscriber sync.** *Blocked on ESP choice.* ~half a day.

After each: `npx tsc --noEmit` + `npm run build` green, update `PROGRESS.md`, add new env vars to
`.env.local` + Vercel + `DEPLOY.md`, and register any new cron in `vercel.json`.

## Open questions to confirm with the artist before building #3/#4

- Which platform is the **online shop** on? (Etsy / Shopify / Square / Big Cartel / Gumroad / other)
- Which **email list / ESP**, if any? (Buttondown / Kit / Mailchimp / MailerLite / none)
- Is the **snail-mail subscription** sold as a recurring product in the shop, or tracked offline?
- Confirm she'll convert the IG account to a **Creator** account (required for Item #1).

## Reference links

- Instagram API with Instagram Login: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/
- Media insights reference: https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights/
- Insights overview: https://developers.facebook.com/docs/instagram-platform/insights/
- IG Graph API 2026 guide (background): https://elfsight.com/blog/instagram-graph-api-complete-developer-guide-for-2026/
- Etsy Open API v3: https://developers.etsy.com/documentation/
