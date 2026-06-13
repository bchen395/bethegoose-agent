import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root so Turbopack doesn't infer it from a stray lockfile
  // in a parent directory.
  turbopack: { root: import.meta.dirname ?? process.cwd() },

  // Server-only secrets (ANTHROPIC_API_KEY, DATABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
  // CRON_SECRET) are read at runtime in server code; only NEXT_PUBLIC_* reach the browser.
};

export default nextConfig;
