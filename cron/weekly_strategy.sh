#!/usr/bin/env bash
#
# cron/weekly_strategy.sh — Step 8: the Monday-morning cron job.
#
# Runs the Strategy Agent's weekly plan (agents/strategy_agent.py) so a fresh
# calendar is waiting when the artist opens the app. The UI's "Run weekly plan
# now" button remains the fallback for when the laptop is asleep at cron time.
#
# It resolves its own location, so the crontab line only needs the absolute path
# to this script — no `cd` required in cron, and it works whatever the CWD.
#
# Install it (runs every Monday at 8:00 AM local time):
#
#   crontab -e
#   # then add this line (one line, absolute path):
#   0 8 * * 1 /Users/bensonchen/repos/bethegoose-agent/cron/weekly_strategy.sh
#
# Verify what's installed:  crontab -l
# Watch the log:            tail -f /Users/bensonchen/repos/bethegoose-agent/data/logs/weekly_strategy.log
#
# Notes:
#   - cron runs with a minimal PATH and no shell profile, so this script picks a
#     Python interpreter explicitly (see below) rather than trusting `python3`.
#   - The Anthropic API key is read from the project's .env by utils/claude.py
#     via an absolute path, so it does not need to be exported here.
#   - On macOS, cron needs Full Disk Access (System Settings > Privacy &
#     Security) to read files under your home folder. If runs silently do
#     nothing, grant `/usr/sbin/cron` that permission, or use `launchd` instead.

set -uo pipefail

# --- Resolve the project root from this script's own location ----------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT" || { echo "cannot cd to project root: $PROJECT_ROOT" >&2; exit 1; }

# --- Choose a Python interpreter ---------------------------------------------
# Priority: explicit override > project venv > python3 on PATH. Set
# ART_AGENT_PYTHON in the crontab line if your interpreter lives elsewhere:
#   0 8 * * 1 ART_AGENT_PYTHON=/usr/local/bin/python3 /…/cron/weekly_strategy.sh
if [ -n "${ART_AGENT_PYTHON:-}" ]; then
  PYTHON_BIN="$ART_AGENT_PYTHON"
elif [ -x "$PROJECT_ROOT/.venv/bin/python" ]; then
  PYTHON_BIN="$PROJECT_ROOT/.venv/bin/python"
elif [ -x "$PROJECT_ROOT/venv/bin/python" ]; then
  PYTHON_BIN="$PROJECT_ROOT/venv/bin/python"
else
  PYTHON_BIN="$(command -v python3 || true)"
fi

if [ -z "$PYTHON_BIN" ]; then
  echo "no python3 found — set ART_AGENT_PYTHON to your interpreter" >&2
  exit 1
fi

# --- Run, logging everything (stdout + stderr) to a dated, gitignored log ----
# data/ is gitignored, so the log never lands in version control.
LOG_DIR="$PROJECT_ROOT/data/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/weekly_strategy.log"

{
  echo "===== $(date '+%Y-%m-%d %H:%M:%S %Z') — weekly strategy plan ====="
  echo "python: $PYTHON_BIN"
  "$PYTHON_BIN" agents/strategy_agent.py
  status=$?
  if [ "$status" -eq 0 ]; then
    echo "----- completed OK -----"
  else
    echo "----- FAILED (exit $status) — UI 'Run weekly plan now' is the fallback -----"
  fi
  echo
  exit "$status"
} >> "$LOG_FILE" 2>&1
