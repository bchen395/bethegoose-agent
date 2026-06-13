"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { discardDraft, saveDraft } from "@/app/actions";
import { CTA_OPTIONS, FORMAT_BADGE, badge } from "../_lib/format";

export type ReviewCardData = {
  id: number;
  format: string | null;
  agentReasoning: string | null;
  productName: string | null;
  reelScript: string | null;
  caption: string | null;
  hashtags: string[];
  ctaType: string | null;
  ctaUrl: string | null;
  ctaSuggestion: string | null;
  artUrl: string | null;
  captionStartersEnabled: boolean;
};

export default function ReviewCard({ post }: { post: ReviewCardData }) {
  const router = useRouter();
  const [caption, setCaption] = useState(post.caption ?? "");
  const [hashtagsText, setHashtagsText] = useState((post.hashtags ?? []).join(" "));
  const [ctaType, setCtaType] = useState(post.ctaType ?? "none");
  const [ctaUrl, setCtaUrl] = useState(post.ctaUrl ?? "");
  const [ctaSuggestion, setCtaSuggestion] = useState(post.ctaSuggestion ?? "");
  const [busy, setBusy] = useState<"save" | "approve" | "discard" | null>(null);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  // §9 caption starters (only when the flag is on) — read-only inspiration; the
  // caption field stays empty + required, so we never auto-fill it.
  const [starters, setStarters] = useState<string[] | null>(null);
  const [startersBusy, setStartersBusy] = useState(false);
  const [startersError, setStartersError] = useState("");

  function fields() {
    return { caption, hashtagsText, ctaType, ctaUrl, ctaSuggestion };
  }

  async function onSave() {
    setBusy("save");
    setError("");
    setOk("");
    try {
      await saveDraft(post.id, fields());
      setOk("Saved.");
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function onStarters() {
    setStartersBusy(true);
    setStartersError("");
    try {
      const res = await fetch("/api/review/caption-starters", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ postId: post.id }),
      });
      const data = await res.json();
      if (!data.ok) {
        setStartersError(data.error || "Couldn't fetch starters.");
      } else {
        setStarters(data.starters ?? []);
      }
    } catch {
      setStartersError("Network error fetching starters.");
    } finally {
      setStartersBusy(false);
    }
  }

  async function onDiscard() {
    setBusy("discard");
    try {
      await discardDraft(post.id);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function onApprove() {
    if (!caption.trim()) {
      setError("Add a caption before approving — you write the caption.");
      return;
    }
    setBusy("approve");
    setError("");
    setOk("");
    try {
      await saveDraft(post.id, fields()); // persist edits first
      const res = await fetch(`/api/posts/${post.id}/approve`, { method: "POST" });
      const data = await res.json();
      if (!data.ok) {
        setError(`Distribution Agent failed: ${data.error}\nYour caption/edits were saved.`);
      } else {
        setOk("Approved — the posting checklist is ready in the Engagement view.");
        router.refresh();
      }
    } catch {
      setError("Network error during approval. Your caption/edits were saved.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card">
      <div className="row" style={{ alignItems: "flex-start" }}>
        {post.artUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={post.artUrl} alt="art" style={{ width: 160, borderRadius: 8 }} />
        )}
        <div style={{ flex: 1, minWidth: 220 }}>
          <div className="muted" style={{ fontSize: 13 }}>
            {badge(FORMAT_BADGE, post.format)} · draft #{post.id}
          </div>
          {post.agentReasoning && (
            <p className="muted" style={{ fontSize: 13 }}>
              Agent reasoning: {post.agentReasoning}
            </p>
          )}
          {post.productName && (
            <p className="muted" style={{ fontSize: 13 }}>
              Promoting: {post.productName}
            </p>
          )}
          {post.format === "reel" && post.reelScript && (
            <details open>
              <summary>🎬 Reel hook &amp; script</summary>
              <p style={{ whiteSpace: "pre-wrap" }}>{post.reelScript}</p>
            </details>
          )}
        </div>
      </div>

      <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
        <label>
          Your caption (you write this)
          <textarea
            className="field"
            rows={4}
            placeholder="Write or paste your caption here…"
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
          />
        </label>
        {post.captionStartersEnabled && (
          <div>
            <button className="btn" onClick={onStarters} disabled={startersBusy} type="button">
              {startersBusy ? "Thinking…" : "✨ Need a starting line?"}
            </button>
            {startersError && <p className="err">{startersError}</p>}
            {starters && starters.length > 0 && (
              <div style={{ marginTop: 6 }}>
                <div className="muted" style={{ fontSize: 12 }}>
                  Starters for inspiration — you still write your own caption:
                </div>
                <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 14 }}>
                  {starters.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        <label>
          Hashtags
          <textarea
            className="field"
            rows={2}
            value={hashtagsText}
            onChange={(e) => setHashtagsText(e.target.value)}
          />
        </label>
        <div className="row">
          <label style={{ flex: 1 }}>
            CTA type
            <select className="field" value={ctaType} onChange={(e) => setCtaType(e.target.value)}>
              {CTA_OPTIONS.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </label>
          <label style={{ flex: 2 }}>
            CTA URL
            <input className="field" value={ctaUrl} onChange={(e) => setCtaUrl(e.target.value)} />
          </label>
        </div>
        <label>
          Suggested CTA line (edit or drop it)
          <textarea
            className="field"
            rows={2}
            value={ctaSuggestion}
            onChange={(e) => setCtaSuggestion(e.target.value)}
          />
        </label>
      </div>

      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn" onClick={onSave} disabled={busy !== null}>
          💾 Save draft
        </button>
        <button className="btn btn-primary" onClick={onApprove} disabled={busy !== null}>
          {busy === "approve" ? "Approving…" : "✅ Approve"}
        </button>
        <button className="btn" onClick={onDiscard} disabled={busy !== null}>
          🗑 Discard
        </button>
      </div>
      {ok && <p style={{ color: "#2f7d32", fontSize: 13 }}>{ok}</p>}
      {error && <p className="err" style={{ whiteSpace: "pre-wrap" }}>{error}</p>}
    </div>
  );
}
