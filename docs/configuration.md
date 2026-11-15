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

## Agent (MCP server)

| Variable | Required | Meaning |
| --- | --- | --- |
| `AGENT_PRIVATE_KEY` | yes | Key of the agent's Arc account. It can only propose trades. |
| `MCP_AUTH_TOKEN` | yes | Token Grok Bot presents to the MCP server. |
| `MCP_PORT` | no | Port of the MCP server. Defaults to `8787`. |

## Console

| Variable | Required | Meaning |
| --- | --- | --- |
| `CONSOLE_URL` | no | Address of the console backend. Defaults to `http://localhost:3000`. |
| `CONSOLE_SERVICE_TOKEN` | yes | Shared secret between the console backend and the MCP server. |

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
