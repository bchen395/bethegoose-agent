"use server";

/**
 * app/actions.ts — server actions for UI mutations (attach art, save draft,
 * discard, mark posted, save numbers, sign out). Reads go through RSC; these are
 * the writes. Long agent triggers (Strategy/Content/Distribution) are route
 * handlers instead, so they can set maxDuration.
 *
 * All actions run behind the auth middleware (it matches server-action POSTs).
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  deleteMarket,
  getCalendarSlot,
  insertMarket,
  insertPost,
  insertProduct,
  insertSubscriberEvent,
  linkSlotToPost,
  markPosted as dbMarkPosted,
  setPostStatus,
  updateBrandVoice,
  updateEngagement,
  updateMarket,
  updatePost,
  updateProduct,
  updateSettings,
} from "@/lib/db";
import { buildArtKey, createSignedUploadUrl } from "@/lib/storage";
import { createClient } from "@/lib/supabase/server";
import {
  MARKET_STATUSES,
  PRODUCT_TYPES,
  WEB_SEARCH_CADENCES,
} from "@/app/(app)/_lib/format";

const CTA_OPTIONS = ["none", "shop", "snail_mail", "market"];

/** Parse an edited hashtag box (comma/space/newline separated) into a clean,
 *  de-duped list. Mirrors the Content Agent's normalization. */
function parseHashtags(text: string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.replace(/,/g, " ").split(/\s+/)) {
    const body = raw.replace(/^#+/, "").trim();
    if (!body) continue;
    const tag = "#" + body;
    const key = tag.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      tags.push(tag);
    }
  }
  return tags;
}

/** Return the slot's linked draft post id, creating + linking one if needed
 *  (the row the Content Agent later fills in — attach-art owns its creation). */
async function ensureDraft(slotId: number): Promise<number> {
  const slot = await getCalendarSlot(slotId);
  if (!slot) throw new Error(`Calendar slot ${slotId} not found.`);
  if (slot.postId) return slot.postId;
  const postId = await insertPost({ status: "draft", format: slot.format });
  await linkSlotToPost(slotId, postId);
  return postId;
}

/**
 * Step 1 of attach-art: ensure a draft exists, mint a signed upload URL the
 * browser uploads to directly (no Vercel function in the upload path).
 */
export async function prepareArtUpload(
  slotId: number,
  filename: string,
): Promise<{ postId: number; key: string; token: string }> {
  const postId = await ensureDraft(slotId);
  const key = buildArtKey(slotId, filename);
  const { token } = await createSignedUploadUrl(key);
  return { postId, key, token };
}

/** Step 2 of attach-art: record the uploaded object key on the draft post. */
export async function finalizeArtUpload(postId: number, key: string): Promise<void> {
  await updatePost(postId, { artFilename: key });
  revalidatePath("/calendar");
}

/** Save edits to a draft (caption/hashtags/CTA). */
export async function saveDraft(
  postId: number,
  data: {
    caption: string;
    hashtagsText: string;
    ctaType: string;
    ctaUrl: string;
    ctaSuggestion: string;
  },
): Promise<void> {
  const ctaType = CTA_OPTIONS.includes(data.ctaType) ? data.ctaType : "none";
  const fields: Record<string, unknown> = {
    caption: data.caption.trim() || null,
    hashtags: parseHashtags(data.hashtagsText),
    ctaType,
    ctaSuggestion: data.ctaSuggestion.trim() || null,
    ctaUrl: data.ctaUrl.trim() || null,
  };
  // CTA no longer points at a product -> clear the rotation target so the
  // Distribution Agent doesn't stamp last_promoted_at wrongly.
  if (ctaType !== "shop" && ctaType !== "snail_mail") fields.productId = null;
  await updatePost(postId, fields);
  revalidatePath("/review");
}

export async function discardDraft(postId: number): Promise<void> {
  await setPostStatus(postId, "discarded");
  revalidatePath("/review");
}

export async function markPosted(postId: number): Promise<void> {
  await dbMarkPosted(postId);
  revalidatePath("/engagement");
}

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
// CTA_OPTIONS pattern above. Agent-owned fields (products.lastPromotedAt,
// markets.draftApplication) are never accepted here.

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
  captionStartersEnabled: boolean;
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
    captionStartersEnabled: Boolean(data.captionStartersEnabled),
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

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
