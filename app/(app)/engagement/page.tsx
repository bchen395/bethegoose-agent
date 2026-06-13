import { getPostsByStatus, getPostsMissingEngagement } from "@/lib/db";
import { signedDisplayUrl } from "@/lib/storage";
import { FORMAT_BADGE, badge } from "../_lib/format";
import MarkPostedButton from "../_components/MarkPostedButton";
import NumbersForm from "../_components/NumbersForm";

async function artUrlFor(key: string | null): Promise<string | null> {
  if (!key) return null;
  try {
    return await signedDisplayUrl(key);
  } catch {
    return null;
  }
}

export default async function EngagementPage() {
  const [approved, missing] = await Promise.all([
    getPostsByStatus("approved"),
    getPostsMissingEngagement(),
  ]);

  const approvedCards = await Promise.all(
    approved.map(async (p) => ({ post: p, artUrl: await artUrlFor(p.artFilename) })),
  );
  const missingCards = await Promise.all(
    missing.map(async (p) => ({ post: p, artUrl: await artUrlFor(p.artFilename) })),
  );

  return (
    <main>
      <h1>📊 Engagement</h1>

      <h2>Ready to post</h2>
      {approvedCards.length === 0 && <p className="muted">Nothing approved right now.</p>}
      {approvedCards.map(({ post, artUrl }) => (
        <div className="card" key={post.id}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
            <div style={{ flex: 1, minWidth: 240 }}>
              <div className="muted" style={{ fontSize: 13 }}>
                {badge(FORMAT_BADGE, post.format)} · approved #{post.id}
              </div>
              {post.postingChecklist ? (
                <pre className="checklist">{post.postingChecklist}</pre>
              ) : (
                <p className="muted">
                  No posting checklist yet — it appears once the Distribution Agent runs.
                </p>
              )}
              {post.caption && (
                <details>
                  <summary>Caption</summary>
                  <p style={{ whiteSpace: "pre-wrap" }}>{post.caption}</p>
                </details>
              )}
              <div style={{ marginTop: 8 }}>
                <MarkPostedButton postId={post.id} />
              </div>
            </div>
            {artUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={artUrl} alt="art" style={{ width: 110, borderRadius: 6 }} />
            )}
          </div>
        </div>
      ))}

      <hr style={{ margin: "20px 0", border: "none", borderTop: "1px solid var(--border)" }} />

      <h2>Enter numbers</h2>
      {missingCards.length === 0 ? (
        <p className="muted">Every posted item has its numbers. 🎉</p>
      ) : (
        missingCards.map(({ post, artUrl }) => (
          <div className="card" key={post.id}>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
              <div style={{ flex: 1, minWidth: 240 }}>
                <div className="muted" style={{ fontSize: 13 }}>
                  {badge(FORMAT_BADGE, post.format)} · posted #{post.id}
                  {post.postedAt ? ` · ${post.postedAt}` : ""}
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
                    likes: post.likes ?? 0,
                    comments: post.comments ?? 0,
                    reach: post.reach ?? 0,
                    saves: post.saves ?? 0,
                  }}
                />
              </div>
              {artUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={artUrl} alt="art" style={{ width: 110, borderRadius: 6 }} />
              )}
            </div>
          </div>
        ))
      )}
    </main>
  );
}
