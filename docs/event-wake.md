# Event wake-ups

Issue #40: besides its hourly schedule, Grok Bot's routine runs when something happens that the owner would want acted on, with no person involved.
The console posts a small JSON event to the routine's webhook; a `200` answer means a run started.
Each run spends the owner's Bot usage, so the notifier is built to send few, never twice, and never in a loop.

## Where it lives and why

The notifier runs inside the console backend (`dashboard/src/server/wake.ts`), with its rules and its sender in `@mandate/shared` (`shared/src/wake.ts`, `shared/src/wake-notifier.ts`) so the red team can drive the same code.

- The console already ingests every Policy event into its store, from the RPC poller today and from the QuickNode Stream webhook later (issue #19).
  Both sources end in one function, `ConsoleService.apply`, which receives only the events the store had not seen (an event is identified by its transaction hash and log index).
  The wake-up rules are called there, so a trigger fires once whichever source delivered its event, and a repeated delivery fires nothing.
- The console already asks Gemini for live ladders through a cached, rate-limited client (`MarketQuotes`), and it holds what cover needs: the agent's latest plan per asset (the current goal), the owner's holdings and the intents.
  The price check reuses that client and the server's cover computation (`coverNow`, which calls `coverOfPlan` from `@mandate/planner`; see [cover.md](cover.md)).
- The MCP server only answers Grok Bot; it has no view of the chain between calls.

## The event body

`POST <routine URL>` with `Authorization: Bearer <key>` and `Content-Type: application/json`.
The body is version 1 of `wakeEventSchema` (`shared/src/wake.ts`), usually 300 to 900 bytes:

```json
{
  "type": "mandate.wake",
  "version": 1,
  "id": "wk_8f2c0a51d3e94b7a6c1f0e2d",
  "kind": "owner_decision",
  "occurredAt": "2026-11-16T14:02:11.000Z",
  "sentAt": "2026-11-16T14:02:12.204Z",
  "attempt": 1,
  "count": 1,
  "summary": "The owner rejected #12 (rejected by user).",
  "link": "https://console.example/activity/12",
  "detail": {
    "intents": [{ "id": 12, "market": "GEMI-BTC2611202200-HI64000", "decision": "rejected", "reason": "rejected by user" }]
  }
}
```

- `id` is the same on every retry of one wake-up, so a receiver can drop a repeat.
- `count` is how many triggers of this kind it carries (see debounce below); `detail.intents` lists at most 10 of them, the newest last.
- `link` is the console page that shows it, or `null` when `CONSOLE_URL` is not set.

| `kind` | When | `detail` |
| --- | --- | --- |
| `price_below_floor` | Spot fell below the floor of the current goal. | `asset`, `eventTicker`, `planId`, `spotCents`, `floorCents` |
| `cover_lost` | Spot rose and the protection held no longer meets the goal. | `asset`, `eventTicker`, `planId`, `spotCents`, `previousSpotCents`, `state`, `coverBps` |
| `intent_rejected` | The contract rejected an intent when it was proposed, outside a Bot run. | `intents[]`: `id`, `market`, `reason` |
| `owner_decision` | The owner approved or rejected an order that was waiting for them. | `intents[]`: `id`, `market`, `decision`, `reason` |
| `mandate_changed` | The owner changed the rules, paused or resumed the agent. | `change` (`rules`, `paused` or `resumed`), `paused` |
| `order_filled` | The executor recorded a fill more than 2 minutes (chain time) after the approval. | `intents[]`: `id`, `market`, `filledCents`, `pnlCents` |
| `order_failed` | The executor recorded that an approved order did not fill. | `intents[]`: `id`, `market` |
| `ladder_settled` | A ladder expired and the executor's settlement of its last filled position was stored (issue #92). | `ladders[]`: `asset`, `eventTicker`, `expiresAt`, `settlementValue`, `positions`, `costCents`, `payoutCents`, `pnlCents` |

What the Bot does with each kind is in the routine, [agent/grok/routine.md](../agent/grok/routine.md).

## Which events wake the Bot, and which are noise

The question for each event: does the Bot learn something it could act on, that no run in progress already knows?

| Event | Wakes? | Why |
| --- | --- | --- |
| `PolicyUpdated` | yes, `mandate_changed` | New limits can unblock a goal the last runs could not finish. |
| `Paused` | yes, when it changes the state | A pause tells the owner, in the Bot's chat, that it stood down; a resume lets it finish what the pause stopped. A `Paused` in the same transaction as `PolicyUpdated` (every `setPolicy` emits both) and a pause that repeats the current state wake nothing. |
| `IntentApproved` after `IntentNeedsApproval` | yes, `owner_decision` | The owner decided; the run reports it. |
| `IntentRejected` after `IntentNeedsApproval` | yes, `owner_decision` | That slice of the goal is missing again. The run reports it and does not buy it again unasked (see the routine). |
| `IntentApproved` in the proposal's own transaction | no | The verdict is the answer to the proposing call, which the proposer already has. |
| `IntentRejected` in the proposal's own transaction | yes, unless a run is in progress | Inside a run, `execute_plan` or `propose_trade` already returned the rejection: waking again would loop. Outside a run, someone else used the agent key (a dev script, a person in chat, a stolen key), which the owner should hear about. |
| `IntentNeedsApproval` | no | The owner must act, and the console already shows it waiting. |
| `IntentProposed` | no | Only a proposal; its verdict follows in the same transaction. |
| `ResultRecorded`, filled, within 2 minutes of approval | no | The expected end of an approval that already woke the Bot or happened inside its run; the simulated executor fills within a second. |
| `ResultRecorded`, filled, later | yes, unless a run is in progress | News: a real venue filled the order after the run ended. |
| `ResultRecorded`, not filled | yes, unless a run is in progress | Protection the goal counted on is missing. |
| Spot below the floor | yes | The protection starts to pay; the run reviews the hedge. |
| Spot rose and cover is no longer met | yes | The goal is measured from spot, so the same positions now cover less. |
| The executor's settlement of a ladder's last filled position is stored | yes, `ladder_settled` | The ladder is over: its protection is gone, and the next ladder holds none yet. |
| Any other settlement stored | no | Its ladder still has a position waiting for its outcome; the ladder wakes the Bot once, at its last one. |

Settlement is not a chain event: the contract has one `ResultRecorded` per intent, written when the order fills, so the executor records what each position paid in the console instead ([order-lifecycle.md](order-lifecycle.md)).
The console offers the `ladder_settled` wake-up when it stores one of those records, not from the chain:

- One wake-up per ladder, not per position: it is offered when the record of the ladder's last filled buy is stored, so a ladder of three positions wakes the Bot once, with the three positions' cost, payout and net added up.
- Its trigger id is the deployment and the ladder's event ticker, so a repeated record, an executor restart or a console restart never offers it again.
- It is never dropped as "the run's own doing" (a run cannot cause a settlement), and a ladder that settled while the machine was paused is still news when it wakes.
  Only a ladder that expired more than a day before its last record is stored wakes nothing (`SETTLED_NEWS_MS`): that is a replay, such as the executor recording old settlements again into a new console data folder.
- Two ladders settling inside one 10-minute window (BTC and ETH on the same expiry) share one wake-up: the second joins the first if it is still waiting, or waits for the window to end, and `detail.ladders` lists each ladder once.
- A position whose record is tampered with does not count as settled, so its ladder never wakes the Bot; the console shows the record as tampered.
Role changes (`setAgent`, `setExecutor`) emit no event, so nothing can wake on them.

A loss of cover that is not a rise of spot (an owner rejection, a failed fill) is reported by its chain trigger, not again by the price check.

### A run in progress

Every routine run calls the console through the MCP server, from its first step (`get_setup_state` reads the pairing and holdings) to its last order (`execute_plan` seals each order's reason in the console).
Only the MCP server holds the console's service token, so each authenticated call marks a run in progress for 3 minutes (`RUN_QUIET_MS`).
While it is in progress, rejections at proposal and fill results wake nothing: the run caused them and holds the answer.
Owner actions and price moves still wake it, debounced as below.
This depends on the MCP server being linked to the console, which the routine's first step requires anyway.

### History

Events wake nothing when the console reads them while catching up on a deployment it had never read, or when they are older than 15 minutes when read (`MAX_EVENT_AGE_MS`, chain time against the console's clock).
So a new console, a deleted data folder or a long stop never replays old events as wake-ups.

## Safety

| Guard | How |
| --- | --- |
| Once per event | Every trigger has an id (the deployment, transaction hash and log index; the goal and the count of crossings; or the deployment and a settled ladder). The console records each id in its SQLite file before anything is sent and ignores it after, across restarts. |
| No resend after a restart | A wake-up sent is never sent again. One whose request was in flight when the process stopped is marked failed ("outcome unknown") and counts toward the cap, because it may have started a run. |
| Debounce per kind | At most one wake-up of a kind per window: prices 30 minutes, rejections, fill results and settled ladders 10 minutes, owner decisions 2 minutes, mandate changes 1 minute. A trigger inside the window is not lost: it joins the one wake-up of its kind waiting for the window to end. |
| Daily cap | `GROK_WAKE_DAILY_CAP` (default 12) per UTC day, counting wake-ups answered 2xx and those whose outcome is unknown. Past it, a due wake-up is recorded as not sent. |
| Retries | Network errors and 5xx: retried after 1 s, 5 s, 30 s and 2 minutes, then given up. 4xx and redirects: never retried (a redirect is never followed, so the key never goes elsewhere). Each request times out after 10 s. |
| Bounded queue | At most one wake-up per kind waits for its first try, and at most 16 wait at all; past that a new one is recorded as dropped. |
| Secrets | The webhook URL and key are kept in a `WakeTarget`, which prints and serializes as `[redacted]`. Log lines, the record, errors (only "HTTP 503", "network error" or "timed out", never a raw message) and the console's snapshot never carry either. |
| No new polling | There is no timer of its own. Chain triggers ride on the ingestion that exists; price checks ride on the console's existing poll loop; settled ladders ride on the executor's request that stores a settlement; the only timer is the one that sends a waiting wake-up, set only while one waits. |

## Workspaces

Wake-ups belong to a mandate (issue #94, [accounts.md](accounts.md#event-wake-ups)): every record above is kept per mandate, and the daily cap counts one mandate's wake-ups.
For now the one webhook in the settings serves the first workspace's mandate, the one on the server's contract; a run in progress is marked only by that mandate's agent.
Other workspaces see wake-ups as off.

## Price checks and a machine that pauses

The hosted stack runs on a machine that pauses after about 30 idle minutes and wakes on the next inbound request ([hosting.md](hosting.md#pauses-and-the-free-plans-limits)).
While it is paused, nothing of ours runs, so nothing is watched.

The price check runs on the console's existing poll loop: on each poll after the chain is read, it checks the current goals when the last check is older than `GROK_WAKE_PRICE_CHECK_MS` (default 5 minutes).
It adds no timer, so the machine's idle time is unchanged.
Each check asks Gemini for each goal's ladder through the console's shared client: at most 4 goals (the latest plan per asset, with a floor, on a ladder not yet expired), at most 2 requests each, and nothing when the hedge view fetched the same ladder in the last 10 s.
That is at most 8 requests per 5 minutes, beside the client's 100 a minute.

What is and is not detected:

- While the machine runs: spot below a goal's floor and lost cover, within one check interval (5 minutes by default).
- When the machine wakes (any request: the owner opening the console, Grok Bot calling the MCP server, a Stream delivery): the first poll after the pause finds the last check older than the interval and checks at once.
  A fall below the floor that happened during the pause and is still below on waking is caught then, because the check compares with the side spot was on at the last check (or when the plan was made).
- Not detected: a dip below the floor that recovered before the machine woke, and any move while the machine stays paused.
  Nothing wakes the machine on a price move; the hourly scheduled run does, and it remains the backstop.
- Chain events during a pause: on the demo chain the chain itself is paused.
  On Arc testnet the console reads what it missed when it wakes; events older than 15 minutes by then are history and wake nothing, and the scheduled run reports them.

## Settings

| Variable | Meaning |
| --- | --- |
| `GROK_WEBHOOK_URL` | The routine's "POST to" URL. Empty: wake-ups are off. |
| `GROK_WEBHOOK_KEY` | The routine's key, sent as `Authorization: Bearer <key>`. Empty: wake-ups are off. |
| `GROK_WAKE_DAILY_CAP` | Most wake-ups per UTC day, 0 to 1000. Default 12. |
| `GROK_WAKE_PRICE_CHECK_MS` | Least time between price checks, at least 1000. Default 300000. |

With either the URL or the key empty, nothing is recorded, sent or checked, and the rest of the stack runs as before.
The console's Setup page shows, in Advanced view, whether wake-ups are on (or why not), how many are left today, the last five with what, when and the result, and when spot was last checked.

## Tests

- `shared/test/wake.test.ts`: each rule, and the notifier's debounce, cap, retries, restart and secrecy on a simulated clock.
- `dashboard/src/server/wake.test.ts`: the console's pipeline on anvil with a fake receiver.
- `dashboard/src/server/settlement-wake.test.ts`: a ladder of two positions wakes the Bot once, after its last settlement, with the ladder's totals; a repeated record and a restart send nothing.
- `dashboard/e2e/wake.spec.ts` (in the `live` project): the real console and chain, the fake Gemini and a local webhook receiver; an owner pause, a rejected intent, a late fill and a fall of spot each send exactly one event, the debounce and the cap hold, a restart resends nothing, and the Setup page shows it.
- `redteam` attack `chain.wake-flood`: a stolen agent key sends a burst of rejected intents, replayed through the same rules and notifier over a simulated day, and stays inside the cap.

Not verified: a real Grok Bot routine receiving the body (see [grok-bot.md](grok-bot.md#still-to-verify-by-hand)).
