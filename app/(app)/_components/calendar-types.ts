// Shared types for the simplified calendar (CalendarBoard + children).

/** One day cell in the week, precomputed server-side so the client stays serializable. */
export type DayMeta = {
  iso: string; // YYYY-MM-DD
  name: string; // "Mon"
  dateLabel: string; // "Jun 16"
  isToday: boolean;
  isPast: boolean;
};

/**
 * One card on the calendar, unified across the two stores:
 *   - kind "slot": a scheduled post (a `calendar` row, has a slotDate).
 *   - kind "idea": an unscheduled idea (a `post_ideas` row, slotDate null).
 * The card looks the same either way; only the editor's save path differs.
 */
export type SlotData = {
  kind: "slot" | "idea";
  id: number;
  slotDate: string | null; // YYYY-MM-DD when scheduled; null = unscheduled
  slotTime: string | null;
  format: string | null;
  theme: string | null; // an idea's title maps here
  contentIdea: string | null;
  priority: number | null; // slots only (1 = must-post, 2 = nice to have)
  done: boolean; // slots only
  fromAgent: boolean; // un-touched agent suggestion → shows a small badge
};
