/**
 * lib/db/schema.ts — Drizzle schema for the Art Business Agent.
 *
 * Faithful port of db/init.sql (6 tables) to Supabase Postgres. Mechanical
 * changes from the SQLite original:
 *   - INTEGER PRIMARY KEY -> bigint generated always as identity.
 *   - JSON-in-TEXT columns (hashtags, example_captions, avoid_phrases) -> jsonb,
 *     so arrays round-trip natively (the _loads/_encode plumbing is gone).
 *   - Timestamps/dates stay ISO-8601 TEXT (faithful) so lexicographic date
 *     comparisons in the helpers keep working unchanged.
 *   - Postgres enforces foreign keys by default (no per-connection PRAGMA).
 *
 * Also folds in the FEATURES.md §1 schema deltas (additive / nullable /
 * defaulted). These are NOT read or written by the ported agents/UI this round
 * — they exist so the database is migrated once. Behavior comparison unaffected.
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// --- settings: single row (id = 1) -----------------------------------------
export const settings = pgTable(
  "settings",
  {
    id: bigint("id", { mode: "number" }).primaryKey(),
    timezone: text("timezone").notNull(), // IANA name, e.g. America/New_York
    hashtagCountMin: integer("hashtag_count_min").notNull(),
    hashtagCountMax: integer("hashtag_count_max").notNull(),
    defaultPostTime: text("default_post_time").notNull(), // HH:MM fallback
    reelsRequired: boolean("reels_required").notNull().default(false),

    // --- FEATURES.md §1 deltas (not read/written by the faithful port) ------
    weeklyMix: jsonb("weekly_mix")
      .$type<Record<string, number>>()
      .notNull()
      .default({ reel: 3, carousel: 2, static: 1 }),
    webSearchCadence: text("web_search_cadence").notNull().default("monthly"),
    lastWebSearchAt: text("last_web_search_at"), // ISO, nullable
    monthlyBudgetUsd: numeric("monthly_budget_usd").notNull().default("5"),
    captionStartersEnabled: boolean("caption_starters_enabled")
      .notNull()
      .default(false),

    // --- Item #3 (shop sync): the canonical "link in bio" shop URL, used as the
    // CTA fallback when a synced product has no per-product url. Nullable. -----
    shopUrl: text("shop_url"),
  },
  (t) => [
    check("settings_id_check", sql`${t.id} = 1`),
    check("settings_hashtag_range_check", sql`${t.hashtagCountMin} <= ${t.hashtagCountMax}`),
    check(
      "settings_web_search_cadence_check",
      sql`${t.webSearchCadence} in ('weekly', 'monthly', 'off')`,
    ),
  ],
);

// --- products: synced from the shop; drives CTAs and rotation ---------------
export const products = pgTable(
  "products",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    name: text("name").notNull(),
    url: text("url"),
    type: text("type").notNull(),
    active: boolean("active").notNull().default(true),
    lastPromotedAt: text("last_promoted_at"), // set = now() on approval

    // --- Item #3 (shop sync): external id of the Stripe product this row mirrors.
    // NULL for products created by hand in the CRUD; the sync only ever touches
    // rows where this is set, so manual products are never disturbed. ----------
    stripeProductId: text("stripe_product_id"),
  },
  (t) => [
    check("products_type_check", sql`${t.type} in ('print', 'sticker', 'craft', 'snail_mail')`),
    index("idx_products_promoted").on(t.lastPromotedAt),
    uniqueIndex("idx_products_stripe_id").on(t.stripeProductId),
  ],
);

// --- posts: every post and every draft --------------------------------------
export const posts = pgTable(
  "posts",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    postedAt: text("posted_at"),
    status: text("status").notNull().default("draft"),
    format: text("format"),
    artFilename: text("art_filename"), // Supabase Storage object key
    caption: text("caption"), // human-written; null until review
    hashtags: jsonb("hashtags").$type<string[]>(),
    ctaType: text("cta_type"),
    ctaUrl: text("cta_url"),
    ctaSuggestion: text("cta_suggestion"),
    productId: bigint("product_id", { mode: "number" }).references(() => products.id),
    reelScript: text("reel_script"),
    agentReasoning: text("agent_reasoning"),
    postingChecklist: text("posting_checklist"),
    likes: integer("likes"),
    comments: integer("comments"),
    reach: integer("reach"),
    saves: integer("saves"),

    // --- FEATURES.md §1 delta (metrics live here) ---------------------------
    shares: integer("shares"),

    // --- Item #1 (Instagram sync): IG is the source of posted rows. The daily
    // sync ingests media directly (there's no in-app draft to match against),
    // so these mirror the real post on Instagram. ig_media_id is the idempotent
    // upsert key; published_at is the real media timestamp (not a click). ------
    igMediaId: text("ig_media_id"),
    publishedAt: text("published_at"),
    statsSyncedAt: text("stats_synced_at"), // ISO; null until insights pulled
    permalink: text("permalink"), // link to the post on Instagram
  },
  (t) => [
    check(
      "posts_status_check",
      sql`${t.status} in ('draft', 'approved', 'posted', 'discarded')`,
    ),
    check("posts_format_check", sql`${t.format} in ('static', 'carousel', 'reel', 'story')`),
    check("posts_cta_type_check", sql`${t.ctaType} in ('shop', 'snail_mail', 'market', 'none')`),
    index("idx_posts_status").on(t.status),
    index("idx_posts_posted_at").on(t.postedAt),
    // Postgres allows multiple NULLs in a unique index, so legacy non-IG rows
    // are fine; the sync uses this to upsert-by-media without duplicating.
    uniqueIndex("idx_posts_ig_media_id").on(t.igMediaId),
  ],
);

// --- calendar: the weekly plan from the Strategy Agent ----------------------
export const calendar = pgTable(
  "calendar",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    weekStart: text("week_start").notNull(), // Monday of target week (DATE)
    generatedAt: text("generated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    slotDate: text("slot_date").notNull(),
    slotTime: text("slot_time"),
    format: text("format"),
    theme: text("theme"),
    contentIdea: text("content_idea"),
    priority: integer("priority"),
    postId: bigint("post_id", { mode: "number" }).references(() => posts.id),

    // --- Interactive calendar (drag-and-drop planner) -----------------------
    // done: a lightweight planning check (not tied to IG-synced post data).
    // pinned: set true on any manual edit (move / create / mark done) so a
    //   Strategy Agent re-run preserves it — replaceWeekPlan only clears
    //   un-pinned, un-attached slots. ideaId: the library idea this slot was
    //   scheduled from (the idea itself stays in post_ideas).
    done: boolean("done").notNull().default(false),
    pinned: boolean("pinned").notNull().default(false),
    ideaId: bigint("idea_id", { mode: "number" }).references(() => postIdeas.id),
  },
  (t) => [
    check("calendar_format_check", sql`${t.format} in ('static', 'carousel', 'reel', 'story')`),
    check("calendar_priority_check", sql`${t.priority} in (1, 2)`),
    index("idx_calendar_week").on(t.weekStart),
  ],
);

// --- post_ideas: the reusable idea "box" the calendar drags from ------------
// A backlog of post ideas that persists across weeks. Scheduling an idea
// *copies* its fields into a calendar slot (calendar.ideaId links back), so the
// idea stays available in the library. Created by the user or seeded by agents.
export const postIdeas = pgTable(
  "post_ideas",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    title: text("title").notNull(), // short label on the idea card
    format: text("format"), // nullable; same vocabulary as posts/calendar
    contentIdea: text("content_idea"),
    source: text("source").notNull().default("user"), // 'agent' | 'user'
    archived: boolean("archived").notNull().default(false),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    check("post_ideas_format_check", sql`${t.format} in ('static', 'carousel', 'reel', 'story')`),
    check("post_ideas_source_check", sql`${t.source} in ('agent', 'user')`),
    index("idx_post_ideas_archived").on(t.archived),
  ],
);

// --- markets: art-market applications and events ----------------------------
export const markets = pgTable(
  "markets",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    name: text("name").notNull(),
    location: text("location"),
    eventDate: text("event_date"),
    applicationDeadline: text("application_deadline"),
    status: text("status"),
    draftApplication: text("draft_application"), // agent-written blurb
    notes: text("notes"), // human notes only
  },
  (t) => [
    check(
      "markets_status_check",
      sql`${t.status} in ('considering', 'applied', 'accepted', 'rejected', 'attended')`,
    ),
    index("idx_markets_deadline").on(t.applicationDeadline),
  ],
);

// --- brand_voice: single row (id = 1) ---------------------------------------
export const brandVoice = pgTable(
  "brand_voice",
  {
    id: bigint("id", { mode: "number" }).primaryKey(),
    artistName: text("artist_name"),
    toneDescription: text("tone_description"),
    exampleCaptions: jsonb("example_captions").$type<string[]>(),
    avoidPhrases: jsonb("avoid_phrases").$type<string[]>(),
    snailMailPitch: text("snail_mail_pitch"),
  },
  (t) => [check("brand_voice_id_check", sql`${t.id} = 1`)],
);

// --- FEATURES.md §1 new tables (created empty; no code writes them yet) ------

// §4: owned-audience attribution
export const subscriberEvents = pgTable(
  "subscriber_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    occurredAt: text("occurred_at").notNull(), // ISO, Luxon in settings.timezone
    channel: text("channel").notNull(),
    count: integer("count").notNull().default(1), // batch entry allowed
    sourcePostId: bigint("source_post_id", { mode: "number" }).references(() => posts.id),
    note: text("note"),
  },
  (t) => [check("subscriber_events_channel_check", sql`${t.channel} in ('snail_mail', 'email')`)],
);

// §7: cost meter
export const usageLog = pgTable(
  "usage_log",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    occurredAt: text("occurred_at").notNull(), // ISO
    agent: text("agent").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    webSearches: integer("web_searches").notNull().default(0),
    estCostUsd: numeric("est_cost_usd").notNull().default("0"), // computed at write time
  },
  (t) => [check("usage_log_agent_check", sql`${t.agent} in ('strategy', 'content', 'distribution')`)],
);

// --- Item #1 (Instagram sync): connection + follower history -----------------

// Single-row Instagram connection (id = 1), mirrors settings/brand_voice. Holds
// the long-lived OAuth token (refreshed by the weekly cron) and last-sync stamp.
export const instagramAccount = pgTable(
  "instagram_account",
  {
    id: bigint("id", { mode: "number" }).primaryKey(),
    igUserId: text("ig_user_id").notNull(),
    username: text("username"),
    accessToken: text("access_token").notNull(),
    tokenExpiresAt: text("token_expires_at"), // ISO; refresh before this
    followersCount: integer("followers_count"),
    syncedAt: text("synced_at"), // ISO of last successful sync
  },
  (t) => [check("instagram_account_id_check", sql`${t.id} = 1`)],
);

// Follower count over time — charted as a sparkline on /insights.
export const followerSnapshots = pgTable(
  "follower_snapshots",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    capturedAt: text("captured_at").notNull(), // ISO
    followersCount: integer("followers_count").notNull(),
  },
  (t) => [index("idx_follower_snapshots_captured").on(t.capturedAt)],
);

// Convenient row types for callers (camelCase, jsonb arrays native).
export type Settings = typeof settings.$inferSelect;
export type BrandVoice = typeof brandVoice.$inferSelect;
export type Post = typeof posts.$inferSelect;
export type CalendarSlot = typeof calendar.$inferSelect;
export type PostIdea = typeof postIdeas.$inferSelect;
export type Product = typeof products.$inferSelect;
export type Market = typeof markets.$inferSelect;
export type InstagramAccount = typeof instagramAccount.$inferSelect;
export type FollowerSnapshot = typeof followerSnapshots.$inferSelect;
