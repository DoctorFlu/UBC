# syntax=docker/dockerfile:1
#
# Mandate's two images, built from the repository root (docker compose does this, see compose.yml):
#
#   console   the owner's console: a production Next.js build, served by its standalone server.
#   services  the MCP server, the signal API, and for the demo chain anvil, the one-shot deployer and the
#             simulated executor. They run from TypeScript source with tsx, exactly as in development.
#
# Both run as the unprivileged `node` user, carry no secret (every secret comes from the environment at
# run time, see mandate.env.template), and build on arm64 and amd64 alike.
#
# The `site` stage is not an image: it is the landing page's static files (see deploy/build-site.sh).

# Node 24 LTS on Debian bookworm, pinned by the digest of the multi-arch index.
ARG NODE_IMAGE=node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

FROM ${NODE_IMAGE} AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    npm_config_audit=false \
    npm_config_fund=false \
    npm_config_update_notifier=false

# The same, on the machine that builds. The compiled contracts do not depend on the CPU, so they are made
# natively even when building for another one; forge's solc does not run reliably under emulation. On a
# native build this is the same stage as `base`, and BuildKit runs it once.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build-base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    npm_config_audit=false \
    npm_config_fund=false \
    npm_config_update_notifier=false

# ----------------------------------------------------------------------------------------- dependencies
# The workspace manifests first, so the install layer is reused until a manifest or the lockfile changes.
FROM base AS manifests
COPY package.json package-lock.json ./
COPY brand/package.json brand/
COPY shared/package.json shared/
COPY gemini/package.json gemini/
COPY planner/package.json planner/
COPY agent/package.json agent/
COPY signals/package.json signals/
COPY devchain/package.json devchain/
COPY streams/package.json streams/
COPY redteam/package.json redteam/
COPY dashboard/package.json dashboard/
COPY site/package.json site/

# Everything, development tools included: the console build, forge and tsx need them.
# `npm ci`, never `npm install`: it installs exactly the lockfile, native bindings for this platform included.
FROM base AS deps
COPY --from=manifests /app ./
RUN --mount=type=cache,target=/root/.npm npm ci

# The same install for the building machine, for the contracts stage.
FROM build-base AS build-deps
COPY --from=manifests /app ./
RUN --mount=type=cache,target=/root/.npm npm ci

# Only what the services need at run time.
FROM manifests AS services-deps
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --include-workspace-root=false \
      --workspace=@mandate/agent --workspace=@mandate/signals --workspace=@mandate/devchain \
 # forge compiles the contracts in the build stage below; nothing runs it later.
 && rm -rf node_modules/@foundry-rs/forge node_modules/@foundry-rs/forge-*

# ------------------------------------------------------------------------------------------------ console
FROM deps AS console-build
COPY . .
# The dev signer signs as anvil account 0, a public test key. Only the demo chain builds with it, and its
# /rpc route is open only to the first workspace's members (see compose.demo.yml and docs/hosting.md).
ARG NEXT_PUBLIC_DEV_SIGNER=0
ENV NEXT_OUTPUT=standalone \
    NEXT_PUBLIC_DEV_SIGNER=${NEXT_PUBLIC_DEV_SIGNER}
# The operator's account commands (claim-code, invite, status), bundled into one file the standalone server's
# folder can run with plain node: docker compose exec console node dashboard/admin.mjs claim-code
RUN npm run build -w @mandate/dashboard \
 && node dashboard/scripts/build-admin.mjs dashboard/.next/standalone/dashboard/admin.mjs \
 && if [ "$NEXT_PUBLIC_DEV_SIGNER" != "1" ] \
      && grep -rl ac0974bec39a dashboard/.next/static dashboard/.next/standalone --include='*.js' --include='*.mjs'; then \
      echo "The dev signer's key is in a build made without NEXT_PUBLIC_DEV_SIGNER=1." >&2; exit 1; \
    fi

# The Policy contracts, compiled once here: the demo chain deploys them without forge, and the console
# deploys and checks each new mandate's contract against them (#95).
FROM build-deps AS contracts
# forge fetches solc over HTTPS, and the slim image has no CA certificates.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY shared shared
COPY gemini gemini
COPY devchain devchain
COPY contracts/src contracts/src
COPY contracts/foundry.toml contracts/
# forge downloads the solc version foundry.toml pins; the cache keeps it between builds.
RUN --mount=type=cache,target=/root/.svm \
    node --import tsx --input-type=module \
      -e 'import { buildContracts } from "@mandate/devchain"; buildContracts();'

FROM base AS console
ARG NEXT_PUBLIC_DEV_SIGNER=0
LABEL org.opencontainers.image.title="mandate-console" \
      org.opencontainers.image.source="https://github.com/DoctorFlu/UBC" \
      dev.mandate.dev-signer="${NEXT_PUBLIC_DEV_SIGNER}"
# HOSTNAME: Docker sets it to the container id, and the standalone server listens on whatever it names.
# KEEP_ALIVE_TIMEOUT: how long the standalone server keeps an idle connection open, in milliseconds. It must
# outlast Caddy, which reuses an idle connection to the console for up to 2 minutes; with Node's 5 s default,
# a request Caddy sends just as Node closes the connection gets a 502 (docs/hosting.md, "Idle connections").
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    KEEP_ALIVE_TIMEOUT=130000 \
    CONSOLE_DATA_DIR=/data/console
# The application files stay owned by root, so the server cannot rewrite its own code.
COPY --from=console-build /app/dashboard/.next/standalone ./
COPY --from=console-build /app/dashboard/.next/static ./dashboard/.next/static
# The compiled Policy contracts, from the contracts stage below (never a copy kept in git): the console
# deploys a new mandate's contract from them on the demo chain, serves the owner's wallet the same bytecode
# on Arc, and follows only contracts whose code matches them (#95).
COPY --from=contracts /app/devchain/out/production/Policy.sol/Policy.json policy-artifacts/production/Policy.sol/
COPY --from=contracts /app/devchain/out/PolicyReference.sol/PolicyReference.json policy-artifacts/PolicyReference.sol/
ENV CONSOLE_POLICY_ARTIFACTS_DIR=/app/policy-artifacts
RUN mkdir -p /data/console dashboard/.next/cache \
 && chown node:node /data/console dashboard/.next/cache
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dashboard/server.js"]

# --------------------------------------------------------------------------------------------- landing page
# The static export of site/, built from the same install as the console. It is files, not an image to run:
# deploy/build-site.sh writes this stage to a folder with `docker build --output`, and compose.site.yml has
# Caddy serve that folder. The four settings are public and baked into the pages.
FROM deps AS site-build
COPY . .
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_DASHBOARD_AGENT
ARG NEXT_PUBLIC_REPO_URL
ENV NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL} \
    NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL} \
    NEXT_PUBLIC_DASHBOARD_AGENT=${NEXT_PUBLIC_DASHBOARD_AGENT} \
    NEXT_PUBLIC_REPO_URL=${NEXT_PUBLIC_REPO_URL}
RUN test -n "$NEXT_PUBLIC_APP_URL" || { echo "NEXT_PUBLIC_APP_URL is required: the app's public URL." >&2; exit 1; }
RUN test -n "$NEXT_PUBLIC_SITE_URL" || { echo "NEXT_PUBLIC_SITE_URL is required: the landing page's public URL." >&2; exit 1; }
RUN npm run build -w @mandate/site

FROM scratch AS site
COPY --from=site-build /app/site/out /

# ----------------------------------------------------------------------------------------------- services
FROM base AS services
LABEL org.opencontainers.image.title="mandate-services" \
      org.opencontainers.image.source="https://github.com/DoctorFlu/UBC"
ENV NODE_ENV=production
COPY --from=services-deps /app/node_modules ./node_modules
# tsx is a development dependency of the repository root; it and esbuild are all it needs.
COPY --from=deps /app/node_modules/tsx ./node_modules/tsx
COPY --from=deps /app/node_modules/esbuild ./node_modules/esbuild
COPY --from=deps /app/node_modules/@esbuild ./node_modules/@esbuild
COPY package.json tsconfig.base.json ./
COPY shared/package.json shared/tsconfig.json shared/
COPY shared/src shared/src
COPY gemini/package.json gemini/tsconfig.json gemini/
COPY gemini/src gemini/src
# The Gemini doctor, run in the executor's container to check its key (docs/gemini-venue.md).
COPY gemini/scripts gemini/scripts
COPY planner/package.json planner/tsconfig.json planner/
COPY planner/src planner/src
COPY agent/package.json agent/tsconfig.json agent/
COPY agent/src agent/src
COPY signals/package.json signals/tsconfig.json signals/
COPY signals/src signals/src
COPY devchain/package.json devchain/tsconfig.json devchain/
COPY devchain/src devchain/src
COPY devchain/scripts devchain/scripts
COPY --from=contracts /app/devchain/out devchain/out
# anvil comes from the lockfile's @foundry-rs package for this platform; put it on the PATH.
RUN ln -s "$(node -p 'require.resolve(`@foundry-rs/anvil-linux-${process.arch === "x64" ? "amd64" : "arm64"}/bin/anvil`)')" \
      /usr/local/bin/anvil \
 && anvil --version \
 && mkdir -p /data/agent /data/chain \
 && chown node:node /data/agent /data/chain
USER node
# As the user the services run as: COPY keeps the source's file modes, so a checkout made with umask 077
# would build an image whose files `node` cannot read. Fail the build then, not the containers.
RUN node --import tsx -e 'await import("@mandate/shared/node"); await import("@mandate/devchain");'
# Each service sets its own command and health check in compose.yml.
CMD ["node", "--import", "tsx", "agent/src/main.ts"]
