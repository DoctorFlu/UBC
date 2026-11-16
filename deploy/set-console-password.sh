#!/usr/bin/env bash
# Sets the owner's console password. It asks for the password twice without echoing it, hashes it with Caddy
# (bcrypt), and stores only the hash in deploy/.env as CONSOLE_PASSWORD_HASH, base64-encoded so it holds no
# "$" for docker compose to misread. The password itself is never written anywhere and never passed on a
# command line. Run it again to change the password, then `docker compose up -d` to apply it.
set -euo pipefail
cd "$(dirname "$0")"
umask 077

if [ ! -f .env ]; then
  echo "deploy/.env does not exist yet. Run deploy/init-env.sh first." >&2
  exit 1
fi

# The Caddy image compose.yml pins, so the hash is made by the same Caddy that checks it.
caddy_image="$(sed -n 's/^ *image: \(caddy:[^ ]*\)$/\1/p' compose.yml)"
if [ -z "$caddy_image" ]; then
  echo "Could not find the Caddy image in compose.yml." >&2
  exit 1
fi

read -r -s -p "New console password for the owner (at least 16 characters): " password
echo
read -r -s -p "The same password again: " again
echo
if [ "$password" != "$again" ]; then
  echo "The two passwords differ; nothing changed." >&2
  exit 1
fi
if [ "${#password}" -lt 16 ]; then
  echo "Use at least 16 characters; nothing changed." >&2
  exit 1
fi

hash="$(printf '%s\n' "$password" | docker run --rm -i "$caddy_image" caddy hash-password)"
unset password again
encoded="$(printf '%s' "$hash" | base64 | tr -d '\n')"

temp="$(mktemp .env.XXXXXX)"
HASH="$encoded" awk '
  BEGIN { key = "CONSOLE_PASSWORD_HASH"; value = ENVIRON["HASH"]; done = 0 }
  index($0, key "=") == 1 { print key "=" value; done = 1; next }
  { print }
  END { if (!done) print key "=" value }
' .env >"$temp"
mv "$temp" .env
chmod 600 .env
echo "CONSOLE_PASSWORD_HASH set. Apply it with: docker compose up -d"
