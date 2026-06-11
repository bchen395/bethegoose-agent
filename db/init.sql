-- db/init.sql — schema for the Art Business Agent system.
--
-- Build the database from this file:
--     sqlite3 data/art_business.db < db/init.sql
--
-- Then seed the single-row config tables:
--     python scripts/seed_settings.py
--     python scripts/seed_brand_voice.py
--
-- Re-running this file is safe: every table uses CREATE TABLE IF NOT EXISTS,
-- so it never drops data. To rebuild from scratch, delete data/art_business.db
-- first. All datetimes are stored as ISO-8601 TEXT (SQLite has no native date
-- type); all times/dates are in settings.timezone. hashtags / example_captions /
-- avoid_phrases are JSON arrays in TEXT columns (use SQLite's json_* functions).

PRAGMA foreign_keys = ON;

-- settings: single row (id = 1). Centralizes config the agents read so nothing
-- is hardcoded.
CREATE TABLE IF NOT EXISTS settings (
    id                INTEGER PRIMARY KEY CHECK (id = 1),
    timezone          TEXT    NOT NULL,              -- IANA name, e.g. America/New_York
    hashtag_count_min INTEGER NOT NULL,              -- lower bound for Content Agent hashtag sets
    hashtag_count_max INTEGER NOT NULL,              -- upper bound; Strategy may narrow per-week
    default_post_time TEXT    NOT NULL,              -- HH:MM fallback, e.g. 18:30
    reels_required    INTEGER NOT NULL DEFAULT 0,    -- boolean: 1 = require >=1 reel/week
    CHECK (reels_required IN (0, 1)),
    CHECK (hashtag_count_min <= hashtag_count_max)
);

-- products: synced from the shop. Drives CTAs and their rotation.
CREATE TABLE IF NOT EXISTS products (
    id               INTEGER PRIMARY KEY,
    name             TEXT    NOT NULL,
    url              TEXT,
    type             TEXT    NOT NULL CHECK (type IN ('print', 'sticker', 'craft', 'snail_mail')),
    active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),  -- currently in stock
    last_promoted_at TEXT                                                 -- set = now() on approval
);

-- posts: every post and every draft.
CREATE TABLE IF NOT EXISTS posts (
    id                INTEGER PRIMARY KEY,
    created_at        TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    posted_at         TEXT,                                               -- null until posted
    status            TEXT    NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'approved', 'posted', 'discarded')),
    format            TEXT    CHECK (format IN ('static', 'carousel', 'reel', 'story')),
    art_filename      TEXT,                                               -- null until art attached in UI
    caption           TEXT,                                               -- human-written; null until review
    hashtags          TEXT,                                               -- JSON array, e.g. ["#indieart"]
    cta_type          TEXT    CHECK (cta_type IN ('shop', 'snail_mail', 'market', 'none')),
    cta_url           TEXT,
    cta_suggestion    TEXT,                                               -- agent's suggested CTA line
    product_id        INTEGER REFERENCES products(id),                    -- CTA target; drives rotation
    reel_script       TEXT,                                               -- hook + outline, reel only
    agent_reasoning   TEXT,                                               -- Content Agent's brief rationale
    posting_checklist TEXT,                                               -- written by Distribution Agent
    likes             INTEGER,                                            -- filled after posting
    comments          INTEGER,                                            -- filled after posting
    reach             INTEGER,                                            -- filled after posting
    saves             INTEGER                                             -- filled after posting
);

-- calendar: the weekly plan from the Strategy Agent.
CREATE TABLE IF NOT EXISTS calendar (
    id           INTEGER PRIMARY KEY,
    week_start   TEXT    NOT NULL,                                        -- Monday of target week (DATE)
    generated_at TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    slot_date    TEXT    NOT NULL,                                        -- target posting date
    slot_time    TEXT,                                                    -- proposed by Strategy, confirmed by Distribution
    format       TEXT    CHECK (format IN ('static', 'carousel', 'reel', 'story')),
    theme        TEXT,
    content_idea TEXT,                                                    -- 1-2 sentence description
    priority     INTEGER CHECK (priority IN (1, 2)),                      -- 1 = must post, 2 = nice to have
    post_id      INTEGER REFERENCES posts(id)                             -- linked once a draft is created
);

-- markets: art-market applications and events.
CREATE TABLE IF NOT EXISTS markets (
    id                   INTEGER PRIMARY KEY,
    name                 TEXT NOT NULL,
    location             TEXT,
    event_date           TEXT,
    application_deadline  TEXT,
    status               TEXT CHECK (status IN ('considering', 'applied', 'accepted', 'rejected', 'attended')),
    draft_application    TEXT,                                            -- agent-written blurb
    notes                TEXT                                             -- human notes only
);

-- brand_voice: single row (id = 1). Informs reel hooks and CTA suggestions,
-- not captions (the artist writes those herself).
CREATE TABLE IF NOT EXISTS brand_voice (
    id               INTEGER PRIMARY KEY CHECK (id = 1),
    artist_name      TEXT,                                               -- how she refers to herself
    tone_description TEXT,
    example_captions TEXT,                                              -- JSON array of real captions
    avoid_phrases    TEXT,                                              -- JSON array
    snail_mail_pitch TEXT
);

-- Indexes matching the agents' documented query patterns.
CREATE INDEX IF NOT EXISTS idx_posts_status       ON posts(status);
CREATE INDEX IF NOT EXISTS idx_posts_posted_at    ON posts(posted_at);
CREATE INDEX IF NOT EXISTS idx_calendar_week      ON calendar(week_start);
CREATE INDEX IF NOT EXISTS idx_products_promoted  ON products(last_promoted_at);
CREATE INDEX IF NOT EXISTS idx_markets_deadline   ON markets(application_deadline);
