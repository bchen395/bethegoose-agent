/**
 * app/api/review/caption-starters/route.ts — FEATURES.md §9 (flagged, default off).
 *
 * When settings.caption_starters_enabled is true, offer 2-3 SHORT opening lines /
 * angles in her voice referencing the attached art. STARTERS, not a draft — the
 * caption field stays empty and required; she still writes the caption. Double-
 * gated: the button is hidden when the flag is off, and this route refuses too.
 * One bounded Haiku call per click; metered by §7 (agent: "content").
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { AgentError, CONTENT_MODEL, callJson, imageBlock } from "@/lib/claude";
import { getBrandVoice, getCalendarSlotByPost, getPost, getSettings } from "@/lib/db";
import { fetchArtBytes } from "@/lib/storage";

export const maxDuration = 60;

const STARTERS_SCHEMA = z.object({
  starters: z
    .array(z.string())
    .min(1)
    .max(3)
    .describe("2-3 short opening lines / angles in her voice, ~12 words or fewer each."),
});

function systemPrompt(artist: string): string {
  return `You are helping ${artist}, a one-person indie art business on Instagram \
(hand-drawn comics, doodles, stickers). She writes her OWN captions — you are NOT \
writing the caption. You only fight the blank page: offer 2-3 SHORT opening lines or \
angles she could start from, in her voice, referencing what's actually in the attached \
art and the slot's theme.

- These are STARTERS, not a finished caption. Keep each to ~12 words or fewer.
- Match \`tone_description\`; sound like her (warm, casual, playful), never salesy, and \
never use any phrase in \`avoid_phrases\`.
- Reference what is genuinely visible in the image — not a generic guess.
- Return 2-3 starters. Call \`record_caption_starters\` exactly once.`;
}

export async function POST(request: Request) {
  // Gate on the flag first — the route is unreachable even if hit directly.
  const settings = await getSettings();
  if (!settings?.captionStartersEnabled) {
    return NextResponse.json({ ok: false, error: "Caption starters are disabled." }, { status: 403 });
  }

  try {
    const body = await request.json().catch(() => ({}) as Record<string, unknown>);
    const postId = Number(body.postId);
    if (!Number.isInteger(postId)) {
      return NextResponse.json({ ok: false, error: "Missing or invalid postId." }, { status: 400 });
    }

    const post = await getPost(postId);
    if (!post) {
      return NextResponse.json({ ok: false, error: "Post not found." }, { status: 404 });
    }
    if (!post.artFilename) {
      return NextResponse.json(
        { ok: false, error: "Attach art before asking for starting lines." },
        { status: 400 },
      );
    }

    const [brandVoice, slot] = await Promise.all([
      getBrandVoice(),
      getCalendarSlotByPost(postId),
    ]);
    const { bytes, mediaType } = await fetchArtBytes(post.artFilename);

    const ctx = {
      slot: { format: post.format, theme: slot?.theme ?? null, content_idea: slot?.contentIdea ?? null },
      brand_voice: {
        artist_name: brandVoice?.artistName ?? null,
        tone_description: brandVoice?.toneDescription ?? null,
        example_captions: brandVoice?.exampleCaptions ?? [],
        avoid_phrases: brandVoice?.avoidPhrases ?? [],
      },
    };

    const result = await callJson({
      model: CONTENT_MODEL,
      system: systemPrompt(brandVoice?.artistName || "the artist"),
      content: [
        imageBlock(bytes, mediaType),
        {
          type: "text" as const,
          text:
            "The image above is the actual artwork for this post. Here is the slot and her voice:\n\n" +
            JSON.stringify(ctx, null, 2),
        },
      ],
      schema: STARTERS_SCHEMA,
      toolName: "record_caption_starters",
      toolDescription: "Record 2-3 short caption starter lines in her voice.",
      maxTokens: 400,
      agent: "content",
    });

    const starters = result.starters.map((s) => s.trim()).filter(Boolean).slice(0, 3);
    return NextResponse.json({ ok: true, starters });
  } catch (e) {
    if (e instanceof AgentError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 400 });
    }
    console.error("review/caption-starters failed:", e);
    return NextResponse.json(
      { ok: false, error: "Unexpected error generating caption starters." },
      { status: 500 },
    );
  }
}
