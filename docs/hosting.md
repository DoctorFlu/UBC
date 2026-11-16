# Hosting

This runbook puts the whole product on one small Linux VM with `docker compose up -d`, behind Caddy with an automatic HTTPS certificate.
The example host is an Oracle Cloud Always Free Ubuntu VM with a free `sslip.io` name, but nothing in the images or compose files depends on the host.
Any Linux VM with Docker, a public IP and ports 80 and 443 open works the same way, on arm64 or amd64.

## What runs

Everything is in [`deploy/`](../deploy).

| Container | What it is | Public |
| --- | --- | --- |
| `caddy` | TLS and routing for one hostname, and the owner's login. | ports 80 and 443 |
| `console` | The owner's console (Next.js, standalone build). | through Caddy |
| `mcp` | The MCP server Grok Bot connects to. | `/mcp` through Caddy |
| `signals` | The x402 signal API. Only the MCP server calls it. | no |
| `anvil` | Demo chain only: a local chain with Arc's chain id 5042002. | `/rpc`, behind the owner's login |
| `chain-init` | Demo chain only: deploys the Policy contract once, then exits. | no |
| `executor` | Demo chain only: the simulated executor, which records fills without placing orders. | no |

There are two modes, chosen by `COMPOSE_FILE` in `deploy/.env`.

- `compose.yml:compose.demo.yml` runs the self-contained demo chain.
  The contract is deployed with the demo rules on first start, and the chain keeps its state across restarts.
  The owner signs with the console's built-in test signer, anvil account 0, whose key is public.
- `compose.yml:compose.arc.yml` uses a Policy contract already deployed on Arc testnet.
  There is no anvil and no executor, and the owner signs with a real browser wallet.
  It refuses to start until `POLICY_ADDRESS`, `POLICY_DEPLOY_BLOCK` and `AGENT_PRIVATE_KEY` are set.

### Routes and who may use them

Caddy denies by default: every path that is not listed as public needs the owner's login.

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
| `mandate_chain` (demo chain only) | `anvil-state.json`, the chain itself, saved every 5 seconds and on shutdown, and `deployment.json`, the contract the other services use. | `anvil`, `chain-init`; read only for `console`, `mcp`, `executor` |
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

It checks both health endpoints, that `/mcp` refuses a request without the token and answers with it, that owner pages and APIs refuse a request without the login or with a wrong one, that the live event stream and a cross-site write behave, that the scorecard and its scripts are public, that the webhook checks its own signature, that `/api/agent/*` is not public, and, on the demo chain, that `/rpc` needs the login.
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
docker compose up -d --build --remove-orphans
docker image prune -f
```

Compose rebuilds the images, replaces only the containers whose image or settings changed, and keeps every volume.
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

## Limits

Each container has a memory limit, sized for VMs from 1 to 6 GB: Caddy 128 MB, console 512 MB, MCP server 384 MB, signal API, anvil, chain-init and executor 256 MB each.
Measured use with the demo running is about 20 MB for Caddy, 100 MB for the console, the signal API and the executor each, 115 MB for the MCP server and 10 MB for anvil.
