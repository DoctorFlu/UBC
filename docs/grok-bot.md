# Grok Bot integration notes

Status: documentation read on 2026-11-15 from docs.x.ai.
The web client at grok.com/bot was checked by hand the same day.
The hands-on connection test is still open (issue #4) until the MCP server from issue #9 is running.

## What Grok Bot is

Grok Bot is xAI's agent product: Bots that work on a shared cloud computer and keep running while your laptop is closed.
It is used through a web client at `https://grok.com/bot/<bot-id>`, a desktop app (macOS, Windows, Linux) and a mobile app.
The documentation only describes the desktop and mobile apps, but the web client exists and has the same settings: **Connect Apps**, **Skills**, **Automations** and **Bots**.
Premium, Super and Ultra plans on The X Subscription include it.
Source: https://docs.x.ai/grok-bot/get-started.md and https://docs.x.ai/x-subscription/grok-bot.md

## How it connects to our MCP server

In the web client or the desktop app, open **Connect apps** and choose **Add a custom connector** at the bottom of the list.
The dialog takes:

- **Name**: any label, for example `Mandate`.
- **Type**: `Remote HTTPS` (the other option, `Command`, runs a process on the Bot's computer).
- **Server URL**: our public address ending in `/mcp`.
- **HTTP headers** (optional): we use `Authorization: Bearer <MCP_AUTH_TOKEN>`.
- **OAuth Client ID** (optional): not used.

A Bot can also add an MCP server itself when asked, by URL.
Connected apps are account-wide, so every Bot on the account can use the connector.
Source: https://docs.x.ai/grok-bot/computer-and-apps.md

Grok's servers call the MCP server over the public internet, so a server on `localhost` needs a tunnel.
Cloudflare quick tunnels work with the Streamable HTTP transport and do not work with the older SSE transport.
Source: https://docs.x.ai/grok/connectors/custom-mcp-tunneling.md

Consequences for our server:

- Streamable HTTP only, and no reliance on long-lived server-to-client streams.
- Static bearer token in a header, checked on every request.
- The token is entered once in the connector dialog and never appears in chat.

## Skills

A skill is a reusable set of instructions.
It is created by asking a Bot to save a process as a named skill, and it is shared by all Bots on the account.
A useful skill states when to use it, required inputs and access, the sequence of work, how to validate the result, what to return, and what requires approval.
Source: https://docs.x.ai/grok-bot/skills-routines-and-automations.md

We ship the text of our skill in the repo (`agent/grok/skill.md`, issue #12).

Checked live on 2026-11-15:

- A skill can also be created by hand under Settings, Skills, New Skill. The form takes a name in kebab case, a description and Markdown instructions; pasted Markdown is rendered as headings and lists.
- The Grok Bot chat thread does not see that skill. Asked directly, the Bot answered that its skill list was empty.
- A new automation lists the skill and selects it by default, next to the Mandate connector.
  Seen on 2026-11-17 in the web client: an automation gets every connector and every skill on the account, and their checkboxes are disabled.
  So each routine's prompt names its connector ("Mandate Hosted"), and the daily digest's prompt sets the hedging skill aside; with a second connector on the account, such as "Mandate Local" for a laptop, a prompt that named none could use either.
- So in chat the Bot works from the MCP server's `instructions` and the tool descriptions only. Anything it must do in chat belongs in `agent/src/instructions.ts`; the skill serves the routine.

## Routines

A routine tells one Bot when to run a workflow.
It can run on a schedule ("every weekday at 8:00 AM") or on an event.
Routines run in the cloud.
A new scheduled routine waits for its next slot, and **Test** runs it immediately.

### Webhook triggers

A routine can be started by an HTTP call.
The routine's **Webhook** section shows a **POST to** URL and a **key**.
The sender posts to the URL with `Authorization: Bearer <key>` and an optional JSON body, which the Bot receives together with the routine instruction.
A `200` response means a run started, not that it finished.

This lets our backend wake the Bot when something happens onchain or in the market.
The console does it (issue #40): it posts a versioned `mandate.wake` event when spot falls below the goal's floor or a rise loses cover, the owner decides on a held order, changes the rules, pauses or resumes, an intent is rejected outside a run, or an order fills late or fails.
Events the Bot's own run causes, and the fill that follows an approval, wake nothing; a debounce per kind and a daily cap bound the rest.
[event-wake.md](event-wake.md) has the body, the reasoning and the limits, and the routine says what to do with each kind.
The webhook URL and key are secrets and belong in `.env` (`GROK_WEBHOOK_URL`, `GROK_WEBHOOK_KEY`, see [configuration.md](configuration.md#grok-bot-event-wake-ups)).

## Whether a goal is already covered (issue #88)

An unattended routine runs the same goal every hour, so each run must know what earlier runs already bought.
That is not left to the model: on 17 Nov 2026 a run read the fills, judged the holding "not yet fully" covered at about 99%, and bought a second full ladder.

- `plan_hedge` counts the protection already held on the ladder (filled, waiting to fill, waiting for the owner) and returns a `cover` object the server computed, with the reason `ALREADY_COVERED` and no orders when the goal is met.
  Otherwise its orders are only the missing part.
- `execute_plan` re-reads the positions before each order and stops with `COVER_CHANGED` if other orders added protection since the plan was made.
- The server instructions (`agent/src/instructions.ts`, sent on every connection), the routine and the skill tell the agent to rely on that answer and never to add up positions itself.

The definition of "covered" is in [cover.md](cover.md).
This changed what the tools return and the descriptions of `plan_hedge` and `execute_plan`, not any tool name or input schema.
The Bot reads descriptions only when the connector is added, so until it is added again it sees the old descriptions; the behaviour does not depend on them, because the server instructions arrive on every connection and every result says what to do next.

## Daily digest (issue #97)

A second routine sends the owner one short notification a day: what is protected, what was spent, what settled, and what waits for the owner.
It is read-only: it calls `get_setup_state`, `get_policy`, `get_portfolio` and `get_activity`, and never trades, buys a signal or proposes anything.
Its text is [agent/grok/digest.md](../agent/grok/digest.md).

The model adds nothing up.
The server sums the day and the console measures the cover, in fields the existing tools now return; no tool name or input schema changed:

- `get_activity` returns `last24h`: the intents proposed in the last 24 hours by status, what they filled, the rejections by the contract's reason, flagged intents, the signals bought and what settled, with cost, the estimated fees when there are any (`feeCents`), payout and the net after fees.
  It reads back through the whole day, whatever `limit` asks for, so the routine calls it with `limit` 1 to keep the result small.
- `get_activity` returns `waitingForOwner`: the intents waiting for approval and the rule change requests still pending, with a link to the console's Approvals page.
  A request's reason was written by the agent, so it is marked untrusted, cut to its start and kept out of the summary.
  The lists are capped so that the busiest day the caps allow stays under the 4 kB the Bot is known to take (a unit test checks it).
- `get_portfolio` returns `cover`: the cover held now against each current goal, which the console measures on Gemini's quotes exactly as its Hedge page does, and how much of it waits for the owner's approval.
  A goal that is met reads as covered, never as "99%" (issue #88).

These come from one new console read route, `GET /api/agent/v1/summary`.
A field the console cannot fill is null, and the routine reports it as unknown, never as zero.
The Bot sees no output schemas, so the routine names every field it reads.

To create it in Grok:

1. Open Settings, then Automations, and create a new automation.
2. Name it, for example `Mandate daily digest`, and set the schedule to Daily at the hour the owner wants it, for example 8:00 AM.
3. Leave the connectors and skills as they are: the web client attaches all of them and does not let them be changed, so the prompt names the "Mandate Hosted" connector and sets the hedging skill aside.
4. Paste everything below the line in `agent/grok/digest.md` as the instruction and save.
5. **Test** runs it immediately.

### Example digests

These three were written by following the routine on what the four tools returned on a local stack: the real MCP server, a Policy contract on anvil, the simulated executor and the fake console (`agent/test/digest-days.ts`).
The console address is a placeholder.
They show the shape; Grok writes the real ones.

A quiet day: the hourly runs found the goal covered and bought nothing.

```text
Mandate: all covered, quiet day. Nothing waits for you.
Protected: BTC below $63,000 to Nov 20 (BTC2611202200): covered.
Spent: nothing filled, no signals bought. Budget left $179.00.
Waiting for you: nothing.
```

A day with a settlement: last week's ladder expired and settled on Gemini, and the routine protected the next one.
The fee is estimated from Gemini's schedule, so the digest says so once; a simulated fill has no fee and no fee in the line.

```text
Mandate: last week's BTC ladder settled, net +$9.99 after fees. BTC is covered again.
Protected: BTC below $63,000 to Nov 27 (BTC2611272200): covered.
Spent: $42.00 on 6 orders, 2 signals for 0.02 USDC. Budget left $158.00.
Settled: BTC2611202200, 3 positions: cost $21.00, fees $1.01, paid $32.00, net +$9.99 (fees estimated).
Waiting for you: nothing.
```

A day with something waiting for the owner: one order was above the approval threshold, a call outside the routine was rejected, and the agent asked for a rule change.

```text
Mandate: 1 order and 1 rule change wait for your approval.
Protected: BTC below $63,000 to Nov 20 (BTC2611202200): covered, $52.50 of it waits for your approval.
Spent: $23.10 on 2 orders, 1 signal for 0.01 USDC. Budget left $176.90.
Blocked: 1 order over max trade size.
Waiting for you: intent #2 ($21.00); change request pcr_1, approval threshold to $25.00. https://console.example/approvals
```

## Grok Bot's own approvals, and why the mandate still matters

Grok Bot has Auto Review, which checks each action before it runs and shows an approval card when it decides the owner should confirm.
Owners can add **Ask first** and **Allow** rules.
Auto Review treats text from emails and web pages as not being the owner's request.
Source: https://docs.x.ai/grok-bot/approvals-security-and-privacy.md

Auto Review is a judgement made by a model inside the agent's own platform.
The mandate is a rule checked by a contract outside it.
The two are complementary: Auto Review reduces how often a confused Bot tries something, and the mandate guarantees the attempt fails if it does.
For the demo, the Mandate connector's tools should be set to run without an approval card, so that the onchain verdict is what the audience sees.

## Chat export for the bounty

The docs describe no export of a whole chat.
What exists:

- A Bot can be shared with **Share** then **Copy link**.
- Files in a message can be downloaded from the message's menu.
- Call transcripts can be exported, which applies to voice calls only.

Open question for the sponsor: which export format the Grok Bot bounty accepts.
Fallbacks: ask the Bot to write the full conversation to a file and download it, or capture the chat as a PDF.

## Verified by hand (issue #4)

Checked on 2026-11-15 against our server through a Cloudflare quick tunnel.

- The custom connector saves and lists our tools. The header value is entered once in the dialog.
- The tool list is read only when the connector is added. Clients `connectors-manager` and `grok-validator` call `initialize` and `tools/list` at that moment; a tool call later sends `initialize`, `notifications/initialized` and `tools/call`, never `tools/list`.
- After the server grew from 3 to 16 tools, the Bot kept seeing 3. Adding the connector again under the same URL did not help. Adding it under a changed URL (`/mcp?v=2`) with a smaller list (output schemas off, 17.5 kB instead of 61 kB) showed all 16. Which of the two changes fixed it is not isolated.
- Working rule: freeze the tool names and input schemas before the final connector is added, and after any change add the connector again under a new query string.
- Every tool call is a fresh MCP session, about 3 seconds apart. The Bot does not retry a failed call on its own.
- In chat, no approval card was shown for any of our tools, including `buy_signal`, `propose_trade`, `execute_plan` and `request_policy_change`.
- Results are shown to the Bot as the text summary plus the structured JSON. Results up to 4 kB and calls up to 9 seconds worked.
- Typing into the chat box through browser automation can drop spaces; the Bot still understood the message.

## Still to verify by hand

1. Whether Auto Review asks before a write tool on a scheduled or webhook run.
2. Tool result size limits and timeouts beyond what we have seen.
3. A webhook-triggered routine receives our JSON body (`mandate.wake`, [event-wake.md](event-wake.md)), and how the Bot sees it beside the instruction. The notifier is tested only against a local fake receiver.
4. The export method.
5. That a daily routine's result reaches the owner as a phone notification, and that Grok keeps the digest's shape (a first line of about 100 characters, then at most five short lines).
