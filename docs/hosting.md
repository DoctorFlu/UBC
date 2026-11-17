# Hosting

This runbook puts the whole product on one small Linux VM with `docker compose up -d`, behind Caddy with an automatic HTTPS certificate.
The example host is an Oracle Cloud Always Free Ubuntu VM with a free `sslip.io` name, but nothing in the images or compose files depends on the host.
Any Linux VM with Docker, a public IP and ports 80 and 443 open works the same way, on arm64 or amd64.
A host without a public IP, whose own proxy ends TLS and forwards plain HTTP, uses gateway mode instead; [InstaBox](#instabox) below is the worked example.

## What runs

Everything is in [`deploy/`](../deploy).

| Container | What it is | Public |
| --- | --- | --- |
| `caddy` | TLS and routing for one hostname; it asks the console whether a request has a session. | ports 80 and 443, or one high port in gateway mode |
| `console` | The console (Next.js, standalone build): workspaces, passkey sign-in, and each workspace's mandate. | through Caddy |
| `mcp` | The MCP server Grok Bot connects to. | `/mcp` through Caddy |
| `signals` | The x402 signal API. Only the MCP server calls it. | no |
| `anvil` | Demo chain only: a local chain with Arc's chain id 5042002. | `/rpc`, for members of the first workspace only |
| `chain-init` | Demo chain only: deploys the Policy contract once, then exits. | no |
| `executor` | Demo chain only: the simulated executor, which records fills without placing orders. | no |

The chain is chosen by `COMPOSE_FILE` in `deploy/.env`.

- `compose.yml:compose.demo.yml` runs the self-contained demo chain.
  The contract is deployed with the demo rules on first start, and the chain keeps its state across restarts.
  The owner signs with the console's built-in test signer, anvil account 0, whose key is public.
- `compose.yml:compose.arc.yml` uses a Policy contract already deployed on Arc testnet.
  There is no anvil and no executor, and the owner signs with a real browser wallet.
  It refuses to start until `POLICY_ADDRESS`, `POLICY_DEPLOY_BLOCK` and `AGENT_PRIVATE_KEY` are set.
  The console keeps a database of its own in this mode; the switch is in [Arc testnet](#arc-testnet).

Two optional files go after the chain's:

- `compose.gateway.yml` is gateway mode, for a host behind a proxy that ends TLS (see [InstaBox](#instabox)).
  Caddy serves plain HTTP on `MANDATE_APP_PORT` (default 8080), published on `127.0.0.1` only, and handles no certificate.
- `compose.site.yml` serves the landing page, the static build of `site/` in `site/out`, as a second origin (see [Landing page](#landing-page)).

### Routes and who may use them

Caddy denies by default: every path that is not listed as public needs a signed-in member of a workspace.
The rules are in one file, [`deploy/caddy/app-routes.caddy`](../deploy/caddy/app-routes.caddy), which both the HTTPS `Caddyfile` and the gateway's `Caddyfile.gateway` import.
How workspaces, passkeys, sessions and agent tokens work is in [accounts.md](accounts.md).

| Path | Who | Check |
| --- | --- | --- |
| `/mcp` | Grok Bot | A bearer agent token. The MCP server asks the console which agent it belongs to, on every call, and acts for that agent's mandate only. |
| `/mcp/health` | anyone | None; it says only that the server is up. |
| `/api/webhooks/quicknode` | QuickNode | The console verifies QuickNode's HMAC signature and refuses stale or unsigned deliveries. |
| `/sign-in`, `/sign-up`, `/claim`, `/recover` and `/api/auth/*` | anyone | The way to a session: passkeys, invite, claim and recovery codes, each rate limited by the console. |
| `/agent/<address>` and its scripts under `/_next/static/` | anyone | None; this is the public scorecard, and it links to nothing private. |
| `/api/health` | anyone | None; it reports only `ok` and the feed's health. |
| `/api/agent/*` | nobody | Answers 404 publicly. The MCP server reaches it inside the Docker network with `CONSOLE_SERVICE_TOKEN`. |
| `/rpc` (demo chain only) | members of the first workspace | A session in the workspace that holds the demo chain's mandate. It forwards to anvil, so the browser's test signer can send transactions. |
| everything else (pages, `/api/console/*`) | members | A session. Caddy asks the console (`forward_auth` to `/api/auth/forward`), and the console checks it again and shows each member their own workspace only. |

A page opened without a session is sent to `/sign-in`, and an API request gets 401; nothing asks the browser for a password.
Members are needed because the console's pages and read APIs show holdings, hedge plans and decision contexts, and on the demo chain the owner's key is public, so wallet signatures alone prove nothing there.
A browser request from another site (`Sec-Fetch-Site: cross-site` or `same-site`) is refused unless it is a plain page navigation, and the console also checks the `Origin` of every write, so another site cannot use a signed-in browser to make changes.
The stock Caddy image has no rate limiter, so the limits on sign-in, sign-up, claim and recovery codes, and failed agent tokens are in the console and the MCP server.
They key on the client's address, which Caddy appends to `X-Forwarded-For` (`CONSOLE_TRUST_PROXY` and `MCP_TRUST_PROXY`, both set by compose).

The signal API is not routed at all.
Only the MCP server buys signals, it reaches the API inside the Docker network, and x402 settlement goes through Circle Gateway with no callback to this host.
Publishing it would only give strangers a way to spend its Gemini rate limit.

### State

Every file the product writes is in a named Docker volume, so `docker compose down` and image updates keep it.
Compose prefixes each name with the project name, `mandate`.

| Volume | Files | Used by |
| --- | --- | --- |
| `mandate_console-data` (`mandate_console-data-arc` on Arc testnet) | `console.sqlite` (with its `-wal` and `-shm`): workspaces, members, passkeys, sessions, agent tokens (as hashes) and the agents' keys (sealed with `CONSOLE_MASTER_KEY`), and each mandate's event cache, holdings, decision contexts, hedge plans, pairing, change requests and signal payments. | `console` |
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
```

`init-env.sh` copies [`mandate.env.template`](../deploy/mandate.env.template) to `deploy/.env` with mode 600, and fills `MCP_AUTH_TOKEN`, `CONSOLE_SERVICE_TOKEN` and `CONSOLE_MASTER_KEY` with fresh random values without printing them.
`CONSOLE_MASTER_KEY` encrypts the agents' keys the console holds: keep a copy of `deploy/.env` somewhere safe, apart from the volume backups, because without the key those agent keys cannot be opened.

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

It accepts only `GROK_WEBHOOK_URL`, `GROK_WEBHOOK_KEY`, `GEMINI_API_KEY`, `GEMINI_API_SECRET`, `QUICKNODE_STREAM_SECURITY_TOKEN`, and the Arc testnet keys `AGENT_PRIVATE_KEY` and `EXECUTOR_PRIVATE_KEY` (see [Arc testnet](#arc-testnet)); the tokens and the master key are generated.
It drops one trailing newline and refuses an empty value, a line break or other control character, a character outside printable ASCII (a non-breaking space from a web page), a space at either end and a single quote; the URL must start with `https://`, a key must be `0x` and 64 hex digits, and the Stream's token at least 32 characters.
It writes the line as `NAME='value'`, because docker compose would otherwise expand a `$` in the value and cut it at ` #`.
The file is rebuilt next to itself with mode 600 and moved over the old one, so it is never half written, and a failure leaves no temporary file; run it as the file's owner, so the owner stays.
It prints only the name, the value's length and the first 12 hex digits of its SHA-256, which the owner can compare with `printf %s "$(pbpaste)" | shasum -a 256 | cut -c1-12` on their own computer.
The executor reads `GEMINI_API_KEY` and `GEMINI_API_SECRET` when `EXECUTOR_VENUE=gemini` ([gemini-venue.md](gemini-venue.md)); it trades on Gemini's sandbox only, and the demo chain refuses production.

For the Arc testnet mode, follow [Arc testnet](#arc-testnet): keys from `npm run arc:keygen`, gas and roles until `npm run arc:doctor` says `READY`, then `COMPOSE_FILE=compose.yml:compose.arc.yml` with `POLICY_ADDRESS` and `POLICY_DEPLOY_BLOCK`.
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
./smoke.sh https://<host>
```

Without `MCP_AUTH_TOKEN` it skips the MCP checks that need a token, so it can run from a machine that should not hold one; set `SMOKE_AGENT_ADDRESS` to the agent's address then, for the scorecard check.
With `CONSOLE_SESSION`, the value of the console's session cookie copied from a signed-in browser (`read -rs CONSOLE_SESSION && export CONSOLE_SESSION`), it also checks the signed-in routes.

It checks both health endpoints, that `/mcp` refuses a request without a token or with an unknown one and answers `initialize`, `tools/list` and a read-only `whoami` call with the token, that member APIs answer 401 without a session or with a wrong one and pages send the browser to `/sign-in`, that nothing asks for a password, that cross-site writes and sign-ins are refused, that the account pages, the scorecard and its scripts are public, that the webhook checks its own signature, that `/api/agent/*` is not public, and, on the demo chain, that `/rpc` needs a session.
With a session it also checks the console, the snapshot, the Agents data and the live event stream.
It ends with `All checks passed.`

### Claim the first workspace

The first workspace holds the server's own mandate: the contract from the env file, its agent and `MCP_AUTH_TOKEN`.
Nobody can see it until it is claimed, with a one-time code that only the server prints:

```sh
docker compose exec console node dashboard/admin.mjs claim-code
```

The code works once, for 24 hours, and only its hash is stored.
Open `https://<host>/claim` on the device that will hold your passkey, enter your name and the code, and create the passkey.
The console then shows a recovery code once: keep it in a password manager, because it is the way back in if every passkey is lost.
`docker compose exec console node dashboard/admin.mjs status` shows whether the workspace is claimed, and `invite` prints a one-time code that lets one more person create a workspace of their own on `/sign-up`.

## 6. Connect Grok Bot

In Grok Bot, open **Connect apps** and add a custom connector:

- URL: `https://<host>/mcp`
- Header: `Authorization` with the value `Bearer ` followed by the token.

The token is either `MCP_AUTH_TOKEN`, the first workspace's agent token from the env file, or one made in the console under **Setup**, **Agents**, which shows a new token once.
Every workspace connects its own Grok Bot with its own token, and each token reaches only its own workspace's mandate.
To see the env file's token, run `sed -n 's/^MCP_AUTH_TOKEN=//p' deploy/.env` in your own terminal and copy it into Grok Bot.
Never paste it into a chat, an issue or a pull request.
Revoking a token in the Agents section stops it on its next call, `MCP_AUTH_TOKEN` included.
The rest of the connector setup is in [agent/README.md](../agent/README.md#connect-grok-bot).

The first time Grok Bot connects, it asks to pair and gives you a link to `https://<host>/setup/pair/<agent>`.
Open it, sign in, and confirm.
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

`mandate_chain` exists only in the demo mode; skip it otherwise, and on Arc testnet add `console-data-arc` to the list.
Archive each volume whole: the console's SQLite file runs in WAL mode, so `console.sqlite` alone, without its `-wal` file, can be almost empty.
To back it up without stopping anything, as before an update that changes its schema, see [Updates that change the console's database](#updates-that-change-the-consoles-database).
Copy the archives off the VM, together with `deploy/.env`, which holds the tokens and keys and must stay private.
The console's archive is useless without the `CONSOLE_MASTER_KEY` that was in `deploy/.env` when it was made: it seals the agents' keys.

To copy the console's database without stopping anything, use SQLite's online backup, never a plain file copy.
The database runs in WAL mode, so recent writes may still be only in `console.sqlite-wal`, and a copy of `console.sqlite` alone can miss them:

```sh
docker compose exec console node -e 'const {DatabaseSync,backup}=require("node:sqlite");const db=new DatabaseSync(process.argv[1],{readOnly:true});backup(db,process.argv[2]).then((pages)=>{db.close();new DatabaseSync(process.argv[2]).exec("PRAGMA journal_mode=DELETE");console.log("backed up",pages,"pages")})' /data/console/console.sqlite "/data/console/backup-$(date +%F-%H%M).sqlite"
docker compose cp "console:/data/console/backup-<date>.sqlite" ~/mandate-backups/
```

The copy is one self-contained file.
To restore it, stop the stack, copy it into the volume as `console.sqlite`, and remove any `console.sqlite-wal` and `console.sqlite-shm` beside it.

To restore, with the stack stopped (`docker compose down`), unpack each archive into its volume, then start:

```sh
docker volume create mandate_console-data
docker run --rm -v mandate_console-data:/v -v ~/mandate-backups:/b alpine:3.20 tar xzf /b/console-data-<date>.tgz -C /v
docker compose up -d
```

Losing `mandate_console-data` loses the workspaces, members and passkeys, the agents' keys the console holds, and the offchain records (holdings, contexts, plans, pairing); the console rebuilds the onchain part from the chain, and the first workspace can be claimed again.
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
- It passes `Authorization` (the agent tokens), `Cookie` (the console's session) and the browser's `Origin` and `Sec-Fetch-*` headers unchanged, so sign-in, the token check and the cross-site check work as on a VM.
  It puts the client in `X-Forwarded-For`, and Caddy appends the proxy's private address, so the rate limits key on the client.
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
| `/data/mandate/mandate.env` | The env file, mode 600: the tokens and the console's master key. |
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

`init-env.sh` creates the tokens and the master key on the machine; they never leave it.
In `/data/mandate/mandate.env`, set:

- `COMPOSE_FILE=compose.yml:compose.demo.yml:compose.gateway.yml`;
- `MANDATE_HOST=8080-<machine id>.instabox.tech`;
- `X402_SELLER_ADDRESS`, the address that receives signal payments.

Until the first workspace is claimed, nobody can see it.
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

### Claim the first workspace

The owner prints a claim code from their own terminal; it is shown once and only its hash is stored:

```sh
instabox ssh mandate -- 'cd /data/mandate/repo/deploy && docker compose --env-file /data/mandate/mandate.env exec console node dashboard/admin.mjs claim-code'
```

Then open `https://8080-<machine id>.instabox.tech/claim` on the device that will hold the passkey, as in [Claim the first workspace](#claim-the-first-workspace).
The passkey belongs to that public name, so a machine with a new id needs new passkeys.

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
Only the executor reads `GEMINI_ENV`, `GEMINI_API_KEY`, `GEMINI_API_SECRET` and `EXECUTOR_VENUE`, so after setting them recreate the executor alone (`... up -d --no-deps --no-build executor`).
Check the key first with the doctor in the executor's container, which prints neither value: `docker compose --env-file /data/mandate/mandate.env run --rm --no-deps executor node --import tsx gemini/scripts/doctor.ts`.
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
The update never writes the env file, so a value the owner sets in the meantime stays.
Caddy is recreated because its configuration files are mounted one by one from `repo`: after `mv repo repo.old` a running Caddy still reads the old files (checked on the machine), so new routes would apply only at its next restart.
Every other command in this runbook works the same way with `--env-file /data/mandate/mandate.env` added after `docker compose`.

### Updates that change the console's database

The console keeps its records in SQLite, `/data/console/console.sqlite` in the `mandate_console-data` volume.
Its schema version is `PRAGMA user_version`: one per entry of `MIGRATIONS` in `dashboard/src/server/db.ts`.
The new console upgrades the file when it first opens it, one version per transaction, and nothing ever downgrades it.
After the first block of [Update](#update-1), this shows whether the new version changes the schema (any added `MIGRATIONS` entry does):

```sh
diff /data/mandate/repo.old/dashboard/src/server/db.ts /data/mandate/repo/dashboard/src/server/db.ts
```

If it does, back up the live file and rehearse the upgrade on a copy before the swap, as below.
The steps were first used for the update from version 5 to 6 (the `settlements` table) on 17 Nov 2026.

> **Never back up `console.sqlite` by copying the file.**
> The database runs in WAL mode, and recent writes stay in `console.sqlite-wal` until SQLite checkpoints them.
> On the machine the main file was 4 KB while the data, about 230 KB, was all in a 647 KB WAL, so a copy of `console.sqlite` alone is almost empty.
> SQLite's backup API, below, copies a consistent snapshot while the console keeps running.

1. Before the build, keep the running images under a rollback tag; the build moves `demo` and `latest` to the new images, and `docker image prune` would then delete the old ones.
   The next update's tag replaces these, so the old images go with that update's prune.

   ```sh
   docker tag mandate-console:demo mandate-console:rollback     # mandate-console:arc on Arc testnet
   docker tag mandate-services:latest mandate-services:rollback
   ```

2. After the build, back up the live database with SQLite's backup API inside the running console, into its `/tmp`, then stream the copy out.
   The console's `/tmp` is a tmpfs, which `docker cp` cannot read, so the copy leaves through `docker exec cat`.
   The copy is switched to a plain journal, so it is one self-contained file; put the current version (here 5) in its name.

   ```sh
   mkdir -p -m 700 /data/mandate/backups
   b=/data/mandate/backups/console-$(date -u +%Y%m%dT%H%M%SZ)-v5.sqlite
   docker exec mandate-console-1 node --no-warnings -e '
   const { DatabaseSync, backup } = require("node:sqlite");
   backup(new DatabaseSync("/data/console/console.sqlite", { readOnly: true }), "/tmp/backup.sqlite").then(() => {
     const copy = new DatabaseSync("/tmp/backup.sqlite");
     copy.exec("PRAGMA journal_mode = DELETE");
     copy.close();
   });'
   (umask 077; docker exec mandate-console-1 cat /tmp/backup.sqlite > "$b")
   docker exec mandate-console-1 rm /tmp/backup.sqlite
   ```

   Keep the file: it is also the rollback point.
   It holds the owner's private records (holdings, plans, pairing, payments), so it stays mode 600 in a folder of mode 700, and never leaves the machine unencrypted.
   Each one is a few hundred KB; delete old ones once a later update has run for a while.

3. Check the copy against the live file: the same version, `integrity_check` ok, and the same rows and content hash in every table.

   ```sh
   sum='const { DatabaseSync } = require("node:sqlite"); const { createHash } = require("node:crypto");
   const db = new DatabaseSync(process.argv[1], { readOnly: true });
   console.log("version", db.prepare("PRAGMA user_version").get().user_version, "integrity", db.prepare("PRAGMA integrity_check").get().integrity_check);
   for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = ? ORDER BY name").all("table")) {
     const rows = db.prepare(`SELECT * FROM "${name}"`).all();
     console.log(name, rows.length, createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 12));
   }'
   r=$(mktemp -d)
   docker exec mandate-console-1 node --no-warnings -e "$sum" /data/console/console.sqlite > "$r/live.txt"
   docker run --rm --network none --user "$(id -u):$(id -g)" -v "$b:/copy.sqlite:ro" --entrypoint node mandate-services:latest --no-warnings -e "$sum" /copy.sqlite > "$r/backup.txt"
   diff "$r/live.txt" "$r/backup.txt" && echo "backup matches the live database"
   ```

4. Rehearse the upgrade on a second copy, never on the live file or the kept backup.
   This runs the new version's own `openDatabase` (`db.ts`, the code the console runs when it starts) in a throwaway container of the new services image, without network.
   `db.ts` starts with `import "server-only"`, a marker Next.js resolves to an empty module on the server; the services image does not have it, so an empty one stands in.

   ```sh
   mkdir -p "$r/db" "$r/code/node_modules/server-only"
   cp "$b" "$r/db/console.sqlite"
   cp /data/mandate/repo/dashboard/src/server/db.ts "$r/code/"
   echo '{ "name": "server-only", "main": "index.js" }' > "$r/code/node_modules/server-only/package.json"
   touch "$r/code/node_modules/server-only/index.js"
   echo 'import { DatabaseSync } from "node:sqlite";
   import { openDatabase } from "./db.ts";
   for (const pass of ["first", "second"]) {
     const before = new DatabaseSync("/rehearsal/console.sqlite").prepare("PRAGMA user_version").get().user_version;
     const db = openDatabase("/rehearsal");
     console.log(pass, "open: version", before, "->", db.prepare("PRAGMA user_version").get().user_version);
     db.close();
   }' > "$r/code/migrate.mjs"
   docker run --rm --network none --user "$(id -u):$(id -g)" -v "$r/code:/app/rehearsal:ro" -v "$r/db:/rehearsal" --entrypoint node mandate-services:latest --no-warnings --import tsx /app/rehearsal/migrate.mjs
   docker run --rm --network none --user "$(id -u):$(id -g)" -v "$r/db:/rehearsal" --entrypoint node mandate-services:latest --no-warnings -e "$sum" /rehearsal/console.sqlite > "$r/upgraded.txt"
   diff "$r/backup.txt" "$r/upgraded.txt"
   ```

   The first open must go from the old version to the new one and the second must change nothing (`6 -> 6`).
   The `diff` must show only the version line and the new tables, each with 0 rows: every earlier table keeps its rows and hash, and `integrity` stays `ok`.
   If anything else differs, stop: nothing live has changed yet, and the swap waits for a fix.

5. Swap as in [Update](#update-1), then compare the live file with the backup, and clean up:

   ```sh
   docker exec mandate-console-1 node --no-warnings -e "$sum" /data/console/console.sqlite > "$r/live-after.txt"
   diff "$r/backup.txt" "$r/live-after.txt"
   rm -rf "$r"
   ```

   The same `diff` as in the rehearsal is expected, with one more line: `signal_budget` changes its hash on every update, because the MCP server sends the console its budget again when it starts.
   Only the times in that row change (`as_of`, `stored_at` and the snapshot's `asOf`), not the amounts.

If the new version misbehaves after the swap, roll back to the old images and the old `repo`.
After an update that only adds tables, the old console runs on the upgraded file as it is: its `migrate()` starts at the file's version, finds no step to apply, and ignores tables it does not know.
So the backup is restored only if the upgrade damaged the data, and restoring it loses what was written since the backup (the onchain part comes back from the chain, offchain records do not).
An update that changes existing tables, such as [the upgrade to workspaces](#upgrade-to-workspaces-once), must restore the backup on a rollback: the old console cannot read the changed tables.
The rollback is three blocks, and the second one is run only to restore the backup.

First, put the old `repo` and the old images back:

```sh
cd /data/mandate
mv repo repo.failed
mv repo.old repo
docker tag mandate-console:rollback mandate-console:demo         # :arc on Arc testnet
docker tag mandate-services:rollback mandate-services:latest
```

Second, and only if the data was damaged, restore the backup.
Skip this block to keep the upgraded file.
In a new shell, set `b` to the kept backup's path first.

```sh
cd /data/mandate/repo/deploy
docker compose --env-file /data/mandate/mandate.env stop console executor
docker run --rm --network none -v mandate_console-data:/v -v "$b:/backup.sqlite:ro" --entrypoint sh mandate-services:latest -c \
  'mkdir -p /v/failed && mv -f /v/console.sqlite* /v/failed/ && cp /backup.sqlite /v/console.sqlite && chmod 644 /v/console.sqlite'
```

Third, start the old version:

```sh
cd /data/mandate/repo/deploy
docker compose --env-file /data/mandate/mandate.env up -d --no-build --remove-orphans
docker compose --env-file /data/mandate/mandate.env up -d --force-recreate --no-deps caddy
```

The WAL and shared-memory files go with the file they belong to: a stale WAL next to the restored file would be replayed over it, so the copy runs only after they have moved.
The container runs as the console's user (`node`, uid 1000), so the restored file has the console's owner.
`repo.old` is gone after the next update, so a rollback is possible only until then.

### Upgrade to workspaces (once)

The first version with workspaces and passkeys (issue #94) changes the console's database and how everyone signs in.
It is an update that changes the console's database, run exactly as in [Updates that change the console's database](#updates-that-change-the-consoles-database), with these differences:

- **Before the build**, add the master key; `init-env.sh` adds `CONSOLE_MASTER_KEY` and leaves every other line of the env file exactly as it was:

  ```sh
  cd /data/mandate
  MANDATE_ENV_FILE=/data/mandate/mandate.env repo/deploy/init-env.sh
  ```

  Keep a copy of `/data/mandate/mandate.env` off the machine from now on: the master key in it is the only way to open the agents' keys the console will hold.
  The old login's settings (`CONSOLE_USER`, `CONSOLE_PASSWORD_HASH`) are no longer read and can stay where they are.
- **The rehearsal** goes from the current version to 8, then `8 -> 8`.
  The machine is at 7 once the Gemini venue update (#108, the venue order journal) has run, so `7 -> 8`; a machine that skipped it goes `6 -> 8`, and one that also skipped the settlements update `5 -> 8`, and their `diff` also shows those updates' new tables, empty.
  The `diff` shows more than new empty tables, because the upgrade gives every record to the first workspace:
  - the version line;
  - new tables `workspaces`, `mandates` and `agents` with 1 row each, and `members`, `passkeys`, `sessions`, `recovery_codes`, `ceremonies`, `access_codes` and `agent_tokens` with 0;
  - `holdings`, `decision_contexts`, `hedge_plans`, `policy_change_requests`, `pairings`, `intent_context_links`, `signal_payments`, `signal_budget`, `wake_deliveries`, `wake_sources` and `wake_price_memory` with the same number of rows as before and, when they have rows, a new hash, because each row gains the first mandate's id.

  `policy_events`, `ingest_cursors`, `intent_details`, `market_listings`, `settlements`, `venue_orders` and `executor_venues` keep their rows and their hash: they stay keyed by deployment ([accounts.md](accounts.md#the-model)).
  Any other change, a different row count above all, means stop.
  The comparison after the swap shows the same tables changed, but not the rehearsal's hashes: the first workspace's ids are random, so the live upgrade gives the records another mandate id than the rehearsal did; compare the row counts.
  It may also show rows in `access_codes`, `agent_tokens` and `sessions`, from a claim code, Grok Bot's first call with the env file's token, and a sign-in, and a new hash in `executor_venues` and `ingest_cursors`, from the executor's announcement when it starts and the console's reading of the chain.
  `dashboard/src/server/db.test.ts` upgrades a database of the hosted schema with rows in every table, checks every count, and reads the records back through the console's stores.
- **During the swap**, `/mcp` cannot be reached for about ten seconds: Caddy answers 502 while the MCP server restarts, then refuses connections while Caddy itself restarts (its routes changed).
  The MCP server starts only once the console is healthy, and asks the console about every token, never guessing; if the console stops answering later, `/mcp` answers 503 with `Retry-After: 5`.
  In the rehearsal on Docker (17 Nov 2026), Grok Bot's calls failed for 10.2 s and then worked with the env file's token on the first try.
- **After the swap**, run the smoke test with the token as in [Smoke test](#smoke-test): Grok Bot's token from the env file is now the first workspace's agent token, and works as before.
  Then claim the first workspace as in [Claim the first workspace](#claim-the-first-workspace-1); until then the console shows nobody its data.
  Under **Setup**, **Agents**, the first workspace's agent lists the env file's token, with when Grok Bot last used it.
- **Between the swap and the claim** the owner cannot sign in, and everything that does not need the owner keeps working:
  - Grok Bot's hourly run: `/mcp` resolves the env file's token to the first workspace's agent on its first call (and registers it), and every tool works as before.
    Only during the swap itself, about ten seconds, can `/mcp` not be reached, so swap away from the run's hour mark.
  - The contract approves a proposal inside the mandate's rules by itself, as always, and the executor places and settles it; it keeps storing settlements and its venue order journal, the event wake-ups keep going to Grok Bot's webhook, the console keeps following the chain, and `/agent/<address>` stays public.
  - The owner gets nothing: every console page sends them to `/sign-in`, which has no passkey yet to offer, and every `/api/console/*` request is refused with 401.
    So no holdings change, and no pairing or change request is confirmed.
    An intent the contract holds for the owner's approval waits, since approving is a transaction from the owner's wallet that the console's pages send; until the claim only another wallet tool could send it.
  - A console tab left open from before the swap keeps its old page: its live stream drops when the console restarts and comes back refused, so the page shows the last data it had with the lamp on reconnecting, and a write from it fails.
    Reloading it goes to `/sign-in`.
    Pages of the new version go to `/sign-in` by themselves when their stream is refused.
  - The claim ends the window: the owner then sees everything that happened in it.
- **A rollback restores the backup**: run all three blocks of the rollback, the second one included.
  The previous console cannot read the upgraded tables, whose rows now carry a mandate.
  On a version 8 file it starts, but its health check, its pages and the agent API's holdings answer 500 (`no such column: id`), as the version 7 image did on Docker on 17 Nov 2026; the MCP server and Caddy wait for a healthy console, so they are not started either.
  Passkeys made after the swap stay on their devices unused.

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

## Arc testnet

This switches a running demo-chain stack to the Policy contract on Arc testnet, `0x571D8ea7C86c80a230C10818743f8861084F82f3` (deploy block 72740419, [contracts/README.md](../contracts/README.md)).
The commands are for the InstaBox machine (env file `/data/mandate/mandate.env`, code in `/data/mandate/repo`); on a plain VM, drop `--env-file ...` and edit `deploy/.env` instead.
What each setting means, the doctor, and the RPC budget are in [configuration.md](configuration.md#arc-testnet).

What changes:

- `COMPOSE_FILE` takes `compose.arc.yml` instead of `compose.demo.yml`: no anvil, no `chain-init`, no demo executor, and a console image (`mandate-console:arc`) without the test signer, so the owner signs with their own browser wallet.
- The env file gains `POLICY_ADDRESS`, `POLICY_DEPLOY_BLOCK`, `AGENT_PRIVATE_KEY` and `EXECUTOR_PRIVATE_KEY`; `ARC_RPC_URL` stays empty, so every service uses Arc's public RPC and spends no QuickNode credits.
- The console uses a database of its own, in the volume `mandate_console-data-arc`, and leaves the demo chain's `mandate_console-data` as it is.
  Chain events are kept per deployment, but the first mandate's offchain records (holdings, hedge plans, change requests, wake-ups) are kept per mandate, so in one database the demo chain's would show against the Arc contract.
  So on Arc the first workspace is claimed again, with new passkeys; `MCP_AUTH_TOKEN` keeps working for Grok Bot (the console registers it on first use), but tokens made in the Agents section belong to the demo database.
  Switching back to the demo chain finds its database, its chain and its tokens as they were.
- Nothing executes approved intents on Arc yet: the executor's Arc support (its key, its role check, the simulated venue as the default) comes after #118, with an `executor` service in `compose.arc.yml`.

### 1. Keys, gas and roles (before touching the machine)

On the laptop, in the clone whose `.env` holds the Arc settings:

```sh
npm run arc:keygen                        # prints the agent and executor addresses, never the keys
npm run arc:doctor -- --owner 0x<owner>   # lists what is missing
```

Then, in this order, until the doctor says `READY`:

1. **Faucet** (the owner has approved it; a person does it in a browser): open https://faucet.circle.com, choose **Arc Testnet** and USDC, paste the agent address and request; repeat for the executor address.
   Arc pays gas in USDC: one faucet drip covers hundreds of proposals and `recordResult` calls (the doctor prints how many).
2. **Roles**: the owner calls `setAgent(<agent address>)` and `setExecutor(<executor address>)` on the contract from their wallet, exactly as the doctor prints them.
3. `npm run arc:doctor -- --owner 0x<owner>` again: it must end `READY`.

Run the doctor again after any later `setUser`, `setAgent` or `setExecutor`: the roles can change at any time.

### 2. Back up the demo database

The demo database is not touched by the switch, but back it up first anyway, as in step 2 of [Updates that change the console's database](#updates-that-change-the-consoles-database) (SQLite's online backup inside the running console, never a file copy).

### 3. Put the keys on the machine

The keys go from the laptop's env file to the machine's through a pipe into `set-secret.sh`, so they are never on a command line, in shell history, on a screen or in a log; `set-secret.sh` checks that each is `0x` and 64 hex digits and prints only its length and a hash:

```sh
sed -n 's/^AGENT_PRIVATE_KEY=//p' .env | instabox ssh mandate -- 'MANDATE_ENV_FILE=/data/mandate/mandate.env /data/mandate/repo/deploy/set-secret.sh AGENT_PRIVATE_KEY'
sed -n 's/^EXECUTOR_PRIVATE_KEY=//p' .env | instabox ssh mandate -- 'MANDATE_ENV_FILE=/data/mandate/mandate.env /data/mandate/repo/deploy/set-secret.sh EXECUTOR_PRIVATE_KEY'
```

Compare each printed hash with `sed -n 's/^AGENT_PRIVATE_KEY=//p' .env | tr -d '\n' | shasum -a 256 | cut -c1-12` on the laptop.
The demo compose file ignores both lines (its agent key is in `compose.demo.yml`), so setting them changes nothing until the switch.
After the switch, the laptop must not run its own stack against Arc with the same keys: two processes signing with one key race for its nonces.

### 4. Switch

In `/data/mandate/mandate.env`, with an editor (none of these is a secret):

- `COMPOSE_FILE=compose.yml:compose.arc.yml:compose.gateway.yml` (add `:compose.site.yml` if the landing page is served);
- `POLICY_ADDRESS=0x571D8ea7C86c80a230C10818743f8861084F82f3` and `POLICY_DEPLOY_BLOCK=72740419`;
- `ARC_RPC_URL=` (empty: Arc's public RPC) and `CONSOLE_EVENT_SOURCE=rpc`.

Then build the Arc console image, start, and remove the demo chain's containers (their volumes stay):

```sh
cd /data/mandate/repo/deploy
docker compose --env-file /data/mandate/mandate.env up -d --build --remove-orphans
```

Compose refuses to start while `POLICY_ADDRESS`, `POLICY_DEPLOY_BLOCK` or `AGENT_PRIVATE_KEY` is missing, and the MCP server refuses to start with one of anvil's published keys.

### 5. Claim and check

1. Claim the first workspace again, as in [Claim the first workspace](#claim-the-first-workspace-1), and connect the owner's wallet in the console.
2. `/api/health` reports the feed; the console reads the contract's history from block 72740419 once (a few `eth_getLogs` calls of 5,000 blocks), then polls every second.
3. The Setup page and the MCP server's `get_setup_state` show the agent's address and gas, and the contract's roles.
4. Before any trade, `npm run arc:doctor -- --owner 0x<owner>` on the laptop ends `READY`.

### Back to the demo chain

Put `COMPOSE_FILE` back to `compose.yml:compose.demo.yml:compose.gateway.yml` and run the same `up -d --build --remove-orphans`.
The demo chain, its contract and its database are as they were left; the Arc lines in the env file are ignored by the demo compose file.
If the QuickNode Stream is active, pause it first ([quicknode-streams.md](quicknode-streams.md#plan-for-the-arc-deployment-19)).

## Limits

Each container has a memory limit, sized for VMs from 1 to 6 GB: Caddy 128 MB, console 512 MB, MCP server 384 MB, signal API, anvil, chain-init and executor 256 MB each.
Measured use with the demo running is about 20 MB for Caddy, 100 MB for the console, the signal API and the executor each, 115 MB for the MCP server and 10 MB for anvil.
