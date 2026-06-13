# DEPLOY.md — Vercel production deploy (MIGRATION.md Step 8)

The port (steps 0–7) is code-complete and `next build` is clean. This runbook covers
going live on Vercel. Steps marked **(you)** are interactive (login / payment / dashboard)
and must be run by a human; everything else is scripted.

Repo: `git@github.com:bchen395/bethegoose-agent.git` (branch `main`).

---

## 0. One-time prerequisites

```bash
npm i -g vercel        # or use `npx vercel ...` everywhere below
vercel login           # (you) opens a browser — run as: ! vercel login
```

---

## 1. Make sure the database is live (run locally, once)

The app reads through the **pooled** `DATABASE_URL`; `db:push` uses the **direct**
`DIRECT_URL`. Both are already in `.env.local`. This hits the **production Supabase DB.**

```bash
npm run db:push        # creates the 8 tables in Supabase (uses DIRECT_URL)
npm run seed           # inserts settings + brand_voice (+ confirm placeholders first)
```

> ⚠️ Confirm the placeholder seed values with the artist before seeding for real:
> snail-mail pitch, avoid phrases, default post time, and the new `monthly_budget_usd`
> / `weekly_mix` defaults (see FEATURES.md §1).

---

## 2. Link the project to Vercel

Pick **one** path.

**A. Git import (recommended — gives auto-deploy on push):** **(you)**
In the Vercel dashboard → *Add New → Project* → import `bchen395/bethegoose-agent`.
Framework auto-detects as Next.js. Don't deploy yet — set env vars first (step 3).

**B. CLI link:**
```bash
vercel link            # (you) pick scope + project name
```

---

## 3. Set environment variables (production scope)

Seven vars go to Vercel. **`DIRECT_URL` is intentionally excluded** — it's only for local
`db:push`. The helper reads `.env.local` and pipes each value to `vercel env add`, so no
secret is printed.

```bash
bash scripts/vercel-env.sh production
```

Vars set: `DATABASE_URL` (pooled 6543), `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`,
`ANTHROPIC_API_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`ALLOWED_EMAILS`.

> Preview deployments won't have these secrets (production scope only) — that's
> deliberate: previews can't spend API budget or touch the prod DB. Add `preview` scope
> later only if you want working preview envs.

---

## 4. Upgrade to Vercel Pro **(you)**

Required for two reasons:
- The Strategy/cron/agent routes set `export const maxDuration = 300`; Hobby caps function
  duration well below that.
- Commercial use (tied to the art business) requires a paid plan per Vercel's terms.

Dashboard → project/team → *Settings → Plan → Pro* ($20/mo).

---

## 5. Configure Supabase Auth for the prod domain **(you)** — easy to forget

Magic-link login derives its redirect from the request origin (`window.location.origin`
+ `/auth/callback`), so it adapts to the Vercel URL — **but Supabase rejects redirects not
on its allow-list.** In the Supabase dashboard → *Authentication → URL Configuration*:
- **Site URL:** `https://<your-vercel-domain>`
- **Redirect URLs:** add `https://<your-vercel-domain>/auth/callback`
  (add the `*.vercel.app` preview pattern too only if you enabled preview env vars).

Also confirm **email signups are disabled** / the allow-list (`ALLOWED_EMAILS`) is the gate
— only allow-listed emails (`bchen395@gmail.com` today) can sign in.

---

## 6. Deploy

```bash
vercel --prod          # CLI path
# or: git push origin main   (Git-import path auto-deploys)
```

---

## 7. Post-deploy smoke test (on the production URL)

1. Visit the URL → redirected to `/login`.
2. Sign in with an allow-listed email → magic link → lands on `/calendar`.
3. Walk `/calendar → /review → /engagement`; banners render; data loads.
4. "Run weekly plan now" completes within 300s and writes calendar slots.
5. Cron route responds to the secret (Vercel sends it; this is the manual equivalent):
   ```bash
   curl -i https://<domain>/api/cron/weekly-strategy \
     -H "Authorization: Bearer $CRON_SECRET"
   ```
   Expect 200 + a fresh week of slots; without the header expect 401.

---

## Gotchas (recap from MIGRATION.md §13)

- **Region:** Vercel default `iad1` ≈ Supabase `aws-1-us-east-1` — already aligned; keep it.
- **Cron is UTC:** `0 12 * * 1` ≈ Mon 08:00 America/New_York (EDT); drifts ±1h at DST. Fine
  for a weekly plan.
- **Supabase free tier pauses after ~7 days idle:** her weekly use + the weekly cron should
  keep it warm; if it pauses, add a keep-alive cron or go Supabase Pro.
- **Body limit:** uploads go browser→Supabase direct (signed URL), never through a function.

---

## Step 9 — Cutover (after a week of confidence)

Keep the Python app runnable as a fallback. Once the hosted app is trusted, remove
`agents/*.py`, `ui/`, `utils/`, `scripts/*.py`, `cron/`, `db/init.sql`, `requirements.txt`,
and update `README.md`. Then FEATURES.md §2–§9 ships on the new stack.
