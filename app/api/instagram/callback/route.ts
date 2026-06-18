/**
 * app/api/instagram/callback/route.ts — OAuth redirect target for "Connect
 * Instagram" (Item #1). Exchanges the `code` for a long-lived token and stores
 * the connection (id = 1), seeding username/followers from the profile.
 *
 * Auth: unlike /api/cron, this route is NOT exempt in proxy.ts, so the session
 * proxy already gated it to a logged-in, allow-listed admin — reaching here means
 * the owner initiated the connect. (If a deployment ever shows Meta's top-level
 * redirect dropping the Supabase cookie and bouncing to /login, harden with a
 * `state` nonce cookie set at connect time and exempt this path in proxy.ts.)
 *
 * Fail-soft: any error redirects back to /settings?ig=error rather than 500ing.
 */

import { NextResponse } from "next/server";

import { insertFollowerSnapshot, upsertInstagramAccount } from "@/lib/db";
import { exchangeCodeForToken, getAccount } from "@/lib/instagram";

export const maxDuration = 60;

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const error = searchParams.get("error");

  if (error || !code) {
    return NextResponse.redirect(`${origin}/settings?ig=error`);
  }

  const token = await exchangeCodeForToken(code);
  if (!token) {
    return NextResponse.redirect(`${origin}/settings?ig=error`);
  }

  // Best-effort profile seed (followers + username) before the first sync.
  const profile = await getAccount(token.accessToken);
  await upsertInstagramAccount({
    igUserId: profile?.igUserId || token.igUserId,
    username: profile?.username ?? null,
    accessToken: token.accessToken,
    tokenExpiresAt: token.expiresAt,
    followersCount: profile?.followersCount ?? null,
    syncedAt: null,
  });
  if (profile?.followersCount != null) {
    await insertFollowerSnapshot(profile.followersCount);
  }

  return NextResponse.redirect(`${origin}/settings?ig=connected`);
}
