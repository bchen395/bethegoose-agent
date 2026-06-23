-- 2026-06-23 — Enable Row-Level Security on every public table.
--
-- WHY: Supabase auto-exposes the `public` schema through its PostgREST API. With
-- RLS off, the built-in `anon` / `authenticated` roles (the anon key is public —
-- it ships in the browser bundle as NEXT_PUBLIC_SUPABASE_ANON_KEY) have full
-- read/write/delete on these tables over https://<ref>.supabase.co/rest/v1/...
-- This is the Supabase advisor's "rls_disabled_in_public" warning, and
-- "sensitive_columns_exposed" for instagram_account.access_token (a long-lived
-- OAuth token) — anyone with the project URL could read it.
--
-- SAFE TO APPLY: this app never touches these tables through the REST API. All
-- data access goes through lib/db/index.ts over a DIRECT postgres connection
-- (DATABASE_URL / DIRECT_URL) as the `postgres` role, which has BYPASSRLS = true
-- (and owns the tables). RLS does not apply to that connection. The Supabase JS
-- client (anon key) is used ONLY for auth (magic-link sign-in / getUser).
--
-- Enabling RLS with NO policies = deny-all for anon/authenticated over the API,
-- while the app's direct connection is unaffected. That is exactly the posture we
-- want, so we intentionally add no policies. (Supabase may then show an
-- INFO-level "RLS enabled, no policy" notice — that is expected and benign here;
-- it is not the WARN/ERROR we are clearing.)
--
-- HOW TO APPLY (this repo applies schema by hand, not via a migration journal):
--   Option A — paste this file into the Supabase SQL editor and run it.
--   Option B — run it with psql against DIRECT_URL.
-- Re-runnable: ENABLE ROW LEVEL SECURITY is idempotent (no-op if already on).

ALTER TABLE public.settings            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brand_voice         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posts               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_ideas          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.markets             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriber_events   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_log           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instagram_account   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.follower_snapshots  ENABLE ROW LEVEL SECURITY;
