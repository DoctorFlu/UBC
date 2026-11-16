#!/usr/bin/env bash
# Creates deploy/.env from mandate.env.template (readable by its owner only) and fills MCP_AUTH_TOKEN and
# CONSOLE_SERVICE_TOKEN with fresh random values, without printing them. Safe to run again: a token that is
# already set is kept. The other values are yours to fill (see docs/hosting.md).
set -euo pipefail
cd "$(dirname "$0")"
umask 077

if [ ! -f .env ]; then
  cp mandate.env.template .env
  echo "Created deploy/.env from mandate.env.template."
fi
chmod 600 .env

# Sets KEY to a new random value, unless it already has one. The value travels in the environment, never on
# a command line, so no other user can read it from the process list.
fill_token() {
  local key="$1"
  if grep -Eq "^${key}=.+" .env; then
    echo "${key} is already set; kept it."
    return
  fi
  local temp
  temp="$(mktemp .env.XXXXXX)"
  TOKEN="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')" KEY="$key" awk '
    BEGIN { key = ENVIRON["KEY"]; value = ENVIRON["TOKEN"]; done = 0 }
    index($0, key "=") == 1 { print key "=" value; done = 1; next }
    { print }
    END { if (!done) print key "=" value }
  ' .env >"$temp"
  mv "$temp" .env
  echo "${key} created."
}

fill_token MCP_AUTH_TOKEN
fill_token CONSOLE_SERVICE_TOKEN

echo "Next: fill MANDATE_HOST and X402_SELLER_ADDRESS in deploy/.env, then run deploy/set-console-password.sh."
