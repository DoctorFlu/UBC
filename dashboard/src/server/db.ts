import "server-only";

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type * as Sqlite from "node:sqlite";
import type { DatabaseSync } from "node:sqlite";

/**
 * The console's durable store: one SQLite file under `CONSOLE_DATA_DIR`, opened with Node's built-in
 * `node:sqlite`, so there is no native dependency to build.
 *
 * It holds two kinds of data:
 * - a cache of Policy contract events, keyed by deployment, transaction hash and log index, so
 *   repeated deliveries are ignored and a restart resumes instead of rescanning the chain;
 * - the offchain records the console is the system of record for: holdings, decision contexts, hedge
 *   plans, policy change requests and agent pairing.
 */
export type Database = DatabaseSync;

/** Each entry upgrades the schema by one version. Never edit a shipped entry; append a new one. */
const MIGRATIONS: readonly string[] = [
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
];

/**
 * `node:sqlite` is loaded through `process.getBuiltinModule` so bundlers never try to resolve it, and its
 * one-time "experimental feature" warning is dropped: the API is stable in practice and the warning would
 * otherwise show on every server start.
 */
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
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function migrate(db: Database): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  const current = row?.user_version ?? 0;
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    transaction(db, () => {
      db.exec(MIGRATIONS[version] ?? "");
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
