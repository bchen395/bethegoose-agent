"use client";

import { FORMAT_BADGE, badge } from "../_lib/format";
import type { SlotData } from "./calendar-types";

/**
 * One unified calendar card — a scheduled slot or an unscheduled idea. Tap it
 * (when onEdit is given) to open the editor. Slots also get an inline "done"
 * check that toggles without opening the editor.
 */
export default function SlotCard({
  slot,
  onEdit,
  onToggleDone,
}: {
  slot: SlotData;
  onEdit?: (slot: SlotData) => void;
  onToggleDone?: (id: number, done: boolean) => void;
}) {
  const showDone = slot.kind === "slot" && !!onToggleDone;

  return (
    <div
      className={`slot${slot.done ? " slot-done" : ""}${onEdit ? " slot-tappable" : ""}`}
      role={onEdit ? "button" : undefined}
      tabIndex={onEdit ? 0 : undefined}
      onClick={onEdit ? () => onEdit(slot) : undefined}
      onKeyDown={
        onEdit
          ? (e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onEdit(slot);
              }
            }
          : undefined
      }
    >
      <div className="slot-tags">
        {slot.format && (
          <span className={`chip chip-fmt-${slot.format}`}>{badge(FORMAT_BADGE, slot.format)}</span>
        )}
        {slot.kind === "slot" && (
          <span className={slot.priority === 1 ? "chip chip-must" : "chip chip-nice"}>
            {slot.priority === 1 ? "must-post" : "nice to have"}
          </span>
        )}
        {slot.fromAgent && <span className="chip chip-accent">🧠 agent</span>}
        {slot.slotTime && <span className="meta tabular slot-time">{slot.slotTime}</span>}
      </div>
      {slot.theme && <div className="slot-theme">{slot.theme}</div>}
      {slot.contentIdea && <div className="text-sm">{slot.contentIdea}</div>}
      {showDone && (
        <label
          className="slot-check"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={slot.done}
            onChange={(e) => onToggleDone!(slot.id, e.target.checked)}
          />
          done
        </label>
      )}
    </div>
  );
}
