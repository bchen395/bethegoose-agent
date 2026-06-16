export const FORMAT_BADGE: Record<string, string> = {
  static: "🖼 Static",
  carousel: "🎠 Carousel",
  reel: "🎬 Reel",
  story: "📲 Story",
};

export const STATUS_BADGE: Record<string, string> = {
  draft: "📝 Draft",
  approved: "✅ Approved",
  posted: "📣 Posted",
  discarded: "🗑 Discarded",
};

export const CTA_OPTIONS = ["none", "shop", "snail_mail", "market"];

// Mirror the schema CHECK constraints so the CRUD forms (dropdowns) and server
// actions (validation) share one source of truth. Keep in sync with lib/db/schema.ts.
export const PRODUCT_TYPES = ["print", "sticker", "craft", "snail_mail"];
export const MARKET_STATUSES = ["considering", "applied", "accepted", "rejected", "attended"];
export const WEB_SEARCH_CADENCES = ["weekly", "monthly", "off"];

export function badge(map: Record<string, string>, key: string | null | undefined): string {
  return (key && map[key]) || key || "—";
}
