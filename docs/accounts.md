# Accounts

Mandate is a multi-user product: people sign in to their own workspace with a passkey, and each agent reaches its own mandate with its own token.
This page describes the model, how each request is scoped, the threat model, and how a production deployment should hold keys and secrets.
It covers phases 1 (issue #94, workspaces) and 2 (#95, several mandates per workspace) of 3; phase 3 (#96) adds members and roles.

## The model

```mermaid
erDiagram
    WORKSPACE ||--o{ MEMBER : has
    MEMBER ||--o{ PASSKEY : "signs in with"
    MEMBER ||--o{ SESSION : "is signed in by"
    WORKSPACE ||--o{ MANDATE : runs
    MANDATE ||--|| AGENT : "has exactly one"
    AGENT ||--o{ AGENT_TOKEN : "is reached with"
    MANDATE ||--o{ RECORDS : "holdings, plans, contexts, pairing, change requests, payments"
```

- A **workspace** is the unit of isolation: nothing is readable or writable across workspaces.
- A **member** belongs to one workspace and signs in with one or more **passkeys**.
  Phase 1 has one member per workspace; the `role` column exists (every member is `admin`) so phase 3 is additive.
- A **mandate** is one Policy contract with its rules, its holding and exactly one agent, because the contract has one `user`, one `agent` and one `executor` (`docs/contract-interface.md`).
  "Several agents" therefore means several mandates.
  A workspace may have up to `CONSOLE_MANDATES_PER_WORKSPACE` mandates (5 by default), the first included, and every record, route and token lookup is keyed by mandate.
  Each mandate has its own contract, agent key, tokens, rules, holdings, approvals, settlements, venue journal, signal budget and cover; they share nothing but the workspace and the executor key.
- An **agent** has its own onchain key and one or more **agent tokens**.
  A token is what an MCP client presents as `Authorization: Bearer <token>`; it decides which agent, and so which mandate, a call acts on.
- **Records** the console keeps (holdings, decision contexts, hedge plans, intent-to-context links, pairing, change requests, signal payments and budget, and event wake-ups) carry the mandate they belong to.
  The Policy event cache stays keyed by deployment, because events are public chain data; a mandate names the deployment it follows.
- **The executor's records** stay keyed by deployment too: what each filled position paid at settlement, the journal of each intent's venue order, and the venue the executor announced.
  They describe one Policy contract and the executor that fills its orders, not a mandate, and a contract has one executor whichever mandate follows it.
  The executor signs each of them, and the console reads them only for the mandate that follows that deployment, so a mandate without a contract sees none: no venue badge, no order fields in Advanced view, no settlements.
  Each mandate's own contract brings its executor records with its deployment, with no new key: one executor key serves every contract (see [One executor](#one-executor)).

### Event wake-ups

Event wake-ups ([event-wake.md](event-wake.md)) belong to a mandate: each wake-up, each trigger it carries and each price check's memory has the mandate in its key, and the daily cap counts one mandate's wake-ups.
Phase 1 has one webhook, the one in `GROK_WEBHOOK_URL` and `GROK_WEBHOOK_KEY`, and sends wake-ups only for the mandate that follows the server's contract, from its chain events and its own plans and holdings.
Only that mandate's agent marks a run in progress, so another workspace's agent cannot hold back its wake-ups.
Every other mandate's Setup page shows wake-ups as off, with that reason.
The webhook stays with the first mandate in phase 2: the wake-up's links open that mandate's pages (`/m/<id>/hedge`), and a test proves that nothing another mandate's contract or settlements do reaches it.
Issue #112 adds a webhook per agent, which needs no new key.

### Where the contract comes from

A mandate's `deployment` says which Policy contract it follows:

- `env`: the contract the server is configured with (`POLICY_ADDRESS`, or the devchain or demo chain deployment file).
  Exactly one mandate can follow it: the first one, which the migration creates from the single-tenant data.
- `server`: a contract the console deployed for the mandate, on the demo chain.
  The console holds the contract's owner key (its `user()`), sealed under the master key and bound to the mandate, and signs an owner call only after the member's passkey confirms that exact call (see [Owner actions and the passkey](#owner-actions-and-the-passkey)).
- `wallet`: a contract the owner's own wallet deployed, on Arc.
  The console checks the deployment transaction before it follows the contract: it succeeded on this chain and created the contract, its sender is the owner the contract names, its code is the compiled Policy contract, and it names this mandate's agent and the executor.
  The wallet stays the owner; the console holds no key for it.
- none: the mandate has no contract yet.
  Its console shows "no Policy contract", its Setup page offers to deploy one, and its agent's tools answer `unavailable`.

A mandate's contract never changes once it has one: `POST /api/console/mandates/<mandate>/deployment` answers 409 `has_contract` for any mandate whose `deployment` is set, the first mandate (`env`) included, whether it asks the console to deploy or names a wallet's transaction.

"New mandate" (`/mandates/new`) creates the mandate, its agent and the agent's first token, shown once with the steps to connect Grok Bot.
On the demo chain the console then deploys the contract with the first rules the passkey confirmed, in the same request; on Arc the owner's wallet deploys it from the new mandate's Setup page and signs the first rules itself.

Deployment sits behind one interface, so the choice is a setting (`CONSOLE_MANDATE_DEPLOYER`), not a code path:

| Deployer | Who sends the transaction | Owner of the contract | Status |
| --- | --- | --- | --- |
| `server` (demo chain default) | the console, from a key it creates per mandate | that key, sealed in the console | implemented and proven end to end |
| `wallet` (Arc default) | the owner's wallet, from the console page | the owner's wallet | implemented; the console checks the transaction before following the contract |
| a factory contract | the owner, through one factory call | the owner's wallet | not built: it needs Solidity, and `/contracts` is out of scope for #95 |

Both deployers take the compiled Policy contract from the contracts build (`CONSOLE_POLICY_ARTIFACTS_DIR`, or `devchain/out` in a checkout), never a hand-copied copy; the console image copies it from the build stage.
A factory would make one call deploy and register the contract onchain, so the console could find mandates from events rather than from its own table; it is a third implementation of the same interface when the contracts change.

### Owner actions and the passkey

On a `server` contract the console holds the owner key, so a session alone would be enough to move money.
It is not: approving or rejecting an intent, setting rules, resuming the agent, and the offchain owner requests (saving holdings, confirming the agent, dismissing a change request) each take a fresh passkey confirmation, and so does creating an agent token, on every mandate, because a token is a credential.

- The browser asks for a challenge for one action (`POST /api/console/step-up`), the member's passkey signs it, and the answer goes with the action itself.
- The challenge is bound on the server to the member, the workspace, the action with its exact arguments (the intent id, the rules, the token's name and agent) and, for a contract call, the mandate's contract and chain.
  An answer for one action confirms no other, on no other mandate, in no other workspace, for no other member.
- It is single use and lives 2 minutes; a replayed, expired or swapped answer gets 401 `step_up_refused`, and nothing changes.
- Pausing needs the session only, and so does revoking a token: both are the safe direction, and a pause must never wait for a device.
- Every owner action is recorded with the member and the passkey that confirmed it (none for a pause), and the Audit page lists them as "Owner actions".
- The page asks once per action, the button names what the passkey confirms ("Approve with passkey"), and a closed or failed prompt leaves the page as it was, with one plain sentence.
- An admin renames a mandate in Setup on the session alone (`PATCH /api/console/mandates/<mandate>`, the same rules as a new mandate's name), and the Audit page lists it as `mandate.rename` with the old and the new name.
  The passkey prompt's binding is the mandate id and contract, never the name, so a rename changes nothing a passkey confirmed, and an answer given before it still confirms the same action after it.
  The agent sees the new name on its next call (`whoami`), since the MCP server caches nothing; wake-up links name the mandate by id, so they need no change.

On a `wallet` contract (Arc, and the first mandate's demo contract, whose owner is the dev signer) the wallet signs owner calls as before, and the passkey is not asked.

#### Trade-off: who holds the owner key

| | Console-held key and passkey (`server`, demo chain) | Owner's wallet (`wallet`, Arc) |
| --- | --- | --- |
| Setup | none: the console deploys and pays the gas | the owner needs a funded wallet and signs the deployment |
| Each owner action | one passkey prompt | one wallet signature |
| Who can move money | someone with the member's session and passkey, or the master key and the database together | only the wallet's key |
| Recovery | the recovery code gets a new passkey; the contract is unchanged | lose the wallet, lose the owner role |
| Fit | demos and test funds | real funds |

The first workspace keeps its dev signer and `/rpc` as before, so the demo and the hosted stack work unchanged.
Real funds belong on a `wallet` contract, or on a console key held in an HSM or a custody provider behind the same signer interface.

### One executor

One executor key serves every mandate's contract, and each contract names it as its `executor()` (`CONSOLE_MANDATE_EXECUTOR`, by default the executor of the server's own contract).
The executor asks the console which contracts name it (`GET /api/executor/v1/contracts`, signed by its key and fresh within 5 minutes), checks each contract's `executor()` onchain before serving it, and looks again every `EXECUTOR_DISCOVERY_MS`.
For each contract it keeps a separate order journal and venue announcement, and it signs each settlement for that contract alone; one transaction lane orders its transactions, so two approvals on two contracts at the same moment never race for a nonce.
A Gemini client order id binds the chain, the contract, its deployment and the intent (`m-<20 hex digits of a hash of the chain, the whole address and the deploy block's hash>-<intent id>`, at most Gemini's 36 characters, see [gemini-venue.md](gemini-venue.md#safety-rules)), so intent 0 on two contracts gets two ids, even when one contract's address was ground to share the other's first digits.
The executor reads each contract's deploy block hash when it starts serving it, from the deploy block the console lists for that contract.
Because one Gemini account places every mandate's orders, the executor never matches an order by its terms when Gemini returns no client order id; it asks the owner to check Gemini instead.
On Arc the shared executor is the default but **not yet proven on the testnet**: it is an open point until a two-mandate run there.

### Agent keys and the signer interface

Every agent key sits behind one interface, `AgentSigner` in `@mandate/shared`: an address and `signTransaction`.
Callers never see a key.

- **Console key store** (`console` signer): the console creates the key when it creates the agent, and stores it with envelope encryption.
  A random 256-bit data key encrypts the private key with AES-256-GCM; the master key encrypts the data key with AES-256-GCM; both bind the agent id as additional data, so a ciphertext cannot be moved to another agent.
  The MCP server never holds these keys: it asks the console to sign, over the private network, with the service token and the agent id.
  The console signs only a transaction to its mandate's Policy contract, on its chain, calling `proposeTrade`, with no value, so even a compromised MCP server cannot make an agent key do anything an agent cannot already do.
- **Server key** (`env` signer): the key the MCP server is configured with (`AGENT_PRIVATE_KEY`, or the demo chain's agent).
  It signs for the first mandate's agent, so the live hosted agent keeps working after the upgrade.

A KMS, an HSM or a custody provider replaces the console key store by implementing `AgentSigner` behind the same signing route; nothing that proposes changes.

### Tokens and codes

| Secret | Made by | Shown | Stored as | Lifetime |
| --- | --- | --- | --- | --- |
| Agent token (`mdt_` and 43 characters, 256 bits) | the owner, in Setup, Agents | once | SHA-256 | until revoked |
| Env-file token (`MCP_AUTH_TOKEN`) | the operator, on the server | never by the console | SHA-256, registered by the MCP server | until revoked in the console |
| Session id (256 bits) | the console, at sign-in | never (cookie only) | SHA-256 | 30 days, or 7 days unused |
| Passkey prompt (ceremony) id (256 bits) | the console, when a prompt starts | never (cookie only) | SHA-256 | 5 minutes, single use |
| Claim code (120 bits) | the operator, with the admin command's `claim-code` | once, in the operator's terminal | SHA-256 | 24 hours, single use |
| Invite code (120 bits) | the operator, with the admin command's `invite` | once, in the operator's terminal | SHA-256 | 7 days, single use |
| Recovery code (120 bits) | the console, after a passkey is registered | once | SHA-256 | until used; a new one is shown then |

Every secret is high-entropy, so a plain SHA-256 is enough and lookups are by hash.
A lookup by hash leaks nothing about the secret through timing: an attacker cannot choose inputs whose hashes approach a stored one.
Where a secret is compared rather than looked up (the env-file token, the service token), the comparison hashes both sides and uses `timingSafeEqual`.
A token's name is shown in the Agents list, so a name that contains `mdt_` (a token pasted into the wrong field) is refused.

The admin command runs on the server, next to the console's database: `npm run console:admin -- claim-code` (or `invite`, or `status`) in a checkout, and `docker compose exec console node dashboard/admin.mjs claim-code` in the hosted console, whose image carries it bundled into one file.
It prints the code to standard output and everything else to standard error, so the code can be piped without the instructions.

### The env-file token

`MCP_AUTH_TOKEN` keeps the hosted agent working through the upgrade.
The MCP server presents it to the console with `legacy: true`, and the first time it does, the console stores its hash as the first mandate's agent's token, named after the env file; from then on the console decides about it like any other token, and the Agents section lists it with when it was last used.
That registration happens once: when the first mandate's agent has an env-file token, revoked or not, a different `MCP_AUTH_TOKEN` is never accepted, so a revoked token cannot come back by editing a file.
The legacy flag never makes a console-issued token act as the env-file one, nor the other way round.

## Sign-in

Sign-in is a passkey (WebAuthn), with no password, no email and nothing secret stored on the server: a passkey's public key, its id and its counter.
The server side uses `@simplewebauthn/server` and the browser side `@simplewebauthn/browser`.
User verification is required, and passkeys are discoverable, so signing in asks for nothing but the passkey.

- **Claim** (`/claim`): the first workspace holds the data that existed before accounts.
  The operator runs the admin command's `claim-code` on the server; it prints a one-time code once and stores only its hash.
  Whoever enters the code and registers a passkey becomes that workspace's member.
  Until then nobody can see the workspace's data.
  Once it is claimed, `/claim` sends visitors to sign in, since no claim code can work again.
- **Sign-up** (`/sign-up`): creates a new workspace with one mandate (no contract yet) and its agent.
  It is open to anyone by default, the hosted demo included; with `CONSOLE_SIGNUP=invite` it needs an invite code from the admin command's `invite`.
- **Sign-in** (`/sign-in`): one button, which asks the browser for a passkey of this site.
- **Recovery** (`/recover`): the recovery code shown after sign-up or claim signs the member in once and asks for a new passkey; using it shows a new code.
  A member can also add a second passkey in Setup, so losing one device does not lock them out.
- **Sign-out** ends the session on the server and clears the cookie.

Each flow starts with its own route (`POST /api/auth/claim`, `/api/auth/sign-up`, `/api/auth/recover`, `/api/auth/sign-in`, and `POST /api/console/passkeys` for a second passkey), which checks the code or the session and answers the passkey options.
Every new passkey then comes back to `POST /api/auth/register`, and a sign-in's answer to `POST /api/auth/sign-in/verify`; the purpose of the prompt is kept on the server, so the browser cannot change it in between.
The relying party id and origin come from settings: the origin is `CONSOLE_URL` and the relying party id its host name, unless `CONSOLE_WEBAUTHN_RP_ID` names a parent domain.
That works on `http://localhost`, in the end-to-end suites and on `https://8080-<id>.instabox.tech`.
Passkeys belong to the relying party id, so changing the public name means registering passkeys again (through recovery).

### Sessions

A session is a row on the server, referenced by a random id in the cookie `__Host-mandate_session`: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`.
On plain-HTTP `localhost`, where browsers refuse `Secure` cookies and the `__Host-` prefix, the cookie is `mandate_session` without `Secure`.
A passkey prompt's id travels the same way in `__Host-mandate_ceremony` (`mandate_ceremony` on `localhost`), `SameSite=Strict`, for 5 minutes.
Only the id's hash is stored, so a copy of the database cannot be used to sign in.
A new id is issued at every sign-in, sign-up, claim and recovery, and a ceremony's challenge lives in its own short-lived cookie and server row, so a session id can never be fixed in advance.
`Lax` lets the pairing link from Grok Bot's chat open the console signed in; every write is a `POST`, `PUT` or `DELETE`, which `Lax` never sends cross-site, and every write must also carry an `Origin` header equal to `CONSOLE_URL`.

## How each request is scoped

| Surface | Who | Scoped by |
| --- | --- | --- |
| Console pages (`/m/<mandate>/...`) | a signed-in member | the session's workspace, then the mandate in the path; another workspace's mandate is 404, the same answer as one that does not exist |
| Workspace pages (`/`, `/mandates/new`) | a signed-in member | the session's workspace; creating a mandate needs an admin, a passkey and room under the cap |
| Old links (`/approvals`, `/setup/pair/<address>`) | a signed-in member | sent to the same page of the workspace's first mandate, or of the mandate whose agent the pairing link names |
| `/api/console/*` | a signed-in member | the session's workspace, then the mandate named by `?mandate=` (every write must name it) or the workspace's first mandate |
| `/api/console/events` | a signed-in member | the same; the stream carries only that mandate's snapshot |
| Owner writes (approvals, rules, holdings, pairing, change requests) | a signed-in member | the named mandate, and either the passkey confirming that exact action (a `server` contract) or the wallet signature of that mandate's contract `user()` |
| `/api/auth/*` | anyone | ceremonies, rate limited per client and in total |
| `/mcp` | an agent token | the token's agent and mandate; an unknown or revoked token gets 401, and every token gets 503 while the console cannot be asked |
| `/api/agent/v1/*` (private network) | the MCP server | `CONSOLE_SERVICE_TOKEN`, plus the agent id in `X-Mandate-Agent`; every record read or written belongs to that agent's mandate |
| `/api/executor/v1/*` (private network) | the contracts' executor | no session and no token: a settlement, a venue order version or a venue announcement names its contract and is stored only when its signature recovers to that contract's `executor()`, so it belongs to that deployment and only the mandate that follows it sees it, in its snapshot, its event stream and its agent's `GET /api/agent/v1/settlements`; `GET /api/executor/v1/orders/<intent>?chainId=&policy=` returns that contract's signed journal entry after a restart, and `GET /api/executor/v1/contracts` lists the contracts that name the signing key |
| `/agent/<address>` | anyone | onchain data of the mandate whose agent is that address, nothing offchain |
| `/rpc` (demo chain) | a signed-in member of the workspace that holds the demo chain's mandate | Caddy asks the console (`forward_auth`) before it forwards to anvil |

The MCP server resolves the token of every request by asking the console (`POST /api/agent/v1/auth/resolve` with the token's SHA-256, never the token).
It caches nothing, so a revoked token stops on its next call; the lookup is one indexed read on the private network.
When the console cannot be asked, the MCP server refuses the call (503 with `Retry-After`) rather than guess, and it keeps no local copy of `MCP_AUTH_TOKEN` to fall back on.
The lookup has its own bound of 5 seconds, headers and body, before the tool call's deadline (`MCP_TOOL_DEADLINE_MS`) starts: a console that does not answer in time gets the request a 503 that says so and one `http.auth_unavailable` log line, so a slow console cannot hold MCP requests open.
A request then takes at most that bound, the tool deadline and its 3-second unwind, 48 seconds at the largest deadline, under the 60 seconds MCP clients wait.
A workspace agent's proposal is signed by the console inside the call, so the call's deadline stops the signing request as it stops the call's other requests.
Each agent gets its own policy client, plan store and proposal ledger in the MCP server, so a plan id or a retried proposal of one agent means nothing to another.
`whoami` names the agent and mandate a token reaches.
Signal purchases spend the operator's wallet, so only the agent of the mandate that follows the server's contract may buy signals; each mandate's signal budget and payments are its own records, so a second payer per mandate needs no schema change.
The daily digest's numbers (`GET /api/agent/v1/summary`, and the sums `get_activity` and `get_portfolio` return) are read from the token's mandate only, and its links open that mandate's pages.

The env-file token keeps working for the first mandate's agent until it is revoked (see [The env-file token](#the-env-file-token)).

### Rate limits

Every limit is a token bucket per client and one shared by everyone, so neither one client nor many can flood it; a refused request gets 429 with `Retry-After`.

| What | Per client | In total |
| --- | --- | --- |
| Passkey prompts: sign-in, sign-up, claim, recovery, a new passkey, and their answers | 20 at once, then 1 per 6 seconds | 300 at once, then 5 a second |
| Typed codes: invite, claim and recovery | 10 at once, then 1 per 30 seconds | 60 at once, then 1 a second |
| Token lookups that find no live token (the console's check) | 30 at once, then 1 per 2 seconds | 60 at once, then 1 a second |
| New agent tokens, per member | 10 at once, then 1 a minute | 100 at once, then 1 a second |
| Passkey confirmations of owner actions, per member | 30 at once, then 1 per 2 seconds | 300 at once, then 5 a second |
| New mandates, per member (the cap bounds the total) | 5 at once, then 1 per 2 minutes | 50 at once, then 1 per 10 seconds |
| Failed bearer tokens at `/mcp` (the MCP server's check, before it asks the console) | 30 at once, then 1 per 2 seconds | |
| Tool calls, per token | 60 at once, then 1 a second | |

The client is the right-most public address in `X-Forwarded-For` when the service is told it sits behind a proxy (`CONSOLE_TRUST_PROXY`, `MCP_TRUST_PROXY`); proxies append the peer they saw, so the addresses to its left are the client's own claim and cannot pick its bucket.
Without a trusted proxy every request shares one bucket and only the totals apply.
The buckets live in each process's memory, which is enough for one console and one MCP server.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `CONSOLE_MODE` | `production` when `NODE_ENV=production`, else `development` | Production refuses to start without a master key. |
| `CONSOLE_MASTER_KEY_FILE` | unset | File holding the master key (32 bytes, base64 or base64url). Preferred: mount it as a Docker secret. |
| `CONSOLE_MASTER_KEY` | unset | The master key itself, for hosts whose secrets live in an env file. Set one of the two, not both. |
| `CONSOLE_SIGNUP` | `open` | `open` lets anyone create a workspace; `invite` needs a code from `console:admin invite`. |
| `CONSOLE_WEBAUTHN_RP_ID` | the host name of `CONSOLE_URL` | The passkeys' relying party id. |
| `CONSOLE_TRUST_PROXY` | `false` | `true` behind Caddy: rate limits key on the client address in `X-Forwarded-For`. |
| `MCP_TRUST_PROXY` | `false` | The MCP server's: `true` behind Caddy, so its failed-token limit keys on the client. |
| `CONSOLE_MANDATES_PER_WORKSPACE` | `5` | Most mandates a workspace may have, the first included (1 to 100). Each has one agent, so it bounds agents too; on the demo chain it bounds the contracts the console deploys and pays for. |
| `CONSOLE_MANDATE_DEPLOYER` | by network: `server` on the local and demo chains, `wallet` on Arc | Who deploys a new mandate's contract. |
| `CONSOLE_MANDATE_EXECUTOR` | the executor of the server's own contract | The executor a new contract names. |
| `CONSOLE_POLICY_ARTIFACTS_DIR` | `devchain/out` in a checkout | Where the compiled Policy contracts are; the console image sets it. |
| `EXECUTOR_DISCOVERY_MS` | `15000` | The executor's: how often it asks the console for new contracts that name it (at least 1000). |

In development, without a master key, the console creates one in its data directory (`master.key`, mode 600) and logs that it did, without the value.
The hosted stack passes `CONSOLE_MASTER_KEY` from its env file, which `deploy/init-env.sh` fills, so the key sits with the other secrets the operator already keeps and backs up apart from the data volume; how to upgrade a hosted machine is in [hosting.md](hosting.md#upgrade-to-workspaces-once).

## Threat model

- **A stolen agent token** reaches only its own mandate through the MCP server: it can propose inside the contract's rules, read that mandate's holdings, plans, activity, settlements and digest, and file a change request.
  It cannot read or write another mandate, even in the same workspace, nor another workspace; it cannot sign in to the console, create or revoke tokens, approve, change rules, or make its key sign anything but a proposal to its own contract.
  The agent routes take no mandate at all: the console derives it from the token, so there is nothing to point at another one.
  The owner revokes it in Setup, and it stops working on its next call.
- **A stolen session cookie** acts as that member until it expires or they sign out; it is `HttpOnly`, so page scripts cannot read it.
  Without the member's passkey it can read, pause the agent and revoke tokens, but on a `server` contract it cannot approve, reject, set rules, resume, save holdings, confirm an agent, create a token or create a mandate.
  An event stream opened with it ends with the session: at once on sign-out, and at its next snapshot or 15-second heartbeat otherwise.
- **Another workspace's member** cannot name a foreign mandate: every route takes the workspace from the session, and a `?mandate=` or `/m/<mandate>` that is not in it is 404, the same answer as one that does not exist.
  A passkey answer is bound to the workspace and the mandate's contract, so one for a member's own mandate confirms nothing on another.
- **Guessing codes and tokens** is hopeless at 120 to 256 bits, and sign-in, sign-up, claim, recovery and token checks are rate limited besides.
- **Timing** tells nothing about a token or code: the store looks them up by the SHA-256 of what was presented, never by the secret, so how long a lookup takes depends on a hash an attacker cannot steer toward a stored one; the service token is compared in constant time.
- **The executor's route** (`/api/executor/v1/*`) takes no session and no token, so neither can be stolen for it: a settlement is stored only when its signature recovers to the contract's `executor()`.
  Caddy answers 404 for it from outside, and forward auth never sees it.
- **Cross-site requests** cannot write: `SameSite=Lax`, the `Origin` check on every write, and Caddy's refusal of cross-site requests that are not navigations.
- **A copy of the database** holds no usable secret: hashes of tokens, sessions and codes, passkey public keys, and agent keys encrypted under a master key that is not in the database.
- **A copy of the master key and the database together** reveals the agent keys; that is why production keeps them apart.
- **Logs, errors, the snapshot and the event stream** carry no token, key, code or session id; a test (`dashboard/src/server/accounts/redaction.test.ts`) proves it.
- **The demo chain's owner key is public** (anvil account 0, the dev signer), so on the demo chain the session is what protects the first mandate's owner routes and `/rpc`, not the wallet.
  Mandates the console deploys have owner keys of their own, which never leave the console.
  The "Dev signer" badge shows only on a mandate whose owner is a wallet (the first mandate, or one an owner's wallet deployed), never on a mandate whose owner key the console holds, nor on Home or New mandate.
- **`/rpc` on the hosted demo** is anvil itself, behind Caddy's `forward_auth` (`GET /api/auth/forward/rpc`).
  A member of another workspace gets 403 there, and anvil has no other route from outside, so they cannot send a transaction signed with the public key at all, to the first mandate's contract or any other.
  A member of the first workspace, a viewer included, reaches all of anvil, with its test methods (`anvil_impersonateAccount`, `anvil_setStorageAt`, `anvil_setBalance`): they can act as any address on the chain, including the owner keys the console holds for other workspaces' contracts and the shared executor.
  On the demo chain that is by design, since nothing on it has value.
  **This blocks real funds**: real funds run on a `wallet` contract on Arc, where `/rpc` does not exist; a hosted stack that keeps the demo chain must not hold anything of value on it.
- **The console's owner keys** are sealed like agent keys, under labels of their own, so a sealed owner key never opens as an agent key or for another mandate; with the master key and the database together they are as exposed as the agent keys.
- **One Gemini account fills every mandate's orders**, so mandates share its balance, its positions and its rate limits.
  A client order id tells their orders apart, and the executor never guesses by terms, but the money is not separated at the venue.
  **This blocks real funds**: before them, each mandate needs its own venue account or subaccount, or the console must reconcile every fill per mandate against the venue.

## Production keys and secrets

This deployment is a demo on one machine.
A production deployment would hold its secrets like this:

- **Master key**: in a KMS (AWS KMS, Google Cloud KMS, Vault Transit), never on disk.
  The console would ask the KMS to unwrap each data key, so a copy of the machine is not enough.
  Short of a KMS, a file mounted as a Docker or Kubernetes secret (`CONSOLE_MASTER_KEY_FILE`), readable only by the console, kept out of backups of the data volume.
- **Agent keys**: in an HSM or a custody provider (Fireblocks, Turnkey, Circle Programmable Wallets) with its own policy engine, behind `AgentSigner`, so the private key never exists in our memory and the "only `proposeTrade` to this contract" rule is enforced twice.
- **Service token, Stream token, x402 buyer key**: in a secrets manager, injected at start, rotated on a schedule.
- **Sessions and rate limits**: in a shared store (Redis) once there is more than one console process.
- **The database**: encrypted at rest, backed up separately from the master key.
