# Hosting

This runbook puts the whole product on one small Linux VM with `docker compose up -d`, behind Caddy with an automatic HTTPS certificate.
The example host is an Oracle Cloud Always Free Ubuntu VM with a free `sslip.io` name, but nothing in the images or compose files depends on the host.
Any Linux VM with Docker, a public IP and ports 80 and 443 open works the same way, on arm64 or amd64.
A host without a public IP, whose own proxy ends TLS and forwards plain HTTP, uses gateway mode instead; [InstaBox](#instabox) below is the worked example.

## What runs

Everything is in [`deploy/`](../deploy).

| Container | What it is | Public |
| --- | --- | --- |
| `caddy` | TLS and routing for one hostname, and the owner's login. | ports 80 and 443, or one high port in gateway mode |
| `console` | The owner's console (Next.js, standalone build). | through Caddy |
| `mcp` | The MCP server Grok Bot connects to. | `/mcp` through Caddy |
| `signals` | The x402 signal API. Only the MCP server calls it. | no |
| `anvil` | Demo chain only: a local chain with Arc's chain id 5042002. | `/rpc`, behind the owner's login |
| `chain-init` | Demo chain only: deploys the Policy contract once, then exits. | no |
| `executor` | Demo chain only: the simulated executor, which records fills without placing orders. | no |

The chain is chosen by `COMPOSE_FILE` in `deploy/.env`.

- `compose.yml:compose.demo.yml` runs the self-contained demo chain.
  The contract is deployed with the demo rules on first start, and the chain keeps its state across restarts.
  The owner signs with the console's built-in test signer, anvil account 0, whose key is public.
- `compose.yml:compose.arc.yml` uses a Policy contract already deployed on Arc testnet.
  There is no anvil and no executor, and the owner signs with a real browser wallet.
  It refuses to start until `POLICY_ADDRESS`, `POLICY_DEPLOY_BLOCK` and `AGENT_PRIVATE_KEY` are set.

Two optional files go after the chain's:

- `compose.gateway.yml` is gateway mode, for a host behind a proxy that ends TLS (see [InstaBox](#instabox)).
  Caddy serves plain HTTP on `MANDATE_APP_PORT` (default 8080), published on `127.0.0.1` only, and handles no certificate.
- `compose.site.yml` serves the landing page, the static build of `site/` in `site/out`, as a second origin (see [Landing page](#landing-page)).

### Routes and who may use them

Caddy denies by default: every path that is not listed as public needs the owner's login.
The rules are in one file, [`deploy/caddy/app-routes.caddy`](../deploy/caddy/app-routes.caddy), which both the HTTPS `Caddyfile` and the gateway's `Caddyfile.gateway` import.

| Path | Who | Check |
| --- | --- | --- |
| `/mcp` | Grok Bot | The MCP server's own bearer token (`MCP_AUTH_TOKEN`). |
| `/mcp/health` | anyone | None; it says only that the server is up. |
| `/api/webhooks/quicknode` | QuickNode | The console verifies QuickNode's HMAC signature and refuses stale or unsigned deliveries. |
| `/agent/<address>` and its scripts under `/_next/static/` | anyone | None; this is the public scorecard, and it links to nothing private. |
| `/api/health` | anyone | None; it reports only `ok` and the feed's health. |
| `/api/agent/*` | nobody | Answers 404 publicly. The MCP server reaches it inside the Docker network with `CONSOLE_SERVICE_TOKEN`. |
| `/rpc` (demo chain only) | the owner | The owner's login. It forwards to anvil, so the browser's test signer can send transactions. |
| everything else (pages, `/api/console/*`) | the owner | The owner's login (HTTP basic auth over HTTPS). |

Until the owner sets a password, `CONSOLE_PASSWORD_HASH` is empty and compose uses the base64 of the sentence `locked: run deploy/set-console-password.sh`, which is not a bcrypt hash, so no password can match it: every owner route answers 401 to everyone while the rest of the stack runs.
The owner's login is needed because the console's pages and read APIs show holdings, hedge plans and decision contexts, and on the demo chain the owner's key is public, so wallet signatures alone prove nothing there.
Caddy strips the login header before the request reaches the console.
A browser request from another site (`Sec-Fetch-Site: cross-site` or `same-site`) to an owner route is refused unless it is a plain page navigation, so another site cannot use a logged-in browser to make changes.

The signal API is not routed at all.
Only the MCP server buys signals, it reaches the API inside the Docker network, and x402 settlement goes through Circle Gateway with no callback to this host.
Publishing it would only give strangers a way to spend its Gemini rate limit.

### State

Every file the product writes is in a named Docker volume, so `docker compose down` and image updates keep it.
Compose prefixes each name with the project name, `mandate`.

| Volume | Files | Used by |
| --- | --- | --- |
| `mandate_console-data` | `console.sqlite` (with its `-wal` and `-shm`): event cache, holdings, decision contexts, hedge plans, pairing, change requests, signal payments. | `console` |
| `mandate_agent-data` | The MCP server's signal spend ledger and purchased signals. | `mcp` |
| `mandate_chain` (demo chain only) | `anvil-state.json`, the chain itself, saved every 60 seconds (`ANVIL_STATE_INTERVAL`) and on shutdown, and `deployment.json`, the contract the other services use. | `anvil`, `chain-init`; read only for `console`, `mcp`, `executor` |
| `mandate_caddy-data` | The HTTPS certificate and its key, and Caddy's account with Let's Encrypt. | `caddy` |
| `mandate_caddy-config` | Caddy's saved runtime configuration. | `caddy` |

The containers run as a non-root user with a read-only root filesystem, so nothing else is written.

## 1. Create the VM

In the Oracle Cloud console, create a Compute instance with the Canonical Ubuntu 24.04 image.
The Always Free `VM.Standard.A1.Flex` shape (arm64) with 1 OCPU and 6 GB of memory is the best fit.
The running stack uses about 500 MB, but the console's first build needs about 2 GB, so on a 1 GB `VM.Standard.E2.1.Micro` add swap first (step 3).
Keep the SSH key, and note the instance's public IP address.

Your hostname is the IP with dashes and `.sslip.io` after it.
For example, the IP `203.0.113.10` becomes `203-0-113-10.sslip.io`, which already resolves to that IP.
Any DNS name you own that points at the IP works too.

## 2. Open ports 80 and 443

Oracle blocks these ports twice: in the cloud network and in the instance's own firewall.
Let's Encrypt needs both ports to issue the certificate.

In the cloud console, open the instance's subnet, then its security list (Networking, Virtual cloud networks, your VCN, Security Lists).
Add two ingress rules with source CIDR `0.0.0.0/0`, IP protocol TCP and destination port `80` for one and `443` for the other.

Then, on the instance, allow both ports ahead of Oracle's reject rule and save the rules so they survive a reboot:

```sh
sudo iptables -I INPUT 1 -p tcp -m multiport --dports 80,443 -m conntrack --ctstate NEW -j ACCEPT
sudo netfilter-persistent save
```

Do not flush the existing rules; Oracle's images need some of them.

## 3. Install Docker

Install Docker Engine and the Compose plugin from Docker's own repository:

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"
```

Log out and back in so the `docker` group applies, then check with `docker compose version`.

On a VM with less than 4 GB of memory, add 4 GB of swap for the build:

```sh
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 4. Clone and configure

```sh
git clone https://github.com/DoctorFlu/UBC.git mandate
cd mandate/deploy
./init-env.sh
./set-console-password.sh
```

`init-env.sh` copies [`mandate.env.template`](../deploy/mandate.env.template) to `deploy/.env` with mode 600, and fills `MCP_AUTH_TOKEN` and `CONSOLE_SERVICE_TOKEN` with fresh random values without printing them.
`set-console-password.sh` asks twice for the owner's console password (at least 16 characters) and stores only its bcrypt hash, as `CONSOLE_PASSWORD_HASH`.
Keep the password in a password manager; the host never stores it.

Open `deploy/.env` in an editor and set at least:

- `MANDATE_HOST`, the hostname from step 1;
- `X402_SELLER_ADDRESS`, the address that receives signal payments (an address, not a key).

Every other variable has a one-line explanation in the file, and [configuration.md](configuration.md) says more.
Leave `X402_BUYER_PRIVATE_KEY` empty unless the agent should buy signals; without it, `buy_signal` answers `unavailable` and everything else works.
`deploy/.env` is git-ignored and is never copied into an image.

Secrets copied from another product, such as Grok Bot's webhook URL and key for [event wake-ups](event-wake.md), go in with `set-secret.sh` rather than an editor, so the value is never shown, kept in shell history or put on a command line:

```sh
pbpaste | ./set-secret.sh GROK_WEBHOOK_URL    # from the clipboard (xclip -o or wl-paste on Linux)
./set-secret.sh GROK_WEBHOOK_KEY              # or typed or pasted at its prompt, which shows nothing
```

It accepts only `GROK_WEBHOOK_URL`, `GROK_WEBHOOK_KEY`, `GEMINI_API_KEY` and `GEMINI_API_SECRET`; the console password has its own script, and the tokens are generated.
It drops one trailing newline and refuses an empty value, a line break or other control character, a character outside printable ASCII (a non-breaking space from a web page), a space at either end and a single quote; the URL must start with `https://`.
It writes the line as `NAME='value'`, because docker compose would otherwise expand a `$` in the value and cut it at ` #`.
The file is rebuilt next to itself with mode 600 and moved over the old one, so it is never half written, and a failure leaves no temporary file; run it as the file's owner, so the owner stays.
It prints only the name, the value's length and the first 12 hex digits of its SHA-256, which the owner can compare with `printf %s "$(pbpaste)" | shasum -a 256 | cut -c1-12` on their own computer.
Nothing reads `GEMINI_API_KEY` or `GEMINI_API_SECRET` yet; they are on the list for the Gemini sandbox keys to come.

For the Arc testnet mode, set `COMPOSE_FILE=compose.yml:compose.arc.yml` and fill `POLICY_ADDRESS`, `POLICY_DEPLOY_BLOCK` and `AGENT_PRIVATE_KEY`, and `ARC_RPC_URL` if you use a provider.
Nothing executes approved intents in this mode yet: there is no executor for Arc testnet in this setup.

## 5. Start

```sh
docker compose up -d
```

The first start builds both images on the VM, which takes 10 to 20 minutes on a small VM.
Later starts reuse the build cache.
Services start in order, each when the ones it needs report healthy, and Caddy gets the certificate within a minute of starting.

Check that everything is up:

```sh
docker compose ps
```

Every service should say `healthy`, and `chain-init` (demo chain only) should say `Exited (0)`.

Then run the smoke test from the host or any other machine with a copy of the repository.
It reads its secrets from the environment and prints none of them:

```sh
export MCP_AUTH_TOKEN="$(sed -n 's/^MCP_AUTH_TOKEN=//p' .env)"
read -rs CONSOLE_PASSWORD && export CONSOLE_PASSWORD
./smoke.sh https://<host>
```

Without `CONSOLE_PASSWORD` it checks instead that every owner route refuses everyone, and skips the checks that need the login.
Without `MCP_AUTH_TOKEN` it skips the MCP checks that need the token, so it can run from a machine that should not hold it; set `SMOKE_AGENT_ADDRESS` to the agent's address then, for the scorecard check.

It checks both health endpoints, that `/mcp` refuses a request without the token and answers `initialize`, `tools/list` and a read-only `whoami` call with it, that owner pages and APIs refuse a request without the login or with a wrong one, that the live event stream and a cross-site write behave, that the scorecard and its scripts are public, that the webhook checks its own signature, that `/api/agent/*` is not public, and, on the demo chain, that `/rpc` needs the login.
It ends with `All checks passed.`

Open `https://<host>` in a browser and log in as `owner` (or your `CONSOLE_USER`) with the password.

## 6. Connect Grok Bot

In Grok Bot, open **Connect apps** and add a custom connector:

- URL: `https://<host>/mcp`
- Header: `Authorization` with the value `Bearer ` followed by the token.

To see the token, run `sed -n 's/^MCP_AUTH_TOKEN=//p' deploy/.env` in your own terminal and copy it into Grok Bot.
Never paste it into a chat, an issue or a pull request.
The rest of the connector setup, and how to rotate the token, are in [agent/README.md](../agent/README.md#connect-grok-bot).

The first time Grok Bot connects, it asks to pair and gives you a link to `https://<host>/setup/pair/<agent>`.
Open it, log in, and confirm.
On the demo chain, enter a holding under **Hedge** before asking for a hedge.

## 7. QuickNode webhook (Arc testnet only)

QuickNode cannot see the demo chain, so this applies to the Arc testnet mode.
The design and the Stream setup are in [quicknode-streams.md](quicknode-streams.md).

- Set the Stream's webhook destination to `https://<host>/api/webhooks/quicknode`.
- Put the Stream's security token in `QUICKNODE_STREAM_SECURITY_TOKEN` and set `CONSOLE_EVENT_SOURCE=stream` in `deploy/.env`.
- Apply the change with `docker compose up -d`.

Until the token is set, the webhook answers 503 to every delivery; a delivery without a valid signature gets 401.
The console keeps a slow RPC poll in stream mode, so a missed delivery is filled in.

## Update

```sh
cd mandate
git pull
cd deploy
./build-site.sh                                  # only with compose.site.yml
docker compose build
docker compose up -d --remove-orphans
docker compose up -d --force-recreate --no-deps caddy
docker image prune -f
docker builder prune -f --filter until=1h
```

`docker compose build` builds the new images while the old version keeps serving; only the two `up` lines interrupt it, for about 20 seconds.
`up` replaces only the containers whose image or settings changed, and keeps every volume.
Caddy's configuration files are mounted one by one, and a mounted file that is replaced (as `git pull` does) stays the old file inside a running container, so the second `up` recreates Caddy to load the new routes; it takes a second.
The last two lines keep the disk from filling: a full build caches about 4 GB, and each build whose dependencies changed adds about as much again.
`until=1h` removes the cache that the build just now did not use, and keeps what it used, so the next build is fast too.
A longer window keeps the cache of every recent build: with `until=24h`, two updates an hour apart left 7.7 GB of build cache on the machine, and the prune removed nothing.
After changing `deploy/.env`, `docker compose up -d` applies it.
After switching `COMPOSE_FILE` between the modes, `--remove-orphans` removes the containers the new mode does not use.

## Back up and restore

Stop the stack so SQLite and anvil are not writing, archive each volume, then start again:

```sh
cd mandate/deploy
mkdir -p ~/mandate-backups
docker compose stop
for v in console-data agent-data chain caddy-data; do docker run --rm -v "mandate_$v:/v:ro" -v ~/mandate-backups:/b alpine:3.20 tar czf "/b/$v-$(date +%F).tgz" -C /v .; done
docker compose start
```

`mandate_chain` exists only in the demo mode; skip it otherwise.
Copy the archives off the VM, together with `deploy/.env`, which holds the tokens and keys and must stay private.

To restore, with the stack stopped (`docker compose down`), unpack each archive into its volume, then start:

```sh
docker volume create mandate_console-data
docker run --rm -v mandate_console-data:/v -v ~/mandate-backups:/b alpine:3.20 tar xzf /b/console-data-<date>.tgz -C /v
docker compose up -d
```

Losing `mandate_console-data` loses the offchain records (holdings, contexts, plans, pairing); the console rebuilds the onchain part from the chain.
Losing `mandate_chain` resets the demo chain; `chain-init` then deploys a new contract and the other services follow it.

## Logs

```sh
docker compose logs -f --tail 100           # every service
docker compose logs -f --tail 100 console   # one service
```

Caddy writes one JSON line per request, with the `Authorization` header redacted.
Docker keeps at most three 10 MB log files per container, so logs never fill the disk.

## Stop

```sh
docker compose stop      # stop everything, keep the containers and the data
docker compose down      # remove the containers and the network, keep the data
docker compose down -v   # also delete every volume: the console's data, the demo chain and the certificate
```

Containers restart on their own after a crash or a reboot, unless you stopped them.
Avoid `down -v` unless you mean to start from nothing: a new certificate counts against Let's Encrypt's weekly limit.

## Landing page

The landing page in `site/` is a static export, served by Caddy from its own origin so it shares no cookies or storage with the console.
Add `compose.site.yml` to `COMPOSE_FILE`, build the site, and apply:

```sh
./build-site.sh
docker compose up -d
```

[`build-site.sh`](../deploy/build-site.sh) builds it with Docker (the Dockerfile's `site` stage, from the same install as the console), so the host needs no Node.js; once the console has been built it takes about 10 seconds and 1.3 GB of memory.
It bakes in four public settings from the env file: `NEXT_PUBLIC_APP_URL` (default `MANDATE_PUBLIC_URL`, else `https://<MANDATE_HOST>`), `NEXT_PUBLIC_SITE_URL` (the site's own URL, which link previews need: default `https://<MANDATE_SITE_ADDRESS>` when that is a name, and required in gateway mode), `NEXT_PUBLIC_SCORECARD_AGENT` (default the demo chain's agent) and `NEXT_PUBLIC_REPO_URL` (default empty, no source link).
It replaces the folder's contents only when the build succeeds, and in place, so a running Caddy serves the new pages at once.
Caddy serves `site/out` (or `MANDATE_SITE_DIR`) on a second listener, `MANDATE_SITE_ADDRESS`.
Files under `/_next/static/` carry a content hash, so they are cached for a year; everything else is revalidated on every visit.
Without `compose.site.yml` the stack runs without the site, whether or not `site/` exists.
With it, the folder must exist, or Docker refuses to start Caddy.

- In gateway mode, `MANDATE_SITE_ADDRESS` keeps its default `http://:8081`, Docker publishes it on `127.0.0.1:MANDATE_SITE_PORT` (default 8081), and the host's proxy gives it its own URL (on InstaBox, `instabox port publish mandate 8081`).
- With automatic HTTPS, give the site and the app a name each, both pointing at the VM: for example `MANDATE_SITE_ADDRESS=example.com` for the site and `MANDATE_HOST=app.example.com` for the app.
  Caddy then gets a certificate for each name on the same ports 80 and 443; the compose file needs no other change.

## InstaBox

[InstaBox](https://instabox.sh) machines have no public IP.
`instabox port publish` gives a port on the machine a public HTTPS URL, `https://<port>-<machine id>.instabox.tech`.
InstaBox's proxy ends TLS and connects to that port from inside the machine over plain HTTP, so the stack runs in gateway mode.
Every command below that starts with `instabox` runs on your own computer (`npx --yes instabox@0.8.281` if it is not installed); the others run on the machine, in `instabox ssh mandate`.

### What the proxy does

These were checked on a real machine.

- It connects to the port on the machine's loopback interface, so Docker publishes the app on `127.0.0.1` only.
- It rewrites `Host` to `127.0.0.1:<port>`, puts the public name in `X-Forwarded-Host`, and sets `X-Forwarded-Proto: https` and `X-Forwarded-For`.
  Caddy sets `Host` back to `MANDATE_HOST` from the env file, never from the request, and trusts the forwarded headers only from private addresses.
- It passes `Authorization` (the owner's login and the MCP token) and the browser's `Origin` and `Sec-Fetch-*` headers unchanged, so the login and the cross-site check work as on a VM.
- It streams responses, so the console's live events work, and it adds `X-Robots-Tag: noindex` and a few security headers of its own.
- The console builds its links from `MANDATE_HOST` (`https://<MANDATE_HOST>`), and its redirects are relative, so pairing links and the browser's `/rpc` point at the public URL.

### Create the machine

On the free plan, one machine from the default template (`agent-browser`: Debian 13, amd64, Docker with Compose) is enough:

```sh
instabox create --name mandate
instabox get mandate        # "id" is m_<machine id>; the public names use the part after m_
```

`/data` is the machine's persistent disk (20 GiB); everything Mandate keeps is under `/data/mandate`.

| Path | What |
| --- | --- |
| `/data/mandate/repo` | The code, replaced on every update, and the built landing page in `repo/site/out`. |
| `/data/mandate/mandate.env` | The env file, mode 600: the tokens and the owner's password hash. |
| `/data/mandate/docker` | Docker's data root: the named volumes (the console's database, the demo chain) and the containers' state. |
| `/data/mandate/containerd` | containerd's root: Docker's images and build cache, because Docker 29 keeps images in containerd. |

Move both there once, before the first build; the root disk is only 16 GiB and holds the system:

```sh
sudo mkdir -p /data/mandate/docker /data/mandate/containerd
sudo chown "$USER:$USER" /data/mandate
echo '{ "data-root": "/data/mandate/docker" }' | sudo tee /etc/docker/daemon.json
sudo sed -i '1i root = "/data/mandate/containerd"' /etc/containerd/config.toml
sudo systemctl restart containerd docker
```

Measured with the demo chain and the landing page, `/data` holds 8.3 GB: InstaBox's own 4 GiB swap file, about 0.8 GB of images, 3.9 GB of build cache, and some 70 MB of code, volumes and settings.
That leaves 12 GB, enough for a rebuild with new dependencies (about 4 GB more) before the update's prune step.

### Deploy

The repository is private, so copy the code from a checkout on your computer instead of cloning it on the machine:

```sh
git archive --format=tar.gz -o mandate-src.tgz HEAD
instabox cp -p mandate-src.tgz mandate:/data/mandate/mandate-src.tgz
```

On the machine, unpack it and create the env file.
The images run as an unprivileged user, so the files must be readable by everyone (`umask 022`); the build stops with `permission denied` otherwise.

```sh
cd /data/mandate
umask 022
mkdir repo
tar -xzf mandate-src.tgz -C repo
MANDATE_ENV_FILE=/data/mandate/mandate.env repo/deploy/init-env.sh
```

`init-env.sh` creates the tokens on the machine; they never leave it.
In `/data/mandate/mandate.env`, set:

- `COMPOSE_FILE=compose.yml:compose.demo.yml:compose.gateway.yml`;
- `MANDATE_HOST=8080-<machine id>.instabox.tech`;
- `X402_SELLER_ADDRESS`, the address that receives signal payments.

Leave `CONSOLE_PASSWORD_HASH` empty: until the owner sets the password, every owner route refuses everyone.
Then build and start, which takes about 10 minutes the first time:

```sh
cd /data/mandate/repo/deploy
docker compose --env-file /data/mandate/mandate.env up -d --build
```

Publish the app's port, and only that one (never anvil's 8545 or the signal API's):

```sh
instabox port publish mandate 8080 --name "Mandate app"
```

For the landing page, add `compose.site.yml` to `COMPOSE_FILE` and set `NEXT_PUBLIC_SITE_URL` (`https://8081-<machine id>.instabox.tech`) and `NEXT_PUBLIC_REPO_URL` (and `NEXT_PUBLIC_SCORECARD_AGENT`, for another agent) in the env file, then build it, apply, and publish its port:

```sh
MANDATE_ENV_FILE=/data/mandate/mandate.env ./build-site.sh
docker compose --env-file /data/mandate/mandate.env up -d
```

```sh
instabox port publish mandate 8081 --name "Mandate site"
```

The site's origin serves only the static files: `/mcp`, `/rpc`, `/api/*` and the console's pages answer 404 there.

### The owner's password

The owner sets it from their own terminal; the command asks twice, shows nothing, and restarts Caddy with the new hash:

```sh
instabox ssh mandate -- -t 'MANDATE_ENV_FILE=/data/mandate/mandate.env /data/mandate/repo/deploy/set-console-password.sh && cd /data/mandate/repo/deploy && docker compose --env-file /data/mandate/mandate.env up -d caddy'
```

### Secrets from other products

`instabox ssh` passes its standard input to the remote command (checked by hash on the machine), so the owner copies a value in the other product and sends it from the clipboard, one value at a time:

```sh
pbpaste | instabox ssh mandate -- 'MANDATE_ENV_FILE=/data/mandate/mandate.env /data/mandate/repo/deploy/set-secret.sh GROK_WEBHOOK_URL'
pbpaste | instabox ssh mandate -- 'MANDATE_ENV_FILE=/data/mandate/mandate.env /data/mandate/repo/deploy/set-secret.sh GROK_WEBHOOK_KEY'
```

Without a pipe, add `-t` after `--` so the remote prompt hides what is pasted; with neither, the remote side has no terminal and the laptop's terminal shows what is typed.
Each run prints the name, the length and the start of the SHA-256; compare it with `printf %s "$(pbpaste)" | shasum -a 256 | cut -c1-12` on the laptop while the same value is on the clipboard.

Only the console reads the two Grok Bot settings, so after both are set, recreate the console alone:

```sh
instabox ssh mandate -- 'cd /data/mandate/repo/deploy && docker compose --env-file /data/mandate/mandate.env up -d --no-deps --no-build console'
```

The console answers 502 for a few seconds while it restarts (about 3 seconds when an update recreated only the console and Caddy).
Nothing reads `GEMINI_API_KEY` or `GEMINI_API_SECRET` yet, so setting them needs no restart until a service does.
Then check that wake-ups are on, without showing either value: the console's Setup page says so in Advanced view, or from the laptop:

```sh
instabox ssh mandate -- 'docker exec mandate-mcp-1 node --input-type=module -e "const w = (await (await fetch(\"http://console:3000/api/console/snapshot\")).json()).wake; console.log(\"wake-ups enabled:\", w.enabled, \"| off because:\", w.offReason)"'
```

`enabled: true` means both values are set and the URL parses; whether Grok Bot accepts them shows on the Setup page after the first wake-up, as its result.

### Smoke test

From any computer, without secrets (the agent's address is public):

```sh
SMOKE_AGENT_ADDRESS=<agent address> deploy/smoke.sh https://8080-<machine id>.instabox.tech
```

With the MCP token, run it on the machine against its own public URL, so the token stays there:

```sh
instabox ssh mandate -- 'cd /data/mandate/repo/deploy && MCP_AUTH_TOKEN="$(sed -n "s/^MCP_AUTH_TOKEN=//p" /data/mandate/mandate.env)" ./smoke.sh "https://8080-<machine id>.instabox.tech"'
```

### Update

Copy a new archive as in [Deploy](#deploy), then on the machine:

```sh
cd /data/mandate
umask 022
rm -rf repo.old
mv repo repo.old
mkdir repo
tar -xzf mandate-src.tgz -C repo
grep -o '^[A-Z0-9_]*=' repo/deploy/mandate.env.template | grep -vxF -f <(grep -o '^[A-Z0-9_]*=' mandate.env)
```

The last line prints the names of settings the new version's template has and the env file does not (it prints no values).
Read each one's comment in `repo/deploy/mandate.env.template`, and add it to `/data/mandate/mandate.env` if it is required or wanted; `NEXT_PUBLIC_SITE_URL` is required for the landing page in gateway mode.
Then build, while the old version keeps serving:

```sh
cd /data/mandate/repo/deploy
MANDATE_ENV_FILE=/data/mandate/mandate.env ./build-site.sh    # only with compose.site.yml
docker compose --env-file /data/mandate/mandate.env build
```

Then swap to the new version, which is the only interruption, and clean up:

```sh
docker compose --env-file /data/mandate/mandate.env up -d --remove-orphans
docker compose --env-file /data/mandate/mandate.env up -d --force-recreate --no-deps caddy
docker image prune -f
docker builder prune -f --filter until=1h
```

Measured on the free machine, a swap that recreates every container took 25 to 36 seconds: the console answered 502 for 15 to 27 seconds and `/mcp` for 8 to 19, while the containers were recreated in order, and both for a second more while Caddy was recreated.
An update that changes only the console recreates only the console and Caddy, for about 4 seconds.
The prune keeps only the build cache the new version used (see [Update](#update) for why).
Pick a moment when nothing is scheduled to call the app, such as a Grok Bot routine at the top of the hour.
The landing page keeps serving the previous build until Caddy is recreated, then the new one.

The env file and the volumes are outside `repo`, so they are kept, and `repo.old` holds the previous version until the next update.
The update never writes the env file, so a password the owner sets in the meantime stays.
Caddy is recreated because its configuration files are mounted one by one from `repo`: after `mv repo repo.old` a running Caddy still reads the old files (checked on the machine), so new routes would apply only at its next restart.
Every other command in this runbook works the same way with `--env-file /data/mandate/mandate.env` added after `docker compose`.

### Pauses and the free plan's limits

A free machine pauses itself after 30 minutes without use, and wakes on the next request to a published URL.
A pause keeps memory and every process, so the stack carries on where it was: the containers are not restarted, the chain, the console's database and the tokens are as they were, and the console's poll picks up again.
Use means requests to a published port, commands and file copies over the CLI, SSH traffic, or CPU load.
The idle stack does not count as use: it needs about 0.02 vCPU (the bare machine about 0.01), because its health checks run every 5 minutes and it polls the chain once a second.

Measured on the free plan with the demo chain running and nobody using it:

- The machine paused 44 and 53 minutes after the last request, in two tries: InstaBox's 30 minutes plus however it samples use.
- The first request after the pause took 3.5 seconds, the next ones 0.3 to 0.4 seconds.
- After the wake every container had its original start time and no restart, and the chain, the contract and the console's data were unchanged.

Each wake starts a new run of at most 120 minutes.
With 5 minutes left, InstaBox looks at the last 30 minutes: 5 or more minutes of use add 120 minutes, 1 to 4 add 30, none lets the run end; one run lasts at most 480 minutes.
When a run ends, the machine pauses for a cooldown of 5 to 20 minutes (60 to 75 for a second one in a row, 120 to 135 after that).
During a cooldown nothing wakes the machine: the published URL fails (InstaBox documents `409 machine_cooldown` with a `Retry-After`; this setup has not met a cooldown yet), so the console, the scorecard and Grok Bot's connector are all unreachable until it ends.
An idle pause owes no cooldown and ends the run, so a machine that rests between visits rarely meets one.

Event wake-ups of Grok Bot's routine ([event-wake.md](event-wake.md)) add no timer: chain triggers ride on the console's poll and price checks run on it at most every 5 minutes.
While the machine is paused nothing is watched; the first poll after it wakes checks spot at once, and the hourly scheduled run stays the backstop.
A wake-up the console sends makes Grok Bot call `/mcp`, which is use and keeps the machine awake for that run.

The executor settles filled positions at expiry ([order-lifecycle.md](order-lifecycle.md#5-a-hosted-machine-that-pauses)) without keeping the machine awake: its 60-second timer calls neither Gemini nor the console until a position's ladder has expired, and then backs off while Gemini has not published the outcome.
A ladder that expires while the machine is paused is settled on the next wake, which the hourly scheduled run brings within the hour.
A cooldown comes when a run reaches its limit: after 8 hours of steady use, or when light use (a request now and then) keeps the machine from idling but is too little to extend the run.

Before a demo, wake the machine and check it:

```sh
instabox wake mandate
instabox get mandate        # "state": "running", "cooldownUntil": null
SMOKE_AGENT_ADDRESS=<agent address> deploy/smoke.sh https://8080-<machine id>.instabox.tech
```

If `cooldownUntil` is set, the machine cannot run before then.
`instabox get mandate` also shows `runStartedAt` and `maxRunMinutes`; if the run is close to its limit, let the machine idle-pause for 30 minutes first, and the wake starts a fresh run.

### Connect Grok Bot

In Grok Bot's connector, set the URL to `https://8080-<machine id>.instabox.tech/mcp`.
The connector's `Authorization` header is `Bearer ` and the token.
On a Mac, this copies exactly that value to the clipboard without showing it; paste it into Grok Bot:

```sh
instabox ssh mandate -- "sed -n 's/^MCP_AUTH_TOKEN=/Bearer /p' /data/mandate/mandate.env" | tr -d '\n' | pbcopy
```

Wake the machine before a session (`instabox wake mandate`): a connector call that has to wake it waits for the resume, and during a cooldown it fails.

## Limits

Each container has a memory limit, sized for VMs from 1 to 6 GB: Caddy 128 MB, console 512 MB, MCP server 384 MB, signal API, anvil, chain-init and executor 256 MB each.
Measured use with the demo running is about 20 MB for Caddy, 100 MB for the console, the signal API and the executor each, 115 MB for the MCP server and 10 MB for anvil.
