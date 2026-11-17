#!/usr/bin/env bash
# Checks a hosted Mandate from the outside, the way Grok Bot, QuickNode and a member's browser reach it.
#
#   deploy/smoke.sh https://<host>
#
# Reads its secrets from the environment, never from the command line, and never prints them:
#   MCP_AUTH_TOKEN      an agent token (the env file's, or one made in the console's Agents section).
#                       Without it, the checks that need it are skipped, so the test can run from a machine
#                       that should not hold a token.
#   CONSOLE_SESSION     a member's session: the value of the console's session cookie, copied from a signed-in
#                       browser. Without it, the test checks that every member route refuses everyone, and
#                       skips the checks that need a session.
#   SMOKE_AGENT_ADDRESS the agent's address, for the public scorecard when MCP_AUTH_TOKEN is not given (it
#                       is public: the scorecard's URL)
#   SMOKE_CA_CERT       a CA certificate to trust, for a host with a private certificate (localhost)
#
# It only reads and asks; it changes nothing. Exits 0 when every check passes.
set -uo pipefail

base="${1:-}"
if [ -z "$base" ]; then
  echo "usage: deploy/smoke.sh https://<host>" >&2
  exit 2
fi
base="${base%/}"
token="${MCP_AUTH_TOKEN:-}"
session="${CONSOLE_SESSION:-}"
# Over HTTPS the console's session cookie carries the __Host- prefix (docs/accounts.md).
case "$base" in
  https://*) cookie_name="__Host-mandate_session" ;;
  *) cookie_name="mandate_session" ;;
esac

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
chmod 700 "$work"

# Credentials go to curl in header files (mode 600), so they never appear in the process list.
[ -n "$token" ] && printf 'Authorization: Bearer %s\n' "$token" >"$work/mcp-auth"
[ -n "$session" ] && printf 'Cookie: %s=%s\n' "$cookie_name" "$session" >"$work/member"
: >"$work/none"
printf 'Authorization: Bearer %s\n' "mdt_not-a-token-of-this-host-0000000000000000000" >"$work/wrong-token"
printf 'Cookie: %s=%s\n' "$cookie_name" "not-a-session-of-this-host" >"$work/wrong-session"

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

# The old owner login (HTTP basic auth) is gone: nothing may ask a browser for it.
has_basic_challenge() { grep -qi '^www-authenticate: *basic' "$work/headers"; }
location() { sed -n 's/^[Ll]ocation: *\([^[:space:]]*\).*/\1/p' "$work/headers" | head -n 1; }

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

echo "-- MCP server: agent tokens, which the console resolves"
initialize='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mandate-hosting-smoke","version":"0"}}}'
mcp_headers=(--header "Content-Type: application/json" --header "Accept: application/json, text/event-stream")
expect "MCP refuses a request without a token" none POST /mcp 401 "${mcp_headers[@]}" --data-binary "$initialize"
if has_basic_challenge; then fail "MCP's 401 comes from the MCP server, not a login prompt"; fi
expect "MCP refuses a token the console does not know" wrong-token POST /mcp 401 "${mcp_headers[@]}" \
  --data-binary "$initialize"
agent="${SMOKE_AGENT_ADDRESS:-}"
if [ -z "$token" ]; then
  echo "   (no MCP_AUTH_TOKEN: the checks that need a token are skipped)"
else
  mcp "$initialize"
  check "MCP initialize with the token (POST /mcp -> $status)" '[ "$status" = 200 ] && grep -q "\"serverInfo\"" "$work/body"'
  mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  tools="$(grep -o '"name":"[a-z_]*"' "$work/body" | sort -u | wc -l | tr -d ' ')"
  check "MCP tools/list ($tools tools)" '[ "$status" = 200 ] && [ "$tools" -gt 5 ]'
  mcp '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"whoami","arguments":{}}}'
  agent="$(sed -n 's/.*"agentAddress":"\(0x[0-9a-fA-F]\{40\}\)".*/\1/p' "$work/body" | head -n 1)"
  mandate="$(sed -n 's/.*"mandateId":"\([a-z0-9_]*\)".*/\1/p' "$work/body" | head -n 1)"
  check "MCP tools/call whoami, read only (agent ${agent:-unknown}, mandate ${mandate:-unknown})" \
    '[ "$status" = 200 ] && [ -n "$agent" ] && [ -n "$mandate" ]'
fi

echo "-- member routes: a session"
for path in /api/console/snapshot /api/console/agents /api/console/events; do
  expect "member API refuses without a session" none GET "$path" 401
  if has_basic_challenge; then fail "the 401 on $path asks for no login prompt"; fi
done
expect "member API refuses a session the console does not know" wrong-session GET /api/console/snapshot 401
for path in / /hedge /hedge/plans/smoke-test /setup; do
  expect "page sends a browser without a session to sign in" none GET "$path" 303 --header "Accept: text/html"
  check "  ... to /sign-in (Location $(location))" '[ "$(location)" = "/sign-in" ] || location | grep -q "^/sign-in?next="'
done
expect "/rpc refuses without a session" none POST /rpc 401 \
  --header "Content-Type: application/json" --data-binary '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}'
expect "a cross-site write is refused before any session check" none PUT /api/console/holdings 403 \
  --header "Sec-Fetch-Site: cross-site" --header "Sec-Fetch-Mode: cors" \
  --header "Content-Type: application/json" --data-binary '{}'
expect "a cross-site sign-in is refused" none POST /api/auth/sign-in 403 \
  --header "Sec-Fetch-Site: cross-site" --header "Sec-Fetch-Mode: cors" \
  --header "Content-Type: application/json" --data-binary '{}'
snapshot=""
if [ -z "$session" ]; then
  echo "   (no CONSOLE_SESSION: the checks that need a member's session are skipped)"
else
  expect "console home with the session" member GET / 200 --header "Accept: text/html"
  expect "snapshot with the session" member GET /api/console/snapshot 200
  snapshot="$(cat "$work/body")"
  expect "the Agents section's data with the session" member GET /api/console/agents 200
  # A stream never ends, so curl stops at --max-time; what matters is the status, the type and a first event.
  curl "${curl_opts[@]}" --max-time 3 --header @"$work/member" "$base/api/console/events" >/dev/null 2>&1
  check "live events stream through the proxy with the session (GET /api/console/events)" \
    'grep -q "^HTTP/[0-9.]* 200" "$work/headers" && grep -qi "^content-type: *text/event-stream" "$work/headers" && grep -q "^data:" "$work/body"'
  expect "a cross-site write is refused even with the session" member PUT /api/console/holdings 403 \
    --header "Sec-Fetch-Site: cross-site" --header "Sec-Fetch-Mode: cors" \
    --header "Content-Type: application/json" --data-binary '{}'
  if printf '%s' "$snapshot" | grep -q '"kind":"local"'; then
    rpc='{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}'
    expect "/rpc with the session (demo chain, first workspace)" member POST /rpc 200 \
      --header "Content-Type: application/json" --data-binary "$rpc"
    check "/rpc reaches the demo chain (chain id 5042002)" 'grep -q "\"result\":\"0x4cef52\"" "$work/body"'
  fi
fi

echo "-- public routes"
for path in /sign-in /sign-up /claim /recover; do
  expect "account page without a session" none GET "$path" 200 --header "Accept: text/html"
done
expect "who is signed in, without a session" none GET /api/auth/session 401
if [ -n "$agent" ]; then
  expect "public scorecard without a session" none GET "/agent/$agent" 200
  check "the scorecard page loads its assets" 'grep -q "/_next/static/" "$work/body"'
  asset="$(sed -n 's/.*\(\/_next\/static\/[^"]*\.js\)".*/\1/p' "$work/body" | head -n 1)"
  [ -n "$asset" ] && expect "the scorecard's scripts without a session" none GET "$asset" 200
else
  fail "the agent's address, for the scorecard (from the MCP server, or set SMOKE_AGENT_ADDRESS)"
fi
# Every page links these, the sign-in page's browser tab included.
for path in /favicon.ico /icon.svg /apple-icon.png; do
  expect "the $path icon without a session" none GET "$path" 200
  check "$path is an image" 'grep -qi "^content-type: *image/" "$work/headers"'
done
# 401 for a delivery without a valid signature, or 503 while QUICKNODE_STREAM_SECURITY_TOKEN is unset.
request none POST /api/webhooks/quicknode --header "Content-Type: application/json" --data-binary '{"data":[]}'
check "QuickNode webhook is public and checks its own signature (POST /api/webhooks/quicknode -> $status)" \
  '{ [ "$status" = 401 ] || [ "$status" = 503 ]; } && ! has_basic_challenge'

echo "-- internal only"
expect "the console's agent API is not public" none GET /api/agent/v1/holdings 404
expect "the console's token lookup is not public" none POST /api/agent/v1/auth/resolve 404 \
  --header "Content-Type: application/json" --data-binary '{}'
expect "the console's executor API is not public" none PUT /api/executor/v1/settlements/0 404

if [ "$failures" -eq 0 ]; then
  echo "All checks passed."
else
  echo "$failures check(s) failed."
  exit 1
fi
