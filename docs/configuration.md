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
| `MCP_AUTH_TOKEN` | yes | Token Grok Bot presents to the MCP server, at least 32 characters. Create or rotate it with `npm run mcp:token`. |
| `MCP_PORT` | no | Port of the MCP server. Defaults to `8787`. |
| `MCP_HOST` | no | Interface the MCP server listens on. Defaults to `127.0.0.1`. |
| `MCP_ALLOWED_ORIGINS` | no | Comma-separated hostnames allowed in a browser `Origin` header, in addition to localhost. |
| `MCP_LOG_LEVEL` | no | `debug`, `info`, `warn` or `error`. Defaults to `info`. |
| `MCP_ADVERTISE_OUTPUT_SCHEMAS` | no | `true` to include each tool's output schema in `tools/list`. Defaults to `false`, which makes the list about four times smaller; results are validated on the server either way. |

The MCP server starts with only `MCP_AUTH_TOKEN`.
A variable marked "for ... tools" becomes required once a registered tool declares it; until then `get_setup_state` reports it as a remaining step.
See [agent/README.md](../agent/README.md).

## Console

| Variable | Required | Meaning |
| --- | --- | --- |
| `CONSOLE_URL` | no | Public address of the console. The MCP server calls it, and the console builds the pairing link from it. Defaults to `http://localhost:3000`. |
| `CONSOLE_SERVICE_TOKEN` | for console tools | Shared secret between the console backend and the MCP server, sent as a bearer token and compared in constant time. Without it every `/api/agent/v1` route answers 503. |
| `CONSOLE_DATA_DIR` | no | Folder for the console's SQLite store (events, contexts, holdings, hedge plans, pairing, change requests, signal payments and budget, and Gemini's listing of each intent's market). Defaults to `dashboard/.data`, which is git-ignored. Deleting it is safe: the console rebuilds the onchain part from the chain. |
| `CONSOLE_EVENT_SOURCE` | no | `rpc` (default) polls the chain for Policy events. `stream` takes the QuickNode Stream webhook as the primary source and keeps a slow RPC poll to fill gaps. |
| `CONSOLE_POLL_INTERVAL_MS` | no | How often the RPC poller asks for new blocks. Defaults to 250 ms on the local devchain and 1 s on Arc testnet. |
| `GEMINI_API_URL` | no | Gemini's public REST API, which the console reads (server side, cached for 10 s, no key) for the hedge view's live ladder and preview, and to check each intent's market against Gemini's listing (once per market, in the background; the answer is stored, so each market costs one lookup ever). For ladders it only asks about assets Gemini lists and the events of plans the console stores, and keeps at most 32 ladders. Listing checks have a budget of their own inside the client's 100 requests a minute: at most 24 requests in any 60 s and 12 a minute sustained, counted as the most each lookup could send (4 candidate event tickers, each tried twice) until it says what it sent. Intents waiting for approval are checked first, then the newest, and the queue never holds more than the intents the console shows. So a stream of invented markets from a stolen agent key is checked at one every 40 s and leaves the hedge view at least 81 requests a minute: a public console cannot be made to spend its Gemini rate limit. Defaults to `https://api.gemini.com`. The end-to-end tests point it at a local server that replays recorded responses. The dev scripts read it too: `dev:executor` checks approved intents against it and `dev:propose` picks its default market from it. |
| `MCP_PUBLIC_URL` | no | Public address of the MCP server, shown on the console's Setup page so the owner can add it to Grok Bot. |
| `NEXT_PUBLIC_DEV_SIGNER` | no | `1` adds a test-only owner signer (anvil account 0, a public key) for end-to-end tests and local demos. It is read at build time. Never set it in a deployed build that runs on Arc testnet; the hosted demo chain sets it and keeps the whole console behind the owner's login. |
| `CONSOLE_BROWSER_RPC_URL` | no | Local devchain only: the RPC address the browser uses, when it cannot reach the chain at the deployment file's address. The hosted demo chain sets it to `https://<host>/rpc`, which Caddy forwards to anvil behind the owner's login. |

The network is not a build setting: the console decides it at runtime from the Chain variables above, and the browser follows.

## Hosting

The hosted setup in [hosting.md](hosting.md) reads one file, `deploy/.env`, which [`deploy/mandate.env.template`](../deploy/mandate.env.template) describes line by line.
Besides the variables on this page it uses `COMPOSE_FILE` (demo chain or Arc testnet), `MANDATE_HOST` (the public hostname), `MANDATE_PUBLIC_URL`, `MANDATE_HTTP_PORT`, `MANDATE_HTTPS_PORT`, `CONSOLE_USER` and `CONSOLE_PASSWORD_HASH` (the owner's login at the proxy) and `DEVCHAIN_CONTRACT` (which contract the demo chain deploys).
The compose files set the addresses between the services, the data folders and the listening interfaces themselves.

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
| `SIGNALS_VOL_WINDOW_HOURS` | no | Hourly candles behind the realised volatility, from 24 to 1000. Defaults to `168` (one week). |
| `SIGNAL_DAILY_BUDGET_USDC` | no | Most the MCP server's `buy_signal` tool spends per UTC day. Defaults to `0.02`. |
| `SIGNAL_MAX_PRICE_USDC` | no | Most `buy_signal` pays for one signal; checked before anything is signed. At most the daily budget. Defaults to `0.005`. |
| `AGENT_DATA_DIR` | no | Where the MCP server keeps its signal spend ledger and purchased signals. Defaults to `.data/agent`, which is git-ignored. |

The MCP server reads `X402_BUYER_PRIVATE_KEY` too: with it, `buy_signal` pays from that wallet's Circle Gateway balance; without it, `buy_signal` answers `unavailable`.
With `CONSOLE_SERVICE_TOKEN` set as well, the MCP server reports each payment and the signal budget to the console (see [agent/README.md](../agent/README.md#payment-reports-to-the-console)).
The server never deposits; top the Gateway balance up as described in [x402.md](x402.md).
