"use client";

import { useDroppable } from "@dnd-kit/core";

import IdeaCard from "./IdeaCard";
import NewIdeaForm from "./NewIdeaForm";
import type { DayMeta, IdeaData } from "./calendar-types";

/** The "box" of reusable ideas: a droppable target (drag a slot here to
 *  unschedule) and the source for dragging ideas onto days. */
export default function IdeaTray({
  ideas,
  days,
  onSchedule,
  onArchive,
}: {
  ideas: IdeaData[];
  days: DayMeta[];
  onSchedule: (ideaId: number, dayIso: string) => void;
  onArchive: (ideaId: number) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: "tray" });

  return (
    <aside ref={setNodeRef} className={isOver ? "idea-tray drop-over" : "idea-tray"}>
      <h2 className="idea-tray-head">💡 Idea box</h2>
      <p className="muted text-sm idea-tray-hint">
        Drag an idea onto a day — it stays here for reuse. Drag a planned post here to
        unschedule it.
      </p>
      <NewIdeaForm />
      <div className="idea-list">
        {ideas.length === 0 ? (
          <p className="muted text-sm">No ideas yet. Add one above.</p>
        ) : (
          ideas.map((idea) => (
            <IdeaCard
              key={idea.id}
              idea={idea}
              days={days}
              onSchedule={onSchedule}
              onArchive={onArchive}
            />
          ))
        )}
      </div>
    </aside>
  );
}
