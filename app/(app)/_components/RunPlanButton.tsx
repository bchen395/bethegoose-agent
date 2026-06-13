"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function RunPlanButton({ weekStart }: { weekStart: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notes, setNotes] = useState<{ reasoning?: string; webQueries?: string[]; webUsed?: boolean } | null>(
    null,
  );

  async function run() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/strategy/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ weekStart }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error || "Failed to run the weekly plan.");
      } else {
        setNotes({ reasoning: data.reasoning, webQueries: data.webQueries, webUsed: data.webUsed });
        router.refresh();
      }
    } catch {
      setError("Network error running the weekly plan.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button className="btn btn-primary" onClick={run} disabled={busy}>
        {busy ? "Strategy Agent: planning the week…" : "🔄 Run weekly plan now"}
      </button>
      {error && <p className="err">{error}</p>}
      {notes && (
        <div className="card" style={{ marginTop: 10 }}>
          <strong>🧠 Strategy Agent notes</strong>
          {notes.reasoning && <p style={{ marginBottom: 6 }}>{notes.reasoning}</p>}
          {notes.webQueries && notes.webQueries.length > 0 ? (
            <p className="muted" style={{ fontSize: 12, margin: 0 }}>
              Web searches: {notes.webQueries.join(", ")}
            </p>
          ) : notes.webUsed === false ? (
            <p className="muted" style={{ fontSize: 12, margin: 0 }}>
              Web research was unavailable — planned on first-party data only.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
