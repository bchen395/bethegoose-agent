/**
 * app/api/insights/reuse/route.ts — FEATURES.md §8 "Reuse your hits".
 *
 * On demand (a button on /insights), take her top posts from the last 90 days
 * (§2's getTopPosts, by saves+shares) and ask Haiku for 2-3 CONCRETE repurposes
 * grounded in those actual posts + her active products + brand voice. One bounded
 * Haiku call per click; nothing persists. Metered by §7 (agent: "content").
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { AgentError, CONTENT_MODEL, callJson } from "@/lib/claude";
import { getActiveProducts, getBrandVoice, getTopPosts } from "@/lib/db";

export const maxDuration = 120;

const REUSE_WINDOW_DAYS = 90;
const TOP_N = 5;
const VALID_FORMATS = ["static", "carousel", "reel", "story"] as const;

const SUGGESTIONS_SCHEMA = z.object({
  suggestions: z
    .array(
      z.object({
        title: z.string().describe("Short label for the repurpose idea."),
        idea: z
          .string()
          .describe("1-2 concrete sentences, grounded in the named post(s) — never generic."),
        based_on_post_ids: z
          .array(z.number().int())
          .min(1)
          .describe("ids from top_posts this idea draws on."),
        suggested_format: z.enum(VALID_FORMATS).optional().describe("Target format, if reformatting."),
        product_tie_in: z
          .string()
          .optional()
          .describe("An active product to attach, if one fits."),
      }),
    )
    .min(1)
    .max(3),
});

function systemPrompt(artist: string): string {
  return `You are a content strategist for ${artist}, a one-person indie art business \
on Instagram (under 1,000 followers; hand-drawn comics, doodles, and stickers; sells \
prints, stickers, crafts, and a monthly snail-mail subscription).

You are given her TOP-PERFORMING posts from the last 90 days (ranked by a saves+shares \
score) plus her active products and brand voice. Propose 2-3 CONCRETE ways to get more \
mileage from what already worked — grounded in the REAL posts, never generic advice.

Good repurposes:
- Turn a popular doodle or comic into a sticker / print SKU (tie to an active product if one fits).
- Re-cut a top static or carousel as a reel (reels reach non-followers).
- Compile a recurring theme across several top posts into a saves-friendly carousel.

Rules:
- Every suggestion MUST reference specific post(s) by id in \`based_on_post_ids\` and say what \
about them worked.
- Tie to \`active_products\` when relevant (\`product_tie_in\`).
- These are ideas, not finished captions — she writes the words.
- Return 2-3 suggestions. Call \`record_reuse_ideas\` exactly once.`;
}

export async function POST() {
  try {
    const [top, brandVoice, products] = await Promise.all([
      getTopPosts(REUSE_WINDOW_DAYS, TOP_N),
      getBrandVoice(),
      getActiveProducts(),
    ]);

    if (top.length === 0) {
      return NextResponse.json({
        ok: true,
        suggestions: [],
        message:
          "Not enough posted history yet — post a few things and enter their numbers, then try again.",
      });
    }

    const ctx = {
      top_posts: top.map((p) => ({
        id: p.id,
        format: p.format,
        caption: p.caption ? p.caption.slice(0, 200) : null,
        cta_type: p.ctaType,
        score: p.score,
        saves: p.saves,
        shares: p.shares,
        reach: p.reach,
        likes: p.likes,
      })),
      active_products: products.map((p) => ({ id: p.id, name: p.name, type: p.type, url: p.url })),
      brand_voice: {
        artist_name: brandVoice?.artistName ?? null,
        tone_description: brandVoice?.toneDescription ?? null,
        avoid_phrases: brandVoice?.avoidPhrases ?? [],
      },
    };

    const result = await callJson({
      model: CONTENT_MODEL,
      system: systemPrompt(brandVoice?.artistName || "the artist"),
      content: JSON.stringify(ctx, null, 2),
      schema: SUGGESTIONS_SCHEMA,
      toolName: "record_reuse_ideas",
      toolDescription: "Record 2-3 concrete reuse ideas grounded in the top posts.",
      maxTokens: 1200,
      agent: "content",
    });

    return NextResponse.json({ ok: true, suggestions: result.suggestions });
  } catch (e) {
    if (e instanceof AgentError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 400 });
    }
    console.error("insights/reuse failed:", e);
    return NextResponse.json(
      { ok: false, error: "Unexpected error generating reuse ideas." },
      { status: 500 },
    );
  }
}
