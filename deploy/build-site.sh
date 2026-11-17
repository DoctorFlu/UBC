#!/usr/bin/env bash
# Builds the landing page (site/) into the folder compose.site.yml serves, with Docker, so the host needs no
# Node.js. It uses the Dockerfile's `site` stage, the same install as the console, and bakes in three public
# settings, each taken from the environment, else from the env file:
#
#   NEXT_PUBLIC_APP_URL          the app's public URL. Default MANDATE_PUBLIC_URL, else https://<MANDATE_HOST>.
#   NEXT_PUBLIC_SCORECARD_AGENT  the agent whose scorecard the page links to. Default: the site's own (the
#                                demo chain's agent).
#   NEXT_PUBLIC_REPO_URL         the source link in the footer. Default empty: no link.
#
# The folder is MANDATE_SITE_DIR (relative to deploy/, default ../site/out). Its contents are replaced in
# place, so a running Caddy serves the new pages at once; nothing changes if the build fails.
#
# MANDATE_ENV_FILE  the env file to read (default: .env next to this script; it may be missing)
# --dry-run         print the settings and the folder, build nothing
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
env_file="${MANDATE_ENV_FILE:-$here/.env}"

# setting KEY: the environment's value if set, else the env file's (KEY=value, quotes removed), else empty.
setting() {
  local key="$1" value
  if [ -n "${!key:-}" ]; then
    printf '%s' "${!key}"
    return
  fi
  [ -f "$env_file" ] || return 0
  value="$(sed -n "s/^$key=//p" "$env_file" | tail -n 1)"
  value="${value#[\"\']}"
  value="${value%[\"\']}"
  printf '%s' "$value"
}

app_url="$(setting NEXT_PUBLIC_APP_URL)"
[ -n "$app_url" ] || app_url="$(setting MANDATE_PUBLIC_URL)"
if [ -z "$app_url" ]; then
  host="$(setting MANDATE_HOST)"
  [ -n "$host" ] && app_url="https://$host"
fi
if [ -z "$app_url" ]; then
  echo "Set MANDATE_HOST (or NEXT_PUBLIC_APP_URL): the landing page links to the app." >&2
  exit 1
fi
agent="$(setting NEXT_PUBLIC_SCORECARD_AGENT)"
repo_url="$(setting NEXT_PUBLIC_REPO_URL)"
out="$(setting MANDATE_SITE_DIR)"
out="${out:-../site/out}"
case "$out" in
  /*) ;;
  *) out="$here/$out" ;;
esac

echo "NEXT_PUBLIC_APP_URL=$app_url"
site_default="(the site's default)"
echo "NEXT_PUBLIC_SCORECARD_AGENT=${agent:-$site_default}"
echo "NEXT_PUBLIC_REPO_URL=${repo_url:-(none)}"
echo "folder: $out"
if [ "${1:-}" = "--dry-run" ]; then
  exit 0
fi

# Readable by everyone: Caddy serves these files.
umask 022
mkdir -p "$out"
staging="$(mktemp -d "$out.build.XXXXXX")"
trap 'rm -rf "$staging"' EXIT
docker build --file "$here/Dockerfile" --target site \
  --build-arg NEXT_PUBLIC_APP_URL="$app_url" \
  --build-arg NEXT_PUBLIC_SCORECARD_AGENT="$agent" \
  --build-arg NEXT_PUBLIC_REPO_URL="$repo_url" \
  --output "type=local,dest=$staging" \
  "$here/.."
if [ ! -f "$staging/index.html" ]; then
  echo "The build wrote no index.html; the site was not changed." >&2
  exit 1
fi
# Same folder, new contents: Caddy's bind mount keeps pointing at it.
find "$out" -mindepth 1 -delete
cp -R "$staging/." "$out/"
echo "Site built in $out."
