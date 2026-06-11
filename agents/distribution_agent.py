"""agents/distribution_agent.py — Agent 3: post-approval distribution prep.

Model: claude-haiku-4-5-20251001 (logic + formatting only). Trigger: the UI's
Approve button calls `distribute(post_id)` once the artist has written her
caption and approved (SPEC § "Agent 3 — Distribution Agent").

Flow:
  1. Read the approved `posts` row (by id, regardless of current status).
  2. Confirm the final posting time — this agent OWNS `slot_time`. Keep the time
     Strategy proposed unless the last ~5 scheduled posts cluster at it, in which
     case nudge slightly to avoid back-to-back identical slots. `default_post_time`
     is the floor; no fake optimization. The confirmed time is written back to the
     post's calendar slot.
  3. Build the plain-text posting checklist DETERMINISTICALLY in Python — the
     file name, her caption, and the CTA URL are copied verbatim, so the model can
     never alter them.
  4. The ONLY model call is the art-market blurb: when a market's application
     deadline is within 14 days, draft a short blurb in her voice via forced-JSON
     (utils/claude.py). With no such market, the agent makes no API call at all.
  5. Write the checklist to `posts.posting_checklist`, the blurb to
     `markets.draft_application` (NEVER `notes`), and — for a shop/snail_mail CTA —
     stamp `products.last_promoted_at = now()` so CTA rotation actually advances.
  6. Set `posts.status = 'approved'` LAST, so a mid-run blurb-call failure leaves
     the post a draft with nothing half-written (the UI surfaces the error).

The posting time is honestly a sensible default, not a data-derived optimum — a
sub-1K account has no Instagram Insights to optimize against (SPEC § Posting time).
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

# Make `utils` importable when run directly (python agents/distribution_agent.py),
# not only when imported from the project root (UI).
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from utils import claude, db  # noqa: E402

# Minutes to push a posting time when it would otherwise be the 3rd-in-a-row at
# the same slot — small, so it stays in her usual window (no fake optimization).
NUDGE_MINUTES = 15

# Markets with an application deadline within this many days get a draft blurb.
MARKET_DEADLINE_DAYS = 14


# --- Posting checklist (deterministic — no model) ----------------------------

def _to_12h(hhmm):
    """18:30 -> '6:30 PM'."""
    h, m = int(hhmm[:2]), int(hhmm[3:5])
    suffix = "AM" if h < 12 else "PM"
    return f"{h % 12 or 12}:{m:02d} {suffix}"


def _friendly_date(iso_date):
    """'2026-06-12' -> 'Friday, June 12' (falls back to the raw string)."""
    try:
        d = date.fromisoformat(iso_date)
    except (TypeError, ValueError):
        return iso_date
    return f"{d:%A, %B} {d.day}"


def _first_comment_line(post):
    """CTA goes in the pinned first comment; otherwise the first comment is hashtags."""
    labels = {"shop": "shop", "snail_mail": "snail-mail", "market": "market"}
    cta_type = post.get("cta_type")
    cta_url = (post.get("cta_url") or "").strip()
    if cta_type in labels and cta_url:
        return f"- First comment: pin the {labels[cta_type]} link -> {cta_url}"
    return "- First comment: drop your hashtags here"


def _build_checklist(post, confirmed_time, posting_date, is_today, nudged):
    """Assemble the SPEC's posting checklist from exact values — the file name,
    caption, and CTA URL are copied verbatim, never paraphrased by a model."""
    when = "today" if is_today else f"on {_friendly_date(posting_date)}"
    time_note = ("nudged off your default to vary timing — not data-optimized"
                 if nudged else "sensible default — not data-optimized yet")
    caption = (post.get("caption") or "").strip() or "(add your caption before posting)"
    art = post.get("art_filename") or "(attach your art first)"

    lines = [
        "POST CHECKLIST",
        f"- Best time to post: {_to_12h(confirmed_time)} {when} ({time_note})",
        f"- Use file: {art}",
        f"- Caption: {caption}",
        _first_comment_line(post),
    ]
    fmt = post.get("format")
    if fmt == "reel":
        lines.append("- Post as a Reel, then share it to your Story (tag the shop if relevant)")
    elif fmt != "story":
        lines.append("- Add to Story after posting: yes (tag the shop if relevant)")
    lines.append("- Tag location: yes if at the studio or a market")
    return "\n".join(lines)


# --- Market blurb (the only model call) --------------------------------------

_BLURB_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "market_blurb": {
            "type": "string",
            "description": (
                "A warm, genuine 2-3 sentence art-market application blurb in her "
                "voice, naming the market and what she'd bring."
            ),
        },
    },
    "required": ["market_blurb"],
}


def _blurb_system_prompt(brand_voice):
    artist = (brand_voice.get("artist_name") if brand_voice else None) or "the artist"
    return f"""You are the Distribution Agent for {artist}, a one-person indie art \
business (hand-drawn comics, doodles, stickers; sells prints, stickers, crafts, and \
a monthly snail-mail subscription). An art market's application deadline is coming \
up. Draft `market_blurb`: a warm, genuine 2-3 sentence application blurb she could \
adapt, naming the market and what she'd bring. Match `tone_description`, sound like \
her, never use any phrase in `avoid_phrases`, and never be salesy. Use the human \
`notes` only as background — do not quote them. Call the `record_market_blurb` tool \
exactly once."""


def _blurb_context(market, brand_voice):
    return {
        "market": {
            "name": market.get("name"),
            "location": market.get("location"),
            "event_date": market.get("event_date"),
            "application_deadline": market.get("application_deadline"),
            "status": market.get("status"),
            "notes": market.get("notes") or "",   # read-only background for the blurb
        },
        "brand_voice": {
            "artist_name": brand_voice.get("artist_name") if brand_voice else None,
            "tone_description": brand_voice.get("tone_description") if brand_voice else None,
            "avoid_phrases": brand_voice.get("avoid_phrases") if brand_voice else [],
        },
    }


def _draft_market_blurb(market, brand_voice):
    result = claude.call_json(
        model=claude.DISTRIBUTION_MODEL,
        system=_blurb_system_prompt(brand_voice),
        content=json.dumps(_blurb_context(market, brand_voice), ensure_ascii=False, indent=2),
        schema=_BLURB_SCHEMA,
        tool_name="record_market_blurb",
        tool_description="Record the art-market application blurb.",
        max_tokens=600,
    )
    blurb = (result.get("market_blurb") or "").strip()
    if not blurb:
        raise claude.AgentError("Distribution Agent returned an empty market blurb.")
    return blurb


# --- Posting-time confirmation -----------------------------------------------

def _norm_time(value, default):
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


def _to_minutes(hhmm):
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def _from_minutes(total):
    total %= 24 * 60
    return f"{total // 60:02d}:{total % 60:02d}"


def _confirm_time(planned, recent_times, default_time):
    """Confirm the posting time (SPEC step 2). Keep Strategy's value, floored at
    the default; nudge only if the last few scheduled posts already cluster at it.

    Returns (confirmed_HHMM, nudged_bool).
    """
    default = _norm_time(default_time, "18:30")
    base = _norm_time(planned, default)
    if _to_minutes(base) < _to_minutes(default):     # default is the floor
        base = default
    # "Cluster" = base would be the 3rd+ post at this exact time in a row.
    clustered = sum(1 for t in recent_times if _norm_time(t, None) == base) >= 2
    if clustered:
        return _from_minutes(_to_minutes(base) + NUDGE_MINUTES), True
    return base, False


# --- Orchestration -----------------------------------------------------------

def distribute(post_id):
    """Prepare distribution for an approved post and set it to 'approved'.

    Confirms the posting time, builds the posting checklist (deterministically),
    drafts a near-deadline market's application blurb (the only model call),
    stamps the promoted product, and flips status to 'approved' last. Returns a
    summary dict. Raises claude.AgentError on any failure, in which case the
    status is NOT advanced and nothing half-baked is written (the blurb call, the
    only failure point, precedes every DB write).
    """
    post = db.get_post(post_id)
    if not post:
        raise claude.AgentError(f"Post {post_id} not found.")

    settings = db.get_settings()
    if not settings:
        raise claude.AgentError("settings row is missing — run scripts/seed_settings.py first.")
    brand_voice = db.get_brand_voice()
    default_time = settings.get("default_post_time")

    # 1) Confirm the posting time (this agent owns slot_time).
    slot = db.get_calendar_slot_by_post(post_id)
    planned = slot.get("slot_time") if slot else None
    recent_times = db.get_recent_scheduled_times(limit=5, exclude_post_id=post_id)
    confirmed_time, nudged = _confirm_time(planned, recent_times, default_time)

    posting_date = (slot.get("slot_date") if slot else None) or db.today_iso()
    is_today = posting_date == db.today_iso()

    # 2) Build the checklist deterministically — verbatim file/caption/CTA URL.
    checklist = _build_checklist(post, confirmed_time, posting_date, is_today, nudged)

    # 3) Draft a blurb only for a near-deadline market that doesn't have one yet
    #    (so repeated approvals during a deadline window don't churn it). This is
    #    the agent's only API call — and the only place it can fail.
    near_markets = db.get_markets_with_deadline(MARKET_DEADLINE_DAYS)
    target_market = next(
        (m for m in near_markets if not (m.get("draft_application") or "").strip()),
        None,
    )
    blurb = _draft_market_blurb(target_market, brand_voice) if target_market else None

    # --- Writes (all after the only failure point; status last). -------------
    db.update_post(post_id, posting_checklist=checklist)

    if slot and confirmed_time != _norm_time(planned, confirmed_time):
        db.update_calendar_slot(slot["id"], slot_time=confirmed_time)

    market_drafted = None
    if target_market is not None and blurb:
        db.set_market_draft_application(target_market["id"], blurb)
        market_drafted = {"market_id": target_market["id"], "name": target_market.get("name")}

    product_promoted = None
    if post.get("cta_type") in ("shop", "snail_mail") and post.get("product_id"):
        db.set_product_promoted(post["product_id"])
        product_promoted = post["product_id"]

    db.set_post_status(post_id, "approved")           # last — leaves a draft on any earlier failure

    return {
        "post_id": post_id,
        "status": "approved",
        "slot_time": confirmed_time,
        "time_nudged": nudged,
        "posting_checklist": checklist,
        "market_drafted": market_drafted,
        "product_promoted": product_promoted,
    }


def main():
    parser = argparse.ArgumentParser(
        description="Prepare distribution for an approved post (checklist + market blurb)."
    )
    parser.add_argument("--post", type=int, required=True, help="post id to distribute")
    args = parser.parse_args()

    try:
        result = distribute(args.post)
    except claude.AgentError as e:
        raise SystemExit(f"Distribution Agent failed (status not advanced): {e}")

    print(f"Post {result['post_id']} -> {result['status']}")
    print(f"  posting time: {result['slot_time']}"
          + (" (nudged for variety)" if result["time_nudged"] else ""))
    if result["product_promoted"]:
        print(f"  promoted product: {result['product_promoted']} (last_promoted_at stamped)")
    if result["market_drafted"]:
        m = result["market_drafted"]
        print(f"  market blurb drafted for: {m['name']} (id {m['market_id']})")
    print("\n" + result["posting_checklist"])


if __name__ == "__main__":
    main()
