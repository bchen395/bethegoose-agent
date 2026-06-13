/**
 * lib/agents/distribution.ts — Agent 3: post-approval distribution prep.
 *
 * Faithful port of agents/distribution_agent.py. Model: claude-haiku-4-5 (logic +
 * formatting only). Trigger: the UI's Approve button calls distribute(postId).
 *
 * Flow: confirm the posting time (this agent owns slot_time); build the posting
 * checklist DETERMINISTICALLY in TS (verbatim filename/caption/CTA URL); the only
 * model call is the near-deadline market blurb; stamp the promoted product; set
 * status 'approved' LAST so a mid-run failure leaves a draft with nothing half-written.
 */

import { DateTime } from "luxon";
import { z } from "zod";

import { AgentError, DISTRIBUTION_MODEL, callJson } from "../claude";
import {
  getCalendarSlotByPost,
  getMarketsWithDeadline,
  getPost,
  getRecentScheduledTimes,
  getBrandVoice,
  getSettings,
  setMarketDraftApplication,
  setPostStatus,
  setProductPromoted,
  todayIso,
  updateCalendarSlot,
  updatePost,
  type BrandVoice,
  type Market,
  type Post,
} from "../db";

// Minutes to push a posting time that would otherwise be the 3rd-in-a-row.
const NUDGE_MINUTES = 15;

// Markets with an application deadline within this many days get a draft blurb.
const MARKET_DEADLINE_DAYS = 14;

// --- Posting checklist (deterministic — no model) ---------------------------

/** 18:30 -> '6:30 PM'. */
function to12h(hhmm: string): string {
  const h = parseInt(hhmm.slice(0, 2), 10);
  const m = parseInt(hhmm.slice(3, 5), 10);
  const suffix = h < 12 ? "AM" : "PM";
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** '2026-06-12' -> 'Friday, June 12' (falls back to the raw string). */
function friendlyDate(isoDate: string): string {
  const d = DateTime.fromISO(isoDate);
  if (!d.isValid) return isoDate;
  return d.toFormat("EEEE, LLLL d");
}

/** CTA goes in the pinned first comment; otherwise the first comment is hashtags. */
function firstCommentLine(post: Post): string {
  const labels: Record<string, string> = { shop: "shop", snail_mail: "snail-mail", market: "market" };
  const ctaType = post.ctaType ?? "";
  const ctaUrl = (post.ctaUrl || "").trim();
  if (labels[ctaType] && ctaUrl) {
    return `- First comment: pin the ${labels[ctaType]} link -> ${ctaUrl}`;
  }
  return "- First comment: drop your hashtags here";
}

/** Assemble the posting checklist from exact values (never paraphrased). */
function buildChecklist(
  post: Post,
  confirmedTime: string,
  postingDate: string,
  isToday: boolean,
  nudged: boolean,
): string {
  const when = isToday ? "today" : `on ${friendlyDate(postingDate)}`;
  const timeNote = nudged
    ? "nudged off your default to vary timing — not data-optimized"
    : "sensible default — not data-optimized yet";
  const caption = (post.caption || "").trim() || "(add your caption before posting)";
  const art = post.artFilename || "(attach your art first)";

  const lines = [
    "POST CHECKLIST",
    `- Best time to post: ${to12h(confirmedTime)} ${when} (${timeNote})`,
    `- Use file: ${art}`,
    `- Caption: ${caption}`,
    firstCommentLine(post),
  ];
  const fmt = post.format;
  if (fmt === "reel") {
    lines.push("- Post as a Reel, then share it to your Story (tag the shop if relevant)");
  } else if (fmt !== "story") {
    lines.push("- Add to Story after posting: yes (tag the shop if relevant)");
  }
  lines.push("- Tag location: yes if at the studio or a market");
  return lines.join("\n");
}

// --- Market blurb (the only model call) -------------------------------------

const BLURB_SCHEMA = z.object({
  market_blurb: z
    .string()
    .describe(
      "A warm, genuine 2-3 sentence art-market application blurb in her voice, naming the " +
        "market and what she'd bring.",
    ),
});

function blurbSystemPrompt(brandVoice: BrandVoice | null): string {
  const artist = brandVoice?.artistName || "the artist";
  return `You are the Distribution Agent for ${artist}, a one-person indie art \
business (hand-drawn comics, doodles, stickers; sells prints, stickers, crafts, and \
a monthly snail-mail subscription). An art market's application deadline is coming \
up. Draft \`market_blurb\`: a warm, genuine 2-3 sentence application blurb she could \
adapt, naming the market and what she'd bring. Match \`tone_description\`, sound like \
her, never use any phrase in \`avoid_phrases\`, and never be salesy. Use the human \
\`notes\` only as background — do not quote them. Call the \`record_market_blurb\` tool \
exactly once.`;
}

function blurbContext(market: Market, brandVoice: BrandVoice | null) {
  return {
    market: {
      name: market.name,
      location: market.location,
      event_date: market.eventDate,
      application_deadline: market.applicationDeadline,
      status: market.status,
      notes: market.notes || "", // read-only background for the blurb
    },
    brand_voice: {
      artist_name: brandVoice?.artistName ?? null,
      tone_description: brandVoice?.toneDescription ?? null,
      avoid_phrases: brandVoice?.avoidPhrases ?? [],
    },
  };
}

async function draftMarketBlurb(market: Market, brandVoice: BrandVoice | null): Promise<string> {
  const result = await callJson({
    model: DISTRIBUTION_MODEL,
    system: blurbSystemPrompt(brandVoice),
    content: JSON.stringify(blurbContext(market, brandVoice), null, 2),
    schema: BLURB_SCHEMA,
    toolName: "record_market_blurb",
    toolDescription: "Record the art-market application blurb.",
    maxTokens: 600,
  });
  const blurb = (result.market_blurb || "").trim();
  if (!blurb) throw new AgentError("Distribution Agent returned an empty market blurb.");
  return blurb;
}

// --- Posting-time confirmation ----------------------------------------------

function normTime(value: unknown, fallback: string | null): string | null {
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

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

function fromMinutes(total: number): string {
  const t = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

/**
 * Confirm the posting time. Keep Strategy's value, floored at the default; nudge
 * only if the last few scheduled posts already cluster at it.
 */
function confirmTime(
  planned: string | null,
  recentTimes: string[],
  defaultTime: string | null,
): { confirmedTime: string; nudged: boolean } {
  const def = normTime(defaultTime, "18:30")!;
  let base = normTime(planned, def)!;
  if (toMinutes(base) < toMinutes(def)) base = def; // default is the floor
  // "Cluster" = base would be the 3rd+ post at this exact time in a row.
  const clustered = recentTimes.filter((t) => normTime(t, null) === base).length >= 2;
  if (clustered) return { confirmedTime: fromMinutes(toMinutes(base) + NUDGE_MINUTES), nudged: true };
  return { confirmedTime: base, nudged: false };
}

// --- Orchestration ----------------------------------------------------------

export type DistributeResult = {
  postId: number;
  status: string;
  slotTime: string;
  timeNudged: boolean;
  postingChecklist: string;
  marketDrafted: { marketId: number; name: string } | null;
  productPromoted: number | null;
};

/**
 * Prepare distribution for an approved post and set it to 'approved'. Throws
 * AgentError on any failure, in which case the status is NOT advanced and
 * nothing half-baked is written (the blurb call precedes every DB write).
 */
export async function distribute(postId: number): Promise<DistributeResult> {
  const post = await getPost(postId);
  if (!post) throw new AgentError(`Post ${postId} not found.`);

  const settings = await getSettings();
  if (!settings) throw new AgentError("settings row is missing — run `npm run seed` first.");
  const brandVoice = await getBrandVoice();
  const defaultTime = settings.defaultPostTime;

  // 1) Confirm the posting time (this agent owns slot_time).
  const slot = await getCalendarSlotByPost(postId);
  const planned = slot?.slotTime ?? null;
  const recentTimes = await getRecentScheduledTimes(5, postId);
  const { confirmedTime, nudged } = confirmTime(planned, recentTimes, defaultTime);

  const today = await todayIso();
  const postingDate = slot?.slotDate ?? today;
  const isToday = postingDate === today;

  // 2) Build the checklist deterministically — verbatim file/caption/CTA URL.
  const checklist = buildChecklist(post, confirmedTime, postingDate, isToday, nudged);

  // 3) Draft a blurb only for a near-deadline market that doesn't have one yet.
  //    This is the agent's only API call — and the only place it can fail.
  const nearMarkets = await getMarketsWithDeadline(MARKET_DEADLINE_DAYS);
  const targetMarket =
    nearMarkets.find((m) => !(m.draftApplication || "").trim()) ?? null;
  const blurb = targetMarket ? await draftMarketBlurb(targetMarket, brandVoice) : null;

  // --- Writes (all after the only failure point; status last). --------------
  await updatePost(postId, { postingChecklist: checklist });

  if (slot && confirmedTime !== normTime(planned, confirmedTime)) {
    await updateCalendarSlot(slot.id, { slotTime: confirmedTime });
  }

  let marketDrafted: { marketId: number; name: string } | null = null;
  if (targetMarket && blurb) {
    await setMarketDraftApplication(targetMarket.id, blurb);
    marketDrafted = { marketId: targetMarket.id, name: targetMarket.name };
  }

  let productPromoted: number | null = null;
  if ((post.ctaType === "shop" || post.ctaType === "snail_mail") && post.productId) {
    await setProductPromoted(post.productId);
    productPromoted = post.productId;
  }

  await setPostStatus(postId, "approved"); // last — leaves a draft on any earlier failure

  return {
    postId,
    status: "approved",
    slotTime: confirmedTime,
    timeNudged: nudged,
    postingChecklist: checklist,
    marketDrafted,
    productPromoted,
  };
}
