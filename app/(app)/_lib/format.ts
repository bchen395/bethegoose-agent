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

// Post formats — the shared vocabulary for the calendar, idea library, and the
// new-idea form dropdown. Mirrors the schema CHECK constraints (posts/calendar/
// post_ideas). Keep in sync with lib/db/schema.ts.
export const FORMATS = ["reel", "carousel", "static", "story"];

// Mirror the schema CHECK constraints so the CRUD forms (dropdowns) and server
// actions (validation) share one source of truth. Keep in sync with lib/db/schema.ts.
export const PRODUCT_TYPES = ["print", "sticker", "craft", "snail_mail"];
export const MARKET_STATUSES = ["considering", "applied", "accepted", "rejected", "attended"];
export const WEB_SEARCH_CADENCES = ["weekly", "monthly", "off"];

// Human labels for the CRUD forms and the read rows — one source for both.
export const TYPE_LABELS: Record<string, string> = {
  print: "Print",
  sticker: "Sticker",
  craft: "Craft",
  snail_mail: "Snail mail",
};

export const STATUS_LABELS: Record<string, string> = {
  considering: "Considering",
  applied: "Applied",
  accepted: "Accepted",
  rejected: "Rejected",
  attended: "Attended",
};

// Maps a market status to a chip variant class (defined in globals.css).
export const STATUS_CHIP: Record<string, string> = {
  considering: "chip-muted",
  applied: "chip-accent",
  accepted: "chip-ok",
  rejected: "chip-danger",
  attended: "chip-ok",
};

export function badge(map: Record<string, string>, key: string | null | undefined): string {
  return (key && map[key]) || key || "—";
}
