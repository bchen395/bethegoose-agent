/**
 * lib/supabase/server.ts — Supabase client for Server Components, Server
 * Actions, and Route Handlers (cookie-backed session via @supabase/ssr), plus
 * requireUser(): the per-call authorization gate.
 */

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { isAllowedEmail } from "@/lib/auth";

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Called from a Server Component (read-only cookies). Safe to ignore —
            // the middleware refreshes the session cookie on every request.
          }
        },
      },
    },
  );
}

/**
 * Assert the caller is a signed-in, allow-listed account; return their user.
 *
 * Defense in depth. proxy.ts already redirects unauthorized traffic, but that is
 * ONE gate, enforced by a path matcher — edit the matcher, add a route outside
 * it, or hit a framework bug in the middleware layer (cf. CVE-2025-29927) and
 * every mutation and every paid agent run would be wide open. So every server
 * action and agent route calls this too. Cost: one cached getUser() per call.
 *
 * Throws rather than redirecting: these are called from actions and route
 * handlers where an exception is the right failure, and the proxy has already
 * handled the friendly "you are logged out" redirect for real browser traffic.
 */
export async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !isAllowedEmail(user.email)) {
    throw new Error("Not authorized.");
  }
  return user;
}
