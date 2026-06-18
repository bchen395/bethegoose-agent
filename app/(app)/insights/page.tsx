import {
  INSIGHTS_WINDOW_DAYS,
  getEngagementByFormat,
  getEngagementByWeekday,
  getFollowerTrend,
  getInstagramAccount,
  getSubscriberTrend,
  getSubscribersByCtaType,
  getTopPosts,
} from "@/lib/db";
import ReuseHitsButton from "../_components/ReuseHitsButton";
import { FORMAT_BADGE, badge } from "../_lib/format";

const WINDOW = INSIGHTS_WINDOW_DAYS;

/** Minimal inline sparkline (no client JS) for the follower trend. */
function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return null;
  const w = 220;
  const h = 44;
  const pad = 3;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const pts = points.map((v, i) => {
    const x = pad + (i / (points.length - 1)) * (w - 2 * pad);
    const y = h - pad - ((v - min) / span) * (h - 2 * pad);
    return { x, y };
  });
  const line = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const base = h - pad;
  const area = `${pad.toFixed(1)},${base.toFixed(1)} ${line} ${(w - pad).toFixed(1)},${base.toFixed(1)}`;
  const last = pts[pts.length - 1];
  return (
    <svg
      className="sparkline"
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      aria-hidden
    >
      <polygon className="sparkline-area" points={area} />
      <polyline className="sparkline-line" fill="none" strokeWidth={2} points={line} />
      <circle className="sparkline-dot" cx={last.x} cy={last.y} r={3} />
    </svg>
  );
}

const CTA_LABEL: Record<string, string> = {
  shop: "🛍 Shop",
  snail_mail: "✉️ Snail mail",
  market: "🎪 Market",
  none: "— No CTA",
  unattributed: "❓ Unattributed",
};

export default async function InsightsPage() {
  const [byFormat, byWeekday, top, byCta, trend, followerTrend, instagram] = await Promise.all([
    getEngagementByFormat(WINDOW),
    getEngagementByWeekday(WINDOW),
    getTopPosts(WINDOW, 5),
    getSubscribersByCtaType(WINDOW),
    getSubscriberTrend(WINDOW),
    getFollowerTrend(WINDOW),
    getInstagramAccount(),
  ]);

  const hasPosts = byFormat.length > 0 || top.length > 0;
  // Both queries are sorted by avgScore desc, so the first row is the max.
  const maxFormatScore = byFormat[0]?.avgScore ?? 0;
  const maxWeekdayScore = byWeekday[0]?.avgScore ?? 0;

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
            Nothing to rank yet. Once Instagram syncs a few posts and their numbers, the patterns
            show up here.
          </p>
        </div>
      )}

      <div className="insights-grid">
        {/* --- Format ranking --------------------------------------------- */}
        {byFormat.length > 0 && (
          <section className="card span-2">
            <h2 style={{ marginTop: 0 }}>By format</h2>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Format</th>
                  <th>Posts</th>
                  <th>Score</th>
                  <th>Avg saves</th>
                  <th>Avg shares</th>
                  <th>Avg reach</th>
                </tr>
              </thead>
              <tbody>
                {byFormat.map((f, i) => (
                  <tr key={f.format}>
                    <td>
                      {i === 0 ? "🏆 " : ""}
                      {badge(FORMAT_BADGE, f.format)}
                    </td>
                    <td className="tabular">{f.posts}</td>
                    <td className="tabular">
                      <strong>{f.avgScore}</strong>
                      <span className="bar-track">
                        <span
                          className="bar-fill"
                          style={{
                            width: `${maxFormatScore > 0 ? (f.avgScore / maxFormatScore) * 100 : 0}%`,
                          }}
                        />
                      </span>
                    </td>
                    <td className="tabular">{f.avgSaves}</td>
                    <td className="tabular">{f.avgShares}</td>
                    <td className="tabular">{f.avgReach}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {/* --- Weekday ranking -------------------------------------------- */}
        {byWeekday.length > 0 && (
          <section className="card">
            <h2 style={{ marginTop: 0 }}>By weekday</h2>
            <div className="weekday-bars">
              {byWeekday.map((w, i) => (
                <div key={w.weekday} className="weekday-bar">
                  <span className="weekday-bar-label">
                    {i === 0 ? "⭐ " : ""}
                    {w.label}
                  </span>
                  <span className="bar-track">
                    <span
                      className={`bar-fill${i === 0 ? " bar-fill-top" : ""}`}
                      style={{
                        width: `${maxWeekdayScore > 0 ? (w.avgScore / maxWeekdayScore) * 100 : 0}%`,
                      }}
                    />
                  </span>
                  <span className="weekday-bar-val tabular">{w.avgScore}</span>
                </div>
              ))}
            </div>
            <p className="muted text-xs" style={{ marginBottom: 0 }}>
              Real Instagram publish day, scored by saves + shares.
            </p>
          </section>
        )}

        {/* --- Follower growth (Item #1) ---------------------------------- */}
        {followerTrend.length >= 2 && (
          <section className="card">
            <h2 style={{ marginTop: 0 }}>
              Followers
              {instagram?.followersCount != null ? ` · ${instagram.followersCount}` : ""}
            </h2>
            <Sparkline points={followerTrend.map((s) => s.followersCount)} />
            <p className="muted text-xs" style={{ marginBottom: 0 }}>
              {followerTrend[0].followersCount} →{" "}
              {followerTrend[followerTrend.length - 1].followersCount} over the last {WINDOW} days.
            </p>
          </section>
        )}

        {/* --- Top posts -------------------------------------------------- */}
        {top.length > 0 && (
          <section className="card">
            <h2 style={{ marginTop: 0 }}>Top posts</h2>
            {top.map((post, i) => (
              <div
                key={post.id}
                style={{
                  borderTop: i === 0 ? "none" : "1px solid var(--border)",
                  paddingTop: 10,
                  marginTop: 10,
                }}
              >
                <div className="meta">
                  {i === 0 ? "🥇 " : `#${i + 1} `}
                  {badge(FORMAT_BADGE, post.format)} · score{" "}
                  <strong className="tabular">{post.score}</strong> · posted #{post.id}
                </div>
                {post.caption && (
                  <div className="text-md">
                    {post.caption.slice(0, 140)}
                    {post.caption.length > 140 ? "…" : ""}
                  </div>
                )}
                <div className="muted text-xs tabular">
                  {post.saves ?? 0} saves · {post.shares ?? 0} shares · {post.reach ?? 0} reach ·{" "}
                  {post.likes ?? 0} likes
                  {post.permalink && (
                    <>
                      {" · "}
                      <a href={post.permalink} target="_blank" rel="noreferrer">
                        View on Instagram ↗
                      </a>
                    </>
                  )}
                </div>
              </div>
            ))}
          </section>
        )}

      {/* --- Reuse your hits (§8) ----------------------------------------- */}
      {hasPosts && (
        <section className="card">
          <h2 style={{ marginTop: 0 }}>♻️ Reuse your hits</h2>
          <p className="meta">
            Concrete ways to get more mileage from your top posts — turn a popular doodle into a
            sticker, re-cut a comic as a reel, compile a theme into a carousel.
          </p>
          <ReuseHitsButton />
        </section>
      )}

        {/* --- Subscriber attribution (§4) -------------------------------- */}
        <section className="card span-2">
          <h2 style={{ marginTop: 0 }}>
            Subscribers ({trend.total} in last {WINDOW}d)
          </h2>
          {trend.total === 0 ? (
            <p className="muted" style={{ marginBottom: 0 }}>
              No subscriber signups logged yet. Log them in the Engagement view — converting
              followers to the mailing list is the most durable growth at this size.
            </p>
          ) : (
            <>
              <p className="meta">
                {Object.entries(trend.byChannel)
                  .map(([ch, n]) => `${ch === "snail_mail" ? "snail mail" : ch}: ${n}`)
                  .join(" · ")}
              </p>
              <h3 style={{ marginBottom: 4 }}>Which CTA type converts</h3>
              <table className="data-table" style={{ maxWidth: 360 }}>
                <tbody>
                  {byCta.map((c) => (
                    <tr key={c.ctaType}>
                      <td>{CTA_LABEL[c.ctaType] ?? c.ctaType}</td>
                      <td className="tabular" style={{ textAlign: "right" }}>
                        <strong>{c.subscribers}</strong>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {trend.weekly.length > 0 && (
                <p className="muted text-xs" style={{ marginBottom: 0 }}>
                  Weekly: {trend.weekly.map((w) => `${w.weekStart}: ${w.count}`).join(" · ")}
                </p>
              )}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
