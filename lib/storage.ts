/**
 * lib/storage.ts — Supabase Storage helpers for post art (replaces data/art/).
 *
 * SERVER-ONLY. Uses the service-role key, so this module must never be imported
 * into client components (the key isn't inlined into the browser bundle, so an
 * accidental import fails safe rather than leaking the key — but keep it server-side).
 *
 * The bucket `art` is PRIVATE:
 *   - browsers upload directly via a signed upload URL (sidesteps Vercel's
 *     ~4.5 MB function body limit; photos of drawings exceed it),
 *   - the Content Agent fetches the bytes server-side for the image block,
 *   - the UI displays via short-lived signed URLs.
 *
 * Images only (MIGRATION.md §4): reels attach a still image; no video handling.
 */

import { createClient } from "@supabase/supabase-js";

export const ART_BUCKET = "art";

const DISPLAY_URL_TTL_SECONDS = 60 * 60; // 1 hour

const SUPPORTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

const EXT_TO_MEDIA_TYPE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Supabase storage is not configured — set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    );
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

/** Sanitize an uploaded filename stem: keep alnum/dot/dash/underscore. */
function sanitizeStem(stem: string): string {
  const cleaned = stem.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "");
  return cleaned || "art";
}

/**
 * Build the storage object key for a slot's art, mirroring the Python UI's
 * `slot{id}_{stem}.ext` naming so different slots never clobber each other.
 */
export function buildArtKey(slotId: number, originalName: string): string {
  const dot = originalName.lastIndexOf(".");
  const stem = dot > 0 ? originalName.slice(0, dot) : originalName;
  const ext = dot > 0 ? originalName.slice(dot + 1).toLowerCase() : "";
  const suffix = ext ? `.${ext}` : "";
  return `slot${slotId}_${sanitizeStem(stem)}${suffix}`;
}

/**
 * A signed URL the browser uploads to directly (no Vercel function in the path).
 * Returns the object key plus the token/url the client passes to
 * `supabase.storage.from(ART_BUCKET).uploadToSignedUrl(path, token, file)`.
 */
export async function createSignedUploadUrl(key: string): Promise<{
  key: string;
  token: string;
  signedUrl: string;
}> {
  const { data, error } = await admin()
    .storage.from(ART_BUCKET)
    .createSignedUploadUrl(key, { upsert: true }); // allow re-uploading to the same slot
  if (error || !data) {
    throw new Error(`Could not create signed upload URL for ${key}: ${error?.message}`);
  }
  return { key, token: data.token, signedUrl: data.signedUrl };
}

/**
 * Download an object's bytes for the Content Agent's image block. Replaces
 * `_resolve_art_path` + `read_bytes`. Returns bytes + a supported image media type.
 */
export async function fetchArtBytes(key: string): Promise<{ bytes: Buffer; mediaType: string }> {
  const { data, error } = await admin().storage.from(ART_BUCKET).download(key);
  if (error || !data) {
    throw new Error(`Art object not found in storage: ${key} (${error?.message})`);
  }
  const bytes = Buffer.from(await data.arrayBuffer());
  const ext = key.includes(".") ? key.slice(key.lastIndexOf(".") + 1).toLowerCase() : "";
  const mediaType = data.type && SUPPORTED_IMAGE_TYPES.has(data.type)
    ? data.type
    : EXT_TO_MEDIA_TYPE[ext];
  if (!mediaType || !SUPPORTED_IMAGE_TYPES.has(mediaType)) {
    throw new Error(
      `Unsupported image type for ${key}: ${data.type || ext || "unknown"} ` +
        `(supported: ${[...SUPPORTED_IMAGE_TYPES].join(", ")})`,
    );
  }
  return { bytes, mediaType };
}

/** Short-lived signed URL for displaying private art in the UI. */
export async function signedDisplayUrl(
  key: string,
  expiresIn = DISPLAY_URL_TTL_SECONDS,
): Promise<string> {
  const { data, error } = await admin()
    .storage.from(ART_BUCKET)
    .createSignedUrl(key, expiresIn);
  if (error || !data) {
    throw new Error(`Could not create display URL for ${key}: ${error?.message}`);
  }
  return data.signedUrl;
}
