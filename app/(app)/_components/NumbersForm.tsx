"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { saveNumbers } from "@/app/actions";

type Field = "saves" | "reach" | "likes" | "comments" | "shares";

// Empty string = "not entered" (distinct from a real 0). saves+reach required.
type Initial = Record<Field, number | null>;

function toStr(v: number | null): string {
  return v == null ? "" : String(v);
}

function toNum(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
}

export default function NumbersForm({ postId, initial }: { postId: number; initial: Initial }) {
  const router = useRouter();
  const [vals, setVals] = useState<Record<Field, string>>({
    saves: toStr(initial.saves),
    reach: toStr(initial.reach),
    likes: toStr(initial.likes),
    comments: toStr(initial.comments),
    shares: toStr(initial.shares),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function bind(key: Field) {
    return {
      type: "number" as const,
      min: 0,
      value: vals[key],
      onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
        setVals((v) => ({ ...v, [key]: e.target.value })),
      className: "field",
      style: { width: 90 },
    };
  }

  const ready = vals.saves.trim() !== "" && vals.reach.trim() !== "";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) {
      setError("Saves and reach are required.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await saveNumbers(postId, {
        saves: toNum(vals.saves),
        reach: toNum(vals.reach),
        likes: toNum(vals.likes),
        comments: toNum(vals.comments),
        shares: toNum(vals.shares),
      });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save numbers.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} style={{ marginTop: 8 }}>
      <div className="row">
        <label>
          Saves <span className="err">*</span> <input {...bind("saves")} required />
        </label>
        <label>
          Reach <span className="err">*</span> <input {...bind("reach")} required />
        </label>
        <label>
          Shares <input {...bind("shares")} placeholder="—" />
        </label>
        <label>
          Likes <input {...bind("likes")} placeholder="—" />
        </label>
        <label>
          Comments <input {...bind("comments")} placeholder="—" />
        </label>
        <button className="btn btn-primary" type="submit" disabled={busy || !ready}>
          💾 Save numbers
        </button>
      </div>
      <p className="muted text-xs" style={{ marginTop: 4 }}>
        Only <strong>saves</strong> + <strong>reach</strong> are required. Shares is the strongest
        growth signal — worth the extra tap.
      </p>
      {error && <p className="err">{error}</p>}
    </form>
  );
}
