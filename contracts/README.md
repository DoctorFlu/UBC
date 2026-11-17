# Policy contract

On-chain rulebook and audit log. The agent proposes trades, the contract approves
or rejects them against the user's rules, and the executor records the result.
This is the production contract. `devchain/contracts/PolicyReference.sol` is a local copy for tests.

## Setup

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup   # once
cd contracts
forge build
forge test -vv
```

`forge-std` is a git submodule. If `lib/forge-std` is empty, run `git submodule update --init`.

## Run locally

```bash
anvil                                   # terminal 1: local chain, prints test keys
# terminal 2: account 0 = deployer, 1 = agent, 2 = executor
AGENT=<account 1 address> EXECUTOR=<account 2 address> \
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 \
  --private-key <account 0 key> --broadcast
```

## Deploy to Arc testnet

The deployer pays gas (USDC on Arc) and starts as the user. Set `OWNER` to hand the
user role to the real owner in the same run.

```bash
AGENT=0x... EXECUTOR=0x... OWNER=0x... \
forge script script/Deploy.s.sol --rpc-url https://rpc.testnet.arc.io \
  --private-key $DEPLOYER_PRIVATE_KEY --broadcast
```

The script prints the address and the deploy block. Put them in `POLICY_ADDRESS` and
`POLICY_DEPLOY_BLOCK`. `@mandate/shared` keeps a typed copy of the ABI that CI checks
against `out/Policy.sol/Policy.json`.

## Roles

| Role | Can call |
|---|---|
| user | `setPolicy`, `setPaused`, `approveIntent`, `rejectIntent`, `setUser`, `setAgent`, `setExecutor` |
| agent | `proposeTrade` (6 or 7 arguments) |
| executor | `recordResult` |

The deployer is the first user. Role setters reject the zero address and emit
`UserChanged`, `AgentChanged` or `ExecutorChanged`.

## Rules

`setPolicy` takes one `PolicyRules` struct. Every field is checked in `proposeTrade`
and again in `approveIntent`, in this order.

| # | Field | Rule | Rejection reason |
|---|---|---|---|
| 6 | `paused` | Kill switch, also settable alone with `setPaused` | `agent paused` |
| - | - | A zero amount is recorded and rejected | `zero amount` |
| 5 | `dailyLossCents` | Stop once today's losses reach this (0 = off). Losses come from `recordResult` and reset at 00:00 UTC | `daily loss limit reached` |
| 2 | `maxTradeCents` | No single order above this | `over max trade size` |
| 3 | `allowedCategories` | Bitmask, bit N set = category N allowed | `category not allowed` |
| 1 | `budgetCents` | Approved and executed buys may not exceed this total | `over budget` |
| 4 | `approvalAboveCents` | Orders above this wait for the user (0 = never ask) | emits `IntentNeedsApproval` |

Before the rules, `proposeTrade` checks the format of the intent. A bad one is still
recorded, with one of these reasons: `invalid market` (empty or over 128 bytes),
`invalid outcome` (not `YES` or `NO`), `invalid limit price` (not 1 to 99).
`rejectIntent` emits `rejected by user`.

## Units and categories

| Thing | Convention |
|---|---|
| Money | Integer US cents. `2500` is $25.00. |
| `limitPrice` | Cents per one-dollar contract, 1 to 99. |
| `market` | Gemini's instrument symbol, for example `GEMI-BTC2611202200-HI65000`. |
| `outcome` | `YES` or `NO`. |
| Day | UTC day number, `block.timestamp / 1 days`. |

Category numbers (bit positions in `allowedCategories`), agreed with `shared/src/categories.ts`:

| Bit | Category |
|---|---|
| 0 | Crypto |
| 1 | Sports |
| 2 | Economics |
| 3 | Commodities |
| 4 | Weather |
| 5 | Politics |
| 6 | Other |

The contract trusts the category the agent sends. The MCP server takes it from Gemini,
and the executor checks it against Gemini's listing before it trades.

## Reads

`policy()`, `user()`, `agent()`, `executor()`, `committedCents()`, `remainingBudgetCents()`,
`lossTodayCents()`, `intentCount()`, `getIntent(id)`, and
`previewTrade(category, isBuy, amountCents)`, which returns the verdict (0 approve,
1 needs approval, 2 reject) and the reason without recording anything.

## Events

`IntentProposed` is emitted for every proposal, with the agent address, every field of
the intent and the agent's `contextHash` (zero for the 6-argument `proposeTrade`).
Then exactly one of `IntentApproved`, `IntentRejected` or `IntentNeedsApproval`.
`recordResult` emits `ResultRecorded`. Rule and role changes emit `PolicyUpdated`,
`Paused`, `UserChanged`, `AgentChanged` and `ExecutorChanged`.
