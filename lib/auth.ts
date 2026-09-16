/**
 * lib/auth.ts — the email allow-list, in one place.
 *
 * This is the cost control: only allow-listed accounts may sign in or trigger a
 * paid agent run. Supabase magic-link sign-up is open by default, so without the
 * list ANY email that can receive a link would be able to spend API credits.
 *
 * FAIL CLOSED: an unset or empty ALLOWED_EMAILS denies everyone. A missing env
 * var must never be the thing that opens the app up. Set ALLOWED_EMAILS in
 * .env.local (and in Vercel) before signing in — see .env.example.
 *
 * Kept free of imports on purpose: proxy.ts runs in the middleware runtime and
 * must be able to pull this in without dragging `next/headers` along.
 */

/** Parsed at call time (not module load) so tests and local runs can vary it. */
function allowedEmails(): string[] {
  return (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** True only for a non-empty email that appears on a non-empty allow-list. */
export function isAllowedEmail(email: string | null | undefined): boolean {
  const list = allowedEmails();
  if (list.length === 0) return false; // fail closed — see the header note
  const normalized = (email ?? "").trim().toLowerCase();
  return normalized.length > 0 && list.includes(normalized);
}
