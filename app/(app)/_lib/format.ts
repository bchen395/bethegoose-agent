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

export function badge(map: Record<string, string>, key: string | null | undefined): string {
  return (key && map[key]) || key || "—";
}
