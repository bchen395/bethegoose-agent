"use client";

import { useDraggable } from "@dnd-kit/core";

import { FORMAT_BADGE, badge } from "../_lib/format";
import type { DayMeta, IdeaData } from "./calendar-types";

/**
 * A draggable idea from the library. Drag it onto a day to schedule (the idea
 * stays here for reuse), use the "Add to…" select as a no-drag fallback, or ×
 * to remove it from the library.
 */
export default function IdeaCard({
  idea,
  days,
  onSchedule,
  onArchive,
}: {
  idea: IdeaData;
  days: DayMeta[];
  onSchedule: (ideaId: number, dayIso: string) => void;
  onArchive: (ideaId: number) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `idea:${idea.id}`,
  });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;

  return (
    <div ref={setNodeRef} style={style} className={isDragging ? "idea-card dragging" : "idea-card"}>
      <div className="idea-card-head">
        <button
          type="button"
          className="grip"
          aria-label="Drag onto a day"
          {...listeners}
          {...attributes}
        >
          ⠿
        </button>
        {idea.format && (
          <span className={`chip chip-fmt-${idea.format}`}>{badge(FORMAT_BADGE, idea.format)}</span>
        )}
        <button
          type="button"
          className="slot-x idea-archive"
          aria-label="Remove idea"
          onClick={() => onArchive(idea.id)}
        >
          ×
        </button>
      </div>
      <div className="idea-title">{idea.title}</div>
      {idea.contentIdea && <div className="text-sm muted">{idea.contentIdea}</div>}
      <select
        className="idea-schedule"
        aria-label="Add this idea to a day"
        value=""
        onChange={(e) => {
          if (e.target.value) onSchedule(idea.id, e.target.value);
        }}
      >
        <option value="">Add to…</option>
        {days.map((d) => (
          <option key={d.iso} value={d.iso}>
            {d.name} {d.dateLabel}
          </option>
        ))}
      </select>
    </div>
  );
}
