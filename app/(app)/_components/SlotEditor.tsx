"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { FORMAT_BADGE, FORMATS, badge } from "../_lib/format";
import type { DayMeta } from "./calendar-types";

export type SlotDraft = {
  theme: string;
  contentIdea: string;
  format: string; // "" = any
  slotTime: string; // "HH:MM" or ""
  priority: 1 | 2;
  slotDate: string | null; // null = unscheduled
};

/**
 * The one editor used for both add and edit. A modal on desktop, a bottom sheet
 * on phone. The Day select (with "— Unscheduled" first) is what replaces drag:
 * picking a day schedules; picking Unscheduled parks it. Time/priority only
 * apply once a day is chosen.
 */
export default function SlotEditor({
  title,
  initial,
  days,
  canDelete,
  onSave,
  onDelete,
  onClose,
}: {
  title: string;
  initial: SlotDraft;
  days: DayMeta[];
  canDelete: boolean;
  onSave: (draft: SlotDraft) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<SlotDraft>(initial);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  if (!mounted) return null;

  function set<K extends keyof SlotDraft>(key: K, value: SlotDraft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  const scheduled = draft.slotDate != null;
  const canSave = draft.theme.trim().length > 0 || draft.contentIdea.trim().length > 0;

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-head">{title}</h2>

        <div className="modal-body">
          <label className="modal-field">
            <span className="field-label">Idea / theme</span>
            <input
              className="field"
              autoFocus
              value={draft.theme}
              onChange={(e) => set("theme", e.target.value)}
              placeholder="e.g. Behind the scenes of a new print"
            />
          </label>

          <label className="modal-field">
            <span className="field-label">Notes</span>
            <textarea
              className="field"
              rows={3}
              value={draft.contentIdea}
              onChange={(e) => set("contentIdea", e.target.value)}
              placeholder="A sentence or two about the post."
            />
          </label>

          <div className="modal-grid">
            <label className="modal-field">
              <span className="field-label">Format</span>
              <select
                className="field"
                value={draft.format}
                onChange={(e) => set("format", e.target.value)}
              >
                <option value="">Any format</option>
                {FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {badge(FORMAT_BADGE, f)}
                  </option>
                ))}
              </select>
            </label>

            <label className="modal-field">
              <span className="field-label">Day</span>
              <select
                className="field"
                value={draft.slotDate ?? ""}
                onChange={(e) => set("slotDate", e.target.value || null)}
              >
                <option value="">— Unscheduled</option>
                {days.map((d) => (
                  <option key={d.iso} value={d.iso}>
                    {d.name} · {d.dateLabel}
                  </option>
                ))}
              </select>
            </label>

            {scheduled && (
              <>
                <label className="modal-field">
                  <span className="field-label">Time</span>
                  <input
                    type="time"
                    className="field"
                    value={draft.slotTime}
                    onChange={(e) => set("slotTime", e.target.value)}
                  />
                </label>

                <label className="modal-field">
                  <span className="field-label">Priority</span>
                  <select
                    className="field"
                    value={draft.priority}
                    onChange={(e) => set("priority", Number(e.target.value) === 1 ? 1 : 2)}
                  >
                    <option value={1}>Must-post</option>
                    <option value={2}>Nice to have</option>
                  </select>
                </label>
              </>
            )}
          </div>
        </div>

        <div className="modal-foot">
          {canDelete && (
            <button type="button" className="btn modal-delete" onClick={onDelete}>
              Delete
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canSave}
            onClick={() => onSave(draft)}
          >
            Save
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
