# Policy contract

On-chain rulebook and audit log. The agent proposes trades, the contract approves
or rejects them against the user's rules, and the executor records the result.

## Setup

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup   # once
cd contracts
forge install foundry-rs/forge-std
forge build
forge test -vv
```

## Run locally

```bash
anvil                                   # terminal 1: local chain, prints test keys
# terminal 2: account 0 = user, 1 = agent, 2 = executor
AGENT=<account 1 address> EXECUTOR=<account 2 address> \
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 \
  --private-key <account 0 key> --broadcast
```

## Deploy to Arc testnet

Same command with Arc's RPC URL and a funded key. Put the deployed address in
`/shared/addresses.json` and the ABI (`out/Policy.sol/Policy.json`) in `/shared`.

## Roles

| Role | Can call |
|---|---|
| user (deployer) | `setPolicy`, `setPaused`, `approveIntent`, `rejectIntent`, `setAgent`, `setExecutor` |
| agent | `proposeTrade` |
| executor | `recordResult` |

## Rules

`setPolicy` takes one `PolicyRules` struct. Every field is checked on-chain in `proposeTrade`.

| # | Field | Rule | Rejection reason |
|---|---|---|---|
| 1 | `budgetCents` | Approved and executed buys may not exceed this total | `over budget` |
| 2 | `maxTradeCents` | No single order above this | `over max trade size` |
| 3 | `allowedCategories` | Bitmask, bit N set = category N allowed | `category not allowed` |
| 4 | `approvalAboveCents` | Orders above this wait for the user (0 = never ask) | emits `IntentNeedsApproval` |
| 5 | `dailyLossCents` | Stop once today's losses reach this (0 = off). Losses come from `recordResult` and reset at 00:00 UTC | `daily loss limit reached` |
| 6 | `paused` | Kill switch, also settable alone with `setPaused` | `agent paused` |

Read the current rules with `policy()`, the remaining budget with `remainingBudgetCents()`
and today's losses with `lossTodayCents()`.

## Units

Amounts are in US cents. Categories are small integers; `allowedCategories` is a
bitmask (bit N set means category N is allowed). Agree the category numbers with
whoever writes the Gemini client.

## Events the executor and dashboard listen for

`IntentApproved`, `IntentRejected`, `IntentNeedsApproval`, `ResultRecorded`.
