"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** "reel ×2, carousel ×1" from a {format: count} record. */
function fmtMix(mix: Record<string, number>): string {
  return Object.entries(mix)
    .map(([fmt, n]) => `${fmt} ×${n}`)
    .join(", ");
}

export default function RunPlanButton({ weekStart }: { weekStart: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notes, setNotes] = useState<{
    reasoning?: string;
    webQueries?: string[];
    webUsed?: boolean;
    webSkippedReason?: "cadence" | "off" | null;
    mixTarget?: Record<string, number>;
    mixActual?: Record<string, number>;
    mixNote?: string | null;
  } | null>(null);

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
        setNotes({
          reasoning: data.reasoning,
          webQueries: data.webQueries,
          webUsed: data.webUsed,
          webSkippedReason: data.webSkippedReason,
          mixTarget: data.mixTarget,
          mixActual: data.mixActual,
          mixNote: data.mixNote,
        });
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
          ) : notes.webSkippedReason === "cadence" ? (
            <p className="muted" style={{ fontSize: 12, margin: 0 }}>
              Web search skipped (monthly cadence — searched recently). Planned on first-party data.
            </p>
          ) : notes.webSkippedReason === "off" ? (
            <p className="muted" style={{ fontSize: 12, margin: 0 }}>
              Web search is off — planned on first-party data only.
            </p>
          ) : notes.webUsed === false ? (
            <p className="muted" style={{ fontSize: 12, margin: 0 }}>
              Web research was unavailable — planned on first-party data only.
            </p>
          ) : null}
          {notes.mixActual && Object.keys(notes.mixActual).length > 0 && (
            <p className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>
              Format mix: {fmtMix(notes.mixActual)}
              {notes.mixTarget && Object.keys(notes.mixTarget).length > 0
                ? ` (target ${fmtMix(notes.mixTarget)})`
                : ""}
            </p>
          )}
          {notes.mixNote && (
            <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
              ⚖ {notes.mixNote}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
