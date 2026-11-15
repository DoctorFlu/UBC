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

## Agent (MCP server)

| Variable | Required | Meaning |
| --- | --- | --- |
| `AGENT_PRIVATE_KEY` | for trading tools | Key of the agent's Arc account. It can only propose trades. |
| `MCP_AUTH_TOKEN` | yes | Token Grok Bot presents to the MCP server, at least 32 characters. Create or rotate it with `npm run mcp:token`. |
| `MCP_PORT` | no | Port of the MCP server. Defaults to `8787`. |
| `MCP_HOST` | no | Interface the MCP server listens on. Defaults to `127.0.0.1`. |
| `MCP_ALLOWED_ORIGINS` | no | Comma-separated hostnames allowed in a browser `Origin` header, in addition to localhost. |
| `MCP_LOG_LEVEL` | no | `debug`, `info`, `warn` or `error`. Defaults to `info`. |

The MCP server starts with only `MCP_AUTH_TOKEN`.
A variable marked "for ... tools" becomes required once a registered tool declares it; until then `get_setup_state` reports it as a remaining step.
See [agent/README.md](../agent/README.md).

## Console

| Variable | Required | Meaning |
| --- | --- | --- |
| `CONSOLE_URL` | no | Address of the console backend. Defaults to `http://localhost:3000`. |
| `CONSOLE_SERVICE_TOKEN` | for console tools | Shared secret between the console backend and the MCP server. |

## QuickNode Streams

| Variable | Required | Meaning |
| --- | --- | --- |
| `QUICKNODE_API_KEY` | for Streams | API key used to create and manage the Stream. |
| `QUICKNODE_STREAM_SECURITY_TOKEN` | for Streams | Token QuickNode signs webhook deliveries with. |

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
The server never deposits; top the Gateway balance up as described in [x402.md](x402.md).
