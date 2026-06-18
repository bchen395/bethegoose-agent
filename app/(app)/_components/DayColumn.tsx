"use client";

import { useDroppable } from "@dnd-kit/core";

import DraggableSlot from "./DraggableSlot";
import type { DayMeta, SlotCardData } from "./calendar-types";

/** One droppable day of the week, holding its scheduled slots. */
export default function DayColumn({
  day,
  slots,
  days,
  onToggleDone,
  onUnschedule,
  onMove,
}: {
  day: DayMeta;
  slots: SlotCardData[];
  days: DayMeta[];
  onToggleDone: (id: number, done: boolean) => void;
  onUnschedule: (id: number) => void;
  onMove: (id: number, dayIso: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `day:${day.iso}` });

  const className = [
    "cal-day",
    day.isToday && "cal-day-today",
    day.isPast && "cal-day-past",
    slots.length === 0 && "cal-day-empty",
    isOver && "drop-over",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div ref={setNodeRef} className={className}>
      <div className="cal-day-head">
        <span className="cal-day-name">{day.name}</span>
        <span className="cal-day-date tabular">{day.dateLabel}</span>
        {day.isToday && <span className="chip chip-must cal-today-tag">today</span>}
      </div>
      {slots.length === 0 ? (
        <div className="cal-rest">— drop a post here</div>
      ) : (
        slots.map((s) => (
          <DraggableSlot
            key={s.id}
            slot={s}
            days={days}
            onToggleDone={onToggleDone}
            onUnschedule={onUnschedule}
            onMove={onMove}
          />
        ))
      )}
    </div>
  );
}
