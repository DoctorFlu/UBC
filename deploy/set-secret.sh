#!/usr/bin/env bash
# Sets one secret in the env file, for values the owner copies from another product (a webhook URL, an API
# key) or from another machine (the Arc testnet keys `npm run arc:keygen` made), so that the value never
# passes through a person, a terminal's output, shell history or a process argument list:
#
#   pbpaste | deploy/set-secret.sh GROK_WEBHOOK_URL       # from standard input (one trailing newline is dropped)
#   deploy/set-secret.sh GROK_WEBHOOK_KEY                 # from a terminal: asks, and shows nothing typed
#
# Only the names on the allow-list below are accepted; the tokens and keys the stack generates
# (deploy/init-env.sh) are never set by hand.
# The value must be printable ASCII without a single quote, with no space at either end; GROK_WEBHOOK_URL
# must also start with https:// and hold no space, and AGENT_PRIVATE_KEY and EXECUTOR_PRIVATE_KEY must be
# 0x and 64 hex digits, and QUICKNODE_STREAM_SECURITY_TOKEN at least 32 characters. Anything else is
# refused and nothing changes.
#
# The line is written as NAME='value': single quotes make docker compose take the value literally (no "$"
# interpolation, no " #" comment). The file is rebuilt next to itself (mode 600) by bash alone and moved over
# the old one, so it is never half written; a failure removes the temporary file. Only the name, the
# value's length and the start of its SHA-256 are printed, never the value.
#
# MANDATE_ENV_FILE   the env file to update (default: .env next to this script)
set +x
set -euo pipefail
export LC_ALL=C
here="$(cd "$(dirname "$0")" && pwd)"
env_file="${MANDATE_ENV_FILE:-$here/.env}"
umask 077

ALLOWED="GROK_WEBHOOK_URL GROK_WEBHOOK_KEY GEMINI_API_KEY GEMINI_API_SECRET AGENT_PRIVATE_KEY EXECUTOR_PRIVATE_KEY QUICKNODE_STREAM_SECURITY_TOKEN"
MAX_BYTES=8192

usage() {
  echo "Usage: $(basename "$0") NAME, with the value on standard input or typed at the prompt." >&2
  echo "NAME is one of: $ALLOWED" >&2
  exit 2
}

[ "$#" -eq 1 ] || usage
name="$1"
case " $ALLOWED " in
  *" $name "*) ;;
  *)
    # Not echoed: a value pasted here by mistake must not be shown.
    echo "That name cannot be set with this script." >&2
    usage
    ;;
esac

if [ -L "$env_file" ] || [ ! -f "$env_file" ]; then
  echo "$env_file is not a regular file. Run deploy/init-env.sh first; a symlink is not followed." >&2
  exit 1
fi
if [ ! -O "$env_file" ]; then
  echo "$env_file belongs to another user; run this as its owner so it keeps its owner." >&2
  exit 1
fi
count="$(grep -c "^$name=" "$env_file" || true)"
if [ "${count:-0}" -gt 1 ]; then
  echo "$env_file has $count lines for $name; remove all but one by hand. Nothing changed." >&2
  exit 1
fi

refuse() {
  unset value
  echo "$name: $1 Nothing changed." >&2
  exit 1
}

# The value lives only in this shell's memory: read and printf are builtins, so it never reaches another
# process's arguments or environment, and no here-document (which bash may back with a file) is used.
value=""
if [ -t 0 ]; then
  IFS= read -r -s -p "Paste the value for $name (nothing is shown), then press Enter: " value || true
  echo >&2
else
  # Up to MAX_BYTES + 2 bytes (the value, its newline and one more) or a NUL byte, whichever comes first; a
  # status of 0 means one of those stopped it rather than the end of the input.
  if IFS= read -r -d '' -n "$((MAX_BYTES + 2))" value; then
    if [ "${#value}" -gt "$((MAX_BYTES + 1))" ]; then refuse "the value is longer than $MAX_BYTES bytes."; fi
    refuse "the value contains a NUL byte."
  fi
  value="${value%$'\n'}"
fi

[ -n "$value" ] || refuse "the value is empty."
[ "${#value}" -le "$MAX_BYTES" ] || refuse "the value is longer than $MAX_BYTES bytes."
case "$value" in
  *[[:cntrl:]]*) refuse "the value contains a line break, tab or other control character." ;;
  *[![:print:]]*) refuse "the value contains a character outside printable ASCII (for example a non-breaking space)." ;;
  " "* | *" ") refuse "the value starts or ends with a space; copy it again without it." ;;
  *"'"*) refuse "the value contains a single quote, which the env file cannot hold." ;;
esac
if [ "$name" = GROK_WEBHOOK_URL ]; then
  case "$value" in
    *" "*) refuse "the URL contains a space." ;;
    https://?*) ;;
    *) refuse "the URL must start with https://." ;;
  esac
fi
case "$name" in
  AGENT_PRIVATE_KEY | EXECUTOR_PRIVATE_KEY)
    if [ "${#value}" -ne 66 ]; then refuse "a private key is 0x and 64 hex digits."; fi
    case "$value" in
      0x*) ;;
      *) refuse "a private key is 0x and 64 hex digits." ;;
    esac
    case "${value#0x}" in
      *[!0-9a-fA-F]*) refuse "a private key is 0x and 64 hex digits." ;;
    esac
    ;;
  QUICKNODE_STREAM_SECURITY_TOKEN)
    if [ "${#value}" -lt 32 ]; then refuse "the Stream's security token is at least 32 characters."; fi
    ;;
esac

sha256_short() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi | cut -c1-12
}
length="${#value}"
digest="$(printf '%s' "$value" | sha256_short)"

temp=""
cleanup() {
  if [ -n "$temp" ]; then rm -f "$temp"; fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
temp="$(mktemp "$env_file.XXXXXX")"
chmod 600 "$temp"
# Opened with exec, whose failure ends the script (and the trap removes the temporary file); a failed
# redirection on the loop itself would not stop it, and an empty copy would replace the env file.
exec 3<"$env_file"
exec 4>"$temp"

found=0
ended_with_newline=1
while :; do
  if IFS= read -r line <&3; then
    newline=$'\n'
  else
    [ -n "$line" ] || break
    newline=""
  fi
  case "$line" in
    "$name="*)
      printf "%s='%s'%s" "$name" "$value" "$newline" >&4
      found=1
      ;;
    *) printf '%s%s' "$line" "$newline" >&4 ;;
  esac
  if [ -z "$newline" ]; then
    ended_with_newline=0
    break
  fi
done
if [ "$found" -eq 0 ]; then
  if [ "$ended_with_newline" -eq 0 ]; then printf '\n' >&4; fi
  printf "%s='%s'\n" "$name" "$value" >&4
fi
unset value
exec 3<&- 4>&-
# A last guard against a short copy: the new file has exactly the old file's lines, plus the appended one.
want="$(wc -l <"$env_file")"
if [ "$found" -eq 0 ]; then want=$((want + 2 - ended_with_newline)); fi
if [ "$(wc -l <"$temp")" -ne "$want" ]; then
  echo "Rebuilding $env_file did not give the expected number of lines. Nothing changed." >&2
  exit 1
fi

mv -f "$temp" "$env_file"
temp=""
echo "$name set in $env_file: $length characters, sha256 $digest."
