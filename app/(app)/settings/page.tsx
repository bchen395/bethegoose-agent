import { getBrandVoice, getInstagramAccount, getSettings } from "@/lib/db";
import { authorizeUrl } from "@/lib/instagram";

import BrandVoiceForm from "../_components/BrandVoiceForm";
import InstagramConnect from "../_components/InstagramConnect";
import SettingsForm from "../_components/SettingsForm";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ ig?: string }>;
}) {
  const [{ ig }, settings, brandVoice, instagram] = await Promise.all([
    searchParams,
    getSettings(),
    getBrandVoice(),
    getInstagramAccount(),
  ]);

  return (
    <main>
      <h1>⚙️ Settings</h1>
      <p className="muted">
        The tuning knobs the Strategy Agent reads each run — plus the brand voice it mirrors.
      </p>

      {ig === "connected" && <p className="ok">✅ Instagram connected.</p>}
      {ig === "error" && (
        <p className="err">Couldn&apos;t connect Instagram — please try again.</p>
      )}

      {settings ? (
        <SettingsForm settings={settings} />
      ) : (
        <p className="muted">Settings row not found — run the seed first (`npm run seed`).</p>
      )}

      <BrandVoiceForm brandVoice={brandVoice} />

      <InstagramConnect account={instagram} authorizeUrl={authorizeUrl()} />
    </main>
  );
}
