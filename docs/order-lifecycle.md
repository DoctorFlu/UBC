# Order lifecycle

How one hedge order goes from the agent's plan to what it paid at expiry, which part of the stack owns each step, and what is recorded where.
Issue #92 added the last steps: settlement at expiry and the roll to the next ladder.
Issue #93 added a real venue, Gemini's sandbox ([gemini-venue.md](gemini-venue.md)).

```text
plan_hedge -> execute_plan -> proposeTrade -> verdict -> (owner approves) -> executor checks the market
  -> venue fills -> recordResult (onchain) -> ladder expires -> Gemini publishes the outcome
  -> executor signs the settlement -> console stores it -> Bot reports it and plans on the next ladder
```

## 1. Proposal and verdict

The agent's MCP server plans on the soonest ladder that has not expired (`plan_hedge`), seals its reason in the console, and calls `proposeTrade` with the agent key (`execute_plan`).
The Policy contract checks the mandate and answers in the same transaction: approved, rejected with a reason, or held for the owner's approval.
A held intent waits until the owner approves or rejects it in the console.

## 2. Fill

The executor watches for `IntentApproved`.
For each approved intent it reads the stored intent, refuses anything the venue could not trade (not a Gemini symbol, not YES or NO, a limit outside 1 to 99, a market Gemini does not list, or one listed under another category), and records a refusal as not filled.
Otherwise it places the order on the venue, follows it until it is closed, and records the fill with `recordResult(intentId, filled, filledCents, pnlCents)`.
When the venue cannot be reached it does nothing and tries again later: an order that cannot be checked is never placed.

## 3. The venue seam

Every venue sits behind one interface, `Venue` in `devchain/src/venue.ts`, so the executor's rules are the same whatever fills the order:

| Method | Answers |
| --- | --- |
| `categoryOf(symbol)` | The mandate category Gemini lists the market under, or null when it lists no such market. |
| `placeOrder(order)` | `placed` with the venue's id for the order; `refused` (the venue refused the order itself: recorded as not filled); or `held` (no order now and nothing recorded, for example while the terms are not accepted or a lost answer is looked up: asked again later). |
| `readFill(placed)` | `open` (ask again) or `closed`, with the cents filled and why it closed. |
| `positionOutcome(position)` | `open` with its expiry, `awaiting` (expired, no outcome yet), `unlisted`, `disputed` (the venue's own record disagrees with the public outcome: never settled), or `resolved` with the resolution, the settlement value, the contracts held and the payout. |

Each method throws when the venue cannot be reached; the executor then waits and asks again, and never guesses.
`simulatedVenue`, the default, places nothing, fills every order in full at its limit price, and reads listings and outcomes from Gemini's public market data, so a position settles exactly as the real market did.
`geminiVenue` (issue #93, `EXECUTOR_VENUE=gemini`) places the order on Gemini Prediction Markets' sandbox, journals it in the console so it is never placed twice, and settles only when the account's settled position agrees with the public outcome; [gemini-venue.md](gemini-venue.md) has the rules.

## 4. Settlement

A position is a filled buy of YES or NO.
At its limit price `p` cents, `c` cents buy `c / p` contracts (kept in hundredths, rounded down), and each contract pays $1 when the market resolves to its side, nothing otherwise (`contractsBought` and `payoutFor` in `shared/src/settlement.ts`).

What the executor does with each filled position:

1. When the fill is recorded, it asks the venue once, which tells it when the ladder expires.
2. It asks nothing more until 5 seconds after that expiry.
3. Then, while Gemini has not published the outcome, it asks again after 1, 2, 5 and 10 minutes, then every 30 minutes, and never guesses.
   One question answers for every position on the same ladder, so a ladder costs one request per wait, whatever it holds: about 8 requests in its first two hours, against Gemini's public limit of 120 a minute.
4. Once Gemini publishes the outcome, it builds the settlement document for each position (the fill onchain plus the outcome: cost, contracts, resolution, payout, net), signs its hash with the executor key, and stores it in the console.
5. A console that does not answer, or has not read the fill yet, gets the same waits as an unpublished outcome.

### Exactly once

The console keeps the first record per intent and answers a repeat with it.
The document has no "now" in it, so after a restart the executor reads every fill again from the deploy block, builds the same documents, and the console answers "already stored".
A different document for an intent that already has one is refused (`409 conflict`), and the executor keeps the first.

### What the contract can and cannot record

The Policy contract cannot hold a payout.
`recordResult` works only while an intent is `Approved` and moves it to `Executed`, so the executor spends it on the fill, days before the market resolves.
So the payout is recorded offchain, in the console, sealed the way decision contexts are:

- the document is canonical JSON (`settlementSchema`), and its keccak256 hash is signed with the executor key (EIP-191 over the raw 32 bytes);
- the console stores it only when the signer is the contract's `executor()` and the numbers match the fill onchain (`PUT /api/executor/v1/settlements/:intentId`, which the proxy does not expose: only the executor, inside the stack, reaches it);
- it re-hashes the document on every read, and a record that no longer matches shows as tampered and is never counted.

Two limits follow, and the console says so where it shows a payout.
The record is as trustworthy as the executor key and the console's copy, not the chain.
And the contract's daily loss rule never sees a settlement loss.
[contract-interface.md](contract-interface.md#24-recordsettlement-issue-92) asks for `recordSettlement` to close both.

## 5. A hosted machine that pauses

The hosted machine pauses after about 30 idle minutes ([hosting.md](hosting.md#pauses-and-the-free-plans-limits)).
The executor's settlement timer looks every 60 seconds (`EXECUTOR_SETTLE_MS`), but the look is local: on a tick where no filled, unsettled position has reached its expiry or the end of its wait, it calls neither Gemini nor the console, so it never keeps the machine awake.
While the machine is paused nothing runs, so a ladder that expires during a pause is settled on the next wake: the first tick after it finds the position due and asks at once.
On Gemini the same holds for its private API: the executor asks it about an order only while that order is open or held (its waits grow to 10 minutes), and about settled positions only after the public outcome is out, so with nothing open it sends Gemini nothing.
The hourly scheduled run of Grok Bot wakes the machine anyway, so a settlement waits at most about an hour.

## 6. What the owner and the agent see

The console (all from the verified records only):

- Hedge: once the plan's ladder has expired, "Cover now" gives way to "Expired ladder", which says it is waiting for Gemini's outcome, or what the positions cost, paid and netted, and that the next plan goes on the next ladder.
  Advanced view lists each strike: contracts held, resolution, cost, payout, net and the intent.
  After the agent plans on the next ladder, the last settled ladder stays below it.
- Activity: an "At expiry" column with what each settled position paid and its net, and a "Paid at expiry" total.
- Intent detail: an "At expiry" card with the resolution, cost, payout and net, and in Advanced view the signer and the hash.
- The public scorecard counts settled positions with their cost, payout and net, and says they are recorded offchain, signed by the executor.

The agent (no tool input changed):

- `get_activity` returns `settlements`: totals and the last few settled ladders, and each intent's `settlement`; its `last24h.settled` counts the ones the console stored in the last 24 hours, for the daily digest ([grok-bot.md](grok-bot.md#daily-digest-issue-97)).
- `get_portfolio` returns `settled`, with the last settled ladder, and says that ladder is over.
- `plan_hedge` never offers an expired ladder, so the next plan rolls to the next one by itself.
- The console wakes the routine once per settled ladder (`ladder_settled`, [event-wake.md](event-wake.md)), with the ladder's cost, payout and net.
  The routine ([agent/grok/routine.md](../agent/grok/routine.md)) reports that and plans on the next ladder.

## Tests

- `devchain/test/venue.test.ts`: the simulated venue's outcomes on recorded Gemini events, open, awaiting, unlisted and resolved.
- `devchain/test/executor.test.ts`: a position settles once, signed, only after the outcome is published; a restart and a conflicting outcome never rewrite it; passes make no call while nothing is due, and an expired ladder costs one question per wait.
- `dashboard/src/server/http/executor-api.test.ts`: the console refuses records not signed by the executor, numbers that do not match the fill, and a second record; an edited record shows as tampered.
- `dashboard/src/server/db.test.ts`: a database at the hosted console's schema upgrades with its data to the settlements table.
- `dashboard/src/server/settlement-wake.test.ts`: one wake-up per ladder, after its last settlement.
- `agent/test/routine.e2e.test.ts`: a ladder moves past expiry, its positions settle once, `get_activity` and `get_portfolio` report it, and the next run plans on the next ladder only.
- `dashboard/e2e/live.spec.ts` ("an expired ladder settles once"): the real console, chain and executor with the fake Gemini; the Hedge, Activity and intent pages show what the ladder paid.
- The Gemini venue's own tests are listed in [gemini-venue.md](gemini-venue.md#tests).
- `npm run dev:settle-proof [-- hourly|daily]`: against Gemini's live public API (no key, nothing placed), plans on the soonest hourly or daily BTC ladder, fills the plan with the simulated executor on a throwaway anvil, and waits until it settles by itself.
  On 17 November 2026 it settled both positions of `BTC2611171000` (expired 10:00 UTC, BTC at $64,305.67, both NO strikes resolved YES); Gemini's own `resolvedAt` put the strikes 6 to 141 seconds after expiry.
