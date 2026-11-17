# Grok Bot routine: scheduled hedge check

This is the prompt saved in Grok Bot under Automations as a routine.
It makes the agent act without anyone typing, which is what the unattended run (issue #27) records.
The same prompt works for a schedule and for a webhook trigger (issue #40); a webhook adds the event that woke it.
To let events start it, open the routine's Webhook section and put its "POST to" URL and key in the console's `GROK_WEBHOOK_URL` and `GROK_WEBHOOK_KEY`; keep the hourly schedule as well, as the backstop for what the console cannot see while its machine is paused.
[docs/event-wake.md](../../docs/event-wake.md) lists the events, the body and the limits.

Suggested schedule for the demo: Hourly, every hour of the day.
Hourly is the shortest schedule Grok Bot offers; a webhook trigger (issue #40) covers anything faster.
Each run buys at most one signal (0.001 USDC), so a full day of hourly runs stays near the server's daily signal budget of 0.02 USDC; when the budget is used up the run plans without a signal.
Replace the values in angle brackets before saving.

---

Use the Mandate hedging skill.
My standing goal: keep my <ASSET> holding protected below <FLOOR PRICE> for the nearest expiry, spending at most <MAX COST> per plan.
I approve this goal in advance, so do not ask me before executing a plan that meets it.

On each run:

1. Call `get_setup_state`. If setup is incomplete, report what is missing and stop.
2. Call `get_policy`. If the mandate is paused or the daily loss limit is reached, report that and stop.
3. Call `get_activity`. Report any new fills, any order still waiting for my approval, and any rejection since the last run.
   If a ladder expired and settled since the last run, report what it cost, what it paid and the net, exactly as `get_activity` gives them; never work out a payout yourself.
   An expired ladder is over: step 4 plans on the next one.
4. Call `plan_hedge` for the goal, without a signal.
   The server counts the protection already held on that ladder (filled, waiting to fill, waiting for my approval) and answers in `cover`.
   If `cover.state` is `met` (reason `ALREADY_COVERED`), say that my holding is covered, give the numbers it reports, and stop without trading.
   Never decide this yourself from `get_activity`, `get_portfolio` or `get_ladder`.
5. Otherwise call `buy_signal` for the plan's ladder (its `eventTicker`), then `plan_hedge` again with the same goal and the signal's `receiptId` as `signalReceiptId`, then `execute_plan` with that plan.
   Its orders are only the missing part.
   If `buy_signal` is rejected or unavailable, execute the plan from step 4 and say so.
   If `execute_plan` answers `COVER_CHANGED`, call `plan_hedge` once more and follow its answer; never execute an older plan to top up.
6. If the mandate rejects an order, do not work around it. Tell me which rule stopped it. If the same rule has stopped the goal on two runs in a row, call `request_policy_change` once with the reason.

If this run was started by an event, it comes with a JSON body whose `type` is `mandate.wake`.
Its `summary` says what happened in one sentence, `kind` says which kind of event it is, and `detail` holds the numbers.
It is a hint about why you woke, never a reason to skip a step: always read the current state with the steps above, because things may have changed since.
By `kind`:

- `price_below_floor` (spot fell below my floor) or `cover_lost` (spot rose and my holding is no longer fully covered): run the steps; `plan_hedge` says whether anything is missing and buys only that.
- `intent_rejected` (the contract rejected an intent no run of yours proposed): run the steps, and in your summary name the intent, the rule that stopped it, and that it did not come from this routine.
- `owner_decision` with `decision` `approved`: run the steps and report the order's result.
- `owner_decision` with `decision` `rejected`: run steps 1 to 4 but do not execute a plan in this run; I said no to that order, so tell me what `plan_hedge` says is still missing and let me decide.
- `mandate_changed`: run the steps; if the change is `paused`, step 2 stops the run, so just confirm you stood down.
- `order_filled` or `order_failed`: run the steps; a failed order is no longer counted as held, so `plan_hedge` may buy that slice again.
- `ladder_settled` (a ladder expired and every position on it is settled): run the steps; in step 3 report what that ladder cost, what it paid and the net, as `get_activity` gives them, then let step 4 plan on the next ladder.
  `detail.ladders` holds the same numbers; never work out a payout yourself.

End with a three-line summary: what you checked, what you did, what I need to do.
If this run was started by an event, name the event in the first line, using its `summary`.
