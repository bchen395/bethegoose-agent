/**
 * proxy.ts — refresh the Supabase session on every request, redirect unauthorized
 * traffic to /login, and enforce the email allow-list (the cost control — only
 * allow-listed accounts can trigger API spend). Guards /api/* agent routes too.
 * The cron route is exempt: it authenticates with CRON_SECRET.
 *
 * (Next 16 renamed the `middleware` file convention to `proxy`.)
 */

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // IMPORTANT: getUser() refreshes the session; don't run logic between this and
  // the response return that could short-circuit the cookie write.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  // Public paths: the login page, the magic-link callback, and the cron route
  // (which guards itself with CRON_SECRET).
  const isPublic =
    path.startsWith("/login") || path.startsWith("/auth") || path.startsWith("/api/cron");

  const email = (user?.email ?? "").toLowerCase();
  const isAllowed = !!user && (ALLOWED_EMAILS.length === 0 || ALLOWED_EMAILS.includes(email));

  if (!isAllowed && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    if (user && !isAllowed) url.searchParams.set("denied", "1"); // logged in but not allow-listed
    return NextResponse.redirect(url);
  }

  if (isAllowed && path.startsWith("/login")) {
    const url = request.nextUrl.clone();
    url.pathname = "/calendar";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  // Run on everything except Next internals and static image assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
