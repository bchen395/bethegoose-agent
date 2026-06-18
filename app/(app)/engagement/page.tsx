import Link from "next/link";

import { getPostsMissingEngagement, getRecentPosted, type Post } from "@/lib/db";
import { FORMAT_BADGE, badge } from "../_lib/format";
import NumbersForm from "../_components/NumbersForm";
import SubscriberForm, { type PostOption } from "../_components/SubscriberForm";

/** Build a compact picker label for a posted post. */
function postLabel(post: { id: number; format: string | null; caption: string | null }): string {
  const fmt = (post.format && FORMAT_BADGE[post.format]) || post.format || "post";
  const cap = post.caption ? ` — ${post.caption.slice(0, 40)}${post.caption.length > 40 ? "…" : ""}` : "";
  return `#${post.id} ${fmt}${cap}`;
}

/** Posted date, preferring the real IG publish time. */
function postedOn(post: Post): string | null {
  const ts = post.publishedAt ?? post.postedAt;
  return ts ? ts.slice(0, 10) : null;
}

function metricLine(post: Post): string {
  const cell = (label: string, v: number | null) => `${label} ${v ?? "—"}`;
  return [
    cell("reach", post.reach),
    cell("saves", post.saves),
    cell("shares", post.shares),
    cell("likes", post.likes),
    cell("comments", post.comments),
  ].join("  ·  ");
}

export default async function EngagementPage() {
  const [recentPosted, missing] = await Promise.all([
    getRecentPosted(20),
    getPostsMissingEngagement(),
  ]);

  const postOptions: PostOption[] = recentPosted.map((p) => ({ id: p.id, label: postLabel(p) }));

  return (
    <main>
      <h1>📊 Engagement</h1>
      <p className="muted">
        Posts and their numbers sync from Instagram daily — no typing needed. The form lower down is
        a manual fallback for anything the API didn&apos;t return.
      </p>

      <h2>Recent posts</h2>
      {recentPosted.length === 0 ? (
        <p className="muted">
          No posts synced yet. Connect Instagram in <Link href="/settings">Settings</Link>; the daily
          sync then pulls your recent posts and their metrics.
        </p>
      ) : (
        recentPosted.map((post) => (
          <div className="card" key={post.id}>
            <div className="muted" style={{ fontSize: 13 }}>
              {badge(FORMAT_BADGE, post.format)} · #{post.id}
              {postedOn(post) ? ` · ${postedOn(post)}` : ""}
              {post.statsSyncedAt ? " · synced from Instagram ✓" : ""}
            </div>
            {post.caption && (
              <p style={{ fontSize: 14, whiteSpace: "pre-wrap" }}>
                {post.caption.slice(0, 180)}
                {post.caption.length > 180 ? "…" : ""}
              </p>
            )}
            <div className="muted" style={{ fontSize: 13 }}>{metricLine(post)}</div>
            {post.permalink && (
              <a href={post.permalink} target="_blank" rel="noreferrer" style={{ fontSize: 13 }}>
                View on Instagram ↗
              </a>
            )}
          </div>
        ))
      )}

      <hr style={{ margin: "20px 0", border: "none", borderTop: "1px solid var(--border)" }} />

      <h2>Enter numbers (manual fallback)</h2>
      {missing.length === 0 ? (
        <p className="muted">Every posted item has its numbers. 🎉</p>
      ) : (
        missing.map((post) => (
          <div className="card" key={post.id}>
            <div className="muted" style={{ fontSize: 13 }}>
              {badge(FORMAT_BADGE, post.format)} · posted #{post.id}
              {postedOn(post) ? ` · ${postedOn(post)}` : ""}
            </div>
            {post.caption && (
              <p className="muted" style={{ fontSize: 13 }}>
                {post.caption.slice(0, 120)}
                {post.caption.length > 120 ? "…" : ""}
              </p>
            )}
            <NumbersForm
              postId={post.id}
              initial={{
                saves: post.saves,
                reach: post.reach,
                likes: post.likes,
                comments: post.comments,
                shares: post.shares,
              }}
            />
          </div>
        ))
      )}

      <hr style={{ margin: "20px 0", border: "none", borderTop: "1px solid var(--border)" }} />

      <h2>Subscribers</h2>
      <SubscriberForm posts={postOptions} />
      <p className="muted" style={{ fontSize: 13 }}>
        See which CTA types convert in the <Link href="/insights">Insights view</Link>.
      </p>
    </main>
  );
}
