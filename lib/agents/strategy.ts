/**
 * lib/agents/strategy.ts — Agent 1: the weekly content-calendar planner.
 *
 * Faithful port of agents/strategy_agent.py. Model: claude-sonnet-4-6.
 * Trigger: the Monday cron + the UI's "Run weekly plan now" button.
 *
 * Flow: read last 30 posts + settings + upcoming markets (<=45d) + active
 * products; ONE web search (degradable supplement); forced-JSON synthesis
 * leading with her own engagement; idempotent write via replaceWeekPlan.
 */

import { DateTime } from "luxon";
import { z } from "zod";

import { AgentError, STRATEGY_MODEL, callJson, webSearch } from "../claude";
import {
  getActiveProducts,
  getRecentPosts,
  getSettings,
  getUpcomingMarkets,
  replaceWeekPlan,
  todayIso,
  type Market,
  type Post,
  type Product,
  type Settings,
  type SlotInput,
} from "../db";

const VALID_FORMATS = ["static", "carousel", "reel", "story"] as const;

// Forced-JSON shape for the synthesis call. `slots` carry exactly the writable
// calendar columns; `reasoning` is surfaced to the human, not stored.
const SLOT_SCHEMA = z.object({
  slot_date: z.string().describe("YYYY-MM-DD; must be one of target_week.allowed_dates."),
  slot_time: z.string().describe("HH:MM 24-hour; default to settings.default_post_time."),
  format: z.enum(VALID_FORMATS),
  theme: z.string().describe("Short label, e.g. 'process video — sticker making'."),
  content_idea: z.string().describe("1-2 sentences; weave any CTA intent in here."),
  priority: z
    .union([z.literal(1), z.literal(2)])
    .describe("1 = must post, 2 = nice to have."),
});

const PLAN_SCHEMA = z.object({
  reasoning: z
    .string()
    .describe(
      "2-4 sentences on the format/CTA choices, including an honest note that slot times " +
        "are a sensible default, not a data-derived optimum.",
    ),
  slots: z.array(SLOT_SCHEMA).min(1).max(5),
});

type Plan = z.infer<typeof PLAN_SCHEMA>;

// --- Small derivations from first-party data --------------------------------

/** Date a post happened on (postedAt, else createdAt) as a DateTime, or null. */
function dateOf(post: Post): DateTime | null {
  const raw = post.postedAt || post.createdAt;
  if (!raw) return null;
  const d = DateTime.fromISO(String(raw).slice(0, 10));
  return d.isValid ? d : null;
}

function trimPost(post: Post) {
  const d = dateOf(post);
  return {
    format: post.format,
    status: post.status,
    cta_type: post.ctaType,
    likes: post.likes,
    comments: post.comments,
    reach: post.reach,
    saves: post.saves,
    date: d ? d.toISODate() : null,
  };
}

/** Per-format averages over *posted* rows with metrics. */
function formatPerformance(posts: Post[]) {
  const metrics = ["likes", "comments", "reach", "saves"] as const;
  type Bucket = { posts: number; likes: number[]; comments: number[]; reach: number[]; saves: number[] };
  const buckets: Record<string, Bucket> = {};
  for (const p of posts) {
    if (p.status !== "posted") continue;
    const fmt = p.format;
    if (!fmt) continue;
    const b = (buckets[fmt] ??= { posts: 0, likes: [], comments: [], reach: [], saves: [] });
    b.posts += 1;
    for (const m of metrics) {
      const v = p[m];
      if (typeof v === "number") b[m].push(v);
    }
  }
  const out: Record<string, Record<string, number>> = {};
  for (const [fmt, b] of Object.entries(buckets)) {
    const entry: Record<string, number> = { posts: b.posts };
    for (const m of metrics) {
      const arr = b[m];
      if (arr.length) entry[`avg_${m}`] = Math.round((arr.reduce((s, x) => s + x, 0) / arr.length) * 10) / 10;
    }
    out[fmt] = entry;
  }
  return out;
}

/** Cues for the CTA-rotation and snail-mail rules. `posts` is most-recent-first. */
function signals(posts: Post[], today: DateTime) {
  let daysSinceSnail: number | null = null;
  const ctaSequence: string[] = [];
  for (const p of posts) {
    const cta = p.ctaType;
    if (cta) ctaSequence.push(cta);
    if (daysSinceSnail === null && cta === "snail_mail") {
      const d = dateOf(p);
      if (d) daysSinceSnail = Math.floor(today.startOf("day").diff(d.startOf("day"), "days").days);
    }
  }
  return {
    days_since_snail_mail_cta: daysSinceSnail, // null = never mentioned
    recent_cta_sequence: ctaSequence.slice(0, 6), // most recent first
  };
}

// --- Prompts ----------------------------------------------------------------

function researchPrompt(today: DateTime): string {
  return (
    "Research current Instagram content strategy for a small indie art business " +
    "(under 1,000 followers; hand-drawn comics, doodles, stickers, prints, and a " +
    "monthly snail-mail subscription). Run at most 2-3 quick web searches, then " +
    "summarize concisely as a few practical bullet points covering:\n" +
    `- Seasonal or timely content hooks for ${today.toFormat("LLLL")} ${today.year}.\n` +
    "- Indie-art / illustration hashtags worth using or avoiding right now.\n" +
    `- What's currently working for small Instagram accounts and Reels in ${today.year}.\n` +
    "Keep it brief. These findings are a light supplement to the artist's own " +
    "engagement data, not a directive."
  );
}

function systemPrompt(settings: Settings): string {
  const defaultTime = settings.defaultPostTime;
  const reelRule = settings.reelsRequired
    ? "Include at least one reel this week — reels_required is on."
    : "Include a reel only when she's likely to have process footage to film; " +
      "never prescribe video she can't realistically shoot.";
  return `You are the Strategy Agent for a one-person indie art business on \
Instagram (under 1,000 followers). The artist draws original comics, doodles, and \
stickers and sells prints, stickers, crafts, and a monthly snail-mail subscription. \
She posts ~3x/week and writes her own captions — you plan WHAT to post, not the words.

Your task: from the context JSON, produce a content calendar of 3-4 posting slots \
for the target week.

LEAD WITH HER OWN DATA. \`format_performance\` and \`recent_posts\` are first-party \
engagement and outrank everything else. If her carousels out-save her reels, that \
beats any article claiming "reels win." Treat \`web_findings\` as a light supplement \
for seasonal hooks and obviously fresh-or-stale hashtags only — never let it override \
what her own numbers show.

FORMAT MIX:
- ${reelRule}
- Aim for at least one carousel — they tend to earn saves.
- One static post (her core comic/doodle) is good.
- Vary formats across the week unless her own data clearly favors repeating one.

CTAs — there is NO separate CTA field, so weave the CTA intent into \`theme\`/\`content_idea\`:
- Rotate calls to action; don't promote the shop two slots in a row (see \`signals.recent_cta_sequence\`).
- If a market's event is within ~3 weeks, make at least one slot tease or announce it (see \`upcoming_markets\`).
- If snail mail hasn't been mentioned in 10+ days, include a slot that mentions the subscription \
(see \`signals.days_since_snail_mail_cta\`; null means never — include one).
- Slots with no CTA are fine.
- When a slot promotes the shop or snail mail, favor the least-recently-promoted relevant item in \
\`active_products\` (listed least-recent first) so promotion rotates.

POSTING TIMES: set every \`slot_time\` to ${defaultTime} (the configured default), give or take a \
small per-day variation. Do NOT invent "optimal" times — a sub-1K account has no Instagram Insights \
to optimize against. In \`reasoning\`, say plainly that the times are a sensible default, not a \
data-derived optimum.

DATES: every \`slot_date\` MUST be one of the dates in \`target_week.allowed_dates\`. Spread slots \
across different days.

Call the \`record_plan\` tool exactly once with 3-4 slots.`;
}

function context(
  today: DateTime,
  weekStart: DateTime,
  weekEnd: DateTime,
  allowedDates: string[],
  settings: Settings,
  posts: Post[],
  markets: Market[],
  products: Product[],
  web: { text: string; queries: string[] },
) {
  return {
    today: today.toISODate(),
    target_week: {
      week_start: weekStart.toISODate(),
      week_end: weekEnd.toISODate(),
      allowed_dates: allowedDates,
    },
    settings: {
      timezone: settings.timezone,
      default_post_time: settings.defaultPostTime,
      reels_required: Boolean(settings.reelsRequired),
      hashtag_count_min: settings.hashtagCountMin,
      hashtag_count_max: settings.hashtagCountMax,
    },
    format_performance: formatPerformance(posts),
    recent_posts: posts.map(trimPost),
    signals: signals(posts, today),
    upcoming_markets: markets.map((m) => ({
      name: m.name,
      location: m.location,
      event_date: m.eventDate,
      application_deadline: m.applicationDeadline,
      status: m.status,
    })),
    active_products: products.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      url: p.url,
      last_promoted_at: p.lastPromotedAt,
    })),
    web_findings: { text: web.text, queries: web.queries },
  };
}

// --- Validation -------------------------------------------------------------

/** Return a zero-padded HH:MM, falling back to `fallback` if unparseable. */
function normalizeTime(value: unknown, fallback: string): string {
  if (typeof value === "string") {
    const parts = value.trim().split(":");
    if (parts.length === 2) {
      const h = Number(parts[0]);
      const m = Number(parts[1]);
      if (Number.isInteger(h) && Number.isInteger(m) && h >= 0 && h <= 23 && m >= 0 && m <= 59) {
        return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      }
    }
  }
  return fallback;
}

/**
 * Turn the model's slots into clean calendar rows, or throw AgentError. Raises
 * (rather than silently dropping) on a bad format or out-of-week date so a
 * malformed plan surfaces clearly and nothing half-baked is written.
 */
function validateSlots(
  rawSlots: Plan["slots"],
  allowedDates: string[],
  defaultTime: string,
): SlotInput[] {
  if (!Array.isArray(rawSlots) || rawSlots.length === 0) {
    throw new AgentError("Strategy Agent returned no slots.");
  }
  const allowed = new Set(allowedDates);
  const cleaned: SlotInput[] = [];
  rawSlots.forEach((slot, i) => {
    const fmt = slot.format;
    if (!VALID_FORMATS.includes(fmt)) {
      throw new AgentError(`slot ${i}: invalid format ${JSON.stringify(fmt)}`);
    }
    const slotDate = (slot.slot_date || "").trim();
    if (!allowed.has(slotDate)) {
      throw new AgentError(
        `slot ${i}: slot_date ${JSON.stringify(slotDate)} is not in the target week ${JSON.stringify([...allowed].sort())}`,
      );
    }
    const priority = slot.priority === 1 || slot.priority === 2 ? slot.priority : 2;
    cleaned.push({
      slotDate,
      slotTime: normalizeTime(slot.slot_time, defaultTime),
      format: fmt,
      theme: (slot.theme || "").trim(),
      contentIdea: (slot.content_idea || "").trim(),
      priority,
    });
  });
  return cleaned;
}

// --- Orchestration ----------------------------------------------------------

function mondayOfWeek(d: DateTime): DateTime {
  // Luxon weekday: 1 = Monday .. 7 = Sunday.
  return d.minus({ days: d.weekday - 1 }).startOf("day");
}

/** Web search as a degradable supplement — never blocks the weekly plan. */
async function runResearch(today: DateTime): Promise<{ ok: boolean; text: string; queries: string[] }> {
  try {
    const result = await webSearch({ prompt: researchPrompt(today) });
    return { ok: true, text: result.text, queries: result.queries };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, text: `(web research unavailable: ${msg})`, queries: [] };
  }
}

export type WeeklyPlanResult = {
  weekStart: string;
  slots: SlotInput[];
  rowIds: number[];
  reasoning: string;
  webQueries: string[];
  webUsed: boolean;
};

/**
 * Generate and idempotently write the coming week's content calendar. Throws
 * AgentError on any failure, in which case nothing was written.
 */
export async function runWeeklyPlan(weekStart?: string): Promise<WeeklyPlanResult> {
  const settings = await getSettings();
  if (!settings) {
    throw new AgentError("settings row is missing — run `npm run seed` first.");
  }
  const defaultTime = settings.defaultPostTime;

  const today = DateTime.fromISO(await todayIso());
  const ws = weekStart ? DateTime.fromISO(weekStart) : mondayOfWeek(today);
  const we = ws.plus({ days: 6 });
  const todayStr = today.toISODate()!;
  const allowedDates = Array.from({ length: 7 }, (_, i) => ws.plus({ days: i }))
    .map((d) => d.toISODate()!)
    .filter((d) => d >= todayStr);
  if (allowedDates.length === 0) {
    throw new AgentError(
      `Target week ${ws.toISODate()}..${we.toISODate()} is entirely in the past — nothing to plan.`,
    );
  }

  const posts = await getRecentPosts(30);
  const markets = await getUpcomingMarkets(45);
  const products = await getActiveProducts();
  const web = await runResearch(today);

  const ctx = context(today, ws, we, allowedDates, settings, posts, markets, products, web);
  const result = await callJson({
    model: STRATEGY_MODEL,
    system: systemPrompt(settings),
    content: JSON.stringify(ctx, null, 2),
    schema: PLAN_SCHEMA,
    toolName: "record_plan",
    toolDescription: "Record the weekly content calendar.",
    maxTokens: 3000,
  });

  const slots = validateSlots(result.slots, allowedDates, defaultTime);
  const rowIds = await replaceWeekPlan(ws.toISODate()!, slots);
  return {
    weekStart: ws.toISODate()!,
    slots,
    rowIds,
    reasoning: (result.reasoning || "").trim(),
    webQueries: web.queries,
    webUsed: web.ok,
  };
}
