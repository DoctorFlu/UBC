# Mandate

Mandate lets an AI agent hedge your crypto holding on Gemini's prediction markets inside rules you set once in a Policy contract.
The agent, Grok Bot, plans the hedge, pays a fraction of a cent for a pricing signal, and proposes each order to the contract.
The contract approves the order, holds it for your approval, or rejects it with the rule that stopped it, and the agent's key cannot do anything else.

Built for the UBC 2026 Hackathon: track **Agentic Payments & AI**, **Best use of Arc**, and the **Gemini Prediction Markets**, **Grok Bot** and **QuickNode Streams** bounties.

![The owner's console](dashboard/docs/screenshots/home-1440-light.png)

## Hosted demo

- Console: https://8080-agq6mxapjuxoy3aavoouae6yri.instabox.tech
- Landing page: https://8081-agq6mxapjuxoy3aavoouae6yri.instabox.tech

The hosted demo runs the demo chain in gateway mode, as described in [docs/hosting.md](docs/hosting.md#instabox).
The console asks for a passkey sign-in; a workspace there is opened with a code from the operator ([docs/accounts.md](docs/accounts.md#sign-in)).

<!-- #96 (members, roles and hosted sign-up): when it is merged, say here how a visitor signs up on the hosted demo. -->

## How it fits together

```mermaid
flowchart LR
    Owner([Owner])
    Grok["Grok Bot<br/>chat or routine"]
    Console["Console<br/>dashboard/"]
    MCP["MCP server<br/>agent/"]
    Signals["Signal API<br/>signals/"]
    Executor["Executor<br/>devchain/"]
    Policy[("Policy contract<br/>chain id 5042002")]
    Gemini["Gemini<br/>Prediction Markets"]
    Gateway["Circle Gateway<br/>x402 on Arc testnet"]
    Streams["QuickNode Stream<br/>designed, not active"]

    Owner -- "rules and approvals" --> Console
    Console -- "owner transactions" --> Policy
    Owner -- "chat" --> Grok
    Console -- "wake-up webhook" --> Grok
    Grok -- "MCP tools, agent token" --> MCP
    MCP -- "proposeTrade, agent key" --> Policy
    MCP -- "holdings, plans, sealed reasons" --> Console
    MCP -- "market data" --> Gemini
    MCP -- "buys a signal" --> Signals
    Signals -- "verifies and settles the payment" --> Gateway
    Signals -- "ladder prices" --> Gemini
    Executor -- "reads approved intents, records results" --> Policy
    Executor -- "places orders" --> Gemini
    Executor -- "order journal, settlements" --> Console
    Policy -- "events, RPC poll today" --> Console
    Policy -. "Logs dataset" .-> Streams
    Streams -. "signed webhook" .-> Console
```

The agent talks only to the MCP server, the MCP server can only propose, and nothing reaches Gemini without the contract's approval.
The dotted edges are the QuickNode Stream, which is built and tested but not yet switched on (see [What is real and what is simulated](#what-is-real-and-what-is-simulated)).

| Folder | What it is |
| --- | --- |
| `contracts/` | The Policy contract (Solidity, Foundry). |
| `agent/` | The remote MCP server Grok Bot connects to: the agent's only way to act. Its Grok Bot skill and routine are in `agent/grok/`. |
| `planner/` | The hedge planner: turns a holding and a price floor into a ladder of orders, and measures the cover already held. |
| `gemini/` | Clients for Gemini's public prediction-market data and, for the executor only, its signed order API. |
| `signals/` | The paid signal API (x402, Circle Gateway on Arc testnet). |
| `streams/` | The QuickNode Stream: filter, configuration, management script, payload parser. |
| `dashboard/` | The owner's console (Next.js). |
| `site/` | The public landing page. |
| `brand/` | Design tokens and the two self-hosted fonts, shared by every web app. |
| `devchain/` | A local chain with Arc's chain id, the executor, and `npm run dev:stack`. |
| `redteam/` | A scripted adversary that attacks the mandate through the MCP server and with the agent key. |
| `shared/` | Types, the contract ABI, the TypeScript copy of the rules, and the API contracts between services. |
| `deploy/` | Docker Compose and Caddy files for the hosted demo. |
| `docs/` | Design notes and verified findings for each integration (see [Docs map](#docs-map)). |

## The life of one hedge

The owner has entered a holding in the console, for example 0.05 BTC, and saved a Grok Bot routine with a standing goal such as "keep it protected below $60,000, spending at most $50 per plan".

1. **Wake-up.**
   The routine runs every hour, and also when the console posts a `mandate.wake` event to its webhook, for example when the spot price falls below the goal's floor.
   [agent/grok/routine.md](agent/grok/routine.md), [docs/event-wake.md](docs/event-wake.md), [docs/grok-bot.md](docs/grok-bot.md#routines)
2. **Read the state.**
   The Bot calls `get_setup_state`, `get_policy` and `get_activity` on the MCP server: whether setup is complete, the rules and today's usage from the contract, and what happened since the last run.
   [agent/README.md](agent/README.md)
3. **Plan, and check the cover.**
   `plan_hedge` sizes NO orders on the nearest Gemini ladder between the floor and the current price.
   The server first counts the protection already held on that ladder, so a goal that is already met answers `ALREADY_COVERED` and nothing is bought.
   [docs/cover.md](docs/cover.md)
4. **Buy a signal.**
   `buy_signal` pays the signal API $0.001 in USDC over x402 for a cheap, fair or expensive rating of each strike, and the Bot plans again with the signal's receipt.
   [docs/x402.md](docs/x402.md#hedge-signal-issue-20-and-buy_signal-issue-21)
5. **Propose.**
   `execute_plan` re-reads the cover before each order and proposes it to the Policy contract with the agent key and the hash of a sealed reason (the request, the prices seen, the signal and the plan).
   The contract answers each proposal with a verdict: approved, held for the owner, or rejected with its rule.
   [docs/order-lifecycle.md](docs/order-lifecycle.md#1-proposal-and-verdict), [docs/contract-interface.md](docs/contract-interface.md)
6. **The owner decides what is held.**
   An order above the approval threshold waits in the console's Approvals page until the owner approves or rejects it with their wallet.
   <!-- #95 (several mandates with passkey approvals): when it is merged, say here how an approval is signed. -->
   [docs/order-lifecycle.md](docs/order-lifecycle.md#1-proposal-and-verdict)
7. **The console follows the chain.**
   The console stores every Policy event and builds the activity feed, approvals and audit trail from them.
   [docs/quicknode-streams.md](docs/quicknode-streams.md)
8. **Fill.**
   The executor sees the approval, refuses any intent the venue could not trade, places the order, and records the fill onchain with `recordResult`.
   On Gemini, the order is sized so its cost and Gemini's fee fit the approved amount.
   [docs/order-lifecycle.md](docs/order-lifecycle.md#2-fill), [docs/gemini-venue.md](docs/gemini-venue.md#what-the-executor-does-with-an-approved-intent)
9. **Settlement.**
   When the ladder expires, the executor waits for Gemini to publish the outcome, then signs a settlement (cost, fee, payout, net) and stores it in the console.
   The console wakes the routine once for the settled ladder, and the Bot reports what it cost and paid, then plans on the next ladder.
   [docs/order-lifecycle.md](docs/order-lifecycle.md#4-settlement)

![An intent in the console](dashboard/docs/screenshots/intent-1440-light.png)

## What is real and what is simulated

| Piece | State today |
| --- | --- |
| Policy contract | The real contract from `contracts/`, on a local anvil chain that uses Arc testnet's chain id (5042002), both locally and on the hosted demo. No Arc testnet deployment is recorded yet ([docs/contract-interface.md](docs/contract-interface.md), section 4); moving to one is configuration only ([docs/configuration.md](docs/configuration.md#chain)). |
| Order placement | Simulated by default: the executor checks each approved intent against Gemini's listing, records a fill marked "Simulated fill", and places no order. With `EXECUTOR_VENUE=gemini` it places orders on Gemini's sandbox, with test funds. |
| Gemini sandbox run | Measured on 17 November 2026 ([docs/gemini-venue.md](docs/gemini-venue.md#what-a-sandbox-demo-can-show)): $9.73 approved at 97c, 10 contracts placed and filled at 0.97, a fee of $0.03 equal to the estimate, and at expiry a payout of $10.00, net +$0.27 after fees, matching the sandbox balance to the cent. |
| Gemini market data | Gemini's public endpoints, read only. |
| x402 signal payments | Arc testnet with testnet USDC through Circle Gateway. A paid run on 15 November 2026 bought one signal for 0.001 USDC, settled in batch transaction [`0xa99bcd21...41e5ec12b`](https://explorer.testnet.arc.io/tx/0xa99bcd21ab5a60c3749c1c9fcb743768e6cffb5513a3dd7d3ab87d541e5ec12b) ([docs/x402.md](docs/x402.md#a-paid-run-of-the-hedge-signal)). |
| QuickNode Stream | The filter, configuration, management script and signed webhook receiver are in the repository and tested; no Stream has been created or activated yet ([docs/quicknode-streams.md](docs/quicknode-streams.md)). The console reads Policy events by RPC poll today, and a Stream cannot see the local chain. |
| Grok Bot | A real Grok Bot plans and proposes through the connector ([docs/grok-bot.md](docs/grok-bot.md#verified-by-hand-issue-4)). |
| Console sign-in | Passkeys (WebAuthn) for each workspace member ([docs/accounts.md](docs/accounts.md)). |

## Safety model

- **Rules onchain.**
  The Policy contract checks every proposal against a total budget, a maximum trade size, an approval threshold, a daily loss limit, the allowed categories and a pause switch.
  The demo rules are a $200 budget, $25 per trade, approval above $20, a $40 daily loss limit and Crypto only (`DEMO_POLICY` in `devchain/src/deploy.ts`).
- **Three keys.**
  The owner sets rules and approves, the agent only proposes, and the executor only places approved orders and records results.
  No MCP tool calls an owner or executor function, and `agent/test/no-owner-calls.test.ts` proves it from the source.
- **The server computes cover.**
  The MCP server counts the protection already held and re-checks it before each order, so repeated or overlapping runs do not buy the same protection twice ([docs/cover.md](docs/cover.md)).
- **Held versus rejected.**
  An order above the approval threshold is held until the owner decides; an order that breaks a rule is rejected, with the rule recorded onchain, and the agent is told never to work around it.
- **Passkeys.**
  Console members sign in with passkeys; owner actions on the contract are signed with the owner's wallet ([docs/accounts.md](docs/accounts.md)).
  <!-- #95: when passkey approvals are merged, say here what a passkey signs. -->
- **A token per agent.**
  Each agent reaches the MCP server with its own bearer token, which acts on that agent's mandate only, is stored as a hash, and can be revoked in the console ([docs/accounts.md](docs/accounts.md#how-each-request-is-scoped)).
  <!-- #95: several mandates per workspace, each with its own agent and tokens. -->
- **A second layer in the MCP server.**
  The market category comes from Gemini, never from the agent; a repeated proposal within 10 minutes returns the first result (`agent/src/state/ledger.ts`); a plan can be executed for 30 minutes (`agent/src/state/plans.ts`); signal spend is capped at 0.02 USDC a day and 0.005 USDC a purchase by default ([docs/configuration.md](docs/configuration.md#x402-signal-api-circle-nanopayments-on-arc-testnet)); third-party text is marked untrusted.
- **The executor checks again.**
  It refuses any approved intent the MCP server could not have sent (not a Gemini symbol, a limit outside 1 to 99, a category Gemini disagrees with), and places one order per intent at most ([docs/gemini-venue.md](docs/gemini-venue.md#safety-rules)).
- **Red team.**
  `npm run redteam` attacks the mandate through the MCP server and with a stolen agent key.
  Against the `production` contract it ran 46 attacks: 39 held, 7 bounded, 0 breaches ([redteam/REPORT.md](redteam/REPORT.md)).
  The bounded ones are listed there with their limits: for example, splitting an order gets past the per-order rules but not the budget.

## How the sponsor technologies are used

**Arc.**
The Policy contract is written for Arc, where gas is paid in USDC ([docs/contract-interface.md](docs/contract-interface.md)), and the local and hosted demo chains use Arc testnet's chain id, 5042002.
The x402 payments for signals settle on Arc testnet, and the QuickNode Stream is configured for Arc testnet.

**Circle Gateway and x402.**
The agent pays for each signal it uses: the signal API answers `402 Payment Required`, the MCP server signs a USDC transfer authorization offchain, and Circle Gateway verifies it and settles many payments later in one batch transaction on Arc testnet.
The spend is capped by a daily budget and a price cap per purchase on the MCP server, a hard cap per request in the payment client, and the buyer's Gateway balance, which the server never tops up.
Each payment's receipt id is part of the sealed reason of the orders it informed ([docs/x402.md](docs/x402.md)).

**QuickNode Streams.**
The Stream is designed as the console's source of Policy events on **Arc testnet** (network `arc-testnet`) with the **Logs** dataset.
Its **filter**, [streams/filter.js](streams/filter.js), runs on QuickNode's side and keeps only the Policy contract's logs.
Its **destination** is the console's webhook, `/api/webhooks/quicknode`, which verifies the `X-QN-Signature` HMAC, refuses stale deliveries, and stores each event once by transaction hash and log index.
It is core because the activity feed, the approval queue, the audit trail, the scorecard and the Bot's wake-ups are all built from these events, and the Stream and the RPC poller end in the same function ([docs/event-wake.md](docs/event-wake.md)).
No Stream is active yet; [streams/scripts/quicknode-stream.ts](streams/scripts/quicknode-stream.ts) creates, pauses and prices it, and [docs/quicknode-streams.md](docs/quicknode-streams.md) has the design and the credit budget.

**Gemini.**
Gemini's public prediction-market data gives the ladders the planner sizes, each market's category, and the prices the signal rates.
The executor places approved orders through Gemini's signed order API on the sandbox, never on production from the demo setup, and settles each position from the outcome Gemini publishes ([docs/gemini-venue.md](docs/gemini-venue.md)).

**Grok.**
Grok Bot is the agent: it connects to the MCP server as a custom connector and uses its tools to read the mandate, plan a hedge, pay for a signal and propose orders, in a chat with the owner or in a scheduled or webhook-started routine.
It holds no keys and has no direct access to Gemini or the contract, so the contract judges everything it does.
The instruction text, the skill and the routine are in `agent/grok/` ([docs/grok-bot.md](docs/grok-bot.md)).

## Run it locally

You need Node.js 22 or newer and git.
Foundry (anvil and forge) is installed from npm with the other dependencies.

```sh
git clone https://github.com/DoctorFlu/UBC.git
cd UBC
npm ci                 # use ci, not install: it keeps the lockfile's native bindings intact
npm run mcp:token      # writes MCP_AUTH_TOKEN into .env without printing it
npm run x402:keygen    # writes the signal buyer and seller keys into .env, prints only addresses
npm run dev:stack      # chain, signal API, console, MCP server, executor and landing page
```

These commands were run on a clean clone on 17 November 2026 (macOS on Apple silicon, Node.js 26.13.1, npm 11.20.0).
The stack uses ports 3000 (console), 3001 (landing page), 8545 (chain), 8787 (MCP server) and 8788 (signal API), and stops if one is taken.
It deploys the Policy contract with the demo rules on a local chain with Arc's chain id, and the executor is simulated.
When it is ready it prints a one-time claim code.

1. Open http://localhost:3000/claim, enter the code and your name, and make a passkey.
   Save the recovery code it shows.
   The owner signs contract transactions with a built-in test wallet, so no browser wallet is needed.
2. In the console, open **Hedge** and enter a holding, for example 0.05 BTC.
3. Optional: to let the agent buy signals, fund the buyer address that `x402:keygen` printed with Arc testnet USDC at https://faucet.circle.com, then, with the stack running, run `npm run x402:hello` once to deposit 1 USDC into Circle Gateway.
   Without this step the agent plans without a signal.
4. In a second terminal, run `npm run dev:tunnel`; it prints a public HTTPS address for the MCP server.
5. In Grok Bot, open **Connect apps** and add a custom connector with that address ending in `/mcp` and an `Authorization` header of `Bearer ` followed by a token you create in the console under **Setup**, **Agents** ([agent/README.md](agent/README.md#connect-grok-bot)).
6. Ask Grok Bot: "Protect my BTC below $60,000 for at most $50."
   The first time, it gives you a pairing link to confirm in the console; then it plans, asks for your yes, and proposes the orders.

Without Grok Bot, `npm run mcp:e2e` drives the same tools end to end with a scripted client, and `npm run dev:propose -- --amount 30` proposes one trade as the agent.

```sh
npm run check     # lint, format, types and unit tests
npm run mcp:e2e   # the agent flow against a real local chain, both contract variants
npm run e2e       # the console against a real local chain, then the landing page, in a real browser
npm run redteam   # a scripted adversary attacks the mandate, both contract variants
```

Every setting is in [docs/configuration.md](docs/configuration.md), and every secret lives in `.env`, which git ignores.
[docs/hosting.md](docs/hosting.md) runs the whole product on one Linux VM with `docker compose up -d`.

## Docs map

| Document | What it covers |
| --- | --- |
| [docs/accounts.md](docs/accounts.md) | Workspaces, members, passkey sign-in, sessions, agent tokens, and how each request is scoped to one mandate. |
| [docs/configuration.md](docs/configuration.md) | Every environment variable, by service. |
| [docs/contract-interface.md](docs/contract-interface.md) | What the offchain code uses from the Policy contract, the requested additions, and the red team's findings for the contract owner. |
| [docs/cover.md](docs/cover.md) | How the server decides that a protection goal is already met, and plans only the missing part. |
| [docs/event-wake.md](docs/event-wake.md) | Which events wake Grok Bot's routine, the event body, and the limits on wake-ups. |
| [docs/gemini-venue.md](docs/gemini-venue.md) | Orders on Gemini's sandbox: safety rules, fees, settlement, the journal, and what was verified. |
| [docs/grok-bot.md](docs/grok-bot.md) | How Grok Bot connects to the MCP server, its skills and routines, and what was verified by hand. |
| [docs/hosting.md](docs/hosting.md) | Running the product on one VM with Docker Compose and Caddy, including the InstaBox gateway mode. |
| [docs/order-lifecycle.md](docs/order-lifecycle.md) | One order from proposal to settlement, and who owns each step. |
| [docs/quicknode-streams.md](docs/quicknode-streams.md) | The QuickNode Stream on Arc testnet: dataset, filter, webhook, lifecycle and credit budget. |
| [docs/x402.md](docs/x402.md) | x402 with Circle Gateway on Arc testnet: the seller, the buyer, the hedge signal and a recorded paid run. |

<!-- #95 and #96: add their docs here when they are merged. -->
