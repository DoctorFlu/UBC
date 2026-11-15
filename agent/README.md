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
In another terminal, `npm run mcp:smoke` connects with the official MCP SDK client, lists the tools and calls each one, the same way Grok Bot does.
Pass a URL to test a remote server, for example `npm run mcp:smoke -- https://<name>.trycloudflare.com`.
Set `MCP_ERA=auto` to negotiate the 2026-07-28 protocol instead of the 2025 `initialize` handshake.

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
  Each token has an in-memory token bucket (burst 60, 1 request per second sustained), and failed authentication attempts share a stricter bucket; both answer `429` with `Retry-After`.
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
| `CONSOLE_URL` | `http://localhost:3000` | holdings and change requests |
| `CONSOLE_SERVICE_TOKEN` | unset | holdings and change requests |
| `SIGNALS_URL` | `http://localhost:4021` | buying signals |
| `X402_BUYER_PRIVATE_KEY` | unset | buying signals (pays from its Circle Gateway balance) |
| `SIGNAL_DAILY_BUDGET_USDC` | `0.02` | buying signals: most spent per UTC day |
| `SIGNAL_MAX_PRICE_USDC` | `0.005` | buying signals: most paid for one signal |
| `AGENT_DATA_DIR` | `.data/agent` | spend ledger and purchased signals (git-ignored) |

Only `MCP_AUTH_TOKEN` is always required.
`POLICY_ADDRESS`, `AGENT_PRIVATE_KEY` and `CONSOLE_SERVICE_TOKEN` are required only when a registered tool lists them in `requires`, so a partly configured server still starts and `get_setup_state` tells the owner what is missing.
The repo-wide list is in [docs/configuration.md](../docs/configuration.md).

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
  services.ts        service interfaces later issues implement
  instructions.ts    the operating brief sent at initialize
  capabilities.ts    which features the configuration supports
  http/              Hono app, bearer auth, rate limiter
  mcp/               tool framework, verdict envelope, untrusted text, MCP endpoint
  tools/             one file per tool, plus index.ts, the registry
  x402/              x402 buyer, signal payments, spend ledger, purchased-signal store
scripts/             mcp:token, dev:tunnel, mcp:smoke, x402:*, signal:e2e
test/                Vitest, offline
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
