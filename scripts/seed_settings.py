"""
seed_settings.py — populate the single-row `settings` table (id = 1).

Run once after db/init.sql has created the schema:

    python scripts/seed_settings.py

Re-running is safe; it overwrites row 1 with these values.
Edit the VALUES below any time her preferences change, then re-run.
"""

import sqlite3
from pathlib import Path

# Resolve <project_root>/data/art_business.db regardless of where this is run from.
DB_PATH = Path(__file__).resolve().parents[1] / "data" / "art_business.db"

SETTINGS = {
    "id": 1,
    "timezone": "America/New_York",       # all slot_time values are stored in this zone
    "hashtag_count_min": 3,               # Instagram 2026: lean, hyper-relevant tags win;
    "hashtag_count_max": 5,               # >5 can read as low-intent. Kept in the caption.
    "default_post_time": "18:30",         # 6:30 PM ET fallback — change to her real best window
    "reels_required": 0,                  # 0 = aim for a reel only when she has footage (not forced)
}


def main():
    if not DB_PATH.exists():
        raise SystemExit(
            f"Database not found at {DB_PATH}.\n"
            "Run db/init.sql first (e.g. `sqlite3 data/art_business.db < db/init.sql`)."
        )

    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute(
            """
            INSERT OR REPLACE INTO settings
                (id, timezone, hashtag_count_min, hashtag_count_max,
                 default_post_time, reels_required)
            VALUES
                (:id, :timezone, :hashtag_count_min, :hashtag_count_max,
                 :default_post_time, :reels_required)
            """,
            SETTINGS,
        )
        conn.commit()
    except sqlite3.OperationalError as e:
        raise SystemExit(
            f"Could not write to `settings`: {e}\n"
            "Make sure db/init.sql created the settings table."
        )
    finally:
        conn.close()

    print(f"Seeded settings into {DB_PATH}")
    for k, v in SETTINGS.items():
        print(f"  {k}: {v}")


if __name__ == "__main__":
    main()