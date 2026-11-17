# Accounts

Mandate is a multi-user product: people sign in to their own workspace with a passkey, and each agent reaches its own mandate with its own token.
This page describes the model, how each request is scoped, the threat model, and how a production deployment should hold keys and secrets.
It covers phase 1 of 3 (issue #94); phase 2 (#95) adds several mandates per workspace and phase 3 (#96) adds members and roles.

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
  Phase 1 keeps one mandate per workspace, but every record, route and token lookup is keyed by mandate.
- An **agent** has its own onchain key and one or more **agent tokens**.
  A token is what an MCP client presents as `Authorization: Bearer <token>`; it decides which agent, and so which mandate, a call acts on.
- **Records** the console keeps (holdings, decision contexts, hedge plans, intent-to-context links, pairing, change requests, signal payments and budget, and event wake-ups) carry the mandate they belong to.
  The Policy event cache stays keyed by deployment, because events are public chain data; a mandate names the deployment it follows.
- **The executor's records** stay keyed by deployment too: what each filled position paid at settlement, the journal of each intent's venue order, and the venue the executor announced.
  They describe one Policy contract and the executor that fills its orders, not a mandate, and a contract has one executor whichever mandate follows it.
  The executor signs each of them, and the console reads them only for the mandate that follows that deployment, so a mandate without a contract sees none: no venue badge, no order fields in Advanced view, no settlements.
  When phase 2 gives other mandates their own contracts, each one's executor records come with its deployment, with no new key.

### Event wake-ups

Event wake-ups ([event-wake.md](event-wake.md)) belong to a mandate: each wake-up, each trigger it carries and each price check's memory has the mandate in its key, and the daily cap counts one mandate's wake-ups.
Phase 1 has one webhook, the one in `GROK_WEBHOOK_URL` and `GROK_WEBHOOK_KEY`, and sends wake-ups only for the mandate that follows the server's contract, from its chain events and its own plans and holdings.
Only that mandate's agent marks a run in progress, so another workspace's agent cannot hold back its wake-ups.
Every other mandate's Setup page shows wake-ups as off, with that reason.
Phase 2 adds a webhook per mandate, which needs no new key.

### Where the contract comes from

A mandate's `deployment` says which Policy contract it follows:

- `env`: the contract the server is configured with (`POLICY_ADDRESS`, or the devchain or demo chain deployment file).
  Exactly one mandate can follow it: the first one, which the migration creates from the single-tenant data.
- none: the mandate has no contract yet.
  Its console shows "no Policy contract" and its agent's tools answer `unavailable`.
  Phase 2 adds the "New mandate" flow that deploys a contract and records its address, chain and deploy block in the same row.

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
  In production it needs an invite code from the admin command's `invite`; in local development it is open unless `CONSOLE_SIGNUP=invite`.
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
| Console pages and `/api/console/*` | a signed-in member | the session's workspace, then the mandate named by `?mandate=` or the workspace's only mandate |
| `/api/console/events` | a signed-in member | the same; the stream carries only that mandate's snapshot |
| Owner writes (holdings, pairing, change requests) | a signed-in member | the session's mandate, and the wallet signature of that mandate's contract `user()` |
| `/api/auth/*` | anyone | ceremonies, rate limited per client and in total |
| `/mcp` | an agent token | the token's agent and mandate; an unknown or revoked token gets 401, and every token gets 503 while the console cannot be asked |
| `/api/agent/v1/*` (private network) | the MCP server | `CONSOLE_SERVICE_TOKEN`, plus the agent id in `X-Mandate-Agent`; every record read or written belongs to that agent's mandate |
| `/api/executor/v1/*` (private network) | the contract's executor | no session and no token: a settlement, a venue order version or a venue announcement is stored only when its signature recovers to the `executor()` of the server's contract, so it belongs to that deployment and only the mandate that follows it (the first workspace's) sees it, in its snapshot, its event stream and its agent's `GET /api/agent/v1/settlements`; `GET /api/executor/v1/orders/<intent>` returns that deployment's signed journal entry to the executor after a restart |
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
Signal purchases spend the operator's wallet, so in phase 1 only the agent of the mandate that follows the server's contract may buy signals; phase 2 gives each mandate its own budget.

The env-file token keeps working for the first mandate's agent until it is revoked (see [The env-file token](#the-env-file-token)).

### Rate limits

Every limit is a token bucket per client and one shared by everyone, so neither one client nor many can flood it; a refused request gets 429 with `Retry-After`.

| What | Per client | In total |
| --- | --- | --- |
| Passkey prompts: sign-in, sign-up, claim, recovery, a new passkey, and their answers | 20 at once, then 1 per 6 seconds | 300 at once, then 5 a second |
| Typed codes: invite, claim and recovery | 10 at once, then 1 per 30 seconds | 60 at once, then 1 a second |
| Token lookups that find no live token (the console's check) | 30 at once, then 1 per 2 seconds | 60 at once, then 1 a second |
| New agent tokens, per member | 10 at once, then 1 a minute | 100 at once, then 1 a second |
| Failed bearer tokens at `/mcp` (the MCP server's check, before it asks the console) | 30 at once, then 1 per 2 seconds | |
| Tool calls, per token | 60 at once, then 1 a second | |

The client is the right-most public address in `X-Forwarded-For` when the service is told it sits behind a proxy (`CONSOLE_TRUST_PROXY`, `MCP_TRUST_PROXY`); proxies append the peer they saw, so the addresses to its left are the client's own claim and cannot pick its bucket.
Without a trusted proxy every request shares one bucket and only the totals apply.
The buckets live in each process's memory, which is enough for one console and one MCP server.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `CONSOLE_MODE` | `production` when `NODE_ENV=production`, else `development` | Production refuses to start without a master key and refuses open sign-up. |
| `CONSOLE_MASTER_KEY_FILE` | unset | File holding the master key (32 bytes, base64 or base64url). Preferred: mount it as a Docker secret. |
| `CONSOLE_MASTER_KEY` | unset | The master key itself, for hosts whose secrets live in an env file. Set one of the two, not both. |
| `CONSOLE_SIGNUP` | `invite` in production, `open` in development | `invite` needs a code from `console:admin invite`; `open` lets anyone create a workspace. |
| `CONSOLE_WEBAUTHN_RP_ID` | the host name of `CONSOLE_URL` | The passkeys' relying party id. |
| `CONSOLE_TRUST_PROXY` | `false` | `true` behind Caddy: rate limits key on the client address in `X-Forwarded-For`. |
| `MCP_TRUST_PROXY` | `false` | The MCP server's: `true` behind Caddy, so its failed-token limit keys on the client. |

In development, without a master key, the console creates one in its data directory (`master.key`, mode 600) and logs that it did, without the value.
The hosted stack passes `CONSOLE_MASTER_KEY` from its env file, which `deploy/init-env.sh` fills, so the key sits with the other secrets the operator already keeps and backs up apart from the data volume; how to upgrade a hosted machine is in [hosting.md](hosting.md#upgrade-to-workspaces-once).

## Threat model

- **A stolen agent token** reaches only its own mandate through the MCP server: it can propose inside the contract's rules, read that mandate's holdings, plans and activity, and file a change request.
  It cannot read or write another workspace, sign in to the console, create or revoke tokens, approve, change rules, or make its key sign anything but a proposal to its own contract.
  The owner revokes it in Setup, and it stops working on its next call.
- **A stolen session cookie** acts as that member until it expires or they sign out; it is `HttpOnly`, so page scripts cannot read it.
  An event stream opened with it ends with the session: at once on sign-out, and at its next snapshot or 15-second heartbeat otherwise.
- **Another workspace's member** cannot name a foreign mandate: every route takes the mandate from the session, and a `?mandate=` that is not the session's is 404, the same answer as one that does not exist.
- **Guessing codes and tokens** is hopeless at 120 to 256 bits, and sign-in, sign-up, claim, recovery and token checks are rate limited besides.
- **Timing** tells nothing about a token or code: the store looks them up by the SHA-256 of what was presented, never by the secret, so how long a lookup takes depends on a hash an attacker cannot steer toward a stored one; the service token is compared in constant time.
- **The executor's route** (`/api/executor/v1/*`) takes no session and no token, so neither can be stolen for it: a settlement is stored only when its signature recovers to the contract's `executor()`.
  Caddy answers 404 for it from outside, and forward auth never sees it.
- **Cross-site requests** cannot write: `SameSite=Lax`, the `Origin` check on every write, and Caddy's refusal of cross-site requests that are not navigations.
- **A copy of the database** holds no usable secret: hashes of tokens, sessions and codes, passkey public keys, and agent keys encrypted under a master key that is not in the database.
- **A copy of the master key and the database together** reveals the agent keys; that is why production keeps them apart.
- **Logs, errors, the snapshot and the event stream** carry no token, key, code or session id; a test (`dashboard/src/server/accounts/redaction.test.ts`) proves it.
- **The demo chain's owner key is public** (anvil account 0, the dev signer), so on the demo chain the session is what protects the owner's routes and `/rpc`, not the wallet.

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
