/**
 * scripts/seed.ts — populate the single-row config tables (settings, brand_voice).
 *
 * Port of scripts/seed_settings.py + scripts/seed_brand_voice.py into one
 * tsx-runnable seed. Re-running is safe (upsert overwrites row 1). Run with:
 *     npm run seed
 *
 * ⚠ Placeholders to confirm with the artist (carried over from PROGRESS.md /
 * FEATURES.md): brand_voice.snail_mail_pitch, brand_voice.avoid_phrases,
 * settings.default_post_time, and the FEATURES.md tunables settings.monthly_budget_usd
 * and settings.weekly_mix are sensible starter guesses, not her confirmed values.
 *
 * NOTE: env is loaded *before* importing lib/db (which builds the postgres client
 * from DATABASE_URL). ESM hoists static imports, so lib/db is imported dynamically.
 */

try {
  process.loadEnvFile(".env.local");
} catch {
  // env may already be set
}

// --- settings (port of seed_settings.py + FEATURES.md §1 columns) -----------

const SETTINGS = {
  id: 1,
  timezone: "America/New_York", // all slot_time values are stored in this zone
  hashtagCountMin: 3, // Instagram 2026: lean, hyper-relevant tags win;
  hashtagCountMax: 5, // >5 can read as low-intent.
  defaultPostTime: "18:30", // ⚠ 6:30 PM ET fallback — confirm her real best window
  reelsRequired: false, // aim for a reel only when she has footage (not forced)

  // FEATURES.md §1 tunables (defaulted; ⚠ confirm monthlyBudgetUsd + weeklyMix)
  weeklyMix: { reel: 3, carousel: 2, static: 1 } as Record<string, number>, // ⚠
  webSearchCadence: "monthly",
  lastWebSearchAt: null as string | null,
  monthlyBudgetUsd: "5", // ⚠
  captionStartersEnabled: false,
};

// --- brand_voice (verbatim port of seed_brand_voice.py) ---------------------

const ARTIST_NAME = "Be The Goose (@bethegoose)";

const TONE_DESCRIPTION =
  "Warm, casual, and enthusiastic — she writes the way she texts a friend. " +
  "Heavy on exclamation points, often doubled or tripled (!!, !!!). Personal " +
  "and a little vulnerable (happy to say when she's nervous or ask her audience " +
  "for help). Playful, slightly absurd sense of humor. Frequently references her " +
  "own pets, family pets, and commission subjects by name. Never salesy or " +
  "corporate. Her comics post under 'The Daily Dog' / 'Daily Dog Presents'; the " +
  "overall account is 'Be The Goose'. Daily doodles are often captioned as a " +
  "playful one-liner labeling the character.";

const EXAMPLE_CAPTIONS = [
  "Read left to right!",
  "Read left to right!!",
  "Commission done for my mom ❤️ Penelope loves bird hunting!",
  "I'm trying out some new layouts for my comics!",
  "Commission for my sisters cat calypso!!",
  "My daily doodle: the best lawyer in town!",
  "Come out and support!!! I'm super nervous, any tips from other vendors " +
    "would be greatly appreciated!!",
  "She loves the stinkiest stuffed animal carcasses",
];

// ⚠ Inferred defaults — REVIEW WITH HER (not things she told us to avoid).
const AVOID_PHRASES = [
  "link in bio",
  "don't miss out",
  "grab yours today",
  "limited time offer",
  "shop now",
  "buy now",
  "act fast",
  "exclusive deal",
];

// ⚠ PLACEHOLDER — she did not provide a snail-mail pitch. Replace before relying
// on any snail-mail CTA output.
const SNAIL_MAIL_PITCH =
  "[PLACEHOLDER — replace with her words] Every month I mail out a little packet " +
  "of original doodles, a sticker or two, and a handwritten note — basically happy " +
  "mail straight from my desk to yours!";

const BRAND_VOICE = {
  id: 1,
  artistName: ARTIST_NAME,
  toneDescription: TONE_DESCRIPTION,
  exampleCaptions: EXAMPLE_CAPTIONS,
  avoidPhrases: AVOID_PHRASES,
  snailMailPitch: SNAIL_MAIL_PITCH,
};

async function main() {
  const { db } = await import("../lib/db");
  const { settings, brandVoice } = await import("../lib/db/schema");

  await db
    .insert(settings)
    .values(SETTINGS)
    .onConflictDoUpdate({ target: settings.id, set: SETTINGS });

  await db
    .insert(brandVoice)
    .values(BRAND_VOICE)
    .onConflictDoUpdate({ target: brandVoice.id, set: BRAND_VOICE });

  console.log("Seeded settings + brand_voice.");
  console.log(
    `  timezone: ${SETTINGS.timezone}, hashtags: ${SETTINGS.hashtagCountMin}-${SETTINGS.hashtagCountMax}`,
  );
  console.log(`  artist:   ${ARTIST_NAME}`);
  console.log(
    `  example_captions: ${EXAMPLE_CAPTIONS.length}, avoid_phrases: ${AVOID_PHRASES.length} (⚠ review with her)`,
  );
  if (SNAIL_MAIL_PITCH.startsWith("[PLACEHOLDER")) {
    console.log("  ⚠ snail_mail_pitch is a PLACEHOLDER — replace before using snail-mail CTAs");
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
