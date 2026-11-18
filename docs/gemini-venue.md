# The Gemini venue

Issue #93 puts a real exchange behind the executor's `Venue` seam ([order-lifecycle.md](order-lifecycle.md#3-the-venue-seam)): approved orders are placed on Gemini Prediction Markets, on the sandbox (test funds) by default.
The simulated venue stays the default; nothing is placed anywhere until `EXECUTOR_VENUE=gemini` is set.

## Safety rules

- **Sandbox by default.**
  `GEMINI_ENV` defaults to `sandbox`.
  Production needs `GEMINI_ENV=production` and a second, explicit `GEMINI_LIVE_TRADING=on`.
  The dev and demo executor (`devchain/scripts/executor.ts`) refuses production all the same, because the devchain's owner and agent keys are public test keys.
- **Signed requests go to Gemini's own hosts only.**
  The private client (`@mandate/gemini/private`) sends to `https://api.sandbox.gemini.com` or `https://api.gemini.com`, never to `GEMINI_API_URL`; tests may use a loopback address only.
  It never follows a redirect, because fetch keeps custom headers across hosts and would hand the key, payload and signature to whatever host the answer names; a redirect is reported as `redirected`, an unknown outcome.
  The executor's market checks, and the rest of the stack's market data, read the public data of the environment its orders go to, because the sandbox lists other strikes than production (see below).
- **One order per intent, whatever fails.**
  Every order carries our client order id, `m-<deployment>-<intent id>`, but safety does not depend on Gemini honouring it (see below).
  `<deployment>` is the first 20 hex digits (80 bits) of keccak256 of the chain id, the whole contract address and the whole hash of the block the contract was deployed in (`clientOrderIdFor` in `shared/src/venue-order.ts`).
  Gemini takes a client order id of at most 36 characters (`GEMINI_CLIENT_ORDER_ID_MAX`).
  This was measured on the sandbox on 2026-11-17: a 37-character id is refused with HTTP 400, `InvalidInput`, "client_order_id must be at most 36 characters", and a 36-character id is accepted and comes back intact in the placement's answer, the active orders and the order history.
  `m-<deployment>-` takes 23 characters, which leaves 13 digits for the intent id: the largest intent id an order can carry is 9,999,999,999,999, which a contract reaching one intent a second would hit after about 300,000 years.
  Above it, `clientOrderIdFor` throws and the executor refuses the intent before anything is journalled or sent.
  The chain id and the contract are not readable in the id; the journal's record names both.
  The fake Gemini the tests use refuses a longer id with Gemini's own answer, so an id form that is too long cannot pass the suites.
  The deploy block tells apart two deployments at the same address (issue #117): a fresh local dev chain deploys the contract at the address the last one had, and without it a new stack would reuse an earlier stack's ids on the same sandbox account.
  Each block carries the time it was mined, so two dev chains get different ids unless both were started and deployed within the same second.
  The whole address tells apart two contracts (#95): one Gemini account places every mandate's orders, and on Arc anyone can grind a contract address to share another's first 8 hex digits and deploy it in the same block, which would give printed prefixes alone the same id; the digest covers the whole address and a block hash no one knows before the block is made, so it cannot be ground in advance: matching another contract's digest takes about 2^80 deployments, each paying gas, and among a million honest deployments the chance that any two share one is about 1 in 2.4 trillion.
  An order journalled in an earlier form (`mandate-<chain id>-<first 8 hex digits of the contract>-<intent id>`, or with the first 8 hex digits of the deploy block's hash before the intent id) keeps its id: a retry is always sent under its record's id.
  Before an order is sent, the executor writes a "placing" record to its journal in the console; when that write fails, nothing is sent.
  A placement that gets no answer is never sent again: the executor looks the order up among the account's active orders and order history, by client order id when Gemini returns it, otherwise by its exact terms (symbol, side, outcome, quantity, price, after the attempt) and only when exactly one order matches.
  Until it finds the order, or proves there is none, the intent is held and nothing is recorded onchain.
  An order is sent again only after Gemini refused the request itself (the key, the nonce, the terms, the account, the rate limit), which proves no order was made.
- **Never retried blindly.**
  The private client never retries; the executor decides from the journal what happens next.
- **Terms are never accepted from code.**
  While the account has not accepted the latest Prediction Markets terms, approved orders are held and the executor says so once in its log.
  The owner accepts them on Gemini's site.
- **No secrets in output.**
  The key and secret are never logged, printed, put in an error or on a command line; the doctor prints only whether each is set, the key's kind and its length.

## What the executor does with an approved intent

1. It checks the intent as before (Gemini symbol, YES or NO, limit 1 to 99, listed under the right category), now against the trading environment's listings.
2. It turns the amount into the most contracts whose cost at the limit price plus Gemini's worst-case fee fits in it, rounded down to the contract's quantity step (see [Fees](#fees)).
   It refuses a price off the contract's price step, fewer contracts than the contract's minimum quantity, and an order that would cost less than one cent, which Gemini refuses too.
3. It writes "placing" to the journal, then sends one limit order, good till cancelled.
4. It follows the order (`POST /v1/prediction-markets/orders/active`, then `orders/history`) and records each change in the journal.
5. When the order fills, or when its time is up (`EXECUTOR_ORDER_TTL_MS`, 10 minutes by default, and never later than a minute before the market stops trading), it cancels what is left and records the fill onchain with `recordResult`.

| Gemini's answer | Journal state | Onchain |
| --- | --- | --- |
| Order made | `open`, then `filled`, `partly_filled` or `cancelled` | the fill, as before |
| The order refused (`InsufficientFunds`, a bad price, any 4xx about the order) | `rejected` | recorded as not filled, so the budget is released |
| The request refused (key, nonce, terms, account, rate limit) | `not_placed` | nothing; held, tried again with waits of 15 s doubling to 10 minutes |
| No answer (timeout, network, 5xx, a redirect) | `unknown` | nothing; held and looked up, never sent again |

The cost recorded onchain is what the fills cost at their prices, rounded up to the cent.
It does not include Gemini's fee, which no answer reports; the order's size leaves room for it inside the approved amount.
The result recorded onchain (`pnlCents`) is 0 at every fill: the contract cannot record the settlement (request 2.4 in [contract-interface.md](contract-interface.md)), so a position's result is its signed settlement.

## Fees

Gemini's fee page gives the prediction-market fee as a rate times the contracts times P times (1 - P), where P is the price in dollars, rounded up to the next cent.
The rate is 0.07 for a taker and 0.0175 for a maker.
The fee is largest for a taker filled at the limit price, so the executor sizes every order for that case (`worstCaseSpendCents` in `gemini/src/fees.ts`): cost plus the taker fee never exceeds the approved amount.
For example, $10 at 50c buys 19.32 contracts, not 20; 98c at 97c buys 1 contract (97c, and a 1c fee).

One case is outside the bound: the page does not say whether the rounding to a cent is per order or per fill.
If it is per fill, an order filled in many small pieces can pay up to 1 cent more per extra fill.
A strict bound would need the number of fills, which is unknown when the order is sized.
The two fills seen so far (below) are consistent with the schedule at the taker rate.
The first, 1 contract at 97c, paid 1 cent, which both rates give once rounded up.
The second, 10 contracts at 97c, paid 3 cents: the taker rate gives 2.04 cents, rounded up to 3, and the maker rate would give 1.
Each filled in one piece, so neither tells per-order rounding from per-fill rounding.

### The estimated fee

No Gemini answer reports the fee, so the executor estimates it from the schedule at the taker rate (`estimatedFeeCents` in `gemini/src/fees.ts`), on the filled contracts and their average price, rounded up to the cent.
The taker rate is the larger, so the estimate covers a fee at either rate, as long as Gemini rounds once per order (the gap above).
The journal stores it with the order's record when the order fills (`feeCents`), and the signed settlement carries it too: `feeCents`, with `pnlCents` = payout - cost - fee, the net after fees.
A record written before the estimate was stored gets the estimate at settlement, from the cost and the contracts.
A simulated fill pays no fee, so its settlement has no `feeCents` and its net is payout - cost.
The console and the agent show the fee as estimated, said once next to any total.

## Settlement

A position on Gemini settles the way issue #92 settles a simulated one, with one more check.
The executor first waits for the public outcome, as before, and asks Gemini's private API nothing while the market trades.
Once it is published, it reads the account's settled positions (`POST /v1/prediction-markets/positions/settled`) and settles only when they agree with the public outcome: the same resolution, at least as many contracts as our order filled, and the payout that resolution implies.
A disagreement is never resolved silently: the position is not settled, the executor logs "NOT SETTLED" with both sides, writes it to the order's journal record (the intent page shows it in Advanced view), and asks again later.
A fill recorded before the executor traded on Gemini has no journal record and settles on the public outcome as before, marked simulated.

## The journal

The executor's container has no writable disk, so the journal lives in the console, next to settlements: `GET` and `PUT /api/executor/v1/orders/:intentId`, inside the stack only (Caddy answers 404 for `/api/executor/*`).
Each version is canonical JSON (`venueOrderRecordSchema` in `shared/src/venue-order.ts`), signed with the executor key like a settlement, and stored only when:

- the signer is the contract's `executor()` and the record names the deployment the console follows;
- the console has seen the intent, and the market, outcome, side and limit price match it;
- its revision is higher than the stored one, its order terms are unchanged, Gemini's order id never changes once known, what filled never goes down, and a closed order changes only its note.

The executor follows the chain a moment ahead of the console, so its first write for a new intent is often answered `not_seen`.
The journal client tries a request again after 0.25, 0.5, 1, 2 and 4 seconds when the console has not seen the intent yet, did not answer (for example while `next dev` compiles the route on its first request), or failed with a 5xx; it never tries again after a refusal.
Only after those 8 seconds does the executor wait its usual 15 seconds and try the intent again.
A "placing" version whose write failed was never sent, and the next try sends the order; before this rule, that version stayed in the executor's memory and the intent waited for an order that never existed (the live e2e flake of 17 November 2026).

The executor also announces its venue at start (`PUT /api/executor/v1/venue`), which drives the console's badge.
The console keeps every announcement of a contract in order, and labels each fill by the one in force when it was mined (see below).
A restart on the venue already in force adds nothing.

## The console

- A badge in the top bar says where approved orders are filled, from the executor's signed announcement, never from the chain:
  "Live" (in the danger colour) for real money on Gemini, "Sandbox" for its test funds, "Simulated fills" for the simulated venue, and "Fill source unknown" until the executor announces one.
  The chain decides nothing here: the hosted Arc demo is a real chain whose fills are simulated, and it says so.
  Only a local devchain whose executor announced nothing reads as simulated, since its in-process simulator never announces.
  On a phone the badge is the icon alone, so the strip still fits.
- Each fill is labelled the same way wherever it is shown with its amount or result: the intent page and its timeline, Activity's Filled and Paid at expiry totals, the evidence page, and the public scorecard's Filled count and settled result.
  A fill's own evidence comes first: the order the executor journaled for it (Sandbox or Live), then the venue its settlement names, then the venue announced when the fill was mined, never a later one.
  A Gemini executor journals every order, so a fill it has no order for is "Fill source unknown".
- When the console stores an announcement of a new venue, it reads the chain head and the announcement holds from the next block: fills mined up to that head keep the announcement before it.
  The first announcement of a contract also covers that contract's earlier fills.
  This is the rule that keeps a switch truthful: after the hosted demo moves from the simulated venue to Gemini's sandbox, its earlier fills still say "Simulated fill", and the new ones say "Sandbox fill" from their journaled orders.
  It is not a guess about the past: an announcement only labels a fill that has no journaled order, so the most it can say of one is "simulated" or "unknown", and no earlier fill on Gemini (which always has an order) can be called simulated by it.
  When the console cannot read the head, it answers 503 and the executor tries again.
- A total of fills from one source carries that source's tag, as a single fill does.
  A total of mixed fills says each source's count instead ("1 simulated", "1 on the sandbox"), never one tag for all: Activity's Filled and Paid at expiry, the Hedge page's settled totals, and the public scorecard's Filled count and settled result.
- The intent page, in Advanced view: the Gemini order id, its state, how much filled, the executor's note, and our client order id.
- The Order line, on the intent page, in Activity and on Home, gives the contracts the order was placed for, which [Fees](#fees) can make fewer than the amount buys at the limit (issue #117).
  Advanced view adds what the amount buys at the limit when the two differ: "Buy NO, 10 at 97¢ (10.03 before the fee)".
  Before an order is placed, and on the simulated venue, the line gives what the amount buys at the limit.

The agent reads the same journal through the console's agent API (`GET /api/agent/v1/orders`, its own mandate only): `get_intent` and `get_activity` give each intent's `order` (venue, environment, state, contracts placed and filled, fee), and `get_intent` says when fewer contracts were placed than the amount buys at the limit.
The same response carries each filled intent's source as the console labels it (`fillSources`), so each filled intent also has a `fillSource` (`simulated`, `sandbox`, `live` or `unknown`), and `get_intent` and `get_activity` name it in their summaries whenever a fill was not real money; `get_activity` gives each source's count when its fills differ.
Against a console from before `fillSources`, the agent falls back to the venue announced last.

## The doctor

`npm run gemini:doctor` checks the settings before the executor uses them.
It is read-only: it places nothing, cancels nothing and never accepts terms, and it prints no key and no secret.

1. It asks the sandbox `POST /v1/roles`, which any key may call.
   A key the sandbox answers for is a sandbox key.
   A key it refuses with `InvalidApiKey` is not a sandbox key: a key made on Gemini's normal site is a production key, which trades real money.
   The doctor never sends a request signed with the key to production, so it stops there.
2. It refuses to go on when `GEMINI_ENV` and the key disagree, and says so in plain words.
3. For a sandbox key, it checks the Trader role, the Prediction Markets terms and the USD balance.

It ends with one line: `READY`, `NOT READY` with each reason, `REFUSED` (the key and `GEMINI_ENV` disagree), `NOT CHECKED` (production is never checked) or `UNKNOWN` (the sandbox did not answer).
Its exit status is 0 when ready, 1 when not, 2 when the sandbox could not be reached.

## The mirror maker

The sandbox lists the same ladders as production, but its books are empty, and on the hourly ladder its own maker prices off the sandbox's BTC price, which was about $700 below the real index the contracts settle on (18 November 2026).
So the sandbox alone gives no fill at a real price.
The mirror maker fills that gap from a second sandbox account of its own: it rests orders on the sandbox at the prices Gemini's production exchange shows for the same contracts.

What is real and what is not:

- The prices are production's: the best bids of the same contract, read from production's public books.
- The orders, the matching and the fills are the sandbox's own engine, between two accounts.
- The settlement is the sandbox's, on the same index as production (`LS-LRRR-XBTUSD`).
- The counterparty is ours: the maker, on a second sandbox account. The sizes are production's displayed sizes, capped.

How it quotes, for each rung of a ladder in scope:

- A YES bid at production's best YES bid, which is what a NO buyer takes (a NO buy at 100 minus that bid matches it), and a NO bid at 100 minus production's best YES ask, each sized to what production shows at that price, within the caps.
- Every order is maker only (`makerOrCancel`): an order that would take liquidity is cancelled by Gemini instead of filling, and the maker leaves that side alone until production's price moves.
- Nothing is quoted where production does not list the contract or could not be read, where production's book is closed, one-sided, locked or crossed, or more than 45 seconds old, where the sandbox does not have the rung open, within 2 minutes of expiry, or where the sandbox book holds someone else's order.
  It never invents a price.
- Daily ladders only by default (`MAKER_KINDS`); weekly and month-end on request; never hourly or shorter, where the sandbox's own maker is.

Every 15 seconds it reads production's books and the sandbox's listing (public), and its account's open orders and positions, then cancels what no longer matches and places what is missing.
An order stays while its price is right and between half and all of its size is left; otherwise it is replaced, so a quote the executor took is refilled at production's size.
It places at most 8 orders a cycle and never holds back a cancel, inside the private client's pace of one signed request a second.
Its caps (`MAKER_MAX_*`, [configuration.md](configuration.md)) bound each quote, all quotes together, and what it may hold.

Safety:

- Sandbox only: the host is fixed in its code, and it refuses to start where `GEMINI_ENV` names anything else or any live-trading setting is set.
- Its own account: it refuses the executor's key (`GEMINI_API_KEY`) as its own.
- Every client order id it sends starts with `mk-`, and it cancels only those; the executor's ids start with `m-` and a hex digest, so they never match.
- It cancels every order of its own when it starts and when it stops; a killed process leaves its orders until the next start, or `--cancel-all`.
- A placement that got no answer is never sent again: that side is left alone until the account's open orders show what happened.
- No key or secret is printed.

Running it:

```sh
npm run gemini:maker:doctor             # read-only: both accounts, open orders, and each rung against production
npm run gemini:maker                    # run until Ctrl-C, then cancel everything of its own
npm run gemini:maker -- --cancel-all    # cancel every order of its own, and exit
```

On the hosted Arc stack it is the `maker` service of `compose.arc.yml`, off unless its profile is named (from `/data/mandate/repo/deploy`):

```sh
docker compose --env-file /data/mandate/mandate.env run --rm --no-deps maker node --import tsx gemini/scripts/maker-doctor.ts
docker compose --env-file /data/mandate/mandate.env --profile maker up -d --no-build --no-deps maker
docker compose --env-file /data/mandate/mandate.env --profile maker logs -f --tail 50 maker
docker compose --env-file /data/mandate/mandate.env --profile maker stop maker
docker compose --env-file /data/mandate/mandate.env run --rm --no-deps maker node --import tsx gemini/scripts/maker.ts --cancel-all
```

`stop` sends SIGTERM and allows 60 seconds, in which the maker cancels its orders.
Its keys are `GEMINI_MAKER_API_KEY` and `GEMINI_MAKER_API_SECRET`, set with `deploy/set-secret.sh`.
The second account is made, funded and given its Prediction Markets terms by its owner on <https://exchange.sandbox.gemini.com>, as in [Setting it up](#setting-it-up).

The first match between the two accounts, on 18 November 2026: the maker's YES bid of 1 contract at 52c on `GEMI-BTC2611182200-HI64250` was taken at once by the executor account's NO buy at 48c, and Get Positions showed YES 1 at 0.52 on one account and NO 1 at 0.48 on the other.
Gemini's self-trade prevention does not stop a match between two accounts.
`MAKER_INTEGRATION=1 npx vitest run gemini/test/maker.sandbox.live.test.ts` repeats it with the maker's own loop, about $1 of test funds.

## Setting it up

1. Make a separate account on <https://exchange.sandbox.gemini.com> (it is credited with test funds; the 2FA code there is `9999999`).
2. Accept the Prediction Markets terms there, in the web interface.
3. Create an API key there: account-scoped (not master), Trader role, time-based nonce.
4. Put `GEMINI_ENV=sandbox`, `GEMINI_API_KEY` and `GEMINI_API_SECRET` in `.env` (on the host: `deploy/set-secret.sh`, see [hosting.md](hosting.md)).
5. Run `npm run gemini:doctor` until it says `READY`.
6. Set `EXECUTOR_VENUE=gemini` and restart the executor.

## One environment for the whole stack

With `EXECUTOR_VENUE=gemini`, the console, the MCP server and the signal API read the public market data of the environment the orders go to (`GEMINI_ENV`, the sandbox by default), not production's.
The sandbox lists fewer strikes (for example 8 of production's 21 on the BTC ladder of 20 November 2026), has its own books and its own spot price (about 1 % from production's), so planning on production would propose strikes the executor cannot place.
Give every service the same `EXECUTOR_VENUE` and `GEMINI_ENV`; the demo compose file does.
When they disagree, nothing is traded on the wrong exchange:

- The console refuses the executor's venue announcement with 409 `environment_mismatch`, naming both sides' settings, and the executor stops before it trades.
- The MCP server proposes nothing while the console names another environment, and pays for no signal while the signal API does; both answer `MARKET_ENVIRONMENT_MISMATCH`.
- A `GEMINI_API_URL` on another host than the environment's is refused at start (a loopback test server is allowed), and the console's health answers 503.

[configuration.md](configuration.md#one-gemini-for-the-whole-stack) has the table of settings.

## What a sandbox demo can show

Seen on 17 November 2026, and checked again before each sandbox run:

- The sandbox lists the same ladders as production, but a test market maker quotes only some of them, and not all the time.
  The hourly BTC ladder was quoted for most of each hour, and empty for the first few minutes after a new one opened.
  The 15-minute and 5-minute ladders were quoted; the daily and weekly ladders were empty.
- On an empty ladder, `get_ladder` and `plan_hedge` say so first, with the reason `NO_PRICES`: nothing can be planned or filled there.
  The answer names the environment (`marketEnvironment`) and how many strikes are priced (`pricedRungCount`).
- The sandbox's own BTC spot can sit far from the ladder's strikes (about $63,700 against strikes of $64,400 to $65,100 that day), so `plan_hedge` can find nothing to buy on a quoted ladder.
  A demo then proposes one intent directly.
- A fill is achievable: with a YES bid at 3c, buying NO at 97c crosses it and fills at once.
  An order far from the market rests, and the executor cancels it at its time limit.
- Sandbox fills spend test funds only; the account starts with $100,000 of them.

## What is verified and what is not

Verified against the sandbox's public endpoints (no key): the host `https://api.sandbox.gemini.com`, its terms (version 2, while production's public terms are version 1), its event and contract listings and their quantity and price steps (0.01 each), and its settled ladders.

Verified with the owner's sandbox key on 17 November 2026 (the doctor answered READY, then the opt-in sandbox test ran three times, each order cancelled; `npm run gemini:sandbox-orders` lists none open):

- The authentication scheme works as documented: a base64 JSON payload with `request` and `nonce` in `X-GEMINI-PAYLOAD`, its HMAC-SHA384 with the secret in `X-GEMINI-SIGNATURE`, the key in `X-GEMINI-APIKEY`, a time-based nonce in whole seconds.
- The REST order request takes `clientOrderId`, and the place answer, the active list and the history all return it.
- Order ids are larger than a JavaScript number holds exactly (for example 145853902320696849, above 2^53). The client reads them as strings before parsing and sends them back digit for digit; read through `JSON.parse` they would be rounded, and a cancel would name another order.
- Gemini refuses an order that costs less than one cent: `InvalidInput`, "Validation error for quantity: Order cost must be at least 0.01". The smallest order is 1 contract at 1 cent.
- The states seen: `open` after placing, `cancelled` after cancelling (with `cancelledAt`), and `filled`.
- An open order in the active list carries `fundsOnHold` (0.01 for 1 contract at 1 cent: the cost, nothing more) and `contractMetadata`. No answer carries a fee field.
- Without a `symbol`, the active and history lists cover every contract.
- The cancel answer is `{"result":"ok","message":"Order <id> cancelled successfully"}`.

Verified end to end on 17 November 2026, a local stack on the sandbox (devchain, console, executor with `EXECUTOR_VENUE=gemini` and `GEMINI_ENV=sandbox`), two intents on the 17:00 UTC hourly BTC ladder:

- Buy NO on HI64500, $0.98 at 97c, against a YES bid of 3c: the executor placed 1 contract, which filled at once at 0.97.
  The fill was recorded onchain as $0.97, and the intent page shows the Gemini order id, Filled, and the Sandbox badge.
  The history row is `filled`, `filledQuantity` 1, `avgExecutionPrice` 0.97, and still no fee field.
  The USD balance fell from 100000.00 to 99999.02: 97c and a 1c fee, consistent with the schedule (both rates round up to 1c here); the order was sized for the taker fee.
- Buy NO on HI65100, $0.02 at 1c: 1 contract rested (`fundsOnHold` 0.01), and the executor cancelled it at its time limit with nothing filled, so its budget was released onchain.
- Afterwards `npm run gemini:sandbox-orders` listed no open order.
- At expiry the fill settled on Gemini's settled positions: Gemini published the outcome at 17:00:07 UTC (NO, BTC at $63,696.06), and the executor recorded the settlement, signed, at 17:00:30 UTC: cost $0.97, paid $1.00.
  The balance rose from 99999.02 to 100000.02, so the payout carried no fee: the only fee was the 1c at the fill.
  Over the position the balance went from 100000.00 to 100000.02, a net of +$0.02, which is what the settlement now records with the estimated fee (cost $0.97, fee $0.01, paid $1.00, net after fees +$0.02).

A second pass on 17 November 2026, with the estimated fee in the journal, one intent on the 18:00 UTC hourly BTC ladder:

- Buy NO on HI64100, $9.73 at 97c, against a YES bid of 3c with 59 contracts: the executor placed 10 contracts (cost and taker fee $9.73), which filled at once at 0.97.
  The journal recorded the fill with `feeCents` 3.
  The USD balance fell from 100000.02 to 99990.29: $9.70 and a 3c fee, the estimate exactly.
- At expiry Gemini published NO (BTC at $63,744.59), and the executor signed the settlement at 18:00:44 UTC: cost $9.70, fee $0.03 (estimated), paid $10.00, net after fees +$0.27.
  The balance rose to 100000.29, so this payout carried no fee either, and the position's +$0.27 is the settlement's net to the cent.
- Afterwards `npm run gemini:sandbox-orders` listed no open order.

From Gemini's documentation only, not yet checked with a key:

- That a key the sandbox does not know gets `InvalidApiKey`, and a wrong secret `InvalidSignature`.
- The roles: the quickstart says orders need the Trader role; the API reference names NewOrder, CancelOrder and OrderStatus permissions per endpoint. The owner's key has Trader and Fund Manager.
- The terms: the API reference and quickstart describe `POST /v1/prediction-markets/terms/accept`, while an older getting-started page says to accept them in the web interface first. We never call the accept endpoint either way.
- Order states other than open and cancelled: one page lists open, filled and cancelled, another adds closed.
- Whether the fee is rounded per order or per fill (see [Fees](#fees)).

The opt-in sandbox test (`gemini/test/sandbox.live.test.ts`) checks these facts with a real sandbox key: it runs only with `GEMINI_SANDBOX_TEST=1` and sandbox keys in the environment, places one order of 1 contract at 1 cent, far from the market, prints Gemini's raw answers, and cancels it.
It should be the first order ever sent with a new key, before the executor trades.
To see its output, add `--silent=false`:

```sh
ENV_FILE="$PWD/.env" GEMINI_SANDBOX_TEST=1 npx vitest run --root gemini --silent=false test/sandbox.live.test.ts
npm run gemini:sandbox-orders   # the sandbox account's open orders; -- --cancel <id> cancels one, --balances adds the USD balance, --raw prints the history as sent
```

## Tests

- `gemini/test/private.test.ts`: the signature scheme, nonces, hosts, how each answer is classified, and that the secret never appears in a request or error.
- `gemini/test/doctor.test.ts`: each verdict, that a key and `GEMINI_ENV` that disagree are refused, that production is never called, and that the key and secret are never printed.
- `devchain/test/gemini-venue.test.ts`: placement, refusals, terms, lost answers and restarts, fills, cancelling at the deadline, and settlement agreement and disagreement, against a fake of the private API that checks every signature and nonce.
- `devchain/test/executor.test.ts`: the executor on the Gemini venue places once, records refusals, holds while the terms are not accepted, never settles a disputed position, and asks the private API nothing while nothing is open.
- `dashboard/src/server/http/executor-orders-api.test.ts`: the console's journal rules, and a placement through the real routes.
