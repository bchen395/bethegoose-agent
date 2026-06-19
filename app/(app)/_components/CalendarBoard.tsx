"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import {
  addPost,
  deleteIdea,
  deleteSlot,
  saveIdea,
  saveSlot,
  scheduleSlot,
  setSlotDone,
  unscheduleSlot,
} from "@/app/actions";
import DayColumn from "./DayColumn";
import SlotEditor, { type SlotDraft } from "./SlotEditor";
import UnscheduledArea from "./UnscheduledArea";
import type { DayMeta, SlotData } from "./calendar-types";

/**
 * The simplified week board. No drag-and-drop: tap a day's ＋ to add, tap a card
 * to edit. One editor handles add + edit for both scheduled slots and unscheduled
 * ideas. Mutations are optimistic (local state updates immediately), then the
 * server action runs and router.refresh() reconciles with the persisted state.
 */
export default function CalendarBoard({
  days,
  slots: initialSlots,
}: {
  days: DayMeta[];
  slots: SlotData[];
}) {
  const router = useRouter();
  const [slots, setSlots] = useState(initialSlots);
  const [editor, setEditor] = useState<
    { mode: "create"; slotDate: string | null } | { mode: "edit"; card: SlotData } | null
  >(null);
  const tempId = useRef(-1); // negative ids for optimistic, not-yet-saved cards

  // Re-sync when the server sends fresh data (after a router.refresh()).
  useEffect(() => setSlots(initialSlots), [initialSlots]);

  const unscheduled = slots.filter((s) => s.slotDate == null);
  const slotsByDay = new Map<string, SlotData[]>();
  for (const d of days) slotsByDay.set(d.iso, []);
  for (const s of slots) if (s.slotDate) slotsByDay.get(s.slotDate)?.push(s);

  function handleToggleDone(id: number, done: boolean) {
    setSlots((prev) => prev.map((s) => (s.id === id && s.kind === "slot" ? { ...s, done } : s)));
    void setSlotDone(id, done).then(() => router.refresh());
  }

  function handleSave(draft: SlotDraft) {
    if (!editor) return;
    const fields = {
      slotDate: draft.slotDate,
      slotTime: draft.slotTime || null,
      format: draft.format || null,
      theme: draft.theme.trim() || null,
      contentIdea: draft.contentIdea.trim() || null,
      priority: draft.priority,
    };
    const nextKind: SlotData["kind"] = draft.slotDate == null ? "idea" : "slot";

    if (editor.mode === "create") {
      const optimistic: SlotData = {
        kind: nextKind,
        id: tempId.current--,
        slotDate: fields.slotDate,
        slotTime: fields.slotTime,
        format: fields.format,
        theme: fields.theme,
        contentIdea: fields.contentIdea,
        priority: fields.priority,
        done: false,
        fromAgent: false,
      };
      setSlots((prev) => [...prev, optimistic]);
      void addPost(fields).then(() => router.refresh());
    } else {
      const card = editor.card;
      setSlots((prev) =>
        prev.map((s) =>
          s.id === card.id && s.kind === card.kind ? { ...s, ...fields, kind: nextKind } : s,
        ),
      );
      if (card.kind === "idea") {
        const run = draft.slotDate != null ? scheduleSlot(card.id, fields) : saveIdea(card.id, fields);
        void run.then(() => router.refresh());
      } else {
        const run =
          draft.slotDate != null ? saveSlot(card.id, fields) : unscheduleSlot(card.id, fields);
        void run.then(() => router.refresh());
      }
    }
    setEditor(null);
  }

  function handleDelete() {
    if (!editor || editor.mode !== "edit") return;
    const card = editor.card;
    setSlots((prev) => prev.filter((s) => !(s.id === card.id && s.kind === card.kind)));
    const run = card.kind === "idea" ? deleteIdea(card.id) : deleteSlot(card.id);
    void run.then(() => router.refresh());
    setEditor(null);
  }

  const editorTitle =
    editor?.mode === "create"
      ? editor.slotDate == null
        ? "Add idea"
        : "Add post"
      : "Edit post";

  const editorInitial: SlotDraft =
    editor?.mode === "edit"
      ? {
          theme: editor.card.theme ?? "",
          contentIdea: editor.card.contentIdea ?? "",
          format: editor.card.format ?? "",
          slotTime: editor.card.slotTime ?? "",
          priority: editor.card.priority === 1 ? 1 : 2,
          slotDate: editor.card.slotDate,
        }
      : {
          theme: "",
          contentIdea: "",
          format: "",
          slotTime: "",
          priority: 2,
          slotDate: editor?.mode === "create" ? editor.slotDate : null,
        };

  return (
    <>
      <UnscheduledArea
        slots={unscheduled}
        onEdit={(c) => setEditor({ mode: "edit", card: c })}
        onAdd={() => setEditor({ mode: "create", slotDate: null })}
      />
      <div className="cal-week">
        {days.map((day) => (
          <DayColumn
            key={day.iso}
            day={day}
            slots={slotsByDay.get(day.iso) ?? []}
            onEdit={(c) => setEditor({ mode: "edit", card: c })}
            onAdd={(iso) => setEditor({ mode: "create", slotDate: iso })}
            onToggleDone={handleToggleDone}
          />
        ))}
      </div>
      {editor && (
        <SlotEditor
          title={editorTitle}
          initial={editorInitial}
          days={days}
          canDelete={editor.mode === "edit"}
          onSave={handleSave}
          onDelete={handleDelete}
          onClose={() => setEditor(null)}
        />
      )}
    </>
  );
}
