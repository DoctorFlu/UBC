# Configuration

Every service reads its settings from environment variables.
For local work they live in a `.env` file at the repository root, which is git-ignored.
Never commit `.env`, and never paste its values into chat, issues or pull requests.

Scripts that create secrets write them straight into `.env` without printing them.

## Chain

| Variable | Required | Meaning |
| --- | --- | --- |
| `ARC_RPC_URL` | no | Arc testnet RPC endpoint. Defaults to `https://rpc.testnet.arc.io`. |
| `POLICY_ADDRESS` | no | Deployed Policy contract. When empty, the local devchain deployment is used. |
| `POLICY_DEPLOY_BLOCK` | no | Block the Policy contract was deployed in, so event scans start there instead of block 0. The MCP server reads it too, to recover rejection reasons from events; when it is unset, the server scans only the last 200,000 blocks. |
| `POLICY_DEPLOYMENT_FILE` | no | Local deployment file to use when `POLICY_ADDRESS` is empty. Defaults to `devchain/deployments/local.json`, which `npm run dev:chain` writes, for the console and the scripts. Tests that run their own chain point every process at their own file. The MCP server reads it only when it is set explicitly, taking the contract, its deploy block and the RPC from it; the hosted demo chain uses this. |

Switching the console, the agent and the scripts from the local devchain to Arc testnet is configuration only: set `POLICY_ADDRESS`, `POLICY_DEPLOY_BLOCK` and, if you use a provider, `ARC_RPC_URL`.
The browser never receives `ARC_RPC_URL`, because it may carry a provider key; it uses Arc's public RPC.

## Agent (MCP server)

| Variable | Required | Meaning |
| --- | --- | --- |
| `AGENT_PRIVATE_KEY` | for trading tools | Key of the agent's Arc account. It can only propose trades. |
| `MCP_AUTH_TOKEN` | yes | The first workspace's agent token, at least 32 characters, which Grok Bot presents to the MCP server. The console registers its hash the first time it is used and decides about it from then on, like any token made in the Agents section; once revoked there it stays revoked (see [accounts.md](accounts.md#the-env-file-token)). Create it with `npm run mcp:token`. |
| `MCP_TRUST_PROXY` | no | `true` when a reverse proxy appends the client to `X-Forwarded-For` (Caddy in the hosted stack), so the limit on failed tokens keys on the client. Defaults to `false`: every client shares one bucket. |
| `MCP_PORT` | no | Port of the MCP server. Defaults to `8787`. |
| `MCP_HOST` | no | Interface the MCP server listens on. Defaults to `127.0.0.1`. |
| `MCP_ALLOWED_ORIGINS` | no | Comma-separated hostnames allowed in a browser `Origin` header, in addition to localhost. |
| `MCP_LOG_LEVEL` | no | `debug`, `info`, `warn` or `error`. Defaults to `info`. |
| `MCP_ADVERTISE_OUTPUT_SCHEMAS` | no | `true` to include each tool's output schema in `tools/list`. Defaults to `false`, which makes the list about four times smaller; results are validated on the server either way. |

The MCP server starts with only `MCP_AUTH_TOKEN`, but it answers calls only with `CONSOLE_SERVICE_TOKEN` too: it asks the console which agent every token belongs to, and refuses every call (503) while it cannot.
A variable marked "for ... tools" becomes required once a registered tool declares it; until then `get_setup_state` reports it as a remaining step.
See [agent/README.md](../agent/README.md).

## Console

| Variable | Required | Meaning |
| --- | --- | --- |
| `CONSOLE_URL` | no | Public address of the console. The MCP server calls it, the console builds the pairing link from it, and it is the passkeys' origin and the `Origin` every write must carry. Defaults to `http://localhost:3000`. |
| `CONSOLE_SERVICE_TOKEN` | for console tools | Shared secret between the console backend and the MCP server, sent as a bearer token and compared in constant time. Without it every `/api/agent/v1` route answers 503, so the MCP server cannot resolve tokens. |
| `CONSOLE_DATA_DIR` | no | Folder for the console's SQLite store (workspaces, members, passkeys, sessions, agent tokens and sealed agent keys, events, contexts, holdings, hedge plans, pairing, change requests, signal payments and budget, Gemini's listing of each intent's market, event wake-ups, and the executor's settlement records). Defaults to `dashboard/.data`, which is git-ignored. Deleting it loses the workspaces and the keys the console holds; the console rebuilds the onchain part from the chain, and the executor records each settlement again the next time it starts. |
| `CONSOLE_MODE` | no | `production` or `development`. Defaults to `production` when `NODE_ENV=production`. Production refuses to start without a master key and refuses open sign-up. |
| `CONSOLE_MASTER_KEY_FILE` | in production, this or the next | File holding the master key that seals the agents' keys: 32 bytes as 64 hex digits, base64 or base64url. Preferred where the platform mounts secrets as files. |
| `CONSOLE_MASTER_KEY` | in production, this or the previous | The master key itself, for hosts whose secrets live in an env file; `deploy/init-env.sh` creates it for the hosted stack. Set one of the two, not both. In development without either, the console creates `master.key` (mode 600) in its data folder and logs that it did, without the value. |
| `CONSOLE_SIGNUP` | no | `invite` (needs a code from the admin command's `invite`) or `open`. Defaults to `invite` in production, where `open` is refused, and `open` in development. |
| `CONSOLE_WEBAUTHN_RP_ID` | no | The passkeys' relying party id: the host name of `CONSOLE_URL` (the default) or a parent domain of it. Passkeys made for one value do not work with another. |
| `CONSOLE_TRUST_PROXY` | no | `true` when a reverse proxy appends the client to `X-Forwarded-For` (Caddy in the hosted stack), so the sign-in, code and token limits key on the client. Defaults to `false`. |
| `CONSOLE_EVENT_SOURCE` | no | `rpc` (default) polls the chain for Policy events. `stream` takes the QuickNode Stream webhook as the primary source and keeps a slow RPC poll to fill gaps. |
| `CONSOLE_POLL_INTERVAL_MS` | no | How often the RPC poller asks for new blocks. Defaults to 250 ms on the local devchain and 1 s on Arc testnet. The hosted demo chain sets 1 s. |
| `GEMINI_API_URL` | no | Gemini's public REST API, which the console reads (server side, cached for 10 s, no key) for the hedge view's live ladder and preview, and to check each intent's market against Gemini's listing (once per market, in the background; the answer is stored, so each market costs one lookup ever). For ladders it only asks about assets Gemini lists and the events of plans the console stores, and keeps at most 32 ladders. Listing checks have a budget of their own inside the client's 100 requests a minute: at most 24 requests in any 60 s and 12 a minute sustained, counted as the most each lookup could send (4 candidate event tickers, each tried twice) until it says what it sent. Intents waiting for approval are checked first, then the newest, and the queue never holds more than the intents the console shows. So a stream of invented markets from a stolen agent key is checked at one every 40 s and leaves the hedge view at least 81 requests a minute: a public console cannot be made to spend its Gemini rate limit. Defaults to `https://api.gemini.com`. The end-to-end tests point it at a local server that replays recorded responses. The dev scripts read it too: `dev:executor` checks approved intents against it and `dev:propose` picks its default market from it. |
| `MCP_PUBLIC_URL` | no | Public address of the MCP server, shown on the console's Setup page so the owner can add it to Grok Bot. |
| `NEXT_PUBLIC_DEV_SIGNER` | no | `1` adds a test-only owner signer (anvil account 0, a public key) for end-to-end tests and local demos. It is read at build time. Never set it in a deployed build that runs on Arc testnet; the hosted demo chain sets it and keeps the whole console behind sign-in. |
| `CONSOLE_BROWSER_RPC_URL` | no | Local devchain only: the RPC address the browser uses, when it cannot reach the chain at the deployment file's address. The hosted demo chain sets it to `https://<host>/rpc`, which Caddy forwards to anvil for members of the first workspace only. |

The network is not a build setting: the console decides it at runtime from the Chain variables above, and the browser follows.

## Simulated executor

The executor (`npm run dev:executor`, and the `executor` service of the hosted demo chain) fills approved intents and settles filled positions at expiry; [order-lifecycle.md](order-lifecycle.md) explains both.

| Variable | Required | Meaning |
| --- | --- | --- |
| `CONSOLE_URL` | no | The console the executor records settlements in, through `PUT /api/executor/v1/settlements/:intentId`. Defaults to `http://localhost:3000`; the compose files set `http://console:3000`, inside the stack. The route is not public: Caddy answers 404 for `/api/executor/*`. |
| `EXECUTOR_SETTLE_MS` | no | How often the executor looks for a filled position that is due to be settled, at least `1000`. Defaults to `60000`. The look is local: Gemini and the console are asked only once a position's market has expired, then with waits of 1, 2, 5, 10 and then every 30 minutes while Gemini has not published the outcome. |
| `SIM_EXECUTOR_DELAY_MS` | no | How long the executor waits after an approval before filling it. Defaults to `1500`. |
| `SIM_EXECUTOR_POLL_MS` | no | How often the executor asks the chain for new approvals and fills. Defaults to `1000`. |

## Grok Bot event wake-ups

The console starts Grok Bot's routine through its webhook when an event is worth a run (issue #40); [event-wake.md](event-wake.md) says which events, the body it posts and the limits.
The URL and the key are secrets: some products put a secret in the URL's path, so neither is ever logged, shown or put in an error.

| Variable | Required | Meaning |
| --- | --- | --- |
| `GROK_WEBHOOK_URL` | for wake-ups | The "POST to" URL from the routine's Webhook section in Grok Bot. Empty: wake-ups are off, and the rest of the stack runs as before. |
| `GROK_WEBHOOK_KEY` | for wake-ups | The routine's webhook key, sent as `Authorization: Bearer <key>`. Empty: wake-ups are off. |
| `GROK_WAKE_DAILY_CAP` | no | Most wake-ups the console sends per UTC day, from 0 to 1000. Defaults to `12`, half again the 24 runs of an hourly schedule. |
| `GROK_WAKE_PRICE_CHECK_MS` | no | Least time between two checks of Gemini's spot against the current goal, at least `1000`. Defaults to `300000` (5 minutes). The check rides on the console's chain poll, so it adds no timer. |

## Landing page

The landing page (`site/`) is a static export: `npm run build -w @mandate/site` writes `site/out`, which any static file server can serve.
It has no server, no secrets, no cookies and no analytics.
Its settings are public and read at build time only, so changing one means building again.
`next.config.ts` checks them and the build fails on a malformed value.

| Variable | Required | Meaning |
| --- | --- | --- |
| `NEXT_PUBLIC_APP_URL` | no | The console's public address. "Launch app" links to it, and the scorecard link is built from it. Defaults to `http://localhost:3000`. |
| `NEXT_PUBLIC_SCORECARD_AGENT` | no | The agent address whose public scorecard (`<app>/agent/<address>`) the page links to. Defaults to `0x70997970C51812dc3A010C7d01b50e0d17dc79C8`, the devchain agent (anvil account 1), which the local stack and the hosted demo chain use. |
| `NEXT_PUBLIC_REPO_URL` | no | The repository's address, linked from the footer as "Source on GitHub". Empty (the default) hides the link, so linking the source is a deliberate choice. |
| `NEXT_PUBLIC_SITE_URL` | yes, when hosted | The landing page's own public address, such as `https://mandate.example`. Link previews (Open Graph and Twitter cards) need absolute URLs, so the preview image and the page address are built from it. Defaults to `http://localhost:3001`, the local stack's site, which is wrong anywhere else; `deploy/build-site.sh` therefore refuses to build without it (or a named `MANDATE_SITE_ADDRESS`). |

`npm run dev:stack` starts the page on port 3001 (`--site-port` changes it, `--no-site` skips it) with the console, agent and site addresses set to the stack's own.
The icons (`favicon.ico`, `icon.svg`, `apple-icon.png`) come from `brand/icons`, shared with the console; `npm run icons -w @mandate/brand` redraws them, and `npm run og -w @mandate/site` redraws the link preview image.
`npm run e2e -w @mandate/site` builds `site/out` with example settings for its tests, so build again before deploying from the same folder.

## Hosting

The hosted setup in [hosting.md](hosting.md) reads one file, `deploy/.env`, which [`deploy/mandate.env.template`](../deploy/mandate.env.template) describes line by line.
Besides the variables on this page it uses `COMPOSE_FILE` (demo chain or Arc testnet, and optionally gateway mode and the landing page), `MANDATE_HOST` (the public hostname), `MANDATE_PUBLIC_URL`, `MANDATE_HTTP_PORT`, `MANDATE_HTTPS_PORT`, `MANDATE_APP_PORT`, `MANDATE_SITE_PORT`, `MANDATE_BIND_ADDRESS`, `MANDATE_SITE_ADDRESS` and `MANDATE_SITE_DIR` (the ports and addresses), and for the demo chain `DEVCHAIN_CONTRACT` (which contract it deploys), `ANVIL_STATE_INTERVAL` (seconds between saves of the chain) and `SIM_EXECUTOR_POLL_MS` (how often the simulated executor polls).
The compose files set the addresses between the services, the data folders and the listening interfaces themselves, run the console with `CONSOLE_MODE=production`, and set `CONSOLE_TRUST_PROXY` and `MCP_TRUST_PROXY` to `true`, because Caddy sits in front of both.
Env files from before workspaces may still hold `CONSOLE_USER` and `CONSOLE_PASSWORD_HASH`; nothing reads them any more.

## QuickNode Streams

| Variable | Required | Meaning |
| --- | --- | --- |
| `QUICKNODE_API_KEY` | for Streams | API key used to create and manage the Stream. The console does not use it. |
| `QUICKNODE_STREAM_SECURITY_TOKEN` | for Streams | Token QuickNode signs webhook deliveries with. The console's webhook at `/api/webhooks/quicknode` verifies every delivery with it and refuses all deliveries while it is unset. |

## x402 signal API (Circle Nanopayments on Arc testnet)

Create both keys with `npm run x402:keygen`.

| Variable | Required | Meaning |
| --- | --- | --- |
| `X402_BUYER_PRIVATE_KEY` | yes | Plain wallet key (EOA) that pays for signals. Fund its address at faucet.circle.com on Arc Testnet. |
| `X402_SELLER_PRIVATE_KEY` | one of | Identifies the address that receives payments. |
| `X402_SELLER_ADDRESS` | one of | Receive payments at this address instead of the one derived from the seller key. |
| `X402_FACILITATOR_URL` | no | Defaults to Circle's testnet Gateway API. |
| `SIGNALS_PORT` | no | Port of the signal API. Defaults to `4021`. |
| `SIGNALS_URL` | no | Address the agent calls for signals. Defaults to `http://localhost:4021`. |
| `SIGNALS_HEDGE_PRICE_USD` | no | Price of one hedge signal in dollars, a fraction of a cent from `0.000001` to `0.009999`. Defaults to `0.001`. |
| `SIGNALS_ASSETS` | no | Comma-separated assets the signal API sells hedge signals for. Defaults to every asset the Gemini client knows. |
| `SIGNALS_FAIR_BAND_CENTS` | no | Edge, either way, below which protection counts as fairly priced, from 1 to 50 cents. Defaults to `2`. |
| `SIGNALS_VOL_WINDOW_HOURS` | no | Hours of history behind the realised volatility, ending at the newest closed hourly candle, from 24 to 1000. Defaults to `168` (one week). Hours missing from Gemini's candles are skipped, so the signal states the returns it used and `missingHours`. |
| `SIGNAL_DAILY_BUDGET_USDC` | no | Most the MCP server's `buy_signal` tool spends per UTC day. Defaults to `0.02`. |
| `SIGNAL_MAX_PRICE_USDC` | no | Most `buy_signal` pays for one signal; checked before anything is signed. At most the daily budget. Defaults to `0.005`. |
| `AGENT_DATA_DIR` | no | Where the MCP server keeps its signal spend ledger and purchased signals. Defaults to `.data/agent`, which is git-ignored. |

The MCP server reads `X402_BUYER_PRIVATE_KEY` too: with it, `buy_signal` pays from that wallet's Circle Gateway balance; without it, `buy_signal` answers `unavailable`.
With `CONSOLE_SERVICE_TOKEN` set as well, the MCP server reports each payment and the signal budget to the console (see [agent/README.md](../agent/README.md#payment-reports-to-the-console)).
The server never deposits; top the Gateway balance up as described in [x402.md](x402.md).
