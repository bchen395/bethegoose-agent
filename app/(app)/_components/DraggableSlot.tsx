"use client";

import { useDraggable } from "@dnd-kit/core";

import SlotCard from "./SlotCard";
import type { DayMeta, SlotCardData } from "./calendar-types";

/**
 * A calendar slot with interactive controls: a drag handle (move to another
 * day), a "done" check, a no-drag "Move…" fallback for touch, and an × to
 * unschedule. The card visuals come from the shared SlotCard.
 */
export default function DraggableSlot({
  slot,
  days,
  onToggleDone,
  onUnschedule,
  onMove,
}: {
  slot: SlotCardData;
  days: DayMeta[];
  onToggleDone: (id: number, done: boolean) => void;
  onUnschedule: (id: number) => void;
  onMove: (id: number, dayIso: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `slot:${slot.id}`,
  });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;

  return (
    <div ref={setNodeRef} style={style} className={isDragging ? "slot-wrap dragging" : "slot-wrap"}>
      <div className="slot-controls">
        <button
          type="button"
          className="grip"
          aria-label="Drag to another day"
          {...listeners}
          {...attributes}
        >
          ⠿
        </button>
        <label className="slot-check">
          <input
            type="checkbox"
            checked={Boolean(slot.done)}
            onChange={(e) => onToggleDone(slot.id, e.target.checked)}
          />
          done
        </label>
        <select
          className="slot-move"
          aria-label="Move to a different day"
          value=""
          onChange={(e) => {
            if (e.target.value) onMove(slot.id, e.target.value);
          }}
        >
          <option value="">Move…</option>
          {days.map((d) => (
            <option key={d.iso} value={d.iso} disabled={d.iso === slot.slotDate}>
              {d.name} {d.dateLabel}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="slot-x"
          aria-label="Remove from calendar"
          onClick={() => onUnschedule(slot.id)}
        >
          ×
        </button>
      </div>
      <SlotCard slot={slot} />
    </div>
  );
}
