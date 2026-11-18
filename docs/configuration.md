# Configuration

Every service reads its settings from environment variables.
For local work they live in a `.env` file at the repository root, which is git-ignored.
Never commit `.env`, and never paste its values into chat, issues or pull requests.

Scripts that create secrets write them straight into `.env` without printing them.

## Chain

| Variable | Required | Meaning |
| --- | --- | --- |
| `ARC_RPC_URL` | no | Arc testnet RPC endpoint. Defaults to `https://rpc.testnet.arc.io`. |
| `POLICY_ADDRESS` | no | Deployed Policy contract. When empty, the local devchain deployment is used. |
| `POLICY_DEPLOY_BLOCK` | no | Block the Policy contract was deployed in, so event scans start there instead of block 0. The MCP server reads it too, to recover rejection reasons from events; when it is unset, the server scans only the last 200,000 blocks. |
| `POLICY_DEPLOYMENT_FILE` | no | Local deployment file to use when `POLICY_ADDRESS` is empty. Defaults to `devchain/deployments/local.json`, which `npm run dev:chain` writes, for the console and the scripts. Tests that run their own chain point every process at their own file. The MCP server reads it only when it is set explicitly, taking the contract, its deploy block and the RPC from it; the hosted demo chain uses this. |

Switching the console, the agent and the scripts from the local devchain to Arc testnet is configuration only: set `POLICY_ADDRESS`, `POLICY_DEPLOY_BLOCK` and, if you use a provider, `ARC_RPC_URL`.
The browser never receives `ARC_RPC_URL`, because it may carry a provider key; it uses Arc's public RPC.

## Arc testnet

The Policy contract on Arc testnet is in [contracts/README.md](../contracts/README.md): `POLICY_ADDRESS=0x571D8ea7C86c80a230C10818743f8861084F82f3`, `POLICY_DEPLOY_BLOCK=72740419`.
Moving to it is configuration: two keys of the stack's own, three roles the owner sets on the contract, gas for two addresses, and the variables below.
Instead of the team's instance, the stack can deploy one of its own with `npm run arc:deploy` ([below](#our-own-instance-or-the-teams)).
The hosted machine's switch is in [hosting.md](hosting.md#arc-testnet).

| Variable | Required | Meaning |
| --- | --- | --- |
| `AGENT_PRIVATE_KEY` | yes | The agent's key: it proposes trades. Made by `npm run arc:keygen`. |
| `EXECUTOR_PRIVATE_KEY` | for the executor | The executor's key: it records fills (`recordResult`). Made by `npm run arc:keygen`. Read only for a contract named by `POLICY_ADDRESS`; on the devchain the executor is anvil's account 2. |
| `ARC_OWNER_ADDRESS` | no | The owner's wallet address, for `npm run arc:doctor` only (or `--owner 0x...`). Never a key: the owner signs in their own browser wallet. |

### Keys

`npm run arc:keygen` writes a new `AGENT_PRIVATE_KEY` and `EXECUTOR_PRIVATE_KEY` into the env file (`ENV_FILE`, default the root `.env`) with mode 600, and prints only the two addresses and the next steps.
It keeps keys that are already there; `-- --replace` replaces them.
It refuses, changing nothing, a value that is not a key, the same key for both roles, and any of anvil's published test keys (from the mnemonic `test test ... junk`, which anyone can sign with).
The owner role is not a key the stack holds: it is the owner's browser wallet.

The MCP server and the executor refuse anvil's published keys too, wherever they would sign on a chain that is not the devchain.
The devchain uses Arc testnet's chain id, 5042002, so the chain id cannot tell them apart; where the process signs does.
For the MCP server the devchain is a loopback RPC (`127.0.0.1`, `localhost`, `[::1]`), or a deployment file (`POLICY_DEPLOYMENT_FILE`) whose RPC is loopback or a bare compose service name without a dot, as the hosted demo chain's `http://anvil:8545`.
A name is not resolved to decide this: `ARC_RPC_URL=http://anvil:8545` typed in by hand is refused like any other host, because only the deployment file the devchain writes marks a chain as local, and that mark is not an environment variable.
A deployment file that names `rpc.testnet.arc.io`, a QuickNode host or a private IP address is refused as well.
The executor follows the same rule: on the devchain's deployment file it signs with anvil's executor account, and for a contract named by `POLICY_ADDRESS` with `EXECUTOR_PRIVATE_KEY`, which may be one of anvil's keys only on a loopback RPC.
Off a loopback RPC it also needs `POLICY_DEPLOY_BLOCK`, so it never scans from block 0.

Until the contract's `executor()` is its key, the executor does not exit: it logs `not the executor yet: ... Ask the contract's owner to call setExecutor(0x...)` once, reads the role again every 30 s, and starts serving when the owner has made the call.
On Arc it fills with the simulated venue unless `EXECUTOR_VENUE=gemini`, which trades on Gemini's sandbox only: it refuses `GEMINI_ENV=production` there, as on the devchain.

### The doctor

`npm run arc:doctor -- --owner 0x<owner wallet>` checks everything before the stack runs against Arc, and ends `READY` or with the one next step (exit codes 0, 1, and 2 when Arc did not answer).
Run it after every change of keys, gas or roles: the owner can change the three roles at any time (`setUser`, `setAgent`, `setExecutor`).
It sends nothing to Arc and prints no key, and of `ARC_RPC_URL` only the host.
It reports, in order:

1. the RPC and the chain id it serves, and the head block;
2. whether the code at `POLICY_ADDRESS` is the `contracts/src/Policy.sol` of this checkout (compiled by `npm run dev:chain`), and whether it was deployed in exactly `POLICY_DEPLOY_BLOCK`;
3. the contract's `user`, `agent` and `executor`, each against the address of the configured key (the user against the owner you name);
4. the rules, the budget used and left, today's loss, whether it is paused, and the number of intents;
5. the gas a proposal, an owner approval and a `recordResult` use, and how many of its costliest call each address's balance covers.

The gas is measured, not guessed: the doctor starts a local anvil that forks Arc at the head block through Arc's public RPC, sets known rules as the contract's user, proposes twice (once held for the owner, once approved by the rules), approves and records a result, each as the role's current holder (impersonated, unsigned).
Nothing done on the fork reaches Arc, and the fork never uses the configured `ARC_RPC_URL`, so it spends no provider credits; `--no-fork` skips it.
Measured on 2026-11-17 at 29 gwei: a proposal held for the owner 215,852 gas (0.0063 USDC), one approved by the rules 205,689 (0.0060), an owner approval 82,684 (0.0024), a `recordResult` 131,229 (0.0038).
Arc pays gas in USDC, so 1 USDC from the faucet covers about 130 proposals, with the doctor's 20% headroom.

### Our own instance, or the team's

There are two ways to get a contract whose roles are the stack's keys:

- **The team's instance** (`0x571D…82f3` above): its user, the deployer, calls `setAgent` and `setExecutor` with the addresses `arc:keygen` printed, and `setUser` to the owner's wallet.
  Only that address can make these calls.
- **Our own instance**: `npm run arc:deploy -- --owner 0x<owner wallet>` deploys the same contract with our keys in its roles, as `contracts/script/Deploy.s.sol` does, without waiting for anyone.

`arc:deploy` sends three transactions from the executor's key: `new Policy(agent, executor)` from this checkout's compiled `contracts/src/Policy.sol` (the build the doctor compares against), `setPolicy` with the demo rules (`DEMO_POLICY`), and `setUser(owner)` last.
The deployer is the contract's user only between the first and the last of them.
It uses the executor's key because that key is funded and its role has no power over the rules; the agent's key never holds the user role, not even for one block, because the agent proposes the trades the user's rules judge.
The keys come from the env file the process loads (`ENV_FILE`), never from the command line, and no key is printed.
Do not run it while an executor with the same key is sending on the same chain: two senders with one key race for its nonces.

It refuses, sending nothing, without `--owner`; with an owner that is the zero address, the agent or the executor; with a missing, malformed or shared key, or one of anvil's published keys; with a loopback `ARC_RPC_URL` unless `--fork` says it is a local fork; on a chain other than 5042002; and when the deployer's balance does not cover the three transactions with 50% headroom (it estimates the deployment, and bounds the two calls).
Each transaction's hash is printed as it is sent; after the deployment the address, the deploy block and the command to finish a stopped run; at the end the two lines for the env file:

```text
POLICY_ADDRESS=0x...
POLICY_DEPLOY_BLOCK=...
```

Then it runs the doctor against the same chain and exits 0 only when the doctor says `READY`.

It is resumable and never deploys twice by accident:

- `--resume 0x<address>` reads the contract first and sends only what is missing (`setPolicy`, `setUser`, or nothing).
  It refuses an address that is not this build's Policy, names other keys, or whose user is neither the deployer nor the owner.
  It finds the deploy block itself.
- Without `--resume`, it looks at the contracts the deployer's key created (its last 64 nonces); if one is this build's Policy, it stops and names it.
  `--new` deploys another anyway.

`--dry-run` runs all three on a throwaway local anvil fork of Arc's public RPC, with the real keys loaded in the process, then the doctor on that fork, and sends nothing to Arc.
The address it prints is the one a real run would get, while the deployer's nonce does not change.
On 2026-11-18 at 02:05 UTC it used 3,092,050 gas at most (about 0.055 USDC spent at 20 gwei on the fork; up to 0.116 USDC with headroom) and ended with the doctor's `READY`.
The real run on 18 November 2026 deployed `0x9a240b2aaa2a936DBf4543940341Bb725C92412d` in block 72777078, with three confirmed transactions and the doctor's `READY` against Arc testnet; the hosted demo uses it.

### Which RPC each service uses, and what it costs

Every service reads the same `ARC_RPC_URL`, so one env file decides for the console, the MCP server and the executor together; the browser always uses the public RPC.
The default, Arc's public `https://rpc.testnet.arc.io`, costs no credits.
A QuickNode endpoint on our account costs 20 credits per call on Arc, from the Build plan's 80M credits a month (2.67M a day on average), and overage must never be incurred.

Calls at the default settings, with Arc's blocks every 0.5 s (QuickNode's budget basis; 0.508 s measured over the 11,407 blocks after the deploy block).
The console and the executor rows were measured, not only derived: on 2026-11-17 the real console (`next dev`, a fresh database) and the real executor ran for 60 s against the production Policy on a local anvil that mined a block every 0.5 s, through a proxy that counted every JSON-RPC call; the console made 136 calls (59 `eth_getBlockByNumber`, 59 `eth_getLogs`, 18 `eth_call`) and the executor 120 (60 `eth_blockNumber`, 60 `eth_getLogs`).
The MCP server's `mcp:smoke` (seven read-only tool calls) made 21.
Each row is **per contract**: the console follows, and the executor serves, every mandate's contract with a loop of its own, so two mandates' contracts double the console's and the executor's calls.

| Service | What it calls | Calls a minute | Calls a day | QuickNode credits a day |
| --- | --- | --- | --- | --- |
| Console, `CONSOLE_EVENT_SOURCE=rpc`, poll 1 s | each poll: the latest block and `eth_getLogs`; the three roles every 10 s | 136 measured (138 at most) | up to 198,720 | up to 3,974,400 |
| Console, `CONSOLE_EVENT_SOURCE=stream` | the same poll every 15 s, roles included | 20 | 28,800 | 576,000, plus the Stream's 3,456,000 |
| Executor, `SIM_EXECUTOR_POLL_MS=1000` | each poll: `eth_blockNumber` and `eth_getLogs` | 120 measured | 172,800 | 3,456,000 |
| MCP server | only during a tool call: about 10 calls for a proposal (fees, simulation, nonce, gas, send, receipt, the event index), about 3 for a read (21 measured for 7) | 0 when idle | about 2,000 at 200 tool calls | about 40,000 |

So the three at their defaults on QuickNode, with one contract, would spend about 7.5M credits a day and use up the month's 80M in 11 days.
**Run all three on the public RPC**, and spend QuickNode credits only on the Stream, in demo windows ([quicknode-streams.md](quicknode-streams.md#plan-for-the-arc-deployment-19)).
If a service must use QuickNode, these settings bound it (credits a day, `I` in seconds):

- the console's poll, `CONSOLE_POLL_INTERVAL_MS`: 20 x 86,400 x (2/I + the roles, 0.3 or 3/I when I is 10 s or more), so 1.21M at 5 s, 864,000 at 10 s, 288,000 at 30 s;
- `CONSOLE_EVENT_SOURCE=stream`, which slows the poll to 15 s at least;
- the executor's poll, `SIM_EXECUTOR_POLL_MS`: 20 x 86,400 x 2/I, so 691,200 at 5 s, 230,400 at 15 s, 115,200 at 30 s;
- the MCP server spends only on tool calls, so its use follows the agent's activity.

Catching up from the deploy block costs a one-time scan, measured read-only on the public RPC: it answers `eth_getLogs` over at most 10,000 blocks (10,001 is refused with `-32012 requested range too large`).
The console reads 5,000 blocks a call and keeps its cursor in its database, so it scans once per new database: 3 calls at 11,407 blocks, about 35 more for each day since the deploy, about 1,040 (20,800 credits on QuickNode) a month after it.
The executor and the MCP server read 10,000 blocks a call and keep no cursor, so each start scans again: 2 calls now, about 18 more a day, about 520 (10,400 credits) a month after the deploy.
Without `POLICY_DEPLOY_BLOCK` the console would look for the deploy block itself and the MCP server would scan only the last 200,000 blocks; always set it.
QuickNode's own `eth_getLogs` range limit was not measured (no call to our account); the console halves its range on a range error, down to 50 blocks, while the executor and the MCP server use 10,000 blocks and would fail on an endpoint with a smaller limit.

### The local stack against Arc testnet

`npm run dev:stack` always starts its own anvil, so it is for the devchain only.
Against Arc, set in the root `.env` `POLICY_ADDRESS=0x571D8ea7C86c80a230C10818743f8861084F82f3` and `POLICY_DEPLOY_BLOCK=72740419` (and `ARC_RPC_URL` only for a provider), then:

```sh
npm run arc:keygen                        # once; prints the agent and executor addresses
npm run arc:doctor -- --owner 0x<owner>   # until it says READY: faucet, then the owner's setAgent and setExecutor
npm run dev -w @mandate/dashboard         # the console on http://localhost:3000; the owner signs with their wallet
npm run dev:mcp                           # the MCP server on 127.0.0.1:8787
npm run dev:executor                      # fills approved intents, simulated by default
```

Leave `NEXT_PUBLIC_DEV_SIGNER` unset: its signer is anvil's account 0, whose key is public.
Run one stack per key at a time: a laptop and the hosted machine signing with the same agent key would race for its nonces.

## Agent (MCP server)

| Variable | Required | Meaning |
| --- | --- | --- |
| `AGENT_PRIVATE_KEY` | for trading tools | Key of the agent's Arc account. It can only propose trades. |
| `MCP_AUTH_TOKEN` | yes | The first workspace's agent token, at least 32 characters, which Grok Bot presents to the MCP server. The console registers its hash the first time it is used and decides about it from then on, like any token made in the Agents section; once revoked there it stays revoked (see [accounts.md](accounts.md#the-env-file-token)). Create it with `npm run mcp:token`. |
| `MCP_TRUST_PROXY` | no | `true` when a reverse proxy appends the client to `X-Forwarded-For` (Caddy in the hosted stack), so the limit on failed tokens keys on the client. Defaults to `false`: every client shares one bucket. |
| `MCP_PORT` | no | Port of the MCP server. Defaults to `8787`. |
| `MCP_HOST` | no | Interface the MCP server listens on. Defaults to `127.0.0.1`. |
| `MCP_ALLOWED_ORIGINS` | no | Comma-separated hostnames allowed in a browser `Origin` header, in addition to localhost. |
| `MCP_LOG_LEVEL` | no | `debug`, `info`, `warn` or `error`. Defaults to `info`. |
| `MCP_ADVERTISE_OUTPUT_SCHEMAS` | no | `true` to include each tool's output schema in `tools/list`. Defaults to `false`, which makes the list about four times smaller; results are validated on the server either way. |
| `MCP_TOOL_DEADLINE_MS` | no | Most one tool call may take, in milliseconds, from 1000 to 40000. Defaults to `25000`, well under the 60 s an MCP client waits. When it passes, every Gemini, chain and console request of the call is aborted and the tool answers `unavailable` (`TIMED_OUT`), naming what was slow. A proposal or payment already sent is still followed to its answer. |

The MCP server starts with only `MCP_AUTH_TOKEN`, but it answers calls only with `CONSOLE_SERVICE_TOKEN` too: it asks the console which agent every token belongs to, and refuses every call (503) while it cannot.
A variable marked "for ... tools" becomes required once a registered tool declares it; until then `get_setup_state` reports it as a remaining step.
See [agent/README.md](../agent/README.md).

## Console

| Variable | Required | Meaning |
| --- | --- | --- |
| `CONSOLE_URL` | no | Public address of the console. The MCP server calls it, the console builds the pairing link from it, and it is the passkeys' origin and the `Origin` every write must carry. Defaults to `http://localhost:3000`. |
| `CONSOLE_SERVICE_TOKEN` | for console tools | Shared secret between the console backend and the MCP server, sent as a bearer token and compared in constant time. Without it every `/api/agent/v1` route answers 503, so the MCP server cannot resolve tokens. |
| `CONSOLE_DATA_DIR` | no | Folder for the console's SQLite store (workspaces, members, passkeys, sessions, agent tokens and sealed agent keys, events, contexts, holdings, hedge plans, pairing, change requests, signal payments and budget, Gemini's listing of each intent's market, event wake-ups, and the executor's settlement records). Defaults to `dashboard/.data`, which is git-ignored. Deleting it loses the workspaces and the keys the console holds; the console rebuilds the onchain part from the chain, and the executor records each settlement again the next time it starts. |
| `CONSOLE_MODE` | no | `production` or `development`. Defaults to `production` when `NODE_ENV=production`. Production refuses to start without a master key and refuses open sign-up. |
| `CONSOLE_MASTER_KEY_FILE` | in production, this or the next | File holding the master key that seals the agents' keys: 32 bytes as 64 hex digits, base64 or base64url. Preferred where the platform mounts secrets as files. |
| `CONSOLE_MASTER_KEY` | in production, this or the previous | The master key itself, for hosts whose secrets live in an env file; `deploy/init-env.sh` creates it for the hosted stack. Set one of the two, not both. In development without either, the console creates `master.key` (mode 600) in its data folder and logs that it did, without the value. |
| `CONSOLE_SIGNUP` | no | `invite` (needs a code from the admin command's `invite`) or `open`. Defaults to `invite` in production, where `open` is refused, and `open` in development. |
| `CONSOLE_WEBAUTHN_RP_ID` | no | The passkeys' relying party id: the host name of `CONSOLE_URL` (the default) or a parent domain of it. Passkeys made for one value do not work with another. |
| `CONSOLE_TRUST_PROXY` | no | `true` when a reverse proxy appends the client to `X-Forwarded-For` (Caddy in the hosted stack), so the sign-in, code and token limits key on the client. Defaults to `false`. |
| `CONSOLE_MANDATES_PER_WORKSPACE` | no | Most mandates a workspace may have, the first included, from 1 to 100. Defaults to `5`. Each mandate has one agent, so it bounds the agents too, and on the demo chain the contracts the console deploys and pays gas for. Past it, "New mandate" says so and the console answers 409 `mandate_limit`. |
| `CONSOLE_MANDATE_DEPLOYER` | no | Who deploys a new mandate's Policy contract: `server` (the console, from an owner key it creates and seals for that mandate; owner actions then take a passkey) or `wallet` (the owner's own wallet, from the mandate's Setup page). Defaults by network: `server` on the local and demo chains, `wallet` on Arc. See [accounts.md](accounts.md#where-the-contract-comes-from). |
| `CONSOLE_MANDATE_EXECUTOR` | no | The executor a new mandate's contract names. Defaults to the executor of the server's own contract, so one executor serves every mandate. On Arc this default is not yet proven with two mandates on the testnet. |
| `CONSOLE_POLICY_ARTIFACTS_DIR` | no | Where the compiled Policy contracts are, as `forge build` writes them. Defaults to `devchain/out` in a checkout (`npm run dev:chain` builds it); the console image sets it to the copy it takes from the contracts build. Without them the console cannot deploy or check a new mandate's contract. |
| `CONSOLE_EVENT_SOURCE` | no | `rpc` (default) polls the chain for Policy events. `stream` takes the QuickNode Stream webhook as the primary source and keeps a slow RPC poll to fill gaps. |
| `CONSOLE_POLL_INTERVAL_MS` | no | How often the RPC poller asks for new blocks. Defaults to 250 ms on the local devchain and 1 s on Arc testnet. The hosted demo chain sets 1 s. |
| `GEMINI_API_URL` | no | Gemini's public REST API, which the console reads (server side, cached for 10 s, no key) for the hedge view's live ladder and preview, and to check each intent's market against Gemini's listing (once per market, in the background; the answer is stored, so each market costs one lookup ever). For ladders it only asks about assets Gemini lists and the events of plans the console stores, and keeps at most 32 ladders. Listing checks have a budget of their own inside the client's 100 requests a minute: at most 24 requests in any 60 s and 12 a minute sustained, counted as the most each lookup could send (4 candidate event tickers, each tried twice) until it says what it sent. Intents waiting for approval are checked first, then the newest, and the queue never holds more than the intents the console shows. So a stream of invented markets from a stolen agent key is checked at one every 40 s and leaves the hedge view at least 81 requests a minute: a public console cannot be made to spend its Gemini rate limit. By default it is the host of the stack's Gemini environment (see [One Gemini for the whole stack](#one-gemini-for-the-whole-stack)): `https://api.gemini.com`, or `https://api.sandbox.gemini.com` when `EXECUTOR_VENUE=gemini`. Set it only to that same host or to a loopback address (`http://127.0.0.1:<port>`); any other host is refused, naming the settings, because it would read one exchange while the executor trades on another. The end-to-end tests point it at a local server that replays recorded responses. The MCP server, the signal API and the dev scripts follow the same rule: `dev:executor` checks approved intents against it and `dev:propose` picks its default market from it. |
| `MCP_PUBLIC_URL` | no | Public address of the MCP server, shown on the console's Setup page so the owner can add it to Grok Bot. When it is not set, Setup asks the MCP server on the console's machine (at `MCP_HOST` and `MCP_PORT`) and shows its local address, or the public address a tunnel (`npm run dev:tunnel`) last reached it at. |
| `NEXT_PUBLIC_DEV_SIGNER` | no | `1` adds a test-only owner signer (anvil account 0, a public key) for end-to-end tests and local demos. It is read at build time. Never set it in a deployed build that runs on Arc testnet; the hosted demo chain sets it and keeps the whole console behind sign-in. |
| `CONSOLE_BROWSER_RPC_URL` | no | Local devchain only: the RPC address the browser uses, when it cannot reach the chain at the deployment file's address. The hosted demo chain sets it to `https://<host>/rpc`, which Caddy forwards to anvil for members of the first workspace only. |

The network is not a build setting: the console decides it at runtime from the Chain variables above, and the browser follows.

## One Gemini for the whole stack

The sandbox lists other strikes than production (8 of 21 on one BTC ladder) and has its own books and spot price.
A stack that planned on one and traded on the other would propose strikes the executor cannot place.
So every part that reads Gemini's public market data follows one rule (`marketDataSource` in `@mandate/gemini`), from the same two settings:

| `EXECUTOR_VENUE` | `GEMINI_ENV` | Market data for the console, the MCP server, the signal API and the executor |
| --- | --- | --- |
| `simulated` or unset | ignored | `https://api.gemini.com` (production's live prices; nothing is placed anywhere) |
| `gemini` | `sandbox` or unset | `https://api.sandbox.gemini.com` |
| `gemini` | `production` | `https://api.gemini.com` (real money; the dev and demo executor refuses it) |

Give all four services the same `EXECUTOR_VENUE` and `GEMINI_ENV`; the demo compose file does.
Each logs the environment it reads when it starts, and the parts check each other:

- The console's `GET /api/health` names its environment (`marketEnvironment`), and answers 503 while its settings contradict each other (for example a `GEMINI_API_URL` on another host), so its container never turns healthy.
- The executor announces its venue and environment to the console at start. A console that reads another Gemini refuses it (409 `environment_mismatch`, naming both sides' settings), and the executor stops. On Gemini, it trades nothing before the console has agreed.
- Before proposing onchain, the MCP server asks the console's health; when it names another Gemini, nothing is proposed and the tool answers `MARKET_ENVIRONMENT_MISMATCH` with both sides' settings. A console that does not answer does not stop a proposal.
- Before paying for a signal, the MCP server asks the signal API's free `GET /health` (`marketEnvironment`); when it names another Gemini, nothing is signed or paid (`MARKET_ENVIRONMENT_MISMATCH`).

## Executor

The executor (`npm run dev:executor`, and the `executor` service of the hosted demo chain and of Arc testnet) fills approved intents and settles filled positions at expiry; [order-lifecycle.md](order-lifecycle.md) explains both, and [gemini-venue.md](gemini-venue.md) the Gemini venue.

| Variable | Required | Meaning |
| --- | --- | --- |
| `CONSOLE_URL` | no | The console the executor records settlements in, through `PUT /api/executor/v1/settlements/:intentId`, and, on Gemini, its order journal and venue (`/api/executor/v1/orders/:intentId`, `/api/executor/v1/venue`). Defaults to `http://localhost:3000`; the compose files set `http://console:3000`, inside the stack. The route is not public: Caddy answers 404 for `/api/executor/*`. |
| `EXECUTOR_VENUE` | no | What fills approved orders: `simulated` (default, places nothing anywhere) or `gemini` (Gemini Prediction Markets, on the sandbox unless `GEMINI_ENV` says otherwise; the dev and demo executor refuses production). Run `npm run gemini:doctor` first. |
| `EXECUTOR_ORDER_TTL_MS` | no | `gemini` only: how long an order may rest unfilled before the rest is cancelled, at least `10000`. Defaults to `600000` (10 minutes), and never later than a minute before the market stops trading. |
| `GEMINI_ENV` | no | `sandbox` (default, test funds) or `production` (real money, which also needs `GEMINI_LIVE_TRADING=on`). Read by the executor and `npm run gemini:doctor`, and, with `EXECUTOR_VENUE=gemini`, by every service that reads market data. |
| `GEMINI_LIVE_TRADING` | no | `on` to allow `GEMINI_ENV=production`; anything but `on` or empty is refused. The dev and demo executor refuses production even then, and the demo compose file does not pass it. |
| `GEMINI_API_KEY` | with `gemini` | An account-scoped API key with the Trader role, from a separate account on exchange.sandbox.gemini.com for the sandbox. A secret: never printed or logged. |
| `GEMINI_API_SECRET` | with `gemini` | The key's secret. Never printed or logged; the doctor shows only whether it is set and its length. |
| `EXECUTOR_SETTLE_MS` | no | How often the executor looks for a filled position that is due to be settled, at least `1000`. Defaults to `60000`. The look is local: Gemini and the console are asked only once a position's market has expired, then with waits of 1, 2, 5, 10 and then every 30 minutes while Gemini has not published the outcome. |
| `EXECUTOR_DISCOVERY_MS` | no | How often the executor asks the console which mandate contracts name it as their executor (`GET /api/executor/v1/contracts`, signed by its key), at least `1000`. Defaults to `15000`. It checks each contract's `executor()` onchain before serving it, and serves the server's own contract whatever the console says. |
| `SIM_EXECUTOR_DELAY_MS` | no | How long the executor waits after an approval before filling it. Defaults to `1500`. |
| `SIM_EXECUTOR_POLL_MS` | no | How often the executor asks the chain for new approvals and fills. Defaults to `1000`. |

## Grok Bot event wake-ups

The console starts Grok Bot's routine through its webhook when an event is worth a run (issue #40); [event-wake.md](event-wake.md) says which events, the body it posts and the limits.
The URL and the key are secrets: some products put a secret in the URL's path, so neither is ever logged, shown or put in an error.

| Variable | Required | Meaning |
| --- | --- | --- |
| `GROK_WEBHOOK_URL` | for wake-ups | The "POST to" URL from the routine's Webhook section in Grok Bot. Empty: wake-ups are off, and the rest of the stack runs as before. |
| `GROK_WEBHOOK_KEY` | for wake-ups | The routine's webhook key, sent as `Authorization: Bearer <key>`. Empty: wake-ups are off. |
| `GROK_WAKE_DAILY_CAP` | no | Most wake-ups the console sends per UTC day, from 0 to 1000. Defaults to `12`, half again the 24 runs of an hourly schedule. |
| `GROK_WAKE_PRICE_CHECK_MS` | no | Least time between two checks of Gemini's spot against the current goal, at least `1000`. Defaults to `300000` (5 minutes). The check rides on the console's chain poll, so it adds no timer. |
| `GROK_WAKE_TEST_CLOCK` | no | `on` runs the wake-ups on a clock the end-to-end tests move forward through `POST /api/dev/wake-clock` (with the service token), so a debounce window ends when a test says so. For tests only: the console refuses to start with it in production. Defaults to `off`. |

## Landing page

The landing page (`site/`) is a static export: `npm run build -w @mandate/site` writes `site/out`, which any static file server can serve.
It has no server, no secrets, no cookies and no analytics.
Its settings are public and read at build time only, so changing one means building again.
`next.config.ts` checks them and the build fails on a malformed value.

| Variable | Required | Meaning |
| --- | --- | --- |
| `NEXT_PUBLIC_APP_URL` | no | The console's public address. "Launch app" links to it, and the scorecard link is built from it. Defaults to `http://localhost:3000`. |
| `NEXT_PUBLIC_SCORECARD_AGENT` | no | The agent address whose public scorecard (`<app>/agent/<address>`) the page links to. Defaults to `0x70997970C51812dc3A010C7d01b50e0d17dc79C8`, the devchain agent (anvil account 1), which the local stack and the hosted demo chain use. |
| `NEXT_PUBLIC_REPO_URL` | no | The repository's address, linked from the footer as "Source on GitHub". Empty (the default) hides the link, so linking the source is a deliberate choice. |
| `NEXT_PUBLIC_SITE_URL` | yes, when hosted | The landing page's own public address, such as `https://mandate.example`. Link previews (Open Graph and Twitter cards) need absolute URLs, so the preview image and the page address are built from it. Defaults to `http://localhost:3001`, the local stack's site, which is wrong anywhere else; `deploy/build-site.sh` therefore refuses to build without it (or a named `MANDATE_SITE_ADDRESS`). |

`npm run dev:stack` starts the page on port 3001 (`--site-port` changes it, `--no-site` skips it) with the console, agent and site addresses set to the stack's own.
The icons (`favicon.ico`, `icon.svg`, `apple-icon.png`) come from `brand/icons`, shared with the console; `npm run icons -w @mandate/brand` redraws them, and `npm run og -w @mandate/site` redraws the link preview image.
`npm run e2e -w @mandate/site` builds `site/out` with example settings for its tests, so build again before deploying from the same folder.

## Hosting

The hosted setup in [hosting.md](hosting.md) reads one file, `deploy/.env`, which [`deploy/mandate.env.template`](../deploy/mandate.env.template) describes line by line.
Besides the variables on this page it uses `COMPOSE_FILE` (demo chain or Arc testnet, and optionally gateway mode and the landing page), `MANDATE_HOST` (the public hostname), `MANDATE_PUBLIC_URL`, `MANDATE_HTTP_PORT`, `MANDATE_HTTPS_PORT`, `MANDATE_APP_PORT`, `MANDATE_SITE_PORT`, `MANDATE_BIND_ADDRESS`, `MANDATE_SITE_ADDRESS` and `MANDATE_SITE_DIR` (the ports and addresses), and for the demo chain `DEVCHAIN_CONTRACT` (which contract it deploys), `ANVIL_STATE_INTERVAL` (seconds between saves of the chain) and `SIM_EXECUTOR_POLL_MS` (how often the simulated executor polls).
The compose files set the addresses between the services, the data folders and the listening interfaces themselves, run the console with `CONSOLE_MODE=production`, and set `CONSOLE_TRUST_PROXY` and `MCP_TRUST_PROXY` to `true`, because Caddy sits in front of both.
Env files from before workspaces may still hold `CONSOLE_USER` and `CONSOLE_PASSWORD_HASH`; nothing reads them any more.

## QuickNode Streams

| Variable | Required | Meaning |
| --- | --- | --- |
| `QUICKNODE_API_KEY` | for Streams | API key used to create and manage the Stream. The console does not use it. |
| `QUICKNODE_STREAM_SECURITY_TOKEN` | for Streams | Token QuickNode signs webhook deliveries with. The console's webhook at `/api/webhooks/quicknode` verifies every delivery with it and refuses all deliveries while it is unset. |

## x402 signal API (Circle Nanopayments on Arc testnet)

Create both keys with `npm run x402:keygen`.

| Variable | Required | Meaning |
| --- | --- | --- |
| `X402_BUYER_PRIVATE_KEY` | yes | Plain wallet key (EOA) that pays for signals. Fund its address at faucet.circle.com on Arc Testnet. |
| `X402_SELLER_PRIVATE_KEY` | one of | Identifies the address that receives payments. |
| `X402_SELLER_ADDRESS` | one of | Receive payments at this address instead of the one derived from the seller key. |
| `X402_FACILITATOR_URL` | no | Defaults to Circle's testnet Gateway API. |
| `SIGNALS_PORT` | no | Port of the signal API. Defaults to `4021`. |
| `SIGNALS_URL` | no | Address the agent calls for signals. Defaults to `http://localhost:4021`. |
| `SIGNALS_HEDGE_PRICE_USD` | no | Price of one hedge signal in dollars, a fraction of a cent from `0.000001` to `0.009999`. Defaults to `0.001`. |
| `SIGNALS_ASSETS` | no | Comma-separated assets the signal API sells hedge signals for. Defaults to every asset the Gemini client knows. |
| `SIGNALS_FAIR_BAND_CENTS` | no | Edge, either way, below which protection counts as fairly priced, from 1 to 50 cents. Defaults to `2`. |
| `SIGNALS_VOL_WINDOW_HOURS` | no | Hours of history behind the realised volatility, ending at the newest closed hourly candle, from 24 to 1000. Defaults to `168` (one week). Hours missing from Gemini's candles are skipped, so the signal states the returns it used and `missingHours`. |
| `SIGNAL_DAILY_BUDGET_USDC` | no | Most the MCP server's `buy_signal` tool spends per UTC day. Defaults to `0.02`. |
| `SIGNAL_MAX_PRICE_USDC` | no | Most `buy_signal` pays for one signal; checked before anything is signed. At most the daily budget. Defaults to `0.005`. |
| `AGENT_DATA_DIR` | no | Where the MCP server keeps its signal spend ledger and purchased signals. Defaults to `.data/agent`, which is git-ignored. |

The MCP server reads `X402_BUYER_PRIVATE_KEY` too: with it, `buy_signal` pays from that wallet's Circle Gateway balance; without it, `buy_signal` answers `unavailable`.
With `CONSOLE_SERVICE_TOKEN` set as well, the MCP server reports each payment and the signal budget to the console (see [agent/README.md](../agent/README.md#payment-reports-to-the-console)).
The server never deposits; top the Gateway balance up as described in [x402.md](x402.md).
