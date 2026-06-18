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
  getWeekRecap,
  nowIso,
  replaceWeekPlan,
  todayIso,
  updateSettings,
  type Market,
  type Post,
  type Product,
  type RecapRow,
  type Settings,
  type SlotInput,
} from "../db";

const VALID_FORMATS = ["static", "carousel", "reel", "story"] as const;

// FEATURES.md §6: on the 'monthly' cadence, only search if the last search is at
// least this many days old. The MAX_WEB_SEARCHES per-run cap (lib/claude) still applies.
const WEB_SEARCH_MIN_DAYS = 28;

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

/** Compact prior-week plan→actual for the prompt (empty array = no prior plan). */
function summarizeRecap(recap: RecapRow[]) {
  return recap.map((r) => ({
    format: r.slot.format,
    theme: r.slot.theme,
    posted: r.post != null,
    saves: r.post?.saves ?? null,
    shares: r.post?.shares ?? null,
    score: r.score,
  }));
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

/** Render settings.weekly_mix as "reel:3, carousel:2, static:1" for the prompt. */
function formatWeeklyMix(mix: Record<string, number> | null | undefined): string {
  const entries = Object.entries(mix ?? {}).filter(([, w]) => typeof w === "number" && w > 0);
  if (entries.length === 0) return "no explicit target set";
  return entries
    .sort((a, b) => b[1] - a[1])
    .map(([fmt, w]) => `${fmt}:${w}`)
    .join(", ");
}

function systemPrompt(settings: Settings): string {
  const defaultTime = settings.defaultPostTime;
  const reelRule = settings.reelsRequired
    ? "Include at least one reel this week — reels_required is on."
    : "Include a reel only when she's likely to have process footage to film; " +
      "never prescribe video she can't realistically shoot.";
  const mixTarget = formatWeeklyMix(settings.weeklyMix);
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

LEARN FROM LAST WEEK. \`last_week_recap\` lists what you planned for the prior week and \
whether each slot actually got posted (with saves/shares/score for the ones that did). \
Use it: if a planned format keeps going unposted, she likely can't make it that week — \
ease off it; lean toward formats and themes that both got posted AND scored well. An \
empty array means there was no prior plan — ignore it.

FORMAT MIX — target for a FULL week (from settings.weekly_mix): ${mixTarget}.
This is the relative EMPHASIS, not a literal count: she posts only ~3-4x/week, so honor the \
proportions, don't try to hit the raw numbers.
- Lead with reels — they reach non-followers and drive most discovery for a sub-1K account.
- Include carousels — they earn the most saves (the metric that matters here).
- Use static (her core comic/doodle) more sparingly, per the target's lower weight.
- ${reelRule}
- Vary formats across the week unless her own data clearly favors repeating one.
- Her own \`format_performance\` STILL OUTRANKS this target — if her carousels clearly out-save \
her reels, weight toward what her numbers show, not the default mix.

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
  recap: RecapRow[],
) {
  return {
    today: today.toISODate(),
    last_week_recap: summarizeRecap(recap),
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
      weekly_mix: settings.weeklyMix,
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

// --- Content-mix nudge (FEATURES.md §5) -------------------------------------

export type MixSummary = {
  target: Record<string, number>;
  actual: Record<string, number>;
  note: string | null;
};

/**
 * Compare the plan's format distribution against settings.weekly_mix. This is a
 * NUDGE, never a hard-fail (she may have only doodles a given week): the prompt
 * is the real lever; this just surfaces how the week landed and flags a gentle,
 * honest note if the target's top-emphasis format got no slot at all.
 */
function mixSummary(slots: SlotInput[], target: Record<string, number> | null | undefined): MixSummary {
  const tgt = target ?? {};
  const actual: Record<string, number> = {};
  for (const s of slots) actual[s.format] = (actual[s.format] ?? 0) + 1;

  let topFmt: string | null = null;
  let topWeight = 0;
  for (const [fmt, w] of Object.entries(tgt)) {
    if (typeof w === "number" && w > topWeight) {
      topWeight = w;
      topFmt = fmt;
    }
  }

  let note: string | null = null;
  if (topFmt && topWeight > 0 && !(actual[topFmt] > 0)) {
    note =
      `Target leads with ${topFmt} (weight ${topWeight}) but the plan has none — ` +
      "fine if she lacked the material this week.";
  }
  return { target: tgt, actual, note };
}

// --- Orchestration ----------------------------------------------------------

function mondayOfWeek(d: DateTime): DateTime {
  // Luxon weekday: 1 = Monday .. 7 = Sunday.
  return d.minus({ days: d.weekday - 1 }).startOf("day");
}

export type WebSkipReason = "cadence" | "off" | null;

/**
 * Decide whether to run web search this cycle (FEATURES.md §6):
 *   'off'     -> never
 *   'weekly'  -> always (legacy behavior)
 *   'monthly' -> only if last_web_search_at is null or >= WEB_SEARCH_MIN_DAYS old
 * Returns the reason it was skipped so the UI can explain itself.
 */
function decideWebSearch(
  settings: Settings,
  today: DateTime,
): { search: boolean; skipReason: WebSkipReason } {
  const cadence = settings.webSearchCadence;
  if (cadence === "off") return { search: false, skipReason: "off" };
  if (cadence === "weekly") return { search: true, skipReason: null };

  // 'monthly' (default): gate on the stamp.
  const last = settings.lastWebSearchAt ? DateTime.fromISO(settings.lastWebSearchAt) : null;
  if (!last || !last.isValid) return { search: true, skipReason: null }; // never searched
  const ageDays = today.startOf("day").diff(last.startOf("day"), "days").days;
  if (ageDays >= WEB_SEARCH_MIN_DAYS) return { search: true, skipReason: null };
  return { search: false, skipReason: "cadence" };
}

/** Web search as a degradable supplement — never blocks the weekly plan. */
async function runResearch(today: DateTime): Promise<{ ok: boolean; text: string; queries: string[] }> {
  try {
    const result = await webSearch({ prompt: researchPrompt(today), agent: "strategy" });
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
  webSkippedReason: WebSkipReason;
  mixTarget: Record<string, number>;
  mixActual: Record<string, number>;
  mixNote: string | null;
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
  // Plan→actual loop: last week's plan + what actually got posted, to adapt from.
  const recap = await getWeekRecap(ws.minus({ days: 7 }).toISODate()!);

  // FEATURES.md §6: web search is now cadence-gated (default 'monthly').
  const { search: doSearch, skipReason } = decideWebSearch(settings, today);
  const web = doSearch
    ? await runResearch(today)
    : {
        ok: false,
        text:
          skipReason === "off"
            ? "(web search is turned off in settings — planned from first-party data only)"
            : "(web search skipped — searched within the last 28 days; monthly cadence)",
        queries: [] as string[],
      };
  // Stamp only when a search actually ran and returned at least one query.
  if (doSearch && web.ok && web.queries.length > 0) {
    await updateSettings({ lastWebSearchAt: await nowIso() });
  }

  const ctx = context(today, ws, we, allowedDates, settings, posts, markets, products, web, recap);
  const result = await callJson({
    model: STRATEGY_MODEL,
    system: systemPrompt(settings),
    content: JSON.stringify(ctx, null, 2),
    schema: PLAN_SCHEMA,
    toolName: "record_plan",
    toolDescription: "Record the weekly content calendar.",
    maxTokens: 3000,
    agent: "strategy",
  });

  const slots = validateSlots(result.slots, allowedDates, defaultTime);
  const mix = mixSummary(slots, settings.weeklyMix);
  const rowIds = await replaceWeekPlan(ws.toISODate()!, slots);
  return {
    weekStart: ws.toISODate()!,
    slots,
    rowIds,
    reasoning: (result.reasoning || "").trim(),
    webQueries: web.queries,
    webUsed: web.ok,
    webSkippedReason: skipReason,
    mixTarget: mix.target,
    mixActual: mix.actual,
    mixNote: mix.note,
  };
}
