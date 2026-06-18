"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { createIdea } from "@/app/actions";
import { FORMAT_BADGE, FORMATS, badge } from "../_lib/format";

/** Inline "＋ New idea" affordance that expands into a small create form. */
export default function NewIdeaForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [format, setFormat] = useState("");
  const [contentIdea, setContentIdea] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await createIdea({ title, format, contentIdea });
      setTitle("");
      setFormat("");
      setContentIdea("");
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add the idea.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="btn idea-add-btn" onClick={() => setOpen(true)}>
        ＋ New idea
      </button>
    );
  }

  return (
    <form className="idea-form" onSubmit={submit}>
      <input
        className="field"
        placeholder="Idea title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        autoFocus
      />
      <select className="field" value={format} onChange={(e) => setFormat(e.target.value)}>
        <option value="">Any format</option>
        {FORMATS.map((f) => (
          <option key={f} value={f}>
            {badge(FORMAT_BADGE, f)}
          </option>
        ))}
      </select>
      <textarea
        className="field"
        placeholder="Notes / the idea (optional)"
        value={contentIdea}
        onChange={(e) => setContentIdea(e.target.value)}
        rows={2}
      />
      {error && <p className="err">{error}</p>}
      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={busy || !title.trim()}>
          {busy ? "Adding…" : "Add idea"}
        </button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
