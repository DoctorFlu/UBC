#!/usr/bin/env bash
# Checks a hosted Mandate from the outside, the way Grok Bot, QuickNode and the owner's browser reach it.
#
#   deploy/smoke.sh https://<host>
#
# Reads its secrets from the environment, never from the command line, and never prints them:
#   MCP_AUTH_TOKEN    the MCP server's bearer token (required)
#   CONSOLE_PASSWORD  the owner's console password (required)
#   CONSOLE_USER      the owner's user name (default owner)
#   SMOKE_CA_CERT     a CA certificate to trust, for a host with a private certificate (localhost)
#
# It only reads and asks; it changes nothing. Exits 0 when every check passes.
set -uo pipefail

base="${1:-}"
if [ -z "$base" ]; then
  echo "usage: deploy/smoke.sh https://<host>" >&2
  exit 2
fi
base="${base%/}"
: "${MCP_AUTH_TOKEN:?set MCP_AUTH_TOKEN in the environment}"
: "${CONSOLE_PASSWORD:?set CONSOLE_PASSWORD in the environment}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
chmod 700 "$work"

# Credentials go to curl in header files (mode 600), so they never appear in the process list.
printf 'Authorization: Bearer %s\n' "$MCP_AUTH_TOKEN" >"$work/mcp-auth"
printf 'Authorization: Basic %s\n' \
  "$(printf '%s:%s' "${CONSOLE_USER:-owner}" "$CONSOLE_PASSWORD" | base64 | tr -d '\n')" >"$work/owner-auth"
: >"$work/none"
printf 'Authorization: Basic %s\n' "$(printf '%s:%s' "${CONSOLE_USER:-owner}" not-the-password | base64 | tr -d '\n')" \
  >"$work/wrong-auth"

curl_opts=(--silent --show-error --max-time 20 --output "$work/body" --dump-header "$work/headers")
if [ -n "${SMOKE_CA_CERT:-}" ]; then
  curl_opts+=(--cacert "$SMOKE_CA_CERT")
fi

failures=0
pass() { printf 'ok    %s\n' "$1"; }
fail() {
  printf 'FAIL  %s\n' "$1"
  failures=$((failures + 1))
}

# request <auth file> <method> <path> [curl args...]: sets $status; the body is in $work/body.
request() {
  local auth="$1" method="$2" path="$3"
  shift 3
  status="$(curl "${curl_opts[@]}" --header @"$work/$auth" --request "$method" --write-out '%{http_code}' "$@" \
    "$base$path" 2>"$work/error")" || status="000"
}

has_basic_challenge() { grep -qi '^www-authenticate: *basic' "$work/headers"; }

# expect <label> <auth> <method> <path> <status> [curl args...]
expect() {
  local label="$1" auth="$2" method="$3" path="$4" want="$5"
  shift 5
  request "$auth" "$method" "$path" "$@"
  if [ "$status" = "$want" ]; then
    pass "$label ($method $path -> $status)"
  else
    fail "$label ($method $path -> $status, expected $want) $(head -c 200 "$work/error")"
  fi
}

mcp_initialize='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mandate-hosting-smoke","version":"0"}}}'
mcp_headers=(--header "Content-Type: application/json" --header "Accept: application/json, text/event-stream")

echo "Mandate smoke test against $base"

echo "-- health, public"
expect "console health" none GET /api/health 200
grep -q '"status":"ok"' "$work/body" || fail "console health body says ok"
expect "MCP server health" none GET /mcp/health 200
grep -q '"status":"ok"' "$work/body" || fail "MCP health body says ok"

echo "-- MCP server: its own bearer token"
expect "MCP refuses a request without the token" none POST /mcp 401 "${mcp_headers[@]}" --data-binary "$mcp_initialize"
if has_basic_challenge; then fail "MCP's 401 comes from the MCP server, not the owner login"; fi
expect "MCP answers with the token" mcp-auth POST /mcp 200 "${mcp_headers[@]}" --data-binary "$mcp_initialize"
if grep -q '"serverInfo"' "$work/body"; then
  pass "MCP initialize returns serverInfo"
else
  fail "MCP initialize returns serverInfo"
fi

echo "-- owner routes: the owner's login"
for path in / /hedge /hedge/plans/smoke-test /setup /api/console/snapshot; do
  expect "owner route refuses without the login" none GET "$path" 401
  has_basic_challenge || fail "the 401 on $path asks for the owner login"
done
expect "owner route refuses a wrong password" wrong-auth GET /api/console/snapshot 401
expect "console home with the login" owner-auth GET / 200
expect "snapshot with the login" owner-auth GET /api/console/snapshot 200
snapshot="$(cat "$work/body")"
# A stream never ends, so curl stops at --max-time; what matters is the status, the type and a first event.
curl "${curl_opts[@]}" --max-time 3 --header @"$work/owner-auth" "$base/api/console/events" >/dev/null 2>&1
if grep -q '^HTTP/[0-9.]* 200' "$work/headers" && grep -qi '^content-type: *text/event-stream' "$work/headers" &&
  grep -q '^data:' "$work/body"; then
  pass "live events stream through the proxy with the login (GET /api/console/events)"
else
  fail "live events stream through the proxy with the login (GET /api/console/events)"
fi
expect "a cross-site write is refused even with the login" owner-auth PUT /api/console/holdings 403 \
  --header "Sec-Fetch-Site: cross-site" --header "Sec-Fetch-Mode: cors" \
  --header "Content-Type: application/json" --data-binary '{}'

echo "-- public routes"
agent="$(printf '%s' "$snapshot" | sed -n 's/.*"roles":{[^}]*"agent":"\(0x[0-9a-fA-F]\{40\}\)".*/\1/p')"
if [ -n "$agent" ]; then
  expect "public scorecard without a login" none GET "/agent/$agent" 200
  grep -q '/_next/static/' "$work/body" || fail "the scorecard page loads its assets"
  asset="$(sed -n 's/.*\(\/_next\/static\/[^"]*\.js\)".*/\1/p' "$work/body" | head -n 1)"
  [ -n "$asset" ] && expect "the scorecard's scripts without a login" none GET "$asset" 200
else
  fail "the snapshot names the contract's agent (is the chain connected?)"
fi
# 401 for a delivery without a valid signature, or 503 while QUICKNODE_STREAM_SECURITY_TOKEN is unset.
request none POST /api/webhooks/quicknode --header "Content-Type: application/json" --data-binary '{"data":[]}'
if { [ "$status" = "401" ] || [ "$status" = "503" ]; } && ! has_basic_challenge; then
  pass "QuickNode webhook is public and checks its own signature (POST /api/webhooks/quicknode -> $status)"
else
  fail "QuickNode webhook is public and checks its own signature (POST /api/webhooks/quicknode -> $status)"
fi

echo "-- internal only"
expect "the console's agent API is not public" mcp-auth GET /api/agent/v1/holdings 404

if printf '%s' "$snapshot" | grep -q '"kind":"local"'; then
  echo "-- demo chain: the browser's RPC"
  rpc='{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}'
  expect "/rpc refuses without the login" none POST /rpc 401 --header "Content-Type: application/json" --data-binary "$rpc"
  expect "/rpc with the login" owner-auth POST /rpc 200 --header "Content-Type: application/json" --data-binary "$rpc"
  if grep -q '"result":"0x4cef52"' "$work/body"; then
    pass "/rpc reaches the demo chain (chain id 5042002)"
  else
    fail "/rpc reaches the demo chain (chain id 5042002)"
  fi
fi

if [ "$failures" -eq 0 ]; then
  echo "All checks passed."
else
  echo "$failures check(s) failed."
  exit 1
fi
