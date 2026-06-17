#!/usr/bin/env bash
# scripts/vercel-env.sh — push the app's runtime env vars to Vercel.
#
# Reads values from .env.local and pipes each to `vercel env add` so secrets never
# appear in your shell history or any transcript. Run AFTER `vercel link`.
#
# Usage:  bash scripts/vercel-env.sh [production|preview|development]
#         (defaults to production)
#
# DIRECT_URL is deliberately NOT pushed — it's only for local `npm run db:push`.
# The app connects through the pooled DATABASE_URL at runtime.

set -euo pipefail

TARGET="${1:-production}"
ENV_FILE="$(dirname "$0")/../.env.local"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found" >&2
  exit 1
fi

if ! command -v vercel >/dev/null 2>&1; then
  echo "error: vercel CLI not found. Install with: npm i -g vercel" >&2
  exit 1
fi

# The 8 vars the deployed app needs. (No DIRECT_URL.)
VARS=(
  DATABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  CRON_SECRET
  ANTHROPIC_API_KEY
  NEXT_PUBLIC_SUPABASE_URL
  NEXT_PUBLIC_SUPABASE_ANON_KEY
  ALLOWED_EMAILS
  STRIPE_SECRET_KEY
)

# Pull a single var's value out of .env.local (everything after the first '=').
read_var() {
  local key="$1"
  # grep the first matching assignment; strip "key=" prefix; trim surrounding quotes.
  local line
  line="$(grep -m1 "^${key}=" "$ENV_FILE" || true)"
  [[ -z "$line" ]] && return 1
  local val="${line#${key}=}"
  val="${val%\"}"; val="${val#\"}"
  printf '%s' "$val"
}

echo "Pushing ${#VARS[@]} env vars to Vercel ($TARGET scope)…"
for key in "${VARS[@]}"; do
  if ! value="$(read_var "$key")"; then
    echo "  ! $key missing from .env.local — skipped" >&2
    continue
  fi
  # Remove any existing value first so this is idempotent (ignore if absent).
  vercel env rm "$key" "$TARGET" --yes >/dev/null 2>&1 || true
  printf '%s' "$value" | vercel env add "$key" "$TARGET" >/dev/null
  echo "  ✓ $key"
done

echo "Done. Verify with: vercel env ls"
