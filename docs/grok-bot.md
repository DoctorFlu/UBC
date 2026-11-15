# Grok Bot integration notes

Status: documentation read on 2026-11-15 from docs.x.ai.
The hands-on connection test is still open (issue #4) because it needs the Grok Bot desktop app.

## What Grok Bot is

Grok Bot is xAI's agent product: Bots that work on a shared cloud computer and keep running while your laptop is closed.
It is used through a desktop app (macOS, Windows, Linux) and a mobile app.
There is no web client.
Premium, Super and Ultra plans on The X Subscription include it.
Source: https://docs.x.ai/grok-bot/get-started.md and https://docs.x.ai/x-subscription/grok-bot.md

## How it connects to our MCP server

In the desktop app, open **Connect apps** and choose **Add a custom connector** at the bottom.
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

We ship the text of our skill in the repo (issue #12) and ask the Bot to save it.

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

## Still to verify by hand (issue #4)

1. The custom connector saves and lists our tools.
2. A tool call reaches the server through the tunnel, and how it is shown in chat.
3. Whether Auto Review asks before calling our tools, and how to allow them.
4. Tool result size limits and timeouts.
5. A webhook-triggered routine receives our JSON body.
6. The export method.
