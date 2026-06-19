"use client";

import SlotCard from "./SlotCard";
import type { SlotData } from "./calendar-types";

/**
 * The unscheduled "Ideas" band above the week grid. These persist across weeks;
 * tap one to edit or give it a day, or add a new one.
 */
export default function UnscheduledArea({
  slots,
  onEdit,
  onAdd,
}: {
  slots: SlotData[];
  onEdit: (slot: SlotData) => void;
  onAdd: () => void;
}) {
  return (
    <section className="cal-unscheduled">
      <div className="cal-unscheduled-head">
        <h2 className="cal-unscheduled-title">💡 Ideas</h2>
        <span className="muted text-xs cal-unscheduled-note">kept across weeks</span>
        <button type="button" className="btn cal-unscheduled-add" onClick={onAdd}>
          ＋ Add idea
        </button>
      </div>
      {slots.length === 0 ? (
        <p className="muted text-sm" style={{ margin: 0 }}>
          Nothing waiting. Add an idea to plan later, or tap ＋ on a day to post.
        </p>
      ) : (
        <div className="cal-unscheduled-list">
          {slots.map((s) => (
            <SlotCard key={`${s.kind}-${s.id}`} slot={s} onEdit={onEdit} />
          ))}
        </div>
      )}
    </section>
  );
}
