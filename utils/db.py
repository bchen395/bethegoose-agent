"""utils/db.py — typed read/write helpers for the Art Business Agent SQLite DB.

Every caller (agents and UI) goes through these helpers instead of touching
SQLite directly, so that:
  - foreign keys are enforced on every connection (PRAGMA is per-connection and
    does NOT persist from init.sql),
  - JSON-array columns (hashtags, example_captions, avoid_phrases) round-trip as
    plain Python lists — callers never see or build raw JSON,
  - timestamps are written in settings.timezone as ISO-8601, matching the
    schema's stored-as-TEXT convention.

Reads return plain dicts (or None / a list of dicts). For writes, pass Python
lists for JSON columns and you get lists back on the next read.
"""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path

try:
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
except ImportError:  # zoneinfo is stdlib on 3.9+; degrade to naive local time.
    ZoneInfo = None
    ZoneInfoNotFoundError = Exception

# Resolve <project_root>/data/art_business.db regardless of the caller's cwd.
DB_PATH = Path(__file__).resolve().parents[1] / "data" / "art_business.db"

# Columns stored as JSON arrays (TEXT). Encoded/decoded transparently below.
_JSON_COLUMNS = {"hashtags", "example_captions", "avoid_phrases"}

# Writable columns per table (PK columns excluded). These allow-lists are the
# only column names interpolated into SQL, so dynamic writes stay injection-safe
# and caller typos raise instead of silently no-op'ing.
_POST_COLUMNS = {
    "created_at", "posted_at", "status", "format", "art_filename", "caption",
    "hashtags", "cta_type", "cta_url", "cta_suggestion", "product_id",
    "reel_script", "agent_reasoning", "posting_checklist",
    "likes", "comments", "reach", "saves",
}
_CALENDAR_COLUMNS = {
    "week_start", "generated_at", "slot_date", "slot_time", "format",
    "theme", "content_idea", "priority", "post_id",
}
_PRODUCT_COLUMNS = {"name", "url", "type", "active", "last_promoted_at"}
_MARKET_COLUMNS = {
    "name", "location", "event_date", "application_deadline",
    "status", "draft_application", "notes",
}


# --- Connection --------------------------------------------------------------

@contextmanager
def connect():
    """Open the DB with foreign keys on and dict-like rows.

    Commits on clean exit, rolls back on any exception — so multi-statement
    helpers (e.g. the idempotent calendar write) are atomic.
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


# --- JSON / row plumbing -----------------------------------------------------

def _loads(value):
    """Decode a JSON-array TEXT column to a list. Null/empty/garbage -> []."""
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return []
    return parsed if isinstance(parsed, list) else [parsed]


def _encode(col, value):
    """Encode a list/tuple for a JSON column; pass everything else through."""
    if col in _JSON_COLUMNS and isinstance(value, (list, tuple)):
        return json.dumps(list(value), ensure_ascii=False)
    return value


def _row(row):
    """sqlite3.Row -> dict, decoding any JSON-array columns present."""
    if row is None:
        return None
    out = dict(row)
    for col in _JSON_COLUMNS & out.keys():
        out[col] = _loads(out[col])
    return out


def _rows(rows):
    return [_row(r) for r in rows]


def _check_columns(allowed, fields):
    """Raise on unknown keys so a typo fails loudly instead of being dropped."""
    unknown = set(fields) - allowed
    if unknown:
        raise ValueError(f"Unknown columns: {sorted(unknown)}")


def _insert(conn, table, allowed, fields):
    _check_columns(allowed, fields)
    cols = list(fields)
    if not cols:
        raise ValueError(f"Nothing to insert into {table}")
    placeholders = ", ".join(f":{c}" for c in cols)
    params = {c: _encode(c, fields[c]) for c in cols}
    cur = conn.execute(
        f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({placeholders})", params
    )
    return cur.lastrowid


def _update(conn, table, allowed, pk_col, pk_val, fields):
    _check_columns(allowed, fields)
    cols = list(fields)
    if not cols:
        return
    assignments = ", ".join(f"{c} = :{c}" for c in cols)
    params = {c: _encode(c, fields[c]) for c in cols}
    params["_pk"] = pk_val
    conn.execute(
        f"UPDATE {table} SET {assignments} WHERE {pk_col} = :_pk", params
    )


# --- Time helpers (all in settings.timezone) ---------------------------------

def _zone():
    if ZoneInfo is None:
        return None
    settings = get_settings()
    name = settings.get("timezone") if settings else None
    if not name:
        return None
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError:
        return None


def now_iso():
    """Current timestamp in settings.timezone, ISO-8601 to the second."""
    return datetime.now(_zone()).isoformat(timespec="seconds")


def today_iso():
    """Current date (settings.timezone) as YYYY-MM-DD."""
    return datetime.now(_zone()).date().isoformat()


def _date_window(days):
    """(today, today+days) as ISO dates — ISO dates sort lexicographically."""
    today = datetime.now(_zone()).date()
    return today.isoformat(), (today + timedelta(days=days)).isoformat()


# --- settings / brand_voice (single rows, id = 1) ----------------------------

def get_settings():
    with connect() as conn:
        return _row(conn.execute("SELECT * FROM settings WHERE id = 1").fetchone())


def get_brand_voice():
    with connect() as conn:
        return _row(conn.execute("SELECT * FROM brand_voice WHERE id = 1").fetchone())


# --- posts -------------------------------------------------------------------

def insert_post(**fields):
    """Insert a post (default status 'draft', created_at now). Returns its id."""
    if "created_at" not in fields:
        fields["created_at"] = now_iso()
    fields.setdefault("status", "draft")
    with connect() as conn:
        return _insert(conn, "posts", _POST_COLUMNS, fields)


def update_post(post_id, **fields):
    with connect() as conn:
        _update(conn, "posts", _POST_COLUMNS, "id", post_id, fields)


def get_post(post_id):
    with connect() as conn:
        return _row(conn.execute("SELECT * FROM posts WHERE id = ?", (post_id,)).fetchone())


def get_posts_by_status(status):
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM posts WHERE status = ? ORDER BY created_at DESC, id DESC",
            (status,),
        ).fetchall()
    return _rows(rows)


def get_recent_posts(limit=30):
    """Last N posts by recency — Strategy Agent's first-party history window."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM posts "
            "ORDER BY COALESCE(posted_at, created_at) DESC, id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return _rows(rows)


def get_recent_posted(limit=5):
    """Last N *posted* rows — Content Agent reads these to vary tags/hooks."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM posts WHERE status = 'posted' "
            "ORDER BY posted_at DESC, id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return _rows(rows)


def get_posts_missing_engagement():
    """Posted rows missing any metric — powers the engagement-entry nudge."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM posts WHERE status = 'posted' AND "
            "(likes IS NULL OR comments IS NULL OR reach IS NULL OR saves IS NULL) "
            "ORDER BY posted_at DESC, id DESC"
        ).fetchall()
    return _rows(rows)


def set_post_status(post_id, status):
    update_post(post_id, status=status)


def mark_posted(post_id, posted_at=None):
    update_post(post_id, status="posted", posted_at=posted_at or now_iso())


def update_engagement(post_id, likes, comments, reach, saves):
    update_post(post_id, likes=likes, comments=comments, reach=reach, saves=saves)


# --- calendar ----------------------------------------------------------------

def replace_week_plan(week_start, slots):
    """Idempotent weekly write (Strategy Agent).

    Deletes this week's *unattached* slots (post_id IS NULL) then inserts the
    fresh plan, so re-running never duplicates a week and never discards a slot
    a draft has already been attached to. `week_start`/`generated_at` are set
    here; each slot supplies slot_date, slot_time, format, theme, content_idea,
    priority. Returns the new row ids.
    """
    generated_at = now_iso()
    new_ids = []
    with connect() as conn:
        conn.execute(
            "DELETE FROM calendar WHERE week_start = ? AND post_id IS NULL",
            (week_start,),
        )
        for slot in slots:
            fields = dict(slot, week_start=week_start, generated_at=generated_at)
            new_ids.append(_insert(conn, "calendar", _CALENDAR_COLUMNS, fields))
    return new_ids


def get_calendar_week(week_start):
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM calendar WHERE week_start = ? "
            "ORDER BY slot_date ASC, slot_time ASC, id ASC",
            (week_start,),
        ).fetchall()
    return _rows(rows)


def get_calendar_slot(slot_id):
    with connect() as conn:
        return _row(conn.execute("SELECT * FROM calendar WHERE id = ?", (slot_id,)).fetchone())


def get_calendar_slot_by_post(post_id):
    """The calendar slot linked to a post, or None — the Distribution Agent owns
    its slot_time, so it reads (and writes back) the confirmed time here."""
    with connect() as conn:
        return _row(conn.execute(
            "SELECT * FROM calendar WHERE post_id = ? ORDER BY id ASC LIMIT 1",
            (post_id,),
        ).fetchone())


def get_recent_scheduled_times(limit=5, exclude_post_id=None):
    """slot_time of the most recent calendar slots that already have a linked
    post — lets the Distribution Agent avoid scheduling back-to-back identical
    posting times. The post being scheduled can be excluded from the comparison.
    """
    with connect() as conn:
        rows = conn.execute(
            "SELECT slot_time FROM calendar "
            "WHERE post_id IS NOT NULL AND slot_time IS NOT NULL "
            "AND (:exclude IS NULL OR post_id != :exclude) "
            "ORDER BY slot_date DESC, slot_time DESC, id DESC LIMIT :limit",
            {"exclude": exclude_post_id, "limit": limit},
        ).fetchall()
    return [r["slot_time"] for r in rows]


def update_calendar_slot(slot_id, **fields):
    with connect() as conn:
        _update(conn, "calendar", _CALENDAR_COLUMNS, "id", slot_id, fields)


def link_slot_to_post(slot_id, post_id):
    update_calendar_slot(slot_id, post_id=post_id)


# --- products ----------------------------------------------------------------

def insert_product(**fields):
    with connect() as conn:
        return _insert(conn, "products", _PRODUCT_COLUMNS, fields)


def get_product(product_id):
    with connect() as conn:
        return _row(conn.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone())


def get_active_products():
    """Active products, least-recently-promoted first (NULL = never -> first)."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM products WHERE active = 1 "
            "ORDER BY last_promoted_at ASC, id ASC"
        ).fetchall()
    return _rows(rows)


def set_product_promoted(product_id, when=None):
    """Stamp last_promoted_at (Distribution Agent at approval) -> CTA rotation."""
    when = when or now_iso()
    with connect() as conn:
        _update(conn, "products", _PRODUCT_COLUMNS, "id", product_id,
                {"last_promoted_at": when})


# --- markets -----------------------------------------------------------------

def insert_market(**fields):
    with connect() as conn:
        return _insert(conn, "markets", _MARKET_COLUMNS, fields)


def get_market(market_id):
    with connect() as conn:
        return _row(conn.execute("SELECT * FROM markets WHERE id = ?", (market_id,)).fetchone())


def get_upcoming_markets(within_days=45):
    """Markets whose event_date falls within the next N days (Strategy Agent)."""
    today, cutoff = _date_window(within_days)
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM markets WHERE event_date IS NOT NULL "
            "AND event_date >= ? AND event_date <= ? ORDER BY event_date ASC",
            (today, cutoff),
        ).fetchall()
    return _rows(rows)


def get_markets_with_deadline(within_days=14):
    """Markets with an application_deadline in the next N days (Distribution + UI banner)."""
    today, cutoff = _date_window(within_days)
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM markets WHERE application_deadline IS NOT NULL "
            "AND application_deadline >= ? AND application_deadline <= ? "
            "ORDER BY application_deadline ASC",
            (today, cutoff),
        ).fetchall()
    return _rows(rows)


def set_market_draft_application(market_id, text):
    """Write the agent-drafted blurb without touching human `notes`."""
    with connect() as conn:
        _update(conn, "markets", _MARKET_COLUMNS, "id", market_id,
                {"draft_application": text})
