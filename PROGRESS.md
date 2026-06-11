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
| 3 | Claude client | `utils/claude.py` | ✅ Done & tested (offline; live call needs a key) |
| 4 | Strategy Agent | `agents/strategy_agent.py` | ✅ Done & tested (offline; live run needs a key) |
| 5 | Content Agent | `agents/content_agent.py` | ⬜ Not started |
| 6 | Review UI | `ui/app.py` | ⬜ Not started |
| 7 | Distribution Agent | `agents/distribution_agent.py` | ⬜ Not started |
| 8 | Cron wiring | `cron/weekly_strategy.sh` | ⬜ Not started |

Supporting files: `requirements.txt` ✅ and `.env` ✅ (placeholder, gitignored)
created in step 3. Still to create: `README.md`.

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

## Step 3 — Claude client ✅

**Done:**
- `utils/claude.py` — the single gateway to the Claude API; agents never call
  the SDK directly. Highlights:
  - **Lazy shared client** via `get_client()`: loads `.env` with `python-dotenv`
    on first use and raises a clear `AgentError` if `ANTHROPIC_API_KEY` is unset
    or still the placeholder.
  - **`call_json(...)`** — forced structured output. The installed SDK
    (`anthropic 0.76.0`) has no `output_config`/`messages.parse`, so this uses
    **forced tool-use** (`tool_choice` → a single output tool whose `input_schema`
    is the caller's schema) — the SPEC's "tool-use / forced JSON" path. Reads the
    tool args back as a dict; defensive `_parse_json_object` (strips ``` fences,
    falls back to the outer `{...}`) covers the rare string case. **Retries once**
    with a stricter system instruction on any parse/shape failure, then raises
    `AgentError`. Surfaces refusals and `max_tokens` truncation as errors. Accepts
    a string or a list of content blocks (text + image) for the Content Agent.
  - **`web_search(...)`** — separate, cost-capped call (each search is billable).
    Server-side `web_search_20260209`, `max_uses` **hard-capped at 3**
    (`MAX_WEB_SEARCHES`), `tool_choice` auto. Returns
    `{"text": <synthesis>, "queries": [...]}` and handles `pause_turn`. Strategy
    feeds the text into `call_json` — it does not loop. Two-phase by design:
    forced `tool_choice` can't coexist with the model freely choosing to search.
  - **`image_block(path)`** — base64 image content block, media-type from the
    extension (png/jpeg/gif/webp), rejects unsupported types.
  - Model constants: `STRATEGY_MODEL = claude-sonnet-4-6`,
    `CONTENT_MODEL = DISTRIBUTION_MODEL = claude-haiku-4-5-20251001`.
  - `AgentError` is the single failure type — on it the caller writes nothing.
- `requirements.txt` — `anthropic`, `streamlit`, `python-dotenv` (per SPEC).
- `.env` — placeholder `ANTHROPIC_API_KEY=your_key_here`; **gitignored**
  (`git check-ignore .env` confirms). **Replace with a real key before any live
  call** (see TODOs below).

**Verify (offline tests passed on 2026-06-11):** ran a self-contained script
covering fence stripping, JSON-object parsing (clean / fenced / prose-wrapped /
non-object rejected), `image_block` (real 1×1 PNG → base64; non-image rejected),
the placeholder-key guard, and — via a mocked SDK client — `call_json` happy
path, one-retry-then-succeed, refusal → `AgentError`, total-failure → `AgentError`,
and `web_search` query/text collection with the `max_uses` cap. No network used.

**Live smoke test (run once `.env` has a real key):**
```python
from utils import claude
print(claude.call_json(
    model=claude.CONTENT_MODEL,
    system="You output structured data.",
    content="Suggest 3 Instagram hashtags for a hand-drawn goose sticker.",
    schema={"type": "object",
            "properties": {"hashtags": {"type": "array", "items": {"type": "string"}}},
            "required": ["hashtags"]},
))
r = claude.web_search(prompt="Instagram hashtags for indie sticker artists, June 2026. Summarize briefly.")
print(r["queries"], "\n", r["text"][:300])
```

---

## Step 4 — Strategy Agent ✅

**Done:**
- `agents/strategy_agent.py` — the weekly content-calendar planner. Public entry
  `run_weekly_plan(week_start=None)` is what both the Monday cron (step 8) and the
  UI's "Run weekly plan now" button (step 6) call. Flow:
  - Reads `db.get_recent_posts(30)`, `db.get_settings()`, `db.get_upcoming_markets(45)`,
    `db.get_active_products()` (least-recently-promoted first).
  - **Week math:** `week_start` defaults to the Monday of the current week (in
    `settings.timezone` via `db.today_iso()`); `allowed_dates` = today→Sunday, so the
    Monday cron gets a full week and a mid-week fallback run only plans remaining days.
    Raises `AgentError` if the whole target week is already past.
  - Runs **one** `claude.web_search(...)` (queries capped at 3 in `utils/claude.py`) for
    seasonal hooks / hashtag freshness. **Degradable:** if the search raises, the run
    notes it and proceeds on first-party data alone (web is a light supplement, per SPEC).
  - Builds a **lean context** (SPEC § Output reliability): trimmed recent posts (format,
    status, cta_type, likes/comments/reach/saves, date) **plus two derivations that make
    the "first-party leads" + rotation rules concrete** — `format_performance` (per-format
    avg metrics over posted rows) and `signals` (`days_since_snail_mail_cta`,
    `recent_cta_sequence`).
  - Synthesizes via `claude.call_json` on **`claude.STRATEGY_MODEL` (`claude-sonnet-4-6`)**,
    forced tool `record_plan` with `PLAN_SCHEMA`. System prompt encodes every SPEC rule:
    first-party-over-web, format mix (reel rule keyed to `reels_required`, ≥1 carousel,
    a static is fine), CTA rotation / market tease (≤3 wks) / snail-mail (10+ days),
    product rotation, and **posting time = `default_post_time` with an honest "sensible
    default, not data-optimized" note in `reasoning`**.
  - **Schema reality:** `calendar` has no CTA or reasoning column, so CTA intent is woven
    into each slot's `theme`/`content_idea`, and the run's `reasoning` is **returned to the
    caller** (printed by the CLI / shown by the UI), not persisted. Slots carry exactly the
    six writable calendar columns.
  - `_validate_slots` rejects a bad `format` or an out-of-week `slot_date` with `AgentError`
    (normalizes `slot_time`→HH:MM with `default_post_time` fallback, odd priority→2). Because
    `db.replace_week_plan` is atomic, any raise leaves the calendar untouched.
  - **Idempotent write** via `db.replace_week_plan(week_start, slots)` (deletes the week's
    `post_id IS NULL` slots, then inserts).
  - CLI: `python agents/strategy_agent.py [--week-start YYYY-MM-DD]` prints the slots,
    web queries, and reasoning; `main()` surfaces `AgentError` as a clean exit.

**Verify (offline tests passed on 2026-06-11):** ran a self-contained script against a
*temp copy* of the DB (real DB confirmed untouched: posts=0, calendar=0) with
`claude.web_search`/`call_json` monkeypatched — no key/network used. Covered: correct
`format_performance` (seeded carousels' avg_saves=20.0) and `signals`
(`days_since_snail_mail_cta=15`, recent shop/shop sequence), market + product-rotation
ordering in the context, model id = `STRATEGY_MODEL`, all slot dates within
`allowed_dates`, **idempotent re-run** (3 rows stay 3), **attached-slot survival** (linked
slot kept with its `post_id`; unattached replaced → 4 rows), and **bad slot_date →
`AgentError` with the calendar unchanged**. To re-run: copy the script into a scratch file
that sets `db.DB_PATH` to a temp copy and stubs the two `claude.*` calls.

**Live smoke test (run once `.env` has a real key):**
```bash
python agents/strategy_agent.py            # plans the current week
python agents/strategy_agent.py --week-start 2026-06-15
```
First-party data is sparse until real posts exist, so early plans lean on the web
supplement and sane defaults — that's expected.

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

## Next step → Step 5: `agents/content_agent.py`

Per SPEC build order #5 and § "Agent 2 — Content Agent". Model
`claude.CONTENT_MODEL` (`claude-haiku-4-5-20251001`). On-demand, per calendar
slot, **after art is attached** in the UI. Flow:
- Input: one `calendar` slot (`db.get_calendar_slot`), the attached art file, the
  `brand_voice` + `settings` rows, the relevant `products` row when `cta_type` is
  `shop`/`snail_mail`, and recent posted rows' `hashtags` + `reel_script`
  (`db.get_recent_posted(5)`) for variety only.
- **Pass the actual art** to the model: `claude.call_json(..., content=[claude.image_block(art_path), {"type": "text", ...}])` so hashtags/hooks reference what's really in the post. `image_block` already validates the media type.
- Produce: a hashtag set (count within `settings.hashtag_count_min/max`; mix
  large/medium/niche), a CTA suggestion (+ product + URL), and — reels only — a
  hook line + outline. **No caption** (`caption` stays null; she writes it).
- Write a `draft` row via `db.insert_post(...)` (status='draft', format, art_filename,
  hashtags, cta_type/cta_url/cta_suggestion, product_id, reel_script, agent_reasoning).
  Then link it to the slot with `db.link_slot_to_post(slot_id, post_id)`.
- Test with one slot + a real attached image; review hashtags, CTA, reel hook.

**Reminders for later steps:** Distribution (#7) is `call_json` only (no image, no
search), `claude.DISTRIBUTION_MODEL`; it writes `posting_checklist`,
`markets.draft_application`, and stamps `products.last_promoted_at` on approval.
A reusable offline-test recipe (temp DB copy + monkeypatched `claude.*`) is proven
in the Step 2/3/4 sections — copy it for #5 and #7.

**NOTE:** Anything touching the Claude API — consult the `claude-api` skill for
current model ids and usage rather than relying on memory. The installed SDK is
`anthropic 0.76.0` (tool-use only; no `output_config`), which is why step 3 uses
forced tool-use — see the Step 3 section above.
