"use server";

/**
 * app/actions.ts — server actions for UI mutations (save numbers override, log
 * subscribers, CRUD for products/markets/settings/brand voice, sign out). Reads
 * go through RSC; these are the writes. The long agent trigger (Strategy) is a
 * route handler instead, so it can set maxDuration.
 *
 * All actions run behind the auth middleware (it matches server-action POSTs).
 */

import { DateTime } from "luxon";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  archiveIdea,
  deleteCalendarSlot,
  deleteMarket,
  getCalendarSlot,
  getCalendarWeek,
  getSettings,
  insertCalendarSlot,
  insertIdea,
  insertMarket,
  insertProduct,
  insertSubscriberEvent,
  updateBrandVoice,
  updateCalendarSlot,
  updateEngagement,
  updateIdea,
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

// --- Interactive calendar: tap-to-add / tap-to-edit -------------------------
//
// These back the simplified /calendar. The page shows ONE unified card type:
// scheduled posts live in `calendar` (under a day), unscheduled ideas live in
// `post_ideas`. The editor edits either in place, and moving a card between the
// two (give a day / send back to unscheduled) hops it across tables. Any manual
// change pins the slot (pinned = true) so a Strategy Agent re-run preserves it
// (see replaceWeekPlan). Agent suggestions are just un-pinned `calendar` rows,
// so editing one is a plain update — no separate "accept" step.

const HHMM = /^\d{2}:\d{2}$/;

/** Monday (ISO) of the week a given day falls in — keeps weekStart in sync on moves. */
function mondayOfIso(slotDate: string): string {
  const d = DateTime.fromISO(slotDate);
  return d.minus({ days: d.weekday - 1 }).toISODate()!;
}

/** The shared editor payload for a card (a slot or an idea). */
type SlotFields = {
  slotDate: string | null; // null = unscheduled
  slotTime?: string | null;
  format?: string | null;
  theme?: string | null;
  contentIdea?: string | null;
  priority?: number | null;
};

/** Validate + normalize the editor fields once for every write path below. */
function cleanSlotFields(f: SlotFields) {
  const format = (f.format ?? "").trim();
  if (format && !FORMATS.includes(format)) throw new Error("Pick a valid format.");
  const slotTime = (f.slotTime ?? "").trim();
  if (slotTime && !HHMM.test(slotTime)) throw new Error("Time must be HH:MM (e.g. 18:30).");
  return {
    format: format || null,
    slotTime: slotTime || null,
    theme: (f.theme ?? "").trim() || null,
    contentIdea: (f.contentIdea ?? "").trim() || null,
    priority: f.priority === 1 ? 1 : 2,
  };
}

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

/** Add a brand-new card: onto a day (a calendar slot) or to the unscheduled box (an idea). */
export async function addPost(fields: SlotFields): Promise<void> {
  const c = cleanSlotFields(fields);
  if (fields.slotDate == null) {
    if (!c.theme) throw new Error("Give your idea a short title.");
    await insertIdea({ title: c.theme, format: c.format, contentIdea: c.contentIdea, source: "user" });
  } else {
    if (!ISO_DATE.test(fields.slotDate)) throw new Error("Invalid day.");
    const settings = await getSettings();
    await insertCalendarSlot({
      weekStart: mondayOfIso(fields.slotDate),
      slotDate: fields.slotDate,
      slotTime: c.slotTime ?? settings?.defaultPostTime ?? "12:00",
      format: c.format,
      theme: c.theme,
      contentIdea: c.contentIdea,
      priority: c.priority,
      pinned: true,
    });
  }
  revalidatePath("/calendar");
}

/** Edit a scheduled slot in place — text/format/time/priority and/or move to another day. */
export async function saveSlot(slotId: number, fields: SlotFields): Promise<void> {
  if (fields.slotDate == null || !ISO_DATE.test(fields.slotDate)) throw new Error("Invalid day.");
  const c = cleanSlotFields(fields);
  await updateCalendarSlot(slotId, {
    slotDate: fields.slotDate,
    weekStart: mondayOfIso(fields.slotDate),
    slotTime: c.slotTime,
    format: c.format,
    theme: c.theme,
    contentIdea: c.contentIdea,
    priority: c.priority,
    pinned: true,
  });
  revalidatePath("/calendar");
}

/** Edit an unscheduled idea in place (stays in the box). */
export async function saveIdea(ideaId: number, fields: SlotFields): Promise<void> {
  const c = cleanSlotFields(fields);
  if (!c.theme) throw new Error("Give your idea a short title.");
  await updateIdea(ideaId, { title: c.theme, format: c.format, contentIdea: c.contentIdea });
  revalidatePath("/calendar");
}

/** Move an unscheduled idea onto a day. The idea leaves the box (archived). */
export async function scheduleSlot(ideaId: number, fields: SlotFields): Promise<void> {
  if (fields.slotDate == null || !ISO_DATE.test(fields.slotDate)) throw new Error("Invalid day.");
  const c = cleanSlotFields(fields);
  const settings = await getSettings();
  await insertCalendarSlot({
    weekStart: mondayOfIso(fields.slotDate),
    slotDate: fields.slotDate,
    slotTime: c.slotTime ?? settings?.defaultPostTime ?? "12:00",
    format: c.format,
    theme: c.theme,
    contentIdea: c.contentIdea,
    priority: c.priority,
    pinned: true,
    ideaId, // provenance: lets unscheduleSlot restore this same idea
  });
  await archiveIdea(ideaId);
  revalidatePath("/calendar");
}

/** Move a scheduled slot back to the unscheduled box. The slot leaves the calendar. */
export async function unscheduleSlot(slotId: number, fields: SlotFields): Promise<void> {
  const c = cleanSlotFields(fields);
  const title = c.theme ?? "Untitled idea";
  const slot = await getCalendarSlot(slotId);
  if (slot?.ideaId != null) {
    // Restore the original library idea this slot came from, with any edits.
    await updateIdea(slot.ideaId, {
      title,
      format: c.format,
      contentIdea: c.contentIdea,
      archived: false,
    });
  } else {
    await insertIdea({ title, format: c.format, contentIdea: c.contentIdea, source: "user" });
  }
  await deleteCalendarSlot(slotId);
  revalidatePath("/calendar");
}

/** Permanently remove a scheduled slot (the editor's Delete). */
export async function deleteSlot(slotId: number): Promise<void> {
  await deleteCalendarSlot(slotId);
  revalidatePath("/calendar");
}

/** Remove an unscheduled idea (soft-delete; some slots may still reference it). */
export async function deleteIdea(ideaId: number): Promise<void> {
  await archiveIdea(ideaId);
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
