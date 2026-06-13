"use client";

import { useState } from "react";

type Suggestion = {
  title: string;
  idea: string;
  based_on_post_ids: number[];
  suggested_format?: string;
  product_tie_in?: string;
};

/**
 * FEATURES.md §8 — on-demand button on /insights. POSTs to /api/insights/reuse
 * (one bounded Haiku call) and renders the returned suggestions inline. Nothing
 * persists, so there's no router.refresh().
 */
export default function ReuseHitsButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);

  async function run() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const res = await fetch("/api/insights/reuse", { method: "POST" });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error || "Failed to generate reuse ideas.");
      } else {
        setSuggestions(data.suggestions ?? []);
        setMessage(data.message ?? "");
      }
    } catch {
      setError("Network error generating reuse ideas.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button className="btn" onClick={run} disabled={busy}>
        {busy ? "Asking Haiku…" : "♻️ Suggest reuses"}
      </button>
      <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>
        One quick Haiku call over your top posts — nothing is saved.
      </span>

      {error && <p className="err">{error}</p>}
      {message && (
        <p className="muted" style={{ fontSize: 13 }}>
          {message}
        </p>
      )}

      {suggestions && suggestions.length > 0 && (
        <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
          {suggestions.map((s, i) => (
            <div key={i} className="card" style={{ margin: 0 }}>
              <div style={{ fontWeight: 600 }}>
                {s.suggested_format ? `${s.suggested_format} · ` : ""}
                {s.title}
              </div>
              <p style={{ margin: "4px 0", fontSize: 14 }}>{s.idea}</p>
              <div className="muted" style={{ fontSize: 12 }}>
                from post{s.based_on_post_ids.length === 1 ? "" : "s"}{" "}
                {s.based_on_post_ids.map((id) => `#${id}`).join(", ")}
                {s.product_tie_in ? ` · ties in: ${s.product_tie_in}` : ""}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
