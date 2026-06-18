"use client";

import { useState } from "react";

import type { Market } from "@/lib/db";
import { STATUS_CHIP, STATUS_LABELS } from "../_lib/format";
import MarketForm from "./MarketForm";

/**
 * A scannable read view for one market. Click Edit to expand the existing
 * MarketForm inline; it collapses again on a successful save or cancel.
 */
export default function MarketRow({ market }: { market: Market }) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <MarketForm
        market={market}
        onSaved={() => setEditing(false)}
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <div className="read-row">
      <div className="read-row-main">
        <span className="read-row-name">{market.name}</span>
        {market.status && (
          <span className={`chip ${STATUS_CHIP[market.status] ?? "chip-muted"}`}>
            {STATUS_LABELS[market.status] ?? market.status}
          </span>
        )}
        {market.location && <span className="meta">{market.location}</span>}
        {market.eventDate && <span className="meta tabular">{market.eventDate}</span>}
      </div>
      <button type="button" className="btn" onClick={() => setEditing(true)}>
        Edit
      </button>
    </div>
  );
}
