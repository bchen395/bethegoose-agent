-- 2026-06-18 — Drop columns orphaned by the pipeline simplification.
--
-- These columns are no longer read or written by any code (the Content +
-- Distribution agents, in-app drafts/captions, photo upload, and the §9
-- caption-starters flag were all removed). Dropping them is the schema half of
-- the "delete the dead layer" cleanup; the code half is already in this commit.
--
-- HOW TO APPLY (this repo applies schema via db:push, not a migration journal):
--   Option A — run `npm run db:push`; drizzle-kit will detect exactly these
--              drops from lib/db/schema.ts and prompt to apply them.
--   Option B — run this file directly against the database (psql / Supabase SQL
--              editor) if you'd rather apply the delta explicitly.
-- Either way, REVIEW FIRST: DROP COLUMN is irreversible and discards any data in
-- these columns. They are confirmed empty/unused, but confirm against prod.

ALTER TABLE posts
  DROP COLUMN IF EXISTS art_filename,
  DROP COLUMN IF EXISTS hashtags,
  DROP COLUMN IF EXISTS cta_suggestion,
  DROP COLUMN IF EXISTS product_id,        -- drops the FK to products(id) with it
  DROP COLUMN IF EXISTS reel_script,
  DROP COLUMN IF EXISTS agent_reasoning,
  DROP COLUMN IF EXISTS posting_checklist;

ALTER TABLE markets
  DROP COLUMN IF EXISTS draft_application;

ALTER TABLE settings
  DROP COLUMN IF EXISTS caption_starters_enabled;
