"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { seedDefaultWeek } from "@/app/actions";

/** Seeds an empty week with the deterministic default layout (then drag to adjust). */
export default function DefaultLayoutButton({ weekStart }: { weekStart: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      await seedDefaultWeek(weekStart);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" className="btn" onClick={run} disabled={busy}>
      {busy ? "Adding default layout…" : "✨ Use a default layout"}
    </button>
  );
}
