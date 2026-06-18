# INSTAGRAM_SETUP.md — connect Instagram for auto metrics

One-time setup so the app can **read your own Instagram insights** — post metrics
(saves, reach, likes, comments, shares), real publish times, and follower count. The
daily `instagram-sync` cron then ingests your recent posts and fills these in
automatically; no hand-typing.

**This only reads.** It never posts, writes captions, or generates CTAs — you do all of
that by hand. (Auto-publishing would need a different scope and is deliberately out of
scope.)

> Meta changes this flow often. If a screen name doesn't match, check the live docs
> (links at the bottom) — the **concepts** below stay the same.

**Time:** ~20 minutes, mostly clicking around the Meta dashboard. You only do it once.

---

## Prerequisites

- Admin access to the Instagram account.
- The app already deployed (or running locally) — you need its domain for the redirect URI.
- The code for this integration is already built (`lib/instagram.ts`, the OAuth callback,
  the sync cron). **You are only doing the external Meta setup + filling in three secrets.**

---

## Step 1 — Convert Instagram to a Professional (Creator) account

In the Instagram app: **Settings → Account type and tools → Switch to professional account
→ Creator**. It's free and reversible. A linked Facebook Page is **not** required.

(Reading insights needs a Professional/Creator account — this is the only account change.)

---

## Step 2 — Create a Meta app

1. Go to <https://developers.facebook.com/apps> → **Create app**.
2. Use case: **"Other" → Business** (or pick the **Instagram** use case if offered).
3. Once created, open **App settings → Basic** and copy the **App ID** and **App Secret** —
   you'll paste these into env vars in Step 5.

---

## Step 3 — Add the Instagram product (Instagram Login variant)

1. In the app dashboard, add the **Instagram** product.
2. Choose **"Instagram API setup with Instagram login"** — the business-login variant.
   **Not** the old "Basic Display" (deprecated).

---

## Step 4 — Configure OAuth (redirect URI + scopes)

Under **Instagram → API setup with Instagram login**:

- **Valid OAuth Redirect URIs** — add your callback URL exactly:
  - Production: `https://<your-vercel-domain>/api/instagram/callback`
  - Local dev (optional): `http://localhost:3000/api/instagram/callback`
- **Scopes** — request:
  - `instagram_business_basic`
  - `instagram_business_manage_insights`

  (Do **not** add `instagram_business_content_publish` — that's for auto-posting, which this
  app intentionally doesn't do.)

> The redirect URI must match `INSTAGRAM_REDIRECT_URI` (Step 5) **character-for-character**,
> including `https://` and no trailing slash.

---

## Step 5 — Add the env vars

Put these three values where the app runs. **Local** (`.env.local`):

```
INSTAGRAM_APP_ID=<your App ID>
INSTAGRAM_APP_SECRET=<your App Secret>
INSTAGRAM_REDIRECT_URI=https://<your-vercel-domain>/api/instagram/callback
```

(For local testing use the `http://localhost:3000/...` redirect instead, and make sure that
exact URL is also in the app's Valid OAuth Redirect URIs from Step 4.)

**Production** — push them to Vercel:

```bash
bash scripts/vercel-env.sh production
```

> The access token and IG user id are **not** env vars — the OAuth callback (Step 7) writes
> them into the `instagram_account` row in the database, and the daily cron refreshes the
> token automatically.

---

## Step 6 — Add yourself as a tester

In **development mode**, the app owner/tester can read their **own** data with **no App
Review** — so you don't need Meta to approve anything for a single self-owned account.

1. App dashboard → **App roles → Roles** → add the Instagram account as an **Instagram
   tester**.
2. Accept the invite from the Instagram side: Instagram app → **Settings → Apps and websites
   → Tester invites** → accept.

---

## Step 7 — Connect in the app

1. Open the app → **Settings** (`/settings`).
2. Click **Connect Instagram**. You'll be sent to Instagram's consent screen; approve.
3. You're redirected back and the Settings panel shows **"✅ Connected as @yourhandle"**.

That's it. The daily `instagram-sync` cron now pulls your recent posts + metrics.

---

## Step 8 — Verify

- On `/settings`, the panel reads **Connected as @…**.
- Trigger a sync manually (Vercel cron does this daily on its own):
  ```bash
  curl -i https://<your-vercel-domain>/api/cron/instagram-sync \
    -H "Authorization: Bearer $CRON_SECRET"
  ```
  Expect `200` with `{ ok: true, ingested, statsSynced, followers }`.
- On `/engagement`, your recent Instagram posts appear (read-only) with a **"synced from
  Instagram ✓"** badge and their metrics. The "you still owe numbers" banner clears as
  metrics fill in.
- On `/insights`, the weekday ranking uses real publish day and a follower-growth sparkline
  appears once there are ≥2 snapshots.

---

## How it works (for debugging)

The app does the OAuth token exchange for you when you click Connect; you don't need to run
these by hand, but they're useful if something looks off. Host: `https://graph.instagram.com`,
append `access_token=`:

- Authorize (what "Connect" opens):
  `https://www.instagram.com/oauth/authorize?client_id=<APP_ID>&redirect_uri=<REDIRECT>&response_type=code&scope=instagram_business_basic,instagram_business_manage_insights`
- `code` → short-lived token: `POST https://api.instagram.com/oauth/access_token`
- short-lived → long-lived (~60-day) token: `GET /access_token?grant_type=ig_exchange_token&client_secret=<APP_SECRET>&access_token=<SHORT>`
- Refresh (cron does this before expiry): `GET /refresh_access_token?grant_type=ig_refresh_token&access_token=<LONG>`
- Recent media: `GET /me/media?fields=id,caption,media_type,media_product_type,permalink,timestamp`
- Per-post metrics: `GET /{ig-media-id}/insights?metric=reach,saved,likes,comments,shares,total_interactions`
- Account: `GET /me?fields=user_id,username,followers_count,media_count`

Metric availability varies by media type (feed vs reel vs carousel); the app degrades
gracefully when a metric is absent and leaves the manual numbers form as a fallback.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Connect redirects to `/login` instead of finishing | Meta's redirect didn't carry your session cookie. Make sure you're logged into the app first; if it persists it's the documented edge case — the callback route comments describe the `state`-nonce fallback. |
| "Couldn't connect Instagram" on return | `INSTAGRAM_REDIRECT_URI` doesn't exactly match the app's Valid OAuth Redirect URI, or the App ID/Secret are wrong. Re-check Steps 4–5. |
| Sync returns `{ ok:false, "Instagram not connected" }` | Finish Step 7 (Connect) first. |
| Metrics not appearing | Account must be **Professional/Creator** (Step 1) and you must be an accepted **tester** (Step 6). Then run the sync (Step 8). |
| Connected, then stopped working after ~2 months | The long-lived token lapsed (the app sat unused past ~60 days, so the cron couldn't refresh it). Just click **Connect Instagram** again. |

---

## Reference links

- Instagram API with Instagram Login: <https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/>
- Media insights reference: <https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights/>
- Insights overview: <https://developers.facebook.com/docs/instagram-platform/insights/>
