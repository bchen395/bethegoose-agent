# Art Business Agent System — Build Spec (v2)

> This is a build spec to hand directly to Claude Code. It supersedes the original brief.
> Build the system exactly as described here. Where this spec and the original brief
> conflict, **this spec wins**. Prefer the simpler path on any decision not specified.

---

## What changed from v1 (read this first)

This version removes **agent-generated caption drafting** — the artist writes her own
captions. That single removal cascades into several schema and agent changes, and we've
also folded in a set of robustness fixes. Summary:

**Removed**
- Content Agent no longer drafts captions. The `posts.caption_draft` column is gone.
- "Read last 5 posted captions to avoid repetition" is repurposed: the Content Agent now
  glances at recent **hashtag sets and reel hooks** to vary those, not captions.
- `brand_voice.signature_sign_off` is removed (she writes her own captions, so there's no
  caption for the agent to sign off).

**Changed**
- **Content Agent stays on `claude-haiku-4-5-20251001`.** (The voice-critical task that
  would have justified a stronger model is gone.) Strategy Agent stays on `claude-sonnet-4-6`.
- The Content Agent now **receives the actual art file** (image or video frame) so its
  hashtags and reel hooks reference what's really in the post.
- `posts.notes` is **split into three columns** (`agent_reasoning`, `reel_script`,
  `posting_checklist`) so the Distribution Agent's checklist no longer overwrites the reel script.
- `markets` gets a dedicated `draft_application` column so the agent blurb doesn't clobber
  human notes.
- `hashtags` and `brand_voice.example_captions` are stored as **JSON arrays**, not
  pipe-delimited strings.
- Hashtag count is **config-driven** (`settings` table), not hardcoded to "20–25."
- `products.last_promoted_at` is now **actually written** on approval, so CTA rotation works.
- Strategy Agent **weights first-party engagement data over web-search trends.**
- Posting time: **Strategy proposes a default, Distribution confirms** — one owner. No fake
  "optimal time" precision for a sub-1K account; use sane defaults from `settings`.
- Calendar generation is **idempotent**: re-running the weekly plan replaces that week's
  unattached slots instead of duplicating them.
- New `discarded` post status (soft-delete; we keep history).
- Engagement input form is **promoted from "nice to have" to core** — the learning loop
  depends on it.
- A **"Run weekly plan now"** button in the UI is the fallback for when cron doesn't fire
  (e.g. laptop asleep).
- All agent calls use **forced-JSON / tool-use output** with defensive parsing and one retry.

---

## Project overview

A three-agent system using the Claude API to help a small indie art business grow on
Instagram and drive sales to an online shop and in-person art markets. The artist is the
human-in-the-loop: the agents prepare everything, **she writes the caption, approves, and posts.**

**Business context**
- Platform: Instagram (primary growth channel) + personal website with online shop
- Products: prints, stickers, crafts, monthly snail-mail subscription
- Current output: ~3 posts/week, original comics and doodles drawn same-day
- Followers: under 1K
- Goal: grow followers, convert to shop customers and art-market attendees
- Open to: Reels, Stories, Carousels, art-market vlogs, time-lapses, behind-the-scenes

---

## Stack decisions

| Component | Tool | Reason |
|---|---|---|
| Strategy Agent brain | `claude-sonnet-4-6` | Editorial judgment, not rote generation |
| Content Agent brain | `claude-haiku-4-5-20251001` | Hashtags + reel hooks + CTA suggestion; fast and cheap |
| Distribution Agent brain | `claude-haiku-4-5-20251001` | Logic and formatting only |
| Web search | Claude API built-in web search tool | No external API key needed |
| Memory / persistence | SQLite (local) | Queryable, free, no infra |
| Orchestration | Python scripts + cron (+ UI fallback button) | Simple, auditable, no frameworks |
| Review UI | Streamlit | Python-native, runs locally |
| Instagram posting | Manual (she posts) | API restrictions on personal accounts |

**Cost target:** under $5/month in API usage. Note that **each web search is a billable
line item** — the Strategy Agent runs 2–3 per weekly run, max.

**No agent frameworks** (no LangChain, CrewAI, etc.). Each agent is a standalone script.
Agents communicate only through the shared SQLite database, never by calling each other.

---

## Architecture overview

```
[Inputs]
Art backlog photos · Past IG posts · Shop product data · Art market history
        |
        v
[Shared memory — SQLite]
Posts · Engagement · Calendar · Products · Markets · Brand voice · Settings
        |
   _____|_____________________
  |            |              |
  v            v              v
[Strategy    [Content      [Distribution
 Agent]       Agent]        Agent]
Weekly        Per-post      Post-approval
  |            |              |
  |____________|______________|
        |
        v
[Human review — Streamlit]
Attach art · generate draft · write caption · edit · approve
        |
   _____|___________________
  |           |             |
  v           v             v
Instagram   Online shop   Art markets
        |
        v
[Engagement entered back into SQLite → Strategy Agent learns]
```

---

## Shared memory layer (SQLite schema)

Create `db/init.sql` with all tables below. Store the DB at `data/art_business.db`.
Use JSON-array TEXT columns where noted; SQLite has native `json_*` functions.

### `settings` (new — single row, id always 1)
Centralizes config the agents read so nothing is hardcoded.

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | always 1 |
| timezone | TEXT | IANA name, e.g. `America/New_York`. **All `slot_time` values are in this tz.** |
| hashtag_count_min | INTEGER | lower bound for Content Agent hashtag sets |
| hashtag_count_max | INTEGER | upper bound; Strategy Agent may narrow this per-week based on web findings |
| default_post_time | TIME | sane default used when no better signal exists (e.g. `18:30`) |
| reels_required | BOOLEAN | if true, hard-require ≥1 reel/week; if false, "aim for one when footage exists" |

### `posts`
Every post and every draft.

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| created_at | DATETIME | |
| posted_at | DATETIME | null if not yet posted |
| status | TEXT | `draft`, `approved`, `posted`, `discarded` |
| format | TEXT | `static`, `carousel`, `reel`, `story` |
| art_filename | TEXT | image/video file; **null until the artist attaches art in the UI** |
| caption | TEXT | **human-written**, null until she enters it at review time |
| hashtags | TEXT (JSON array) | e.g. `["#indieart","#stickerart"]` |
| cta_type | TEXT | `shop`, `snail_mail`, `market`, `none` |
| cta_url | TEXT | |
| cta_suggestion | TEXT | agent's *suggested* CTA line — she may use, edit, or ignore it |
| product_id | INTEGER FK → products.id | which product this CTA promotes (drives rotation); null if none |
| reel_script | TEXT | hook line + rough outline, reel only; otherwise null |
| agent_reasoning | TEXT | Content Agent's brief explanation of its choices |
| posting_checklist | TEXT | written by Distribution Agent at approval; never overwrites the above |
| likes | INTEGER | filled after posting via engagement form |
| comments | INTEGER | filled after posting |
| reach | INTEGER | filled after posting |
| saves | INTEGER | filled after posting |

### `calendar`
The weekly plan from the Strategy Agent.

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| week_start | DATE | Monday of the target week |
| generated_at | DATETIME | |
| slot_date | DATE | target posting date |
| slot_time | TIME | proposed by Strategy (default from settings), confirmed by Distribution |
| format | TEXT | recommended format |
| theme | TEXT | e.g. "process video — sticker making" |
| content_idea | TEXT | 1–2 sentence description |
| priority | INTEGER | 1 = must post, 2 = nice to have |
| post_id | INTEGER FK → posts.id | linked once a draft is created |

**Idempotency:** when the Strategy Agent regenerates a week, it must first delete existing
`calendar` rows for that `week_start` **where `post_id IS NULL`** (i.e. slots no draft has
been attached to yet), then insert the fresh plan. Never duplicate a week.

### `products`
Synced from the shop. Drives CTAs.

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| name | TEXT | |
| url | TEXT | direct product link |
| type | TEXT | `print`, `sticker`, `craft`, `snail_mail` |
| active | BOOLEAN | currently in stock |
| last_promoted_at | DATETIME | **written `= now()` on post approval** when this product is the CTA target |

### `markets`
Art-market applications and events.

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| name | TEXT | |
| location | TEXT | |
| event_date | DATE | |
| application_deadline | DATE | |
| status | TEXT | `considering`, `applied`, `accepted`, `rejected`, `attended` |
| draft_application | TEXT | **agent-written** blurb (new column; separate from notes) |
| notes | TEXT | human notes only |

### `brand_voice` (single row, id always 1)
Now slimmer — it informs reel hooks and CTA suggestions, not captions.

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | always 1 |
| artist_name | TEXT | how she refers to herself |
| tone_description | TEXT | e.g. "warm, a little whimsical, never salesy" |
| example_captions | TEXT (JSON array) | a few real captions she loves; used so hooks/CTAs sound like her |
| avoid_phrases | TEXT (JSON array) | phrases that don't sound like her |
| snail_mail_pitch | TEXT | her preferred way to describe the subscription |

---

## Agent 1 — Strategy Agent

**Model:** `claude-sonnet-4-6`
**Trigger:** weekly cron (Monday AM) **and** a "Run weekly plan now" button in the UI.
**Runtime:** once per week (or on demand via the button).

### What it does
1. Reads the last 30 rows of `posts` (format, likes, comments, reach, saves, cta_type, status).
2. Reads `settings`, upcoming `markets` (event within 45 days), and active `products`
   sorted by `last_promoted_at ASC`.
3. Runs **2–3 targeted web searches max**, then synthesizes — does not loop.
4. Produces a content calendar of 3–4 slots for the coming week.
5. **Idempotent write** to `calendar` (delete this week's unattached slots, then insert).

### First-party data takes priority
The system prompt must instruct the agent to **lead with her own engagement data** and treat
web-search results as a light supplement. If her own carousels out-save her reels, that beats
a listicle saying "reels win." Web search fills gaps (seasonal hooks, obviously stale tags to
avoid), it does not override observed performance.

### Format mix guidance (encode in the prompt, driven by `settings`)
- If `settings.reels_required` is true: require ≥1 reel/week. If false: aim for one only when
  she's likely to have process footage; never prescribe video she can't realistically shoot.
- Aim for ≥1 carousel (high saves signal).
- 1 static post is fine (her core comic/doodle content).
- Rotate CTAs — don't push the shop two posts in a row.
- If a market is within 3 weeks, ≥1 slot teases or announces it.
- If snail mail hasn't been mentioned in 10+ days, include it.

### Posting time
Set `slot_time` to `settings.default_post_time` (or a light per-day variation). **Do not
fabricate "optimal" times** — a sub-1K account has no Insights data to optimize against. Be
honest in `agent_reasoning` that this is a sensible default, not a data-derived optimum. Once
she's on a Business account with Insights, real best-times can replace the default later.

### Web search queries (examples — adapt, max 2–3 total)
- `Instagram growth tips small artists 2026`
- `indie art illustration hashtags <current month> 2026`
- `Instagram reels small accounts 2026`

---

## Agent 2 — Content Agent

**Model:** `claude-haiku-4-5-20251001`
**Trigger:** per calendar slot, from the UI (after art is attached).
**Runtime:** on demand.

> No caption generation. She writes captions herself. This agent prepares the supporting
> material around the caption.

### What it does
1. Takes one `calendar` slot (theme, format, content idea) as input.
2. **Reads the attached art file** (`art_filename`) and passes the image — or a representative
   frame for video — to the model so outputs reference the actual artwork.
3. Reads `brand_voice` and `settings`.
4. Reads the relevant `products` row if `cta_type` is `shop` or `snail_mail`.
5. Glances at recent posts' `hashtags` and `reel_script` to **vary tags and hooks**.
6. Produces: a hashtag set, a CTA suggestion (+ which product + URL), and — for reels — a
   hook line and rough script outline.
7. Writes a `draft` row to `posts`.

### Inputs
- One `calendar` row (JSON)
- The attached art file (image bytes / video frame)
- `brand_voice` row, `settings` row
- Relevant `products` row when applicable
- `hashtags` + `reel_script` from the last ~5 `posted` rows (variety only)

### Output (written to `posts`)
- `status = 'draft'`, `format`, `art_filename`
- `hashtags` (JSON array; count within `settings.hashtag_count_min/max`; mix of large/medium/niche)
- `cta_type`, `cta_url`, `cta_suggestion`, `product_id`
- `reel_script` if reel (hook line + outline), else null
- `agent_reasoning` (brief)
- `caption` stays **null** — the artist fills it in the UI

### Prompt guidance
- Hashtags: mix large (1M+), medium (100K–1M), niche (<100K). Count from `settings`, not hardcoded.
- CTA suggestion: natural, not salesy; match `tone_description`; honor `avoid_phrases`; use
  `snail_mail_pitch` verbatim-ish for snail-mail CTAs. Make clear it's a suggestion she can drop.
- Reel hooks: curiosity- or process-reveal based ("Watch me turn this doodle into…"), and they
  should reference what's actually visible in the attached art.

---

## Agent 3 — Distribution Agent

**Model:** `claude-haiku-4-5-20251001`
**Trigger:** runs when a post is approved in the UI.
**Runtime:** on demand.

### What it does
1. Reads the approved `posts` row.
2. **Confirms the final posting time** (owns `slot_time`): keeps Strategy's value unless the
   last ~5 posts cluster at the same time, in which case it nudges to avoid back-to-back
   identical slots. Uses `settings.default_post_time` as the floor. No fake optimization.
3. Generates a plain-text **posting checklist** → writes to `posts.posting_checklist`.
4. If a market `application_deadline` is within 14 days, drafts a blurb →
   writes to `markets.draft_application` (not `notes`).
5. **Writes `products.last_promoted_at = now()`** for the post's `product_id` when
   `cta_type` is `shop` or `snail_mail`. (This is what makes CTA rotation actually work.)
6. Sets `posts.status = 'approved'`.

### Posting checklist format (example)
```
POST CHECKLIST
- Best time to post: 6:30 PM today (default — not data-optimized yet)
- Use file: <art_filename>
- Caption: <her approved caption>
- First comment: pin the shop link -> <cta_url>
- Add to Story after posting: yes (tag shop)
- Tag location: yes if at studio
```

---

## Human review UI (Streamlit)

Local Streamlit app. Wrap every agent trigger in `st.spinner(...)` and `try/except` so a
failed API call surfaces an error instead of leaving a half-written row. If an agent write
fails mid-way, roll back or mark the row clearly so it's not mistaken for a clean draft.

### View 1 — Weekly calendar
- Shows the current week's `calendar` slots: date, format badge, theme, content idea, priority.
- **Attach art** control per slot (file upload) → saves the file and sets `art_filename` on
  the slot's linked draft (create the draft row if needed). The "Generate draft" button is
  disabled until art is attached.
- **Generate draft** button → triggers the Content Agent for that slot.
- **"Run weekly plan now"** button → triggers the Strategy Agent (cron fallback).
- Status indicator per slot: draft / approved / posted / discarded.

### View 2 — Post review
- Lists posts with `status = 'draft'`.
- Per post shows: attached art preview, hashtags, CTA suggestion + URL, agent reasoning, and
  (if reel) the hook + script from `reel_script`.
- **A caption text box where she writes / pastes her own caption** → saves to `posts.caption`.
- Editable hashtag and CTA fields so she can tweak before approving.
- **Approve** (requires a non-empty caption) → sets status, triggers Distribution Agent.
- **Discard** → sets `status = 'discarded'` (soft delete; row is kept).

### View 3 — Engagement entry (core, not optional)
- After a post goes live, a form to enter `likes`, `comments`, `reach`, `saves` for any
  `posted` row missing them.
- A persistent nudge/banner: "N posted items still need their numbers" so the learning loop
  stays fed. This is what powers the Strategy Agent's first-party weighting.

### Market deadline banner
- Shows any `markets` with `application_deadline` within 14 days, plus the
  `draft_application` text if the Distribution Agent has written one.

---

## File structure

```
art-agent/
├── README.md
├── requirements.txt
├── .env                        # ANTHROPIC_API_KEY  (gitignored)
├── .gitignore                  # MUST include .env and data/
├── db/
│   └── init.sql                # schema (includes settings table)
├── data/
│   └── art_business.db         # gitignored
│   └── art/                    # uploaded art files referenced by art_filename
├── agents/
│   ├── strategy_agent.py
│   ├── content_agent.py
│   └── distribution_agent.py
├── utils/
│   ├── db.py                   # read/write helpers per table
│   └── claude.py               # shared client + web-search wrapper + forced-JSON parsing
├── ui/
│   └── app.py                  # Streamlit (3 views + banner)
├── scripts/
│   ├── seed_brand_voice.py     # populate brand_voice (real data)
│   └── seed_settings.py        # populate settings row 1
└── cron/
    └── weekly_strategy.sh
```

`.gitignore` must contain at least:
```
.env
data/
```

---

## Environment and dependencies

```
# .env
ANTHROPIC_API_KEY=your_key_here
```

```
# requirements.txt
anthropic>=0.40.0
streamlit>=1.35.0
python-dotenv>=1.0.0
```

SQLite ships with Python's standard library.

---

## Output reliability (applies to all agents)

Do **not** rely on "please return JSON" in free text. In `utils/claude.py`:
- Use tool-use / a forced JSON schema so each agent returns a parseable object.
- Wrap parsing defensively: strip accidental ``` fences, and on a parse failure **retry once**
  with a stricter instruction before giving up.
- On final failure, write nothing to SQLite and surface a clear error to the caller/UI.

Define the exact JSON shape for each agent in its system prompt, and keep context lean
(Strategy: last 30 posts, not all-time; Content: only the fields it uses).

---

## Build order

1. `db/init.sql` — all tables incl. `settings`. Then `seed_settings.py` and
   `seed_brand_voice.py` with real data.
2. `utils/db.py` — typed read/write helpers; JSON-array handling for `hashtags` /
   `example_captions`. Test with manual inserts.
3. `utils/claude.py` — shared client, web-search wrapper, forced-JSON + retry. Test a basic
   call and a web-search call.
4. `agents/strategy_agent.py` — test with dummy post history; inspect calendar; verify
   idempotent re-run doesn't duplicate.
5. `agents/content_agent.py` — test with one slot + a real attached image; review hashtags,
   CTA suggestion, reel hook.
6. `ui/app.py` — three views + banner; wire attach-art, generate, approve (caption required),
   discard, engagement entry, "Run weekly plan now".
7. `agents/distribution_agent.py` — build last; verify it writes `posting_checklist`,
   `markets.draft_application`, and `products.last_promoted_at` without clobbering anything.
8. `cron/weekly_strategy.sh` — wire cron once everything works (UI button remains the fallback).

---

## What this system is NOT
- Does **not** post automatically to Instagram.
- Does **not** write captions — the artist does.
- Does **not** scrape competitor accounts.
- Does **not** require a cloud server.
- Does **not** use paid third-party APIs beyond Anthropic.
- Does **not** manage ad spend or boosted posts.

---

## Handoff notes
Built by the developer for his girlfriend's art business. He's comfortable with Python and
agent pipelines and wants working, clean code — no placeholder comments or boilerplate. When
in doubt, choose the simpler path. The goal is something she'll actually use daily.