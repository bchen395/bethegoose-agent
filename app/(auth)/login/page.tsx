"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState("");

  async function sendMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setMessage("");
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    if (error) {
      setStatus("error");
      setMessage(error.message);
    } else {
      setStatus("sent");
    }
  }

  const denied =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).get("denied");

  return (
    <main style={{ maxWidth: 420, margin: "12vh auto", padding: "0 20px" }}>
      <h1 style={{ fontSize: 24, marginBottom: 4 }}>🎨 Art Business Agent</h1>
      <p style={{ color: "var(--muted)", marginTop: 0 }}>Sign in to plan, prep, and track posts.</p>

      {denied && (
        <p style={{ color: "#b4612f" }}>
          That account isn’t on the allow-list. Ask the owner to add your email.
        </p>
      )}

      {status === "sent" ? (
        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: 10,
            padding: 16,
            background: "var(--card)",
          }}
        >
          <strong>Check your email.</strong>
          <p style={{ marginBottom: 0 }}>
            We sent a magic sign-in link to <b>{email}</b>. Open it on this device.
          </p>
        </div>
      ) : (
        <form onSubmit={sendMagicLink} style={{ display: "grid", gap: 10 }}>
          <input
            type="email"
            required
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{
              padding: "10px 12px",
              borderRadius: 8,
              border: "1px solid var(--border)",
              fontSize: 16,
            }}
          />
          <button
            type="submit"
            disabled={status === "sending"}
            style={{
              padding: "10px 12px",
              borderRadius: 8,
              border: "none",
              background: "var(--accent)",
              color: "#fff",
              fontSize: 16,
              cursor: "pointer",
            }}
          >
            {status === "sending" ? "Sending…" : "Email me a magic link"}
          </button>
          {status === "error" && <p style={{ color: "#b4612f" }}>{message}</p>}
        </form>
      )}
    </main>
  );
}
