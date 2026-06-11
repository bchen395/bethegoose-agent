"""agents/content_agent.py — Agent 2: per-post supporting material.

Model: claude-haiku-4-5-20251001 (hashtags + reel hooks + CTA suggestion;
fast and cheap). Trigger: the UI's "Generate draft" button, once per calendar
slot AFTER the artist has attached art. Runtime: on demand.

It does NOT write a caption — she writes that herself at review time. It prepares
the material around the caption (SPEC § "Agent 2 — Content Agent").

Flow:
  1. Read one `calendar` slot (theme, format, content_idea).
  2. Read the attached art file and pass the actual image — or a representative
     frame for video — to the model, so hashtags/hooks reference the real artwork.
  3. Read `brand_voice` + `settings`, the active `products` (least-recently-
     promoted first, for CTA rotation), and the last ~5 posted rows' hashtags and
     reel scripts (variety only).
  4. Produce a hashtag set, a CTA suggestion (+ product + URL), and — for reels —
     a hook line and rough outline, all via a forced-JSON call (utils/claude.py).
  5. Upsert the slot's `draft` post: the UI's attach-art step creates the draft
     row and sets `art_filename`, so we fill that row in; if no linked draft
     exists yet we insert one and link it. `caption` is left null.

The calendar has no CTA column — the Strategy Agent wove CTA intent into the
slot's theme/content_idea — so this agent reads that intent, picks the cta_type
and (for shop/snail_mail) the product, and we resolve cta_url from that product.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# Make `utils` importable when run directly (python agents/content_agent.py),
# not only when imported from the project root (UI).
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from utils import claude, db  # noqa: E402

ART_DIR = Path(__file__).resolve().parents[1] / "data" / "art"

VALID_CTA_TYPES = {"shop", "snail_mail", "market", "none"}

# Video extensions we'll try to grab a representative frame from (needs ffmpeg).
_VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv"}


# --- Output schema -----------------------------------------------------------

def _schema(hmin, hmax):
    """Forced-JSON shape for the draft. `product_id` and `reel_script` are
    optional (omitted when there's no product CTA / it isn't a reel)."""
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "hashtags": {
                "type": "array",
                "minItems": hmin,
                "maxItems": hmax,
                "items": {"type": "string"},
                "description": (
                    f"{hmin}-{hmax} hashtags, a mix of large/medium/niche reach, "
                    "specific to what's visible in the image and the slot theme."
                ),
            },
            "cta_type": {"type": "string", "enum": sorted(VALID_CTA_TYPES)},
            "product_id": {
                "type": "integer",
                "description": (
                    "An id from active_products; include when cta_type is 'shop' "
                    "or 'snail_mail', omit otherwise."
                ),
            },
            "cta_suggestion": {
                "type": "string",
                "description": "Suggested CTA line in her voice; empty if cta_type is 'none'.",
            },
            "reel_script": {
                "type": "string",
                "description": "Reel only: a hook line + a rough 3-5 beat outline. Omit for non-reels.",
            },
            "agent_reasoning": {
                "type": "string",
                "description": "1-2 sentences on the hashtag/CTA/hook choices.",
            },
        },
        "required": ["hashtags", "cta_type", "cta_suggestion", "agent_reasoning"],
    }


# --- Prompt ------------------------------------------------------------------

def _system_prompt(settings, brand_voice):
    hmin = settings.get("hashtag_count_min")
    hmax = settings.get("hashtag_count_max")
    artist = brand_voice.get("artist_name") or "the artist"
    return f"""You are the Content Agent for {artist}, a one-person indie art \
business on Instagram (under 1,000 followers). She draws original comics, \
doodles, and stickers and sells prints, stickers, crafts, and a monthly \
snail-mail subscription.

She writes her own captions — you do NOT write a caption. You prepare the \
material AROUND the caption: a hashtag set, a suggested call-to-action line, \
and, for reels, a hook and rough script.

You are shown the ACTUAL artwork for this post as an image. Look at it closely. \
Your hashtags and (for reels) your hook must reference what is genuinely visible \
in that image, not a generic guess.

HASHTAGS:
- Return between {hmin} and {hmax} hashtags (the count comes from settings, it is \
not a fixed number).
- Mix reach tiers: some large (1M+ posts), some medium (100K-1M), some niche \
(<100K). Niche tags are where a small account actually gets discovered.
- Make them specific to what's in the image and to the slot theme.
- Vary them from `recent_hashtag_sets` — don't repeat the same block every post.

CTA SUGGESTION (she may use it, edit it, or drop it entirely):
- Infer the CTA from the slot's theme/content_idea. If it points to the online \
shop, set cta_type "shop" and choose the most fitting, least-recently-promoted \
item from `active_products`. If it points to the subscription, set "snail_mail". \
If it teases or announces an art market, set "market". If nothing fits, set \
"none" and leave cta_suggestion empty.
- Write it in her voice: warm, casual, a little playful, NEVER salesy. Match \
`tone_description` and never use any phrase in `avoid_phrases`.
- For a snail-mail CTA, base it closely on `snail_mail_pitch`.
- For "shop" or "snail_mail", return the `product_id` you chose from \
`active_products`.

REEL (only when the slot format is "reel"):
- Provide `reel_script`: a curiosity- or process-reveal hook line (e.g. "Watch me \
turn this doodle into…") that references what's visible in the image, followed by \
a rough 3-5 beat outline.
- Vary the hook from `recent_reel_scripts`.
- For any non-reel format, omit `reel_script` entirely.

Keep `agent_reasoning` to 1-2 sentences. Call the `record_draft` tool exactly once."""


def _context(slot, settings, brand_voice, products, recent):
    """Lean context — only the fields the agent reasons over (SPEC § Output reliability)."""
    return {
        "slot": {
            "format": slot.get("format"),
            "theme": slot.get("theme"),
            "content_idea": slot.get("content_idea"),
        },
        "settings": {
            "hashtag_count_min": settings.get("hashtag_count_min"),
            "hashtag_count_max": settings.get("hashtag_count_max"),
        },
        "brand_voice": {
            "artist_name": brand_voice.get("artist_name"),
            "tone_description": brand_voice.get("tone_description"),
            "example_captions": brand_voice.get("example_captions"),
            "avoid_phrases": brand_voice.get("avoid_phrases"),
            "snail_mail_pitch": brand_voice.get("snail_mail_pitch"),
        },
        "active_products": [
            {k: p.get(k) for k in ("id", "name", "type", "url", "last_promoted_at")}
            for p in products
        ],
        "recent_hashtag_sets": [p["hashtags"] for p in recent if p.get("hashtags")],
        "recent_reel_scripts": [p["reel_script"] for p in recent if p.get("reel_script")],
    }


# --- Art file -> image block -------------------------------------------------

def _resolve_art_path(art_filename):
    """Find the art file. art_filename is normally a bare name under data/art/,
    but an absolute or cwd-relative path (e.g. from the CLI) also works."""
    p = Path(art_filename)
    if p.is_absolute() and p.exists():
        return p
    candidate = ART_DIR / art_filename
    if candidate.exists():
        return candidate
    if p.exists():
        return p
    raise claude.AgentError(
        f"Art file not found for {art_filename!r} (looked under {ART_DIR})."
    )


def _extract_video_frame(video_path):
    """Grab the first frame of a video to a temp PNG using ffmpeg.

    Best-effort: if ffmpeg isn't installed we raise a clear, actionable error
    rather than generating blind — the SPEC requires outputs to reference the
    real artwork.
    """
    if shutil.which("ffmpeg") is None:
        raise claude.AgentError(
            f"{video_path.name} is a video, but ffmpeg isn't installed to grab a "
            "frame. Install ffmpeg, or attach a representative still image instead."
        )
    fd, tmp = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    tmp_path = Path(tmp)
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(video_path), "-frames:v", "1", str(tmp_path)],
            check=True, capture_output=True,
        )
    except (subprocess.CalledProcessError, OSError) as e:
        tmp_path.unlink(missing_ok=True)
        raise claude.AgentError(f"Could not extract a frame from {video_path.name}: {e}")
    if not tmp_path.exists() or tmp_path.stat().st_size == 0:
        tmp_path.unlink(missing_ok=True)
        raise claude.AgentError(f"Frame extraction produced no image for {video_path.name}.")
    return tmp_path


def _art_image_block(art_path):
    """Build the image content block, extracting a frame first for videos."""
    if art_path.suffix.lower() in _VIDEO_EXTS:
        frame = _extract_video_frame(art_path)
        try:
            return claude.image_block(frame)        # base64-encoded before cleanup
        finally:
            frame.unlink(missing_ok=True)
    return claude.image_block(art_path)             # raises AgentError on unsupported types


# --- Post-process the model output -------------------------------------------

def _normalize_hashtags(raw, hmax):
    """Clean and de-dupe hashtags; trim to the max. Raise if none survive."""
    tags, seen = [], set()
    for t in raw if isinstance(raw, list) else []:
        if not isinstance(t, str):
            continue
        body = "".join(t.strip().lstrip("#").split())    # drop '#'/spaces, no inner spaces
        if not body:
            continue
        tag = "#" + body
        key = tag.lower()
        if key not in seen:
            seen.add(key)
            tags.append(tag)
    if not tags:
        raise claude.AgentError("Content Agent returned no usable hashtags.")
    return tags[:hmax]


def _fallback_product(cta_type, products):
    """Pick a product when the model didn't return a valid id. `products` are
    least-recently-promoted first, so the first match keeps rotation honest."""
    if cta_type == "snail_mail":
        return next((p for p in products if p.get("type") == "snail_mail"), None)
    # shop: prefer a non-subscription item, else fall back to anything active.
    return next((p for p in products if p.get("type") != "snail_mail"),
                products[0] if products else None)


def _resolve_cta(model_out, products):
    """Map the model's CTA choice onto a (cta_type, suggestion, product_id, url)."""
    cta_type = model_out.get("cta_type")
    if cta_type not in VALID_CTA_TYPES:
        cta_type = "none"
    suggestion = (model_out.get("cta_suggestion") or "").strip() or None

    if cta_type in ("shop", "snail_mail"):
        by_id = {p["id"]: p for p in products}
        product = by_id.get(model_out.get("product_id")) or _fallback_product(cta_type, products)
        if product is not None:
            return cta_type, suggestion, product["id"], product.get("url")
        return cta_type, suggestion, None, None     # no product to point at; keep the line
    return cta_type, suggestion, None, None          # market / none carry no product


# --- Orchestration -----------------------------------------------------------

def generate_draft(slot_id, art_filename=None):
    """Generate the supporting material for one calendar slot and upsert its draft.

    Args:
      slot_id: the `calendar` row to generate for.
      art_filename: optional override; defaults to the art already attached to
        the slot's linked draft post (the UI's attach-art step sets it there).

    Returns a dict: post_id, slot_id, and the fields written (hashtags, cta_*,
    product_id, reel_script, agent_reasoning). Raises claude.AgentError on any
    failure, in which case nothing was written.
    """
    slot = db.get_calendar_slot(slot_id)
    if not slot:
        raise claude.AgentError(f"Calendar slot {slot_id} not found.")

    # The UI's attach-art step creates the draft post (linked via slot.post_id)
    # and sets art_filename on it. Fill that row in; fall back to inserting one.
    post = db.get_post(slot["post_id"]) if slot.get("post_id") else None
    art_filename = art_filename or (post.get("art_filename") if post else None)
    if not art_filename:
        raise claude.AgentError(
            "No art attached for this slot — attach art before generating a draft."
        )
    art_path = _resolve_art_path(art_filename)

    settings = db.get_settings()
    if not settings:
        raise claude.AgentError("settings row is missing — run scripts/seed_settings.py first.")
    brand_voice = db.get_brand_voice()
    if not brand_voice:
        raise claude.AgentError("brand_voice row is missing — run scripts/seed_brand_voice.py first.")

    products = db.get_active_products()
    recent = db.get_recent_posted(5)

    hmin = settings.get("hashtag_count_min")
    hmax = settings.get("hashtag_count_max")

    content = [
        _art_image_block(art_path),
        {
            "type": "text",
            "text": (
                "The image above is the actual artwork for this post. Here is the "
                "slot and context:\n\n"
                + json.dumps(_context(slot, settings, brand_voice, products, recent),
                             ensure_ascii=False, indent=2)
            ),
        },
    ]

    result = claude.call_json(
        model=claude.CONTENT_MODEL,
        system=_system_prompt(settings, brand_voice),
        content=content,
        schema=_schema(hmin, hmax),
        tool_name="record_draft",
        tool_description="Record the post's hashtags, CTA suggestion, and reel script.",
        max_tokens=1500,
    )

    hashtags = _normalize_hashtags(result.get("hashtags"), hmax)
    cta_type, cta_suggestion, product_id, cta_url = _resolve_cta(result, products)

    fmt = slot.get("format")
    reel_script = (result.get("reel_script") or "").strip()
    if fmt == "reel":
        if not reel_script:
            raise claude.AgentError("Reel slot needs a hook + script, but none was generated.")
    else:
        reel_script = None                           # non-reels carry no script

    fields = {
        "status": "draft",
        "format": fmt,
        "art_filename": art_filename,
        "hashtags": hashtags,                        # list -> JSON via utils/db.py
        "cta_type": cta_type,
        "cta_url": cta_url,
        "cta_suggestion": cta_suggestion,
        "product_id": product_id,
        "reel_script": reel_script,
        "agent_reasoning": (result.get("agent_reasoning") or "").strip() or None,
    }

    if post:
        db.update_post(post["id"], **fields)         # caption left untouched (stays null)
        post_id = post["id"]
    else:
        post_id = db.insert_post(**fields)           # caption defaults to null
        db.link_slot_to_post(slot_id, post_id)

    return {"post_id": post_id, "slot_id": slot_id, **fields}


def main():
    parser = argparse.ArgumentParser(
        description="Generate a draft's supporting material for one calendar slot."
    )
    parser.add_argument("--slot", type=int, required=True, help="calendar slot id")
    parser.add_argument(
        "--art",
        help="art filename (under data/art/) or path; defaults to the slot's attached art.",
    )
    args = parser.parse_args()

    try:
        draft = generate_draft(args.slot, art_filename=args.art)
    except claude.AgentError as e:
        raise SystemExit(f"Content Agent failed (nothing written): {e}")

    print(f"Slot {draft['slot_id']} -> draft post {draft['post_id']} ({draft['format']})")
    print(f"  art:        {draft['art_filename']}")
    print(f"  hashtags:   {' '.join(draft['hashtags'])}")
    print(f"  cta_type:   {draft['cta_type']}"
          + (f" (product {draft['product_id']})" if draft['product_id'] else ""))
    if draft["cta_url"]:
        print(f"  cta_url:    {draft['cta_url']}")
    if draft["cta_suggestion"]:
        print(f"  cta line:   {draft['cta_suggestion']}")
    if draft["reel_script"]:
        print(f"  reel:\n      " + draft["reel_script"].replace("\n", "\n      "))
    if draft["agent_reasoning"]:
        print(f"  reasoning:  {draft['agent_reasoning']}")


if __name__ == "__main__":
    main()
