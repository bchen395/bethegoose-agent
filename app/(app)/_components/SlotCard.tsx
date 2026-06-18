import { FORMAT_BADGE, badge } from "../_lib/format";

/**
 * A weekly-plan slot: when to post, what format, and the theme/idea. On the
 * interactive calendar it can be dragged, marked done, and unscheduled; those
 * controls are layered on by DraggableSlot, so this stays a pure presentational
 * card (the `done` flag only changes how it reads).
 */
export type SlotCardData = {
  id: number;
  slotDate: string;
  slotTime: string | null;
  format: string | null;
  theme: string | null;
  contentIdea: string | null;
  priority: number | null;
  done?: boolean;
};

export default function SlotCard({ slot }: { slot: SlotCardData }) {
  return (
    <div className={slot.done ? "slot slot-done" : "slot"}>
      <div className="slot-tags">
        {slot.format && (
          <span className={`chip chip-fmt-${slot.format}`}>{badge(FORMAT_BADGE, slot.format)}</span>
        )}
        <span className={slot.priority === 1 ? "chip chip-must" : "chip chip-nice"}>
          {slot.priority === 1 ? "must-post" : "nice to have"}
        </span>
        {slot.slotTime && <span className="meta tabular slot-time">{slot.slotTime}</span>}
      </div>
      {slot.theme && <div className="slot-theme">{slot.theme}</div>}
      {slot.contentIdea && <div className="text-sm">{slot.contentIdea}</div>}
    </div>
  );
}
