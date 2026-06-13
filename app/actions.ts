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
  getCalendarSlot,
  insertPost,
  insertSubscriberEvent,
  linkSlotToPost,
  markPosted as dbMarkPosted,
  setPostStatus,
  updateEngagement,
  updatePost,
} from "@/lib/db";
import { buildArtKey, createSignedUploadUrl } from "@/lib/storage";
import { createClient } from "@/lib/supabase/server";

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

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
