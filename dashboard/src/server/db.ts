import "server-only";

import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type * as Sqlite from "node:sqlite";
import type { DatabaseSync } from "node:sqlite";

/**
 * The console's durable store: one SQLite file under `CONSOLE_DATA_DIR`, opened with Node's built-in
 * `node:sqlite`, so there is no native dependency to build.
 *
 * It holds:
 * - a cache of Policy contract events, keyed by deployment, transaction hash and log index, so
 *   repeated deliveries are ignored and a restart resumes instead of rescanning the chain;
 * - the offchain records the console is the system of record for: holdings, decision contexts, hedge
 *   plans, policy change requests, agent pairing and intent-to-context links, each keyed by mandate;
 * - accounts: workspaces, members, passkeys, sessions, mandates, agents and agent tokens, with every
 *   secret stored as a hash and every agent key sealed (docs/accounts.md);
 * - what Gemini said about each intent's market the first time the console checked it;
 * - the event wake-ups of each mandate's Grok Bot routine (docs/event-wake.md);
 * - what each filled position paid at settlement, as the executor signed it (the contract cannot hold it);
 * - the executor's journal of each intent's venue order, and the venue it announced.
 *
 * Settlements, venue orders and the executor's venue are keyed by deployment, like the event cache: they
 * describe one Policy contract and its executor, not a mandate. Only the mandate that follows that
 * contract (`deployment = 'env'`) sees them (docs/accounts.md).
 */
export type Database = DatabaseSync;

/**
 * Each entry upgrades the schema by one version, as SQL or as a function for steps that need values made
 * in code. A step that rebuilds a table other tables reference runs with foreign keys off, as SQLite's
 * procedure for changing a table requires, and must leave no broken reference (checked before it commits).
 * Never edit a shipped entry; append a new one.
 */
export type Migration = string | ((db: Database) => void) | { withoutForeignKeys: (db: Database) => void };

export const MIGRATIONS: readonly Migration[] = [
  `
  CREATE TABLE policy_events (
    deployment_id   TEXT    NOT NULL,
    tx_hash         TEXT    NOT NULL,
    log_index       INTEGER NOT NULL,
    block_number    INTEGER NOT NULL,
    block_timestamp INTEGER NOT NULL,
    type            TEXT    NOT NULL,
    payload         TEXT    NOT NULL,
    source          TEXT    NOT NULL,
    received_at     TEXT    NOT NULL,
    PRIMARY KEY (deployment_id, tx_hash, log_index)
  ) STRICT;
  CREATE INDEX policy_events_order ON policy_events (deployment_id, block_number, log_index);

  CREATE TABLE ingest_cursors (
    deployment_id TEXT    PRIMARY KEY,
    next_block    INTEGER NOT NULL,
    updated_at    TEXT    NOT NULL
  ) STRICT;

  CREATE TABLE intent_details (
    deployment_id TEXT    NOT NULL,
    intent_id     INTEGER NOT NULL,
    payload       TEXT    NOT NULL,
    PRIMARY KEY (deployment_id, intent_id)
  ) STRICT;

  CREATE TABLE holdings (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    payload    TEXT    NOT NULL,
    updated_at TEXT    NOT NULL
  ) STRICT;

  CREATE TABLE decision_contexts (
    hash      TEXT PRIMARY KEY,
    document  TEXT NOT NULL,
    stored_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE hedge_plans (
    plan_id      TEXT PRIMARY KEY,
    asset        TEXT NOT NULL,
    request_text TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    plan         TEXT NOT NULL,
    stored_at    TEXT NOT NULL
  ) STRICT;

  CREATE TABLE policy_change_requests (
    id              TEXT PRIMARY KEY,
    agent_address   TEXT NOT NULL,
    proposed        TEXT NOT NULL,
    reason          TEXT NOT NULL,
    status          TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    resolved_at     TEXT,
    applied_tx_hash TEXT
  ) STRICT;
  CREATE INDEX policy_change_requests_created ON policy_change_requests (created_at);

  CREATE TABLE pairings (
    agent_address  TEXT PRIMARY KEY,
    agent_name     TEXT NOT NULL,
    server_version TEXT NOT NULL,
    status         TEXT NOT NULL,
    announced_at   TEXT NOT NULL,
    confirmed_at   TEXT,
    confirmed_by   TEXT
  ) STRICT;
  `,
  // 2: which decision context explains which intent, for contracts that record no contextHash onchain.
  `
  CREATE TABLE intent_context_links (
    deployment_id TEXT    NOT NULL,
    intent_id     INTEGER NOT NULL,
    hash          TEXT    NOT NULL,
    tx_hash       TEXT    NOT NULL,
    linked_at     TEXT    NOT NULL,
    PRIMARY KEY (deployment_id, intent_id)
  ) STRICT;
  `,
  // 3: the agent's x402 signal payments (first write wins) and its latest signal budget snapshot (#22).
  `
  CREATE TABLE signal_payments (
    receipt_id  TEXT NOT NULL PRIMARY KEY,
    paid_at     TEXT NOT NULL,
    payment     TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX signal_payments_paid ON signal_payments (paid_at);

  CREATE TABLE signal_budget (
    id        INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
    as_of     TEXT    NOT NULL,
    snapshot  TEXT    NOT NULL,
    stored_at TEXT    NOT NULL
  ) STRICT;
  `,
  // 4: Gemini's listing of each market an intent named, as first checked (#71). First verdict wins.
  `
  CREATE TABLE market_listings (
    symbol     TEXT    NOT NULL PRIMARY KEY,
    listed     INTEGER NOT NULL,
    category   INTEGER,
    checked_at TEXT    NOT NULL
  ) STRICT;
  `,
  // 5: event wake-ups of the Grok Bot routine (#40): each wake-up, the triggers it carries (so a trigger
  // is offered once, across restarts), and what the last price check of each goal saw. Times in unix ms.
  `
  CREATE TABLE wake_deliveries (
    id               TEXT    NOT NULL PRIMARY KEY,
    kind             TEXT    NOT NULL,
    status           TEXT    NOT NULL,
    detail           TEXT    NOT NULL,
    count            INTEGER NOT NULL,
    occurred_at      INTEGER NOT NULL,
    created_at       INTEGER NOT NULL,
    due_at           INTEGER NOT NULL,
    attempts         INTEGER NOT NULL,
    attempted_at     INTEGER,
    sent_at          INTEGER,
    result           TEXT,
    counts_toward_cap INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX wake_deliveries_status ON wake_deliveries (status, due_at);
  CREATE INDEX wake_deliveries_created ON wake_deliveries (created_at);

  CREATE TABLE wake_sources (
    source_id   TEXT    NOT NULL PRIMARY KEY,
    delivery_id TEXT    NOT NULL,
    seen_at     INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE wake_price_memory (
    plan_id    TEXT    NOT NULL PRIMARY KEY,
    memory     TEXT    NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  `,
  // 6: what each filled position paid at settlement, signed by the executor (#92). First record wins.
  // Keyed by deployment, not mandate: a settlement belongs to the contract whose executor signed it, and
  // a mandate reads those of the deployment it follows.
  `
  CREATE TABLE settlements (
    deployment_id TEXT    NOT NULL,
    intent_id     INTEGER NOT NULL,
    hash          TEXT    NOT NULL,
    document      TEXT    NOT NULL,
    signature     TEXT    NOT NULL,
    signer        TEXT    NOT NULL,
    stored_at     TEXT    NOT NULL,
    PRIMARY KEY (deployment_id, intent_id)
  ) STRICT;
  `,
  // 7: the executor's journal of each intent's venue order, latest signed version only, and the venue it
  // announced (#93).
  `
  CREATE TABLE venue_orders (
    deployment_id TEXT    NOT NULL,
    intent_id     INTEGER NOT NULL,
    revision      INTEGER NOT NULL,
    hash          TEXT    NOT NULL,
    document      TEXT    NOT NULL,
    signature     TEXT    NOT NULL,
    signer        TEXT    NOT NULL,
    stored_at     TEXT    NOT NULL,
    PRIMARY KEY (deployment_id, intent_id)
  ) STRICT;

  CREATE TABLE executor_venues (
    deployment_id TEXT NOT NULL PRIMARY KEY,
    hash          TEXT NOT NULL,
    document      TEXT NOT NULL,
    signature     TEXT NOT NULL,
    signer        TEXT NOT NULL,
    stored_at     TEXT NOT NULL
  ) STRICT;
  `,
  // 8: accounts (#94). Workspaces, members, passkeys, sessions, mandates, agents and their tokens; every
  // offchain record and every wake-up record now belongs to a mandate. The single-tenant data becomes the
  // first workspace's mandate. Settlements and venue orders stay keyed by deployment (see above).
  // Every migration above is applied on the hosted database: never reorder them.
  migrateToAccounts,
  // 9: several mandates per workspace (#95). A mandate may now follow a contract of its own, deployed by
  // the console on the demo chain (with an owner key the console seals) or by the owner's wallet on Arc;
  // owner actions the console signs are recorded with the member and passkey that authorised them.
  { withoutForeignKeys: migrateToMandates },
];

/**
 * Version 9. Rebuilds `mandates` with its own contract: where it is (chain, address, deploy block), which
 * contract it is, the executor it names, who deployed it, and for a contract the console deployed, the
 * owner key it holds (sealed, like the agents' keys). Every mandate keeps its id, so every row that names
 * one still does. Adds `owner_actions`, the audit of the owner calls the console signed.
 */
function migrateToMandates(db: Database): void {
  db.exec(`
  CREATE TABLE mandates_v9 (
    id               TEXT    NOT NULL PRIMARY KEY,
    workspace_id     TEXT    NOT NULL REFERENCES workspaces (id),
    name             TEXT    NOT NULL,
    deployment       TEXT    CHECK (deployment IN ('env', 'server', 'wallet')),
    chain_id         INTEGER,
    policy_address   TEXT    CHECK (policy_address IS NULL OR policy_address GLOB '0x[0-9a-f]*'),
    deploy_block     INTEGER,
    contract_kind    TEXT    CHECK (contract_kind IN ('production', 'reference')),
    executor_address TEXT,
    owner_address    TEXT,
    sealed_owner_key TEXT,
    created_at       TEXT    NOT NULL,
    CHECK (COALESCE(deployment, '') NOT IN ('server', 'wallet')
      OR (chain_id IS NOT NULL AND policy_address IS NOT NULL AND deploy_block IS NOT NULL
          AND contract_kind IS NOT NULL AND executor_address IS NOT NULL AND owner_address IS NOT NULL)),
    CHECK (sealed_owner_key IS NULL OR COALESCE(deployment, 'server') = 'server'),
    CHECK (COALESCE(deployment, '') <> 'server' OR sealed_owner_key IS NOT NULL)
  ) STRICT;
  INSERT INTO mandates_v9 (id, workspace_id, name, deployment, chain_id, policy_address, deploy_block, created_at)
    SELECT id, workspace_id, name, deployment, chain_id, policy_address, deploy_block, created_at
    FROM mandates ORDER BY rowid;
  DROP TABLE mandates;
  ALTER TABLE mandates_v9 RENAME TO mandates;
  CREATE INDEX mandates_workspace ON mandates (workspace_id);
  CREATE UNIQUE INDEX mandates_env ON mandates (deployment) WHERE deployment = 'env';
  CREATE UNIQUE INDEX mandates_contract ON mandates (chain_id, policy_address) WHERE policy_address IS NOT NULL;

  CREATE TABLE owner_actions (
    id            TEXT NOT NULL PRIMARY KEY,
    mandate_id    TEXT NOT NULL REFERENCES mandates (id),
    member_id     TEXT NOT NULL REFERENCES members (id),
    credential_id TEXT,
    function_name TEXT NOT NULL,
    calldata      TEXT,
    status        TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
    tx_hash       TEXT,
    detail        TEXT,
    created_at    TEXT NOT NULL
  ) STRICT;
  CREATE INDEX owner_actions_mandate ON owner_actions (mandate_id, created_at);
  `);
}

/**
 * Version 8. Creates the account tables, then the first workspace (unclaimed: no member yet), its mandate
 * (which follows the contract the server is configured with) and that mandate's agent (whose key the MCP
 * server holds), and moves every existing offchain row into that mandate without losing one.
 */
function migrateToAccounts(db: Database): void {
  db.exec(`
  CREATE TABLE workspaces (
    id         TEXT NOT NULL PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    claimed_at TEXT
  ) STRICT;

  CREATE TABLE members (
    id               TEXT NOT NULL PRIMARY KEY,
    workspace_id     TEXT NOT NULL REFERENCES workspaces (id),
    name             TEXT NOT NULL,
    role             TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'viewer')),
    webauthn_user_id TEXT NOT NULL UNIQUE,
    created_at       TEXT NOT NULL
  ) STRICT;
  CREATE INDEX members_workspace ON members (workspace_id);

  CREATE TABLE passkeys (
    credential_id TEXT    NOT NULL PRIMARY KEY,
    member_id     TEXT    NOT NULL REFERENCES members (id),
    public_key    BLOB    NOT NULL,
    counter       INTEGER NOT NULL,
    transports    TEXT    NOT NULL,
    device_type   TEXT    NOT NULL,
    backed_up     INTEGER NOT NULL,
    created_at    TEXT    NOT NULL,
    last_used_at  TEXT
  ) STRICT;
  CREATE INDEX passkeys_member ON passkeys (member_id);

  CREATE TABLE sessions (
    id_hash      TEXT NOT NULL PRIMARY KEY,
    member_id    TEXT NOT NULL REFERENCES members (id),
    workspace_id TEXT NOT NULL REFERENCES workspaces (id),
    created_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at   TEXT NOT NULL
  ) STRICT;
  CREATE INDEX sessions_member ON sessions (member_id);

  CREATE TABLE recovery_codes (
    member_id  TEXT NOT NULL PRIMARY KEY REFERENCES members (id),
    code_hash  TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE ceremonies (
    id_hash    TEXT NOT NULL PRIMARY KEY,
    kind       TEXT NOT NULL,
    challenge  TEXT NOT NULL,
    payload    TEXT NOT NULL,
    expires_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE access_codes (
    code_hash    TEXT NOT NULL PRIMARY KEY,
    kind         TEXT NOT NULL CHECK (kind IN ('claim', 'invite')),
    workspace_id TEXT REFERENCES workspaces (id),
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    used_at      TEXT,
    CHECK ((kind = 'claim') = (workspace_id IS NOT NULL))
  ) STRICT;

  CREATE TABLE mandates (
    id             TEXT NOT NULL PRIMARY KEY,
    workspace_id   TEXT NOT NULL REFERENCES workspaces (id),
    name           TEXT NOT NULL,
    deployment     TEXT CHECK (deployment IN ('env')),
    chain_id       INTEGER,
    policy_address TEXT,
    deploy_block   INTEGER,
    created_at     TEXT NOT NULL
  ) STRICT;
  CREATE INDEX mandates_workspace ON mandates (workspace_id);
  CREATE UNIQUE INDEX mandates_env ON mandates (deployment) WHERE deployment IS NOT NULL;

  CREATE TABLE agents (
    id         TEXT NOT NULL PRIMARY KEY,
    mandate_id TEXT NOT NULL UNIQUE REFERENCES mandates (id),
    name       TEXT NOT NULL,
    signer     TEXT NOT NULL CHECK (signer IN ('env', 'console')),
    address    TEXT,
    sealed_key TEXT,
    created_at TEXT NOT NULL,
    CHECK ((signer = 'env') = (sealed_key IS NULL)),
    CHECK ((signer = 'env') = (id = 'env'))
  ) STRICT;

  CREATE TABLE agent_tokens (
    id           TEXT NOT NULL PRIMARY KEY,
    agent_id     TEXT NOT NULL REFERENCES agents (id),
    name         TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    source       TEXT NOT NULL CHECK (source IN ('console', 'env')),
    created_at   TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at   TEXT
  ) STRICT;
  CREATE INDEX agent_tokens_agent ON agent_tokens (agent_id);
  `);

  const now = new Date().toISOString();
  const workspaceId = migrationId("wsp");
  const mandateId = migrationId("mnd");
  db.prepare("INSERT INTO workspaces (id, name, created_at, claimed_at) VALUES (?, ?, ?, NULL)").run(
    workspaceId,
    "First workspace",
    now,
  );
  db.prepare(
    "INSERT INTO mandates (id, workspace_id, name, deployment, created_at) VALUES (?, ?, ?, 'env', ?)",
  ).run(mandateId, workspaceId, "Mandate", now);
  db.prepare(
    "INSERT INTO agents (id, mandate_id, name, signer, created_at) VALUES ('env', ?, ?, 'env', ?)",
  ).run(mandateId, "Agent", now);

  // Each offchain table is rebuilt with its mandate in the key, copying the rows in their original order
  // (plans and payments are ordered by rowid among equal times).
  const scoped: { table: string; create: string; columns: string }[] = [
    {
      table: "holdings",
      create: `mandate_id TEXT NOT NULL REFERENCES mandates (id) PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL`,
      columns: "payload, updated_at",
    },
    {
      table: "decision_contexts",
      create: `mandate_id TEXT NOT NULL REFERENCES mandates (id), hash TEXT NOT NULL, document TEXT NOT NULL, stored_at TEXT NOT NULL,
        PRIMARY KEY (mandate_id, hash)`,
      columns: "hash, document, stored_at",
    },
    {
      table: "hedge_plans",
      create: `mandate_id TEXT NOT NULL REFERENCES mandates (id), plan_id TEXT NOT NULL, asset TEXT NOT NULL, request_text TEXT NOT NULL,
        created_at TEXT NOT NULL, plan TEXT NOT NULL, stored_at TEXT NOT NULL, PRIMARY KEY (mandate_id, plan_id)`,
      columns: "plan_id, asset, request_text, created_at, plan, stored_at",
    },
    {
      table: "policy_change_requests",
      create: `id TEXT NOT NULL PRIMARY KEY, mandate_id TEXT NOT NULL REFERENCES mandates (id), agent_address TEXT NOT NULL,
        proposed TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
        resolved_at TEXT, applied_tx_hash TEXT`,
      columns: "id, agent_address, proposed, reason, status, created_at, resolved_at, applied_tx_hash",
    },
    {
      table: "pairings",
      create: `mandate_id TEXT NOT NULL REFERENCES mandates (id), agent_address TEXT NOT NULL, agent_name TEXT NOT NULL,
        server_version TEXT NOT NULL, status TEXT NOT NULL, announced_at TEXT NOT NULL, confirmed_at TEXT,
        confirmed_by TEXT, PRIMARY KEY (mandate_id, agent_address)`,
      columns: "agent_address, agent_name, server_version, status, announced_at, confirmed_at, confirmed_by",
    },
    {
      table: "intent_context_links",
      create: `mandate_id TEXT NOT NULL REFERENCES mandates (id), deployment_id TEXT NOT NULL, intent_id INTEGER NOT NULL,
        hash TEXT NOT NULL, tx_hash TEXT NOT NULL, linked_at TEXT NOT NULL,
        PRIMARY KEY (mandate_id, deployment_id, intent_id)`,
      columns: "deployment_id, intent_id, hash, tx_hash, linked_at",
    },
    {
      table: "signal_payments",
      create: `mandate_id TEXT NOT NULL REFERENCES mandates (id), receipt_id TEXT NOT NULL, paid_at TEXT NOT NULL, payment TEXT NOT NULL,
        recorded_at TEXT NOT NULL, PRIMARY KEY (mandate_id, receipt_id)`,
      columns: "receipt_id, paid_at, payment, recorded_at",
    },
    {
      table: "signal_budget",
      create: `mandate_id TEXT NOT NULL REFERENCES mandates (id) PRIMARY KEY, as_of TEXT NOT NULL, snapshot TEXT NOT NULL,
        stored_at TEXT NOT NULL`,
      columns: "as_of, snapshot, stored_at",
    },
    // Event wake-ups (#40): their ids and trigger ids are derived from chain positions and plan ids, which
    // two mandates could share, so the mandate is part of each key. Phase 1 sends only the first
    // workspace's wake-ups, to the one webhook in the settings; a webhook per mandate needs no new key.
    {
      table: "wake_deliveries",
      create: `mandate_id TEXT NOT NULL REFERENCES mandates (id), id TEXT NOT NULL, kind TEXT NOT NULL,
        status TEXT NOT NULL, detail TEXT NOT NULL, count INTEGER NOT NULL, occurred_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL, due_at INTEGER NOT NULL, attempts INTEGER NOT NULL, attempted_at INTEGER,
        sent_at INTEGER, result TEXT, counts_toward_cap INTEGER NOT NULL, PRIMARY KEY (mandate_id, id)`,
      columns:
        "id, kind, status, detail, count, occurred_at, created_at, due_at, attempts, attempted_at, sent_at, result, counts_toward_cap",
    },
    {
      table: "wake_sources",
      create: `mandate_id TEXT NOT NULL REFERENCES mandates (id), source_id TEXT NOT NULL, delivery_id TEXT NOT NULL,
        seen_at INTEGER NOT NULL, PRIMARY KEY (mandate_id, source_id)`,
      columns: "source_id, delivery_id, seen_at",
    },
    {
      table: "wake_price_memory",
      create: `mandate_id TEXT NOT NULL REFERENCES mandates (id), plan_id TEXT NOT NULL, memory TEXT NOT NULL,
        updated_at INTEGER NOT NULL, PRIMARY KEY (mandate_id, plan_id)`,
      columns: "plan_id, memory, updated_at",
    },
  ];
  for (const { table, create, columns } of scoped) {
    db.exec(`CREATE TABLE ${table}_scoped (${create}) STRICT`);
    db.prepare(
      `INSERT INTO ${table}_scoped (mandate_id, ${columns}) SELECT ?, ${columns} FROM ${table} ORDER BY rowid`,
    ).run(mandateId);
    db.exec(`DROP TABLE ${table}`);
    db.exec(`ALTER TABLE ${table}_scoped RENAME TO ${table}`);
  }
  // Dropping a table drops its indexes: these replace version 5's wake-up indexes, with the mandate first.
  db.exec(`
  CREATE INDEX policy_change_requests_created ON policy_change_requests (mandate_id, created_at);
  CREATE INDEX signal_payments_paid ON signal_payments (mandate_id, paid_at);
  CREATE INDEX wake_deliveries_status ON wake_deliveries (mandate_id, status, due_at);
  CREATE INDEX wake_deliveries_created ON wake_deliveries (mandate_id, created_at);
  `);
}

/**
 * `node:sqlite` is loaded through `process.getBuiltinModule` so bundlers never try to resolve it, and its
 * one-time "experimental feature" warning is dropped: the API is stable in practice and the warning would
 * otherwise show on every server start.
 */
/**
 * A record id in the format of `newId` (accounts/secrets.ts): the prefix and 26 Crockford base32
 * characters of 128 random bits. Written out here so this file imports nothing of the app's: a shipped
 * migration must never change with another module, and docs/hosting.md rehearses an upgrade with
 * `db.ts` alone. A test checks that both make the same kind of id.
 */
export function migrationId(prefix: "wsp" | "mnd"): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of randomBytes(16)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet.charAt((value << (5 - bits)) & 31);
  return `${prefix}_${out}`;
}

function loadSqlite(): typeof Sqlite {
  const emitWarning = process.emitWarning.bind(process);
  process.emitWarning = (warning: string | Error, ...rest: unknown[]) => {
    const message = typeof warning === "string" ? warning : warning.message;
    if (message.startsWith("SQLite is an experimental feature")) return;
    (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
  };
  try {
    return process.getBuiltinModule("node:sqlite");
  } finally {
    process.emitWarning = emitWarning;
  }
}

/** Opens (creating if needed) the console database in `dataDir`, or an in-memory one for `":memory:"`. */
export function openDatabase(dataDir: string): Database {
  const { DatabaseSync } = loadSqlite();
  let path = ":memory:";
  if (dataDir !== ":memory:") {
    mkdirSync(dataDir, { recursive: true });
    path = join(dataDir, "console.sqlite");
  }
  const db = new DatabaseSync(path);
  // busy_timeout: the operator's admin command writes to the same file while the console runs.
  db.exec(
    "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
  );
  try {
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/**
 * Upgrades the schema to `target` (the latest by default; tests build older versions with it, and check a
 * failing step with a list of their own).
 */
export function migrate(
  db: Database,
  target = MIGRATIONS.length,
  migrations: readonly Migration[] = MIGRATIONS,
): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  const current = row?.user_version ?? 0;
  for (let version = current; version < target; version += 1) {
    const step = migrations[version];
    if (step === undefined) throw new Error(`no migration to version ${String(version + 1)}`);
    if (typeof step === "object") {
      // Foreign keys cannot be switched inside a transaction, so this happens around it.
      const enforced = (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys;
      db.exec("PRAGMA foreign_keys = OFF");
      try {
        transaction(db, () => {
          step.withoutForeignKeys(db);
          const broken = db.prepare("PRAGMA foreign_key_check").all();
          if (broken.length > 0) {
            throw new Error(`migration ${String(version + 1)} broke ${String(broken.length)} references`);
          }
          db.exec(`PRAGMA user_version = ${String(version + 1)}`);
        });
      } finally {
        db.exec(`PRAGMA foreign_keys = ${enforced ? "ON" : "OFF"}`);
      }
      continue;
    }
    transaction(db, () => {
      if (typeof step === "function") step(db);
      else db.exec(step);
      db.exec(`PRAGMA user_version = ${String(version + 1)}`);
    });
  }
}

/** Runs `work` in one transaction: all of it lands, or none of it does. */
export function transaction<T>(db: Database, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
