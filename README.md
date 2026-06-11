# Be The Goose — Art Business Agent

A small three-agent system that helps a one-person indie art business grow on
Instagram and drive sales to an online shop and in-person art markets. The agents
do the planning and prep; **the artist writes her own captions, approves, and posts.**

Nothing posts to Instagram automatically. The agents prepare a weekly plan, the
supporting material around each post (hashtags, CTA suggestions, reel hooks), and a
posting checklist — she stays in the loop for every published post.

> Built for an artist with **under 1K followers**, ~3 posts/week of original comics,
> doodles, and stickers, who also sells prints, crafts, and a monthly snail-mail
> subscription. Optimized to stay **under $5/month** in API usage.

---

## What it does (and doesn't)

**It does:**
- Plan a weekly content calendar (3–4 slots) from her own engagement data, lightly
  supplemented by web search.
- For each post, after she attaches art: suggest hashtags, a (droppable) CTA line,
  and — for reels — a hook + rough script, all referencing the actual artwork.
- On approval: build a plain-text posting checklist, confirm the posting time, draft
  art-market application blurbs when a deadline is near, and rotate which product the
  CTA promotes.
- Track engagement (likes/comments/reach/saves) she enters back in, so next week's
  plan leads with what actually worked.

**It does NOT:**
- Post to Instagram automatically (API restrictions on personal accounts — she posts).
- Write captions — **she does.**
- Scrape competitor accounts, run a cloud server, manage ad spend, or use any paid
  third-party API beyond Anthropic.

---

## Architecture

Three standalone agents that share state **only** through one SQLite database — they
never call each other. A Streamlit app is the human-in-the-loop review surface.

```
[Inputs]  Art backlog · Past posts · Shop products · Market history
                              |
                              v
        [Shared memory — SQLite: data/art_business.db]
  Settings · Posts · Calendar · Products · Markets · Brand voice
                              |
        ______________________|______________________
       |                      |                      |
       v                      v                      v
  [Strategy Agent]      [Content Agent]      [Distribution Agent]
  claude-sonnet-4-6     claude-haiku-4-5     claude-haiku-4-5
  weekly calendar       per-post material    post-approval prep
       |______________________|______________________|
                              |
                              v
            [Human review — Streamlit: ui/app.py]
   Attach art · generate draft · write caption · approve · post
                              |
                              v
       [Engagement entered back into SQLite → Strategy learns]
```

| Agent | Model | When it runs | What it produces |
|---|---|---|---|
| **Strategy** | `claude-sonnet-4-6` | Weekly (cron + UI button) | The week's `calendar` slots; leads with first-party engagement, 2–3 web searches max |
| **Content** | `claude-haiku-4-5-20251001` | Per slot, after art is attached | `posts` draft: hashtags, CTA suggestion, reel hook/script — **no caption** |
| **Distribution** | `claude-haiku-4-5-20251001` | On approval | Posting checklist, confirmed time, market blurb, product-promotion stamp |

All agent calls use **forced tool-use / JSON output** with defensive parsing and one
retry; on final failure they write nothing and surface a clear error.

---

## Project layout

```
bethegoose-agent/
├── README.md                  # this file
├── SPEC.md                    # the build spec — source of truth
├── PROGRESS.md                # per-step build log + verification commands
├── requirements.txt
├── .env                       # ANTHROPIC_API_KEY (gitignored)
├── .gitignore                 # ignores .env and data/
├── db/
│   └── init.sql               # full schema (6 tables, incl. settings)
├── data/                      # gitignored — local state only
│   ├── art_business.db        # the SQLite database
│   ├── art/                   # uploaded art files (art_filename points here)
│   └── logs/                  # cron run logs
├── agents/
│   ├── strategy_agent.py      # Agent 1 — run_weekly_plan()
│   ├── content_agent.py       # Agent 2 — generate_draft(slot_id)
│   └── distribution_agent.py  # Agent 3 — distribute(post_id)
├── utils/
│   ├── db.py                  # the only gateway to SQLite (typed read/write helpers)
│   └── claude.py              # shared API client + web-search + forced-JSON parsing
├── ui/
│   └── app.py                 # Streamlit: 3 views + banners
├── scripts/
│   ├── seed_settings.py       # populate the settings row
│   └── seed_brand_voice.py    # populate brand voice (real data)
└── cron/
    └── weekly_strategy.sh     # Monday-morning cron for the weekly plan
```

---

## Setup

**Prerequisites:** Python 3.11+ (developed on 3.13), `sqlite3` on your PATH, and an
Anthropic API key.

```bash
# 1. Install dependencies
python3 -m pip install -r requirements.txt

# 2. Add your API key
#    Edit .env and replace the placeholder:
#    ANTHROPIC_API_KEY=sk-ant-...

# 3. Build and seed the database
mkdir -p data/art
sqlite3 data/art_business.db < db/init.sql
python3 scripts/seed_settings.py
python3 scripts/seed_brand_voice.py
```

To reset the database from scratch, `rm data/art_business.db` and re-run step 3.

**Sanity-check the DB:**
```bash
sqlite3 data/art_business.db ".tables"                 # expect 6 tables
sqlite3 data/art_business.db "SELECT * FROM settings;"  # 1 row, id=1
```

---

## Daily / weekly workflow

This is how the system is meant to be used day to day:

1. **Monday (automatic).** The cron job runs the Strategy Agent and a fresh week of
   slots is waiting. (If the laptop was asleep, click **Run weekly plan now** in the
   app — same result.)
2. **Pick a slot, attach art.** In **Weekly calendar**, upload the day's drawing to a
   slot. This creates the draft and enables **Generate draft**.
3. **Generate draft.** The Content Agent looks at the actual art and fills in hashtags,
   a CTA suggestion, and (for reels) a hook + outline. The caption stays empty.
4. **Write the caption & approve.** In **Post review**, write your own caption, tweak
   hashtags/CTA if you like, and **Approve** (a caption is required). This triggers the
   Distribution Agent, which writes the posting checklist.
5. **Post it.** In **Engagement entry**, the approved post shows its checklist. Post it
   on Instagram by hand, then **Mark as posted**.
6. **Enter the numbers.** A day or two later, enter likes/comments/reach/saves. This is
   what powers next week's plan — the banner nags you until every posted item has them.

---

## Running it

### The review app (primary interface)
```bash
streamlit run ui/app.py
```
Three views (sidebar nav) — **Weekly calendar**, **Post review**, **Engagement entry** —
plus always-on banners for upcoming market deadlines and posts still missing numbers.
The views render without an API key; the agent buttons need a real key in `.env`.

### Agents from the command line (for testing / manual runs)
```bash
# Strategy — plan the current week (or a specific Monday)
python3 agents/strategy_agent.py
python3 agents/strategy_agent.py --week-start 2026-06-15

# Content — generate a draft for one slot (needs art on disk)
python3 agents/content_agent.py --slot <id> --art myart.png

# Distribution — prep an approved-able draft post
python3 agents/distribution_agent.py --post <id>
```

---

## Weekly cron (Step 8)

`cron/weekly_strategy.sh` runs the Strategy Agent every Monday morning so a plan is
ready before she opens the app. It resolves its own location (so the crontab line is
just the absolute path), picks a Python interpreter, and logs everything to
`data/logs/weekly_strategy.log`. The **Run weekly plan now** UI button is the fallback
for when the laptop is asleep at cron time.

**Install it:**
```bash
crontab -e
# add this line — runs Mondays at 8:00 AM local time:
0 8 * * 1 /Users/bensonchen/repos/bethegoose-agent/cron/weekly_strategy.sh
```

**Check / watch:**
```bash
crontab -l                                    # confirm it's installed
tail -f data/logs/weekly_strategy.log          # watch runs
```

**macOS notes:**
- `cron` needs **Full Disk Access** (System Settings → Privacy & Security) to read
  files in your home folder. If runs silently do nothing, grant `/usr/sbin/cron` that
  permission (or switch to a `launchd` agent).
- cron runs with a minimal PATH and no shell profile. If `python3` on that bare PATH
  isn't the one with your dependencies, point the script at the right interpreter:
  ```bash
  0 8 * * 1 ART_AGENT_PYTHON=/path/to/python3 /Users/bensonchen/repos/bethegoose-agent/cron/weekly_strategy.sh
  ```
  (A `.venv/` or `venv/` in the project root is picked up automatically.)

---

## Configuration

Everything tunable lives in the `settings` and `brand_voice` rows — no values are
hardcoded in the agents. Edit the seed scripts and re-run them (`INSERT OR REPLACE`
overwrites the single row):

- **`scripts/seed_settings.py`** — timezone, hashtag count range, default post time,
  whether reels are required.
- **`scripts/seed_brand_voice.py`** — artist name, tone, example captions, phrases to
  avoid, snail-mail pitch.

> ⚠️ **Placeholders to confirm with the artist** before relying on the output (see
> `PROGRESS.md` for the full list): `brand_voice.snail_mail_pitch`,
> `brand_voice.avoid_phrases`, and `settings.default_post_time` are sensible
> starter guesses, not her confirmed wording.

---

## Cost

The target is **under $5/month**. The Content and Distribution agents use Haiku and are
cheap. The main variable cost is **web search in the Strategy Agent — each search is a
billable line item** — so it's hard-capped at 2–3 searches per weekly run. That's one
weekly Sonnet call plus a handful of searches.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `ANTHROPIC_API_KEY is not set` | `.env` still has the placeholder — add your real key. |
| Agent buttons error in the UI | Same — the views render without a key, but the agents need one. |
| `settings row is missing` | Run `python3 scripts/seed_settings.py`. |
| "Generate draft" is disabled | Attach art to the slot first — the Content Agent reads the actual file. |
| Cron does nothing on macOS | Grant `/usr/sbin/cron` Full Disk Access; check `data/logs/weekly_strategy.log`. |
| Wrong Python under cron | Set `ART_AGENT_PYTHON` in the crontab line (see above). |
| Re-running the weekly plan | Idempotent — it replaces the week's *unattached* slots; drafts you've started are kept. |

---

## How to dig deeper

- **`SPEC.md`** — the build spec; the source of truth for what the system should do.
- **`PROGRESS.md`** — a per-step build log with the exact verification commands run for
  each piece, plus the open TODOs to revisit with the artist.
