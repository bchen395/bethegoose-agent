/**
 * app/api/cron/instagram-sync/route.ts — daily Instagram → posts sync (Item #1).
 *
 * Vercel Cron invokes this with `Authorization: Bearer <CRON_SECRET>` (vercel.json).
 * The route is exempt from the auth proxy (it guards itself with the secret).
 *
 * Instagram is the SOURCE of posted rows: there's no in-app draft/caption to match
 * against, so the sync ingests recent media directly as `posts` (status='posted',
 * real published_at, caption, format, permalink), then pulls per-media insights
 * into the five metric columns and snapshots the follower count.
 *
 * Fail-soft: not connected / token / API errors skip the affected step and return
 * 200 — the DB is never left half-written and the manual engagement form keeps
 * working. NOTE: the schedule only fires once deployed; locally, hit this route
 * with the secret header to verify.
 */

import { NextResponse } from "next/server";

import {
  getInstagramAccount,
  getPostByIgMediaId,
  getPostsForStatsSync,
  insertFollowerSnapshot,
  insertPost,
  nowIso,
  updateInstagramAccount,
  updatePost,
} from "@/lib/db";
import { getAccount, getMediaInsights, listRecentMedia, refreshTokenIfNeeded } from "@/lib/instagram";

export const maxDuration = 300;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const account = await getInstagramAccount();
  if (!account) {
    return NextResponse.json(
      { ok: false, error: "Instagram not connected — sync skipped." },
      { status: 200 },
    );
  }

  const token = await refreshTokenIfNeeded(account);

  // 1) Ingest recent media as posted rows (idempotent on ig_media_id).
  let ingested = 0;
  const media = await listRecentMedia(token);
  if (media) {
    for (const m of media) {
      const existing = await getPostByIgMediaId(m.id);
      if (existing) continue;
      await insertPost({
        status: "posted",
        igMediaId: m.id,
        // postedAt mirrors the real IG publish time so existing insights queries
        // (which key on posted_at) stay correct without a rewrite.
        postedAt: m.timestamp,
        publishedAt: m.timestamp,
        caption: m.caption,
        format: m.format,
        permalink: m.permalink,
      });
      ingested++;
    }
  }

  // 2) Pull/refresh metrics for ingested posts (skip metrics IG omits).
  let statsSynced = 0;
  for (const post of await getPostsForStatsSync()) {
    if (!post.igMediaId) continue;
    const insights = await getMediaInsights(token, post.igMediaId);
    if (!insights) continue;
    const fields: Record<string, unknown> = { statsSyncedAt: await nowIso() };
    if (insights.reach != null) fields.reach = insights.reach;
    if (insights.saves != null) fields.saves = insights.saves;
    if (insights.likes != null) fields.likes = insights.likes;
    if (insights.comments != null) fields.comments = insights.comments;
    if (insights.shares != null) fields.shares = insights.shares;
    await updatePost(post.id, fields);
    statsSynced++;
  }

  // 3) Follower count + snapshot.
  let followers: number | null = null;
  const profile = await getAccount(token);
  if (profile) {
    followers = profile.followersCount;
    await updateInstagramAccount({
      username: profile.username ?? account.username,
      followersCount: profile.followersCount ?? account.followersCount,
      syncedAt: await nowIso(),
    });
    if (profile.followersCount != null) await insertFollowerSnapshot(profile.followersCount);
  }

  return NextResponse.json({ ok: true, ingested, statsSynced, followers });
}
