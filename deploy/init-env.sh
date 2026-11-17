#!/usr/bin/env bash
# Creates the host's env file from mandate.env.template (readable by its owner only) and fills
# MCP_AUTH_TOKEN, CONSOLE_SERVICE_TOKEN and CONSOLE_MASTER_KEY with fresh random values, without printing
# them. On an env file from before workspaces it adds CONSOLE_MASTER_KEY and changes nothing else. Safe to run
# again: a value that is already set is kept, and every other line is left exactly as it is. The other
# values are yours to fill (see docs/hosting.md).
#
# MANDATE_ENV_FILE  the env file to create or complete (default: .env next to this script, which docker
#                   compose reads by itself)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
env_file="${MANDATE_ENV_FILE:-$here/.env}"
umask 077

if [ ! -f "$env_file" ]; then
  cp "$here/mandate.env.template" "$env_file"
  echo "Created $env_file from mandate.env.template."
fi
chmod 600 "$env_file"

# Sets KEY to a new random value, unless it already has one. The value travels in the environment, never on
# a command line, so no other user can read it from the process list. The new file is written next to the
# old one and moved over it, so the env file is never half written.
fill_token() {
  local key="$1"
  if grep -Eq "^${key}=.+" "$env_file"; then
    echo "${key} is already set; kept it."
    return
  fi
  local temp
  temp="$(mktemp "$env_file.XXXXXX")"
  TOKEN="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')" KEY="$key" awk '
    BEGIN { key = ENVIRON["KEY"]; value = ENVIRON["TOKEN"]; done = 0 }
    index($0, key "=") == 1 { print key "=" value; done = 1; next }
    { print }
    END { if (!done) print key "=" value }
  ' "$env_file" >"$temp"
  mv "$temp" "$env_file"
  echo "${key} created."
}

fill_token MCP_AUTH_TOKEN
fill_token CONSOLE_SERVICE_TOKEN
# 32 random bytes, which the console reads as base64url. It seals the agents' keys: back it up, never change it.
fill_token CONSOLE_MASTER_KEY

echo "Next: fill MANDATE_HOST and X402_SELLER_ADDRESS in $env_file, start the stack, then claim the first"
echo "workspace with a one-time code (docs/hosting.md)."
