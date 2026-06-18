"use client";

import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import {
  archiveIdeaAction,
  moveSlot,
  scheduleIdea,
  setSlotDone,
  unscheduleSlot,
} from "@/app/actions";
import DayColumn from "./DayColumn";
import IdeaTray from "./IdeaTray";
import SlotCard from "./SlotCard";
import { FORMAT_BADGE, badge } from "../_lib/format";
import type { DayMeta, IdeaData, SlotCardData } from "./calendar-types";

/**
 * The interactive week board: a droppable column per day plus the idea box.
 * Mutations are optimistic (local state updates immediately), then the server
 * action runs and router.refresh() reconciles with the persisted state.
 */
export default function CalendarBoard({
  weekStart,
  days,
  slots: initialSlots,
  ideas,
}: {
  weekStart: string;
  days: DayMeta[];
  slots: SlotCardData[];
  ideas: IdeaData[];
}) {
  const router = useRouter();
  const [slots, setSlots] = useState(initialSlots);
  const [activeId, setActiveId] = useState<string | null>(null);
  const tempId = useRef(-1); // negative ids for optimistic, not-yet-saved slots

  // Re-sync when the server sends fresh data (after a router.refresh()).
  useEffect(() => setSlots(initialSlots), [initialSlots]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  );

  const slotsByDay = new Map<string, SlotCardData[]>();
  for (const d of days) slotsByDay.set(d.iso, []);
  for (const s of slots) {
    if (!slotsByDay.has(s.slotDate)) slotsByDay.set(s.slotDate, []);
    slotsByDay.get(s.slotDate)!.push(s);
  }

  function placeIdea(ideaId: number, dayIso: string) {
    const idea = ideas.find((i) => i.id === ideaId);
    const optimistic: SlotCardData = {
      id: tempId.current--,
      slotDate: dayIso,
      slotTime: null,
      format: idea?.format ?? null,
      theme: idea?.title ?? null,
      contentIdea: idea?.contentIdea ?? null,
      priority: 2,
      done: false,
    };
    setSlots((prev) => [...prev, optimistic]);
    void scheduleIdea(ideaId, dayIso, weekStart).then(() => router.refresh());
  }

  function handleMove(id: number, dayIso: string) {
    setSlots((prev) => prev.map((s) => (s.id === id ? { ...s, slotDate: dayIso } : s)));
    void moveSlot(id, dayIso).then(() => router.refresh());
  }

  function handleUnschedule(id: number) {
    setSlots((prev) => prev.filter((s) => s.id !== id));
    void unscheduleSlot(id).then(() => router.refresh());
  }

  function handleToggleDone(id: number, done: boolean) {
    setSlots((prev) => prev.map((s) => (s.id === id ? { ...s, done } : s)));
    void setSlotDone(id, done).then(() => router.refresh());
  }

  function handleArchive(ideaId: number) {
    void archiveIdeaAction(ideaId).then(() => router.refresh());
  }

  function onDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
  }

  function onDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const { active, over } = e;
    if (!over) return;
    const from = String(active.id);
    const to = String(over.id);

    if (from.startsWith("idea:") && to.startsWith("day:")) {
      placeIdea(Number(from.slice(5)), to.slice(4));
      return;
    }
    if (from.startsWith("slot:")) {
      const slotId = Number(from.slice(5));
      if (to.startsWith("day:")) {
        const dayIso = to.slice(4);
        const current = slots.find((s) => s.id === slotId);
        if (current && current.slotDate !== dayIso) handleMove(slotId, dayIso);
      } else if (to === "tray") {
        handleUnschedule(slotId);
      }
    }
  }

  function renderOverlay() {
    if (!activeId) return null;
    if (activeId.startsWith("slot:")) {
      const slot = slots.find((s) => s.id === Number(activeId.slice(5)));
      return slot ? (
        <div className="slot-wrap dragging">
          <SlotCard slot={slot} />
        </div>
      ) : null;
    }
    if (activeId.startsWith("idea:")) {
      const idea = ideas.find((i) => i.id === Number(activeId.slice(5)));
      return idea ? (
        <div className="idea-card dragging">
          <div className="idea-card-head">
            {idea.format && (
              <span className={`chip chip-fmt-${idea.format}`}>
                {badge(FORMAT_BADGE, idea.format)}
              </span>
            )}
          </div>
          <div className="idea-title">{idea.title}</div>
        </div>
      ) : null;
    }
    return null;
  }

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <div className="cal-board">
        <div className="cal-week">
          {days.map((day) => (
            <DayColumn
              key={day.iso}
              day={day}
              slots={slotsByDay.get(day.iso) ?? []}
              days={days}
              onToggleDone={handleToggleDone}
              onUnschedule={handleUnschedule}
              onMove={handleMove}
            />
          ))}
        </div>
        <IdeaTray ideas={ideas} days={days} onSchedule={placeIdea} onArchive={handleArchive} />
      </div>
      <DragOverlay>{renderOverlay()}</DragOverlay>
    </DndContext>
  );
}
