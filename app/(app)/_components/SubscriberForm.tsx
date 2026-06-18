"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { logSubscriberEvent } from "@/app/actions";

export type PostOption = { id: number; label: string };

export default function SubscriberForm({ posts }: { posts: PostOption[] }) {
  const router = useRouter();
  const [channel, setChannel] = useState<"snail_mail" | "email">("snail_mail");
  const [count, setCount] = useState("1");
  const [sourcePostId, setSourcePostId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const n = Math.floor(Number(count));
    if (!Number.isFinite(n) || n < 1) {
      setError("Enter how many new subscribers (at least 1).");
      return;
    }
    setBusy(true);
    setError("");
    setOk("");
    try {
      await logSubscriberEvent({
        channel,
        count: n,
        sourcePostId: sourcePostId ? Number(sourcePostId) : null,
        note: note || null,
      });
      setOk(`Logged ${n} ${channel === "snail_mail" ? "snail-mail" : "email"} subscriber(s).`);
      setCount("1");
      setSourcePostId("");
      setNote("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not log subscribers.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card">
      <strong>➕ New subscribers this period</strong>
      <p className="muted text-sm" style={{ marginTop: 4 }}>
        Converting followers to the mailing list is the most durable growth at this size — log them
        here so you can see which CTAs actually convert.
      </p>
      <div className="row" style={{ marginTop: 8 }}>
        <label>
          Channel
          <select
            className="field"
            value={channel}
            onChange={(e) => setChannel(e.target.value as "snail_mail" | "email")}
            style={{ width: 150 }}
          >
            <option value="snail_mail">Snail mail</option>
            <option value="email">Email</option>
          </select>
        </label>
        <label>
          How many
          <input
            className="field"
            type="number"
            min={1}
            value={count}
            onChange={(e) => setCount(e.target.value)}
            style={{ width: 90 }}
          />
        </label>
        <label style={{ flex: 1, minWidth: 220 }}>
          Which post drove it? (optional)
          <select
            className="field"
            value={sourcePostId}
            onChange={(e) => setSourcePostId(e.target.value)}
          >
            <option value="">— not sure / not tied to a post</option>
            {posts.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label style={{ display: "block", marginTop: 8 }}>
        Note (optional)
        <input className="field" value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          💾 Log subscribers
        </button>
      </div>
      {ok && <p className="ok">{ok}</p>}
      {error && <p className="err">{error}</p>}
    </form>
  );
}
