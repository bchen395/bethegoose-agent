/**
 * lib/calendar/template.ts — a deterministic default weekly layout.
 *
 * When a week has no plan yet, this spreads settings.weeklyMix across the week's
 * weekdays so the user starts from a sensible arrangement they can drag around,
 * rather than a blank calendar. No agent call, no web search — instant + offline.
 * The seeded slots are left un-pinned, so a later Strategy Agent run replaces them.
 */

import { DateTime } from "luxon";

import type { Settings, SlotInput } from "@/lib/db";

const FORMAT_THEME: Record<string, string> = {
  reel: "Process reel",
  carousel: "Mini story",
  static: "Showcase",
  story: "Behind the scenes",
};

const FORMAT_IDEA: Record<string, string> = {
  reel: "Short reel — a quick studio moment or a piece coming together.",
  carousel: "Carousel — a few frames telling one small story (steps, before/after, or a series).",
  static: "Single image — your strongest recent piece, well lit.",
  story: "Story — a casual behind-the-scenes or a quick poll/question.",
};

// Days to fill first, spread across the week, then trimmed to the post count and
// re-sorted chronologically. Offsets are 0 = Mon … 6 = Sun.
const PREFERRED_OFFSETS = [0, 2, 4, 5, 1, 3, 6];

/** Round-robin a {format: count} mix into a flat list that alternates formats. */
function expandMix(mix: Record<string, number>): string[] {
  const entries = Object.entries(mix)
    .map(([format, count]) => ({ format, count: Math.max(0, Math.floor(Number(count) || 0)) }))
    .filter((e) => e.count > 0);
  const out: string[] = [];
  let added = true;
  while (added) {
    added = false;
    for (const e of entries) {
      if (e.count > 0) {
        out.push(e.format);
        e.count -= 1;
        added = true;
      }
    }
  }
  return out;
}

/**
 * The default arrangement for a week: one SlotInput per planned post, spread
 * across the week's days at the configured default post time.
 */
export function defaultWeekTemplate(weekStart: string, settings: Settings): SlotInput[] {
  const monday = DateTime.fromISO(weekStart).startOf("day");
  const mix = settings.weeklyMix && Object.keys(settings.weeklyMix).length > 0
    ? settings.weeklyMix
    : { reel: 1, carousel: 1, static: 1 };
  const formats = expandMix(mix);
  const time = settings.defaultPostTime || "12:00";

  const n = Math.min(formats.length, PREFERRED_OFFSETS.length);
  const offsets = PREFERRED_OFFSETS.slice(0, n).sort((a, b) => a - b);

  return offsets.map((offset, i) => {
    const format = formats[i];
    return {
      slotDate: monday.plus({ days: offset }).toISODate()!,
      slotTime: time,
      format,
      theme: FORMAT_THEME[format] ?? "Post",
      contentIdea: FORMAT_IDEA[format] ?? "",
      priority: 2,
    };
  });
}
