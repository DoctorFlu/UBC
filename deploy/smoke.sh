#!/usr/bin/env bash
# Checks a hosted Mandate from the outside, the way Grok Bot, QuickNode and the owner's browser reach it.
#
#   deploy/smoke.sh https://<host>
#
# Reads its secrets from the environment, never from the command line, and never prints them:
#   MCP_AUTH_TOKEN    the MCP server's bearer token (required)
#   CONSOLE_PASSWORD  the owner's console password. Without it, the smoke test checks that every owner
#                     route refuses everyone, as it must before the owner sets a password, and skips the
#                     checks that need the login.
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
password="${CONSOLE_PASSWORD:-}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
chmod 700 "$work"

basic() { printf 'Authorization: Basic %s\n' "$(printf '%s:%s' "${CONSOLE_USER:-owner}" "$1" | base64 | tr -d '\n')"; }
# Credentials go to curl in header files (mode 600), so they never appear in the process list.
printf 'Authorization: Bearer %s\n' "$MCP_AUTH_TOKEN" >"$work/mcp-auth"
[ -n "$password" ] && basic "$password" >"$work/owner-auth"
: >"$work/none"
basic not-the-password >"$work/wrong-auth"

# A paused InstaBox machine wakes on the first request, which then waits for the resume (up to 45 s).
curl_opts=(--silent --show-error --max-time 60 --output "$work/body" --dump-header "$work/headers")
if [ -n "${SMOKE_CA_CERT:-}" ]; then
  curl_opts+=(--cacert "$SMOKE_CA_CERT")
fi

failures=0
pass() { printf 'ok    %s\n' "$1"; }
fail() {
  printf 'FAIL  %s\n' "$1"
  failures=$((failures + 1))
}
check() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }

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

# mcp <json-rpc body>: one stateless MCP request with the token, as Grok Bot makes them.
mcp() {
  request mcp-auth POST /mcp --header "Content-Type: application/json" \
    --header "Accept: application/json, text/event-stream" --header "MCP-Protocol-Version: 2025-06-18" \
    --data-binary "$1"
}

echo "Mandate smoke test against $base"

echo "-- health, public"
expect "console health" none GET /api/health 200
check "console health body says ok" 'grep -q "\"status\":\"ok\"" "$work/body"'
expect "MCP server health" none GET /mcp/health 200
check "MCP health body says ok" 'grep -q "\"status\":\"ok\"" "$work/body"'

echo "-- MCP server: its own bearer token"
initialize='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mandate-hosting-smoke","version":"0"}}}'
expect "MCP refuses a request without the token" none POST /mcp 401 \
  --header "Content-Type: application/json" --header "Accept: application/json, text/event-stream" \
  --data-binary "$initialize"
if has_basic_challenge; then fail "MCP's 401 comes from the MCP server, not the owner login"; fi
mcp "$initialize"
check "MCP initialize with the token (POST /mcp -> $status)" '[ "$status" = 200 ] && grep -q "\"serverInfo\"" "$work/body"'
mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
tools="$(grep -o '"name":"[a-z_]*"' "$work/body" | sort -u | wc -l | tr -d ' ')"
check "MCP tools/list ($tools tools)" '[ "$status" = 200 ] && [ "$tools" -gt 5 ]'
mcp '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"whoami","arguments":{}}}'
agent="$(sed -n 's/.*"agentAddress":"\(0x[0-9a-fA-F]\{40\}\)".*/\1/p' "$work/body" | head -n 1)"
check "MCP tools/call whoami, read only (agent ${agent:-unknown})" '[ "$status" = 200 ] && [ -n "$agent" ]'

echo "-- owner routes: the owner's login"
for path in / /hedge /hedge/plans/smoke-test /setup /api/console/snapshot; do
  expect "owner route refuses without the login" none GET "$path" 401
  has_basic_challenge || fail "the 401 on $path asks for the owner login"
done
expect "owner route refuses a wrong password" wrong-auth GET /api/console/snapshot 401
expect "/rpc refuses without the login" none POST /rpc 401 \
  --header "Content-Type: application/json" --data-binary '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}'
expect "a cross-site write is refused before any login" none PUT /api/console/holdings 403 \
  --header "Sec-Fetch-Site: cross-site" --header "Sec-Fetch-Mode: cors" \
  --header "Content-Type: application/json" --data-binary '{}'
snapshot=""
if [ -z "$password" ]; then
  echo "   (no CONSOLE_PASSWORD: the checks that need the owner's login are skipped)"
else
  expect "console home with the login" owner-auth GET / 200
  expect "snapshot with the login" owner-auth GET /api/console/snapshot 200
  snapshot="$(cat "$work/body")"
  # A stream never ends, so curl stops at --max-time; what matters is the status, the type and a first event.
  curl "${curl_opts[@]}" --max-time 3 --header @"$work/owner-auth" "$base/api/console/events" >/dev/null 2>&1
  check "live events stream through the proxy with the login (GET /api/console/events)" \
    'grep -q "^HTTP/[0-9.]* 200" "$work/headers" && grep -qi "^content-type: *text/event-stream" "$work/headers" && grep -q "^data:" "$work/body"'
  expect "a cross-site write is refused even with the login" owner-auth PUT /api/console/holdings 403 \
    --header "Sec-Fetch-Site: cross-site" --header "Sec-Fetch-Mode: cors" \
    --header "Content-Type: application/json" --data-binary '{}'
  if printf '%s' "$snapshot" | grep -q '"kind":"local"'; then
    rpc='{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}'
    expect "/rpc with the login (demo chain)" owner-auth POST /rpc 200 \
      --header "Content-Type: application/json" --data-binary "$rpc"
    check "/rpc reaches the demo chain (chain id 5042002)" 'grep -q "\"result\":\"0x4cef52\"" "$work/body"'
  fi
fi

echo "-- public routes"
if [ -n "$agent" ]; then
  expect "public scorecard without a login" none GET "/agent/$agent" 200
  check "the scorecard page loads its assets" 'grep -q "/_next/static/" "$work/body"'
  asset="$(sed -n 's/.*\(\/_next\/static\/[^"]*\.js\)".*/\1/p' "$work/body" | head -n 1)"
  [ -n "$asset" ] && expect "the scorecard's scripts without a login" none GET "$asset" 200
else
  fail "the MCP server names the agent, for the scorecard (is the chain connected?)"
fi
# 401 for a delivery without a valid signature, or 503 while QUICKNODE_STREAM_SECURITY_TOKEN is unset.
request none POST /api/webhooks/quicknode --header "Content-Type: application/json" --data-binary '{"data":[]}'
check "QuickNode webhook is public and checks its own signature (POST /api/webhooks/quicknode -> $status)" \
  '{ [ "$status" = 401 ] || [ "$status" = 503 ]; } && ! has_basic_challenge'

echo "-- internal only"
expect "the console's agent API is not public" mcp-auth GET /api/agent/v1/holdings 404

if [ "$failures" -eq 0 ]; then
  echo "All checks passed."
else
  echo "$failures check(s) failed."
  exit 1
fi
