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

## Run it

```bash
npm run dev:chain                         # terminal 1: anvil on 127.0.0.1:8545, Policy.sol deployed
npm run dev:chain -- --contract reference # or the reference contract with the additions
npm run dev:executor                      # terminal 2: SIMULATED executor, fills every approved intent
npm run dev:propose -- --amount 10        # terminal 3: propose as the agent
npm run dev:propose -- --amount 22        # waits for the user's approval
npm run dev:propose -- --amount 30        # over max trade size
npm run dev:propose -- --category Sports  # category not allowed
npm run dev:propose -- --amount 22 --preview
```

`dev:chain` writes `devchain/deployments/local.json` (git-ignored), which `resolvePolicyDeployment()` in `@mandate/shared/node` reads when `POLICY_ADDRESS` is unset.
It deletes the file when it stops, since the chain's state goes with it.
`DEVCHAIN_PORT` changes the port.

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
