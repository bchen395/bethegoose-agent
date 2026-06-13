"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { finalizeArtUpload, prepareArtUpload } from "@/app/actions";
import { createClient } from "@/lib/supabase/client";
import { FORMAT_BADGE, STATUS_BADGE, badge } from "../_lib/format";

export type SlotCardData = {
  id: number;
  slotDate: string;
  slotTime: string | null;
  format: string | null;
  theme: string | null;
  contentIdea: string | null;
  priority: number | null;
  status: string | null;
  artUrl: string | null;
  hasArt: boolean;
};

export default function SlotCard({ slot }: { slot: SlotCardData }) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"upload" | "generate" | null>(null);
  const [error, setError] = useState("");

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy("upload");
    setError("");
    try {
      const { postId, key, token } = await prepareArtUpload(slot.id, file.name);
      const supabase = createClient();
      const { error: upErr } = await supabase.storage.from("art").uploadToSignedUrl(key, token, file);
      if (upErr) {
        setError(`Upload failed: ${upErr.message}`);
        return;
      }
      await finalizeArtUpload(postId, key);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setBusy(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function onGenerate() {
    setBusy("generate");
    setError("");
    try {
      const res = await fetch("/api/content/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slotId: slot.id }),
      });
      const data = await res.json();
      if (!data.ok) setError(data.error || "Failed to generate the draft.");
      else router.refresh();
    } catch {
      setError("Network error generating the draft.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <div className="muted" style={{ fontSize: 13 }}>
            <strong>{slot.slotDate}</strong> · {slot.slotTime || "—"} ·{" "}
            {badge(FORMAT_BADGE, slot.format)} ·{" "}
            {slot.priority === 1 ? "⭐ must-post" : "nice to have"}
          </div>
          {slot.theme && <div style={{ fontWeight: 600 }}>{slot.theme}</div>}
          {slot.contentIdea && <div>{slot.contentIdea}</div>}
        </div>
        <div style={{ textAlign: "right" }}>
          {slot.status && <div style={{ fontSize: 13 }}>{badge(STATUS_BADGE, slot.status)}</div>}
          {slot.artUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={slot.artUrl}
              alt="attached art"
              style={{ width: 110, borderRadius: 6, marginTop: 6 }}
            />
          )}
        </div>
      </div>

      <div className="row" style={{ marginTop: 10 }}>
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          onChange={onFile}
          disabled={busy !== null}
          style={{ fontSize: 13 }}
        />
        <button
          className="btn"
          onClick={onGenerate}
          disabled={busy !== null || !slot.hasArt}
          title={slot.hasArt ? undefined : "Attach art first."}
        >
          {busy === "generate"
            ? "Content Agent: preparing…"
            : slot.status === "draft"
              ? "Regenerate draft"
              : "Generate draft"}
        </button>
        {busy === "upload" && <span className="muted">Uploading…</span>}
      </div>
      {error && <p className="err">{error}</p>}
    </div>
  );
}
