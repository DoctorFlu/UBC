#!/usr/bin/env bash
# Sets the owner's console password. It asks for the password twice without echoing it, hashes it with Caddy
# (bcrypt), and stores only the hash in the env file as CONSOLE_PASSWORD_HASH, base64-encoded so it holds no
# "$" for docker compose to misread. The password itself is never written anywhere and never passed on a
# command line. Run it again to change the password, then `docker compose up -d` to apply it.
#
# MANDATE_ENV_FILE       the env file to update (default: .env next to this script)
# MANDATE_HASH_COMMAND   for tests only: a shell command that reads the password on stdin and prints its
#                        bcrypt hash, instead of the pinned Caddy image's `caddy hash-password`
#
# Without a terminal it reads the password and its repetition as two lines on stdin.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
env_file="${MANDATE_ENV_FILE:-$here/.env}"
umask 077

if [ ! -f "$env_file" ]; then
  echo "$env_file does not exist yet. Run deploy/init-env.sh first." >&2
  exit 1
fi

hash_password() {
  if [ -n "${MANDATE_HASH_COMMAND:-}" ]; then
    sh -c "$MANDATE_HASH_COMMAND"
    return
  fi
  # The Caddy image compose.yml pins, so the hash is made by the same Caddy that checks it.
  local caddy_image
  caddy_image="$(sed -n 's/^ *image: \(caddy:[^ ]*\)$/\1/p' "$here/compose.yml")"
  if [ -z "$caddy_image" ]; then
    echo "Could not find the Caddy image in compose.yml." >&2
    return 1
  fi
  docker run --rm -i "$caddy_image" caddy hash-password
}

# IFS= keeps leading and trailing spaces, -r keeps backslashes: the password is exactly what was typed.
IFS= read -r -s -p "New console password for the owner (at least 16 characters): " password || true
echo
IFS= read -r -s -p "The same password again: " again || true
echo
if [ "$password" != "$again" ]; then
  unset password again
  echo "The two passwords differ; nothing changed." >&2
  exit 1
fi
if [ "${#password}" -lt 16 ]; then
  unset password again
  echo "Use at least 16 characters; nothing changed." >&2
  exit 1
fi

hash="$(printf '%s\n' "$password" | hash_password)"
unset password again
case "$hash" in
  '$2a$'* | '$2b$'* | '$2y$'*) ;;
  *)
    echo "Hashing the password did not return a bcrypt hash; nothing changed." >&2
    exit 1
    ;;
esac
encoded="$(printf '%s' "$hash" | base64 | tr -d '\n')"

# Written next to the env file and moved over it, so the file is never half written.
temp="$(mktemp "$env_file.XXXXXX")"
HASH="$encoded" awk '
  BEGIN { key = "CONSOLE_PASSWORD_HASH"; value = ENVIRON["HASH"]; done = 0 }
  index($0, key "=") == 1 { print key "=" value; done = 1; next }
  { print }
  END { if (!done) print key "=" value }
' "$env_file" >"$temp"
mv "$temp" "$env_file"
chmod 600 "$env_file"
if [ -n "${MANDATE_ENV_FILE:-}" ]; then
  echo "CONSOLE_PASSWORD_HASH set in $env_file. Apply it with: docker compose --env-file $env_file up -d"
else
  echo "CONSOLE_PASSWORD_HASH set in $env_file. Apply it with: docker compose up -d"
fi
