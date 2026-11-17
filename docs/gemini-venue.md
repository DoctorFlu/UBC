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
  The executor's market checks read the public data of the environment its orders go to, because the sandbox lists other strikes than production.
- **One order per intent, whatever fails.**
  Every order carries our client order id, `mandate-<chain id>-<first 8 hex digits of the contract>-<intent id>`, but safety does not depend on Gemini honouring it (see below).
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
2. It turns the amount into contracts at the limit price, rounded down to the contract's quantity step, and refuses a price off the contract's price step or less than its minimum quantity.
3. It writes "placing" to the journal, then sends one limit order, good till cancelled.
4. It follows the order (`POST /v1/prediction-markets/orders/active`, then `orders/history`) and records each change in the journal.
5. When the order fills, or when its time is up (`EXECUTOR_ORDER_TTL_MS`, 10 minutes by default, and never later than a minute before the market stops trading), it cancels what is left and records the fill onchain with `recordResult`.

| Gemini's answer | Journal state | Onchain |
| --- | --- | --- |
| Order made | `open`, then `filled`, `partly_filled` or `cancelled` | the fill, as before |
| The order refused (`InsufficientFunds`, a bad price, any 4xx about the order) | `rejected` | recorded as not filled, so the budget is released |
| The request refused (key, nonce, terms, account, rate limit) | `not_placed` | nothing; held, tried again with waits of 15 s doubling to 10 minutes |
| No answer (timeout, network, 5xx, a redirect) | `unknown` | nothing; held and looked up, never sent again |

The cost recorded is what the fills cost at their prices, rounded up to the cent.
It does not include Gemini's fees, which the docs do not state for prediction markets, so the account can spend slightly more than the approved amount.

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

The executor also announces its venue at start (`PUT /api/executor/v1/venue`), which drives the console's badge.

## The console

- A "Sandbox" badge (or "Live", in the danger colour) next to the "Local" and "Dev signer" badges, from the executor's signed announcement.
  On a phone it is the icon alone (a box for the sandbox, a bolt for real money), so the strip still fits.
  Nothing is shown for the simulated executor.
- The intent page, in Advanced view: the Gemini order id, its state, how much filled, the executor's note, and our client order id.
- A fill with a Gemini order in the journal is no longer marked as simulated; earlier simulated fills keep the marker.

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

## Setting it up

1. Make a separate account on <https://exchange.sandbox.gemini.com> (it is credited with test funds; the 2FA code there is `9999999`).
2. Accept the Prediction Markets terms there, in the web interface.
3. Create an API key there: account-scoped (not master), Trader role, time-based nonce.
4. Put `GEMINI_ENV=sandbox`, `GEMINI_API_KEY` and `GEMINI_API_SECRET` in `.env` (on the host: `deploy/set-secret.sh`, see [hosting.md](hosting.md)).
5. Run `npm run gemini:doctor` until it says `READY`.
6. Set `EXECUTOR_VENUE=gemini` and restart the executor.

The agent and the console read Gemini's production listings, while the executor checks orders against the sandbox's.
The sandbox lists fewer strikes (for example 8 of production's 21 on the BTC ladder of 20 November 2026), so a proposal on a strike the sandbox does not list is refused as `market_not_listed` and recorded as not filled.
The sandbox's order books are mostly empty, so a sandbox order may rest unfilled until its time is up and be cancelled.

## What is verified and what is not

Verified against the sandbox's public endpoints (no key): the host `https://api.sandbox.gemini.com`, its terms (version 2, while production's public terms are version 1), its event and contract listings and their quantity and price steps (0.01 each), and its settled ladders.

Verified with the owner's sandbox key on 17 November 2026 (the doctor answered READY, then the opt-in sandbox test ran three times, each order cancelled; `npm run gemini:sandbox-orders` lists none open):

- The authentication scheme works as documented: a base64 JSON payload with `request` and `nonce` in `X-GEMINI-PAYLOAD`, its HMAC-SHA384 with the secret in `X-GEMINI-SIGNATURE`, the key in `X-GEMINI-APIKEY`, a time-based nonce in whole seconds.
- The REST order request takes `clientOrderId`, and the place answer, the active list and the history all return it.
- Order ids are larger than a JavaScript number holds exactly (for example 145853902320696849, above 2^53). The client reads them as strings before parsing and sends them back digit for digit; read through `JSON.parse` they would be rounded, and a cancel would name another order.
- Gemini refuses an order that costs less than one cent: `InvalidInput`, "Validation error for quantity: Order cost must be at least 0.01". The smallest order is 1 contract at 1 cent.
- The states seen: `open` after placing, `cancelled` after cancelling (with `cancelledAt`). A fill has not been seen yet.
- An open order in the active list carries `fundsOnHold` (0.01 for 1 contract at 1 cent: the cost, nothing more) and `contractMetadata`. No answer carries a fee field.
- Without a `symbol`, the active and history lists cover every contract.
- The cancel answer is `{"result":"ok","message":"Order <id> cancelled successfully"}`.

From Gemini's documentation only, not yet checked with a key:

- That a key the sandbox does not know gets `InvalidApiKey`, and a wrong secret `InvalidSignature`.
- The roles: the quickstart says orders need the Trader role; the API reference names NewOrder, CancelOrder and OrderStatus permissions per endpoint. The owner's key has Trader and Fund Manager.
- The terms: the API reference and quickstart describe `POST /v1/prediction-markets/terms/accept`, while an older getting-started page says to accept them in the web interface first. We never call the accept endpoint either way.
- Order states other than open and cancelled: one page lists open, filled and cancelled, another adds closed.
- Fees for prediction markets.

The opt-in sandbox test (`gemini/test/sandbox.live.test.ts`) checks these facts with a real sandbox key: it runs only with `GEMINI_SANDBOX_TEST=1` and sandbox keys in the environment, places one order of 1 contract at 1 cent, far from the market, prints Gemini's raw answers, and cancels it.
It should be the first order ever sent with a new key, before the executor trades.
To see its output, add `--silent=false`:

```sh
ENV_FILE="$PWD/.env" GEMINI_SANDBOX_TEST=1 npx vitest run --root gemini --silent=false test/sandbox.live.test.ts
npm run gemini:sandbox-orders   # the sandbox account's open orders; -- --cancel <id> cancels one
```

## Tests

- `gemini/test/private.test.ts`: the signature scheme, nonces, hosts, how each answer is classified, and that the secret never appears in a request or error.
- `gemini/test/doctor.test.ts`: each verdict, that a key and `GEMINI_ENV` that disagree are refused, that production is never called, and that the key and secret are never printed.
- `devchain/test/gemini-venue.test.ts`: placement, refusals, terms, lost answers and restarts, fills, cancelling at the deadline, and settlement agreement and disagreement, against a fake of the private API that checks every signature and nonce.
- `devchain/test/executor.test.ts`: the executor on the Gemini venue places once, records refusals, holds while the terms are not accepted, never settles a disputed position, and asks the private API nothing while nothing is open.
- `dashboard/src/server/http/executor-orders-api.test.ts`: the console's journal rules, and a placement through the real routes.
