"""agents/strategy_agent.py — Agent 1: the weekly content-calendar planner.

Model: claude-sonnet-4-6 (editorial judgment, not rote generation).
Trigger: the Monday-morning cron and the UI's "Run weekly plan now" button —
both call `run_weekly_plan()`.

Flow (SPEC § "Agent 1 — Strategy Agent"):
  1. Read the last 30 posts, `settings`, upcoming markets (<=45 days), and active
     products (least-recently-promoted first) via utils/db.py.
  2. Run ONE web search (capped at 2-3 queries by utils/claude.py) for seasonal
     hooks and hashtag freshness — a light supplement, not a directive. If it
     fails, the plan is still produced from first-party data alone.
  3. Synthesize 3-4 calendar slots with a forced-JSON call (utils/claude.py),
     leading with her own engagement data over web trends.
  4. Write idempotently via db.replace_week_plan() — re-running a week replaces
     its unattached slots instead of duplicating them.

The calendar table has no CTA or reasoning column, so CTA intent is woven into
each slot's theme/content_idea, and the run's overall reasoning is returned to
the caller (printed by the CLI, shown by the UI) rather than persisted.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date, timedelta
from pathlib import Path

# Make `utils` importable when run directly (python agents/strategy_agent.py),
# not only when imported from the project root (UI / cron).
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from utils import claude, db  # noqa: E402

VALID_FORMATS = {"static", "carousel", "reel", "story"}

# Fields from each post that the Strategy Agent actually reasons over (SPEC says
# format, likes, comments, reach, saves, cta_type, status — plus a date for
# recency). Keeping the context lean per SPEC § Output reliability.
_POST_FIELDS = ("format", "status", "cta_type", "likes", "comments", "reach", "saves")

# Forced-JSON shape for the synthesis call. `slots` carry exactly the writable
# calendar columns; `reasoning` is surfaced to the human, not stored.
PLAN_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "reasoning": {
            "type": "string",
            "description": (
                "2-4 sentences on the format/CTA choices, including an honest note "
                "that slot times are a sensible default, not a data-derived optimum."
            ),
        },
        "slots": {
            "type": "array",
            "minItems": 1,
            "maxItems": 5,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "slot_date": {
                        "type": "string",
                        "description": "YYYY-MM-DD; must be one of target_week.allowed_dates.",
                    },
                    "slot_time": {
                        "type": "string",
                        "description": "HH:MM 24-hour; default to settings.default_post_time.",
                    },
                    "format": {"type": "string", "enum": sorted(VALID_FORMATS)},
                    "theme": {
                        "type": "string",
                        "description": "Short label, e.g. 'process video — sticker making'.",
                    },
                    "content_idea": {
                        "type": "string",
                        "description": "1-2 sentences; weave any CTA intent in here.",
                    },
                    "priority": {
                        "type": "integer",
                        "enum": [1, 2],
                        "description": "1 = must post, 2 = nice to have.",
                    },
                },
                "required": [
                    "slot_date", "slot_time", "format",
                    "theme", "content_idea", "priority",
                ],
            },
        },
    },
    "required": ["reasoning", "slots"],
}


# --- Small derivations from first-party data --------------------------------

def _date_of(post):
    """Date a post happened on (posted_at, else created_at), or None."""
    raw = post.get("posted_at") or post.get("created_at")
    if not raw:
        return None
    try:
        return date.fromisoformat(str(raw)[:10])
    except ValueError:
        return None


def _trim_post(post):
    out = {k: post.get(k) for k in _POST_FIELDS}
    d = _date_of(post)
    out["date"] = d.isoformat() if d else None
    return out


def _format_performance(posts):
    """Per-format averages over *posted* rows with metrics — makes the
    'first-party data leads' instruction concrete instead of hoping the model
    crunches 30 raw rows."""
    buckets = {}
    for p in posts:
        if p.get("status") != "posted":
            continue
        fmt = p.get("format")
        if not fmt:
            continue
        b = buckets.setdefault(fmt, {"posts": 0, "likes": [], "comments": [], "reach": [], "saves": []})
        b["posts"] += 1
        for m in ("likes", "comments", "reach", "saves"):
            v = p.get(m)
            if isinstance(v, (int, float)):
                b[m].append(v)
    out = {}
    for fmt, b in buckets.items():
        entry = {"posts": b["posts"]}
        for m in ("likes", "comments", "reach", "saves"):
            if b[m]:
                entry[f"avg_{m}"] = round(sum(b[m]) / len(b[m]), 1)
        out[fmt] = entry
    return out


def _signals(posts, today):
    """Cues for the CTA-rotation and snail-mail rules. `posts` is most-recent-first."""
    days_since_snail = None
    cta_sequence = []
    for p in posts:
        cta = p.get("cta_type")
        if cta:
            cta_sequence.append(cta)
        if days_since_snail is None and cta == "snail_mail":
            d = _date_of(p)
            if d is not None:
                days_since_snail = (today - d).days
    return {
        "days_since_snail_mail_cta": days_since_snail,  # null = never mentioned
        "recent_cta_sequence": cta_sequence[:6],         # most recent first
    }


# --- Prompts -----------------------------------------------------------------

def _research_prompt(today):
    return (
        "Research current Instagram content strategy for a small indie art business "
        "(under 1,000 followers; hand-drawn comics, doodles, stickers, prints, and a "
        "monthly snail-mail subscription). Run at most 2-3 quick web searches, then "
        "summarize concisely as a few practical bullet points covering:\n"
        f"- Seasonal or timely content hooks for {today.strftime('%B')} {today.year}.\n"
        "- Indie-art / illustration hashtags worth using or avoiding right now.\n"
        f"- What's currently working for small Instagram accounts and Reels in {today.year}.\n"
        "Keep it brief. These findings are a light supplement to the artist's own "
        "engagement data, not a directive."
    )


def _system_prompt(settings):
    default_time = settings["default_post_time"]
    if settings.get("reels_required"):
        reel_rule = "Include at least one reel this week — reels_required is on."
    else:
        reel_rule = (
            "Include a reel only when she's likely to have process footage to film; "
            "never prescribe video she can't realistically shoot."
        )
    return f"""You are the Strategy Agent for a one-person indie art business on \
Instagram (under 1,000 followers). The artist draws original comics, doodles, and \
stickers and sells prints, stickers, crafts, and a monthly snail-mail subscription. \
She posts ~3x/week and writes her own captions — you plan WHAT to post, not the words.

Your task: from the context JSON, produce a content calendar of 3-4 posting slots \
for the target week.

LEAD WITH HER OWN DATA. `format_performance` and `recent_posts` are first-party \
engagement and outrank everything else. If her carousels out-save her reels, that \
beats any article claiming "reels win." Treat `web_findings` as a light supplement \
for seasonal hooks and obviously fresh-or-stale hashtags only — never let it override \
what her own numbers show.

FORMAT MIX:
- {reel_rule}
- Aim for at least one carousel — they tend to earn saves.
- One static post (her core comic/doodle) is good.
- Vary formats across the week unless her own data clearly favors repeating one.

CTAs — there is NO separate CTA field, so weave the CTA intent into `theme`/`content_idea`:
- Rotate calls to action; don't promote the shop two slots in a row (see `signals.recent_cta_sequence`).
- If a market's event is within ~3 weeks, make at least one slot tease or announce it (see `upcoming_markets`).
- If snail mail hasn't been mentioned in 10+ days, include a slot that mentions the subscription \
(see `signals.days_since_snail_mail_cta`; null means never — include one).
- Slots with no CTA are fine.
- When a slot promotes the shop or snail mail, favor the least-recently-promoted relevant item in \
`active_products` (listed least-recent first) so promotion rotates.

POSTING TIMES: set every `slot_time` to {default_time} (the configured default), give or take a \
small per-day variation. Do NOT invent "optimal" times — a sub-1K account has no Instagram Insights \
to optimize against. In `reasoning`, say plainly that the times are a sensible default, not a \
data-derived optimum.

DATES: every `slot_date` MUST be one of the dates in `target_week.allowed_dates`. Spread slots \
across different days.

Call the `record_plan` tool exactly once with 3-4 slots."""


def _context(today, week_start, week_end, allowed_dates, settings, posts, markets, products, web):
    return {
        "today": today.isoformat(),
        "target_week": {
            "week_start": week_start.isoformat(),
            "week_end": week_end.isoformat(),
            "allowed_dates": allowed_dates,
        },
        "settings": {
            "timezone": settings.get("timezone"),
            "default_post_time": settings.get("default_post_time"),
            "reels_required": bool(settings.get("reels_required")),
            "hashtag_count_min": settings.get("hashtag_count_min"),
            "hashtag_count_max": settings.get("hashtag_count_max"),
        },
        "format_performance": _format_performance(posts),
        "recent_posts": [_trim_post(p) for p in posts],
        "signals": _signals(posts, today),
        "upcoming_markets": [
            {k: m.get(k) for k in ("name", "location", "event_date", "application_deadline", "status")}
            for m in markets
        ],
        "active_products": [
            {k: p.get(k) for k in ("id", "name", "type", "url", "last_promoted_at")}
            for p in products
        ],
        "web_findings": {"text": web["text"], "queries": web["queries"]},
    }


# --- Validation --------------------------------------------------------------

def _normalize_time(value, default):
    """Return a zero-padded HH:MM, falling back to `default` if unparseable."""
    if isinstance(value, str):
        parts = value.strip().split(":")
        if len(parts) == 2:
            try:
                h, m = int(parts[0]), int(parts[1])
            except ValueError:
                h = m = None
            if h is not None and 0 <= h <= 23 and 0 <= m <= 59:
                return f"{h:02d}:{m:02d}"
    return default


def _validate_slots(raw_slots, allowed_dates, default_time):
    """Turn the model's slots into clean calendar rows, or raise AgentError.

    Raises (rather than silently dropping) on a bad format or out-of-week date so
    a malformed plan surfaces clearly and nothing half-baked is written — the
    db.replace_week_plan write is atomic, so on any raise the calendar is untouched.
    """
    if not isinstance(raw_slots, list) or not raw_slots:
        raise claude.AgentError("Strategy Agent returned no slots.")
    allowed = set(allowed_dates)
    cleaned = []
    for i, slot in enumerate(raw_slots):
        if not isinstance(slot, dict):
            raise claude.AgentError(f"slot {i} is not an object: {slot!r}")
        fmt = slot.get("format")
        if fmt not in VALID_FORMATS:
            raise claude.AgentError(f"slot {i}: invalid format {fmt!r}")
        slot_date = (slot.get("slot_date") or "").strip()
        if slot_date not in allowed:
            raise claude.AgentError(
                f"slot {i}: slot_date {slot_date!r} is not in the target week {sorted(allowed)}"
            )
        priority = slot.get("priority")
        if priority not in (1, 2):
            priority = 2  # default an odd/missing priority to "nice to have"
        cleaned.append({
            "slot_date": slot_date,
            "slot_time": _normalize_time(slot.get("slot_time"), default_time),
            "format": fmt,
            "theme": (slot.get("theme") or "").strip(),
            "content_idea": (slot.get("content_idea") or "").strip(),
            "priority": priority,
        })
    return cleaned


# --- Orchestration -----------------------------------------------------------

def _monday_of_week(d):
    return d - timedelta(days=d.weekday())


def _run_research(today):
    """Web search as a degradable supplement — never blocks the weekly plan."""
    try:
        result = claude.web_search(prompt=_research_prompt(today))
        return {"ok": True, "text": result["text"], "queries": result["queries"]}
    except claude.AgentError as e:
        return {"ok": False, "text": f"(web research unavailable: {e})", "queries": []}


def run_weekly_plan(week_start=None):
    """Generate and idempotently write the coming week's content calendar.

    Args:
      week_start: optional Monday (YYYY-MM-DD) to target. Defaults to the Monday
        of the current week; slots are planned for today through that Sunday.

    Returns a dict: week_start, slots (the rows written), row_ids, reasoning,
    web_queries, web_used. Raises claude.AgentError on any failure, in which case
    nothing was written.
    """
    settings = db.get_settings()
    if not settings:
        raise claude.AgentError("settings row is missing — run scripts/seed_settings.py first.")
    default_time = settings["default_post_time"]

    today = date.fromisoformat(db.today_iso())
    ws = date.fromisoformat(week_start) if week_start else _monday_of_week(today)
    we = ws + timedelta(days=6)
    allowed_dates = [d.isoformat() for d in (ws + timedelta(days=i) for i in range(7)) if d >= today]
    if not allowed_dates:
        raise claude.AgentError(
            f"Target week {ws}..{we} is entirely in the past — nothing to plan."
        )

    posts = db.get_recent_posts(30)
    markets = db.get_upcoming_markets(45)
    products = db.get_active_products()
    web = _run_research(today)

    context = _context(today, ws, we, allowed_dates, settings, posts, markets, products, web)
    result = claude.call_json(
        model=claude.STRATEGY_MODEL,
        system=_system_prompt(settings),
        content=json.dumps(context, ensure_ascii=False, indent=2),
        schema=PLAN_SCHEMA,
        tool_name="record_plan",
        tool_description="Record the weekly content calendar.",
        max_tokens=3000,
    )

    slots = _validate_slots(result.get("slots"), allowed_dates, default_time)
    row_ids = db.replace_week_plan(ws.isoformat(), slots)
    return {
        "week_start": ws.isoformat(),
        "slots": slots,
        "row_ids": row_ids,
        "reasoning": (result.get("reasoning") or "").strip(),
        "web_queries": web["queries"],
        "web_used": web["ok"],
    }


def main():
    parser = argparse.ArgumentParser(description="Generate the weekly content calendar.")
    parser.add_argument(
        "--week-start",
        help="Monday (YYYY-MM-DD) of the target week. Defaults to the current week.",
    )
    args = parser.parse_args()

    try:
        result = run_weekly_plan(week_start=args.week_start)
    except claude.AgentError as e:
        raise SystemExit(f"Strategy Agent failed (nothing written): {e}")

    print(
        f"Week of {result['week_start']}: wrote {len(result['slots'])} slots "
        f"(calendar ids {result['row_ids']})."
    )
    if result["web_queries"]:
        print(f"Web searches: {result['web_queries']}")
    elif not result["web_used"]:
        print("Web research: unavailable — proceeded on first-party data only.")
    print(f"\nReasoning: {result['reasoning']}\n")
    for s in result["slots"]:
        print(f"  {s['slot_date']} {s['slot_time']}  [{s['format']}] (priority {s['priority']})  {s['theme']}")
        print(f"      {s['content_idea']}")


if __name__ == "__main__":
    main()
