"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { createProduct, updateProductAction } from "@/app/actions";
import type { Product } from "@/lib/db";
import { PRODUCT_TYPES, TYPE_LABELS } from "../_lib/format";

/** Add (no `product`) or edit (with `product`) a single product row. */
export default function ProductForm({
  product,
  onSaved,
  onCancel,
}: {
  product?: Product;
  onSaved?: () => void;
  onCancel?: () => void;
}) {
  const router = useRouter();
  const editing = product != null;
  const [name, setName] = useState(product?.name ?? "");
  const [url, setUrl] = useState(product?.url ?? "");
  const [type, setType] = useState(product?.type ?? PRODUCT_TYPES[0]);
  const [active, setActive] = useState(product?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Product name is required.");
      return;
    }
    setBusy(true);
    setError("");
    setOk("");
    try {
      const data = { name, url, type, active };
      if (editing) {
        await updateProductAction(product!.id, data);
        setOk("Saved.");
        onSaved?.();
      } else {
        await createProduct(data);
        setName("");
        setUrl("");
        setType(PRODUCT_TYPES[0]);
        setActive(true);
        setOk("Added.");
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save product.");
    } finally {
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
        <label style={{ flex: 3, minWidth: 220 }}>
          URL
          <input
            className="field"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…"
          />
        </label>
        <label style={{ minWidth: 140 }}>
          Type
          <select className="field" value={type} onChange={(e) => setType(e.target.value)}>
            {PRODUCT_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t] ?? t}
              </option>
            ))}
          </select>
        </label>
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Active
        </label>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {editing ? "💾 Save" : "➕ Add product"}
        </button>
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
      </div>
      {editing && product?.lastPromotedAt && (
        <p className="muted text-xs" style={{ marginTop: 6 }}>
          Last promoted: {product.lastPromotedAt} (managed by the agent — read-only)
        </p>
      )}
      {ok && <p className="ok">{ok}</p>}
      {error && <p className="err">{error}</p>}
    </form>
  );
}
