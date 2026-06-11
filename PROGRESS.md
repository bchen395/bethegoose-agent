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
| 2 | DB helpers | `utils/db.py` | ✅ Done & tested |
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

## Step 2 — DB helpers ✅

**Done:**
- `utils/db.py` — the single gateway every agent and the UI use; nothing else
  touches SQLite directly. Highlights:
  - `connect()` context manager: opens `data/art_business.db`, sets
    `PRAGMA foreign_keys = ON` and `row_factory = sqlite3.Row`, **commits on clean
    exit / rolls back on exception** (so multi-statement writes are atomic).
  - **JSON columns** (`hashtags`, `example_captions`, `avoid_phrases`) are encoded
    on write and decoded to Python lists on read — callers pass/receive lists,
    never raw JSON. Null/empty decodes to `[]`.
  - **Time helpers** `now_iso()` / `today_iso()` are tz-aware in
    `settings.timezone` (via `zoneinfo`, degrades to naive local if unavailable).
    Timestamps stored ISO-8601 to the second.
  - Dynamic writes are guarded by per-table column allow-lists — an unknown column
    (typo) raises `ValueError` instead of silently no-op'ing.
  - Reads: `get_settings`, `get_brand_voice`, `get_recent_posts(30)` (Strategy),
    `get_recent_posted(5)` (Content variety), `get_posts_by_status`, `get_post`,
    `get_posts_missing_engagement` (banner), `get_active_products` (ordered
    `last_promoted_at ASC`, NULL-first), `get_upcoming_markets(45)`,
    `get_markets_with_deadline(14)`, `get_calendar_week`, plus by-id getters.
  - Writes: `insert_post`/`update_post`, `set_post_status`, `mark_posted`,
    `update_engagement`, idempotent `replace_week_plan` (deletes this week's
    `post_id IS NULL` slots, then inserts), `link_slot_to_post`,
    `set_product_promoted`, `set_market_draft_application`, and
    `insert_product`/`insert_market` for sync/seed.

**Verify (all passed on 2026-06-11):** ran a self-contained round-trip test
against a *temp copy* of the DB (real DB untouched — confirmed all data tables
still empty, both seed rows intact). Covered: JSON-array round-trip, tz-aware
timestamps, product rotation ordering, post draft→approved→posted→engagement
lifecycle, **calendar idempotency** (attached slot preserved, unattached replaced,
no duplicates), market date windows, `draft_application` not clobbering `notes`,
and unknown-column `ValueError`. To re-run, copy the test into a scratch script
that sets `db.DB_PATH` to a temp copy before calling the helpers.

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

## Next step → Step 3: `utils/claude.py`

Per SPEC build order #3 and § "Output reliability": shared Anthropic client,
web-search wrapper, and **forced-JSON / tool-use** output with defensive parsing
(strip stray ``` fences) and **one retry** with a stricter instruction before
giving up. On final failure, write nothing and surface a clear error to the
caller/UI. Test a basic call and a web-search call.

Suggested scope:
- Load `ANTHROPIC_API_KEY` from `.env` (`python-dotenv`); create a shared client.
- A `call_json(...)` helper that takes a model id, system prompt, messages
  (incl. optional image blocks for the Content Agent), and a JSON schema → forces
  a tool/`tool_choice` so the model returns a parseable object; validate, retry
  once on parse failure, raise on final failure.
- A `web_search(...)` wrapper around the API's built-in web-search tool, **capped
  at 2–3 searches** per Strategy run (cost: each search is billable).
- Model ids: Strategy `claude-sonnet-4-6`; Content & Distribution
  `claude-haiku-4-5-20251001`.

Also still pending before agents run: `requirements.txt` (`anthropic`,
`streamlit`, `python-dotenv`) and `.env` with the API key (gitignored).

**NOTE:** This task involves the Anthropic/Claude API — consult the `claude-api`
skill for current model ids, tool-use/forced-JSON, and web-search usage rather
than relying on memory.
