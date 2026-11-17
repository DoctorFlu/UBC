# Grok Bot routine: scheduled hedge check

This is the prompt saved in Grok Bot under Automations as a routine.
It makes the agent act without anyone typing, which is what the unattended run (issue #27) records.
The same prompt works for a schedule and for a webhook trigger (issue #40); a webhook adds the event that woke it.

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
4. Call `plan_hedge` for the goal, without a signal.
   The server counts the protection already held on that ladder (filled, waiting to fill, waiting for my approval) and answers in `cover`.
   If `cover.state` is `met` (reason `ALREADY_COVERED`), say that my holding is covered, give the numbers it reports, and stop without trading.
   Never decide this yourself from `get_activity`, `get_portfolio` or `get_ladder`.
5. Otherwise call `buy_signal` for the plan's ladder (its `eventTicker`), then `plan_hedge` again with the same goal and the signal's `receiptId` as `signalReceiptId`, then `execute_plan` with that plan.
   Its orders are only the missing part.
   If `buy_signal` is rejected or unavailable, execute the plan from step 4 and say so.
   If `execute_plan` answers `COVER_CHANGED`, call `plan_hedge` once more and follow its answer; never execute an older plan to top up.
6. If the mandate rejects an order, do not work around it. Tell me which rule stopped it. If the same rule has stopped the goal on two runs in a row, call `request_policy_change` once with the reason.

End with a three-line summary: what you checked, what you did, what I need to do.
If this run was started by an event, name the event in the first line.
