# Policy contract interface (offchain view)

This document is for whoever owns `contracts/src/Policy.sol`.
It says what the offchain code (agent, console, executor) uses from that contract today, which small additions would help, and what looked surprising.
Line numbers refer to `contracts/src/Policy.sol` as merged on main.

The production contract is the source of truth.
`@mandate/shared` mirrors it exactly, and the devchain tests enforce that:

- `policyBaseAbi` in `shared/src/abi.ts` must equal the ABI forge produces from `contracts/src/Policy.sol` (constructor and `internalType` aside).
- The rule tests and a 600-case fuzz test run against `contracts/src/Policy.sol` compiled as is, comparing the TypeScript evaluator with the verdict each real `proposeTrade` transaction emits.
- The same tests run against `devchain/contracts/PolicyReference.sol`, which is `Policy.sol` plus the three additions below, so the additions are proven to change nothing else.

Nothing under `/contracts` is modified by this work.

## 1. What the offchain code uses as is

| Contract feature | Offchain use |
| --- | --- |
| `PolicyRules` struct, `setPolicy`, `policy()` (L21-28, L90-96, L47) | `PolicyRules` type in `@mandate/shared`, same field order and names. |
| `setPaused`, `setAgent`, `setExecutor`, `user()`, `agent()`, `executor()` (L43-45, L98-109) | `PolicyClient` user methods and `getRoles()`. |
| `proposeTrade` (6 arguments, L136-177) | `PolicyClient.proposeTrade`. The intent id and verdict are read from the verdict event in the receipt. |
| `approveIntent`, `rejectIntent` (L112-130) | Console approval flow. |
| `recordResult` (L183-205) | Executor. |
| `Status` enum (L10-17) | `INTENT_STATUSES`: `none`, `approved`, `needs_approval`, `rejected`, `executed`, `failed`. |
| Reason strings in `_violation` (L228-236), plus `"rejected by user"` (L129) | `REASON_CODES`, each with a label and a one-sentence explanation for the console and agent. |
| Rule order in `_violation`, then the approval threshold (L170) | `evaluateIntent` in TypeScript, checked against the contract by the fuzz test. |
| `committedCents`, `lossTodayCents()`, `intentCount()`, `getIntent()` (L48, L209-224) | `getSnapshot()`, `getHeadroom()`, `getIntent()`. |
| Events `PolicyUpdated`, `Paused`, `IntentApproved`, `IntentRejected`, `IntentNeedsApproval`, `ResultRecorded` (L56-68) | The event reducer, which rebuilds rules, committed spend, losses per UTC day, rejection counts and intent statuses from logs alone. |
| Errors `NotUser`, `NotAgent`, `NotExecutor`, `WrongStatus`, `FillExceedsIntent` (L70-74) | Decoded by name in `PolicyRevertError`. |

Without any additions, everything works.
Previews run the TypeScript evaluator on a fresh snapshot, and intent details missing from the log are read with `getIntent`.

## 2. Requested additions, in priority order

Each one is small, independent and purely additive: existing selectors, events and storage stay as they are.
`PolicyClient` detects each one with a read-only probe and uses it only when present.
The exact Solidity is in `devchain/contracts/PolicyReference.sol`, marked `EXTENSION`.

### 2.1 `IntentProposed` event

```solidity
event IntentProposed(
    uint256 indexed intentId, address indexed agent, string market, uint8 category,
    string outcome, bool isBuy, uint256 amountCents, uint256 limitPrice, bytes32 contextHash
);
```

Emitted in `proposeTrade` right after the push, before the verdict event.

Why: today an intent rejected at proposal leaves only `IntentRejected(id, reason)` in the log, and no event carries `category` at all.
The dashboard's audit trail ("what did the agent try, and why was it blocked") then needs one `getIntent` call per intent, and an indexer cannot be built from logs alone.
With this event, the log is a complete audit record.

### 2.2 `proposeTrade` overload with a `contextHash`

```solidity
function proposeTrade(
    string calldata market, uint8 category, string calldata outcome,
    bool isBuy, uint256 amountCents, uint256 limitPrice, bytes32 contextHash
) external returns (uint256 intentId);
```

The 6-argument version keeps working and records a zero hash.
The hash only needs to appear in `IntentProposed`; it does not need storage.

Why: the agent hashes its decision context (the user's request, the plan, the signals it paid for) with `hashContext` in `@mandate/shared`.
Putting that hash onchain lets anyone later prove which reasoning produced a given trade.
Without it, `PolicyClient` reports `contextHashRecorded: false`.

### 2.3 `previewTrade` view

```solidity
function previewTrade(uint8 category, bool isBuy, uint256 amountCents)
    external view returns (uint8 verdict, string memory reason); // 0 approve, 1 needs approval, 2 reject
```

Same checks as `proposeTrade` (`_violation`, then the threshold), with no state change.

Why: the agent wants to know a trade's fate before spending gas, and the console shows "what would happen" as the user edits rules.
The TypeScript evaluator does this today and is fuzz-tested against the contract, so this is the least urgent request.
An onchain answer removes any chance of drift if the rules change later.

## 3. Behavior worth a second look

These are observations, not bug reports.
Each is pinned by a test that runs against `Policy.sol`, so a deliberate change will show up in CI.

1. Rejected intents keep no reason in storage (L163-167, `Intent` at L30-41).
   The reason exists only in the `IntentRejected` event.
2. `approveIntent` re-checks only the budget (L116-121).
   A held intent can be approved while the agent is paused, after the daily loss limit is hit, or after its category or the max trade size was tightened.
3. The daily loss check runs before the max trade size and category checks (L231-233).
   Once the limit is hit, every proposal reports `"daily loss limit reached"`, even one that would also break another rule.
4. Daily loss counts only negative results (L192-199).
   Profits do not offset losses within a day, and sells count toward the loss like buys.
5. `budgetCents` is a lifetime cap on committed buys, not a per-day budget (L190, L234).
   Budget is released only for the unfilled part of a buy; executed buys stay committed forever.
6. `recordResult` with `filled = false` and a non-zero `filledCents` succeeds and stores a zero fill (L189), but it still reverts with `FillExceedsIntent` if `filledCents` exceeds the amount (L187).
7. `setPolicy` always emits `Paused` after `PolicyUpdated`, even when the pause flag did not change (L95).
8. `setAgent` and `setExecutor` emit no event and accept the zero address (L103-109).
   Role changes are invisible in the log, so the dashboard must read `agent()` and `executor()`.
9. `getIntent` with an id that does not exist reverts with a panic (L214); ids start at 0 (L146).
   `PolicyClient.getIntent` checks `intentCount()` first and returns null.
10. There is no validation of `market`, `outcome` or `limitPrice` (L136-160).
    The offchain schema enforces a non-blank market, `YES` or `NO`, and a price from 1 to 99 cents before sending.
11. `committedCents + amountCents` (L117, L234) reverts with an overflow panic instead of returning `"over budget"` when the sum exceeds `2^256 - 1`.
    Only reachable if `maxTradeCents` is set near `2^256`; offchain code refuses anything above `2^53 - 1` anyway.
12. A zero amount is a recorded rejection (`"zero amount"`, L230), not a revert, so it uses an intent id.

## 4. Open questions for the contract owner

1. Category numbers: offchain code uses bit 0 Crypto, 1 Sports, 2 Economics, 3 Commodities, 4 Weather, 5 Politics, 6 Other (`shared/src/categories.ts`).
   `contracts/README.md` asks for these to be agreed; please confirm or send the list you want.
2. `limitPrice` units: offchain code sends cents per one-dollar contract (1 to 99), matching Gemini prediction markets.
   The struct comment says "venue's price units" (L36); please confirm.
3. Should items 2 and 8 in section 3 change?
   Offchain code works either way, and the tests will flag the change.
4. The contracts README says to copy the ABI and an `addresses.json` into `/shared`.
   `@mandate/shared` instead keeps a typed ABI that CI proves equal to the forge output, and reads the address from `POLICY_ADDRESS` (plus optional `POLICY_DEPLOY_BLOCK`).
   Please post the Arc testnet address and deploy block once deployed.

## 5. Red-team findings for the contract owner

`npm run redteam` attacks the mandate with the agent's own key, through the MCP server and straight at the contract.
The full record, with transaction hashes, is in [redteam/REPORT.md](../redteam/REPORT.md).
No attack changed a rule, a role, the pause switch or the budget, and every owner-only and executor-only call from the agent key reverted.
The four points below are things the contract allows today that the owner of a mandate would probably not expect.
Only the contract can enforce them against a stolen agent key; points 3 and 4 are now contained offchain, after the contract.
They are listed with the smallest change that would close each one, most valuable first.

1. **Splitting gets around the per-order rules** (`mcp.split-order`).
   A $30 order is rejected, but two $15 orders are approved without the owner, because the max trade size and the approval threshold apply to each order alone.
   Only the lifetime budget bounds the total.
   A rolling cap would close it: for example, hold for approval once the buys approved without the owner in the last 24 hours exceed the approval threshold.
2. **Sells have no cumulative cap** (`mcp.sell-outside-budget`, `chain.sells-past-budget`).
   Sells do not count against the budget, so any number of them are approved, even with the budget used up, each up to the max trade size.
   Only losses recorded later by the executor stop them, through the daily loss limit.
   Smallest change: reject a sell unless the agent holds a filled buy on the same market and outcome of at least that size, or count sells against a separate cap.
3. **The contract trusts the category argument** (`chain.mislabel-category`).
   A Sports market sent with category 0 (Crypto) is approved.
   Through the MCP server the category comes from Gemini, so this needs a stolen key, but then nothing onchain stops it.
   Offchain, the executor now looks the market up on Gemini and refuses any approved intent whose category does not match the listing, recording it as not filled (`chain.executor-refuses`).
   The console checks each intent's market against Gemini's listing the same way, stores the first answer, and flags a category mismatch or a market Gemini does not list, with a warning beside Approve while the intent waits.
   It still counts against the budget until then, and a full fix needs a market registry or an attestation.
4. **Market, outcome and limit price are not validated** (`chain.limit-price-edges`, `chain.market-strings`; item 10 in section 3).
   Empty and 16 KiB markets, an outcome of `MAYBE`, and limit prices of 0, 100 and 1,000,000 are all approved and stored.
   Smallest change: require `1 <= limitPrice <= 99`, an outcome of `YES` or `NO`, and a market length between 1 and 128 bytes, and reject the rest with a reason string.
   Offchain, the executor refuses such an intent before trading and records it as not filled (`chain.executor-refuses`).
   A stolen key can still write arbitrary text into the audit log: the MCP server withholds it from the model, and the console flags the intent and shows only a short preview, with the full text folded away on the intent page.

One more observation, not a contract bug: refused owner-only calls revert, so they leave a mined transaction but no event.
The console's activity feed, which is built from events, therefore cannot show them.
An `Unauthorized(address caller, bytes4 selector)` event is not possible on a revert, so this stays a report-only record unless the functions are changed to record and return instead of reverting.

## Conventions

| Thing | Convention |
| --- | --- |
| Money | Integer cents in `uint256` (`int256` for profit and loss). `2500` is $25.00. |
| Offchain numbers | JavaScript numbers. An amount, limit price or result above `2^53 - 1` (only the agent or executor key can write one) decodes to `null` with its exact digits in `outOfRange`, and the intent is flagged, never clamped. Rules above `2^53 - 1` are refused with a clear error, so please avoid `type(uint256).max` as an "unlimited" sentinel. |
| `market` | Gemini's `instrumentSymbol`, for example `GEMI-BTC2611202200-HI65000`. |
| Day | UTC day number, `block.timestamp / 1 days`, as in `lossTodayCents()`. |
| Gas | Arc testnet pays gas in USDC; `PolicyClient` never sends `maxFeePerGas` below 20 gwei. |
