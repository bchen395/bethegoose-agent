import {
  INSIGHTS_WINDOW_DAYS,
  getEngagementByFormat,
  getEngagementByWeekday,
  getSubscriberTrend,
  getSubscribersByCtaType,
  getTopPosts,
} from "@/lib/db";
import { signedDisplayUrl } from "@/lib/storage";
import ReuseHitsButton from "../_components/ReuseHitsButton";
import { FORMAT_BADGE, badge } from "../_lib/format";

const WINDOW = INSIGHTS_WINDOW_DAYS;

async function artUrlFor(key: string | null): Promise<string | null> {
  if (!key) return null;
  try {
    return await signedDisplayUrl(key);
  } catch {
    return null;
  }
}

const CTA_LABEL: Record<string, string> = {
  shop: "🛍 Shop",
  snail_mail: "✉️ Snail mail",
  market: "🎪 Market",
  none: "— No CTA",
  unattributed: "❓ Unattributed",
};

export default async function InsightsPage() {
  const [byFormat, byWeekday, topRaw, byCta, trend] = await Promise.all([
    getEngagementByFormat(WINDOW),
    getEngagementByWeekday(WINDOW),
    getTopPosts(WINDOW, 5),
    getSubscribersByCtaType(WINDOW),
    getSubscriberTrend(WINDOW),
  ]);

  const top = await Promise.all(
    topRaw.map(async (p) => ({ post: p, artUrl: await artUrlFor(p.artFilename) })),
  );

  const hasPosts = byFormat.length > 0 || top.length > 0;

  return (
    <main>
      <h1>💡 What&apos;s working</h1>
      <p className="muted">
        Ranked by a saves-and-shares score over the last {WINDOW} days — not likes. Score ={" "}
        <code>3·shares + 2·saves + comments + 0.25·likes</code>, divided by reach when known.
      </p>

      {!hasPosts && (
        <div className="card">
          <p className="muted">
            Nothing to rank yet. Post a few things and enter their numbers in the Engagement view —
            the patterns show up here once there&apos;s data.
          </p>
        </div>
      )}

      {/* --- Format ranking ----------------------------------------------- */}
      {byFormat.length > 0 && (
        <section className="card">
          <h2 style={{ marginTop: 0 }}>By format</h2>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr className="muted" style={{ textAlign: "left" }}>
                <th style={{ padding: "4px 8px 4px 0" }}>Format</th>
                <th style={{ padding: 4 }}>Posts</th>
                <th style={{ padding: 4 }}>Score</th>
                <th style={{ padding: 4 }}>Avg saves</th>
                <th style={{ padding: 4 }}>Avg shares</th>
                <th style={{ padding: 4 }}>Avg reach</th>
              </tr>
            </thead>
            <tbody>
              {byFormat.map((f, i) => (
                <tr key={f.format} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={{ padding: "6px 8px 6px 0" }}>
                    {i === 0 ? "🏆 " : ""}
                    {badge(FORMAT_BADGE, f.format)}
                  </td>
                  <td style={{ padding: 4 }}>{f.posts}</td>
                  <td style={{ padding: 4 }}>
                    <strong>{f.avgScore}</strong>
                  </td>
                  <td style={{ padding: 4 }}>{f.avgSaves}</td>
                  <td style={{ padding: 4 }}>{f.avgShares}</td>
                  <td style={{ padding: 4 }}>{f.avgReach}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* --- Weekday ranking ---------------------------------------------- */}
      {byWeekday.length > 0 && (
        <section className="card">
          <h2 style={{ marginTop: 0 }}>By weekday</h2>
          <div className="row">
            {byWeekday.map((w, i) => (
              <div
                key={w.weekday}
                className="card"
                style={{ margin: 0, minWidth: 92, textAlign: "center" }}
              >
                <div style={{ fontWeight: 600 }}>
                  {i === 0 ? "⭐ " : ""}
                  {w.label}
                </div>
                <div style={{ fontSize: 20 }}>{w.avgScore}</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {w.posts} post{w.posts === 1 ? "" : "s"}
                </div>
              </div>
            ))}
          </div>
          <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
            Weekday of when posts went out, scored by saves + shares. No time-of-day ranking —
            a sub-1K account has no reliable publish-time signal.
          </p>
        </section>
      )}

      {/* --- Top posts ---------------------------------------------------- */}
      {top.length > 0 && (
        <section className="card">
          <h2 style={{ marginTop: 0 }}>Top posts</h2>
          {top.map(({ post, artUrl }, i) => (
            <div
              key={post.id}
              className="row"
              style={{ alignItems: "flex-start", borderTop: i === 0 ? "none" : "1px solid var(--border)", paddingTop: 10, marginTop: 10 }}
            >
              {artUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={artUrl} alt="art" style={{ width: 72, borderRadius: 6 }} />
              )}
              <div style={{ flex: 1, minWidth: 200 }}>
                <div className="muted" style={{ fontSize: 13 }}>
                  {i === 0 ? "🥇 " : `#${i + 1} `}
                  {badge(FORMAT_BADGE, post.format)} · score <strong>{post.score}</strong> · posted #
                  {post.id}
                </div>
                {post.caption && (
                  <div style={{ fontSize: 14 }}>
                    {post.caption.slice(0, 140)}
                    {post.caption.length > 140 ? "…" : ""}
                  </div>
                )}
                <div className="muted" style={{ fontSize: 12 }}>
                  {post.saves ?? 0} saves · {post.shares ?? 0} shares · {post.reach ?? 0} reach ·{" "}
                  {post.likes ?? 0} likes
                </div>
              </div>
            </div>
          ))}
        </section>
      )}

      {/* --- Reuse your hits (§8) ----------------------------------------- */}
      {hasPosts && (
        <section className="card">
          <h2 style={{ marginTop: 0 }}>♻️ Reuse your hits</h2>
          <p className="muted" style={{ fontSize: 13 }}>
            Concrete ways to get more mileage from your top posts — turn a popular doodle into a
            sticker, re-cut a comic as a reel, compile a theme into a carousel.
          </p>
          <ReuseHitsButton />
        </section>
      )}

      {/* --- Subscriber attribution (§4) ---------------------------------- */}
      <section className="card">
        <h2 style={{ marginTop: 0 }}>Subscribers ({trend.total} in last {WINDOW}d)</h2>
        {trend.total === 0 ? (
          <p className="muted" style={{ marginBottom: 0 }}>
            No subscriber signups logged yet. Log them in the Engagement view — converting followers
            to the mailing list is the most durable growth at this size.
          </p>
        ) : (
          <>
            <p className="muted" style={{ fontSize: 13 }}>
              {Object.entries(trend.byChannel)
                .map(([ch, n]) => `${ch === "snail_mail" ? "snail mail" : ch}: ${n}`)
                .join(" · ")}
            </p>
            <h3 style={{ marginBottom: 4 }}>Which CTA type converts</h3>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14, maxWidth: 360 }}>
              <tbody>
                {byCta.map((c) => (
                  <tr key={c.ctaType} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={{ padding: "6px 8px 6px 0" }}>{CTA_LABEL[c.ctaType] ?? c.ctaType}</td>
                    <td style={{ padding: 6, textAlign: "right" }}>
                      <strong>{c.subscribers}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {trend.weekly.length > 0 && (
              <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
                Weekly: {trend.weekly.map((w) => `${w.weekStart}: ${w.count}`).join(" · ")}
              </p>
            )}
          </>
        )}
      </section>
    </main>
  );
}
