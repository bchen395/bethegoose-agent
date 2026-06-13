"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { saveNumbers } from "@/app/actions";

export default function NumbersForm({
  postId,
  initial,
}: {
  postId: number;
  initial: { likes: number; comments: number; reach: number; saves: number };
}) {
  const router = useRouter();
  const [vals, setVals] = useState(initial);
  const [busy, setBusy] = useState(false);

  function bind(key: keyof typeof vals) {
    return {
      type: "number" as const,
      min: 0,
      value: vals[key],
      onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
        setVals((v) => ({ ...v, [key]: Math.max(0, Math.floor(Number(e.target.value) || 0)) })),
      className: "field",
      style: { width: 90 },
    };
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await saveNumbers(postId, vals.likes, vals.comments, vals.reach, vals.saves);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="row" style={{ marginTop: 8 }}>
      <label>
        Likes <input {...bind("likes")} />
      </label>
      <label>
        Comments <input {...bind("comments")} />
      </label>
      <label>
        Reach <input {...bind("reach")} />
      </label>
      <label>
        Saves <input {...bind("saves")} />
      </label>
      <button className="btn btn-primary" type="submit" disabled={busy}>
        💾 Save numbers
      </button>
    </form>
  );
}
