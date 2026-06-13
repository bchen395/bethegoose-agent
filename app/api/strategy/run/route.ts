import { NextResponse } from "next/server";

import { runWeeklyPlan } from "@/lib/agents/strategy";
import { AgentError } from "@/lib/claude";

export const maxDuration = 300; // the weekly Sonnet run + web search can be slow (Pro)

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}) as Record<string, unknown>);
    const weekStart = typeof body.weekStart === "string" ? body.weekStart : undefined;
    const result = await runWeeklyPlan(weekStart);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof AgentError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 400 });
    }
    console.error("strategy/run failed:", e);
    return NextResponse.json(
      { ok: false, error: "Unexpected error running the weekly plan." },
      { status: 500 },
    );
  }
}
