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
    <main className="login-bg">
      <div className="login-card">
        <h1 style={{ marginTop: 0 }}>🎨 Art Business Agent</h1>
        <p className="muted" style={{ marginTop: 0 }}>Sign in to plan, prep, and track posts.</p>

        {denied && (
          <p className="err">
            That account isn’t on the allow-list. Ask the owner to add your email.
          </p>
        )}

        {status === "sent" ? (
          <div className="card">
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
              className="field"
              style={{ fontSize: 16 }}
            />
            <button
              type="submit"
              disabled={status === "sending"}
              className="btn btn-primary"
              style={{ justifyContent: "center", fontSize: 16, padding: "10px 12px" }}
            >
              {status === "sending" ? "Sending…" : "Email me a magic link"}
            </button>
            {status === "error" && <p className="err">{message}</p>}
          </form>
        )}
      </div>
    </main>
  );
}
