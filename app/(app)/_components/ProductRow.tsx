"use client";

import { useState } from "react";

import type { Product } from "@/lib/db";
import { TYPE_LABELS } from "../_lib/format";
import ProductForm from "./ProductForm";

/**
 * A scannable read view for one product. Click Edit to expand the existing
 * ProductForm inline; it collapses again on a successful save or cancel.
 */
export default function ProductRow({ product }: { product: Product }) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <ProductForm
        product={product}
        onSaved={() => setEditing(false)}
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <div className={`read-row${product.active ? "" : " read-row-inactive"}`}>
      <div className="read-row-main">
        <span className="read-row-name">{product.name}</span>
        <span className="chip chip-accent">{TYPE_LABELS[product.type] ?? product.type}</span>
        {!product.active && <span className="chip chip-muted">inactive</span>}
        {product.url && (
          <a className="text-sm" href={product.url} target="_blank" rel="noreferrer">
            link ↗
          </a>
        )}
      </div>
      <button type="button" className="btn" onClick={() => setEditing(true)}>
        Edit
      </button>
    </div>
  );
}
