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
| 5 | Content Agent | `agents/content_agent.py` | ✅ Done & tested (offline; live run needs a key) |
| 6 | Review UI | `ui/app.py` | ✅ Done & tested (headless via AppTest) |
| 7 | Distribution Agent | `agents/distribution_agent.py` | ✅ Done & tested (offline; live run needs a key) |
| 8 | Cron wiring | `cron/weekly_strategy.sh` | ✅ Done & tested (live run) |

Supporting files: `requirements.txt` ✅, `.env` ✅ (gitignored), and `README.md` ✅
(created with step 8). **All 8 build steps complete.**

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

## Step 5 — Content Agent ✅

**Done:**
- `agents/content_agent.py` — per-post supporting material. Public entry
  `generate_draft(slot_id, art_filename=None)` is what the UI's "Generate draft"
  button (step 6) calls, once per slot **after art is attached**. Model
  `claude.CONTENT_MODEL` (`claude-haiku-4-5-20251001`). Flow:
  - Reads the `calendar` slot, then resolves the art: the UI's attach-art step
    (SPEC View 1) creates the slot's draft `posts` row and sets `art_filename` on
    it, so the agent reads it from `slot.post_id`'s post (or an explicit
    `art_filename` arg for CLI). **No art → `AgentError`** (the UI also disables
    the button until art is attached).
  - **Passes the real artwork** to the model via `claude.image_block`. For video
    files it does **best-effort ffmpeg** frame extraction to a temp PNG; if ffmpeg
    isn't installed it raises a clear, actionable `AgentError` (attach a still)
    rather than generating blind — outputs must reference the actual art.
  - Reads `brand_voice` + `settings`, `db.get_active_products()` (least-recently-
    promoted first, for CTA rotation), and `db.get_recent_posted(5)`'s `hashtags`
    + `reel_script` (variety only). Builds a **lean context** (only the fields it
    uses, per SPEC § Output reliability).
  - **The model decides the CTA.** `calendar` has no CTA column — Strategy wove
    CTA intent into `theme`/`content_idea` — so the agent reads that intent and
    returns `cta_type` + (for shop/snail_mail) a `product_id` chosen from
    `active_products`. We resolve `cta_url` from that product in Python; an
    invalid/missing id **falls back** to the least-recently-promoted fitting
    product (snail_mail-typed for snail_mail; non-subscription for shop).
  - Forced tool `record_draft` with a schema whose `hashtags` `minItems`/`maxItems`
    come from `settings.hashtag_count_min/max`. Backstop in Python:
    `_normalize_hashtags` adds missing `#`, strips inner spaces, de-dupes
    case-insensitively, trims to max, and raises if none survive. `product_id`
    and `reel_script` are **optional** in the schema (avoids nullable-union types,
    which the SDK's tool `input_schema` handles awkwardly).
  - **Reel rule:** if the slot format is `reel`, a missing/empty `reel_script`
    raises `AgentError`; for non-reels `reel_script` is forced to null.
  - **Upsert (no duplicate drafts):** if the slot already has a linked draft post
    (the normal UI path), it `update_post`s that row — **`caption` is never
    touched, so her words survive a re-generate**; otherwise it `insert_post`s and
    `link_slot_to_post`s. `caption` always stays null (she writes it).
  - CLI: `python agents/content_agent.py --slot <id> [--art <file>]` prints the
    draft; `main()` surfaces `AgentError` as a clean exit.

**Verify (offline tests passed on 2026-06-11):** ran a self-contained script
against a *temp copy* of the DB (real DB confirmed untouched: posts/calendar/
products all 0) with `claude.call_json` monkeypatched and the **real (offline)**
`claude.image_block` encoding a tiny 1×1 PNG — no key/network used. 25 checks
covered: model id = `CONTENT_MODEL`, image+text content blocks, schema hashtag
bounds from settings, hashtag normalize/dedupe, shop CTA → product + resolved
`cta_url`, caption stays null, `reel_script` null for static, slot linked on
insert; **upsert** (same post id, no new row, pre-existing caption preserved,
art read from the linked post); **reel without a script → `AgentError` with
nothing written and the slot unlinked**; reel with a script saved; invalid
`product_id` → fallback to a real product + url; snail_mail CTA picks the
snail_mail product; missing art and missing slot both raise. To re-run: copy the
recipe (temp DB copy + monkeypatched `claude.call_json` + a real tiny PNG) from
the Step 2/3/4 pattern.

**Live smoke test (run once `.env` has a real key):**
```bash
# Needs a slot to exist and art on disk. Quick path from a fresh DB:
python agents/strategy_agent.py                          # creates this week's slots
sqlite3 data/art_business.db "SELECT id, slot_date, format, theme FROM calendar;"
cp /path/to/real_art.png data/art/test.png
python agents/content_agent.py --slot <id> --art test.png
```
Review the hashtags (mix of tiers, specific to the image), the CTA suggestion
(in her voice, not salesy), and — for a reel slot — the hook + outline.

---

## Step 6 — Review UI ✅

**Done:**
- `ui/app.py` — local Streamlit app, three views (sidebar nav) + two always-on
  banners. All DB access goes through `utils/db.py`; both agent triggers go
  through the agent entry points; this file touches neither SQLite nor the SDK
  directly. Highlights:
  - **Every agent trigger** is wrapped in `st.spinner(...)` + `try/except`
    (`_run_agent`): `claude.AgentError` (and any unexpected error) surfaces as
    `st.error` and **nothing half-written is left** — the agents already roll back
    on failure, so there's no cleanup. No agent call can crash the UI.
  - **View 1 — Weekly calendar:** week navigation (prev/this/next via a
    `week_offset` in session state; Monday math mirrors the Strategy Agent).
    **"Run weekly plan now"** → `strategy_agent.run_weekly_plan(week_start)` for the
    viewed week (cron fallback); the run's `reasoning` + web queries are shown in an
    expander. Per slot: date/time, format badge, priority, theme, content idea,
    linked-post status badge, art thumbnail. **Attach-art** uploader saves into
    `data/art/` as a slot-prefixed bare filename, **creates+links the draft row if
    needed** (`_ensure_draft` → `db.insert_post` + `db.link_slot_to_post`), and sets
    `art_filename` — the row the Content Agent then fills. A per-file
    name+size signature in session state prevents re-saving the same upload on every
    rerun. **Generate draft** (disabled until art is attached) →
    `content_agent.generate_draft(slot_id)`.
  - **View 2 — Post review:** lists `db.get_posts_by_status("draft")`. Per draft:
    art preview (image or video), format badge, agent reasoning, promoted-product
    name, and — for reels — the hook/script. A `st.form` with her **own caption box**,
    editable **hashtags** (parsed back to a clean de-duped list via `_parse_hashtags`),
    and editable **CTA** type/url/suggestion. Three submit buttons: **Save draft**
    (persists edits, stays draft), **Approve** (requires non-empty caption — warns
    otherwise), **Discard** (`status='discarded'`, soft delete). Switching CTA away
    from shop/snail_mail clears `product_id` so Distribution won't mis-stamp a product.
  - **Approve → Distribution, guarded for step 7's absence** (`_trigger_distribution`):
    tries `from agents import distribution_agent; distribution_agent.distribute(post_id)`.
    `done` → it set the post approved + wrote the checklist; `absent` (not built yet) →
    the UI sets `status='approved'` itself and says so; `error` → the post is **kept as
    a draft** (her saved caption/edits persist) and the error is shown. **This defines
    the step-7 contract: `distribute(post_id)` reads the post, writes the checklist /
    market blurb / `last_promoted_at`, and sets `status='approved'` at the end.**
  - **View 3 — Engagement (core):** "Ready to post" section lists `approved` posts
    with their `posting_checklist` (or a note that it appears once Distribution runs)
    and a **"Mark as posted"** button (`db.mark_posted`) — this is the approved→posted
    bridge the engagement loop needs. "Enter numbers" section: a per-post form over
    `db.get_posts_missing_engagement()` → `db.update_engagement(...)`.
  - **Banners (top of every view):** an engagement nudge ("N posted items still need
    their numbers") from `db.get_posts_missing_engagement()`, and any
    `db.get_markets_with_deadline(14)` with the agent's `draft_application` in an
    expander when present.

**Run it (needs deps + a real key for the agent buttons; views render without either):**
```bash
python3 -m pip install -r requirements.txt   # adds streamlit (anthropic/dotenv already present)
streamlit run ui/app.py
```

**Verify (passed on 2026-06-11):** `python3 -m py_compile ui/app.py`, then a headless
**AppTest** run (`streamlit.testing.v1.AppTest`) against a *temp copy* of the DB (real
DB confirmed untouched: posts/calendar/products/markets all 0) seeded with one row per
view. Covered: all three views render with **no exception**; the market + engagement
banners fire; the **engagement form submit** writes numbers; and the **Approve path**
with the Distribution Agent absent flips a draft to `approved` (the documented fallback).
To re-run: copy the recipe from this section's git history, or set `db.DB_PATH` to a temp
copy, seed rows via `db.*`, and drive `AppTest.from_file("ui/app.py")` (set the sidebar
radio to switch views; `.click().run()` form buttons). `streamlit` was installed during
this step (`1.58.0`).

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

## Step 7 — Distribution Agent ✅

**Done:**
- `agents/distribution_agent.py` — post-approval prep. Public entry
  `distribute(post_id)` is exactly the contract the UI's Approve button already
  calls (`ui/app.py` → `_trigger_distribution`); the agent being present now means
  the UI's `"absent"` fallback no longer fires (no restart needed — the import is
  attempted at click time). Model `claude.DISTRIBUTION_MODEL`
  (`claude-haiku-4-5-20251001`); **one `call_json` call, no image, no web search.**
  Reads the post by id regardless of its current status. Flow:
  1. **Confirms the posting time (owns `slot_time`).** Reads the post's linked
     calendar slot via the new `db.get_calendar_slot_by_post(post_id)` for
     Strategy's proposed time, and the last 5 committed slot times via the new
     `db.get_recent_scheduled_times(5, exclude_post_id=...)`. `_confirm_time` keeps
     the planned time, **floored at `settings.default_post_time`**, and nudges it
     `+15 min` only when ≥2 recent posts already cluster at that exact time (would
     be 3rd-in-a-row). No fake optimization — the checklist says plainly the time
     is a sensible default. The confirmed time is **written back to the calendar
     slot** (`db.update_calendar_slot`) when it changed and a slot exists.
  2. **Builds the posting checklist DETERMINISTICALLY in Python** (`_build_checklist`
     + helpers `_to_12h` / `_friendly_date` / `_first_comment_line`). The file name,
     her caption, and the CTA URL are copied **verbatim** — no model can alter them.
     It converts the 24h time to 12h, says "today"/"on <date>", tailors the first-
     comment line (shop/snail-mail/market link vs. hashtags) and the Story line
     (reel vs. static vs. story), and notes plainly that the time is a default.
  3. **The agent's ONLY model call is the market blurb** (`_draft_market_blurb`,
     forced-JSON `record_market_blurb`, blurb-only schema). It runs **only** when a
     market's `application_deadline` is within 14 days
     (`db.get_markets_with_deadline(14)`) **and** its `draft_application` is still
     empty — the **soonest** such market. With no such market the agent makes **no
     API call at all** (so it needs no key for the common case). Skipping already-
     drafted markets keeps repeated approvals during a deadline window idempotent.
  4. Writes `posts.posting_checklist` (`db.update_post`); the blurb →
     `db.set_market_draft_application` (**never** touches `notes`).
  5. When `cta_type` is `shop`/`snail_mail` and the post has a `product_id`,
     `db.set_product_promoted(product_id)` (`= now()`) — drives CTA rotation.
  6. `db.set_post_status(post_id, "approved")` **last**. The blurb call is the only
     failure point and precedes every DB write, so a failure (or a missing key when
     a blurb is needed) leaves the post a draft with nothing half-written. Returns a
     summary dict (status, confirmed time, whether nudged, checklist, market drafted,
     product promoted).
  - CLI: `python agents/distribution_agent.py --post <id>` prints the summary +
    checklist; `main()` surfaces `claude.AgentError` as a clean exit.
  - **Refactor note:** an earlier cut had the model generate the whole checklist
    via one `record_distribution` call. Per the developer's request the checklist
    is now built in Python (zero risk of the model mangling a URL/filename) and the
    model is used **only** for the voice-dependent market blurb.
- `utils/db.py` — added two read-only helpers used only here:
  `get_calendar_slot_by_post(post_id)` and
  `get_recent_scheduled_times(limit=5, exclude_post_id=None)`.

**Verify (offline tests passed on 2026-06-11):** ran a self-contained script
against a *temp copy* of the DB (real DB confirmed untouched: posts/calendar/
products/markets all 0) with `claude.call_json` monkeypatched — no key/network
used. 33 checks across 5 scenarios: (A) shop CTA + linked slot + near-deadline
market → **exactly one model call** (the blurb), model id = `DISTRIBUTION_MODEL`,
blurb-only schema, market name passed; deterministic checklist contains the
filename / `cta_url` / caption **verbatim** and `6:30 PM` (18:30→12h); status→
approved, `last_promoted_at` stamped, `draft_application` written **without
clobbering `notes`**, slot time kept at 18:30 (no cluster); (B) two recent 18:30
slots → **no model call** (no fresh market), time **nudged to 18:45** and written
back to the slot; (C) reel + `cta_type='none'` → **no model call**, reel Story
line + hashtags-first-comment line present, no product promoted, approved;
(D) blurb `call_json` raises → **post stays draft, no checklist, product not
re-stamped, the market stays undrafted**; (E) missing post → `AgentError`. To
re-run: temp DB copy + set `db.DB_PATH` + monkeypatch `claude.call_json`, seed a
draft post / market / product per the Step 2–5 pattern.

**Live smoke test (run once `.env` has a real key):**
```bash
# Needs an approved-able draft. Quick path from an existing draft (see step 5):
sqlite3 data/art_business.db "SELECT id, status, cta_type FROM posts WHERE status='draft';"
python agents/distribution_agent.py --post <id>
sqlite3 data/art_business.db "SELECT status, posting_checklist FROM posts WHERE id=<id>;"
```
Or just click **Approve** in the UI (caption required) — it calls `distribute()`.

---

## Step 8 — Cron wiring ✅

**Done:**
- `cron/weekly_strategy.sh` — the Monday-morning cron that runs the Strategy
  Agent's weekly plan; the UI's "Run weekly plan now" button stays the fallback
  for when the laptop is asleep at cron time. Design (deliberately robust against
  cron's bare environment):
  - **Self-locating:** resolves `PROJECT_ROOT` from `${BASH_SOURCE[0]}` and `cd`s
    there, so the crontab line is just the absolute path — no `cd` in cron, works
    from any CWD (verified by running it from `/tmp`).
  - **Explicit Python choice:** cron has a minimal PATH and no shell profile, so it
    does NOT trust a bare `python3`. Priority: `ART_AGENT_PYTHON` env override →
    `.venv/bin/python` → `venv/bin/python` → `command -v python3`; clear error if
    none found. (There's no venv in this project today, so it lands on the system
    `python3` that has `anthropic` installed.)
  - **No key handling needed:** `utils/claude.py` loads `.env` via an absolute path
    (`parents[1]/.env`), so the key is found regardless of CWD — the script doesn't
    export it.
  - **Logging:** appends a timestamped header, the chosen interpreter, the full agent
    output, and an OK/FAILED footer to `data/logs/weekly_strategy.log`. `data/` is
    gitignored, so logs never hit version control. Propagates the agent's exit code.
  - Header comments document the `crontab -e` line (`0 8 * * 1 <abs path>`),
    `crontab -l` / `tail -f` checks, the `ART_AGENT_PYTHON` override form, and the
    macOS **Full Disk Access** caveat for `/usr/sbin/cron`.
  - `set -uo pipefail` (intentionally **not** `-e`, so the run's exit status is
    captured rather than aborting before the footer logs); guarded `cd`.

**Verify (passed on 2026-06-11):** `bash -n cron/weekly_strategy.sh` (syntax OK),
`chmod +x` applied. **Live run from `/tmp`** exercised the whole path: it resolved
the project root, picked the system `python3`, ran the Strategy Agent against the
real DB, and logged the full plan + web queries + reasoning with a `completed OK`
footer (exit 0). NOTE: that smoke test was a **live** run — it spent ~2–3 billable
web searches + one Sonnet call and wrote 4 calendar slots for week 2026-06-08 to
the real DB (idempotent, so re-runs replace rather than duplicate). `.env` now holds
a working key (it was a placeholder through step 7).

**Install the cron (run once on her machine):**
```bash
crontab -e
# add — runs Mondays 8:00 AM local:
0 8 * * 1 /Users/bensonchen/repos/bethegoose-agent/cron/weekly_strategy.sh
crontab -l                               # confirm
tail -f data/logs/weekly_strategy.log    # watch runs
```

---

## README ✅

`README.md` created (SPEC § File structure). Covers: what the system does / doesn't,
the architecture diagram + agent/model table, project layout, setup (install → key →
init+seed DB), the daily/weekly workflow, running the UI and each agent's CLI, the
cron install + macOS caveats, configuration via the seed scripts (with the placeholder
TODOs flagged), the under-$5/month cost note, and a troubleshooting table. Points
readers to `SPEC.md` (source of truth) and this file for the build log.

---

## ✅ Build complete — all 8 steps done

All three agents, the UI, the schema/seeds, the cron, and the README are in place and
tested. What remains is operational, not build work:
- **Confirm the placeholder seed values with the artist** (snail-mail pitch, avoid
  phrases, default post time — see "Open TODOs" above), then re-run the seed scripts.
- **Install the cron** on her machine (command above).
- The live smoke tests for steps 3–7 in each section can now actually be run, since
  `.env` has a real key.

**NOTE:** Anything touching the Claude API — consult the `claude-api` skill for
current model ids and usage rather than relying on memory. The installed SDK is
`anthropic 0.76.0` (tool-use only; no `output_config`), which is why the agents use
forced tool-use — see the Step 3 section above.
