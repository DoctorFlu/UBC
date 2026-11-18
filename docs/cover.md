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
| `partly_met` | Something is held, but less. The plan buys only the missing part. |
| `not_met` | Nothing held pays below the floor. The plan is the full staircase. |
| `nothing_to_cover` | The goal calls for no contracts: no strike below spot, the floor is not below the ceiling, or the holding is too small. |

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
