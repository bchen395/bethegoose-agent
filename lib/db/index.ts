/**
 * lib/db/index.ts — typed read/write helpers, the only gateway to Postgres.
 *
 * Every caller (the Strategy Agent, the syncs, and the UI) goes through these.
 * JSON columns are jsonb, so arrays round-trip natively. Timestamps are written
 * in settings.timezone as ISO-8601 (via Luxon).
 *
 * Connects through Supabase's Supavisor transaction pooler (DATABASE_URL); that
 * pooler doesn't support prepared statements, hence `prepare: false`.
 */

import { DateTime } from "luxon";
import { and, asc, desc, eq, gte, isNotNull, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";
import {
  brandVoice,
  calendar,
  followerSnapshots,
  instagramAccount,
  markets,
  postIdeas,
  posts,
  products,
  settings,
  subscriberEvents,
  usageLog,
  type BrandVoice,
  type CalendarSlot,
  type FollowerSnapshot,
  type InstagramAccount,
  type Market,
  type Post,
  type PostIdea,
  type Product,
  type Settings,
} from "./schema";

// Re-export the row types so callers can `import { type Post } from "@/lib/db"`.
export type {
  BrandVoice,
  CalendarSlot,
  FollowerSnapshot,
  InstagramAccount,
  Market,
  Post,
  PostIdea,
  Product,
  Settings,
} from "./schema";

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

/** Patch the single brand_voice row (id = 1) — Item #2 settings CRUD. */
export async function updateBrandVoice(
  fields: Partial<typeof brandVoice.$inferInsert>,
): Promise<void> {
  if (Object.keys(fields).length === 0) return;
  await db.update(brandVoice).set(fields).where(eq(brandVoice.id, 1));
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
 * Idempotent weekly write (Strategy Agent). Deletes this week's *unattached and
 * un-pinned* slots (post_id IS NULL AND pinned = false) then inserts the fresh
 * plan, so re-running never duplicates a week, never discards a slot a draft is
 * attached to, and never discards a slot the user has manually arranged
 * (pinned). Returns the new row ids.
 */
export async function replaceWeekPlan(weekStart: string, slots: SlotInput[]): Promise<number[]> {
  const generatedAt = await nowIso();
  return db.transaction(async (tx) => {
    await tx
      .delete(calendar)
      .where(
        and(eq(calendar.weekStart, weekStart), isNull(calendar.postId), eq(calendar.pinned, false)),
      );
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

export async function updateCalendarSlot(
  slotId: number,
  fields: Partial<typeof calendar.$inferInsert>,
): Promise<void> {
  if (Object.keys(fields).length === 0) return;
  await db.update(calendar).set(fields).where(eq(calendar.id, slotId));
}

/**
 * Link a planned slot to the post that fulfilled it (plan→actual loop). Marks the
 * slot done — it was posted — and the non-null post_id keeps replaceWeekPlan from
 * clearing it on a re-run (see its isNull(post_id) guard).
 */
export async function linkSlotToPost(slotId: number, postId: number): Promise<void> {
  await updateCalendarSlot(slotId, { postId, done: true });
}

/** Planned slots for a week not yet linked to a post — candidates for matching. */
export async function getUnlinkedSlotsForWeek(weekStart: string): Promise<CalendarSlot[]> {
  return db
    .select()
    .from(calendar)
    .where(and(eq(calendar.weekStart, weekStart), isNull(calendar.postId)))
    .orderBy(asc(calendar.slotDate), asc(calendar.id));
}

/**
 * Posted rows within the window not yet linked to any planned slot — the input to
 * the Instagram sync's plan↔actual matching pass. Newest-published first.
 */
export async function getUnmatchedPostedPosts(withinDays = 28): Promise<Post[]> {
  const cutoff = await windowStart(withinDays);
  const linked = await db
    .select({ postId: calendar.postId })
    .from(calendar)
    .where(isNotNull(calendar.postId));
  const linkedIds = linked.map((r) => r.postId).filter((x): x is number => x != null);
  const conds = [
    eq(posts.status, "posted"),
    isNotNull(posts.publishedAt),
    gte(posts.publishedAt, cutoff),
  ];
  if (linkedIds.length > 0) conds.push(notInArray(posts.id, linkedIds));
  return db
    .select()
    .from(posts)
    .where(and(...conds))
    .orderBy(desc(posts.publishedAt), desc(posts.id));
}

export type RecapRow = { slot: CalendarSlot; post: Post | null; score: number | null };

/**
 * A week's plan vs. actuals: every planned slot, plus the post that fulfilled it
 * (via calendar.post_id) with its performance score, or null if nothing matched.
 * Backs the /calendar recap and the Strategy Agent's last-week context.
 */
export async function getWeekRecap(weekStart: string): Promise<RecapRow[]> {
  const score = scoreExpr();
  const rows = await db
    .select({
      slot: calendar,
      post: posts,
      score: sql<number | null>`case when ${posts.id} is null then null else ${score} end`,
    })
    .from(calendar)
    .leftJoin(posts, eq(calendar.postId, posts.id))
    .where(eq(calendar.weekStart, weekStart))
    .orderBy(asc(calendar.slotDate), asc(calendar.slotTime), asc(calendar.id));
  return rows.map((r) => ({
    slot: r.slot,
    post: r.post && r.post.id != null ? r.post : null,
    score: r.score == null ? null : round(Number(r.score), 4),
  }));
}

/** Count of posted rows actually published in the given week (Mon..Sun). */
export async function getPostedCountInWeek(weekStart: string): Promise<number> {
  const end = DateTime.fromISO(weekStart).plus({ days: 7 }).toISODate()!;
  const publishTs = sql`coalesce(${posts.publishedAt}, ${posts.postedAt})`;
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(posts)
    .where(
      and(eq(posts.status, "posted"), sql`${publishTs} >= ${weekStart}`, sql`${publishTs} < ${end}`),
    );
  return Number(rows[0]?.n ?? 0);
}

/** Insert a single calendar slot (manual scheduling / default-layout seed). */
export async function insertCalendarSlot(
  fields: typeof calendar.$inferInsert,
): Promise<number> {
  const generatedAt = await nowIso();
  const [row] = await db
    .insert(calendar)
    .values({ generatedAt, ...fields })
    .returning({ id: calendar.id });
  return row.id;
}

/** Remove a slot from the calendar (unschedule). The linked idea is untouched. */
export async function deleteCalendarSlot(slotId: number): Promise<void> {
  await db.delete(calendar).where(eq(calendar.id, slotId));
}

// --- post_ideas (the reusable idea library / "box") -------------------------

/** Non-archived ideas, newest first — backs the calendar's idea tray. */
export async function getIdeaLibrary(): Promise<PostIdea[]> {
  return db
    .select()
    .from(postIdeas)
    .where(eq(postIdeas.archived, false))
    .orderBy(desc(postIdeas.id));
}

export async function getIdea(ideaId: number): Promise<PostIdea | null> {
  const rows = await db.select().from(postIdeas).where(eq(postIdeas.id, ideaId)).limit(1);
  return rows[0] ?? null;
}

export async function insertIdea(fields: typeof postIdeas.$inferInsert): Promise<number> {
  const [row] = await db.insert(postIdeas).values(fields).returning({ id: postIdeas.id });
  return row.id;
}

/** Soft-delete: keep the row (calendar slots may still reference it) but hide it. */
export async function archiveIdea(ideaId: number): Promise<void> {
  await db.update(postIdeas).set({ archived: true }).where(eq(postIdeas.id, ideaId));
}

/** Patch an idea's editable fields (title / format / contentIdea / archived). */
export async function updateIdea(
  ideaId: number,
  fields: Partial<typeof postIdeas.$inferInsert>,
): Promise<void> {
  if (Object.keys(fields).length === 0) return;
  await db.update(postIdeas).set(fields).where(eq(postIdeas.id, ideaId));
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

/** All products (active + inactive), stable order — Item #2 products CRUD. */
export async function getAllProducts(): Promise<Product[]> {
  return db.select().from(products).orderBy(asc(products.id));
}

/** Patch a product (name/url/type/active) — never touches last_promoted_at. */
export async function updateProduct(
  productId: number,
  fields: Partial<typeof products.$inferInsert>,
): Promise<void> {
  if (Object.keys(fields).length === 0) return;
  await db.update(products).set(fields).where(eq(products.id, productId));
}

/** Active products, least-recently-promoted first (NULL = never -> first). */
export async function getActiveProducts(): Promise<Product[]> {
  return db
    .select()
    .from(products)
    .where(eq(products.active, true))
    .orderBy(sql`${products.lastPromotedAt} asc nulls first`, asc(products.id));
}

/** Look up a product by its Stripe id — the upsert key for the Item #3 shop sync. */
export async function getProductByStripeId(stripeProductId: string): Promise<Product | null> {
  const rows = await db
    .select()
    .from(products)
    .where(eq(products.stripeProductId, stripeProductId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Deactivate Stripe-origin products whose id is no longer in `stripeProductIds`
 * (archived/deleted upstream). Only touches rows with a non-null stripe_product_id,
 * so hand-created CRUD products are never disturbed. Returns the count deactivated.
 *
 * MUST only be called after a *confirmed-good* fetch from Stripe — never on a failed
 * sync, or it would wrongly retire the whole catalog.
 */
export async function deactivateStripeProductsNotIn(stripeProductIds: string[]): Promise<number> {
  const onlyStripe = isNotNull(products.stripeProductId);
  const where =
    stripeProductIds.length === 0
      ? onlyStripe
      : and(onlyStripe, notInArray(products.stripeProductId, stripeProductIds));
  const rows = await db
    .update(products)
    .set({ active: false })
    .where(and(where, eq(products.active, true)))
    .returning({ id: products.id });
  return rows.length;
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

/** All markets, soonest event first (NULL event_date last) — Item #2 markets CRUD. */
export async function getAllMarkets(): Promise<Market[]> {
  return db
    .select()
    .from(markets)
    .orderBy(sql`${markets.eventDate} asc nulls last`, asc(markets.id));
}

/** Patch a market's editable fields. */
export async function updateMarket(
  marketId: number,
  fields: Partial<typeof markets.$inferInsert>,
): Promise<void> {
  if (Object.keys(fields).length === 0) return;
  await db.update(markets).set(fields).where(eq(markets.id, marketId));
}

/** Hard-delete a market. Safe: nothing references markets.id by FK. */
export async function deleteMarket(marketId: number): Promise<void> {
  await db.delete(markets).where(eq(markets.id, marketId));
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

/** Markets with an application_deadline in the next N days (UI banner). */
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
 * An IANA timezone as an inlined SQL string literal, NOT a bound param. Required
 * for `at time zone` expressions that are repeated across SELECT/GROUP BY/ORDER BY:
 * a bound `${tz}` gets a *distinct* positional placeholder ($1, $3, $4, …) at each
 * render, so Postgres treats the GROUP BY expression as structurally different from
 * the SELECT one and rejects the query (42803, "must appear in the GROUP BY clause").
 * Inlining makes every occurrence byte-identical so the expressions unify. Single
 * quotes are doubled so it's injection-safe even though tz comes from settings.
 */
function tzLiteral(tz: string) {
  return sql.raw(`'${tz.replace(/'/g, "''")}'`);
}

/**
 * SQL fragment for a posts row's performance score. Nullable metrics coalesce to
 * 0; when reach > 0 the weighted sum is divided by reach (a saves/shares *rate*),
 * so an efficient small post can outrank a lucky high-reach one. Built from
 * SCORE_WEIGHTS so the constant stays the single source of truth.
 */
function scoreExpr() {
  const w = SCORE_WEIGHTS;
  // Inline the weights as numeric SQL literals, NOT bound params: a fractional weight
  // (e.g. 0.25) bound as a param in `$n * <integer column>` gets type-inferred as
  // integer and Postgres rejects "0.25" (22P02). The weights are compile-time numeric
  // constants, so `sql.raw` here is injection-safe (Number() guards it regardless).
  const lit = (n: number) => sql.raw(String(Number(n)));
  const weighted = sql`(
    ${lit(w.shares)} * coalesce(${posts.shares}, 0)
    + ${lit(w.saves)} * coalesce(${posts.saves}, 0)
    + ${lit(w.comments)} * coalesce(${posts.comments}, 0)
    + ${lit(w.likes)} * coalesce(${posts.likes}, 0)
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
 * Prefers the real IG publish time (published_at) and falls back to posted_at for
 * legacy rows — the Instagram sync (Item #1) makes published_at the true time.
 */
export async function getEngagementByWeekday(
  windowDays = INSIGHTS_WINDOW_DAYS,
): Promise<WeekdayPerformance[]> {
  const tz = (await getSettings())?.timezone ?? "UTC";
  const cutoff = await windowStart(windowDays);
  const score = scoreExpr();
  const publishTs = sql`coalesce(${posts.publishedAt}, ${posts.postedAt})`;
  const dow = sql<number>`extract(isodow from (${publishTs})::timestamptz at time zone ${tzLiteral(tz)})`;
  const rows = await db
    .select({ weekday: dow, n: sql<number>`count(*)`, avgScore: sql<number>`avg(${score})` })
    .from(posts)
    .where(
      and(
        eq(posts.status, "posted"),
        sql`${publishTs} >= ${cutoff}`,
        sql`${publishTs} is not null`,
      ),
    )
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

  const weekExpr = sql<string>`to_char(date_trunc('week', (${subscriberEvents.occurredAt})::timestamptz at time zone ${tzLiteral(tz)}), 'YYYY-MM-DD')`;
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

// --- Instagram sync (Item #1): connection, ingest, follower history ---------

/** Read the single Instagram connection row (id = 1), or null if not connected. */
export async function getInstagramAccount(): Promise<InstagramAccount | null> {
  const rows = await db
    .select()
    .from(instagramAccount)
    .where(eq(instagramAccount.id, 1))
    .limit(1);
  return rows[0] ?? null;
}

/** Create or replace the connection (id = 1) — called by the OAuth callback. */
export async function upsertInstagramAccount(
  fields: Omit<typeof instagramAccount.$inferInsert, "id">,
): Promise<void> {
  await db
    .insert(instagramAccount)
    .values({ id: 1, ...fields })
    .onConflictDoUpdate({ target: instagramAccount.id, set: fields });
}

/** Patch the connection row (id = 1) — token refresh, synced_at, followers. */
export async function updateInstagramAccount(
  fields: Partial<typeof instagramAccount.$inferInsert>,
): Promise<void> {
  if (Object.keys(fields).length === 0) return;
  await db.update(instagramAccount).set(fields).where(eq(instagramAccount.id, 1));
}

/** Look up a post by its IG media id — the idempotent ingest upsert key. */
export async function getPostByIgMediaId(igMediaId: string): Promise<Post | null> {
  const rows = await db.select().from(posts).where(eq(posts.igMediaId, igMediaId)).limit(1);
  return rows[0] ?? null;
}

/**
 * Posted IG-sourced rows whose metrics should be (re)pulled: never synced yet,
 * or published within the last ~7 days (IG metrics keep maturing for a while).
 * Compares the full ISO published_at against a date prefix lexicographically,
 * same approach as getMonthlySpend.
 */
export async function getPostsForStatsSync(): Promise<Post[]> {
  const cutoff = await windowStart(7);
  return db
    .select()
    .from(posts)
    .where(
      and(
        isNotNull(posts.igMediaId),
        eq(posts.status, "posted"),
        or(isNull(posts.statsSyncedAt), gte(posts.publishedAt, cutoff)),
      ),
    )
    .orderBy(desc(posts.publishedAt), desc(posts.id));
}

/** Append a follower-count snapshot (captured now, settings.timezone). */
export async function insertFollowerSnapshot(followersCount: number): Promise<void> {
  await db.insert(followerSnapshots).values({ capturedAt: await nowIso(), followersCount });
}

/** Follower snapshots in the rolling window, oldest first — the §insights sparkline. */
export async function getFollowerTrend(
  windowDays = INSIGHTS_WINDOW_DAYS,
): Promise<Array<{ capturedAt: string; followersCount: number }>> {
  const cutoff = await windowStart(windowDays);
  const rows = await db
    .select({
      capturedAt: followerSnapshots.capturedAt,
      followersCount: followerSnapshots.followersCount,
    })
    .from(followerSnapshots)
    .where(gte(followerSnapshots.capturedAt, cutoff))
    .orderBy(asc(followerSnapshots.capturedAt));
  return rows.map((r) => ({ capturedAt: String(r.capturedAt), followersCount: Number(r.followersCount) }));
}
