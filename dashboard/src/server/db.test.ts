import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { AccountStore } from "./accounts/store";
import { type Database, migrate, openDatabase } from "./db";
import { OffchainStore } from "./store/offchain";
import { SqliteWakeStore } from "./store/wakes";

const AGENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const DEPLOYMENT = "84532:0xabc:1:0xdef";
const T = "2026-11-15T10:00:00.000Z";
const MS = Date.parse(T);

/**
 * The schema version the hosted console runs: every migration up to here is applied on its database, so
 * each keeps its position and the accounts migration comes after all of them. When another migration
 * lands on main first, raise this, insert a row into its tables below, and move accounts after it.
 */
const HOSTED_VERSION = 5;

/** Every table at `HOSTED_VERSION`: a migration moved or reordered on this branch changes this list. */
const HOSTED_TABLES = [
  "decision_contexts",
  "hedge_plans",
  "holdings",
  "ingest_cursors",
  "intent_context_links",
  "intent_details",
  "market_listings",
  "pairings",
  "policy_change_requests",
  "policy_events",
  "signal_budget",
  "signal_payments",
  "wake_deliveries",
  "wake_price_memory",
  "wake_sources",
];

/** The tables the accounts migration gives a mandate. */
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
 * A database at the hosted version, shaped like the hosted one: 26 events of which 8 propose an intent,
 * 3 plans, a holding, a confirmed pairing and a signal budget, plus a row in every other table.
 */
function hostedDatabase(): string {
  const dataDir = mkdtempSync(join(tmpdir(), "mandate-migrate-"));
  const db = new DatabaseSync(join(dataDir, "console.sqlite"));
  migrate(db, HOSTED_VERSION);
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
  db.close();
  return dataDir;
}

describe("the migrations", () => {
  it("keep main's order: the hosted version is exactly the schema the hosted console has", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db, HOSTED_VERSION);
    expect(tables(db)).toEqual(HOSTED_TABLES);
  });
});

describe("migration to accounts (after the hosted version)", () => {
  it("keeps every row, all in the first workspace's mandate, which nobody has claimed", () => {
    const dataDir = hostedDatabase();
    const before = new DatabaseSync(join(dataDir, "console.sqlite"));
    const counts = Object.fromEntries(tables(before).map((table) => [table, count(before, table)]));
    before.close();
    expect(counts).toMatchObject({ policy_events: 26, intent_details: 8, hedge_plans: 3, pairings: 1 });
    for (const [table, n] of Object.entries(counts)) expect(n, table).toBeGreaterThan(0);

    const db = openDatabase(dataDir);
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
      HOSTED_VERSION + 1,
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
    expect(offchain.latestPlans(mandate.id).map((plan) => plan.planId)).toEqual(["plan_3", "plan_2"]);
    expect(offchain.context(mandate.id, hex("bb"))?.document).toEqual({ n: 1 });
    expect(offchain.intentContextLink(mandate.id, DEPLOYMENT, 0)?.hash).toBe(hex("aa"));

    // The wake-ups already sent stay sent and keep counting toward today's cap, and a trigger already
    // handled is not offered again.
    const wakes = new SqliteWakeStore(db, mandate.id);
    expect(wakes.recent(10).map((d) => [d.id, d.status])).toEqual([[`wk_${"0".repeat(24)}`, "sent"]]);
    expect(wakes.countedSince(MS)).toBe(1);
    expect(wakes.hasSource(`chain:${DEPLOYMENT}:${hex("2e")}:0`)).toBe(true);
    expect(wakes.priceMemory("plan_2")).toMatchObject({ side: "above", spotCents: 9_100_000 });

    // Another mandate sees none of it.
    expect(offchain.holdings("mnd_other").holdings).toEqual([]);
    expect(offchain.latestPlans("mnd_other")).toEqual([]);
    const strangers = new SqliteWakeStore(db, "mnd_other");
    expect(strangers.recent(10)).toEqual([]);
    expect(strangers.countedSince(0)).toBe(0);
    expect(strangers.hasSource(`chain:${DEPLOYMENT}:${hex("2e")}:0`)).toBe(false);
    expect(strangers.priceMemory("plan_2")).toBeNull();
  });

  it("runs once: opening the upgraded database again changes nothing", () => {
    const dataDir = hostedDatabase();
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
