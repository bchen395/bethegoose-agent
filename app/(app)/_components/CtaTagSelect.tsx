"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { setPostCta } from "@/app/actions";
import { CTA_LABELS, CTA_OPTIONS } from "../_lib/format";

/**
 * One-tap CTA tag for a posted item (FEATURES.md §4). Untagged posts show the
 * placeholder; picking a type writes posts.cta_type, which feeds the "which CTA
 * converts" insight and the Strategy Agent's CTA-rotation cues.
 */
export default function CtaTagSelect({
  postId,
  value,
}: {
  postId: number;
  value: string | null;
}) {
  const router = useRouter();
  const [cta, setCta] = useState(value ?? "");
  const [pending, start] = useTransition();
  const [error, setError] = useState("");

  function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value;
    const prev = cta;
    setCta(next);
    setError("");
    start(async () => {
      try {
        await setPostCta(postId, next);
        router.refresh();
      } catch (err) {
        setCta(prev); // roll back the optimistic value on failure
        setError(err instanceof Error ? err.message : "Could not save CTA.");
      }
    });
  }

  return (
    <span className="row text-sm" style={{ gap: 6, alignItems: "center" }}>
      <span className="muted">CTA driven:</span>
      <select className="field" value={cta} onChange={onChange} disabled={pending} style={{ width: 150 }}>
        <option value="" disabled hidden>
          Tag CTA…
        </option>
        {CTA_OPTIONS.map((c) => (
          <option key={c} value={c}>
            {CTA_LABELS[c] ?? c}
          </option>
        ))}
      </select>
      {error && <span className="err">{error}</span>}
    </span>
  );
}
