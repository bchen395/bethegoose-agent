# Implementation Progress

Tracks the build of the Art Business Agent system. **`SPEC.md` is the source of
truth** — this file only records what's done, how to verify it, and what's next.
The build order below mirrors `SPEC.md` § "Build order".

> **Resuming in a new session?** Read `SPEC.md` first, then the "Next step" section
> at the bottom of this file. Re-run the verification commands to confirm the DB is
> intact before continuing.

---

## Status at a glance

| # | Step | File(s) | Status |
|---|------|---------|--------|
| 1 | Schema + seeds | `db/init.sql`, `scripts/seed_settings.py`, `scripts/seed_brand_voice.py` | ✅ Done & tested |
| 2 | DB helpers | `utils/db.py` | ⬜ Not started |
| 3 | Claude client | `utils/claude.py` | ⬜ Not started |
| 4 | Strategy Agent | `agents/strategy_agent.py` | ⬜ Not started |
| 5 | Content Agent | `agents/content_agent.py` | ⬜ Not started |
| 6 | Review UI | `ui/app.py` | ⬜ Not started |
| 7 | Distribution Agent | `agents/distribution_agent.py` | ⬜ Not started |
| 8 | Cron wiring | `cron/weekly_strategy.sh` | ⬜ Not started |

Supporting files still to create (not yet needed): `requirements.txt`, `.env`,
`README.md`.

---

## Step 1 — Schema + seeds ✅

**Done:**
- `db/init.sql` — all 6 tables: `settings`, `products`, `posts`, `calendar`,
  `markets`, `brand_voice`. Idempotent (`CREATE TABLE IF NOT EXISTS`), FK-safe
  creation order (`products` → `posts` → `calendar`). JSON-array TEXT columns for
  `hashtags` / `example_captions` / `avoid_phrases`. `CHECK` constraints on every
  enum/status field; single-row `id = 1` guards on `settings` and `brand_voice`.
  Indexes on `posts.status`, `posts.posted_at`, `calendar.week_start`,
  `products.last_promoted_at`, `markets.application_deadline`.
- `.gitignore` — ignores `.env` and `data/` (DB never committed) plus Python noise.
- `scripts/seed_settings.py` and `scripts/seed_brand_voice.py` — moved from repo
  root into `scripts/` (their `parents[1]` paths expect that location). Real
  Be The Goose voice/config data. Both use `INSERT OR REPLACE` so re-running is safe.

**Build / rebuild the DB from scratch:**
```bash
mkdir -p data/art
sqlite3 data/art_business.db < db/init.sql
python3 scripts/seed_settings.py
python3 scripts/seed_brand_voice.py
```
(To fully reset: `rm data/art_business.db` first.)

**Verify (all of these passed on 2026-06-11):**
```bash
sqlite3 data/art_business.db ".tables"                      # 6 tables
sqlite3 data/art_business.db "PRAGMA integrity_check; PRAGMA foreign_key_check;"
sqlite3 data/art_business.db "SELECT * FROM settings;"      # 1 row, id=1
sqlite3 data/art_business.db \
  "SELECT json_valid(example_captions), json_array_length(example_captions) FROM brand_voice;"  # 1, 8
```

**Seeded values:** tz `America/New_York`, hashtags 3–5, default post time `18:30`,
`reels_required = 0`. Brand voice = 8 example captions + 8 avoid phrases.

---

## ⚠ Open TODOs to revisit with the artist

These are placeholders/guesses in the seed data — fine for running the system
end-to-end, but replace before relying on the affected output:

- `brand_voice.snail_mail_pitch` is a **placeholder**. Replace with her real wording
  before any snail-mail CTA (`scripts/seed_brand_voice.py`).
- `brand_voice.avoid_phrases` are **inferred starter guesses**, not phrases she named.
  Confirm with her (`scripts/seed_brand_voice.py`).
- `settings.default_post_time` (`18:30`) is a sane default, not data-derived. Adjust to
  her real best window if known (`scripts/seed_settings.py`).

After editing either seed script, just re-run it — `INSERT OR REPLACE` overwrites row 1.

---

## Key decisions / conventions (apply to later steps)

- **DB path:** `data/art_business.db`. Scripts resolve it via
  `Path(__file__).resolve().parents[1] / "data" / "art_business.db"`, so anything under
  `scripts/`, `agents/`, `utils/`, `ui/` should use `parents[1]` from its own location.
- **Datetimes:** stored as ISO-8601 TEXT (SQLite has no native date type). All
  dates/times are in `settings.timezone`.
- **JSON columns:** `hashtags`, `example_captions`, `avoid_phrases` are JSON arrays in
  TEXT columns — `json.dumps` on write, `json.loads` on read. `utils/db.py` (step 2)
  should centralize this so callers never touch raw JSON.
- **Foreign keys:** `PRAGMA foreign_keys = ON` is per-connection and does NOT persist
  from `init.sql`. `utils/db.py` must set it on every connection it opens.
- **Models (from SPEC):** Strategy = `claude-sonnet-4-6`; Content & Distribution =
  `claude-haiku-4-5-20251001`.
- **Output reliability:** all agents use forced JSON / tool-use, defensive parsing,
  one retry, and write nothing on final failure (SPEC § "Output reliability").

---

## Next step → Step 2: `utils/db.py`

Per SPEC build order #2: typed read/write helpers per table, with JSON-array handling
for `hashtags` / `example_captions` / `avoid_phrases`. Test with manual inserts.

Suggested scope:
- Connection helper that opens `data/art_business.db` and sets `PRAGMA foreign_keys = ON`
  (and `row_factory = sqlite3.Row` for dict-like access).
- Read helpers the agents need: `get_settings()`, `get_brand_voice()`,
  recent posts (last 30 for Strategy, last ~5 for Content), active products sorted by
  `last_promoted_at ASC`, upcoming markets, calendar slots for a week.
- Write helpers: insert/update a draft post, idempotent calendar week write
  (delete `week_start` rows where `post_id IS NULL`, then insert), set
  `products.last_promoted_at`, engagement updates, etc.
- JSON encode/decode handled inside these helpers so callers pass/receive Python lists.
- **Test:** manual inserts + reads round-trip correctly, especially JSON arrays.
