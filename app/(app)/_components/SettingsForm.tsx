"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { saveSettings } from "@/app/actions";
import type { Settings } from "@/lib/db";
import { WEB_SEARCH_CADENCES } from "../_lib/format";

export default function SettingsForm({ settings }: { settings: Settings }) {
  const router = useRouter();
  const mix = settings.weeklyMix ?? {};
  const [timezone, setTimezone] = useState(settings.timezone);
  const [hashtagCountMin, setHashtagCountMin] = useState(String(settings.hashtagCountMin));
  const [hashtagCountMax, setHashtagCountMax] = useState(String(settings.hashtagCountMax));
  const [defaultPostTime, setDefaultPostTime] = useState(settings.defaultPostTime);
  const [reelsRequired, setReelsRequired] = useState(settings.reelsRequired);
  const [reel, setReel] = useState(String(mix.reel ?? 0));
  const [carousel, setCarousel] = useState(String(mix.carousel ?? 0));
  const [staticCount, setStaticCount] = useState(String(mix.static ?? 0));
  const [webSearchCadence, setWebSearchCadence] = useState(settings.webSearchCadence);
  const [monthlyBudgetUsd, setMonthlyBudgetUsd] = useState(String(settings.monthlyBudgetUsd));
  const [captionStartersEnabled, setCaptionStartersEnabled] = useState(
    settings.captionStartersEnabled,
  );
  const [shopUrl, setShopUrl] = useState(settings.shopUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setOk("");
    try {
      await saveSettings({
        timezone,
        hashtagCountMin: Number(hashtagCountMin),
        hashtagCountMax: Number(hashtagCountMax),
        defaultPostTime,
        reelsRequired,
        weeklyMix: {
          reel: Number(reel),
          carousel: Number(carousel),
          static: Number(staticCount),
        },
        webSearchCadence,
        monthlyBudgetUsd,
        captionStartersEnabled,
        shopUrl,
      });
      setOk("Settings saved.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save settings.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card">
      <fieldset className="field-group">
        <legend>Scheduling</legend>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <label style={{ flex: 1, minWidth: 200 }}>
            Timezone (IANA, e.g. America/New_York)
            <input
              className="field"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
            />
          </label>
          <label>
            Default post time
            <input
              className="field"
              type="time"
              value={defaultPostTime}
              onChange={(e) => setDefaultPostTime(e.target.value)}
              style={{ width: 130 }}
            />
          </label>
        </div>
      </fieldset>

      <fieldset className="field-group">
        <legend>Format mix</legend>
        <p className="meta" style={{ marginTop: 0 }}>
          How many of each format the Strategy Agent aims for per week.
        </p>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <label>
            Reels
            <input
              className="field"
              type="number"
              min={0}
              value={reel}
              onChange={(e) => setReel(e.target.value)}
              style={{ width: 80 }}
            />
          </label>
          <label>
            Carousels
            <input
              className="field"
              type="number"
              min={0}
              value={carousel}
              onChange={(e) => setCarousel(e.target.value)}
              style={{ width: 80 }}
            />
          </label>
          <label>
            Static
            <input
              className="field"
              type="number"
              min={0}
              value={staticCount}
              onChange={(e) => setStaticCount(e.target.value)}
              style={{ width: 80 }}
            />
          </label>
        </div>
        <label className="row" style={{ gap: 6, marginTop: 12 }}>
          <input
            type="checkbox"
            checked={reelsRequired}
            onChange={(e) => setReelsRequired(e.target.checked)}
          />
          Require at least one reel each week
        </label>
      </fieldset>

      <fieldset className="field-group">
        <legend>Hashtags & captions</legend>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <label>
            Hashtags min
            <input
              className="field"
              type="number"
              min={0}
              value={hashtagCountMin}
              onChange={(e) => setHashtagCountMin(e.target.value)}
              style={{ width: 90 }}
            />
          </label>
          <label>
            Hashtags max
            <input
              className="field"
              type="number"
              min={0}
              value={hashtagCountMax}
              onChange={(e) => setHashtagCountMax(e.target.value)}
              style={{ width: 90 }}
            />
          </label>
        </div>
        <label className="row" style={{ gap: 6, marginTop: 12 }}>
          <input
            type="checkbox"
            checked={captionStartersEnabled}
            onChange={(e) => setCaptionStartersEnabled(e.target.checked)}
          />
          Enable caption starters
        </label>
      </fieldset>

      <fieldset className="field-group">
        <legend>Budget & research</legend>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <label style={{ minWidth: 160 }}>
            Web-search cadence
            <select
              className="field"
              value={webSearchCadence}
              onChange={(e) => setWebSearchCadence(e.target.value)}
            >
              {WEB_SEARCH_CADENCES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label>
            Monthly budget (USD)
            <input
              className="field"
              type="number"
              min={0}
              step="0.01"
              value={monthlyBudgetUsd}
              onChange={(e) => setMonthlyBudgetUsd(e.target.value)}
              style={{ width: 120 }}
            />
          </label>
        </div>
      </fieldset>

      <fieldset className="field-group">
        <legend>Shop</legend>
        <label style={{ display: "block" }}>
          Shop URL (your &ldquo;link in bio&rdquo;)
          <input
            className="field"
            type="url"
            inputMode="url"
            placeholder="https://…"
            value={shopUrl}
            onChange={(e) => setShopUrl(e.target.value)}
          />
          <span className="muted text-xs">
            Used as the shop CTA link when a synced product has no page of its own.
          </span>
        </label>
      </fieldset>

      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          💾 Save settings
        </button>
      </div>
      {ok && <p className="ok">{ok}</p>}
      {error && <p className="err">{error}</p>}
    </form>
  );
}
