# @mandate/agent

The remote MCP server Grok Bot connects to.
It is the agent's only way to act: every tool the agent can call lives here, and every trade goes through the Policy contract on Arc.

## Run it

All commands run from the repo root.

```sh
npm install
npm run mcp:token     # writes a new MCP_AUTH_TOKEN into .env (mode 600) without printing it
npm run dev:mcp       # starts the server on http://127.0.0.1:8787/mcp and restarts on changes
```

`npm run start:mcp` runs the server without the file watcher.
In another terminal, `npm run mcp:smoke` connects with the official MCP SDK client, lists the tools and calls the read-only ones, the same way Grok Bot does.
Pass a URL to test a remote server, for example `npm run mcp:smoke -- https://<name>.trycloudflare.com`.
Set `MCP_ERA=auto` to negotiate the 2026-07-28 protocol instead of the 2025 `initialize` handshake.

### End-to-end run

`npm run mcp:e2e` runs the whole agent flow against a real chain in one command, with nothing to configure and no `.env` read.
For each Policy contract it starts anvil with a fresh deployment and the demo rules, an in-memory console backend (`testing/fake-console.ts`), and the real server as a child process, each on a free port.
It then drives the server over HTTP with the official MCP SDK client, opening a new session for every call as Grok Bot does, against live public Gemini market data.
The run covers setup and pairing, the read tools, `plan_hedge` and `execute_plan`, `simulate_trade`, the three demo cases (a $10 trade approved, a $30 trade blocked with `over max trade size`, a $22 trade waiting for the owner), a retried proposal, the stored decision contexts and each intent's link to its context in the console, `get_intent`, `get_activity` and `request_policy_change`.
It also checks that no key or token reaches the server's logs.
Pass `-- --contract production` or `-- --contract reference` to run one contract; the default runs both.
On the reference contract, `simulate_trade` must use `previewTrade` and every proposal must record its context hash onchain.
It needs Foundry (`forge` and `anvil`) and network access to Gemini's public API.

The server reads `.env` from the repo root, or the file named by `ENV_FILE`.
Variables already set in the environment win over the file.

### Connect Grok Bot

Grok's servers call the MCP server over the public internet, so a server on a laptop needs a tunnel.

1. Start the server with `npm run dev:mcp`.
2. In a second terminal, run `npm run dev:tunnel`.
   It starts a Cloudflare quick tunnel, waits until the public URL answers `/health`, and prints the values for the connector.
   If `cloudflared` is missing it says how to install it (`brew install cloudflared` on macOS).
3. In Grok Bot (the web client at grok.com/bot or the desktop app), open **Connect apps**, choose **Add a custom connector**, and enter:
   - **Name**: `Mandate`
   - **Type**: `Remote HTTPS`
   - **Server URL**: the printed URL, ending in `/mcp`
   - **HTTP header**: name `Authorization`, value `Bearer ` followed by the token
   - **OAuth Client ID**: leave empty
4. Read the token on the server machine with `grep '^MCP_AUTH_TOKEN=' .env` and paste it only into that dialog, never into a chat.

The quick tunnel URL changes every time the tunnel restarts, so update the connector's Server URL when it does.

## Transport

The server speaks Streamable HTTP only, statelessly, and always answers with a single JSON body.
It never opens a server-to-client stream and never issues an `Mcp-Session-Id`.

Why: Cloudflare quick tunnels do not support the SSE transport, and any buffering proxy can hold back a streamed response.
A stateless JSON exchange is one ordinary HTTP request and response, so it survives proxies, restarts and retries, and needs no sticky routing.

How, with `@modelcontextprotocol/server` v2 (the current stable SDK line; `@modelcontextprotocol/sdk` 1.x is in maintenance):

- Clients on the 2026-07-28 protocol go to the SDK's `createMcpHandler` with `responseMode: 'json'`.
- Clients on a 2025 protocol revision (they open with `initialize`) go to a fresh `WebStandardStreamableHTTPServerTransport` per request with `enableJsonResponse: true`.
  The SDK's built-in legacy path would answer them with a one-shot SSE stream, so `src/mcp/server.ts` routes them with the SDK's `isLegacyRequest` instead.
- `GET` and `DELETE` on `/mcp` answer `405`, which the spec allows for a server without streams or sessions.

The cost is that tools cannot send progress or log notifications mid-call; the SDK drops them and prints a one-line notice about it at startup.
Tools return everything in their result instead.

The HTTP layer is [Hono](https://hono.dev) on `@hono/node-server`, because the SDK handler is a web-standard `(Request) => Response` function that Hono passes through without adapters.

## Endpoints

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /mcp` | Bearer token | MCP requests |
| `GET`/`DELETE /mcp` | Bearer token | `405`: no streams, no sessions |
| `GET /health` | none | `{status, name, version}`, nothing else |
| anything else | none | `404` |

## Authentication and safety

- **Bearer token.** Every `/mcp` request must carry `Authorization: Bearer <MCP_AUTH_TOKEN>`.
  The token is compared in constant time.
  A missing or wrong token gets `401` with `WWW-Authenticate: Bearer` and no detail.
  There is no OAuth.
- **Startup checks.** The server refuses to start if `MCP_AUTH_TOKEN` is unset or shorter than 32 characters, or if a registered tool requires a variable that is not set.
  Error messages name the variable, never its value.
- **Rotation.** `npm run mcp:token` replaces only the `MCP_AUTH_TOKEN` line in `.env` and keeps every other line.
  Restart the server, then update the connector header; the old token stops working at the restart.
- **Origin check.** Browsers always send `Origin`, so a request from a web page on another site gets `403`, which defends against DNS rebinding as the MCP spec requires.
  Localhost origins are allowed, and `MCP_ALLOWED_ORIGINS` adds more hostnames.
  Non-browser clients such as Grok's servers send no `Origin` and are unaffected.
- **Limits.** Bodies over 256 KiB get `413`.
  Each token has an in-memory token bucket of tool calls (burst 60, 1 call per second sustained), and failed authentication attempts share a stricter bucket; both answer `429` with `Retry-After`.
  Only `tools/call` requests count, because a stateless client spends three or four protocol requests on the handshake before every call.
  Each tool call has a time budget (20 s by default, `timeoutMs` per tool), after which its abort signal fires and the call returns `TIMEOUT`.
- **Secrets.** Tokens, the agent key and the RPC URL (hosted RPC URLs embed an API key) are wrapped in `Secret`, which renders as `[redacted]` in `String()`, templates, `JSON.stringify` and `util.inspect`.
  Read the value only with `.reveal()` at the point of use.
  `whoami` returns the agent's address, never its key.
- **Shutdown.** `SIGINT` and `SIGTERM` stop accepting connections, abort in-flight MCP exchanges, and exit, with a 10 s limit.

## Configuration

| Variable | Default | Needed for |
| --- | --- | --- |
| `MCP_AUTH_TOKEN` | none, required | every request |
| `MCP_PORT` | `8787` | |
| `MCP_HOST` | `127.0.0.1` | keep it when the tunnel runs on the same machine |
| `MCP_ALLOWED_ORIGINS` | empty | browser clients other than localhost (comma-separated hostnames) |
| `MCP_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |
| `ARC_RPC_URL` | `https://rpc.testnet.arc.io` | policy reads and trades |
| `POLICY_ADDRESS` | unset | policy reads and trades |
| `AGENT_PRIVATE_KEY` | unset | trades |
| `POLICY_DEPLOY_BLOCK` | unset | rejection reasons in `get_intent` and `get_activity` (scans the last 200,000 blocks when unset) |
| `CONSOLE_URL` | `http://localhost:3000` | holdings, pairing, plans, decision contexts, intent links, change requests and signal payment reports |
| `CONSOLE_SERVICE_TOKEN` | unset | holdings, pairing, plans, decision contexts, intent links, change requests and signal payment reports |
| `SIGNALS_URL` | `http://localhost:4021` | buying signals |
| `X402_BUYER_PRIVATE_KEY` | unset | buying signals (pays from its Circle Gateway balance) |
| `SIGNAL_DAILY_BUDGET_USDC` | `0.02` | buying signals: most spent per UTC day |
| `SIGNAL_MAX_PRICE_USDC` | `0.005` | buying signals: most paid for one signal |
| `AGENT_DATA_DIR` | `.data/agent` | spend ledger and purchased signals (git-ignored) |

Only `MCP_AUTH_TOKEN` is always required.
`POLICY_ADDRESS`, `AGENT_PRIVATE_KEY` and `CONSOLE_SERVICE_TOKEN` are required only when a registered tool lists them in `requires`, so a partly configured server still starts and `get_setup_state` tells the owner what is missing.
The repo-wide list is in [docs/configuration.md](../docs/configuration.md).

## Tools

Grok Bot is told the order of work in `src/instructions.ts`; every result carries a `nextAction` that names who acts next.

| Tool | What it does |
| --- | --- |
| `get_setup_state` | Each setup step with the actor who must do it and a hint: key, contract, console link, chain, agent role, gas, rules, pause switch, pairing, holdings. |
| `request_pairing` | Asks the console to pair this agent and returns the claim link for the owner. |
| `get_policy` | The owner's rules, today's usage and the headroom left, plus which contract extensions exist. |
| `get_portfolio` | The holdings the owner entered in the console, valued at Gemini spot. |
| `list_markets` | Open Gemini events in the categories the mandate allows, by volume. |
| `get_ladder` | One asset's strike ladder for a horizon, the rungs nearest spot first. |
| `plan_hedge` | A hedge plan of NO buys for a holding and a drop, with payoffs and the verdict each order is expected to get; the plan is kept in the server and posted to the console. |
| `simulate_trade` | The verdict a trade would get, from the contract's `previewTrade` when it has one and the server's copy of the rules otherwise, naming the rule. |
| `propose_trade` | Proposes one trade with its decision context; the contract approves, rejects with a reason, or holds it for the owner. Safe to retry. |
| `execute_plan` | Proposes a plan's orders in order, stops at the first rejection, and reports each rung. Safe to retry and resumable. |
| `get_intent` | One intent's status, reason, fill and decision context, checked against its hash. |
| `get_activity` | The latest intents, newest first, with waiting and rejected older ones flagged. |
| `buy_signal` | Pays the signal API a fraction of a cent for a per-strike cheap, fair or expensive verdict, inside a daily budget; returns a `receiptId` that `plan_hedge` accepts. |
| `request_policy_change` | Files a rule change with a reason for the owner to decide in the console; it can never touch the pause switch. |
| `ping`, `whoami` | Liveness and the agent's address. |

Amounts are integer cents, prices are 1 to 99 cents, `market` is a Gemini instrument symbol, and hedges buy NO.
The category of a market is derived from Gemini, never taken from the agent.

The agent key can only propose: no code path calls an owner or executor function, and `test/no-owner-calls.test.ts` proves it structurally.

### Where state lives

Grok Bot opens a fresh MCP session for every call, so state that spans calls lives in the server process.
Plans stay executable for 30 minutes and are kept for 6 hours.
Identical proposals within 10 minutes return the first result instead of trading twice.
Both are lost on restart; the console keeps the plans and decision contexts it received.

### Decision contexts

Every proposal carries a decision-context document (the request, the reasons, the market data and the plan it came from), stored in the console under its keccak256 hash.
When the contract has the 7-argument `proposeTrade`, the hash is also recorded onchain and the result says `contextHashRecorded: true`.
On the production contract the result says `contextHashRecorded: false` and the document lives only offchain.
If the console is down, documents wait in an in-process outbox and are sent with later proposals.

Once the proposal transaction is confirmed and the intent id is known, the server links the intent to its document in the console (`PUT /api/agent/v1/intents/<intentId>/context` with the hash and the proposal transaction), for every single trade and every order of a plan.
Without this link the console cannot show why the agent acted on the production contract, where no event carries the hash.
Linking is best effort and never changes or delays a verdict beyond a short bound: each attempt has a 3 s timeout, an unanswered attempt is retried once, and the result says `contextLinked: true` when the console has the link, `false` when it does not (yet), and `null` without a console.
A link the console could not take waits in an in-process outbox and is sent with the next proposal, or when the same `propose_trade` or `execute_plan` call is retried.
During `execute_plan`, once one link fails the remaining orders only queue theirs, so a console outage costs one bounded wait per call.
A 409 `conflict` (the intent is already linked to another document) is final: it is logged as an error and not retried.

## Buying signals

`buy_signal` pays the signal API (`signals/`) a fraction of a cent from the buyer's Circle Gateway balance for a hedge signal on one Gemini ladder, and returns a compact signal plus its `receiptId`, the nonce of the payment authorization.
In order, it:

1. stops without contacting anyone if today's budget is used up;
2. asks the signal API without paying, which answers with its price or refuses for free (unknown asset, no such ladder, market data down);
3. refuses a price above `SIGNAL_MAX_PRICE_USDC`;
4. reserves the price in the spend ledger, or stops if it would go over `SIGNAL_DAILY_BUDGET_USDC`;
5. pays with that price as a hard cap, which `X402Buyer` checks before it signs;
6. records the amount paid and stores the signal under its receipt id.

An exhausted budget, a price above the maximum, a seller refusal and a Gateway rejection are verdicts (`rejected` or `unavailable` with a reason and `nextAction`), not errors.
The spend ledger (`<AGENT_DATA_DIR>/signal-spend.jsonl`) is an append-only file written with `fsync`, so the budget survives a restart; a payment whose outcome is unknown stays counted against the budget.
Purchased signals live in `<AGENT_DATA_DIR>/signals/<receiptId>.json`, so a later tool call in a fresh session can use a signal by receipt id: `services.payments.purchasedSignal(receiptId)` returns `{ receiptId, signal }` ready for the planner's `signal` input.
The server never deposits into Gateway.

### Payment reports to the console

The console shows what the agent bought, for how much, when and with which settlement reference, plus today's budget use and the Gateway balance (issue #22).
The server reports this best effort through two routes in `@mandate/shared` `console-api.ts`:

- `PUT /api/agent/v1/signal-payments/<receiptId>` records one payment, right after a successful `buy_signal`; the console keeps the first write for a receipt id.
- `PUT /api/agent/v1/signal-budget` replaces the budget snapshot (daily budget, spent today, maximum price, reset time, Gateway balance when it can be read, buyer address); it is sent when the server starts and after each purchase.

`buy_signal` answers `paymentRecorded: true` when the console has the payment, `false` when it does not yet, and `null` when nothing was paid or no console is configured; the purchase result never depends on it.
Each request has a 3 s timeout and one retry, and the balance read is bounded the same way.
The spend ledger is the outbox: on start, and every minute while something is pending, the server sends every paid entry the console has not confirmed in this process, and the console's idempotency keeps that free of duplicates.
A console that does not serve these routes yet answers 404, which counts as "not recorded yet" and is logged at debug level only.
Only public data is sent: amounts in USDC atomic units, times, addresses, the receipt id (the payment nonce), Gateway's settlement reference and a summary of the signal; never a key or the payment signature.

`ENV_FILE=/path/to/.env npm run signal:e2e` runs the whole flow once on Arc testnet: it starts the signal API and this server on free ports, calls `buy_signal` with the SDK client over HTTP, plans a hedge with and without the signal, and looks the payment up in Gateway's transfer history.
It spends the signal price (0.001 USDC by default) per run and keeps its data in `.data/signal-e2e`.

## Layout

```
src/
  main.ts            entry point: env, config, listen, signals
  app.ts             wires config, services, tools and HTTP; no port
  config.ts          every env variable, parsed once with zod
  secret.ts          Secret wrapper
  logger.ts          JSON-lines logger with redaction
  context.ts         AppContext and ToolContext (config, logger, clock, services)
  services.ts        service interfaces and createServices
  instructions.ts    the operating brief sent at initialize
  capabilities.ts    which features the configuration supports
  http/              Hono app, bearer auth, rate limiter
  mcp/               tool framework, verdict envelope, untrusted text, MCP endpoint
  tools/             one file per tool, plus index.ts, the registry
  chain/             the agent's view of the Policy contract and the event index
  console/           HTTP client for the console's agent API, signal payment reports
  markets/           Gemini market data and symbol resolution
  planning/          the hedge planner
  trading/           proposals and decision contexts
  state/             in-process plan store and proposal ledger
  support/           failure mapping, rule explanations, formatting
  x402/              x402 buyer, signal payments, spend ledger, purchased-signal store
scripts/             mcp:token, dev:tunnel, mcp:smoke, mcp:e2e, x402:*, signal:e2e
testing/             in-memory console backend for tests and mcp:e2e
test/                Vitest, offline except chain.test.ts, which starts anvil
```

## Add a tool

1. Create `src/tools/<tool-name>.ts`:

   ```ts
   import * as z from "zod";
   import { reason, summarizeVerdict, unavailable, verdictSchema, ok } from "../mcp/envelope";
   import { defineTool } from "../mcp/tool";

   export const getPolicy = defineTool({
     name: "get_policy",
     title: "Read the mandate",
     description: "Returns the rules the owner set, what has been used today, and the headroom left.",
     inputSchema: z.object({}),
     outputSchema: verdictSchema({ dailyLimitUsdc: z.number().nullable() }),
     annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
     handler: async (_input, ctx) => {
       if (ctx.policy === undefined) {
         const v = unavailable([reason("NOT_CONFIGURED", "No Policy contract is configured.")], {
           actor: "owner",
           hint: "Set POLICY_ADDRESS and ARC_RPC_URL in the server's .env file.",
         });
         return { structured: { ...v, dailyLimitUsdc: null }, summary: summarizeVerdict(v) };
       }
       // ...read through ctx.policy, passing ctx.signal to any network call
       const v = ok();
       return { structured: { ...v, dailyLimitUsdc: 500 }, summary: "Daily limit 500 USDC, 120 used." };
     },
   });
   ```

2. Add one import and one entry to `src/tools/index.ts`, keeping both lists alphabetical.
3. If the tool needs a new service, extend its interface in `src/services.ts` and build it in `createServices`.
4. Add `test/tools/<tool-name>.test.ts` that calls `getPolicy.run(input, fakeContext)` with fake services (see `test/tools.test.ts`), plus a round trip through `connectClient` in `test/helpers.ts` if the wire shape matters.
5. Run `npm run check`.

Rules every tool follows:

- **Names and descriptions** are snake_case verbs and full sentences: Grok Bot sees tools through a meta-tool, so the description is all the model knows.
- **Input** is a zod object; the framework validates it and answers bad input with `INVALID_INPUT` and the failing fields, never the values.
- **Output** returns `structured` (validated against `outputSchema`, which must not use transforms) and a one- or two-sentence `summary`.
  Keep both small: no raw upstream payloads.
- **A denial is a verdict, not an error.** Tools that act or check return the envelope from `src/mcp/envelope.ts`: `{status: approved | rejected | held | ok | unavailable, reasons: [{code, message}], nextAction?: {actor: agent | owner, hint}}`.
- **Real errors** (bad input, upstream down, timeouts, bugs) are thrown as `ToolError` with a stable code from `src/mcp/errors.ts`; the model sees `CODE: message`.
  Anything else thrown becomes `INTERNAL` with the request id, and the details go to the log, scrubbed.
- **Third-party text** (market titles, descriptions) goes into results only through `untrusted(text, source)`, which labels it `{untrusted: true, source, text}`.
  Never put it in a summary or anywhere the model reads as guidance; refer to the item by id or ticker instead.
- **Requirements.** List env variables the tool cannot work without in `requires`; the server then refuses to start without them.
  Leave them out if the tool should answer `unavailable` instead.

## Logging

Logs are JSON lines on stdout: `http.request` (request id, method, path, status, duration) and `tool.call` (request id, tool, outcome, verdict status, error code, duration, argument keys and size).
The Authorization header, tokens, keys and argument values are never logged.
As a second line of defence, fields with sensitive names, 32-byte hex strings and URL paths are redacted.

## Tests

`npm test` from the repo root runs the suite offline.
It covers auth, health, routing and limits, a full MCP round trip with the SDK client in both protocol eras, tool failures and timeouts, the verdict and untrusted-text helpers, secret redaction, config validation, and the token script on a temporary `.env`.
Each tool has contract tests against fake services in `test/tools/`, `test/mcp-tools.test.ts` runs the whole flow over MCP with a new session per call, and `test/chain.test.ts` proposes on both contracts on a local anvil.
