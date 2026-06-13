import { NextResponse } from "next/server";

import { generateDraft } from "@/lib/agents/content";
import { AgentError } from "@/lib/claude";

export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}) as Record<string, unknown>);
    const slotId = Number(body.slotId);
    if (!Number.isInteger(slotId)) {
      return NextResponse.json({ ok: false, error: "Missing or invalid slotId." }, { status: 400 });
    }
    const result = await generateDraft(slotId);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof AgentError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 400 });
    }
    console.error("content/generate failed:", e);
    return NextResponse.json(
      { ok: false, error: "Unexpected error generating the draft." },
      { status: 500 },
    );
  }
}
