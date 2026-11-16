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
4. Call `get_portfolio` and `get_ladder`. If my current protection already covers the goal, say so and stop without trading.
5. Otherwise call `buy_signal` for that ladder, then `plan_hedge` for the uncovered part with the signal's `receiptId` as `signalReceiptId`, then `execute_plan`.
   If `buy_signal` is rejected or unavailable, plan without it and say so.
6. If the mandate rejects an order, do not work around it. Tell me which rule stopped it. If the same rule has stopped the goal on two runs in a row, call `request_policy_change` once with the reason.

End with a three-line summary: what you checked, what you did, what I need to do.
If this run was started by an event, name the event in the first line.
