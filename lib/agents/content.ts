/**
 * lib/agents/content.ts — Agent 2: per-post supporting material.
 *
 * Faithful port of agents/content_agent.py. Model: claude-haiku-4-5. Trigger:
 * the UI's "Generate draft" button, once per calendar slot AFTER art is attached.
 *
 * It does NOT write a caption — she writes that. It prepares the material AROUND
 * the caption: a hashtag set, a CTA suggestion (+ product + URL), and — for reels
 * — a hook + rough script, all referencing the actual artwork.
 *
 * IMAGES ONLY (MIGRATION.md §4): the attached art is always an image (reels take
 * a still), so the Python video/ffmpeg branch (_extract_video_frame, _VIDEO_EXTS)
 * is dropped entirely; the agent always receives one image block.
 */

import { z } from "zod";

import { AgentError, CONTENT_MODEL, callJson, imageBlock } from "../claude";
import { fetchArtBytes } from "../storage";
import {
  getActiveProducts,
  getBrandVoice,
  getCalendarSlot,
  getPost,
  getRecentPosted,
  getSettings,
  insertPost,
  linkSlotToPost,
  updatePost,
  type BrandVoice,
  type CalendarSlot,
  type Product,
  type Settings,
} from "../db";

const VALID_CTA_TYPES = ["shop", "snail_mail", "market", "none"] as const;

// --- Output schema ----------------------------------------------------------

function draftSchema(hmin: number, hmax: number) {
  return z.object({
    hashtags: z
      .array(z.string())
      .min(hmin)
      .max(hmax)
      .describe(
        `${hmin}-${hmax} hashtags, a mix of large/medium/niche reach, specific to what's ` +
          "visible in the image and the slot theme.",
      ),
    cta_type: z.enum(VALID_CTA_TYPES),
    product_id: z
      .number()
      .int()
      .optional()
      .describe("An id from active_products; include when cta_type is 'shop' or 'snail_mail'."),
    cta_suggestion: z
      .string()
      .describe("Suggested CTA line in her voice; empty if cta_type is 'none'."),
    reel_script: z
      .string()
      .optional()
      .describe("Reel only: a hook line + a rough 3-5 beat outline. Omit for non-reels."),
    agent_reasoning: z.string().describe("1-2 sentences on the hashtag/CTA/hook choices."),
  });
}

type DraftOut = z.infer<ReturnType<typeof draftSchema>>;

// --- Prompt -----------------------------------------------------------------

function systemPrompt(settings: Settings, brandVoice: BrandVoice): string {
  const hmin = settings.hashtagCountMin;
  const hmax = settings.hashtagCountMax;
  const artist = brandVoice.artistName || "the artist";
  return `You are the Content Agent for ${artist}, a one-person indie art \
business on Instagram (under 1,000 followers). She draws original comics, \
doodles, and stickers and sells prints, stickers, crafts, and a monthly \
snail-mail subscription.

She writes her own captions — you do NOT write a caption. You prepare the \
material AROUND the caption: a hashtag set, a suggested call-to-action line, \
and, for reels, a hook and rough script.

You are shown the ACTUAL artwork for this post as an image. Look at it closely. \
Your hashtags and (for reels) your hook must reference what is genuinely visible \
in that image, not a generic guess.

HASHTAGS:
- Return between ${hmin} and ${hmax} hashtags (the count comes from settings, it is \
not a fixed number).
- Mix reach tiers: some large (1M+ posts), some medium (100K-1M), some niche \
(<100K). Niche tags are where a small account actually gets discovered.
- Make them specific to what's in the image and to the slot theme.
- Vary them from \`recent_hashtag_sets\` — don't repeat the same block every post.

CTA SUGGESTION (she may use it, edit it, or drop it entirely):
- Infer the CTA from the slot's theme/content_idea. If it points to the online \
shop, set cta_type "shop" and choose the most fitting, least-recently-promoted \
item from \`active_products\`. If it points to the subscription, set "snail_mail". \
If it teases or announces an art market, set "market". If nothing fits, set \
"none" and leave cta_suggestion empty.
- Write it in her voice: warm, casual, a little playful, NEVER salesy. Match \
\`tone_description\` and never use any phrase in \`avoid_phrases\`.
- For a snail-mail CTA, base it closely on \`snail_mail_pitch\`.
- For "shop" or "snail_mail", return the \`product_id\` you chose from \
\`active_products\`.

REEL (only when the slot format is "reel"):
- Provide \`reel_script\`: a curiosity- or process-reveal hook line (e.g. "Watch me \
turn this doodle into…") that references what's visible in the image, followed by \
a rough 3-5 beat outline.
- Vary the hook from \`recent_reel_scripts\`.
- For any non-reel format, omit \`reel_script\` entirely.

Keep \`agent_reasoning\` to 1-2 sentences. Call the \`record_draft\` tool exactly once.`;
}

function context(
  slot: CalendarSlot,
  settings: Settings,
  brandVoice: BrandVoice,
  products: Product[],
  recent: { hashtags: string[] | null; reelScript: string | null }[],
) {
  return {
    slot: {
      format: slot.format,
      theme: slot.theme,
      content_idea: slot.contentIdea,
    },
    settings: {
      hashtag_count_min: settings.hashtagCountMin,
      hashtag_count_max: settings.hashtagCountMax,
    },
    brand_voice: {
      artist_name: brandVoice.artistName,
      tone_description: brandVoice.toneDescription,
      example_captions: brandVoice.exampleCaptions,
      avoid_phrases: brandVoice.avoidPhrases,
      snail_mail_pitch: brandVoice.snailMailPitch,
    },
    active_products: products.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      url: p.url,
      last_promoted_at: p.lastPromotedAt,
    })),
    recent_hashtag_sets: recent.filter((p) => p.hashtags).map((p) => p.hashtags),
    recent_reel_scripts: recent.filter((p) => p.reelScript).map((p) => p.reelScript),
  };
}

// --- Post-process the model output ------------------------------------------

/** Clean and de-dupe hashtags; trim to the max. Throw if none survive. */
function normalizeHashtags(raw: unknown, hmax: number): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const t of Array.isArray(raw) ? raw : []) {
    if (typeof t !== "string") continue;
    const body = t.trim().replace(/^#+/, "").replace(/\s+/g, ""); // drop '#'/spaces
    if (!body) continue;
    const tag = "#" + body;
    const key = tag.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      tags.push(tag);
    }
  }
  if (tags.length === 0) {
    throw new AgentError("Content Agent returned no usable hashtags.");
  }
  return tags.slice(0, hmax);
}

/** Pick a product when the model didn't return a valid id (least-recent first). */
function fallbackProduct(ctaType: string, products: Product[]): Product | null {
  if (ctaType === "snail_mail") {
    return products.find((p) => p.type === "snail_mail") ?? null;
  }
  // shop: prefer a non-subscription item, else fall back to anything active.
  return products.find((p) => p.type !== "snail_mail") ?? products[0] ?? null;
}

/** Map the model's CTA choice onto (ctaType, suggestion, productId, ctaUrl). */
function resolveCta(
  modelOut: DraftOut,
  products: Product[],
): { ctaType: string; suggestion: string | null; productId: number | null; ctaUrl: string | null } {
  let ctaType: string = modelOut.cta_type;
  if (!VALID_CTA_TYPES.includes(ctaType as (typeof VALID_CTA_TYPES)[number])) ctaType = "none";
  const suggestion = (modelOut.cta_suggestion || "").trim() || null;

  if (ctaType === "shop" || ctaType === "snail_mail") {
    const byId = new Map(products.map((p) => [p.id, p]));
    const product =
      (modelOut.product_id != null ? byId.get(modelOut.product_id) : undefined) ??
      fallbackProduct(ctaType, products);
    if (product) return { ctaType, suggestion, productId: product.id, ctaUrl: product.url ?? null };
    return { ctaType, suggestion, productId: null, ctaUrl: null };
  }
  return { ctaType, suggestion, productId: null, ctaUrl: null }; // market / none carry no product
}

// --- Orchestration ----------------------------------------------------------

export type GenerateDraftResult = {
  postId: number;
  slotId: number;
  status: string;
  format: string | null;
  artFilename: string;
  hashtags: string[];
  ctaType: string;
  ctaUrl: string | null;
  ctaSuggestion: string | null;
  productId: number | null;
  reelScript: string | null;
  agentReasoning: string | null;
};

/**
 * Generate the supporting material for one calendar slot and upsert its draft.
 * Throws AgentError on any failure, in which case nothing was written.
 */
export async function generateDraft(slotId: number, artKey?: string): Promise<GenerateDraftResult> {
  const slot = await getCalendarSlot(slotId);
  if (!slot) throw new AgentError(`Calendar slot ${slotId} not found.`);

  // The UI's attach-art step creates the draft post (linked via slot.postId) and
  // sets art_filename on it. Fill that row in; fall back to inserting one.
  const post = slot.postId ? await getPost(slot.postId) : null;
  const artFilename = artKey ?? post?.artFilename ?? null;
  if (!artFilename) {
    throw new AgentError("No art attached for this slot — attach art before generating a draft.");
  }
  const { bytes, mediaType } = await fetchArtBytes(artFilename);

  const settings = await getSettings();
  if (!settings) throw new AgentError("settings row is missing — run `npm run seed` first.");
  const brandVoice = await getBrandVoice();
  if (!brandVoice) throw new AgentError("brand_voice row is missing — run `npm run seed` first.");

  const products = await getActiveProducts();
  const recent = await getRecentPosted(5);

  const hmin = settings.hashtagCountMin;
  const hmax = settings.hashtagCountMax;

  const content = [
    imageBlock(bytes, mediaType),
    {
      type: "text" as const,
      text:
        "The image above is the actual artwork for this post. Here is the slot and context:\n\n" +
        JSON.stringify(context(slot, settings, brandVoice, products, recent), null, 2),
    },
  ];

  const result = await callJson({
    model: CONTENT_MODEL,
    system: systemPrompt(settings, brandVoice),
    content,
    schema: draftSchema(hmin, hmax),
    toolName: "record_draft",
    toolDescription: "Record the post's hashtags, CTA suggestion, and reel script.",
    maxTokens: 1500,
    agent: "content",
  });

  const hashtags = normalizeHashtags(result.hashtags, hmax);
  const { ctaType, suggestion, productId, ctaUrl } = resolveCta(result, products);

  const fmt = slot.format;
  let reelScript: string | null = (result.reel_script || "").trim();
  if (fmt === "reel") {
    if (!reelScript) {
      throw new AgentError("Reel slot needs a hook + script, but none was generated.");
    }
  } else {
    reelScript = null; // non-reels carry no script
  }

  const fields = {
    status: "draft",
    format: fmt,
    artFilename,
    hashtags,
    ctaType,
    ctaUrl,
    ctaSuggestion: suggestion,
    productId,
    reelScript,
    agentReasoning: (result.agent_reasoning || "").trim() || null,
  };

  let postId: number;
  if (post) {
    await updatePost(post.id, fields); // caption left untouched (stays null)
    postId = post.id;
  } else {
    postId = await insertPost(fields); // caption defaults to null
    await linkSlotToPost(slotId, postId);
  }

  return { postId, slotId, ...fields };
}
