// Shared types for the interactive calendar board (CalendarBoard + children).

export type { SlotCardData } from "./SlotCard";

/** One day cell in the week, precomputed server-side so the client stays serializable. */
export type DayMeta = {
  iso: string; // YYYY-MM-DD
  name: string; // "Mon"
  dateLabel: string; // "Jun 16"
  isToday: boolean;
  isPast: boolean;
};

/** A reusable idea from the library (the "box"). */
export type IdeaData = {
  id: number;
  title: string;
  format: string | null;
  contentIdea: string | null;
};
