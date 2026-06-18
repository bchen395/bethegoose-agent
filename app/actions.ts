"use server";

/**
 * app/actions.ts — server actions for UI mutations (save numbers override, log
 * subscribers, CRUD for products/markets/settings/brand voice, sign out). Reads
 * go through RSC; these are the writes. The long agent trigger (Strategy) is a
 * route handler instead, so it can set maxDuration.
 *
 * All actions run behind the auth middleware (it matches server-action POSTs).
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  archiveIdea,
  deleteCalendarSlot,
  deleteMarket,
  getCalendarWeek,
  getIdea,
  getSettings,
  insertCalendarSlot,
  insertIdea,
  insertMarket,
  insertProduct,
  insertSubscriberEvent,
  updateBrandVoice,
  updateCalendarSlot,
  updateEngagement,
  updateMarket,
  updatePost,
  updateProduct,
  updateSettings,
} from "@/lib/db";
import { defaultWeekTemplate } from "@/lib/calendar/template";
import { createClient } from "@/lib/supabase/server";
import {
  CTA_OPTIONS,
  FORMATS,
  MARKET_STATUSES,
  PRODUCT_TYPES,
  WEB_SEARCH_CADENCES,
} from "@/app/(app)/_lib/format";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Coerce to a non-negative integer, or null if blank/invalid. */
function cleanCount(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return Math.max(0, Math.floor(v));
}

export async function saveNumbers(
  postId: number,
  metrics: {
    reach: number | null;
    saves: number | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
  },
): Promise<void> {
  // saves + reach are the only required fields (FEATURES.md §3).
  const reach = cleanCount(metrics.reach);
  const saves = cleanCount(metrics.saves);
  if (reach == null || saves == null) {
    throw new Error("Saves and reach are required.");
  }
  await updateEngagement(postId, {
    reach,
    saves,
    likes: cleanCount(metrics.likes),
    comments: cleanCount(metrics.comments),
    shares: cleanCount(metrics.shares),
  });
  revalidatePath("/engagement");
  revalidatePath("/insights");
}

/**
 * Tag which CTA a posted item drove (FEATURES.md §4). One tap on /engagement; the
 * stored cta_type powers the "which CTA converts" insight and the Strategy Agent's
 * CTA-rotation cues. Validates against the schema CHECK before writing.
 */
export async function setPostCta(postId: number, ctaType: string): Promise<void> {
  if (!CTA_OPTIONS.includes(ctaType)) throw new Error("Pick a valid CTA type.");
  await updatePost(postId, { ctaType });
  revalidatePath("/engagement");
  revalidatePath("/insights");
}

/** Log new subscribers (FEATURES.md §4), optionally attributed to a post. */
export async function logSubscriberEvent(input: {
  channel: string;
  count: number;
  sourcePostId?: number | null;
  note?: string | null;
}): Promise<void> {
  const channel = input.channel === "snail_mail" || input.channel === "email" ? input.channel : null;
  if (!channel) throw new Error("Channel must be 'snail_mail' or 'email'.");
  const count = cleanCount(input.count);
  if (count == null || count < 1) throw new Error("Count must be at least 1.");
  const sourcePostId =
    input.sourcePostId != null && Number.isInteger(input.sourcePostId) ? input.sourcePostId : null;
  const note = (input.note ?? "").trim() || null;
  await insertSubscriberEvent({ channel, count, sourcePostId, note });
  revalidatePath("/engagement");
  revalidatePath("/insights");
}

// --- Item #2: CRUD for products / markets / settings / brand voice ----------
//
// These back the authed CRUD screens that replace the seed-only data entry.
// Each validates enums + CHECK-constraint preconditions before writing so the
// user gets a clean message instead of a raw Postgres error, mirroring the
// CTA_OPTIONS pattern above. The agent-managed products.lastPromotedAt is never
// accepted here.

/** Split a textarea (one item per line) into a clean, de-duped list. */
function parseLines(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const key = line.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(line);
    }
  }
  return out;
}

type ProductInput = { name: string; url: string; type: string; active: boolean };

function cleanProduct(data: ProductInput) {
  const name = data.name.trim();
  if (!name) throw new Error("Product name is required.");
  if (!PRODUCT_TYPES.includes(data.type)) throw new Error("Pick a valid product type.");
  return { name, url: data.url.trim() || null, type: data.type, active: Boolean(data.active) };
}

export async function createProduct(data: ProductInput): Promise<void> {
  await insertProduct(cleanProduct(data));
  revalidatePath("/products");
}

export async function updateProductAction(productId: number, data: ProductInput): Promise<void> {
  await updateProduct(productId, cleanProduct(data));
  revalidatePath("/products");
}

type MarketInput = {
  name: string;
  location: string;
  eventDate: string;
  applicationDeadline: string;
  status: string;
  notes: string;
};

function cleanMarket(data: MarketInput) {
  const name = data.name.trim();
  if (!name) throw new Error("Market name is required.");
  const status = data.status.trim();
  if (status && !MARKET_STATUSES.includes(status)) throw new Error("Pick a valid market status.");
  return {
    name,
    location: data.location.trim() || null,
    eventDate: data.eventDate.trim() || null,
    applicationDeadline: data.applicationDeadline.trim() || null,
    status: status || null,
    notes: data.notes.trim() || null,
  };
}

export async function createMarket(data: MarketInput): Promise<void> {
  await insertMarket(cleanMarket(data));
  revalidatePath("/markets");
}

export async function updateMarketAction(marketId: number, data: MarketInput): Promise<void> {
  await updateMarket(marketId, cleanMarket(data));
  revalidatePath("/markets");
}

export async function deleteMarketAction(marketId: number): Promise<void> {
  await deleteMarket(marketId);
  revalidatePath("/markets");
}

export async function saveSettings(data: {
  timezone: string;
  hashtagCountMin: number;
  hashtagCountMax: number;
  defaultPostTime: string;
  reelsRequired: boolean;
  weeklyMix: { reel: number; carousel: number; static: number };
  webSearchCadence: string;
  monthlyBudgetUsd: string;
  shopUrl: string;
}): Promise<void> {
  const timezone = data.timezone.trim();
  if (!timezone) throw new Error("Timezone is required.");
  const defaultPostTime = data.defaultPostTime.trim();
  if (!/^\d{2}:\d{2}$/.test(defaultPostTime)) {
    throw new Error("Default post time must be HH:MM (e.g. 18:30).");
  }
  const hashtagCountMin = cleanCount(data.hashtagCountMin);
  const hashtagCountMax = cleanCount(data.hashtagCountMax);
  if (hashtagCountMin == null || hashtagCountMax == null) {
    throw new Error("Hashtag counts must be whole numbers.");
  }
  if (hashtagCountMin > hashtagCountMax) {
    throw new Error("Hashtag minimum can't be greater than the maximum.");
  }
  if (!WEB_SEARCH_CADENCES.includes(data.webSearchCadence)) {
    throw new Error("Pick a valid web-search cadence.");
  }
  const budget = Number(data.monthlyBudgetUsd);
  if (!Number.isFinite(budget) || budget < 0) {
    throw new Error("Monthly budget must be a non-negative number.");
  }
  const shopUrl = data.shopUrl.trim();
  if (shopUrl && !/^https?:\/\//i.test(shopUrl)) {
    throw new Error("Shop URL must start with http:// or https://");
  }
  await updateSettings({
    timezone,
    hashtagCountMin,
    hashtagCountMax,
    defaultPostTime,
    reelsRequired: Boolean(data.reelsRequired),
    weeklyMix: {
      reel: cleanCount(data.weeklyMix.reel) ?? 0,
      carousel: cleanCount(data.weeklyMix.carousel) ?? 0,
      static: cleanCount(data.weeklyMix.static) ?? 0,
    },
    webSearchCadence: data.webSearchCadence,
    monthlyBudgetUsd: String(budget),
    shopUrl: shopUrl || null,
  });
  revalidatePath("/settings");
}

export async function saveBrandVoice(data: {
  artistName: string;
  toneDescription: string;
  exampleCaptionsText: string;
  avoidPhrasesText: string;
  snailMailPitch: string;
}): Promise<void> {
  await updateBrandVoice({
    artistName: data.artistName.trim() || null,
    toneDescription: data.toneDescription.trim() || null,
    exampleCaptions: parseLines(data.exampleCaptionsText),
    avoidPhrases: parseLines(data.avoidPhrasesText),
    snailMailPitch: data.snailMailPitch.trim() || null,
  });
  revalidatePath("/settings");
}

// --- Interactive calendar: drag-drop, the idea library, and "done" ----------
//
// These back the interactive /calendar board. Any manual change pins the slot
// (pinned = true) so a Strategy Agent re-run preserves it (see replaceWeekPlan).

/** Seed an empty week from the deterministic default layout (un-pinned). */
export async function seedDefaultWeek(weekStart: string): Promise<void> {
  if (!ISO_DATE.test(weekStart)) throw new Error("Invalid week.");
  const existing = await getCalendarWeek(weekStart);
  if (existing.length > 0) return; // never duplicate an already-populated week
  const settings = await getSettings();
  if (!settings) throw new Error("Settings not configured yet.");
  for (const slot of defaultWeekTemplate(weekStart, settings)) {
    await insertCalendarSlot({ ...slot, weekStart, pinned: false });
  }
  revalidatePath("/calendar");
}

/** Create a custom post idea in the reusable library (the "box"). */
export async function createIdea(data: {
  title: string;
  format: string;
  contentIdea: string;
}): Promise<void> {
  const title = data.title.trim();
  if (!title) throw new Error("Give your idea a short title.");
  const format = data.format.trim();
  if (format && !FORMATS.includes(format)) throw new Error("Pick a valid format.");
  await insertIdea({
    title,
    format: format || null,
    contentIdea: data.contentIdea.trim() || null,
    source: "user",
  });
  revalidatePath("/calendar");
}

/** Hide an idea from the library (calendar slots that used it are untouched). */
export async function archiveIdeaAction(ideaId: number): Promise<void> {
  await archiveIdea(ideaId);
  revalidatePath("/calendar");
}

/** Schedule a library idea onto a day — copies its fields; the idea stays. */
export async function scheduleIdea(
  ideaId: number,
  slotDate: string,
  weekStart: string,
): Promise<void> {
  if (!ISO_DATE.test(slotDate) || !ISO_DATE.test(weekStart)) throw new Error("Invalid day.");
  const idea = await getIdea(ideaId);
  if (!idea) throw new Error("That idea no longer exists.");
  const settings = await getSettings();
  await insertCalendarSlot({
    weekStart,
    slotDate,
    slotTime: settings?.defaultPostTime ?? "12:00",
    format: idea.format,
    theme: idea.title,
    contentIdea: idea.contentIdea,
    priority: 2,
    pinned: true,
    ideaId: idea.id,
  });
  revalidatePath("/calendar");
}

/** Move a scheduled slot to another day (drag between day columns). */
export async function moveSlot(slotId: number, newSlotDate: string): Promise<void> {
  if (!ISO_DATE.test(newSlotDate)) throw new Error("Invalid day.");
  await updateCalendarSlot(slotId, { slotDate: newSlotDate, pinned: true });
  revalidatePath("/calendar");
}

/** Remove a slot from the calendar (drag back to the tray / unschedule). */
export async function unscheduleSlot(slotId: number): Promise<void> {
  await deleteCalendarSlot(slotId);
  revalidatePath("/calendar");
}

/** Toggle the lightweight "done" planning check on a slot. */
export async function setSlotDone(slotId: number, done: boolean): Promise<void> {
  await updateCalendarSlot(slotId, { done: Boolean(done), pinned: true });
  revalidatePath("/calendar");
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
