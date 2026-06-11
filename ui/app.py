"""ui/app.py — Streamlit human-review UI (SPEC § "Human review UI").

The artist is the human-in-the-loop: the agents prepare everything, she attaches
art, writes the caption, approves, and posts. This app is where she does that.

Three views (sidebar nav) plus two always-on banners:
  - View 1 — Weekly calendar: the Strategy Agent's plan for a week. Per slot:
    attach art (creates/links the draft row), then Generate draft (Content Agent).
    A "Run weekly plan now" button is the cron fallback.
  - View 2 — Post review: each draft's art, hashtags, CTA suggestion, reasoning,
    and (for reels) the hook/script. She writes her own caption, tweaks the
    hashtags/CTA, then Approves (caption required → Distribution Agent) or Discards.
  - View 3 — Engagement: approved posts ready to post (with the posting checklist
    and a "Mark as posted" button), then a form to enter likes/comments/reach/saves
    for posted rows missing them — this feeds the Strategy Agent's first-party loop.
  - Banners (top of every view): an engagement nudge and any market application
    deadlines within 14 days, with the agent's draft blurb if it has written one.

Every agent trigger runs inside an st.spinner and try/except, so a failed API call
surfaces as an error instead of leaving a half-written row — the agents already
raise claude.AgentError and write nothing on failure, so we just show its message.

All DB access goes through utils/db.py and all model calls through the agents;
this file never touches SQLite or the SDK directly.
"""

from __future__ import annotations

import re
import sys
from datetime import date, timedelta
from pathlib import Path

import streamlit as st

# Importable whether launched as `streamlit run ui/app.py` or from the repo root.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agents import content_agent, strategy_agent  # noqa: E402
from utils import claude, db  # noqa: E402

# Share the Content Agent's art directory so the attach-art contract lines up:
# the UI writes the bare filename here, the agent resolves it from the same dir.
ART_DIR = content_agent.ART_DIR

FORMAT_BADGE = {
    "static": "🖼 Static",
    "carousel": "🎠 Carousel",
    "reel": "🎬 Reel",
    "story": "📲 Story",
}
STATUS_BADGE = {
    "draft": "📝 Draft",
    "approved": "✅ Approved",
    "posted": "📣 Posted",
    "discarded": "🗑 Discarded",
}
CTA_OPTIONS = ["none", "shop", "snail_mail", "market"]
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv"}


# --- Small helpers -----------------------------------------------------------

def _today():
    return date.fromisoformat(db.today_iso())


def _monday_of_week(d):
    return d - timedelta(days=d.weekday())


def _badge(mapping, key):
    return mapping.get(key, key or "—")


def _art_path(filename):
    return ART_DIR / filename


def _sanitize_stem(stem):
    """Make an uploaded filename safe to store: keep alnum/dot/dash/underscore."""
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip("-._")
    return cleaned or "art"


def _parse_hashtags(text):
    """Parse an edited hashtag box (comma/space/newline separated) into a clean,
    de-duped list. Empty is allowed — she may clear them. Mirrors the Content
    Agent's normalization so edits and generated tags stay consistent."""
    tags, seen = [], set()
    for raw in text.replace(",", " ").split():
        body = raw.lstrip("#").strip()
        if not body:
            continue
        tag = "#" + body
        key = tag.lower()
        if key not in seen:
            seen.add(key)
            tags.append(tag)
    return tags


def _run_agent(spinner_msg, fn, *args, **kwargs):
    """Run an agent call behind a spinner; surface failures as st.error.

    Returns (ok, result). The agents raise claude.AgentError and write nothing
    on failure, so on error there's no half-written row to clean up.
    """
    try:
        with st.spinner(spinner_msg):
            return True, fn(*args, **kwargs)
    except claude.AgentError as e:
        st.error(str(e))
    except Exception as e:  # noqa: BLE001 — never crash the UI; show what broke.
        st.error(f"Unexpected error: {e}")
    return False, None


def _trigger_distribution(post_id):
    """Run the Distribution Agent (step 7) if it's been built.

    Returns one of:
      ("done", result)  — it ran and set the post to approved + wrote the checklist
      ("absent", None)  — not built yet; caller should approve the post itself
      ("error", message)— it failed; caller leaves the post as a draft
    """
    try:
        from agents import distribution_agent
    except ImportError:
        return "absent", None
    fn = getattr(distribution_agent, "distribute", None)
    if fn is None:
        return "absent", None
    try:
        with st.spinner("Distribution Agent: building the posting checklist…"):
            return "done", fn(post_id)
    except claude.AgentError as e:
        return "error", str(e)
    except Exception as e:  # noqa: BLE001
        return "error", str(e)


def _ensure_draft(slot):
    """Return the slot's linked draft post id, creating + linking one if needed.

    This is the row the Content Agent later fills in, so attach-art owns its
    creation (SPEC View 1's attach-art contract)."""
    if slot.get("post_id"):
        return slot["post_id"]
    post_id = db.insert_post(status="draft", format=slot.get("format"))
    db.link_slot_to_post(slot["id"], post_id)
    return post_id


def _save_uploaded(uploaded, slot_id):
    """Persist an uploaded art file under data/art/ and return its bare name.

    Prefixed with the slot id so different slots never clobber each other."""
    ART_DIR.mkdir(parents=True, exist_ok=True)
    ext = Path(uploaded.name).suffix.lower()
    filename = f"slot{slot_id}_{_sanitize_stem(Path(uploaded.name).stem)}{ext}"
    (ART_DIR / filename).write_bytes(uploaded.getbuffer())
    return filename


def _render_art(filename, width=320):
    if not filename:
        st.caption("No art attached.")
        return
    path = _art_path(filename)
    if not path.exists():
        st.caption(f"⚠ Art file missing on disk: {filename}")
        return
    if path.suffix.lower() in VIDEO_EXTS:
        st.video(str(path))
    else:
        st.image(str(path), width=width)


# --- Always-on banners -------------------------------------------------------

def render_banners():
    missing = db.get_posts_missing_engagement()
    if missing:
        st.warning(
            f"📊 {len(missing)} posted item(s) still need their numbers — "
            "open the Engagement view to keep the learning loop fed."
        )

    markets = db.get_markets_with_deadline(14)
    for m in markets:
        header = f"🗓 Market deadline: **{m['name']}**"
        if m.get("application_deadline"):
            header += f" — applications due {m['application_deadline']}"
        st.info(header)
        if m.get("draft_application"):
            with st.expander(f"Draft application for {m['name']}"):
                st.write(m["draft_application"])


# --- View 1: Weekly calendar -------------------------------------------------

def view_calendar():
    st.header("📅 Weekly calendar")

    offset = st.session_state.get("week_offset", 0)
    monday = _monday_of_week(_today()) + timedelta(weeks=offset)
    sunday = monday + timedelta(days=6)
    week_start_iso = monday.isoformat()

    nav_prev, nav_label, nav_next = st.columns([1, 3, 1])
    if nav_prev.button("◀ Prev week", use_container_width=True):
        st.session_state["week_offset"] = offset - 1
        st.rerun()
    label = f"Week of **{monday:%b %d}** – **{sunday:%b %d, %Y}**"
    if offset == 0:
        label += "  ·  _this week_"
    nav_label.markdown(f"<div style='text-align:center'>{label}</div>", unsafe_allow_html=True)
    if nav_next.button("Next week ▶", use_container_width=True):
        st.session_state["week_offset"] = offset + 1
        st.rerun()

    st.divider()

    if st.button("🔄 Run weekly plan now", type="primary",
                 help="Cron fallback — regenerates this week's unattached slots."):
        ok, result = _run_agent(
            "Strategy Agent: reading your engagement data and planning the week…",
            strategy_agent.run_weekly_plan, week_start_iso,
        )
        if ok:
            st.session_state["last_plan"] = result
            st.rerun()

    last = st.session_state.get("last_plan")
    if last and last.get("week_start") == week_start_iso:
        with st.expander("🧠 Strategy Agent notes from the last run", expanded=True):
            if last.get("reasoning"):
                st.write(last["reasoning"])
            if last.get("web_queries"):
                st.caption("Web searches: " + ", ".join(last["web_queries"]))
            elif not last.get("web_used"):
                st.caption("Web research was unavailable — planned on first-party data only.")

    slots = db.get_calendar_week(week_start_iso)
    if not slots:
        st.info("No plan for this week yet. Click **Run weekly plan now** to generate one.")
        return

    for slot in slots:
        post = db.get_post(slot["post_id"]) if slot.get("post_id") else None
        art = post.get("art_filename") if post else None
        status = post.get("status") if post else None

        with st.container(border=True):
            head, side = st.columns([4, 1])
            with head:
                st.markdown(
                    f"**{slot['slot_date']}** · {slot.get('slot_time') or '—'} · "
                    f"{_badge(FORMAT_BADGE, slot.get('format'))} · "
                    f"{'⭐ must-post' if slot.get('priority') == 1 else 'nice to have'}"
                )
                if slot.get("theme"):
                    st.markdown(f"**{slot['theme']}**")
                if slot.get("content_idea"):
                    st.write(slot["content_idea"])
            with side:
                if status:
                    st.markdown(_badge(STATUS_BADGE, status))
                if art:
                    _render_art(art, width=120)

            upload_col, gen_col = st.columns([3, 1])
            with upload_col:
                key = f"upload_{slot['id']}"
                uploaded = st.file_uploader(
                    "Attach art",
                    type=sorted(e.lstrip(".") for e in IMAGE_EXTS | VIDEO_EXTS),
                    key=key,
                )
                if uploaded is not None:
                    sig = (uploaded.name, uploaded.size)
                    if st.session_state.get(f"{key}_saved") != sig:
                        post_id = _ensure_draft(slot)
                        filename = _save_uploaded(uploaded, slot["id"])
                        db.update_post(post_id, art_filename=filename)
                        st.session_state[f"{key}_saved"] = sig
                        st.toast(f"Attached {filename}")
                        st.rerun()
            with gen_col:
                st.write("")  # nudge the button down to align with the uploader
                gen_label = "Regenerate draft" if status == "draft" else "Generate draft"
                if st.button(
                    gen_label, key=f"gen_{slot['id']}", disabled=not art,
                    help=None if art else "Attach art first.",
                    use_container_width=True,
                ):
                    ok, _ = _run_agent(
                        "Content Agent: looking at the art, preparing hashtags, CTA, and hook…",
                        content_agent.generate_draft, slot["id"],
                    )
                    if ok:
                        st.toast("Draft ready — see the Post review view.")
                        st.rerun()


# --- View 2: Post review -----------------------------------------------------

def view_review():
    st.header("📝 Post review")
    drafts = db.get_posts_by_status("draft")
    if not drafts:
        st.info("No drafts waiting. Generate one from the Weekly calendar.")
        return

    st.caption(f"{len(drafts)} draft(s) waiting for your caption and approval.")

    for post in drafts:
        pid = post["id"]
        with st.container(border=True):
            art_col, body_col = st.columns([1, 2])
            with art_col:
                _render_art(post.get("art_filename"))
            with body_col:
                st.markdown(
                    f"{_badge(FORMAT_BADGE, post.get('format'))} · "
                    f"draft #{pid}"
                )
                if post.get("agent_reasoning"):
                    st.caption(f"Agent reasoning: {post['agent_reasoning']}")
                if post.get("product_id"):
                    product = db.get_product(post["product_id"])
                    if product:
                        st.caption(f"Promoting: {product['name']}")
                if post.get("format") == "reel" and post.get("reel_script"):
                    with st.expander("🎬 Reel hook & script", expanded=True):
                        st.write(post["reel_script"])

            with st.form(f"review_{pid}"):
                caption = st.text_area(
                    "Your caption (you write this)",
                    value=post.get("caption") or "",
                    height=140,
                    placeholder="Write or paste your caption here…",
                    key=f"cap_{pid}",
                )
                hashtags_text = st.text_area(
                    "Hashtags",
                    value=" ".join(post.get("hashtags") or []),
                    key=f"tags_{pid}",
                )
                cta_col, url_col = st.columns(2)
                current_cta = post.get("cta_type") or "none"
                cta_type = cta_col.selectbox(
                    "CTA type", CTA_OPTIONS,
                    index=CTA_OPTIONS.index(current_cta) if current_cta in CTA_OPTIONS else 0,
                    key=f"ctatype_{pid}",
                )
                cta_url = url_col.text_input(
                    "CTA URL", value=post.get("cta_url") or "", key=f"ctaurl_{pid}",
                )
                cta_suggestion = st.text_area(
                    "Suggested CTA line (edit or drop it)",
                    value=post.get("cta_suggestion") or "",
                    key=f"ctasug_{pid}",
                )

                save_col, approve_col, discard_col = st.columns(3)
                save = save_col.form_submit_button("💾 Save draft", use_container_width=True)
                approve = approve_col.form_submit_button(
                    "✅ Approve", type="primary", use_container_width=True
                )
                discard = discard_col.form_submit_button("🗑 Discard", use_container_width=True)

            if discard:
                db.set_post_status(pid, "discarded")
                st.toast("Discarded (kept in history).")
                st.rerun()

            if save or approve:
                fields = {
                    "caption": caption.strip() or None,
                    "hashtags": _parse_hashtags(hashtags_text),
                    "cta_type": cta_type,
                    "cta_suggestion": cta_suggestion.strip() or None,
                    "cta_url": cta_url.strip() or None,
                }
                # CTA no longer points at a product → clear the rotation target so
                # the Distribution Agent doesn't stamp last_promoted_at wrongly.
                if cta_type not in ("shop", "snail_mail"):
                    fields["product_id"] = None
                db.update_post(pid, **fields)

            if save:
                st.toast("Saved.")
                st.rerun()

            if approve:
                if not caption.strip():
                    st.warning("Add a caption before approving — you write the caption.")
                else:
                    status, detail = _trigger_distribution(pid)
                    if status == "done":
                        st.success("Approved — the posting checklist is ready in the Engagement view.")
                        st.rerun()
                    elif status == "absent":
                        db.set_post_status(pid, "approved")
                        st.success(
                            "Approved. (The Distribution Agent isn't built yet, so no "
                            "posting checklist was generated.)"
                        )
                        st.rerun()
                    else:  # error — leave the post as a draft; the edits above were saved.
                        st.error(
                            f"Distribution Agent failed: {detail}\n\n"
                            "The post was kept as a draft and your caption/edits were saved."
                        )


# --- View 3: Engagement ------------------------------------------------------

def view_engagement():
    st.header("📊 Engagement")

    approved = db.get_posts_by_status("approved")
    st.subheader("Ready to post")
    if not approved:
        st.caption("Nothing approved right now.")
    for post in approved:
        pid = post["id"]
        with st.container(border=True):
            head, art = st.columns([3, 1])
            with head:
                st.markdown(f"{_badge(FORMAT_BADGE, post.get('format'))} · approved #{pid}")
                if post.get("posting_checklist"):
                    st.code(post["posting_checklist"], language=None)
                else:
                    st.caption(
                        "No posting checklist yet — it appears once the Distribution Agent runs."
                    )
                if post.get("caption"):
                    with st.expander("Caption"):
                        st.write(post["caption"])
            with art:
                _render_art(post.get("art_filename"), width=120)
            if st.button("📣 Mark as posted", key=f"posted_{pid}", type="primary"):
                db.mark_posted(pid)
                st.toast("Marked as posted — enter its numbers below once you have them.")
                st.rerun()

    st.divider()

    st.subheader("Enter numbers")
    missing = db.get_posts_missing_engagement()
    if not missing:
        st.caption("Every posted item has its numbers. 🎉")
        return

    for post in missing:
        pid = post["id"]
        with st.container(border=True):
            head, art = st.columns([3, 1])
            with head:
                st.markdown(
                    f"{_badge(FORMAT_BADGE, post.get('format'))} · posted #{pid}"
                    + (f" · {post['posted_at']}" if post.get("posted_at") else "")
                )
                if post.get("caption"):
                    st.caption(post["caption"][:120] + ("…" if len(post["caption"]) > 120 else ""))
            with art:
                _render_art(post.get("art_filename"), width=120)

            with st.form(f"engagement_{pid}"):
                c1, c2, c3, c4 = st.columns(4)
                likes = c1.number_input("Likes", min_value=0, step=1,
                                        value=int(post.get("likes") or 0), key=f"likes_{pid}")
                comments = c2.number_input("Comments", min_value=0, step=1,
                                           value=int(post.get("comments") or 0), key=f"comments_{pid}")
                reach = c3.number_input("Reach", min_value=0, step=1,
                                        value=int(post.get("reach") or 0), key=f"reach_{pid}")
                saves = c4.number_input("Saves", min_value=0, step=1,
                                        value=int(post.get("saves") or 0), key=f"saves_{pid}")
                if st.form_submit_button("💾 Save numbers", type="primary"):
                    db.update_engagement(pid, int(likes), int(comments), int(reach), int(saves))
                    st.toast("Numbers saved.")
                    st.rerun()


# --- App shell ---------------------------------------------------------------

def main():
    st.set_page_config(page_title="Art Business Agent", page_icon="🎨", layout="wide")
    st.title("🎨 Art Business Agent")

    render_banners()

    view = st.sidebar.radio(
        "View",
        ["📅 Weekly calendar", "📝 Post review", "📊 Engagement"],
    )
    st.sidebar.divider()
    st.sidebar.caption(
        "The agents prepare; you attach art, write the caption, approve, and post."
    )

    if view.endswith("Weekly calendar"):
        view_calendar()
    elif view.endswith("Post review"):
        view_review()
    else:
        view_engagement()


if __name__ == "__main__":
    main()
