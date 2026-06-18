/**
 * lib/instagram.ts — server-only Instagram API client (Item #1 stats auto-pull).
 *
 * Reading your OWN account's media + insights via the "Instagram API with
 * Instagram Login" (the replacement for the deprecated Basic Display API). Needs
 * a Professional/Creator account and a long-lived token (stored in
 * instagram_account, refreshed by the daily cron). This module only READS from
 * Instagram — it never publishes (posting stays manual by design).
 *
 * Fail-soft like lib/shop.ts: every call returns null / [] on a missing-config,
 * network, or API error so a sync can no-op and the manual engagement form stays
 * intact. Metric availability varies by media type (feed vs reel vs carousel), so
 * an absent metric degrades to null rather than throwing.
 *
 * Env: INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET, INSTAGRAM_REDIRECT_URI. The access
 * token + ig user id live in the DB (written by the OAuth callback), not in env.
 */

import { DateTime } from "luxon";

import { updateInstagramAccount, type InstagramAccount } from "@/lib/db";

const GRAPH = "https://graph.instagram.com";
const OAUTH = "https://api.instagram.com";

/** Scopes: read profile/media basics + media insights. (No content-publish.) */
export const IG_SCOPES = "instagram_business_basic,instagram_business_manage_insights";

export type TokenResult = {
  accessToken: string;
  igUserId: string;
  expiresAt: string | null; // ISO; ~60 days out for a long-lived token
};

export type IgMedia = {
  id: string;
  caption: string | null;
  format: string | null; // mapped to our posts.format enum
  permalink: string | null;
  timestamp: string | null; // ISO publish time (the real one)
};

export type IgInsights = {
  reach: number | null;
  saves: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
};

export type IgAccountInfo = {
  igUserId: string;
  username: string | null;
  followersCount: number | null;
  mediaCount: number | null;
};

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return `HTTP ${res.status}`;
  }
}

/**
 * IG media_type/media_product_type → our format enum (static|carousel|reel|story).
 * Keep CHECK-safe: any video surfaces as "reel" (our only video bucket), unknown
 * types fall back to "static". Stories aren't returned by /me/media.
 */
function mapFormat(mediaType?: string, productType?: string): string | null {
  if (productType === "REELS") return "reel";
  switch (mediaType) {
    case "IMAGE":
      return "static";
    case "CAROUSEL_ALBUM":
      return "carousel";
    case "VIDEO":
      return "reel";
    default:
      return "static";
  }
}

/**
 * Build the authorize URL the "Connect Instagram" button points at. Returns null
 * when the Meta app isn't configured (the button then shows a setup hint).
 */
export function authorizeUrl(state?: string): string | null {
  const appId = process.env.INSTAGRAM_APP_ID;
  const redirect = process.env.INSTAGRAM_REDIRECT_URI;
  if (!appId || !redirect) return null;
  const u = new URL("https://www.instagram.com/oauth/authorize");
  u.searchParams.set("client_id", appId);
  u.searchParams.set("redirect_uri", redirect);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", IG_SCOPES);
  if (state) u.searchParams.set("state", state);
  return u.toString();
}

/**
 * Exchange the OAuth `code` for a long-lived (~60-day) token + the ig user id.
 * code → short-lived token (POST /oauth/access_token) → long-lived
 * (GET /access_token?grant_type=ig_exchange_token). Null on any failure.
 */
export async function exchangeCodeForToken(code: string): Promise<TokenResult | null> {
  const appId = process.env.INSTAGRAM_APP_ID;
  const appSecret = process.env.INSTAGRAM_APP_SECRET;
  const redirect = process.env.INSTAGRAM_REDIRECT_URI;
  if (!appId || !appSecret || !redirect) {
    console.warn("instagram: INSTAGRAM_APP_ID/SECRET/REDIRECT_URI not set — cannot connect.");
    return null;
  }
  try {
    const form = new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      grant_type: "authorization_code",
      redirect_uri: redirect,
      code,
    });
    const shortRes = await fetch(`${OAUTH}/oauth/access_token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    if (!shortRes.ok) {
      console.error("instagram: short-token exchange failed:", await safeText(shortRes));
      return null;
    }
    const shortJson = (await shortRes.json()) as { access_token?: string; user_id?: number | string };
    const shortToken = shortJson.access_token;
    const userId = shortJson.user_id != null ? String(shortJson.user_id) : null;
    if (!shortToken || !userId) return null;

    const longUrl = new URL(`${GRAPH}/access_token`);
    longUrl.searchParams.set("grant_type", "ig_exchange_token");
    longUrl.searchParams.set("client_secret", appSecret);
    longUrl.searchParams.set("access_token", shortToken);
    const longRes = await fetch(longUrl);
    if (!longRes.ok) {
      console.error("instagram: long-token exchange failed:", await safeText(longRes));
      return null;
    }
    const longJson = (await longRes.json()) as { access_token?: string; expires_in?: number };
    const accessToken = longJson.access_token ?? shortToken;
    const expiresAt =
      longJson.expires_in != null
        ? DateTime.now().plus({ seconds: longJson.expires_in }).toISO()
        : null;
    return { accessToken, igUserId: userId, expiresAt };
  } catch (e) {
    console.error("instagram: token exchange error:", e);
    return null;
  }
}

/**
 * Refresh the long-lived token when it's within ~7 days of expiry, writing the
 * new token back to the connection row. Returns the token to use right now
 * (refreshed or current). Fail-soft: returns the current token on any error.
 */
export async function refreshTokenIfNeeded(account: InstagramAccount): Promise<string> {
  try {
    if (account.tokenExpiresAt) {
      const expires = DateTime.fromISO(account.tokenExpiresAt);
      if (expires.isValid && expires.diffNow("days").days > 7) return account.accessToken;
    }
    const url = new URL(`${GRAPH}/refresh_access_token`);
    url.searchParams.set("grant_type", "ig_refresh_token");
    url.searchParams.set("access_token", account.accessToken);
    const res = await fetch(url);
    if (!res.ok) {
      console.error("instagram: token refresh failed:", await safeText(res));
      return account.accessToken;
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    const newToken = json.access_token ?? account.accessToken;
    const expiresAt =
      json.expires_in != null
        ? DateTime.now().plus({ seconds: json.expires_in }).toISO()
        : account.tokenExpiresAt;
    await updateInstagramAccount({ accessToken: newToken, tokenExpiresAt: expiresAt });
    return newToken;
  } catch (e) {
    console.error("instagram: token refresh error:", e);
    return account.accessToken;
  }
}

type RawMedia = {
  id: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  permalink?: string;
  timestamp?: string;
};

/** Most recent media (newest first), mapped to our shape. Null on failure. */
export async function listRecentMedia(accessToken: string, limit = 25): Promise<IgMedia[] | null> {
  try {
    const url = new URL(`${GRAPH}/me/media`);
    url.searchParams.set("fields", "id,caption,media_type,media_product_type,permalink,timestamp");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("access_token", accessToken);
    const res = await fetch(url);
    if (!res.ok) {
      console.error("instagram: /me/media failed:", await safeText(res));
      return null;
    }
    const json = (await res.json()) as { data?: RawMedia[] };
    return (json.data ?? []).map((m) => ({
      id: m.id,
      caption: m.caption?.trim() || null,
      format: mapFormat(m.media_type, m.media_product_type),
      permalink: m.permalink ?? null,
      timestamp: m.timestamp ?? null,
    }));
  } catch (e) {
    console.error("instagram: listRecentMedia error:", e);
    return null;
  }
}

type RawInsight = {
  name: string;
  values?: Array<{ value?: number }>;
  total_value?: { value?: number };
};

/**
 * Per-media insights mapped to our five metric columns (IG's `saved` → saves).
 * Any metric absent for the media type comes back null (the manual form fills
 * gaps). Returns null only when the whole call fails.
 */
export async function getMediaInsights(
  accessToken: string,
  igMediaId: string,
): Promise<IgInsights | null> {
  try {
    const url = new URL(`${GRAPH}/${igMediaId}/insights`);
    url.searchParams.set("metric", "reach,saved,likes,comments,shares,total_interactions");
    url.searchParams.set("access_token", accessToken);
    const res = await fetch(url);
    if (!res.ok) {
      // A 400 here usually means a metric isn't valid for this media type — not
      // fatal. Degrade to null; the manual override still works.
      console.warn(`instagram: insights ${igMediaId} unavailable:`, await safeText(res));
      return null;
    }
    const json = (await res.json()) as { data?: RawInsight[] };
    const byName: Record<string, number> = {};
    for (const m of json.data ?? []) {
      const v = m.values?.[0]?.value ?? m.total_value?.value;
      if (typeof v === "number") byName[m.name] = v;
    }
    const num = (k: string): number | null => (k in byName ? byName[k] : null);
    return {
      reach: num("reach"),
      saves: num("saved"),
      likes: num("likes"),
      comments: num("comments"),
      shares: num("shares"),
    };
  } catch (e) {
    console.error("instagram: getMediaInsights error:", e);
    return null;
  }
}

/** Account profile: username + follower/media counts. Null on failure. */
export async function getAccount(accessToken: string): Promise<IgAccountInfo | null> {
  try {
    const url = new URL(`${GRAPH}/me`);
    url.searchParams.set("fields", "user_id,username,followers_count,media_count");
    url.searchParams.set("access_token", accessToken);
    const res = await fetch(url);
    if (!res.ok) {
      console.error("instagram: /me failed:", await safeText(res));
      return null;
    }
    const json = (await res.json()) as {
      user_id?: string | number;
      username?: string;
      followers_count?: number;
      media_count?: number;
    };
    return {
      igUserId: json.user_id != null ? String(json.user_id) : "",
      username: json.username ?? null,
      followersCount: typeof json.followers_count === "number" ? json.followers_count : null,
      mediaCount: typeof json.media_count === "number" ? json.media_count : null,
    };
  } catch (e) {
    console.error("instagram: getAccount error:", e);
    return null;
  }
}
