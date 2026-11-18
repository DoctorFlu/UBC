# Cover: when a protection goal is already met

Issue #88: an hourly routine bought the same hedge twice, because whether the holding was "already covered" was left to the model, reading raw tool output.
Cover is now a fact the server computes, the same way every time, from what the Policy contract and the executor record.
The maths is in `planner/src/cover.ts` (`assessCover`, `positionsFromIntents`); `plan_hedge`, `execute_plan` and the console's Hedge page all use it.

## The goal

A goal is a holding (asset and quantity), a floor, a ceiling (default: spot) and one ladder, which is one expiry.
It means exactly what it means to the planner: the staircase of NO contracts that `planHedge` would buy with nothing held, with no cost, budget or depth limit.
That staircase buys `q x (K_prev - max(K, F))` contracts at each strike `K` below the ceiling, rounded down to Gemini's 0.01-contract increment, down to the first strike at or below the floor `F`.

The goal is measured from spot, like a plan.
When spot rises, the loss between spot and the floor grows, so the same positions cover a smaller share of it; when spot falls, they cover more.

## One goal per asset and ladder

A mandate has one goal per asset and ladder (event), so a daily and a weekly hedge of the same holding are two goals, each with its own floor and staircase.
Each stored plan names its goal: its asset, its ladder and its floor.
Which stored plans are goals (`selectGoalPlans` in `shared/src/goals.ts`):

- For each asset, its newest plan, and every plan with at least one order proposed to the contract, are candidates.
  An order is proposed when an intent is linked to a decision context that names the plan; an intent the contract rejected still counts.
- Of the candidates, the newest per ladder is that ladder's goal.

So the newest plan for an asset supersedes the asset's older plans that never reached the contract, and a plan that did stays a goal until its ladder expires.
A weekly hedge that was executed and a daily planned after it are two goals; planning a third ladder while the daily has no proposed order drops the daily; a plan whose every order was rejected stays a goal and reads not covered.

Home, the price wake-ups, the digest and `get_portfolio` measure every goal whose ladder has not expired, soonest expiry first (at most 4).
Home's "Goals covered" counts each goal.
The cover uses the saved holding, or the holding the plan was sized for when none is saved.
Goals are named in words, by when they end: "BTC, through today, 22:00 UTC" on the day the ladder settles, otherwise "BTC, through Fri 20 Nov", never by the ladder's ticker alone (`goalLabel`).
The Hedge page keeps one tab per asset; inside a tab with more than one goal, a row of goals, soonest first, picks the one the rest of the page shows (`?goal=` keeps the choice).

## Two questions, two sources of strikes

What is covered and what can be added are different questions, and they read different strikes.

- **What is covered** is the goal measured against the positions held, each at its own strike.
  The goal's staircase is designed over the ladder's strikes plus every strike Gemini's production exchange lists on the same event that the ladder lacks (`CoverLadder.elsewhere`, `coverStrikes`).
  It never depends on what is held: a goal built on the held strikes would shrink to whatever is held and read covered.
  When the orders go to production, `elsewhere` is empty and the goal is production's ladder, as before.
- **What can be added** comes from the ladder of the exchange that takes the orders, and only from it.
  `planHedge` buys on that ladder's strikes; a position at a strike it does not list still pays below every one of its strikes under it, so it counts toward each rung there.
  `addablePayoutCents` is what a plan can add there now; when it is 0 for a goal not met, `reason` says why.

On 18 November 2026 Gemini's sandbox listed 8 strikes on the weekly BTC ladder, all above spot, while production listed 21 and the hosted mandate held NO at 7 of production's.
Measured on the sandbox's strikes alone, that goal read "nothing to cover"; measured as above, it reads covered, exactly as on production.
Holding only the three highest of those strikes reads partly covered, and nothing can be added on the sandbox (`no_strike_below_spot`).
When production cannot be read on a stack whose orders go elsewhere, the goal cannot be designed, so cover is shown as unavailable.
`planner/test/cover-two-exchanges.test.ts`, `dashboard/src/server/cover-two-exchanges.test.ts` and `agent/test/two-exchanges.test.ts` replay both exchanges as recorded that day (`@mandate/gemini/two-exchanges`).

## What counts as held

Every intent on that ladder's markets that buys NO and is one of:

| Contract status | Position state | Contracts |
| --- | --- | --- |
| `executed` | filled | `floor(filledCents x 100 / limitPrice)` hundredths |
| `approved` (the executor has not filled it yet) | waiting to fill | `floor(amountCents x 100 / limitPrice)` hundredths |
| `needs_approval` (waiting for the owner) | waiting for the owner | `floor(amountCents x 100 / limitPrice)` hundredths |

Rejected and failed intents, sells, YES buys, other ladders, and numbers that do not fit are not counted.

A held position on this ladder's event whose symbol the ladder does not list is looked up on Gemini's production exchange, for the same event.
That is a fill the simulated venue made before the stack traded on the sandbox: it read production, and the sandbox lists fewer strikes.
A strike belongs to its symbol on every exchange, and so does the index it settles on, so the position counts at production's strike.
When neither the ladder nor production lists the strike, cover is not measured at all: `plan_hedge` and `execute_plan` refuse with `POSITIONS_UNRESOLVED` (or `MARKET_DATA_UNAVAILABLE` while production cannot be read), and the console shows cover as unavailable.
A position is never left out quietly, because a plan made without it could buy the same protection twice.
Orders waiting for the owner count, so a run never buys again what the owner has not decided on yet; if the owner rejects one, its slice is missing again and the next run buys only that slice.
The contracts are the most the money buys at the limit price in 0.01 increments; for an order the planner sized, that is at least the planned quantity.

## Where cover is measured

A NO contract at strike `S` pays $1 whenever the price ends below `S`, so positions held at strikes `S >= K` all pay for a finish just below `K`.
Cover is measured just below the last strike of the goal's staircase, where the staircase pays in full.
That is the floor when the floor is a strike (the usual case), otherwise the first strike under the floor.

- **Target**: what the staircase pays there, the sum of its rungs (in cents, one cent per hundredth of a contract).
- **Held**: what all positions held on the ladder pay there, including any above the ceiling.
- **Shortfall**: `max(0, target - held)`.
- **Cover**: `held / target`, in basis points (10000 is 100%).

## When the goal is met

The goal is **met** when the shortfall is at most 2% of the target, rounded down to the cent (`COVER_TOLERANCE_BPS = 200`).
The tolerance absorbs the 0.01-contract rounding of each rung and small moves of spot between runs, so a holding covered 99% is never bought again for a few cents of drift.
A target under 50 cents has no tolerance, so nothing held is never "met".

| State | Meaning |
| --- | --- |
| `met` | Held pays the target below the floor, within the tolerance. `plan_hedge` returns no orders and the reason `ALREADY_COVERED`. |
| `partly_met` | Something is held, but less. The plan buys only the missing part it can buy on the exchange that takes the orders. |
| `not_met` | Nothing held pays below the floor, and a plan can add protection. |
| `nothing_to_cover` | The floor is not below where protection starts (spot, by default) and nothing is held, so the goal calls for no contracts now. Reason `floor_not_below_ceiling`. |
| `cannot_hedge` | Nothing held pays and nothing can be bought for the goal now, or no staircase can be built at all. Its reason says why (below). |

A goal carries a `reason` when it has no staircase, or when it is not met and nothing can be added:

| Reason | Meaning |
| --- | --- |
| `floor_not_below_ceiling` | The floor is at or above spot (or the ceiling the goal set), and nothing is held. |
| `no_strike_below_spot` | The exchange that takes the orders lists no strike below spot on this ladder. |
| `ladder_not_listed` | The exchange that takes the orders does not list the ladder at all. Positions held are measured on production's strikes as usual. |
| `holding_too_small` | The holding is too small for the smallest contract (0.01) on any rung. |
| `no_more_strikes` | What is still missing lies on strikes the exchange that takes the orders does not list. Only Gemini's sandbox lacks strikes its production exchange lists, so the sentences say so: "Gemini's real exchange lists lower strikes that the sandbox your orders go to does not", with "lower" only when every missing strike lies below the sandbox's lowest (`missingBelowVenue`). |

Only `met` counts as covered: Home's "Goals covered" counts `met` goals, and neither `nothing_to_cover` nor `cannot_hedge` is ever called covered.
The cover always states the goal's floor, also when no strike lies below spot, so "$0" never stands for a floor.
When every strike there is lies above the floor, the staircase ends at the lowest one, and the sentences name that strike as where protection ends (`downToCents` in `get_portfolio`).
A goal met there ends "No lower strike is listed, so nothing more can be added.", never "Nothing more is needed.", which is kept for a staircase that reaches the floor.
While the Hedge page waits for the goal's quotes, "Cover now" says it is measuring; "cannot be measured now" appears only after a read failed.

## When the price is at or below the floor

That is the moment a hedge is for, so with positions held the goal never reads "nothing to protect".
`coverOfPlan` then measures the goal as it was planned: the staircase from the spot the plan read down to the floor (`belowFloor.plannedSpotCents`).
The positions count by what they pay if the price settles at today's spot: every one whose strike is above it (`belowFloor.paysAtSpotCents`, also `heldPayoutCents`).
The goal is met, and Home counts it covered, when that payout is at least the planned staircase's payout, within the same 2% tolerance.
Nothing is missing to buy: below the floor the goal calls for no more contracts, and `plan_hedge` says what the contracts held pay instead.
Losses below where the staircase ends were never part of the goal, so a goal covered as planned stays covered however far the price falls.
With nothing held, the goal reads `nothing_to_cover` as before.

Cover is judged below the floor only.
Positions bunched at low strikes can make a goal "met" while a smaller fall pays less than the staircase would; the console's Advanced view shows each strike for that reason.

## The missing part

When the goal is not met, the plan buys the smallest top-up that brings the payout of held plus new contracts up to the staircase at every strike, nearest spot first, and never adds more below the floor than the shortfall.
With `T_i` the staircase's payout just below its `i`-th strike and `E(K)` what is held pays just below `K`:

```text
B_0 = 0
B_i = min(shortfall, max(B_{i-1}, T_i - E(K_i)))
missing_i = B_i - B_{i-1}
```

With nothing held this is the full staircase; with the full staircase held it is nothing; when spot rose, it is the top slice; when the owner rejected one rung, it is that rung.
The planner then buys `missing_i` at each strike under the usual cost cap, budget, trade size and depth limits.
The property tests in `planner/test/cover.test.ts` check that planning after a plan was executed buys nothing, that any partial execution is completed with only the missing contracts, and that the payout below the floor never goes beyond `max(held, target)`.

## Execution never goes beyond the goal

A plan remembers the intents it counted as held (its basis).
Before each order, `execute_plan` re-reads the positions on the ladder from the chain, under a lock per ladder held across the read and the proposal.
If any position is neither in the basis nor one of the plan's own orders, it sends nothing more and answers `COVER_CHANGED`; the agent then plans again.
So two runs at the same moment, a retried `execute_plan`, and a stored plan executed after other orders landed can never buy the same protection twice.
The lock is in the server process; the hosted stack runs one.
The event index answers as of the block that was latest when a read started, so a read right after a proposal always sees it.

A call's deadline (`MCP_TOOL_DEADLINE_MS`) ends a run between two orders, never inside one.
An order starts only while there is time left for its proposal and receipt, and a proposal is broadcast only with that time still left.
A broadcast proposal is followed to its receipt, up to 3 s past the deadline; one still without a receipt is recorded as `TX_UNCONFIRMED`, the run stops there, and that order is never sent again.
So when a run stops, every order of the plan is either recorded or was never sent, and the next `execute_plan` goes on from the first unsent order, after the same re-check.
If another proposal added protection on the ladder in between, that re-check answers `COVER_CHANGED` as above.
A call that gives up waiting for the ladder's lock never sends anything later.
`agent/test/deadline.e2e.test.ts` stops a run while the console holds the second order's decision context and checks both continuations.

`agent/test/routine.e2e.test.ts` runs the routine against the real server, a Policy contract on anvil and the simulated executor: twice in a row, twice at the same moment with retries, with a stale plan, with an order waiting for the owner, and after a plan the cost cap cut short.
The red-team attack `mcp.repeat-and-overlap-runs` does the same against the server as a hostile agent would.
