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
  },
  (t) => [
    check("products_type_check", sql`${t.type} in ('print', 'sticker', 'craft', 'snail_mail')`),
    index("idx_products_promoted").on(t.lastPromotedAt),
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
  },
  (t) => [
    check("calendar_format_check", sql`${t.format} in ('static', 'carousel', 'reel', 'story')`),
    check("calendar_priority_check", sql`${t.priority} in (1, 2)`),
    index("idx_calendar_week").on(t.weekStart),
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

// Convenient row types for callers (camelCase, jsonb arrays native).
export type Settings = typeof settings.$inferSelect;
export type BrandVoice = typeof brandVoice.$inferSelect;
export type Post = typeof posts.$inferSelect;
export type CalendarSlot = typeof calendar.$inferSelect;
export type Product = typeof products.$inferSelect;
export type Market = typeof markets.$inferSelect;
