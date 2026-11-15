# Policy contract interface

This document is what the offchain code (agent, console, executor) expects from the Policy contract on Arc.
It is written for the contract owner and can be handed over as is.

- Part 1 restates the tech spec, which the offchain code already relies on.
- Part 2 lists the extensions we request, each with the reason it is needed.
- Part 3 lists open questions that need a decision from the contract owner.

The machine-readable version is the ABI in `shared/src/abi.ts` (`policyAbi` in `@mandate/shared`).
A reference implementation of everything below lives in `devchain/contracts/PolicyReference.sol`.
It exists only so offchain work can run on a laptop; the production contract lives in `/contracts`.
The devchain test suite checks that the reference contract compiles to exactly `policyAbi`, so the production contract can be checked the same way.

## Conventions

| Thing | Convention |
| --- | --- |
| Money | Integer cents in `uint256` (`int256` for profit and loss). `2500` is $25.00. |
| `limitPrice` | Cents per one-dollar contract, an integer from 1 to 99. `65` is $0.65. |
| `market` | Gemini's `instrumentSymbol`, for example `GEMI-BTC2611202200-HI65000`. |
| `outcome` | `"YES"` or `"NO"`. |
| Quantity | Offchain only: contracts = `amountCents / limitPrice`, floored to 2 decimals. From a quantity, amount = `ceil(quantity * limitPrice)`. |
| `category` | Bit position in `allowedCategories`: 0 Crypto, 1 Sports, 2 Economics, 3 Commodities, 4 Weather, 5 Politics, 6 Other. |
| Day | UTC day number, `block.timestamp / 1 days`. |

Offchain code holds amounts as JavaScript numbers.
It refuses (with a clear error) any value above 2^53 - 1, so please do not use `type(uint256).max` as an "unlimited" sentinel.

## Part 1: tech spec (unchanged)

```solidity
struct Policy {
    uint256 budgetCents;        // rule 1: total the agent may deploy
    uint256 maxTradeCents;      // rule 2
    uint256 allowedCategories;  // rule 3, bitmask
    uint256 approvalAboveCents; // rule 4, 0 = never ask
    uint256 dailyLossCents;     // rule 5, 0 = off
    bool paused;                // rule 6
}

// owner
function setPolicy(Policy calldata p) external;
function approveIntent(uint256 intentId) external;
function rejectIntent(uint256 intentId) external;
function setPaused(bool paused) external;

// agent
function proposeTrade(string calldata market, uint8 category, string calldata outcome, bool isBuy,
    uint256 amountCents, uint256 limitPrice) external returns (uint256 intentId);

// executor
function recordResult(uint256 intentId, bool filled, uint256 filledCents, int256 pnlCents) external;

event IntentApproved(uint256 indexed intentId, string market, string outcome, bool isBuy, uint256 amountCents, uint256 limitPrice);
event IntentRejected(uint256 indexed intentId, string reason);
event IntentNeedsApproval(uint256 indexed intentId, uint256 amountCents);
event ResultRecorded(uint256 indexed intentId, bool filled, uint256 filledCents, int256 pnlCents);
```

Behavior the offchain code relies on:

- Three roles: owner (the user), agent, executor.
- `proposeTrade` runs every rule and emits exactly one of `IntentApproved`, `IntentRejected` or `IntentNeedsApproval`.
- `proposeTrade` does not revert on a rule violation, so blocked attempts stay in the log.
- `approveIntent` on an intent waiting for approval emits `IntentApproved`.

## Part 2: requested extensions

Each item says what we need and why.
All of them are implemented in the reference contract, so you can read working code for any of them.

### 1. `bytes32 contextHash` as a seventh parameter of `proposeTrade`

```solidity
function proposeTrade(string calldata market, uint8 category, string calldata outcome, bool isBuy,
    uint256 amountCents, uint256 limitPrice, bytes32 contextHash) external returns (uint256 intentId);
```

The hash is keccak256 of the agent's decision context (the request, the plan, the ladder it saw, the signals it bought, its stated reason), serialized as canonical JSON.
Zero is allowed and means "no context".
Why: this is how we prove the agent's stated reason was not rewritten after the fact ("sealed reasons" in issue #30).
The contract only stores and emits it; it never interprets it.

### 2. `IntentProposed` for every proposal, before its verdict event

```solidity
event IntentProposed(uint256 indexed intentId, address indexed agent, string market, uint8 category,
    string outcome, bool isBuy, uint256 amountCents, uint256 limitPrice, bytes32 contextHash);
```

Why: `IntentRejected` and `IntentNeedsApproval` carry no trade details, so without this event a blocked attempt cannot be shown ("the agent tried to buy $30 of X and was stopped").
The dashboard and the public scorecard rebuild everything from events, so the details must be in the log.

### 3. `PolicySet` and `PausedSet` events

```solidity
event PolicySet(Policy policy);
event PausedSet(bool paused);
```

Why: the console shows the history of rule changes and the current rules from events alone, and the public scorecard needs to prove which rules were in force when each verdict was given.

### 4. Views

```solidity
function policy() external view returns (Policy memory);
function owner() external view returns (address);
function agent() external view returns (address);
function executor() external view returns (address);
function spentCents() external view returns (uint256);
function lossTodayCents() external view returns (uint256);
function intentCount() external view returns (uint256);
function getIntent(uint256 intentId) external view returns (Intent memory);

enum Status { None, NeedsApproval, Approved, Rejected, Filled, Unfilled }

struct Intent {
    address agent;
    string market;
    uint8 category;
    string outcome;
    bool isBuy;
    uint256 amountCents;
    uint256 limitPrice;
    bytes32 contextHash;
    Status status;
    string reason;       // reason code when rejected, otherwise empty
    uint64 proposedAt;   // block.timestamp of the proposal
    uint256 filledCents;
    int256 pnlCents;
}
```

Why: the agent needs its remaining headroom before it proposes, the console needs the current state without replaying the whole log, and the executor needs to confirm an intent is still `Approved` before it records a result.
Please return the structs from explicit functions, not public state variables, because an automatic getter returns the fields as a tuple and changes the ABI.
Intent ids start at 1, so an id of 0 or above `intentCount()` returns a zeroed struct with status `None`.

### 5. `previewTrade`

```solidity
function previewTrade(uint8 category, bool isBuy, uint256 amountCents)
    external view returns (uint8 verdict, string memory reason);
```

Verdict: 0 approve, 1 needs approval, 2 reject (with a reason code).
It must call the same internal rule function as `proposeTrade`, so the two can never disagree.
Why: the agent asks "would this pass?" before spending gas, and the console's "simulate" view relies on it (issue #30, "simulate before acting").

### 6. Fixed reason codes

| Code | Meaning |
| --- | --- |
| `PAUSED` | The owner paused the agent. |
| `CATEGORY_NOT_ALLOWED` | The category bit is not set in `allowedCategories`. |
| `OVER_MAX_TRADE` | `amountCents > maxTradeCents`. |
| `OVER_BUDGET` | A buy would take `spentCents` past `budgetCents`. |
| `DAILY_LOSS_LIMIT` | Today's realized loss is at or above `dailyLossCents`. |
| `REJECTED_BY_OWNER` | The owner rejected an intent that was waiting for approval. |

Why: the agent and console map each code to a label and a one-sentence explanation, and the scorecard counts rejections by code.
Please use exactly these strings; offchain code shows unknown codes as raw text but cannot explain them.

### 7. Rule order

`proposeTrade` and `previewTrade` check, in this order, and stop at the first failure:

1. paused
2. category
3. max trade
4. budget (buys only)
5. daily loss
6. approval threshold (needs approval when `approvalAboveCents != 0 && amountCents > approvalAboveCents`)

Why: when several rules fail, the reason must be the same onchain and offchain.
The TypeScript mirror (`evaluateIntent` in `@mandate/shared`) uses this order, and a 600-case fuzz test checks it against the contract.

### 8. Budget semantics

- `spentCents` grows by `amountCents` when a buy intent is approved, whether automatically or by the owner.
- When the result is recorded, `spentCents` is corrected from `amountCents` to `filledCents`, which releases the unfilled remainder.
- Sells never consume budget, but they are still subject to pause, category and max trade (and the daily loss rule).
- An intent waiting for approval reserves nothing.
  The budget is checked again in `approveIntent`; if the buy no longer fits, the intent is rejected with `OVER_BUDGET` and `IntentRejected` is emitted instead of reverting.
- The budget check is `spentCents <= budgetCents && amountCents <= budgetCents - spentCents`, so no input can overflow and lowering the budget below current spend blocks every buy.

Why: the agent must be able to compute its headroom exactly, and a failed or partial fill must not burn budget.

### 9. Daily loss

- On `recordResult`, a negative `pnlCents` adds `-pnlCents` to the loss of the current UTC day (`block.timestamp / 1 days`).
- `lossTodayCents()` returns that sum for the current day, and 0 once the day has changed.
- When `dailyLossCents != 0` and `lossTodayCents() >= dailyLossCents`, new intents are rejected with `DAILY_LOSS_LIMIT`.

Why: this is the "risk rules, not only spend rules" part of the product, and the offchain mirror needs the exact definition.

### 10. Input validation and custom errors (recommended)

The reference contract reverts, rather than storing a rejected intent, on malformed input: empty `market`, an `outcome` other than `YES` or `NO`, `amountCents == 0`, or a `limitPrice` outside 1 to 99.
It also uses custom errors so clients can say exactly what went wrong:

```solidity
error NotOwner();
error NotAgent();
error NotExecutor();
error ZeroAddress();
error InvalidAmount();
error InvalidLimitPrice();
error InvalidOutcome();
error InvalidMarket();
error IntentNotPending(uint256 intentId);   // approve or reject an intent that is not waiting
error IntentNotApproved(uint256 intentId);  // record a result for an intent that is not Approved
error InvalidFill(uint256 intentId);        // filledCents > amountCents, or filled == false with filledCents != 0
```

Why: these are bugs in the caller, not policy decisions, so they should not pollute the verdict log.
The names are in `policyAbi`, so `PolicyClient` reports them as, for example, "setPolicy reverted with NotOwner".
If you prefer different names, tell us and we will update the ABI.

## Part 3: open questions for the contract owner

1. **How are the agent and executor addresses set?**
   The reference contract takes them in the constructor and adds owner-only `setAgent(address)` and `setExecutor(address)`.
   Rotation matters because the agent key lives on a server and may need to be replaced.
2. **One contract per owner, or one contract for many owners?**
   The reference contract and all offchain code assume one deployment per owner, with one agent and one executor.
   A shared contract would need an owner or agent key on every function and event, which changes the ABI.
3. **Should anything besides the budget be re-checked in `approveIntent`?**
   The reference contract re-checks only the budget, as specified.
   It does not re-check pause or the daily loss limit, so an owner can approve a waiting intent while trading is paused.
   If the kill switch should also block approvals, please re-check pause there too and tell us.
4. **Should `setPolicy` and role changes emit events for `setAgent` and `setExecutor` too?**
   We do not need them today, but the public scorecard would be more complete with them.
5. **Partial fills.**
   We assume one `recordResult` per intent, with `filled == true` and `filledCents < amountCents` for a partial fill.
   If the executor may record several partial fills, the interface needs to change.
6. **Reverts on malformed input** (Part 2, item 10).
   Please confirm you are happy to revert instead of emitting a rejection for those cases.
