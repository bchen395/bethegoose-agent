import { type InstagramAccount } from "@/lib/db";

/**
 * Settings-page panel for the Instagram connection (Item #1). Read-only status +
 * a connect/reconnect link to the IG OAuth consent screen. The authorize URL is
 * built server-side (so INSTAGRAM_* env stays off the client) and passed in;
 * it's null when the Meta app isn't configured yet.
 */
export default function InstagramConnect({
  account,
  authorizeUrl,
}: {
  account: InstagramAccount | null;
  authorizeUrl: string | null;
}) {
  return (
    <section style={{ marginTop: 28 }}>
      <h2>📸 Instagram</h2>
      <p className="meta">
        Connect your Creator account to auto-pull post metrics and follower count. Posting and
        captions stay manual — this only reads your insights.
      </p>

      {account ? (
        <div className="card">
          <div>
            ✅ Connected{account.username ? ` as @${account.username}` : ""}
            {account.followersCount != null ? ` · ${account.followersCount} followers` : ""}
          </div>
          <div className="meta" style={{ marginTop: 4 }}>
            Last synced: {account.syncedAt ?? "not yet — runs daily, or trigger the sync cron"}
          </div>
          {authorizeUrl && (
            <a className="btn" href={authorizeUrl} style={{ marginTop: 10, display: "inline-block" }}>
              Reconnect
            </a>
          )}
        </div>
      ) : authorizeUrl ? (
        <a className="btn" href={authorizeUrl}>
          Connect Instagram
        </a>
      ) : (
        <p className="muted">
          Instagram app not configured. Set <code>INSTAGRAM_APP_ID</code>,{" "}
          <code>INSTAGRAM_APP_SECRET</code>, and <code>INSTAGRAM_REDIRECT_URI</code> (see DEPLOY.md),
          then reload.
        </p>
      )}
    </section>
  );
}
