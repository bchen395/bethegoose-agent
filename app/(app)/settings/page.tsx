import { getBrandVoice, getSettings } from "@/lib/db";

import BrandVoiceForm from "../_components/BrandVoiceForm";
import SettingsForm from "../_components/SettingsForm";

export default async function SettingsPage() {
  const [settings, brandVoice] = await Promise.all([getSettings(), getBrandVoice()]);
  return (
    <main>
      <h1>⚙️ Settings</h1>
      <p className="muted">
        The tuning knobs the three agents read each run — plus the brand voice they mirror.
      </p>

      {settings ? (
        <SettingsForm settings={settings} />
      ) : (
        <p className="muted">Settings row not found — run the seed first (`npm run seed`).</p>
      )}

      <BrandVoiceForm brandVoice={brandVoice} />

      {/*
        Item #1 (Instagram stats auto-pull) will add a "Connect Instagram" button here,
        backed by the OAuth callback route. Deferred until that item is built.
      */}
    </main>
  );
}
