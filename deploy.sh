#!/usr/bin/env bash
# One-step deploy of TripEx to Fly.io. Safe to run again: it skips steps already done.
#   cd tripex && bash deploy.sh
# Use a different app name if tripex-app is taken:  APP=my-tripex bash deploy.sh
set -euo pipefail

APP="${APP:-tripex-app}"
REGION="${REGION:-iad}"
URL="https://$APP.fly.dev"

say() { printf "\n\033[1m%s\033[0m\n" "$*"; }

# 1. Fly's command-line tool
if ! command -v fly >/dev/null 2>&1; then
  say "Installing the Fly command-line tool…"
  curl -fsSL https://fly.io/install.sh | sh
  export FLYCTL_INSTALL="$HOME/.fly"
  export PATH="$FLYCTL_INSTALL/bin:$PATH"
fi

# 2. Sign in (opens your browser; sign up there if you're new, Fly asks for a card)
if ! fly auth whoami >/dev/null 2>&1; then
  say "Opening your browser to sign in to Fly…"
  fly auth login
fi

# 3. The app
if ! fly status -a "$APP" >/dev/null 2>&1; then
  say "Creating the app $APP…"
  if ! fly apps create "$APP"; then
    echo "That name is taken. Pick another and rerun, e.g.:  APP=tripex-kiran bash deploy.sh"
    exit 1
  fi
fi

# 4. Storage for the database and receipt photos
if ! fly volumes list -a "$APP" 2>/dev/null | grep -q tripex_data; then
  say "Creating 1 GB of storage…"
  fly volumes create tripex_data --size 1 --region "$REGION" -a "$APP" --yes
fi

# 5. Secrets (asked once; your key is never printed)
SECRETS="$(fly secrets list -a "$APP" 2>/dev/null || true)"
if ! grep -q ANTHROPIC_API_KEY <<<"$SECRETS"; then
  say "Paste your Anthropic API key and press Enter (it won't show while you type):"
  read -rs KEY; echo
  PIN="$(od -An -N4 -tu4 /dev/urandom | tr -d " " | tail -c 7 | sed "s/^0*//" )"; PIN=$(printf "%06d" "${PIN:-0}")
  fly secrets set --stage -a "$APP" ANTHROPIC_API_KEY="$KEY" PUBLIC_URL="$URL" CREATE_PIN="$PIN" >/dev/null
  unset KEY
  say "Access code for starting trips: $PIN  (write this down)"
fi

# Always make sure links point at the live site (safe to repeat).
if ! grep -q PUBLIC_URL <<<"$SECRETS"; then
  fly secrets set --stage -a "$APP" PUBLIC_URL="$URL" >/dev/null
fi

# 6. Ship it (one machine, so it always uses the same storage)
say "Deploying… this takes a few minutes the first time."
fly deploy -a "$APP" --ha=false

say "TripEx is live: $URL"
command -v open >/dev/null 2>&1 && open "$URL" || true
