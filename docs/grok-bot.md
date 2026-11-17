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
Examples: the price crosses the protection floor, a hedge rung settles, or the owner changes the mandate.
The webhook URL and key are secrets and belong in `.env`.

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
3. A webhook-triggered routine receives our JSON body.
4. The export method.
