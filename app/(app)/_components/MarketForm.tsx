"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { createMarket, deleteMarketAction, updateMarketAction } from "@/app/actions";
import type { Market } from "@/lib/db";
import { MARKET_STATUSES } from "../_lib/format";

const STATUS_LABELS: Record<string, string> = {
  considering: "Considering",
  applied: "Applied",
  accepted: "Accepted",
  rejected: "Rejected",
  attended: "Attended",
};

/** Add (no `market`) or edit (with `market`) a single market row. */
export default function MarketForm({ market }: { market?: Market }) {
  const router = useRouter();
  const editing = market != null;
  const [name, setName] = useState(market?.name ?? "");
  const [location, setLocation] = useState(market?.location ?? "");
  const [eventDate, setEventDate] = useState(market?.eventDate ?? "");
  const [applicationDeadline, setApplicationDeadline] = useState(market?.applicationDeadline ?? "");
  const [status, setStatus] = useState(market?.status ?? "");
  const [notes, setNotes] = useState(market?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Market name is required.");
      return;
    }
    setBusy(true);
    setError("");
    setOk("");
    try {
      const data = { name, location, eventDate, applicationDeadline, status, notes };
      if (editing) {
        await updateMarketAction(market!.id, data);
        setOk("Saved.");
      } else {
        await createMarket(data);
        setName("");
        setLocation("");
        setEventDate("");
        setApplicationDeadline("");
        setStatus("");
        setNotes("");
        setOk("Added.");
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save market.");
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!editing) return;
    if (!confirm(`Delete "${market!.name}"? This can't be undone.`)) return;
    setBusy(true);
    setError("");
    try {
      await deleteMarketAction(market!.id);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete market.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card">
      <div className="row" style={{ alignItems: "flex-end" }}>
        <label style={{ flex: 2, minWidth: 180 }}>
          Name
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label style={{ flex: 2, minWidth: 160 }}>
          Location
          <input className="field" value={location} onChange={(e) => setLocation(e.target.value)} />
        </label>
        <label>
          Event date
          <input
            className="field"
            type="date"
            value={eventDate}
            onChange={(e) => setEventDate(e.target.value)}
            style={{ width: 160 }}
          />
        </label>
        <label>
          Application deadline
          <input
            className="field"
            type="date"
            value={applicationDeadline}
            onChange={(e) => setApplicationDeadline(e.target.value)}
            style={{ width: 160 }}
          />
        </label>
        <label style={{ minWidth: 150 }}>
          Status
          <select className="field" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">—</option>
            {MARKET_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s] ?? s}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label style={{ display: "block", marginTop: 8 }}>
        Notes (yours — the agent never edits these)
        <textarea
          className="field"
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </label>
      {editing && market?.draftApplication && (
        <details style={{ marginTop: 8 }}>
          <summary className="muted">Agent-drafted blurb (read-only)</summary>
          <p style={{ whiteSpace: "pre-wrap" }}>{market.draftApplication}</p>
        </details>
      )}
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {editing ? "💾 Save" : "➕ Add market"}
        </button>
        {editing && (
          <button type="button" className="btn" onClick={onDelete} disabled={busy}>
            🗑 Delete
          </button>
        )}
      </div>
      {ok && <p style={{ color: "#2f7d32", fontSize: 13 }}>{ok}</p>}
      {error && <p className="err">{error}</p>}
    </form>
  );
}
