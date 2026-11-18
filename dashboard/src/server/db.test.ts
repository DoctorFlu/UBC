/**
 * Migrations apply by position (`PRAGMA user_version`), so a hosted console upgrades only if every
 * migration it already ran keeps its place and new ones come after. This builds databases exactly as the
 * shipped consoles left them (versions 5, 6 and 7), with rows in them, and opens them with the current code.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { AccountStore } from "./accounts/store";
import { newId } from "./accounts/secrets";
import { type Database, type Migration, MIGRATIONS, migrate, migrationId, openDatabase } from "./db";
import { OffchainStore } from "./store/offchain";
import { SettlementStore } from "./store/settlements";
import { VenueOrderStore } from "./store/venue-orders";
import { SqliteWakeStore } from "./store/wakes";

/**
 * SHA-256 of the shipped migrations, joined by NUL: 1 to 5 as main had them at 190fe37, 1 to 6 as main
 * had them at 2508c46 (settlements, #92), and 1 to 7 with the venue order journal of #108 (#93). A change
 * here means a shipped migration was edited or moved, which a deployed database never re-runs.
 */
const SHIPPED_SHA256 = {
  5: "0a0e02f733cd4c812b7facda9c22497f09de6f4d0b165f0048a6a9f381d68f51",
  6: "f595c104e5563ac1965cb0a8b2466a277699719b6762de0f1d971c845f1be328",
  7: "cec3e06e2ad933d69d043d36f7ca6a1fc3044ce0e5ed88496f957eb880258f63",
} as const;

function shippedHash(versions: number): string {
  const steps = MIGRATIONS.slice(0, versions).map((step) => {
    if (typeof step !== "string") throw new Error("a shipped migration is SQL");
    return step;
  });
  return createHash("sha256").update(steps.join("\u0000")).digest("hex");
}

/**
 * SHA-256 of the schema a version leaves (every table, index and trigger as SQLite stores it, by name), for
 * the migrations written as code: version 8 is the accounts of #94 as main shipped them at cf43611, and
 * version 9 the several mandates of #95. Once 9 is on main, a change here means it was edited after a
 * console ran it.
 */
const SHIPPED_SCHEMA_SHA256 = {
  8: "a1b6c0b890cc9585c59d9aad44bcab810a4af2fe052015f46e0f4d8871523e94",
  9: "2aec9eec5ca927a45ea82498ef77b77c040e31ecee086c921604f28e4fbab6a3",
} as const;

function schemaHash(version: number): string {
  const db = new DatabaseSync(":memory:");
  migrate(db, version);
  const rows = db
    .prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name")
    .all() as { type: string; name: string; sql: string }[];
  db.close();
  return createHash("sha256")
    .update(rows.map((row) => `${row.type}\u0000${row.name}\u0000${row.sql}`).join("\u0000"))
    .digest("hex");
}

const AGENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const DEPLOYMENT = "84532:0xabc:1:0xdef";
const T = "2026-11-15T10:00:00.000Z";
const MS = Date.parse(T);

/**
 * The schema version the hosted console runs: every migration up to here is applied on its database, so
 * each keeps its position and the mandates migration (9) comes after all of them. When another migration
 * lands on main first, raise this, insert a row into its tables below, and move mandates after it.
 * Versions 7 (before accounts), 6 and 5 are upgraded below as well.
 */
const HOSTED_VERSION = 8;

/** Every table at version 7, before accounts. */
const VERSION_7_TABLES = [
  "decision_contexts",
  "executor_venues",
  "hedge_plans",
  "holdings",
  "ingest_cursors",
  "intent_context_links",
  "intent_details",
  "market_listings",
  "pairings",
  "policy_change_requests",
  "policy_events",
  "settlements",
  "signal_budget",
  "signal_payments",
  "venue_orders",
  "wake_deliveries",
  "wake_price_memory",
  "wake_sources",
];

/** The tables accounts (version 8) added. */
const ACCOUNT_TABLES = [
  "access_codes",
  "agent_tokens",
  "agents",
  "ceremonies",
  "mandates",
  "members",
  "passkeys",
  "recovery_codes",
  "sessions",
  "workspaces",
];

/** Every table at `HOSTED_VERSION`: a migration moved or reordered on this branch changes this list. */
const HOSTED_TABLES = [...VERSION_7_TABLES, ...ACCOUNT_TABLES].sort();

/**
 * The tables the accounts migration gives a mandate. Settlements, venue orders and the executor's venue
 * stay keyed by deployment: they describe the contract and its executor, which only the first mandate follows.
 */
const SCOPED_TABLES = [
  "holdings",
  "decision_contexts",
  "hedge_plans",
  "policy_change_requests",
  "pairings",
  "intent_context_links",
  "signal_payments",
  "signal_budget",
  "wake_deliveries",
  "wake_sources",
  "wake_price_memory",
];

const hex = (byte: string) => `0x${byte.repeat(32)}`;

function tables(db: Database): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
    name: string;
  }[];
  return rows.map((row) => row.name);
}

function count(db: Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/**
 * A database at a shipped version (the hosted one by default), shaped like the hosted one: 26 events of
 * which 8 propose an intent, 3 plans, a holding, a confirmed pairing and a signal budget, plus a row in
 * every other table, in write-ahead log mode as the hosted console keeps it.
 */
function hostedDatabase(version = HOSTED_VERSION): string {
  const dataDir = mkdtempSync(join(tmpdir(), "mandate-migrate-"));
  const db = new DatabaseSync(join(dataDir, "console.sqlite"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
  // Version 8 is what the hosted console made of its version 7 file, then used: built the same way.
  migrate(db, Math.min(version, 7));
  const run = (sql: string, ...values: (string | number | null)[]) => db.prepare(sql).run(...values);

  const types = [
    ...Array<string>(8).fill("IntentProposed"),
    ...Array<string>(6).fill("IntentApproved"),
    ...Array<string>(5).fill("OrderFilled"),
    ...Array<string>(2).fill("IntentRejected"),
    "Paused",
    "Unpaused",
    "RulesUpdated",
    "RoleGranted",
    "RoleGranted",
  ];
  for (const [index, type] of types.entries()) {
    run(
      "INSERT INTO policy_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      DEPLOYMENT,
      hex((index + 16).toString(16)),
      0,
      100 + index,
      1_763_200_000 + index,
      type,
      "{}",
      "rpc",
      T,
    );
  }
  run("INSERT INTO ingest_cursors VALUES (?, ?, ?)", DEPLOYMENT, 126, T);
  for (let intent = 0; intent < 8; intent += 1) {
    run("INSERT INTO intent_details VALUES (?, ?, ?)", DEPLOYMENT, intent, "{}");
  }
  run("INSERT INTO holdings VALUES (1, ?, ?)", JSON.stringify([{ asset: "BTC", quantity: "0.05" }]), T);
  for (const [index, hash] of [hex("aa"), hex("bb")].entries()) {
    run("INSERT INTO decision_contexts VALUES (?, ?, ?)", hash, `{"n":${String(index)}}`, T);
  }
  for (const [planId, asset, storedAt] of [
    ["plan_1", "BTC", "2026-11-15T10:00:00.000Z"],
    ["plan_2", "BTC", "2026-11-15T11:00:00.000Z"],
    ["plan_3", "ETH", "2026-11-15T11:00:00.000Z"],
  ] as const) {
    run("INSERT INTO hedge_plans VALUES (?, ?, ?, ?, ?, ?)", planId, asset, "Protect it", T, "{}", storedAt);
  }
  run(
    "INSERT INTO policy_change_requests VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    "pcr_1",
    AGENT,
    JSON.stringify({ maxTradeCents: 3_000 }),
    "A bigger rung.",
    "pending",
    T,
    null,
    null,
  );
  run(
    "INSERT INTO pairings VALUES (?, ?, ?, ?, ?, ?, ?)",
    AGENT,
    "Grok Bot",
    "0.1.0",
    "confirmed",
    T,
    T,
    OWNER,
  );
  run("INSERT INTO intent_context_links VALUES (?, ?, ?, ?, ?)", DEPLOYMENT, 0, hex("aa"), hex("11"), T);
  run("INSERT INTO signal_payments VALUES (?, ?, ?, ?)", hex("7c"), T, "{}", T);
  run("INSERT INTO signal_budget VALUES (1, ?, ?, ?)", T, "{}", T);
  run("INSERT INTO market_listings VALUES (?, ?, ?, ?)", "GEMI-BTC", 1, 1, T);
  run(
    "INSERT INTO wake_deliveries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    `wk_${"0".repeat(24)}`,
    "mandate_changed",
    "sent",
    JSON.stringify({ kind: "mandate_changed", detail: { change: "paused", paused: true } }),
    1,
    MS,
    MS,
    MS,
    1,
    MS,
    MS,
    "200",
    1,
  );
  run(
    "INSERT INTO wake_sources VALUES (?, ?, ?)",
    `chain:${DEPLOYMENT}:${hex("2e")}:0`,
    `wk_${"0".repeat(24)}`,
    MS,
  );
  run(
    "INSERT INTO wake_price_memory VALUES (?, ?, ?)",
    "plan_2",
    JSON.stringify({ side: "above", spotCents: 9_100_000, coverState: null, crossings: 0, coverLosses: 0 }),
    MS,
  );
  if (version >= 6) {
    run(
      "INSERT INTO settlements VALUES (?, ?, ?, ?, ?, ?, ?)",
      DEPLOYMENT,
      3,
      hex("5e"),
      JSON.stringify({ intentId: 3 }),
      `0x${"ab".repeat(65)}`,
      OWNER,
      T,
    );
  }
  if (version >= 7) {
    run(
      "INSERT INTO venue_orders VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      DEPLOYMENT,
      3,
      2,
      hex("0d"),
      JSON.stringify({ intentId: 3, revision: 2, state: "filled" }),
      `0x${"cd".repeat(65)}`,
      OWNER,
      T,
    );
    run(
      "INSERT INTO executor_venues VALUES (?, ?, ?, ?, ?, ?)",
      DEPLOYMENT,
      hex("0e"),
      JSON.stringify({ venue: "gemini", environment: "sandbox" }),
      `0x${"ef".repeat(65)}`,
      OWNER,
      T,
    );
  }
  if (version >= 8) {
    migrate(db, 8);
    addAccountRows(db);
  }
  db.close();
  return dataDir;
}

/** The second workspace's ids, made by a sign-up on version 8. */
const SIGNED_UP = { workspace: "wsp_signedup", mandate: "mnd_signedup", agent: "agt_signedup" };

/**
 * What version 8 consoles wrote once people used them: the first workspace claimed, with a member, a
 * passkey, a session, a recovery code and an agent token; a second workspace from a sign-up, with its own
 * mandate (no contract) and a console-held agent key; an invite, an open ceremony, and that mandate's own
 * holding and plan. A row in every table.
 */
function addAccountRows(db: DatabaseSync): void {
  const run = (sql: string, ...values: (string | number | null | Uint8Array)[]) =>
    db.prepare(sql).run(...values);
  const first = db.prepare("SELECT id, workspace_id FROM mandates WHERE deployment = 'env'").get() as {
    id: string;
    workspace_id: string;
  };
  run("UPDATE workspaces SET claimed_at = ? WHERE id = ?", T, first.workspace_id);
  run("INSERT INTO workspaces VALUES (?, ?, ?, ?)", SIGNED_UP.workspace, "Bob's workspace", T, T);
  run(
    "INSERT INTO mandates (id, workspace_id, name, created_at) VALUES (?, ?, ?, ?)",
    SIGNED_UP.mandate,
    SIGNED_UP.workspace,
    "Mandate",
    T,
  );
  run(
    "INSERT INTO agents VALUES (?, ?, ?, 'console', ?, ?, ?)",
    SIGNED_UP.agent,
    SIGNED_UP.mandate,
    "Agent",
    "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    '{"v":1}',
    T,
  );
  for (const [member, workspace, handle] of [
    ["mbr_alice", first.workspace_id, "aGFuZGxlLWFsaWNl"],
    ["mbr_bob", SIGNED_UP.workspace, "aGFuZGxlLWJvYg"],
  ] as const) {
    run("INSERT INTO members VALUES (?, ?, ?, 'admin', ?, ?)", member, workspace, member.slice(4), handle, T);
    run(
      "INSERT INTO passkeys VALUES (?, ?, ?, 0, '[\"internal\"]', 'multiDevice', 1, ?, NULL)",
      `cred_${member}`,
      member,
      new Uint8Array([1, 2, 3]),
      T,
    );
    run(
      "INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)",
      `sess_${member}`,
      member,
      workspace,
      T,
      T,
      "2026-12-15T10:00:00.000Z",
    );
  }
  run("INSERT INTO recovery_codes VALUES (?, ?, ?)", "mbr_alice", "hash_recovery", T);
  run(
    "INSERT INTO ceremonies VALUES (?, ?, ?, ?, ?)",
    "cer_1",
    "sign-in",
    "challenge",
    "{}",
    "2026-11-15T10:05:00.000Z",
  );
  run(
    "INSERT INTO access_codes VALUES (?, 'invite', NULL, ?, ?, NULL)",
    "hash_invite",
    T,
    "2026-11-22T10:00:00.000Z",
  );
  run(
    "INSERT INTO agent_tokens VALUES (?, 'env', ?, ?, 'console', ?, NULL, NULL)",
    "tok_1",
    "Grok Bot",
    "hash_token",
    T,
  );
  run(
    "INSERT INTO holdings VALUES (?, ?, ?)",
    SIGNED_UP.mandate,
    JSON.stringify([{ asset: "ETH", quantity: "2" }]),
    T,
  );
  run(
    "INSERT INTO hedge_plans VALUES (?, ?, ?, ?, ?, ?, ?)",
    SIGNED_UP.mandate,
    "plan_1",
    "ETH",
    "Protect my ETH",
    T,
    "{}",
    T,
  );
}

describe("the migrations", () => {
  it("keep the shipped migrations as they are, in their places", () => {
    expect(shippedHash(5)).toBe(SHIPPED_SHA256[5]);
    expect(shippedHash(6)).toBe(SHIPPED_SHA256[6]);
    expect(shippedHash(7)).toBe(SHIPPED_SHA256[7]);
    expect(schemaHash(8)).toBe(SHIPPED_SCHEMA_SHA256[8]);
    expect(schemaHash(9)).toBe(SHIPPED_SCHEMA_SHA256[9]);
  });

  it("keep main's order: the hosted version is exactly the schema the hosted console has", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db, HOSTED_VERSION);
    expect(tables(db)).toEqual(HOSTED_TABLES);
  });

  it("need no module of the app, so an upgrade can be rehearsed with db.ts alone (docs/hosting.md)", () => {
    const source = readFileSync(fileURLToPath(new URL("./db.ts", import.meta.url)), "utf8");
    const imports = [...source.matchAll(/^import\s(?:[^"']*\sfrom\s)?["']([^"']+)["']/gm)].map(
      (match) => match[1],
    );
    expect(imports.filter((name) => name !== "server-only" && !name?.startsWith("node:"))).toEqual([]);
  });

  it("make ids in the same format as the accounts", () => {
    const format = (id: string) => id.replace(/^[a-z]+_/, "").replace(/[0-9a-hjkmnp-tv-z]/g, "x");
    for (const prefix of ["wsp", "mnd"] as const) {
      const id = migrationId(prefix);
      expect(id.startsWith(`${prefix}_`)).toBe(true);
      expect(format(id)).toBe(format(newId(prefix)));
      expect(format(id)).toBe("x".repeat(26));
    }
  });
});

describe("migration to accounts (version 7 to 8, then 9)", () => {
  it("keeps every row, all in the first workspace's mandate, which nobody has claimed", () => {
    const dataDir = hostedDatabase(7);
    const before = new DatabaseSync(join(dataDir, "console.sqlite"));
    const counts = Object.fromEntries(tables(before).map((table) => [table, count(before, table)]));
    before.close();
    expect(counts).toMatchObject({
      policy_events: 26,
      intent_details: 8,
      hedge_plans: 3,
      pairings: 1,
      settlements: 1,
      venue_orders: 1,
      executor_venues: 1,
    });
    for (const [table, n] of Object.entries(counts)) expect(n, table).toBeGreaterThan(0);

    const db = openDatabase(dataDir);
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
      MIGRATIONS.length,
    );
    for (const [table, n] of Object.entries(counts)) expect(count(db, table), table).toBe(n);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });

    const accounts = new AccountStore(db);
    const workspace = accounts.firstWorkspace();
    expect(workspace.claimedAt).toBeNull();
    expect(accounts.members(workspace.id)).toEqual([]);
    const mandate = accounts.envMandate();
    expect(mandate.workspaceId).toBe(workspace.id);
    expect(accounts.agentOf(mandate.id)).toMatchObject({
      id: "env",
      signer: "env",
      address: null,
      sealedKey: null,
    });
    for (const table of SCOPED_TABLES) {
      const owners = db.prepare(`SELECT DISTINCT mandate_id FROM ${table}`).all() as { mandate_id: string }[];
      expect(owners, table).toEqual([{ mandate_id: mandate.id }]);
    }

    const offchain = new OffchainStore(db);
    expect(offchain.holdings(mandate.id)).toEqual({
      holdings: [{ asset: "BTC", quantity: "0.05" }],
      updatedAt: T,
    });
    expect(offchain.latestPairing(mandate.id)).toMatchObject({
      agentAddress: AGENT,
      status: "confirmed",
      confirmedBy: OWNER,
    });
    expect(offchain.changeRequests(mandate.id).map((request) => request.id)).toEqual(["pcr_1"]);
    expect(offchain.goalPlans(mandate.id).map((plan) => plan.planId)).toEqual(["plan_3", "plan_2"]);
    expect(offchain.context(mandate.id, hex("bb"))?.document).toEqual({ n: 1 });
    expect(offchain.intentContextLink(mandate.id, DEPLOYMENT, 0)?.hash).toBe(hex("aa"));
    // Settlements, the venue order journal and the executor's venue belong to the deployment the first
    // mandate follows, and are read through it, untouched by the migration.
    expect(new SettlementStore(db).list(DEPLOYMENT).map((s) => [s.intentId, s.hash])).toEqual([
      [3, hex("5e")],
    ]);
    const venue = new VenueOrderStore(db);
    expect(venue.orders(DEPLOYMENT).map((o) => [o.intentId, o.revision, o.hash])).toEqual([
      [3, 2, hex("0d")],
    ]);
    expect(venue.order(DEPLOYMENT, 3)?.document).toEqual({ intentId: 3, revision: 2, state: "filled" });
    expect(venue.venue(DEPLOYMENT)).toMatchObject({
      hash: hex("0e"),
      document: { venue: "gemini", environment: "sandbox" },
    });
    for (const table of ["settlements", "venue_orders", "executor_venue_announcements"]) {
      const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
        (column) => column.name,
      );
      expect(columns, table).toContain("deployment_id");
      expect(columns, table).not.toContain("mandate_id");
    }

    // The wake-ups already sent stay sent and keep counting toward today's cap, and a trigger already
    // handled is not offered again.
    const wakes = new SqliteWakeStore(db, mandate.id);
    expect(wakes.recent(10).map((d) => [d.id, d.status])).toEqual([[`wk_${"0".repeat(24)}`, "sent"]]);
    expect(wakes.countedSince(MS)).toBe(1);
    expect(wakes.hasSource(`chain:${DEPLOYMENT}:${hex("2e")}:0`)).toBe(true);
    expect(wakes.priceMemory("plan_2")).toMatchObject({ side: "above", spotCents: 9_100_000 });

    // Another mandate sees none of it.
    expect(offchain.holdings("mnd_other").holdings).toEqual([]);
    expect(offchain.goalPlans("mnd_other")).toEqual([]);
    const strangers = new SqliteWakeStore(db, "mnd_other");
    expect(strangers.recent(10)).toEqual([]);
    expect(strangers.countedSince(0)).toBe(0);
    expect(strangers.hasSource(`chain:${DEPLOYMENT}:${hex("2e")}:0`)).toBe(false);
    expect(strangers.priceMemory("plan_2")).toBeNull();
  });

  // The hosted console is at 6 today and at 7 once #108 deploys; 5 is the version before #92.
  it.each([
    { from: 6, missing: ["venue_orders", "executor_venues"] },
    { from: 5, missing: ["settlements", "venue_orders", "executor_venues"] },
  ])(
    "upgrades a version $from database too: the missing tables, then accounts, every row kept",
    ({ from, missing }) => {
      const dataDir = hostedDatabase(from);
      const before = new DatabaseSync(join(dataDir, "console.sqlite"));
      const counts = Object.fromEntries(tables(before).map((table) => [table, count(before, table)]));
      for (const table of missing) expect(tables(before)).not.toContain(table);
      before.close();

      const db = openDatabase(dataDir);
      expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
        MIGRATIONS.length,
      );
      for (const [table, n] of Object.entries(counts)) expect(count(db, table), table).toBe(n);
      for (const table of missing) expect(count(db, table), table).toBe(0);
      expect(new AccountStore(db).firstWorkspace().claimedAt).toBeNull();
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    },
  );

  it("runs once: opening the upgraded database again changes nothing", () => {
    const dataDir = hostedDatabase(7);
    const first = openDatabase(dataDir);
    const mandate = new AccountStore(first).envMandate();
    first.close();
    const again = openDatabase(dataDir);
    expect(new AccountStore(again).envMandate()).toEqual(mandate);
    expect(count(again, "workspaces")).toBe(1);
    expect(count(again, "policy_events")).toBe(26);
  });

  it("refuses an offchain or wake-up row for a mandate that does not exist", () => {
    const db = openDatabase(":memory:");
    expect(() => new OffchainStore(db).saveHoldings("mnd_missing", [])).toThrow(/FOREIGN KEY/);
    expect(() => new SqliteWakeStore(db, "mnd_missing").addSource("chain:x", "wk_x", 1)).toThrow(
      /FOREIGN KEY/,
    );
  });
});

describe("migration to several mandates (after the hosted version 8)", () => {
  const columnsOf = (db: Database, table: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name);

  it("keeps every row and every mandate's id, so every row that names a mandate still does", () => {
    const dataDir = hostedDatabase();
    const before = new DatabaseSync(join(dataDir, "console.sqlite"));
    expect(tables(before)).toEqual(HOSTED_TABLES);
    const counts = Object.fromEntries(tables(before).map((table) => [table, count(before, table)]));
    const mandatesBefore = before.prepare("SELECT * FROM mandates ORDER BY rowid").all();
    before.close();
    for (const [table, n] of Object.entries(counts)) expect(n, table).toBeGreaterThan(0);

    const db = openDatabase(dataDir);
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
      MIGRATIONS.length,
    );
    for (const [table, n] of Object.entries(counts)) expect(count(db, table), table).toBe(n);
    expect(count(db, "owner_actions")).toBe(0);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    // The migration switched foreign keys off around itself; they are on again.
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });

    const after = db
      .prepare(
        "SELECT id, workspace_id, name, deployment, chain_id, policy_address, deploy_block, created_at FROM mandates ORDER BY rowid",
      )
      .all();
    expect(after).toEqual(mandatesBefore);
    const added = db
      .prepare(
        `SELECT id FROM mandates WHERE contract_kind IS NOT NULL OR executor_address IS NOT NULL
           OR owner_address IS NOT NULL OR sealed_owner_key IS NOT NULL`,
      )
      .all();
    expect(added).toEqual([]);

    const accounts = new AccountStore(db);
    const env = accounts.envMandate();
    expect(env.deployment).toBe("env");
    expect(accounts.mandates(SIGNED_UP.workspace).map((mandate) => [mandate.id, mandate.deployment])).toEqual(
      [[SIGNED_UP.mandate, null]],
    );
    expect(accounts.agentOf(SIGNED_UP.mandate).id).toBe(SIGNED_UP.agent);
    const offchain = new OffchainStore(db);
    expect(offchain.holdings(SIGNED_UP.mandate).holdings).toEqual([{ asset: "ETH", quantity: "2" }]);
    expect(offchain.holdings(env.id).holdings).toEqual([{ asset: "BTC", quantity: "0.05" }]);
    expect(offchain.goalPlans(SIGNED_UP.mandate).map((plan) => plan.planId)).toEqual(["plan_1"]);
    expect(columnsOf(db, "mandates")).toEqual([
      "id",
      "workspace_id",
      "name",
      "deployment",
      "chain_id",
      "policy_address",
      "deploy_block",
      "contract_kind",
      "executor_address",
      "owner_address",
      "sealed_owner_key",
      "created_at",
    ]);
  });

  it("still refuses a row for a mandate that does not exist, and a contract two mandates would share", () => {
    const db = openDatabase(hostedDatabase());
    expect(() => new OffchainStore(db).saveHoldings("mnd_missing", [])).toThrow(/FOREIGN KEY/);
    expect(() =>
      db
        .prepare("INSERT INTO agents VALUES ('agt_x', 'mnd_missing', 'Agent', 'console', '0x1', '{}', ?)")
        .run(T),
    ).toThrow(/FOREIGN KEY/);
    const insert = db.prepare(
      `INSERT INTO mandates (id, workspace_id, name, deployment, chain_id, policy_address, deploy_block,
         contract_kind, executor_address, owner_address, sealed_owner_key, created_at)
       VALUES (?, ?, 'M', ?, 31337, ?, 5, 'production', '0xe', '0xo', ?, ?)`,
    );
    insert.run("mnd_a", SIGNED_UP.workspace, "server", "0xabc", '{"v":1}', T);
    // The same contract for another mandate, a server deployment without its owner key, a wallet
    // deployment with one, a second env mandate, and an address not in lower case are all refused.
    expect(() => insert.run("mnd_b", SIGNED_UP.workspace, "wallet", "0xabc", null, T)).toThrow(/UNIQUE/);
    expect(() => insert.run("mnd_c", SIGNED_UP.workspace, "server", "0xabd", null, T)).toThrow(/CHECK/);
    expect(() => insert.run("mnd_d", SIGNED_UP.workspace, "wallet", "0xabe", '{"v":1}', T)).toThrow(/CHECK/);
    expect(() => insert.run("mnd_e", SIGNED_UP.workspace, "env", "0xabf", null, T)).toThrow(/UNIQUE/);
    expect(() => insert.run("mnd_f", SIGNED_UP.workspace, "wallet", "0xABC1", null, T)).toThrow(/CHECK/);
    const bare = db.prepare(
      "INSERT INTO mandates (id, workspace_id, name, deployment, created_at) VALUES (?, ?, 'M', 'wallet', ?)",
    );
    expect(() => bare.run("mnd_g", SIGNED_UP.workspace, T)).toThrow(/CHECK/);
    // A mandate being made holds its owner key before its contract exists.
    db.prepare(
      `INSERT INTO mandates (id, workspace_id, name, owner_address, sealed_owner_key, created_at)
       VALUES (?, ?, 'M', '0xo', '{}', ?)`,
    ).run("mnd_h", SIGNED_UP.workspace, T);
  });

  it("refuses to commit a step that would leave a broken reference, and keeps foreign keys on", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db);
    const broken: Migration[] = [
      ...MIGRATIONS,
      { withoutForeignKeys: (inner) => inner.exec("INSERT INTO holdings VALUES ('mnd_missing', '[]', 'x')") },
    ];
    expect(() => migrate(db, broken.length, broken)).toThrow(/broke 1 references/);
    expect(count(db, "holdings")).toBe(0);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: MIGRATIONS.length });
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  });
});

describe("migration to the executor's venue history (version 9 to 10)", () => {
  /** The hosted Arc console's file today: version 9, with the one announcement it holds. */
  function version9(): string {
    const dataDir = hostedDatabase();
    const db = new DatabaseSync(join(dataDir, "console.sqlite"));
    migrate(db, 9);
    db.close();
    return dataDir;
  }

  it("carries the stored announcement over as the first, which covers the contract's earlier fills", () => {
    const dataDir = version9();
    const before = new DatabaseSync(join(dataDir, "console.sqlite"));
    expect((before.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(9);
    const stored = before.prepare("SELECT * FROM executor_venues").all();
    expect(stored).toHaveLength(1);
    before.close();

    const db = openDatabase(dataDir);
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(10);
    // The old table stays as it was, so the version before this one still runs on the file after a rollback.
    expect(db.prepare("SELECT * FROM executor_venues").all()).toEqual(stored);
    const venues = new VenueOrderStore(db);
    expect(venues.venues(DEPLOYMENT)).toEqual([
      {
        seq: 0,
        holdsFromBlock: null,
        hash: hex("0e"),
        document: { venue: "gemini", environment: "sandbox" },
        signature: `0x${"ef".repeat(65)}`,
        signer: OWNER,
        storedAt: T,
      },
    ]);
    expect(venues.venue(DEPLOYMENT)?.seq).toBe(0);
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  it("appends later announcements, each holding from its own block, the latest in force", () => {
    const db = openDatabase(version9());
    const venues = new VenueOrderStore(db, () => new Date("2026-11-18T09:00:00.000Z"));
    const record = {
      hash: hex("1a") as `0x${string}`,
      document: { venue: "simulated" },
      signature: hex("1b") as `0x${string}`,
      signer: OWNER as `0x${string}`,
    };
    venues.announceVenue(DEPLOYMENT, record, 1_201);
    expect(venues.venues(DEPLOYMENT).map((row) => [row.seq, row.holdsFromBlock, row.hash])).toEqual([
      [0, null, hex("0e")],
      [1, 1_201, hex("1a")],
    ]);
    expect(venues.venue(DEPLOYMENT)).toMatchObject({
      seq: 1,
      holdsFromBlock: 1_201,
      storedAt: "2026-11-18T09:00:00.000Z",
    });
    // Another deployment's history starts at its own first announcement.
    expect(venues.venues("other")).toEqual([]);
    expect(venues.announceVenue("other", record, 7).seq).toBe(0);
  });

  it("runs once: opening the upgraded file again changes nothing", () => {
    const dataDir = version9();
    openDatabase(dataDir).close();
    const again = openDatabase(dataDir);
    expect(count(again, "executor_venue_announcements")).toBe(1);
    expect((again.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(10);
  });
});
