"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { saveBrandVoice } from "@/app/actions";
import type { BrandVoice } from "@/lib/db";

export default function BrandVoiceForm({ brandVoice }: { brandVoice: BrandVoice | null }) {
  const router = useRouter();
  const [artistName, setArtistName] = useState(brandVoice?.artistName ?? "");
  const [toneDescription, setToneDescription] = useState(brandVoice?.toneDescription ?? "");
  const [exampleCaptionsText, setExampleCaptionsText] = useState(
    (brandVoice?.exampleCaptions ?? []).join("\n"),
  );
  const [avoidPhrasesText, setAvoidPhrasesText] = useState(
    (brandVoice?.avoidPhrases ?? []).join("\n"),
  );
  const [snailMailPitch, setSnailMailPitch] = useState(brandVoice?.snailMailPitch ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setOk("");
    try {
      await saveBrandVoice({
        artistName,
        toneDescription,
        exampleCaptionsText,
        avoidPhrasesText,
        snailMailPitch,
      });
      setOk("Brand voice saved.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save brand voice.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card">
      <strong>🎨 Brand voice</strong>
      <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>
        Guides how the agents write CTAs and market blurbs. The agents never write captions — they
        only mirror this voice.
      </p>
      <label style={{ display: "block", marginTop: 8 }}>
        Artist name
        <input
          className="field"
          value={artistName}
          onChange={(e) => setArtistName(e.target.value)}
        />
      </label>
      <label style={{ display: "block", marginTop: 8 }}>
        Tone description
        <textarea
          className="field"
          rows={4}
          value={toneDescription}
          onChange={(e) => setToneDescription(e.target.value)}
        />
      </label>
      <label style={{ display: "block", marginTop: 8 }}>
        Example captions (one per line)
        <textarea
          className="field"
          rows={5}
          value={exampleCaptionsText}
          onChange={(e) => setExampleCaptionsText(e.target.value)}
        />
      </label>
      <label style={{ display: "block", marginTop: 8 }}>
        Avoid phrases (one per line)
        <textarea
          className="field"
          rows={4}
          value={avoidPhrasesText}
          onChange={(e) => setAvoidPhrasesText(e.target.value)}
        />
      </label>
      <label style={{ display: "block", marginTop: 8 }}>
        Snail-mail pitch
        <textarea
          className="field"
          rows={3}
          value={snailMailPitch}
          onChange={(e) => setSnailMailPitch(e.target.value)}
        />
      </label>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          💾 Save brand voice
        </button>
      </div>
      {ok && <p style={{ color: "#2f7d32", fontSize: 13 }}>{ok}</p>}
      {error && <p className="err">{error}</p>}
    </form>
  );
}
