# @mandate/devchain

A local chain for development and tests only.
It runs anvil with Arc testnet's chain id, deploys a Policy contract and seeds demo rules.
Production code must not import this package.

Foundry comes from npm (`@foundry-rs/anvil`, `@foundry-rs/forge`), so `npm install` at the repo root is all the setup there is.

## Two contracts

| `--contract` | Source | Use |
| --- | --- | --- |
| `production` (default) | `contracts/src/Policy.sol`, compiled as is | What will run on Arc. |
| `reference` | `devchain/contracts/PolicyReference.sol` | `Policy.sol` plus the additions requested in `docs/contract-interface.md`. |

The production build writes only to `devchain/out/production` and `devchain/cache/production`; nothing under `/contracts` changes.

## Run the whole product: `npm run dev:stack`

One command starts the devchain, the paid signal API, the console, the MCP server and the simulated executor, already wired to each other.
Nothing has to be edited in `.env` beyond what the MCP server and the signal API already need (`MCP_AUTH_TOKEN` and the x402 keys).

```bash
npm run dev:stack                                    # reference contract, demo rules, `next dev` console
npm run dev:stack -- --blank                         # no rules yet: rehearse creating the first mandate
npm run dev:stack -- --prod                          # build the console and serve the build
npm run dev:stack -- --watch                         # restart the MCP server when its code changes
npm run dev:stack -- --mcp-public-url https://<tunnel>/mcp
npm run dev:tunnel                                   # another terminal: a public address for Grok Bot
```

What it passes to the processes, in their environment only:

- the MCP server gets the devchain agent key (anvil account 1, public), the loopback RPC and the deployed address, so no trade can reach a shared network;
- the console and the MCP server share a service token generated for the run, which is never printed;
- the console gets the test signer (`NEXT_PUBLIC_DEV_SIGNER=1`), so the owner signs as anvil account 0.

The chain and the console's store (`dashboard/.data/stack`) are new on every run, so holdings are entered again under Hedge.
It refuses to start if port 8545, 3000, `MCP_PORT` or `SIGNALS_PORT` is taken.
Ctrl+C stops everything.
Keep the tunnel in its own terminal: its address survives a restart of the stack, so the Grok Bot connector stays valid.

## Run the pieces

```bash
npm run dev:chain                         # terminal 1: anvil on 127.0.0.1:8545, Policy.sol deployed
npm run dev:chain -- --contract reference # or the reference contract with the additions
npm run dev:executor                      # terminal 2: SIMULATED executor, fills approved intents it can check
npm run dev:propose -- --amount 10        # terminal 3: propose as the agent
npm run dev:propose -- --amount 22        # waits for the user's approval
npm run dev:propose -- --amount 30        # over max trade size
npm run dev:propose -- --category Sports  # category not allowed
npm run dev:propose -- --amount 22 --preview
```

Without `--market`, `dev:propose` asks Gemini's public API for the soonest open weekly BTC ladder and proposes the open strike nearest spot, and prints which one it picked.
A fixed symbol would stop working once its ladder settles, and the simulated executor refuses a market Gemini no longer lists.
When Gemini cannot be reached it says so and exits without proposing anything.
Pass `--market` with an `instrumentSymbol` from the MCP server's `list_markets` or `get_ladder` to choose the market yourself; that needs no call to Gemini.

The simulated executor never places an order, but it checks every approved intent the way a real executor must before it records a fill.
It refuses an intent and records it as not filled when the market is not a Gemini symbol, the outcome is not YES or NO, the limit price is outside 1 to 99, Gemini does not list the market, or Gemini lists it under another category than the intent's.
The contract approves all of these when they come from the agent key, so this is the only offchain check between a stolen key and an order.
It reads Gemini's public market data for the listing; when Gemini cannot be reached it fills nothing and tries again every 15 seconds, leaving the intent approved.
The logic is in `src/executor.ts`, with the venue injectable so tests run without the network.
It asks the chain for new approvals every second; `SIM_EXECUTOR_POLL_MS` changes that (at least 50), and `SIM_EXECUTOR_DELAY_MS` sets how long it waits after an approval before it records the fill (default 1500).
The hosted demo keeps the one-second poll and can set it higher so an idle machine stays quiet.

`dev:chain` writes `devchain/deployments/local.json` (git-ignored), which `resolvePolicyDeployment()` in `@mandate/shared/node` reads when `POLICY_ADDRESS` is unset.
It deletes the file when it stops, since the chain's state goes with it.
`DEVCHAIN_PORT` changes the port.

`npm run ensure-deployment -w @mandate/devchain` is the deploy-once step of the hosted demo chain (see [docs/hosting.md](../docs/hosting.md)).
It reads `DEVCHAIN_RPC_URL`, `POLICY_DEPLOYMENT_FILE` and `DEVCHAIN_CONTRACT` (`reference` by default), refuses a chain whose id is not 5042002, and reuses the deployment file when the chain still has that contract.
Otherwise it deploys, sets the demo rules and rewrites the file, which is what happens on the first start or after the chain lost its state.

Accounts are anvil's public test accounts: 0 is the user (deployer), 1 the agent, 2 the executor.
Their keys are public, so never use them on Arc testnet.

Tests and scripts that need a whole chain in one call use `startDevchain({ contract, port })`, which starts anvil, deploys and sets the demo rules, and returns the RPC URL, the deployment and a `stop` function.
Pass `port: 0` for a free port.
`devPrivateKey(role)` returns the public test key of the user, agent or executor account.
`npm run mcp:e2e` uses both to run the MCP server end to end (see `agent/README.md`).

## Tests

`npx vitest run devchain` compiles both contracts, then on a fresh anvil:

- checks the production ABI equals `policyBaseAbi` and the reference ABI equals `policyAbi`;
- runs every rule, role and result test against both contracts;
- fuzzes 600 random cases per contract, comparing `evaluateIntent` with the verdict each real `proposeTrade` emits (and with `previewTrade` on the reference), then rebuilds the contract's state from its events.
