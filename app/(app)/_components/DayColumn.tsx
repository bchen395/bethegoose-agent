"use client";

import SlotCard from "./SlotCard";
import type { DayMeta, SlotData } from "./calendar-types";

/** One day of the week: its scheduled cards plus a tap-to-add affordance. */
export default function DayColumn({
  day,
  slots,
  onEdit,
  onAdd,
  onToggleDone,
}: {
  day: DayMeta;
  slots: SlotData[];
  onEdit: (slot: SlotData) => void;
  onAdd: (dayIso: string) => void;
  onToggleDone: (id: number, done: boolean) => void;
}) {
  const className = [
    "cal-day",
    day.isToday && "cal-day-today",
    day.isPast && "cal-day-past",
    slots.length === 0 && "cal-day-empty",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={className}>
      <div className="cal-day-head">
        <span className="cal-day-name">{day.name}</span>
        <span className="cal-day-date tabular">{day.dateLabel}</span>
        {day.isToday && <span className="chip chip-must cal-today-tag">today</span>}
      </div>
      {slots.map((s) => (
        <SlotCard key={`${s.kind}-${s.id}`} slot={s} onEdit={onEdit} onToggleDone={onToggleDone} />
      ))}
      <button type="button" className="cal-add" onClick={() => onAdd(day.iso)}>
        ＋ add
      </button>
    </div>
  );
}
