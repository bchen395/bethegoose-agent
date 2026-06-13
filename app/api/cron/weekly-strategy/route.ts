/**
 * app/api/cron/weekly-strategy/route.ts — Monday-morning weekly plan.
 *
 * Vercel Cron invokes this with `Authorization: Bearer <CRON_SECRET>`. The route
 * is exempt from the auth middleware (it guards itself with the secret). It runs
 * the Strategy Agent for the current week (idempotent — replaces unattached slots).
 *
 * NOTE: the schedule only fires once deployed to Vercel (vercel.json). Locally,
 * hit this route manually with the secret header to verify. The "Run weekly plan
 * now" button is the manual fallback.
 */

import { NextResponse } from "next/server";

import { runWeeklyPlan } from "@/lib/agents/strategy";
import { AgentError } from "@/lib/claude";

export const maxDuration = 300;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    // runWeeklyPlan() with no arg defaults to this week's Monday (settings.timezone).
    const result = await runWeeklyPlan();
    return NextResponse.json({
      ok: true,
      weekStart: result.weekStart,
      rowIds: result.rowIds,
      slots: result.slots.length,
    });
  } catch (e) {
    if (e instanceof AgentError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
    }
    console.error("cron weekly-strategy failed:", e);
    return NextResponse.json({ ok: false, error: "Unexpected error" }, { status: 500 });
  }
}
