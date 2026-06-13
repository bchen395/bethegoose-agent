/**
 * lib/db/index.ts — typed read/write helpers, the only gateway to Postgres.
 *
 * 1:1 port of utils/db.py. Every caller (agents + UI) goes through these so the
 * call surface matches the Python original. JSON columns are jsonb now, so the
 * encode/decode plumbing is gone — arrays round-trip natively. Timestamps are
 * written in settings.timezone as ISO-8601 (Luxon replaces zoneinfo).
 *
 * Connects through Supabase's Supavisor transaction pooler (DATABASE_URL); that
 * pooler doesn't support prepared statements, hence `prepare: false`.
 */

import { DateTime } from "luxon";
import { and, asc, desc, eq, gte, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";
import {
  brandVoice,
  calendar,
  markets,
  posts,
  products,
  settings,
  subscriberEvents,
  usageLog,
  type BrandVoice,
  type CalendarSlot,
  type Market,
  type Post,
  type Product,
  type Settings,
} from "./schema";

// Re-export the row types so callers can `import { type Post } from "@/lib/db"`.
export type { BrandVoice, CalendarSlot, Market, Post, Product, Settings } from "./schema";

// --- Connection (cached across dev hot-reloads to avoid exhausting the pool) -

const globalForDb = globalThis as unknown as { _pgClient?: ReturnType<typeof postgres> };

function makeClient() {
  // `prepare: false` — Supavisor's transaction pooler doesn't support prepared
  // statements. The placeholder URL in .env.local can be unparseable at build
  // time; fall back to a never-queried local URL so module-eval doesn't throw
  // (dynamic routes never connect at build; runtime uses the real pooled URL).
  try {
    return postgres(process.env.DATABASE_URL ?? "", { prepare: false });
  } catch {
    return postgres("postgres://localhost:5432/postgres", { prepare: false });
  }
}

const client = globalForDb._pgClient ?? makeClient();
if (process.env.NODE_ENV !== "production") globalForDb._pgClient = client;

export const db = drizzle(client, { schema });

// --- Time helpers (all in settings.timezone) --------------------------------

async function nowInZone(): Promise<DateTime> {
  const s = await getSettings();
  const tz = s?.timezone;
  if (tz) {
    const dt = DateTime.now().setZone(tz);
    if (dt.isValid) return dt;
  }
  return DateTime.now();
}

/** Current timestamp in settings.timezone, ISO-8601 to the second. */
export async function nowIso(): Promise<string> {
  const dt = (await nowInZone()).startOf("second");
  return dt.toISO({ suppressMilliseconds: true })!;
}

/** Current date (settings.timezone) as YYYY-MM-DD. */
export async function todayIso(): Promise<string> {
  return (await nowInZone()).toISODate()!;
}

/** (today, today+days) as ISO dates — ISO dates sort lexicographically. */
async function dateWindow(days: number): Promise<[string, string]> {
  const today = (await nowInZone()).startOf("day");
  return [today.toISODate()!, today.plus({ days }).toISODate()!];
}

// --- settings / brand_voice (single rows, id = 1) ---------------------------

export async function getSettings(): Promise<Settings | null> {
  const rows = await db.select().from(settings).where(eq(settings.id, 1)).limit(1);
  return rows[0] ?? null;
}

/** Patch the single settings row (id = 1). Used by the §6 web-search cadence stamp. */
export async function updateSettings(
  fields: Partial<typeof settings.$inferInsert>,
): Promise<void> {
  if (Object.keys(fields).length === 0) return;
  await db.update(settings).set(fields).where(eq(settings.id, 1));
}

export async function getBrandVoice(): Promise<BrandVoice | null> {
  const rows = await db.select().from(brandVoice).where(eq(brandVoice.id, 1)).limit(1);
  return rows[0] ?? null;
}

// --- posts ------------------------------------------------------------------

type PostInsert = typeof posts.$inferInsert;

/** Insert a post (default status 'draft', created_at now). Returns its id. */
export async function insertPost(fields: PostInsert): Promise<number> {
  const values: PostInsert = {
    ...fields,
    createdAt: fields.createdAt ?? (await nowIso()),
    status: fields.status ?? "draft",
  };
  const [row] = await db.insert(posts).values(values).returning({ id: posts.id });
  return row.id;
}

export async function updatePost(postId: number, fields: Partial<PostInsert>): Promise<void> {
  if (Object.keys(fields).length === 0) return;
  await db.update(posts).set(fields).where(eq(posts.id, postId));
}

export async function getPost(postId: number): Promise<Post | null> {
  const rows = await db.select().from(posts).where(eq(posts.id, postId)).limit(1);
  return rows[0] ?? null;
}

export async function getPostsByStatus(status: string): Promise<Post[]> {
  return db
    .select()
    .from(posts)
    .where(eq(posts.status, status))
    .orderBy(desc(posts.createdAt), desc(posts.id));
}

/** Last N posts by recency — Strategy Agent's first-party history window. */
export async function getRecentPosts(limit = 30): Promise<Post[]> {
  return db
    .select()
    .from(posts)
    .orderBy(desc(sql`coalesce(${posts.postedAt}, ${posts.createdAt})`), desc(posts.id))
    .limit(limit);
}

/** Last N *posted* rows — Content Agent reads these to vary tags/hooks. */
export async function getRecentPosted(limit = 5): Promise<Post[]> {
  return db
    .select()
    .from(posts)
    .where(eq(posts.status, "posted"))
    .orderBy(desc(posts.postedAt), desc(posts.id))
    .limit(limit);
}

/**
 * Posted rows missing the required metrics — powers the engagement-entry nudge.
 * Only saves+reach are required (FEATURES.md §3); likes/comments/shares are
 * optional, so blank values there never re-trigger the banner.
 */
export async function getPostsMissingEngagement(): Promise<Post[]> {
  return db
    .select()
    .from(posts)
    .where(
      and(eq(posts.status, "posted"), or(isNull(posts.saves), isNull(posts.reach))),
    )
    .orderBy(desc(posts.postedAt), desc(posts.id));
}

export async function setPostStatus(postId: number, status: string): Promise<void> {
  await updatePost(postId, { status });
}

export async function markPosted(postId: number, postedAt?: string): Promise<void> {
  await updatePost(postId, { status: "posted", postedAt: postedAt ?? (await nowIso()) });
}

/**
 * Save a posted row's metrics. saves+reach are required (FEATURES.md §3);
 * likes/comments/shares are optional and stored as null when not provided so a
 * blank stays distinct from a real 0.
 */
export async function updateEngagement(
  postId: number,
  metrics: {
    reach: number;
    saves: number;
    likes?: number | null;
    comments?: number | null;
    shares?: number | null;
  },
): Promise<void> {
  await updatePost(postId, {
    reach: metrics.reach,
    saves: metrics.saves,
    likes: metrics.likes ?? null,
    comments: metrics.comments ?? null,
    shares: metrics.shares ?? null,
  });
}

// --- calendar ---------------------------------------------------------------

export type SlotInput = {
  slotDate: string;
  slotTime: string;
  format: string;
  theme: string;
  contentIdea: string;
  priority: number;
};

/**
 * Idempotent weekly write (Strategy Agent). Deletes this week's *unattached*
 * slots (post_id IS NULL) then inserts the fresh plan, so re-running never
 * duplicates a week and never discards a slot a draft is already attached to.
 * Returns the new row ids.
 */
export async function replaceWeekPlan(weekStart: string, slots: SlotInput[]): Promise<number[]> {
  const generatedAt = await nowIso();
  return db.transaction(async (tx) => {
    await tx
      .delete(calendar)
      .where(and(eq(calendar.weekStart, weekStart), isNull(calendar.postId)));
    const ids: number[] = [];
    for (const slot of slots) {
      const [row] = await tx
        .insert(calendar)
        .values({ ...slot, weekStart, generatedAt })
        .returning({ id: calendar.id });
      ids.push(row.id);
    }
    return ids;
  });
}

export async function getCalendarWeek(weekStart: string): Promise<CalendarSlot[]> {
  return db
    .select()
    .from(calendar)
    .where(eq(calendar.weekStart, weekStart))
    .orderBy(asc(calendar.slotDate), asc(calendar.slotTime), asc(calendar.id));
}

export async function getCalendarSlot(slotId: number): Promise<CalendarSlot | null> {
  const rows = await db.select().from(calendar).where(eq(calendar.id, slotId)).limit(1);
  return rows[0] ?? null;
}

/** The calendar slot linked to a post, or null. */
export async function getCalendarSlotByPost(postId: number): Promise<CalendarSlot | null> {
  const rows = await db
    .select()
    .from(calendar)
    .where(eq(calendar.postId, postId))
    .orderBy(asc(calendar.id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * slot_time of the most recent calendar slots that already have a linked post —
 * lets the Distribution Agent avoid scheduling back-to-back identical times.
 */
export async function getRecentScheduledTimes(
  limit = 5,
  excludePostId?: number,
): Promise<string[]> {
  const filters = [isNotNull(calendar.postId), isNotNull(calendar.slotTime)];
  if (excludePostId !== undefined && excludePostId !== null) {
    filters.push(ne(calendar.postId, excludePostId));
  }
  const rows = await db
    .select({ slotTime: calendar.slotTime })
    .from(calendar)
    .where(and(...filters))
    .orderBy(desc(calendar.slotDate), desc(calendar.slotTime), desc(calendar.id))
    .limit(limit);
  return rows.map((r) => r.slotTime!).filter((t): t is string => t != null);
}

export async function updateCalendarSlot(
  slotId: number,
  fields: Partial<typeof calendar.$inferInsert>,
): Promise<void> {
  if (Object.keys(fields).length === 0) return;
  await db.update(calendar).set(fields).where(eq(calendar.id, slotId));
}

export async function linkSlotToPost(slotId: number, postId: number): Promise<void> {
  await updateCalendarSlot(slotId, { postId });
}

// --- products ---------------------------------------------------------------

export async function insertProduct(fields: typeof products.$inferInsert): Promise<number> {
  const [row] = await db.insert(products).values(fields).returning({ id: products.id });
  return row.id;
}

export async function getProduct(productId: number): Promise<Product | null> {
  const rows = await db.select().from(products).where(eq(products.id, productId)).limit(1);
  return rows[0] ?? null;
}

/** Active products, least-recently-promoted first (NULL = never -> first). */
export async function getActiveProducts(): Promise<Product[]> {
  return db
    .select()
    .from(products)
    .where(eq(products.active, true))
    .orderBy(sql`${products.lastPromotedAt} asc nulls first`, asc(products.id));
}

/** Stamp last_promoted_at (Distribution Agent at approval) -> CTA rotation. */
export async function setProductPromoted(productId: number, when?: string): Promise<void> {
  await db
    .update(products)
    .set({ lastPromotedAt: when ?? (await nowIso()) })
    .where(eq(products.id, productId));
}

// --- markets ----------------------------------------------------------------

export async function insertMarket(fields: typeof markets.$inferInsert): Promise<number> {
  const [row] = await db.insert(markets).values(fields).returning({ id: markets.id });
  return row.id;
}

export async function getMarket(marketId: number): Promise<Market | null> {
  const rows = await db.select().from(markets).where(eq(markets.id, marketId)).limit(1);
  return rows[0] ?? null;
}

/** Markets whose event_date falls within the next N days (Strategy Agent). */
export async function getUpcomingMarkets(withinDays = 45): Promise<Market[]> {
  const [today, cutoff] = await dateWindow(withinDays);
  return db
    .select()
    .from(markets)
    .where(
      and(
        isNotNull(markets.eventDate),
        gte(markets.eventDate, today),
        lte(markets.eventDate, cutoff),
      ),
    )
    .orderBy(asc(markets.eventDate));
}

/** Markets with an application_deadline in the next N days (Distribution + UI banner). */
export async function getMarketsWithDeadline(withinDays = 14): Promise<Market[]> {
  const [today, cutoff] = await dateWindow(withinDays);
  return db
    .select()
    .from(markets)
    .where(
      and(
        isNotNull(markets.applicationDeadline),
        gte(markets.applicationDeadline, today),
        lte(markets.applicationDeadline, cutoff),
      ),
    )
    .orderBy(asc(markets.applicationDeadline));
}

/** Write the agent-drafted blurb without touching human `notes`. */
export async function setMarketDraftApplication(marketId: number, text: string): Promise<void> {
  await db.update(markets).set({ draftApplication: text }).where(eq(markets.id, marketId));
}

// --- insights (§2): aggregates over posts × engagement ----------------------

/**
 * Performance-score weights (FEATURES.md §2). Saves and shares lead (principle
 * #2 — saves/DM-shares outweigh likes for a sub-1K account); likes barely count.
 * Exposed as a constant so they're trivial to retune without touching the model.
 */
export const SCORE_WEIGHTS = { shares: 3, saves: 2, comments: 1, likes: 0.25 } as const;

/** Days back the insights panels look unless a caller overrides. */
export const INSIGHTS_WINDOW_DAYS = 90;

function round(x: number, dp = 1): number {
  if (!Number.isFinite(x)) return 0;
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

/** First day of the rolling window, YYYY-MM-DD (settings.timezone). */
async function windowStart(days: number): Promise<string> {
  return (await nowInZone()).startOf("day").minus({ days }).toISODate()!;
}

/**
 * SQL fragment for a posts row's performance score. Nullable metrics coalesce to
 * 0; when reach > 0 the weighted sum is divided by reach (a saves/shares *rate*),
 * so an efficient small post can outrank a lucky high-reach one. Built from
 * SCORE_WEIGHTS so the constant stays the single source of truth.
 */
function scoreExpr() {
  const w = SCORE_WEIGHTS;
  const weighted = sql`(
    ${w.shares} * coalesce(${posts.shares}, 0)
    + ${w.saves} * coalesce(${posts.saves}, 0)
    + ${w.comments} * coalesce(${posts.comments}, 0)
    + ${w.likes} * coalesce(${posts.likes}, 0)
  )::numeric`;
  return sql`case when coalesce(${posts.reach}, 0) > 0 then ${weighted} / ${posts.reach} else ${weighted} end`;
}

export type FormatPerformance = {
  format: string;
  posts: number;
  avgScore: number;
  avgSaves: number;
  avgShares: number;
  avgReach: number;
};

/** Per-format averages over posted rows in the window, ranked by avg score. */
export async function getEngagementByFormat(
  windowDays = INSIGHTS_WINDOW_DAYS,
): Promise<FormatPerformance[]> {
  const cutoff = await windowStart(windowDays);
  const score = scoreExpr();
  const rows = await db
    .select({
      format: posts.format,
      n: sql<number>`count(*)`,
      avgScore: sql<number>`avg(${score})`,
      avgSaves: sql<number>`avg(coalesce(${posts.saves}, 0))`,
      avgShares: sql<number>`avg(coalesce(${posts.shares}, 0))`,
      avgReach: sql<number>`avg(coalesce(${posts.reach}, 0))`,
    })
    .from(posts)
    .where(and(eq(posts.status, "posted"), gte(posts.postedAt, cutoff), isNotNull(posts.format)))
    .groupBy(posts.format)
    .orderBy(desc(sql`avg(${score})`));
  return rows.map((r) => ({
    format: r.format!,
    posts: Number(r.n),
    avgScore: round(Number(r.avgScore), 3),
    avgSaves: round(Number(r.avgSaves)),
    avgShares: round(Number(r.avgShares)),
    avgReach: round(Number(r.avgReach)),
  }));
}

export type WeekdayPerformance = { weekday: number; label: string; posts: number; avgScore: number };

const WEEKDAY_LABELS = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * Per-weekday averages over posted rows, weekday derived in settings.timezone.
 * (No time-of-day signal: posted_at is the "mark posted" click, not the IG
 * publish time, so we rank weekday only — not an invented "best hour".)
 */
export async function getEngagementByWeekday(
  windowDays = INSIGHTS_WINDOW_DAYS,
): Promise<WeekdayPerformance[]> {
  const tz = (await getSettings())?.timezone ?? "UTC";
  const cutoff = await windowStart(windowDays);
  const score = scoreExpr();
  const dow = sql<number>`extract(isodow from (${posts.postedAt})::timestamptz at time zone ${tz})`;
  const rows = await db
    .select({ weekday: dow, n: sql<number>`count(*)`, avgScore: sql<number>`avg(${score})` })
    .from(posts)
    .where(and(eq(posts.status, "posted"), gte(posts.postedAt, cutoff), isNotNull(posts.postedAt)))
    .groupBy(dow)
    .orderBy(desc(sql`avg(${score})`));
  return rows.map((r) => {
    const wd = Number(r.weekday);
    return {
      weekday: wd,
      label: WEEKDAY_LABELS[wd] ?? String(wd),
      posts: Number(r.n),
      avgScore: round(Number(r.avgScore), 3),
    };
  });
}

/** Top N posted rows by score (full row + computed score). Reused by §8. */
export async function getTopPosts(
  windowDays = INSIGHTS_WINDOW_DAYS,
  n = 5,
): Promise<Array<Post & { score: number }>> {
  const cutoff = await windowStart(windowDays);
  const score = scoreExpr();
  const rows = await db
    .select({ post: posts, score: sql<number>`${score}` })
    .from(posts)
    .where(and(eq(posts.status, "posted"), gte(posts.postedAt, cutoff)))
    .orderBy(desc(sql`${score}`), desc(posts.postedAt), desc(posts.id))
    .limit(n);
  return rows.map((r) => ({ ...r.post, score: round(Number(r.score), 4) }));
}

// --- subscriber attribution (§4) --------------------------------------------

/** Log new subscribers (batch entry allowed) with optional post attribution. */
export async function insertSubscriberEvent(fields: {
  channel: string;
  count?: number;
  sourcePostId?: number | null;
  note?: string | null;
}): Promise<number> {
  const [row] = await db
    .insert(subscriberEvents)
    .values({
      occurredAt: await nowIso(),
      channel: fields.channel,
      count: fields.count ?? 1,
      sourcePostId: fields.sourcePostId ?? null,
      note: fields.note ?? null,
    })
    .returning({ id: subscriberEvents.id });
  return row.id;
}

export type SubscribersByCta = { ctaType: string; subscribers: number };

/**
 * Subscribers grouped by the CTA type of the post that drove them (null source
 * or null cta -> 'unattributed') — shows which CTA types actually convert.
 */
export async function getSubscribersByCtaType(
  windowDays = INSIGHTS_WINDOW_DAYS,
): Promise<SubscribersByCta[]> {
  const cutoff = await windowStart(windowDays);
  const ctaExpr = sql<string>`coalesce(${posts.ctaType}, 'unattributed')`;
  const rows = await db
    .select({ ctaType: ctaExpr, subscribers: sql<number>`sum(${subscriberEvents.count})` })
    .from(subscriberEvents)
    .leftJoin(posts, eq(subscriberEvents.sourcePostId, posts.id))
    .where(gte(subscriberEvents.occurredAt, cutoff))
    .groupBy(ctaExpr)
    .orderBy(desc(sql`sum(${subscriberEvents.count})`));
  return rows.map((r) => ({ ctaType: String(r.ctaType), subscribers: Number(r.subscribers) }));
}

export type SubscriberTrend = {
  total: number;
  byChannel: Record<string, number>;
  weekly: Array<{ weekStart: string; count: number }>;
};

/** Running subscriber trend in the window: total, per-channel, and weekly buckets. */
export async function getSubscriberTrend(
  windowDays = INSIGHTS_WINDOW_DAYS,
): Promise<SubscriberTrend> {
  const tz = (await getSettings())?.timezone ?? "UTC";
  const cutoff = await windowStart(windowDays);

  const byChannelRows = await db
    .select({ channel: subscriberEvents.channel, total: sql<number>`sum(${subscriberEvents.count})` })
    .from(subscriberEvents)
    .where(gte(subscriberEvents.occurredAt, cutoff))
    .groupBy(subscriberEvents.channel);

  const weekExpr = sql<string>`to_char(date_trunc('week', (${subscriberEvents.occurredAt})::timestamptz at time zone ${tz}), 'YYYY-MM-DD')`;
  const weeklyRows = await db
    .select({ weekStart: weekExpr, count: sql<number>`sum(${subscriberEvents.count})` })
    .from(subscriberEvents)
    .where(gte(subscriberEvents.occurredAt, cutoff))
    .groupBy(weekExpr)
    .orderBy(asc(weekExpr));

  const byChannel: Record<string, number> = {};
  let total = 0;
  for (const r of byChannelRows) {
    const c = Number(r.total);
    byChannel[r.channel] = c;
    total += c;
  }
  return {
    total,
    byChannel,
    weekly: weeklyRows.map((r) => ({ weekStart: String(r.weekStart), count: Number(r.count) })),
  };
}

// --- cost meter (§7): usage_log writes + monthly spend ----------------------

/** Log one agent call's token/web-search usage + estimated cost (computed by the caller). */
export async function insertUsageLog(fields: {
  agent: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  webSearches: number;
  estCostUsd: number;
}): Promise<void> {
  await db.insert(usageLog).values({
    occurredAt: await nowIso(),
    agent: fields.agent,
    model: fields.model,
    inputTokens: fields.inputTokens,
    outputTokens: fields.outputTokens,
    webSearches: fields.webSearches,
    estCostUsd: String(fields.estCostUsd), // numeric column stores text
  });
}

/**
 * Total estimated API spend for the current calendar month (settings.timezone).
 * Month start is a YYYY-MM-01 date; occurredAt is full ISO, so the lexicographic
 * compare matches every timestamp in the month (same approach as windowStart).
 */
export async function getMonthlySpend(): Promise<number> {
  const monthStart = (await nowInZone()).startOf("month").toISODate()!;
  const rows = await db
    .select({ total: sql<number>`coalesce(sum(${usageLog.estCostUsd}), 0)::float8` })
    .from(usageLog)
    .where(gte(usageLog.occurredAt, monthStart));
  return Number(rows[0]?.total ?? 0);
}
