"""
seed_brand_voice.py — populate the single-row `brand_voice` table (id = 1).

Run once after db/init.sql has created the schema:

    python scripts/seed_brand_voice.py

Re-running is safe; it overwrites row 1 with these values.

NOTE: example_captions and avoid_phrases are stored as JSON arrays (TEXT).
The Content Agent reads this row on every run to keep reel hooks and CTA
suggestions sounding like her — it does NOT write captions.
"""

import json
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parents[1] / "data" / "art_business.db"

# --- Voice profile -----------------------------------------------------------

ARTIST_NAME = "Be The Goose (@bethegoose)"

# Distilled from her real captions. The comic context is included here because
# brand_voice has no dedicated field for it, and the Content Agent benefits from
# knowing the series names when writing reel hooks.
TONE_DESCRIPTION = (
    "Warm, casual, and enthusiastic — she writes the way she texts a friend. "
    "Heavy on exclamation points, often doubled or tripled (!!, !!!). Personal "
    "and a little vulnerable (happy to say when she's nervous or ask her audience "
    "for help). Playful, slightly absurd sense of humor. Frequently references her "
    "own pets, family pets, and commission subjects by name. Never salesy or "
    "corporate. Her comics post under 'The Daily Dog' / 'Daily Dog Presents'; the "
    "overall account is 'Be The Goose'. Daily doodles are often captioned as a "
    "playful one-liner labeling the character."
)

# Her real captions, verbatim. These anchor the model's sense of her voice.
EXAMPLE_CAPTIONS = [
    "Read left to right!",
    "Read left to right!!",
    "Commission done for my mom ❤️ Penelope loves bird hunting!",
    "I'm trying out some new layouts for my comics!",
    "Commission for my sisters cat calypso!!",
    "My daily doodle: the best lawyer in town!",
    "Come out and support!!! I'm super nervous, any tips from other vendors "
    "would be greatly appreciated!!",
    "She loves the stinkiest stuffed animal carcasses",
]

# Inferred defaults that would clash with her voice. REVIEW WITH HER and edit —
# these are starter guesses, not things she actually told us to avoid.
AVOID_PHRASES = [
    "link in bio",
    "don't miss out",
    "grab yours today",
    "limited time offer",
    "shop now",
    "buy now",
    "act fast",
    "exclusive deal",
]

# PLACEHOLDER — she did not provide a snail-mail pitch. This is a stand-in written
# in her register so the system runs end-to-end. REPLACE with her own wording
# before relying on any snail-mail CTA output.
SNAIL_MAIL_PITCH = (
    "[PLACEHOLDER — replace with her words] Every month I mail out a little packet "
    "of original doodles, a sticker or two, and a handwritten note — basically happy "
    "mail straight from my desk to yours!"
)

# -----------------------------------------------------------------------------

BRAND_VOICE = {
    "id": 1,
    "artist_name": ARTIST_NAME,
    "tone_description": TONE_DESCRIPTION,
    "example_captions": json.dumps(EXAMPLE_CAPTIONS, ensure_ascii=False),
    "avoid_phrases": json.dumps(AVOID_PHRASES, ensure_ascii=False),
    "snail_mail_pitch": SNAIL_MAIL_PITCH,
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
            INSERT OR REPLACE INTO brand_voice
                (id, artist_name, tone_description, example_captions,
                 avoid_phrases, snail_mail_pitch)
            VALUES
                (:id, :artist_name, :tone_description, :example_captions,
                 :avoid_phrases, :snail_mail_pitch)
            """,
            BRAND_VOICE,
        )
        conn.commit()
    except sqlite3.OperationalError as e:
        raise SystemExit(
            f"Could not write to `brand_voice`: {e}\n"
            "Make sure db/init.sql created the brand_voice table."
        )
    finally:
        conn.close()

    print(f"Seeded brand_voice into {DB_PATH}")
    print(f"  artist_name: {ARTIST_NAME}")
    print(f"  example_captions: {len(EXAMPLE_CAPTIONS)} captions")
    print(f"  avoid_phrases: {len(AVOID_PHRASES)} phrases (review with her)")
    if SNAIL_MAIL_PITCH.startswith("[PLACEHOLDER"):
        print("  ⚠ snail_mail_pitch is a PLACEHOLDER — replace before using snail-mail CTAs")


if __name__ == "__main__":
    main()